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
//       vote, compare; a disagreement is durably flagged (vote_reconciliation_flags, migration
//       0010) and returned as matched:false, but the LegiScan vote is NOT quarantined (its own
//       internal gate already passed) — never silently resolved either way. No primary-source
//       counterpart is NOT a failure (checked:false) — LegiScan covers far more sessions than the
//       primary parsers have reached; that's the whole point of this backfill.
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
export const PRIMARY_SOURCE_KEY_PREFIXES = ['mo-house-xml-', 'mo-senate-web-'];

// KNOWN CAVEAT (task-6-brief.md, explicit): LegiScan's own ls_vote schema has NO distinct
// "Present" vote_id (only Yea/Nay/NV/Absent) while MO House's own roll-call PDFs DO print a
// distinct "Present" category (mo-rollcall-pdf.js's POSITION_MAP: Y/N/P/@). A genuine Present cast
// on the primary-source side therefore has no LegiScan analog at all — it can only ever show up as
// a disagreement in the combined non-yea/non-nay bucket (see compareTalliesForCrossCheck below),
// which is NOT necessarily a real data error. Recorded verbatim in every discrepancy flag this
// function writes so a human reviewer is never misled by a bare mismatch number.
export const PRESENT_CATEGORY_CAVEAT = 'LegiScan\'s ls_vote schema has no distinct "Present" vote_id '
  + '(only Yea/Nay/NotVoting/Absent) while MO House\'s own roll-call PDFs print a distinct "Present" '
  + 'category (Y/N/P/@). A disagreement in the combined non-yea/non-nay bucket below may reflect '
  + 'that category difference rather than a genuine data error — check for Present casts on the '
  + 'primary-source side before treating this as a real discrepancy.';

function sameCalendarDate(a, b) {
  if (a == null || b == null) return false;
  return String(a).slice(0, 10) === String(b).slice(0, 10);
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

// compareTalliesForCrossCheck — yea/nay are compared category-for-category (both sources map these
// unambiguously, no caveat needed). Everything else is compared only as a COMBINED "non-yea/non-nay"
// bucket (LegiScan not_voting+absent vs primary present+absent+not_voting+other) BECAUSE of the
// Present-category caveat above — comparing sub-buckets 1:1 would manufacture false mismatches out
// of a real category-vocabulary difference, not an actual data disagreement.
function compareTalliesForCrossCheck(legiscanTallies, primaryCounts) {
  const legiscanNonVote = legiscanTallies.tallies.not_voting + legiscanTallies.tallies.absent;
  const primaryNonVote = primaryCounts.present + primaryCounts.absent + primaryCounts.not_voting + primaryCounts.other;
  const mismatches = [];
  if (legiscanTallies.tallies.yea !== primaryCounts.yea) {
    mismatches.push(`yea: legiscan ${legiscanTallies.tallies.yea} vs primary ${primaryCounts.yea}`);
  }
  if (legiscanTallies.tallies.nay !== primaryCounts.nay) {
    mismatches.push(`nay: legiscan ${legiscanTallies.tallies.nay} vs primary ${primaryCounts.nay}`);
  }
  if (legiscanNonVote !== primaryNonVote) {
    mismatches.push(
      `non-yea/non-nay: legiscan not_voting+absent=${legiscanNonVote} vs primary `
        + `present+absent+not_voting+other=${primaryNonVote}`,
    );
  }
  return mismatches;
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

// crossCheckAgainstPrimarySource(client, billId, legiscanTallies) -> { checked, matched, flag }.
// `billId` is OUR canonical bills.id (uuid) — already resolved by the caller (Task 9's driver) via
// LegiScan's own numeric bill_id -> Task 4's parsed bill record -> normalizeBillIdentifier ->
// `bills` row (CONTROLLER RULING 4 — read normalizeMoBillIdentifier/normalizeBillIdentifier,
// never re-implemented here). `legiscanTallies` is reconcileLegiscanTallies' return value, PLUS a
// `voteId` field (the already-inserted LegiScan `votes.id`) the caller must attach before calling
// this function — reconcileLegiscanTallies is pure and never touches the DB, so it cannot know the
// DB-generated id; by the time this cross-check runs (per the plan's Task 9 flow: reconcile ->
// insertIfAbsent('votes',...) -> crossCheckAgainstPrimarySource -> per-cast insert), the LegiScan
// vote row already exists. An optional `legiscanTallies.runId` rides into the flag row the same way
// every other table's provenance column does.
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
// Single round-trip for the vote-row lookup ("at most one primary-source vote per real roll call"
// per the interface note) plus one more for that vote's own cast tally — plain .select(), selectAll
// (src/lib/db.js:85) not needed at either step (both narrow-filter-bounded to a handful of rows).
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

  if (candidates.length === 0) return { checked: false, matched: null, flag: null };

  if (candidates.length > 1) {
    // Ambiguity -> flags row, never guessed (CONTROLLER RULING 2, literal): more than one
    // primary-source vote row matches the same (jurisdiction, chamber, date, bill) tuple — this
    // should never happen for a real single roll call, but if it does, picking one arbitrarily
    // would be exactly the kind of silent guess this project's fail-loud convention forbids.
    const discrepancy = {
      reason: 'ambiguous_primary_source_match',
      legiscan_tallies: legiscanTallies.tallies,
      candidate_source_keys: candidates.map((c) => c.source_key),
      caveat: PRESENT_CATEGORY_CAVEAT,
    };
    const flag = await writeReconciliationFlag(client, {
      voteId: legiscanTallies.voteId, sourceB: 'ambiguous', discrepancy, runId: legiscanTallies.runId,
    });
    return { checked: true, matched: false, flag };
  }

  const primaryVote = candidates[0];
  const { data: castRows, error: castErr } = await client
    .from('vote_casts')
    .select('position')
    .eq('vote_id', primaryVote.id);
  if (castErr) throw new Error(`legiscan-votes cross-check cast lookup failed: ${castErr.message}`);

  const primaryCounts = summarizePrimaryCastPositions(castRows ?? []);
  const mismatches = compareTalliesForCrossCheck(legiscanTallies, primaryCounts);

  if (mismatches.length === 0) return { checked: true, matched: true, flag: null };

  const matchedPrefix = PRIMARY_SOURCE_KEY_PREFIXES.find((prefix) => primaryVote.source_key.startsWith(prefix));
  const sourceB = matchedPrefix ? matchedPrefix.replace(/-$/, '') : 'unknown-primary-source';
  const discrepancy = {
    source_a_tallies: legiscanTallies.tallies,
    source_b_tallies: primaryCounts,
    source_b_vote_id: primaryVote.id,
    source_b_source_key: primaryVote.source_key,
    mismatches,
    caveat: PRESENT_CATEGORY_CAVEAT,
  };
  const flag = await writeReconciliationFlag(client, {
    voteId: legiscanTallies.voteId, sourceB, discrepancy, runId: legiscanTallies.runId,
  });
  return { checked: true, matched: false, flag };
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
