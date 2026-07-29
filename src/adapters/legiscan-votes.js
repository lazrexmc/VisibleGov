import { isMissingRelationError } from '../lib/db.js';

// LegiScan bulk adapter — votes + casts ingestion (Task 6 of docs/superpowers/plans/2026-07-29-
// legiscan-bulk-adapter.md). Maps a dataset roll_call record (Task 4's legiscan-dataset.js shape —
// verbatim { roll_call_id, bill_id, date, desc, yea, nay, nv, absent, total, passed, chamber,
// chamber_id, votes: [{people_id, vote_id, vote_text}] }) onto canonical `votes` + `vote_casts`
// rows, guarded by TWO reconciliation gates per CONTROLLER RULING 1 (task-6-brief.md, binding):
//   (a) INTERNAL — reconcileLegiscanTallies: parsed votes[] position counts MUST equal the roll
//       call's OWN printed yea/nay/nv/absent/total or it's a typed, counted failure, never stored.
//       Mirrors mo-rollcall-pdf.js's parseMoRollCall gate exactly, applied to LegiScan's own
//       numbers (no primary-source comparison yet).
//   (b) CROSS-SOURCE — crossCheckAgainstPrimarySource: where a primary-source tally (mo-house-xml
//       or mo-senate-web — see PRIMARY_SOURCE_KEY_PREFIXES below) already exists for the same real
//       vote, compare. FIX ROUND 1 (controller ruling — refines, not restores, the original
//       "flag but never quarantine" design this task first shipped): a disagreement is ALWAYS
//       durably flagged (vote_reconciliation_flags, migration 0010), but whether the LegiScan vote
//       itself is stored now depends on WHAT disagrees, per the returned `quarantine` boolean:
//         - yea or nay differs -> REAL divergence (both sources define these identically, and they
//           determine the vote's outcome/attribution stakes) -> flags row + `quarantine:true` — the
//           LegiScan vote/casts must NOT be stored (`votes`/`vote_casts` are anon-readable;
//           possibly-contradicted data must never be publicly reachable — "never store what you
//           can't reconcile", the same rule reconcileLegiscanTallies already enforces internally).
//         - only the combined present/not_voting/absent bucket differs (yea/nay both agree) ->
//           `quarantine:false`, vote STORES anyway — this is an accounting difference between two
//           sources' own category vocabularies (the Present-category caveat below), not a
//           contradiction of the vote's actual outcome.
//       FIX ROUND 2 (review finding — "same-day multi-roll-call blindness"): the plan's own brief
//       text assumed at most one primary-source vote per (jurisdiction, chamber, date, bill), but
//       the real HB 3 fixture disproves this for THAT tuple alone — 5 separate House roll calls
//       (774312-774316) all land on the SAME bill/chamber/date (2018-09-12). When more than one
//       primary-source candidate matches that tuple, disambiguate by TALLY IDENTITY ((yea, nay) —
//       the two categories both sources define identically) rather than treating every multi-match
//       as one flat "ambiguous" bucket:
//         - exactly one candidate's own (yea, nay) equals LegiScan's -> that candidate is SELECTED
//           as the corresponding row (see FIX ROUND 3 immediately below for what happens next).
//         - zero candidates match on (yea, nay) -> no 1:1 correspondence is mechanically assertable,
//           so no hard contradiction is assertable either -> stores (internally reconciled,
//           uncontradicted by anything specific), flags `reason: 'no_tally_corresponding_primary'`
//           listing every same-day candidate's own tallies for human review.
//         - more than one candidate matches on (yea, nay) -> genuinely ambiguous (two same-day votes
//           coincidentally sharing a head count) -> stores, flags
//           `reason: 'ambiguous_tally_match'` with the matching subset listed.
//       FIX ROUND 3 (re-review — a real regression, caught by execution, not just reading): round
//       2's own comment claimed tally-unique selection "IS the verification passing" and returned
//       matched:true immediately — WRONG. TALLY-UNIQUE SELECTION IS SELECTION, NOT VERIFICATION.
//       (yea, nay) agreement only identifies WHICH candidate corresponds; it says nothing about
//       whether the rest of that candidate's own tallies also agree (the re-reviewer proved this by
//       running it: 500 doctored Present casts on the uniquely-selected candidate still returned
//       matched:true with zero flags — the exact scenario the single-candidate path DOES flag).
//       Fixed: the tally-uniquely-selected candidate now goes through the SAME
//       compareTalliesForCrossCheck call the single-candidate path uses (not a hand-rolled second
//       copy). Hard mismatches are impossible there BY CONSTRUCTION (yea/nay equality is literally
//       the selection filter) — soft-clean -> matched:true, `reason: 'tally_unique_match'`, no flag
//       (the real happy path); soft-mismatch -> stores + flags with the identical soft-mismatch
//       shape/caveat the single-candidate path produces, plus a `note` documenting the candidate
//       was tally-uniquely selected among N same-day candidates (a reviewer seeing this flag should
//       know the disambiguation mechanism that picked this specific row).
//       Quarantine is asserted ONLY where a 1:1 correspondence is assertable — i.e. only on the
//       single-candidate path AND the tally-unique-selection path (both now share the same hard/soft
//       comparison, so both share the same quarantine rule — never grounds to quarantine on the
//       zero-match or ambiguous-match branches, since quarantine requires knowing WHAT is being
//       contradicted, which those two branches cannot establish).
//       No primary-source counterpart at all -> `checked:false`, `quarantine:false` (unchanged) —
//       LegiScan covers far more sessions than the primary parsers have reached; absence of a
//       counterpart is the whole point of this backfill, never treated as a failure.
//
// VOTE_ID_MAP — per docs/research/2026-07-27-mo-data-sources.md Q2 (VERIFIED-BY-PAYLOAD against
// LegiScan's own schema-mysql.sql, `ls_vote` lookup table: 1=Yea, 2=Nay, 3=Not Voting, 4=Absent).
// CONTROLLER RULING 1 requires deriving this from the REAL fixture payloads, not a recalled doc —
// done: vote_id 1/2/4 were cross-checked against every cast's own `vote_text` field across ALL 8
// real roll calls in dataset-2018-1608 (1002 individual casts total) PLUS the standalone real
// roll-call-747209 fixture (161 more casts) — 1/Yea, 2/Nay, 4/Absent hold with ZERO exceptions
// across all 1163 real casts checked (tests/legiscan-votes.test.js asserts this directly, not just
// internally). vote_id 3 ('Not Voting') has NO real-fixture example anywhere in this repo's
// captured LegiScan data — its mapping here rests on the schema-mysql.sql citation alone (a
// verified-by-payload SOURCE document, not "recalled" training-data memory of LegiScan's API); this
// gap is called out explicitly, never papered over with a fabricated test.
export const VOTE_ID_MAP = {
  1: 'yea', 2: 'nay', 3: 'not_voting', 4: 'absent',
};

// VOTE_TEXT_BY_ID — the English label LegiScan's own `vote_text` field prints for each `vote_id`,
// verified against the same 1163-cast corpus VOTE_ID_MAP itself was derived from (kept as ONE
// shared constant, not two independently-hand-maintained copies, so the corpus-level test and
// reconcileLegiscanTallies' own runtime check below can never silently drift apart). vote_id 3's
// label ('Not Voting') carries the same unconfirmed-by-real-payload caveat as VOTE_ID_MAP's own
// entry for it.
export const VOTE_TEXT_BY_ID = {
  1: 'Yea', 2: 'Nay', 3: 'Not Voting', 4: 'Absent',
};

export class VoteIdMapError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'VoteIdMapError';
    Object.assign(this, meta);
  }
}

// LegiScan's roll_call.chamber is a bare 'H'/'S' code (verified-exhaustive against all 8 real
// roll calls in dataset-2018-1608 — 6 'H', 2 'S' — plus the standalone 747209 fixture, also 'H').
// Mapped to the schema's own house/senate vocabulary (votes.chamber CHECK constraint) rather than
// stored verbatim, so crossCheckAgainstPrimarySource can compare directly against mo-house-xml/
// mo-senate-web rows without every caller re-deriving the mapping.
const CHAMBER_MAP = { H: 'house', S: 'senate' };

export class UnrecognizedLegiscanChamberError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'UnrecognizedLegiscanChamberError';
    Object.assign(this, meta);
  }
}

export function mapLegiscanChamber(chamber) {
  const mapped = CHAMBER_MAP[chamber];
  if (!mapped) {
    throw new UnrecognizedLegiscanChamberError(
      `legiscan-votes: unrecognized chamber code "${chamber}" (expected "H" or "S" — `
        + 'verified-exhaustive against the real 8-roll-call fixture, dataset-2018-1608)',
      { chamber },
    );
  }
  return mapped;
}

// buildLegiscanVoteSourceKey — CONTROLLER RULING 2 (task-6-brief.md, binding — SUPERSEDES the
// brief's own earlier, non-appended "Interfaces (Produces)" sketch, which proposed the 1-argument
// 'legiscan-mo-<roll_call_id>' shape without a session component). The binding scheme is
// 'legiscan-<legiscan_session_id>-rollcall-<roll_call_id>': roll_call_id alone IS already globally
// unique (LegiScan's own key, confirmed unique across every real roll call captured — 774311-
// 774316, 774411, 774412, 747209, no collisions), but the ruling's literal scheme includes the
// session id too, so this function takes both rather than silently dropping the session component
// the ruling specifies. Collision-proof against 'mo-senate-web-*'/'mo-house-xml-*' by prefix
// alphabet alone ('legiscan-' vs 'mo-') — directly tested below, not just asserted.
export function buildLegiscanVoteSourceKey(legiscanSessionId, rollCallId) {
  return `legiscan-${legiscanSessionId}-rollcall-${rollCallId}`;
}

export class LegiscanRollCallReconcileError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LegiscanRollCallReconcileError';
    Object.assign(this, meta);
  }
}

// reconcileLegiscanTallies(rollCall) -> { rollCallId, legiscanBillId, chamber, date, question,
// tallies: {yea,nay,not_voting,absent,total}, casts: [{people_id, position}] }.
// CONTROLLER RULING 1(a): parsed votes[] position counts MUST equal the roll call's own printed
// yea/nay/nv/absent/total fields (all FIVE, including total — not just the four position buckets)
// or this throws LegiscanRollCallReconcileError (RollCallParseError-shaped: message + a meta
// carrying tallies/counted/mismatches/castCount, mirroring mo-rollcall-pdf.js's parseMoRollCall
// gate exactly, but as its own typed class since this is a different source's own printed numbers,
// not a PDF-parsed body). Any vote_id VOTE_ID_MAP doesn't recognize throws VoteIdMapError instead
// (never silently mapped to 'other') — checked before any counting happens, so a single unmapped
// cast fails the whole roll call loud rather than silently undercounting it.
//
// FIX ROUND 2 (MINOR 1): also runs a PER-RECORD vote_id<->vote_text consistency check WHERE
// `vote_text` is present — locking, at runtime, the same empirical guarantee
// tests/legiscan-votes.test.js already proves at the corpus level (1163 real casts, zero
// exceptions). Absent/empty `vote_text` -> no check (some payload shapes may omit the field;
// absence is not itself an inconsistency, never guessed at). A MISMATCH (a real vote_id whose
// printed vote_text disagrees with VOTE_TEXT_BY_ID's own label for it) throws VoteIdMapError naming
// both values — this is a data-integrity signal distinct from an unrecognized vote_id, but shares
// the same typed-error class since both mean "this cast's vote_id cannot be trusted as printed."
export function reconcileLegiscanTallies(rollCall) {
  const rollCallId = rollCall?.roll_call_id;
  const rawVotes = Array.isArray(rollCall?.votes) ? rollCall.votes : [];

  const counted = {
    yea: 0, nay: 0, not_voting: 0, absent: 0,
  };
  const casts = [];
  for (const v of rawVotes) {
    const position = VOTE_ID_MAP[v.vote_id];
    if (!position) {
      throw new VoteIdMapError(
        `legiscan-votes: roll call ${rollCallId}: unrecognized vote_id ${v.vote_id} `
          + `(people_id=${v.people_id}) — VOTE_ID_MAP only covers 1/2/3/4 (yea/nay/not_voting/`
          + 'absent); never silently mapped to "other"',
        { rollCallId, voteId: v.vote_id, peopleId: v.people_id },
      );
    }

    const voteText = v.vote_text;
    if (voteText != null && String(voteText).trim() !== '') {
      const expectedVoteText = VOTE_TEXT_BY_ID[v.vote_id];
      if (voteText !== expectedVoteText) {
        throw new VoteIdMapError(
          `legiscan-votes: roll call ${rollCallId}: vote_id ${v.vote_id} printed vote_text `
            + `"${voteText}", expected "${expectedVoteText}" (people_id=${v.people_id}) — `
            + 'vote_id/vote_text disagree, never silently trusted',
          {
            rollCallId, voteId: v.vote_id, peopleId: v.people_id, voteText, expectedVoteText,
          },
        );
      }
    }

    counted[position] += 1;
    casts.push({ people_id: v.people_id, position });
  }

  const printed = {
    yea: Number(rollCall.yea),
    nay: Number(rollCall.nay),
    not_voting: Number(rollCall.nv),
    absent: Number(rollCall.absent),
    total: Number(rollCall.total),
  };
  const countedTotal = casts.length;

  const mismatches = [];
  if (counted.yea !== printed.yea) mismatches.push(`yea: parsed ${counted.yea} vs printed ${printed.yea}`);
  if (counted.nay !== printed.nay) mismatches.push(`nay: parsed ${counted.nay} vs printed ${printed.nay}`);
  if (counted.not_voting !== printed.not_voting) mismatches.push(`not_voting: parsed ${counted.not_voting} vs printed ${printed.not_voting}`);
  if (counted.absent !== printed.absent) mismatches.push(`absent: parsed ${counted.absent} vs printed ${printed.absent}`);
  if (countedTotal !== printed.total) mismatches.push(`total: parsed ${countedTotal} vs printed ${printed.total}`);

  if (mismatches.length > 0) {
    throw new LegiscanRollCallReconcileError(
      `legiscan-votes: roll call ${rollCallId} parsed vote counts do not reconcile with LegiScan's `
        + `own printed tallies: ${mismatches.join('; ')}`,
      {
        rollCallId,
        tallies: printed,
        counted: { ...counted, total: countedTotal },
        mismatches,
        castCount: countedTotal,
      },
    );
  }

  return {
    rollCallId,
    legiscanBillId: rollCall.bill_id,
    chamber: mapLegiscanChamber(rollCall.chamber),
    date: rollCall.date,
    question: rollCall.desc,
    tallies: {
      yea: counted.yea, nay: counted.nay, not_voting: counted.not_voting, absent: counted.absent, total: countedTotal,
    },
    casts,
  };
}

// ---- primary-source cross-check (CONTROLLER RULING 1(b) / 2) ----
//
// PRIMARY_SOURCE_KEY_PREFIXES — the REAL source_key prefixes the two existing primary-source
// drivers actually write, verified by reading the live code (not the plan's own prose, which
// guessed wrong — see below): 'mo-house-xml-' (src/adapters/mo-house-xml.js's buildMoVoteRows:
// `mo-house-xml-${identifier}-${n}`). 'mo-senate-web-' (src/cli/ingest-mo-senate.js's own
// buildVoteSourceKey: `mo-senate-web-${year}-${pdfBasename}-vote${ordinal}` — this driver's SOURCE
// constant is 'mo-senate-web', not 'mo-senate-journal-pdf'; mo-senate-journal-pdf.js is the PARSER
// module and never builds a source_key itself, that's the driver's job). Both task-6-brief.md's own
// "Interfaces (Produces)" text and the plan doc's Task 6 description say "mo-senate-journal-pdf
// source_key prefix" — that phrase does not appear anywhere in the actual driver code; corrected
// here after reading src/cli/ingest-mo-senate.js directly (verify current state, don't trust a
// stale doc — per project convention).
//
// DISPLAY-TIME DEDUP RULE (Task 8 of the plan, CONTROLLER RULING 3 — documented here, not coded):
// Task 7 (docs/research/2026-07-29-legiscan-substitute-vehicles.md) confirmed the same real floor
// vote can now legitimately exist as TWO stored rows — a LegiScan row (this module) and a
// primary-source row (source_key prefixed below), different source_keys, both correctly stored
// (expected, not a bug — neither source subsumes the other for every case, per Task 7's finding).
// A downstream consumer (Plan 3's bill/vote rendering, not built yet) needs a tie-break rule for
// which row to SHOW: the primary-source row wins for display whenever both exist for the same
// (chamber, date, bill, tallies) — exactly the correspondence crossCheckAgainstPrimarySource below
// already computes for its flag rows, so Plan 3 can reuse this function's candidate-matching logic
// rather than re-deriving it. This is documentation only, no code change: the flag rows this
// function already writes on any mismatch make the correspondence visible for a human reviewer;
// nothing here silently hides, merges, or deletes the LegiScan row. Same rule is restated in
// src/cli/ingest-mo-house.js's and src/cli/ingest-mo-senate.js's own module-header comments.
export const PRIMARY_SOURCE_KEY_PREFIXES = ['mo-house-xml-', 'mo-senate-web-'];

// KNOWN CAVEAT (task-6-brief.md, explicit; promoted to a STRUCTURAL rule by FIX ROUND 1; SOFTENED
// by FIX ROUND 2 MINOR 2 — a reviewer's adversarial case showed the original opening clause read as
// asserting the accounting-difference explanation, when it is only ONE possible explanation among
// others): LegiScan's own ls_vote schema has NO distinct "Present" vote_id (only Yea/Nay/NV/Absent)
// while MO House's own roll-call PDFs DO print a distinct "Present" category (mo-rollcall-pdf.js's
// POSITION_MAP: Y/N/P/@) — so a genuine Present cast on the primary-source side has no LegiScan
// analog and can only ever show up as a disagreement in the combined non-yea/non-nay bucket (see
// compareTalliesForCrossCheck below). But that disagreement can ALSO be a genuine missing- or
// extra-voter defect on either side — this comparison alone cannot mechanically tell the two apart,
// and the caveat text below no longer implies it can. The raw tallies recorded in the flag row
// (source_a_tallies/source_b_tallies) are the actual evidence a human reviewer should weigh, not
// this caveat standing in for that judgment.
export const PRESENT_CATEGORY_CAVEAT = 'LegiScan\'s ls_vote schema has no distinct "Present" vote_id '
  + '(only Yea/Nay/NotVoting/Absent) while MO House\'s own roll-call PDFs print a distinct "Present" '
  + 'category (Y/N/P/@) — a disagreement in the combined non-yea/non-nay bucket below MAY be that '
  + 'category-vocabulary difference (an accounting difference, not a contradiction), but it can also '
  + 'be a genuine missing- or extra-voter defect on either side; this comparison alone cannot tell '
  + 'the two apart. The raw tallies recorded in this flag are the evidence — check for Present casts '
  + 'on the primary-source side, but do not assume that alone explains it.';

function sameCalendarDate(a, b) {
  if (a == null || b == null) return false;
  return String(a).slice(0, 10) === String(b).slice(0, 10);
}

// primarySourceLabel — the flag row's `source_b` value: the matching prefix with its trailing
// dash stripped ('mo-house-xml-' -> 'mo-house-xml'), or 'unknown-primary-source' for a source_key
// that somehow passed the PRIMARY_SOURCE_KEY_PREFIXES filter but doesn't literally start with
// either prefix (defensive — not reachable via this module's own filtering, but a flag row should
// never silently mislabel its source if that ever changes). Shared by every branch below that
// writes a flag against a specific primary-source candidate.
function primarySourceLabel(sourceKey) {
  const matchedPrefix = PRIMARY_SOURCE_KEY_PREFIXES.find((prefix) => sourceKey.startsWith(prefix));
  return matchedPrefix ? matchedPrefix.replace(/-$/, '') : 'unknown-primary-source';
}

function summarizePrimaryCastPositions(castRows) {
  const counts = {
    yea: 0, nay: 0, present: 0, absent: 0, not_voting: 0, other: 0,
  };
  for (const row of castRows) {
    const key = Object.prototype.hasOwnProperty.call(counts, row.position) ? row.position : 'other';
    counts[key] += 1;
  }
  return counts;
}

// compareTalliesForCrossCheck — FIX ROUND 1 (controller ruling): splits mismatches into two kinds,
// deliberately treated differently by the caller:
//   - HARD (yea/nay): both sources define these two categories identically and they determine the
//     vote's outcome/attribution — a difference here is a REAL divergence, never explained away by
//     a category-vocabulary quirk. Compared category-for-category, no caveat attached.
//   - SOFT (the combined "non-yea/non-nay" bucket: LegiScan not_voting+absent vs primary
//     present+absent+not_voting+other): folded into ONE combined value rather than compared
//     sub-bucket-by-sub-bucket, precisely BECAUSE of the Present-category caveat (comparing
//     present/absent/not_voting 1:1 would manufacture false mismatches out of a real
//     category-vocabulary difference between the two sources, not an actual data disagreement) — an
//     accounting difference, not a contradiction (see PRESENT_CATEGORY_CAVEAT above).
function compareTalliesForCrossCheck(legiscanTallies, primaryCounts) {
  const hardMismatches = [];
  if (legiscanTallies.tallies.yea !== primaryCounts.yea) {
    hardMismatches.push(`yea: legiscan ${legiscanTallies.tallies.yea} vs primary ${primaryCounts.yea}`);
  }
  if (legiscanTallies.tallies.nay !== primaryCounts.nay) {
    hardMismatches.push(`nay: legiscan ${legiscanTallies.tallies.nay} vs primary ${primaryCounts.nay}`);
  }

  const softMismatches = [];
  const legiscanNonVote = legiscanTallies.tallies.not_voting + legiscanTallies.tallies.absent;
  const primaryNonVote = primaryCounts.present + primaryCounts.absent + primaryCounts.not_voting + primaryCounts.other;
  if (legiscanNonVote !== primaryNonVote) {
    softMismatches.push(
      `non-yea/non-nay bucket: legiscan not_voting+absent=${legiscanNonVote} vs primary `
        + `present+absent+not_voting+other=${primaryNonVote}`,
    );
  }

  return { hardMismatches, softMismatches };
}

// writeReconciliationFlag — Draft-then-apply degradation (Global Constraints, plan doc): migration
// 0010 (vote_reconciliation_flags) is draft-only until Lance applies it. A discrepancy detected
// before that point is never silently dropped — it's returned with gated:true and the SAME
// discrepancy payload, so a caller can log/report it even though it couldn't be durably recorded
// yet; a re-run after the migration lands re-detects and this time persists it.
async function writeReconciliationFlag(client, {
  voteId, sourceB, discrepancy, runId,
}) {
  const { data, error } = await client
    .from('vote_reconciliation_flags')
    .insert({
      vote_id: voteId, source_a: 'legiscan', source_b: sourceB, discrepancy, run_id: runId ?? null,
    })
    .select()
    .single();
  if (error) {
    if (isMissingRelationError(error, 'vote_reconciliation_flags')) {
      return {
        gated: true,
        note: 'vote_reconciliation_flags table not found — migration 0010 '
          + '(supabase/migrations/0010_legiscan_identity_and_ledger.sql) not yet applied; the '
          + 'discrepancy below was detected but could not be durably recorded. Never silently '
          + 'dropped — re-run after Lance applies the migration to re-detect and persist it.',
        discrepancy,
      };
    }
    throw new Error(`legiscan-votes: could not write vote_reconciliation_flags row: ${error.message}`);
  }
  return data;
}

// crossCheckAgainstPrimarySource(client, billId, legiscanTallies) -> { checked, matched, flag,
// quarantine }. `billId` is OUR canonical bills.id (uuid) — already resolved by the caller (Task
// 9's driver) via LegiScan's own numeric bill_id -> Task 4's parsed bill record ->
// normalizeBillIdentifier -> `bills` row (CONTROLLER RULING 4 — read normalizeMoBillIdentifier/
// normalizeBillIdentifier, never re-implemented here). `legiscanTallies` is reconcileLegiscanTallies'
// return value; an optional `legiscanTallies.runId` rides into any flag row the same way every
// other table's provenance column does.
//
// FIX ROUND 1 (controller ruling — the contract SIMPLIFIED here, not just extended): every flag row
// this function writes attaches to the PRIMARY-SOURCE vote's own id (already-known from the lookup
// below), NOT a LegiScan `votes.id`. This is deliberate, not incidental: `quarantine:true` means the
// LegiScan vote is NEVER stored at all, so it can never have a `votes.id` for
// `vote_reconciliation_flags.vote_id` (not null) to reference — attaching to the primary-source
// row (which by construction always exists, being the very thing being compared against) is the
// only choice that works in every branch, including quarantine. This ALSO means the caller no
// longer needs to insert the LegiScan vote before calling this function (the original design's
// `legiscanTallies.voteId` pre-attachment requirement is gone) — this function is meant to run
// BEFORE the driver decides whether to call insertIfAbsent('votes', ...) at all, so it can act as
// the actual store/quarantine gate, not an after-the-fact audit of an already-stored row.
//
// Matching (CONTROLLER RULING 2): by (jurisdiction, chamber, date, bill identifier) — exact match
// only, ambiguity -> flags row, never guessed. jurisdiction_id/chamber/bill_id are pushed down as
// server-side .eq() filters (bill_id alone already pins one specific bill row, which pins
// jurisdiction transitively — the explicit jurisdiction_id filter is redundant-but-harmless
// defense in depth, not decorative). `date` is compared client-side on the calendar-day component
// only (sameCalendarDate) rather than a server .eq(): vote_date is a timestamptz column while
// LegiScan's own `date` field is a bare 'YYYY-MM-DD' string, and an exact-timestamp .eq() risks
// silently missing a real match over a time-of-day component neither source actually controls
// consistently — the source_key-prefix + date-and-chamber-and-bill combination is still "exact
// match" in the sense the ruling means (no fuzzy text matching, no picking a "closest" row).
// (jurisdiction, chamber, date, bill) is NOT always enough to pin exactly one row — FIX ROUND 2's
// same-day disambiguation (see below) exists precisely because it sometimes isn't (the real HB 3
// fixture: 5 same-day House roll calls). One round-trip for the vote-row lookup, plus one more per
// candidate for that candidate's own cast tally (a handful at most, bounded by how many roll calls
// one bill/chamber/date can realistically hold in one real legislative day) — plain .select(),
// selectAll (src/lib/db.js:85) not needed at either step.
export async function crossCheckAgainstPrimarySource(client, billId, legiscanTallies) {
  const { data, error } = await client
    .from('votes')
    .select('id,vote_date,chamber,source_key,jurisdiction_id')
    .eq('bill_id', billId)
    .eq('jurisdiction_id', 'mo-legislature')
    .eq('chamber', legiscanTallies.chamber);
  if (error) throw new Error(`legiscan-votes cross-check vote lookup failed: ${error.message}`);

  const candidates = (data ?? []).filter((row) => (
    PRIMARY_SOURCE_KEY_PREFIXES.some((prefix) => String(row.source_key ?? '').startsWith(prefix))
    && sameCalendarDate(row.vote_date, legiscanTallies.date)
  ));

  if (candidates.length === 0) return {
    checked: false, matched: null, flag: null, quarantine: false,
  };

  if (candidates.length === 1) {
    // The ordinary case (one primary-source vote per bill/chamber/date) — round-1 semantics,
    // unchanged: a 1:1 correspondence is directly assertable without needing tally disambiguation,
    // so quarantine on a hard mismatch is safe here in a way it is NOT for the multi-candidate
    // branch below.
    const primaryVote = candidates[0];
    const { data: castRows, error: castErr } = await client
      .from('vote_casts')
      .select('position')
      .eq('vote_id', primaryVote.id);
    if (castErr) throw new Error(`legiscan-votes cross-check cast lookup failed: ${castErr.message}`);

    const primaryCounts = summarizePrimaryCastPositions(castRows ?? []);
    const { hardMismatches, softMismatches } = compareTalliesForCrossCheck(legiscanTallies, primaryCounts);

    if (hardMismatches.length === 0 && softMismatches.length === 0) {
      return {
        checked: true, matched: true, flag: null, quarantine: false,
      };
    }

    // FIX ROUND 1: quarantine iff a HARD (yea/nay) mismatch exists — a soft (bucket-only) mismatch
    // flags but stores (accounting difference, not necessarily a contradiction; see
    // PRESENT_CATEGORY_CAVEAT and compareTalliesForCrossCheck's own comment). The caveat is
    // attached only when the soft bucket is actually part of what's being flagged — a pure
    // yea/nay divergence isn't explained by a category-vocabulary quirk, so attaching the caveat
    // there would misleadingly soften a REAL divergence instead of clarifying an accounting one.
    const quarantine = hardMismatches.length > 0;
    const discrepancy = {
      source_a_tallies: legiscanTallies.tallies,
      source_b_tallies: primaryCounts,
      source_b_vote_id: primaryVote.id,
      source_b_source_key: primaryVote.source_key,
      hard_mismatches: hardMismatches,
      soft_mismatches: softMismatches,
      quarantine,
    };
    if (softMismatches.length > 0) discrepancy.caveat = PRESENT_CATEGORY_CAVEAT;
    const flag = await writeReconciliationFlag(client, {
      voteId: primaryVote.id, sourceB: primarySourceLabel(primaryVote.source_key), discrepancy, runId: legiscanTallies.runId,
    });
    return {
      checked: true, matched: false, flag, quarantine,
    };
  }

  // candidates.length > 1 — FIX ROUND 2 ("same-day multi-roll-call blindness"): more than one
  // primary-source vote shares this exact (jurisdiction, chamber, date, bill) tuple (the real HB 3
  // fixture: 5 House roll calls, all 2018-09-12). (jurisdiction, chamber, date, bill) alone cannot
  // distinguish between them, so disambiguate by TALLY IDENTITY — (yea, nay), the two categories
  // both sources define identically (see compareTalliesForCrossCheck's own hard/soft split).
  //
  // CIRCULARITY GUARD (explicit, per the controller ruling; corrected by FIX ROUND 3 — see the
  // module header for the regression this replaced): (yea, nay) equality is how a corresponding
  // row is IDENTIFIED in this branch, so a candidate selected this way can NEVER also be reported
  // as a HARD mismatch against itself (that would compare a value to itself and trivially always
  // agree, manufacturing a false verification out of nothing) — that part is genuinely guaranteed
  // by construction. But identifying WHICH row corresponds is not the same as confirming the two
  // sources agree on EVERYTHING about that vote: the selected candidate still goes through the
  // full compareTalliesForCrossCheck (below, once selected) exactly like the single-candidate
  // path, so a soft-bucket disagreement on the selected candidate is still caught, not waved
  // through just because tally-selection is how it was found.
  const candidateTallies = [];
  for (const c of candidates) {
    // Sequential, not Promise.all: a handful of same-day candidates at most (5 real, per the HB 3
    // fixture) — not a scale where parallelism matters, and sequential keeps the loop trivially
    // readable/debuggable, same "small/infrequent, readability over throughput" precedent as
    // ingest-mo-senate.js's replayJournalArtifacts.
    // eslint-disable-next-line no-await-in-loop
    const { data: castRows, error: castErr } = await client
      .from('vote_casts')
      .select('position')
      .eq('vote_id', c.id);
    if (castErr) throw new Error(`legiscan-votes cross-check cast lookup failed: ${castErr.message}`);
    candidateTallies.push({ candidate: c, counts: summarizePrimaryCastPositions(castRows ?? []) });
  }

  const tallyMatches = candidateTallies.filter(({ counts }) => (
    counts.yea === legiscanTallies.tallies.yea && counts.nay === legiscanTallies.tallies.nay
  ));

  if (tallyMatches.length === 1) {
    // FIX ROUND 3: TALLY-UNIQUE SELECTION IS SELECTION, NOT VERIFICATION. Finding the one
    // same-day candidate whose (yea, nay) agrees with LegiScan's only identifies WHICH row
    // corresponds — it does not by itself confirm the two sources agree on everything else about
    // that vote. The selected candidate now runs through the exact same compareTalliesForCrossCheck
    // the single-candidate path uses (reusing the function, not a second hand-rolled comparison,
    // so this class of regression can't reappear via code drift between two copies).
    const { candidate: selectedCandidate, counts: selectedCounts } = tallyMatches[0];
    const { hardMismatches, softMismatches } = compareTalliesForCrossCheck(legiscanTallies, selectedCounts);
    // hardMismatches is IMPOSSIBLE here by construction (yea/nay equality is literally the filter
    // that put this candidate in tallyMatches) — proved by reuse of the shared function rather than
    // assumed, but never hand-waved into a hardcoded `false` either: quarantine is derived the same
    // way the single-candidate path derives it, so if that invariant were ever broken by a future
    // change to the selection filter, this code would still behave correctly rather than silently
    // asserting something no longer true.
    const quarantine = hardMismatches.length > 0;

    if (hardMismatches.length === 0 && softMismatches.length === 0) {
      // The real happy path: verification actually passing, not just selection succeeding.
      return {
        checked: true, matched: true, flag: null, quarantine: false, reason: 'tally_unique_match',
      };
    }

    // A soft-bucket mismatch on the tally-uniquely-selected candidate: same shape/consequence as
    // the single-candidate path's own soft-mismatch branch (stores, flags, caveat attached — an
    // accounting difference or a genuine defect, never automatically quarantined for a soft-only
    // mismatch), PLUS a `note` documenting that this candidate was identified via tally-unique
    // selection among N same-day candidates — a reviewer seeing this flag should know the
    // disambiguation mechanism that picked this specific row, not just the mismatch itself.
    const discrepancy = {
      source_a_tallies: legiscanTallies.tallies,
      source_b_tallies: selectedCounts,
      source_b_vote_id: selectedCandidate.id,
      source_b_source_key: selectedCandidate.source_key,
      hard_mismatches: hardMismatches,
      soft_mismatches: softMismatches,
      quarantine,
      note: `selected via tally-unique (yea, nay) match among ${candidates.length} same-day candidates for this (jurisdiction, chamber, date, bill) tuple`,
    };
    if (softMismatches.length > 0) discrepancy.caveat = PRESENT_CATEGORY_CAVEAT;
    const flag = await writeReconciliationFlag(client, {
      voteId: selectedCandidate.id, sourceB: primarySourceLabel(selectedCandidate.source_key), discrepancy, runId: legiscanTallies.runId,
    });
    return {
      checked: true, matched: false, flag, quarantine,
    };
  }

  if (tallyMatches.length === 0) {
    // No same-day candidate's (yea, nay) corresponds to LegiScan's roll call — quarantine requires
    // an assertable 1:1 correspondence to contradict, and none exists here (this is exactly why
    // this branch is capped at flag-for-human, never automatic quarantine). Stores (internally
    // reconciled by gate (a), uncontradicted by anything specific), but flagged so a human can see
    // the primary source and LegiScan disagree SOMEWHERE among this day's votes even though the
    // exact pairing can't be established mechanically.
    const discrepancy = {
      reason: 'no_tally_corresponding_primary',
      legiscan_tallies: legiscanTallies.tallies,
      candidates: candidateTallies.map(({ candidate, counts }) => ({
        source_key: candidate.source_key, vote_id: candidate.id, tallies: counts,
      })),
      quarantine: false,
    };
    const flag = await writeReconciliationFlag(client, {
      voteId: candidates[0].id, sourceB: primarySourceLabel(candidates[0].source_key), discrepancy, runId: legiscanTallies.runId,
    });
    return {
      checked: true, matched: false, flag, quarantine: false,
    };
  }

  // tallyMatches.length > 1 — two or more same-day candidates coincidentally share the exact same
  // (yea, nay) as LegiScan's roll call (genuinely possible: two procedural votes with identical
  // head counts, not assumed impossible). Cannot pick one without guessing — every match agrees on
  // the tally, it's WHICH row corresponds that's unresolved — so this stores (uncontradicted) and
  // flags the matching subset for human review.
  const discrepancy = {
    reason: 'ambiguous_tally_match',
    legiscan_tallies: legiscanTallies.tallies,
    matching_candidates: tallyMatches.map(({ candidate, counts }) => ({
      source_key: candidate.source_key, vote_id: candidate.id, tallies: counts,
    })),
    quarantine: false,
  };
  const flag = await writeReconciliationFlag(client, {
    voteId: tallyMatches[0].candidate.id, sourceB: primarySourceLabel(tallyMatches[0].candidate.source_key), discrepancy, runId: legiscanTallies.runId,
  });
  return {
    checked: true, matched: false, flag, quarantine: false,
  };
}

// ---- cast resolution (CONTROLLER RULING 3) ----
//
// buildLegiscanVoteCasts — "Casts resolve via Task 5's mapping (legiscan_people_id ->
// legislator_id); an unmapped people_id is an unresolved cast (honest count + sample), never
// guessed." Deliberately pure (a plain Map lookup, no DB call per cast): by the time a roll call's
// casts are being built, the driver has already run resolveOrCreateLegiscanPerson (Task 5) once
// per unique people_id encountered in the whole session (sponsors + every roll call's voters) and
// naturally has a people_id -> legislator_id map in hand — re-querying per cast would be a real N+1
// query cost this plan's own budget constraints (30,000 queries/month) can't afford, and isn't
// needed once that map already exists. `unresolved.sample` caps at 10, same convention as
// src/cli/ingest-mo-senate.js's own unresolvedSample slicing.
export function buildLegiscanVoteCasts({
  voteId, runId, casts, legislatorIdByPeopleId,
}) {
  const resolved = [];
  const unresolved = [];
  for (const cast of casts) {
    const legislatorId = legislatorIdByPeopleId?.get(cast.people_id) ?? null;
    if (legislatorId) {
      resolved.push({
        vote_id: voteId, legislator_id: legislatorId, position: cast.position, run_id: runId ?? null,
      });
    } else {
      unresolved.push({ people_id: cast.people_id, position: cast.position });
    }
  }
  return {
    casts: resolved,
    unresolved: { count: unresolved.length, sample: unresolved.slice(0, 10) },
  };
}
