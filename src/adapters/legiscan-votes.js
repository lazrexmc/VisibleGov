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

// VOTE_TEXT_BY_ID — the accepted `vote_text` labels LegiScan prints for each `vote_id`, per-id
// SETS (verified against the 1163-cast fixture corpus for 1/2/4, which print only the long
// forms). vote_id 3 was fixture-unconfirmed until the first live 31-session sweep (2026-07-29),
// where every real payload printed the ABBREVIATION 'NV' — not the 'Not Voting' long form in
// LegiScan's own schema-mysql.sql lookup table — and the strict-equality version of this check
// refused all 1,817 such roll calls (correct fail-loud behavior on first contact; see
// ingestion_runs detail for that sweep). Both evidenced forms are accepted; any OTHER live
// variant still fails loud, exactly as 'NV' did.
export const VOTE_TEXT_BY_ID = {
  1: ['Yea'], 2: ['Nay'], 3: ['Not Voting', 'NV'], 4: ['Absent'],
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

// LegiscanRollCallDateError — FINAL REVIEW, finding 3 (code half; the correction of the rows
// already stored is Lance-gated and deliberately NOT done here). Ten MO roll calls are stored with
// vote_date 1969-12-31 — the Unix-epoch-minus-one sentinel LegiScan's own payload prints when it
// has no date for a roll call. It was stored verbatim, exactly as designed ("store only what's
// printed"), and it is now a live 1969 bucket on a real profile's vote chart plus an undercount of
// that legislator's real year.
//
// The rule this closes is the same one gate (a) already enforces on tallies: a roll call whose own
// printed numbers contradict the dataset they arrived in is not stored, it is refused and counted.
// A date outside the dataset's OWN year_start/year_end is that same class of self-contradiction —
// the session envelope says 2019, the roll call says 1969, and no amount of reading either field
// harder resolves it. So it refuses loud rather than being corrected, clamped, or nulled (any of
// which would be this project inventing a fact the source never printed).
export class LegiscanRollCallDateError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LegiscanRollCallDateError';
    Object.assign(this, meta);
  }
}

const ROLL_CALL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// assertRollCallDateWithinSession — the guard itself, exported so a caller can run it standalone.
// `sessionYears` is `{ yearStart, yearEnd }` straight off the dataset envelope's own year_start/
// year_end fields (src/cli/ingest-legiscan.js already reads them for sessionWindow); null means
// "no bounds known", in which case only the SHAPE of the date is checked. Both branches throw the
// same typed error with a `reason`, so the driver routes them through one catch.
export function assertRollCallDateWithinSession(rollCallId, date, sessionYears = null) {
  const match = typeof date === 'string' ? ROLL_CALL_DATE_PATTERN.exec(date.trim()) : null;
  if (!match) {
    throw new LegiscanRollCallDateError(
      `legiscan-votes: roll call ${rollCallId}: date ${JSON.stringify(date)} is not a printed `
        + 'YYYY-MM-DD calendar date — a vote that cannot be placed in time is never stored',
      { rollCallId, date, reason: 'unparseable_date' },
    );
  }
  if (!sessionYears || sessionYears.yearStart == null) return date.trim();
  const year = Number(match[1]);
  const yearStart = Number(sessionYears.yearStart);
  const yearEnd = Number(sessionYears.yearEnd ?? sessionYears.yearStart);
  if (year < yearStart || year > yearEnd) {
    throw new LegiscanRollCallDateError(
      `legiscan-votes: roll call ${rollCallId}: printed date ${date} (year ${year}) falls outside `
        + `this dataset's own session years ${yearStart}-${yearEnd} — the source contradicts itself, `
        + 'so the roll call is refused rather than stored under a date the session cannot have had '
        + '(LegiScan prints 1969-12-31 as its own missing-date sentinel)',
      {
        rollCallId, date, year, yearStart, yearEnd, reason: 'outside_session_years',
      },
    );
  }
  return date.trim();
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
export function reconcileLegiscanTallies(rollCall, sessionYears = null) {
  const rollCallId = rollCall?.roll_call_id;
  const rawVotes = Array.isArray(rollCall?.votes) ? rollCall.votes : [];

  // FINAL REVIEW, finding 3: gate (a) is now TWO self-consistency checks against the source's own
  // printed fields, not one — the tallies below, and the date here. Run FIRST, before any counting:
  // a roll call the dataset itself cannot place in time has nothing worth counting, and a single
  // typed refusal is cheaper to read in the run detail than a tally report about a 1969 vote.
  // `sessionYears` is optional at THIS layer (the shape check still runs without it) but the driver
  // always supplies it — see ingestLegiscanRollCalls, which requires it.
  assertRollCallDateWithinSession(rollCallId, rollCall?.date, sessionYears);

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
      if (!expectedVoteText.includes(voteText)) {
        throw new VoteIdMapError(
          `legiscan-votes: roll call ${rollCallId}: vote_id ${v.vote_id} printed vote_text `
            + `"${voteText}", expected one of ${JSON.stringify(expectedVoteText)} (people_id=${v.people_id}) — `
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

// EXPORTED (2026-08-01, .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md): this and
// summarizePrimaryCastPositions/compareTalliesForCrossCheck/writeReconciliationFlag below are the
// pure-comparison/write helpers correct-data.js's mo-2026-session-merge reconciliation phase
// reuses directly, rather than re-implementing the same tally/date comparison a second time. Pure
// additive change — just the `export` keyword, zero behavior change to any existing caller.
export function sameCalendarDate(a, b) {
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

export function summarizePrimaryCastPositions(castRows) {
  const counts = {
    yea: 0, nay: 0, present: 0, absent: 0, not_voting: 0, other: 0,
  };
  for (const row of castRows) {
    const key = Object.prototype.hasOwnProperty.call(counts, row.position) ? row.position : 'other';
    counts[key] += 1;
  }
  return counts;
}

// PRIMARY_RESULT_AGGREGATE_PATTERN / parsePrimaryResultAggregate / isPrimaryCastDataComparable —
// FIX (CRITICAL 3, final-review-findings.md, 2026-07-29 final whole-branch review). Primary tallies
// were derived SOLELY from stored vote_casts, but a zero- or partially-cast primary row is a
// designed routine state, not an anomaly: mo-house's two-phase ingestion writes the `votes` row
// from the bill XML immediately while its casts arrive later from a separately-polled roll-call PDF
// (listPendingRollCallPdfs's own definition of "pending" is exactly this gap); mo-senate's
// roster-gating and dropped unresolved-surname casts create the same undercounted shape. Comparing
// an undercounted castRows summary against LegiScan's own COMPLETE printed tally would manufacture
// a false hard (yea/nay) contradiction and quarantine an already-reconciled LegiScan vote for
// nothing but the primary pipeline's own backlog.
//
// CONTROLLER AMENDMENT (final-review-findings.md, Finding 3): mo-house-xml.js's buildMoVoteRows
// prints the vote's own complete aggregate as `result: "<yea>-<nay>"` at vote-creation time,
// independent of whether casts have landed yet — prefer it for the hard comparison once available.
// mo-senate-web (src/cli/ingest-mo-senate.js) stores result:null unconditionally by ruling (its
// journal-PDF text has no equivalent aggregate line to parse); for those rows there is no aggregate
// to fall back on, so zero casts is the only mechanically-detectable "not landed yet" signal.
const PRIMARY_RESULT_AGGREGATE_PATTERN = /^(\d+)-(\d+)$/;

// EXPORTED (2026-08-01, task-review.md Important 4 / this file's own header comment above):
// correct-data.js's mo-2026-session-merge reconciliation phase reuses these two directly so a
// primary row whose casts haven't landed yet (routine two-phase-ingestion backlog state, not an
// anomaly) is never mistaken for a real hard mismatch — pure additive change, zero behavior change
// to any existing caller.
export function parsePrimaryResultAggregate(result) {
  if (typeof result !== 'string') return null;
  const m = PRIMARY_RESULT_AGGREGATE_PATTERN.exec(result.trim());
  if (!m) return null;
  return { yea: Number(m[1]), nay: Number(m[2]) };
}

// Never hard-quarantine (or hard-flag) on a primary row whose own cast data is incomplete relative
// to its printed aggregate (mo-house shape — casts still short of aggregate.yea+aggregate.nay), or
// whose aggregate is null (mo-senate shape) and casts are zero — the LITERAL two conditions the
// controller amendment names.
export function isPrimaryCastDataComparable(aggregate, totalPrimaryCasts) {
  if (aggregate) return totalPrimaryCasts >= (aggregate.yea + aggregate.nay);
  return totalPrimaryCasts > 0;
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
export function compareTalliesForCrossCheck(legiscanTallies, primaryCounts) {
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

// isUniqueViolation — the Postgres/PostgREST code for a unique-constraint violation, source-
// agnostic (which index doesn't matter here, only that an insert lost a race to a matching row).
function isUniqueViolation(error) {
  return error?.code === '23505';
}

// findExistingReconciliationFlag / writeReconciliationFlag — FIX (IMPORTANT 6, final-review-
// findings.md). Bare inserts with no idempotency key meant every persistent discrepancy (especially
// a quarantined-class roll call, re-detected on every hash-unchanged re-run) inserted a fresh
// duplicate row each time, and a human-resolved (resolved=true) row could reappear as a new
// resolved=false duplicate on the very next run — silently negating review. CONTROLLER AMENDMENT:
// app-level check-then-insert keyed on (vote_id, source_a, source_b, roll_call_id, reason) NOW
// (race-safe enough for this single-process driver, same precedent already accepted for this
// codebase's glossary-persistence idempotency check) PLUS a drafted migration 0011
// (supabase/migrations/0011_flag_idempotency.sql, Lance applies) adding a matching DB-level unique
// EXPRESSION index over the same two jsonb fields as a durable backstop — no new columns needed,
// `discrepancy` has existed since migration 0010. Works correctly whether or not 0011 has landed:
// pre-migration, the app-level check above is the only defense; post-migration, a 23505 from the
// new index (a genuine race the app-level check missed) is caught and treated identically to
// finding a pre-existing row, never surfaced as an error.
async function findExistingReconciliationFlag(client, {
  voteId, sourceA, sourceB, rollCallId, reason,
}) {
  const { data, error } = await client
    .from('vote_reconciliation_flags')
    .select('id,vote_id,source_a,source_b,discrepancy,resolved,created_at,run_id')
    .eq('vote_id', voteId)
    .eq('source_a', sourceA)
    .eq('source_b', sourceB);
  if (error) {
    if (isMissingRelationError(error, 'vote_reconciliation_flags')) return { gated: true, existing: null };
    throw new Error(`legiscan-votes: could not check existing vote_reconciliation_flags: ${error.message}`);
  }
  // FIX (2026-08-02, found live: this pre-check missed a real match, the DB's own unique index
  // caught the resulting duplicate insert, and the recheck below hit the SAME miss — a whole
  // legiscan run failed on it). The unique index (migration 0011) casts roll_call_id to ::integer
  // on BOTH sides before comparing; this in-memory check used strict === and a differently-typed
  // roll_call_id (a string, from a source that parsed it out of a source_key via regex rather than
  // reading it as JSON) will never strictly-equal a number, even though the DB considers them the
  // SAME row. Coerce both sides to Number so this check matches the DB's own type-tolerant
  // definition of "the same roll call" — never trust two callers to agree on a type the schema
  // itself doesn't enforce.
  const existing = (data ?? []).find((row) => (
    Number(row?.discrepancy?.roll_call_id) === Number(rollCallId) && row?.discrepancy?.reason === reason
  )) ?? null;
  return { gated: false, existing };
}

// writeReconciliationFlag — Draft-then-apply degradation (Global Constraints, plan doc): migration
// 0010 (vote_reconciliation_flags) is draft-only until Lance applies it. A discrepancy detected
// before that point is never silently dropped — it's returned with gated:true and the SAME
// discrepancy payload, so a caller can log/report it even though it couldn't be durably recorded
// yet; a re-run after the migration lands re-detects and this time persists it. `rollCallId`/
// `reason` (both now REQUIRED, every call site below supplies them explicitly) are the idempotency
// key described above — stamped onto the stored `discrepancy` itself (`roll_call_id`/`reason`
// fields) so the key is self-describing to a human reviewer too, not just an internal lookup detail.
export async function writeReconciliationFlag(client, {
  voteId, sourceB, discrepancy, runId, rollCallId, reason,
}) {
  const keyedDiscrepancy = { ...discrepancy, roll_call_id: rollCallId, reason };

  const lookup = await findExistingReconciliationFlag(client, {
    voteId, sourceA: 'legiscan', sourceB, rollCallId, reason,
  });
  if (lookup.existing) {
    // IDEMPOTENT RE-RUN: the identical discrepancy (same vote, same LegiScan roll call, same
    // classification) was already durably recorded by a prior run — including if a human has since
    // resolved it (resolved:true is returned untouched, never reset by this re-detection).
    return { ...lookup.existing, deduped: true };
  }

  const { data, error } = await client
    .from('vote_reconciliation_flags')
    .insert({
      vote_id: voteId, source_a: 'legiscan', source_b: sourceB, discrepancy: keyedDiscrepancy, run_id: runId ?? null,
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
        discrepancy: keyedDiscrepancy,
      };
    }
    if (isUniqueViolation(error)) {
      // Migration 0011's own unique index caught a duplicate the app-level check above missed (a
      // genuine race) — re-select and return the row that won rather than surfacing a duplicate-key
      // error to the caller.
      const recheck = await findExistingReconciliationFlag(client, {
        voteId, sourceA: 'legiscan', sourceB, rollCallId, reason,
      });
      if (recheck.existing) return { ...recheck.existing, deduped: true };
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
//
// FIX ROUND (Task 9 review finding — the mirror of FIX ROUND 2's own multi-candidate
// disambiguation, never previously extended to this direction): the ORIGINAL single-candidate
// branch (candidates.length === 1) silently assumed a 1:1 correspondence purely from "exactly one
// PRIMARY-source row exists for this tuple" — but that is not sufficient when MULTIPLE LegiScan
// roll calls in the CURRENT dataset also share the exact same (bill, chamber, date) tuple (the
// real HB 3 fixture again: 5 same-day House roll calls, this time on the LegiScan side of the
// comparison rather than the primary side). Without knowing about those siblings, every one of
// them independently sees the SAME single primary candidate and gets compared against it in
// isolation — a roll call whose own tallies genuinely do NOT correspond to that primary row
// (because the primary actually corresponds to a DIFFERENT sibling) would be wrongly treated as a
// real hard mismatch and QUARANTINED, even though nothing about it is actually contradicted (found
// empirically during Task 9's own driver-level testing, not derived from first principles).
//
// `siblingTallies` (new, optional, defaults to `[]`) is an array of `{ rollCallId, tallies: {yea,
// nay, ...} }` for every OTHER LegiScan roll call in the currently-processing dataset that shares
// this exact (bill, chamber, date) tuple, EXCLUDING the one `legiscanTallies` itself describes. The
// caller (Task 9's driver, which has the whole parsed dataset in hand) computes this grouping — see
// that file's own comment for how. An empty array (every pre-existing caller/test, and any tuple
// that genuinely has only one LegiScan roll call) preserves the ORIGINAL single-candidate semantics
// EXACTLY — this is a pure addition, not a behavior change for the N=1 case.
export async function crossCheckAgainstPrimarySource(client, billId, legiscanTallies, siblingTallies = []) {
  const { data, error } = await client
    .from('votes')
    .select('id,vote_date,chamber,source_key,jurisdiction_id,result')
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
    const primaryVote = candidates[0];
    const { data: castRows, error: castErr } = await client
      .from('vote_casts')
      .select('position')
      .eq('vote_id', primaryVote.id);
    if (castErr) throw new Error(`legiscan-votes cross-check cast lookup failed: ${castErr.message}`);
    const primaryCounts = summarizePrimaryCastPositions(castRows ?? []);

    if (siblingTallies.length === 0) {
      // FIX (CRITICAL 3, IMPORTANT 5 — final-review-findings.md, 2026-07-29 final whole-branch
      // review). This is "Branch B": exactly one primary-source candidate AND exactly one LegiScan
      // roll call sharing the tuple, with no siblings on either side to disambiguate against.
      //
      // CRITICAL 3 first: a candidate whose own cast data is incomplete relative to its printed
      // `result` aggregate (mo-house shape), or whose aggregate is null and casts are zero
      // (mo-senate shape), is NOT COMPARABLE — see isPrimaryCastDataComparable's own comment.
      // Comparing against an undercounted castRows summary would manufacture a false contradiction
      // out of the primary pipeline's own backlog, so this is checked BEFORE any hard/soft
      // comparison runs at all: skip the comparison, store + soft-flag for human visibility, never
      // hard-quarantine (or hard-flag) on it.
      const primaryAggregate = parsePrimaryResultAggregate(primaryVote.result);
      const totalPrimaryCasts = (castRows ?? []).length;
      if (!isPrimaryCastDataComparable(primaryAggregate, totalPrimaryCasts)) {
        const discrepancy = {
          legiscan_tallies: legiscanTallies.tallies,
          source_b_result: primaryVote.result ?? null,
          source_b_cast_count: totalPrimaryCasts,
          source_b_tallies: primaryCounts,
          source_b_vote_id: primaryVote.id,
          source_b_source_key: primaryVote.source_key,
          quarantine: false,
        };
        const flag = await writeReconciliationFlag(client, {
          voteId: primaryVote.id, sourceB: primarySourceLabel(primaryVote.source_key), discrepancy, runId: legiscanTallies.runId, rollCallId: legiscanTallies.rollCallId, reason: 'primary_cast_data_not_comparable',
        });
        return {
          checked: true, matched: false, flag, quarantine: false, reason: 'primary_cast_data_not_comparable',
        };
      }

      // Comparable: prefer the primary row's own printed result aggregate for the HARD (yea/nay)
      // comparison when present (complete regardless of the two-phase cast backlog above) — the
      // SOFT bucket has no aggregate equivalent and still comes from castRows, which comparability
      // just established are sufficient.
      const hardCompareCounts = primaryAggregate
        ? { ...primaryCounts, yea: primaryAggregate.yea, nay: primaryAggregate.nay }
        : primaryCounts;
      const { hardMismatches, softMismatches } = compareTalliesForCrossCheck(legiscanTallies, hardCompareCounts);

      if (hardMismatches.length === 0 && softMismatches.length === 0) {
        // Deliberately no `reason` here (unlike the two tally_unique_match branches below) — this
        // is the plain singleton/singleton clean match, and ingestLegiscanRollCalls' own
        // crossCheckFlags.tally_unique_match counter specifically tracks disambiguation-resolved
        // matches, not this branch. Adding a reason string here would silently blur that existing,
        // relied-upon distinction. `matched: true` (set on EVERY clean-match branch, this one
        // included) is the correct, existing signal for "a clean primary-source correspondence was
        // found" — dedup-marking callers gate on `matched`, never on `reason`.
        return {
          checked: true, matched: true, flag: null, quarantine: false, primaryVoteId: primaryVote.id,
        };
      }

      // IMPORTANT 5 ("align branch B with C/D semantics"): a hard (yea/nay) mismatch here rests
      // ONLY on two-sided tuple-singleton-ness — exactly one primary candidate, exactly one
      // LegiScan roll call sharing the tuple — never on any tally-based corroboration the way
      // branches C/D's own selection mechanism provides. With real LegiScan-side whole-vote gaps
      // (combined-vehicle roll calls, Task 7 research) and primary-side counted-skip partial days
      // both proven real, each side can independently hold ONE but a DIFFERENT real vote for this
      // tuple, coincidentally sharing (bill, chamber, date) — quarantining here would delete/
      // withhold a possibly-CORRECT vote on unverified correspondence. Never quarantine on
      // singleton-ness alone: store + flag instead (non-correspondence recorded for human review,
      // exactly like branches C/D's own zero-/ambiguous-match outcomes below). Quarantine is
      // reserved for a corroborated correspondence — which, by construction, can never itself
      // coincide with a hard mismatch (branches C/D only ever reach their own hard/soft comparison
      // AFTER selecting a candidate BY tally equality, so hardMismatches there is always empty).
      const quarantine = false;
      const discrepancy = {
        source_a_tallies: legiscanTallies.tallies,
        source_b_tallies: hardCompareCounts,
        source_b_result: primaryVote.result ?? null,
        source_b_vote_id: primaryVote.id,
        source_b_source_key: primaryVote.source_key,
        hard_mismatches: hardMismatches,
        soft_mismatches: softMismatches,
        quarantine,
      };
      if (softMismatches.length > 0) discrepancy.caveat = PRESENT_CATEGORY_CAVEAT;
      const reason = hardMismatches.length > 0 ? 'hard_mismatch' : 'soft_mismatch';
      const flag = await writeReconciliationFlag(client, {
        voteId: primaryVote.id, sourceB: primarySourceLabel(primaryVote.source_key), discrepancy, runId: legiscanTallies.runId, rollCallId: legiscanTallies.rollCallId, reason,
      });
      return {
        checked: true, matched: false, flag, quarantine,
      };
    }

    // FIX ROUND (mirror of FIX ROUND 2, this file's module comment above): ONE primary-source row
    // exists, but MULTIPLE LegiScan roll calls (this one + siblingTallies) share the exact same
    // tuple — a 1:1 correspondence is NOT directly assertable purely from "one primary candidate
    // exists" anymore. Disambiguate the SAME way FIX ROUND 2 disambiguates multiple PRIMARY
    // candidates against one LegiScan roll call, just mirrored: by tally identity (yea, nay) among
    // the WHOLE group {this roll call, ...siblings}, asking "which of these does the ONE known
    // primary row's own (yea, nay) actually correspond to?"
    const thisMatchesPrimary = legiscanTallies.tallies.yea === primaryCounts.yea && legiscanTallies.tallies.nay === primaryCounts.nay;
    const matchingSiblings = siblingTallies.filter((s) => s.tallies.yea === primaryCounts.yea && s.tallies.nay === primaryCounts.nay);
    const totalMatches = (thisMatchesPrimary ? 1 : 0) + matchingSiblings.length;

    if (totalMatches === 0) {
      // The primary matches NEITHER this roll call NOR any sibling — no assertable 1:1
      // correspondence for ANYONE in this group, so this is exactly the "zero-match" case FIX
      // ROUND 2 already established for the opposite direction: stores (internally reconciled,
      // uncontradicted by anything specific), flagged for human review. Never quarantined — there
      // is nothing specific being contradicted, only an absence of correspondence.
      const discrepancy = {
        legiscan_tallies: legiscanTallies.tallies,
        source_b_tallies: primaryCounts,
        source_b_vote_id: primaryVote.id,
        source_b_source_key: primaryVote.source_key,
        sibling_legiscan_roll_calls: siblingTallies.map((s) => ({ roll_call_id: s.rollCallId, tallies: s.tallies })),
        quarantine: false,
      };
      const flag = await writeReconciliationFlag(client, {
        voteId: primaryVote.id, sourceB: primarySourceLabel(primaryVote.source_key), discrepancy, runId: legiscanTallies.runId, rollCallId: legiscanTallies.rollCallId, reason: 'no_tally_corresponding_primary',
      });
      return {
        checked: true, matched: false, flag, quarantine: false,
      };
    }

    if (totalMatches > 1) {
      // Two or more of {this roll call, ...siblings} coincidentally share the exact same (yea,
      // nay) as the one known primary row — genuinely ambiguous which one it corresponds to
      // (mirrors FIX ROUND 2's own ambiguous_tally_match branch, reversed). Cannot pick one
      // without guessing, so this stores (uncontradicted) and flags the matching group.
      const matchingGroup = [
        ...(thisMatchesPrimary ? [{ roll_call_id: legiscanTallies.rollCallId, tallies: legiscanTallies.tallies }] : []),
        ...matchingSiblings.map((s) => ({ roll_call_id: s.rollCallId, tallies: s.tallies })),
      ];
      const discrepancy = {
        legiscan_tallies: legiscanTallies.tallies,
        source_b_tallies: primaryCounts,
        source_b_vote_id: primaryVote.id,
        source_b_source_key: primaryVote.source_key,
        matching_legiscan_roll_calls: matchingGroup,
        quarantine: false,
      };
      const flag = await writeReconciliationFlag(client, {
        voteId: primaryVote.id, sourceB: primarySourceLabel(primaryVote.source_key), discrepancy, runId: legiscanTallies.runId, rollCallId: legiscanTallies.rollCallId, reason: 'ambiguous_tally_match',
      });
      return {
        checked: true, matched: false, flag, quarantine: false,
      };
    }

    // totalMatches === 1 (exactly one of {this, siblings} corresponds to the primary's tallies).
    if (!thisMatchesPrimary) {
      // The ONE primary row corresponds to a DIFFERENT sibling, not this roll call. This roll call
      // is simply uncorresponded — the sibling that matches carries the actual verification (when
      // IT is processed through this same function, it will find thisMatchesPrimary===true and run
      // the full comparator below). Stores (already internally reconciled by gate (a)), never
      // flagged — flagging here would be a redundant, misleading duplicate of a discrepancy that
      // belongs entirely to a different roll call.
      return {
        checked: true, matched: false, flag: null, quarantine: false, reason: 'corresponds_to_sibling',
      };
    }

    // thisMatchesPrimary === true and no sibling shares that tally — THIS roll call uniquely
    // corresponds to the primary among the whole group. Assertable 1:1, so it now runs through the
    // EXACT SAME comparator the ordinary (siblingTallies.length === 0) branch above uses — reusing
    // the function, not a hand-rolled second copy, so the "selection is not verification" class of
    // regression (FIX ROUND 3, the multi-primary-candidate mirror of this exact situation) cannot
    // reappear here via code drift. hardMismatches is impossible by construction (yea/nay equality
    // IS the selection criterion), proved by reuse rather than hardcoded to false.
    const { hardMismatches, softMismatches } = compareTalliesForCrossCheck(legiscanTallies, primaryCounts);
    const quarantine = hardMismatches.length > 0;

    if (hardMismatches.length === 0 && softMismatches.length === 0) {
      return {
        checked: true, matched: true, flag: null, quarantine: false, reason: 'tally_unique_match', primaryVoteId: primaryVote.id,
      };
    }

    const discrepancy = {
      source_a_tallies: legiscanTallies.tallies,
      source_b_tallies: primaryCounts,
      source_b_vote_id: primaryVote.id,
      source_b_source_key: primaryVote.source_key,
      hard_mismatches: hardMismatches,
      soft_mismatches: softMismatches,
      quarantine,
      note: `selected via tally-unique (yea, nay) match among this roll call + ${siblingTallies.length} sibling LegiScan roll call(s) sharing this (jurisdiction, chamber, date, bill) tuple`,
    };
    if (softMismatches.length > 0) discrepancy.caveat = PRESENT_CATEGORY_CAVEAT;
    const flag = await writeReconciliationFlag(client, {
      voteId: primaryVote.id, sourceB: primarySourceLabel(primaryVote.source_key), discrepancy, runId: legiscanTallies.runId, rollCallId: legiscanTallies.rollCallId, reason: hardMismatches.length > 0 ? 'hard_mismatch' : 'soft_mismatch',
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
        checked: true, matched: true, flag: null, quarantine: false, reason: 'tally_unique_match', primaryVoteId: selectedCandidate.id,
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
      voteId: selectedCandidate.id, sourceB: primarySourceLabel(selectedCandidate.source_key), discrepancy, runId: legiscanTallies.runId, rollCallId: legiscanTallies.rollCallId, reason: hardMismatches.length > 0 ? 'hard_mismatch' : 'soft_mismatch',
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
      legiscan_tallies: legiscanTallies.tallies,
      candidates: candidateTallies.map(({ candidate, counts }) => ({
        source_key: candidate.source_key, vote_id: candidate.id, tallies: counts,
      })),
      quarantine: false,
    };
    const flag = await writeReconciliationFlag(client, {
      voteId: candidates[0].id, sourceB: primarySourceLabel(candidates[0].source_key), discrepancy, runId: legiscanTallies.runId, rollCallId: legiscanTallies.rollCallId, reason: 'no_tally_corresponding_primary',
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
    legiscan_tallies: legiscanTallies.tallies,
    matching_candidates: tallyMatches.map(({ candidate, counts }) => ({
      source_key: candidate.source_key, vote_id: candidate.id, tallies: counts,
    })),
    quarantine: false,
  };
  const flag = await writeReconciliationFlag(client, {
    voteId: tallyMatches[0].candidate.id, sourceB: primarySourceLabel(tallyMatches[0].candidate.source_key), discrepancy, runId: legiscanTallies.runId, rollCallId: legiscanTallies.rollCallId, reason: 'ambiguous_tally_match',
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
