import {
  getClient, openRun, closeRun, selectAll,
} from '../lib/db.js';
import { parsePositiveIntegerFlag } from '../lib/errors.js';
import { journalPdfBasename } from './ingest-mo-senate.js';
import {
  PRIMARY_SOURCE_KEY_PREFIXES,
  sameCalendarDate,
  summarizePrimaryCastPositions,
  compareTalliesForCrossCheck,
  writeReconciliationFlag,
  PRESENT_CATEGORY_CAVEAT,
} from '../adapters/legiscan-votes.js';

// correct-data — data-correction CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md,
// .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md).
// THREE REVERSIBLE-OR-CAREFULLY-GUARDED production-data corrections:
//   A) mo-status: ~37,662 MO bills whose bills.status is a bare LegiScan numeric lifecycle code
//      (ingest-legiscan.js/backfill-mo-bill-meta.js both stored `String(bill.status)` verbatim, by
//      design at the time — "no house-style label mapping exists... inventing one would be a
//      guess") instead of the printed word LegiScan's OWN manual documents for that code.
//   B) mo-1969-dates: 10 `votes` rows carrying LegiScan's own 1969-12-31 missing-date sentinel
//      (legiscan-votes.js's LegiscanRollCallDateError header comment names these ten explicitly —
//      "stored verbatim, exactly as designed... the correction of the rows already stored is
//      Lance-gated and deliberately NOT done here [t]here").
//   C) mo-2026-session-merge (TODO 25): the MO 2026 session is split across TWO `sessions` rows —
//      '261' (canonical, LegiScan-sourced) and '2026' (duplicate, legiscan_session_id=NULL, created
//      by ingest-mo-senate.js's own insertIfAbsent on every Senate-journal run). Phase A merges each
//      duplicate bill into its exact-identifier canonical twin (redirecting votes, deleting the now-
//      empty duplicate rows); Phase B reconciles the redirected mo-senate-web votes against LegiScan's
//      independently-recorded votes on the same now-merged bill, reusing (never reimplementing) the
//      SAME comparison legiscan-votes.js's crossCheckAgainstPrimarySource already uses for its own
//      17 live flags. HIGHER STAKES than A/B (deletes + FK redirects, not just in-place rewrites) —
//      deliberately excluded from `all` below; an operator must name it explicitly.
//      DOES NOT call crossCheckAgainstPrimarySource itself (that function is the live pre-store
//      gate — both LegiScan votes here are already stored/public, not the scenario it decides) or
//      retractLegiscanVoteIfStored (ingest-legiscan.js's own-documented ONE sanctioned delete,
//      explicitly "never a precedent for a delete anywhere else in this repo") — Phase B only ever
//      reads votes/casts and additively writes vote_reconciliation_flags rows, never a delete.
//
// DRAFT-THEN-APPLY (Global Constraints / CLAUDE.md standing policy): this CLI is built READY, with
// a real --dry-run, but Lance runs the live pass himself — nothing in this repo invokes it live.
//
// CLI: `node --env-file=.env src/cli/correct-data.js <which> [--dry-run] [--limit N]`
// `<which>` is REQUIRED (mo-status | mo-1969-dates | mo-2026-session-merge | all) — no default, so
// an operator can never accidentally run every correction at once by omitting an argument.

const SOURCE = 'correct-data';

// ---- args ----

export function parseArgs(argv) {
  const out = { dryRun: false, limit: null, which: null };
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    if (key === '--limit') { out.limit = parsePositiveIntegerFlag(argv[i + 1], '--limit'); i += 2; continue; }
    if (key.startsWith('--')) throw new Error(`unknown flag: ${key}`);
    positionals.push(key);
    i += 1;
  }
  if (positionals.length !== 1) {
    throw new Error(
      `correct-data: requires exactly one <which> argument (mo-status | mo-1969-dates | mo-2026-session-merge | all), got ${positionals.length} — `
        + 'no default, so an operator can never accidentally run every correction at once',
    );
  }
  const [which] = positionals;
  if (!['mo-status', 'mo-1969-dates', 'mo-2026-session-merge', 'all'].includes(which)) {
    throw new Error(`correct-data: unknown <which> "${which}" — expected mo-status | mo-1969-dates | mo-2026-session-merge | all`);
  }
  out.which = which;
  return out;
}

// ============================================================================================
// Correction A — mo-status: numeric LegiScan status codes -> their printed words
// ============================================================================================

// MO_STATUS_WORD_MAP — SOURCED, not invented: LegiScan API User Manual, page 42
// (tests/fixtures/research/legiscan/LegiScan_API_User_Manual.pdf), "Status / Progress" table.
// LegiScan encodes bill status as an integer and prints NO word anywhere in the dataset itself —
// decoding it against the source's own published codebook is exactly the same class of operation
// as VOTE_ID_MAP (legiscan-votes.js, 1->yea): decoding a documented lookup, never editorializing.
//
// Deliberately excludes 0 and 7-12 (see MO_STATUS_UNMAPPED_CODE / MO_STATUS_PROGRESS_ONLY_CODES
// below) — those two are NOT eligible to ever be written to bills.status by this module.
export const MO_STATUS_WORD_MAP = {
  1: 'Introduced',
  2: 'Engrossed',
  3: 'Enrolled',
  4: 'Passed',
  5: 'Vetoed',
  6: 'Failed',
};

export const MO_STATUS_MAPPED_CODES = Object.keys(MO_STATUS_WORD_MAP).map(Number);

// MO_STATUS_UNMAPPED_CODE — 0 = "N/A (pre-filed / pre-introduction)" per the manual. No honest
// single word exists for it (the live site already omits a status word for these bills) — left
// untouched by design, only ever COUNTED (leftUntouchedZero), never written.
export const MO_STATUS_UNMAPPED_CODE = 0;

// MO_STATUS_PROGRESS_ONLY_CODES — 7-12 (Override/Chaptered/Refer/Report Pass/Report DNP/Draft) are
// documented by the manual as "Progress array only" — NOT a bill's overall status. If any of these
// somehow appear in bills.status, that is itself a data anomaly worth surfacing
// (unexpectedMappedCode) — but this module never guesses a word for a code the manual says isn't a
// status; those rows are left untouched too.
export const MO_STATUS_PROGRESS_ONLY_CODES = [7, 8, 9, 10, 11, 12];

// mapMoStatusCode — the same lookup every writer of bills.status (ingest-legiscan.js,
// backfill-mo-bill-meta.js) should route through going forward, per the brief's "fix the writer
// too" requirement — one exported constant/function, not a second copy of this table anywhere.
export function mapMoStatusCode(code) {
  return MO_STATUS_WORD_MAP[code] ?? null;
}

// correctOneStatusCode — corrects ONE numeric code across `bills`. The `.eq('status', code)` on
// the update itself is the ENTIRE safety guard (brief, verbatim) — additive-safe by construction:
// a federal bill's text status, or an already-corrected word, can never match a numeric string, so
// no pre-filter in JS is doing the real work here, the database predicate is.
//
// Two shapes, chosen by whether `remainingBudget` is finite (a --limit is active):
//   - UNLIMITED (the common case — this is what a real live pass actually runs): dry-run uses a
//     count-only `head:true` query (cheap even at 33,068 rows — no row body is ever fetched just
//     to preview a count); live issues ONE bulk update per code and reads back `count` (NOT
//     `data.length` — see the count-vs-data-cap note below) via `{count:'exact'}`.
//   - LIMITED (an operator explicitly capped this run, e.g. for a first small live smoke-test):
//     select up to `remainingBudget` matching ids (deterministically ordered), then scope the
//     update to exactly those ids (still carrying the SAME `.eq('status', code)` guard) — this is
//     the only way to make --limit meaningful without turning the unlimited path into a per-row
//     loop across tens of thousands of rows.
//
// COUNT-VS-DATA-CAP (same class of gotcha src/lib/db.js's selectAll header comment documents for
// SELECT): PostgREST's db-max-rows setting can truncate a large response BODY (`data`), but a
// `Prefer: count=exact` request still reports the TRUE total via the Content-Range header,
// independent of that body cap — supabase-js surfaces this as the separate `count` field. Trusting
// `data.length` for code 1 (33,068 real rows) would silently undercount; `count` never does.
async function correctOneStatusCode(client, code, {
  dryRun, remainingBudget, runId,
}) {
  const word = MO_STATUS_WORD_MAP[code];
  const codeStr = String(code);
  if (remainingBudget <= 0) return { matched: 0, error: null };

  if (Number.isFinite(remainingBudget)) {
    const { data: idRows, error: selErr } = await client
      .from('bills').select('id').eq('status', codeStr)
      .order('id', { ascending: true }).limit(remainingBudget);
    if (selErr) return { matched: 0, error: selErr };
    const ids = (idRows ?? []).map((r) => r.id);
    if (ids.length === 0) return { matched: 0, error: null };
    if (dryRun) return { matched: ids.length, error: null };
    // FIX (review, MEDIUM finding): use the update's own returned `count`, not `ids.length` — a
    // race between the id-select above and this update (another process changing one of those
    // rows' status in between) would make the actual number of rows this update matched/changed
    // LESS than the id list it was given (the `.eq('status', codeStr)` guard on the update itself
    // would simply exclude that row) — trusting `ids.length` would silently OVERCOUNT. Same
    // count-vs-data-cap reasoning as the unlimited branch below: `count` (from `{count:'exact'}`)
    // is the actual server-side truth, never assumed from what was merely requested.
    const { count, error: updErr } = await client
      .from('bills').update({ status: word, run_id: runId })
      .eq('status', codeStr).in('id', ids).select('id', { count: 'exact' });
    if (updErr) return { matched: 0, error: updErr };
    return { matched: count ?? 0, error: null };
  }

  if (dryRun) {
    const { count, error } = await client
      .from('bills').select('id', { count: 'exact', head: true }).eq('status', codeStr);
    if (error) return { matched: 0, error };
    return { matched: count ?? 0, error: null };
  }
  const { count, error } = await client
    .from('bills').update({ status: word, run_id: runId })
    .eq('status', codeStr).select('id', { count: 'exact' });
  if (error) return { matched: 0, error };
  return { matched: count ?? 0, error: null };
}

// countBillsWithStatusIn — the honest-visibility counters for 0 and 7-12 (never written). Also
// count-only (`head:true`), so previewing them costs nothing proportional to row count.
async function countBillsWithStatusIn(client, codes, failures, label) {
  const query = codes.length === 1
    ? client.from('bills').select('id', { count: 'exact', head: true }).eq('status', codes[0])
    : client.from('bills').select('id', { count: 'exact', head: true }).in('status', codes);
  const { count, error } = await query;
  if (error) {
    failures.push({ reason: `${label}_query_failed`, error: String(error.message ?? error) });
    return 0;
  }
  return count ?? 0;
}

// runCorrectMoStatus — dry-run and live both report the SAME honest `matched` counts per code
// (deliberately: the brief states specific live-DB target numbers "for the dry-run to reproduce"),
// distinguished only by whether a write actually happened (the top-level `mode` field, and whether
// any `update` calls appear in a real client's call log). `updated` always equals the sum of
// `perCode` — the reconciliation the brief requires.
export async function runCorrectMoStatus(client, {
  dryRun = false, limit = null, runId = null,
} = {}) {
  let remainingBudget = limit ?? Infinity;
  const perCode = {};
  const failures = [];

  // Sequential, not parallel: remainingBudget is a running total that must be read-then-decremented
  // in order — the same "small/infrequent backlog, sequential is deliberate" precedent as
  // src/lib/db.js's selectAll pagination.
  for (const code of MO_STATUS_MAPPED_CODES) {
    // eslint-disable-next-line no-await-in-loop
    const result = await correctOneStatusCode(client, code, { dryRun, remainingBudget, runId });
    perCode[code] = result.matched;
    if (result.error) {
      failures.push({ code, reason: 'query_failed', error: String(result.error.message ?? result.error) });
    }
    if (Number.isFinite(remainingBudget)) remainingBudget -= result.matched;
  }

  const updated = Object.values(perCode).reduce((a, b) => a + b, 0);
  const leftUntouchedZero = await countBillsWithStatusIn(client, [String(MO_STATUS_UNMAPPED_CODE)], failures, 'leftUntouchedZero');
  const unexpectedMappedCode = await countBillsWithStatusIn(client, MO_STATUS_PROGRESS_ONLY_CODES.map(String), failures, 'unexpectedMappedCode');

  return {
    perCode, updated, leftUntouchedZero, unexpectedMappedCode, failures,
  };
}

// ============================================================================================
// Correction B — mo-1969-dates: 10 votes rows carrying LegiScan's 1969-12-31 sentinel
// ============================================================================================

// VOTE_DATE_1969_SENTINEL — LegiScan's own missing-date sentinel, as stored verbatim (matches
// legiscan-votes.js's assertRollCallDateWithinSession comment and the actual live rows' own
// vote_date value).
export const VOTE_DATE_1969_SENTINEL = '1969-12-31T00:00:00+00:00';

// JOURNAL_YEAR_PATH_PATTERN / JOURNAL_BASENAME_PATTERN — verified against the ACTUAL cached MO
// Senate journal filenames on disk before being trusted (per this task's own instructions), not
// just the brief's one example:
//   - .superpowers/artifacts/mo-senate-journal-index/2018.json's 88 real rows: every "RDay..."
//     entry's embedded MMDD matches that row's own printed journal_date with ZERO mismatches
//     (RDay0101031-86 under /18info/ -> 2018-01-03; RDay330301462-486 -> 2018-03-01, the brief's
//     own example). The SAME 88-row index also contains 12 "T1Day.../S1Day..." entries — a
//     genuinely DIFFERENT (special-session) filename scheme that does not match this pattern at
//     all; JOURNAL_BASENAME_PATTERN correctly refuses them (returns null) rather than mis-parsing.
//   - .superpowers/artifacts/mo-senate-journal-index/2026.json's 70 real rows: same pattern holds,
//     modulo a case difference this codebase had not seen before ("Rday" lowercase-d, e.g.
//     Rday360319651-660.pdf under /26info/) — the regex below is case-insensitive to tolerate that
//     real variation without weakening what it accepts (still requires the exact digit-count shape).
//   - .superpowers/artifacts/mo-senate-journals/ (the raw fetched-PDF cache, 67 files): every
//     "RDay..." file matches this same shape (day-number + MMDD + page-range).
// None of the 10 real sentinel rows (all session 1530, 2018 Regular) reference a T1Day/S1Day/
// non-RDay filename, so this pattern's coverage is sufficient for this correction's actual scope —
// but a future row that DOES hit one of those other real, observed schemes still fails loud
// (unresolvableDate), never guessed.
const JOURNAL_YEAR_PATH_PATTERN = /\/(\d{2})info\//;
const JOURNAL_BASENAME_PATTERN = /^RDay\d{2}(\d{2})(\d{2})\d+-\d+$/i;

// parseMoSenateJournalDateFromUrl — the primary source's OWN filename stating the date (brief:
// "the journal filename encodes the date... This is the primary source's own filename stating the
// date, so it is traceable"). Reuses journalPdfBasename (ingest-mo-senate.js) rather than
// reimplementing the query/fragment-stripping + basename logic a second time. Parses mechanically
// and defensively — any pattern that doesn't cleanly match (including an out-of-range month/day,
// which would indicate a misread rather than a real date) returns null, never a guess.
export function parseMoSenateJournalDateFromUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  const yearMatch = JOURNAL_YEAR_PATH_PATTERN.exec(url);
  if (!yearMatch) return null;
  const year = 2000 + Number(yearMatch[1]);

  const basename = journalPdfBasename(url);
  const dayMatch = JOURNAL_BASENAME_PATTERN.exec(basename);
  if (!dayMatch) return null;
  const [, mm, dd] = dayMatch;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return `${year}-${mm}-${dd}`;
}

// summarizeCastsForMatch — position -> SET of casting legislator_ids (not just a count), plus the
// tally (set size) for human-readable reporting.
//
// REVIEW FIX (false-positive, proven by execution): a bare yea/nay COUNT match is not a reliable
// duplicate signal — two genuinely DIFFERENT senate roll calls on the SAME bill/chamber can
// coincidentally share a tally (e.g. 20-5), and the original count-only comparison accepted that
// coincidence as a confident single-candidate match, deleting the wrong (a genuinely different,
// real) row. `vote_casts.legislator_id` is our OWN canonical identity — the SAME `legislators.id`
// regardless of which source resolved it (LegiScan side via legiscan_people_id, mo-senate-web side
// via surname/district — see legislator-identity.js / ingest-mo-senate.js's own roster-gating) —
// so comparing the EXACT SET of yea-voting ids and the EXACT SET of nay-voting ids between two
// rows is an exact-identity comparison, not a fuzzy one: two different real roll calls sharing a
// tally by coincidence would need the SAME 20 legislators voting yea AND the SAME different 5
// voting nay to also coincidentally pass this check, which is not realistically possible by chance
// (and a genuine duplicate of the SAME real event necessarily has identical casters on both sides,
// since both sources are describing the same legislators voting on the same day).
//
// QUESTION-TEXT WAS CONSIDERED AND REJECTED as the corroborating signal (per the review's own
// escape hatch): LegiScan's `roll_call.desc` (e.g. "House: HB 2  HBs FOR THIRD READING") and
// mo-senate-web's own parsed `motion` sentence (mo-senate-journal-pdf.js's extractMotionSentence —
// a full prose sentence pulled from the journal's own narrative text, e.g. "On motion of Senator
// X, SB 1 was read the third time and passed") are produced by two structurally unrelated
// extraction pipelines with no shared vocabulary or format to compare mechanically — matching them
// would require fuzzy/substring/similarity text matching, which this codebase's identity machinery
// explicitly never does anywhere (CONTROLLER RULING 3 lineage: exact match only). The legislator-
// id-set comparison below is the strongest signal that IS reliably, exactly comparable between a
// legiscan-sourced row and a mo-senate-web-sourced row.
function summarizeCastsForMatch(castRows) {
  const yeaIds = new Set();
  const nayIds = new Set();
  for (const row of castRows ?? []) {
    if (row.position === 'yea') yeaIds.add(row.legislator_id);
    else if (row.position === 'nay') nayIds.add(row.legislator_id);
  }
  return {
    yeaIds, nayIds, tally: { yea: yeaIds.size, nay: nayIds.size },
  };
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// findPrimaryDuplicate — the primary-wins duplicate check (brief, correction B step 1): does the
// MO Senate JOURNAL pipeline (ingest-mo-senate.js / mo-senate-web.js — the primary/completeness
// layer, PRIMARY_SOURCE_KEY_PREFIXES imported from legiscan-votes.js, never reimplemented) already
// hold the SAME roll call with a real date?
//
// The existing cross-check machinery (legiscan-votes.js's crossCheckAgainstPrimarySource) matches
// on (bill, chamber, DATE, tallies) — unusable here verbatim, since the sentinel row's own date is
// exactly the broken field under investigation. This matches on (bill_id, chamber) to find
// candidates, then requires the candidate's EXACT yea-voter-id-set AND nay-voter-id-set to match
// the sentinel's (see summarizeCastsForMatch above for why this, not a bare tally, is the accepted
// corroborating signal). Zero or more-than-one matching candidate is NOT a confident duplicate
// (never guessed which one) — falls through to the URL-derive path.
async function findPrimaryDuplicate(client, sentinelRow, sentinelCasts) {
  const { data: candidateRows, error } = await client
    .from('votes').select('id,vote_date,chamber,source_key')
    .eq('bill_id', sentinelRow.bill_id).eq('chamber', sentinelRow.chamber);
  if (error) return { matched: null, matchedCasts: null, error };

  const primaryCandidates = (candidateRows ?? []).filter((row) => (
    PRIMARY_SOURCE_KEY_PREFIXES.some((prefix) => String(row.source_key ?? '').startsWith(prefix))
  ));

  const matches = [];
  for (const candidate of primaryCandidates) {
    // eslint-disable-next-line no-await-in-loop -- a handful at most per bill/chamber, same bound
    // legiscan-votes.js's own crossCheckAgainstPrimarySource comment documents for this exact query.
    const { data: castRows, error: castErr } = await client
      .from('vote_casts').select('position,legislator_id').eq('vote_id', candidate.id);
    if (castErr) return { matched: null, matchedCasts: null, error: castErr };
    const candidateCasts = summarizeCastsForMatch(castRows);
    if (setsEqual(sentinelCasts.yeaIds, candidateCasts.yeaIds) && setsEqual(sentinelCasts.nayIds, candidateCasts.nayIds)) {
      matches.push({ candidate, candidateCasts });
    }
  }

  if (matches.length === 1) return { matched: matches[0].candidate, matchedCasts: matches[0].candidateCasts, error: null };
  return { matched: null, matchedCasts: null, error: null };
}

// processSentinelRow — one sentinel votes row -> { outcome: 'deleted'|'redated'|'unresolvable', ... }
// or throws-into-failure via the caller's try/catch. `dryRun` performs every READ this would (the
// duplicate check + the URL parse) but never a delete/update. `matchDetail` is populated whenever a
// duplicate was accepted (dry-run or live) — the human-review surface (review requirement 2): with
// only ~10 rows ever in scope, Lance can eyeball every delete DECISION, not just trust an aggregate
// count.
async function processSentinelRow(client, row, { dryRun, runId }) {
  const { data: sentinelCastRows, error: castErr } = await client
    .from('vote_casts').select('position,legislator_id').eq('vote_id', row.id);
  if (castErr) return { outcome: 'failed', reason: 'sentinel_cast_lookup_failed', error: castErr };
  const sentinelCasts = summarizeCastsForMatch(sentinelCastRows);

  const dup = await findPrimaryDuplicate(client, row, sentinelCasts);
  if (dup.error) return { outcome: 'failed', reason: 'duplicate_check_failed', error: dup.error };

  if (dup.matched) {
    const matchDetail = {
      sentinelVoteId: row.id,
      matchedPrimaryVoteId: dup.matched.id,
      billId: row.bill_id,
      chamber: row.chamber,
      sentinelTally: sentinelCasts.tally,
      primaryTally: dup.matchedCasts.tally,
      // question-text was considered and rejected as a signal (see summarizeCastsForMatch's own
      // header comment) — this documents WHAT signal actually backed the decision, for a human
      // reviewer reading this record without re-reading the source.
      signal: 'exact_legislator_id_set_match',
    };
    if (dryRun) return { outcome: 'deleted', matchedVoteId: dup.matched.id, matchDetail };
    const { error: castDelErr } = await client.from('vote_casts').delete().eq('vote_id', row.id);
    if (castDelErr) return { outcome: 'failed', reason: 'cast_delete_failed', error: castDelErr };
    const { data: deletedVotes, error: voteDelErr } = await client
      .from('votes').delete().eq('id', row.id).eq('vote_date', VOTE_DATE_1969_SENTINEL).select('id');
    if (voteDelErr) return { outcome: 'failed', reason: 'vote_delete_failed', error: voteDelErr };
    if (!deletedVotes || deletedVotes.length !== 1) {
      return {
        outcome: 'failed', reason: 'vote_delete_guard_mismatch', error: { message: `expected exactly 1 row deleted for votes.id=${row.id}, got ${deletedVotes?.length ?? 0}` },
      };
    }
    return { outcome: 'deleted', matchedVoteId: dup.matched.id, matchDetail };
  }

  const parsedDate = parseMoSenateJournalDateFromUrl(row.source_url);
  if (!parsedDate) return { outcome: 'unresolvable' };

  if (dryRun) return { outcome: 'redated', to: parsedDate };
  const { data: updatedVotes, error: updErr } = await client
    .from('votes').update({ vote_date: parsedDate, run_id: runId })
    .eq('id', row.id).eq('vote_date', VOTE_DATE_1969_SENTINEL).select('id');
  if (updErr) return { outcome: 'failed', reason: 'redate_failed', error: updErr };
  if (!updatedVotes || updatedVotes.length !== 1) {
    return {
      outcome: 'failed', reason: 'redate_guard_mismatch', error: { message: `expected exactly 1 row updated for votes.id=${row.id}, got ${updatedVotes?.length ?? 0}` },
    };
  }
  return { outcome: 'redated', to: parsedDate };
}

// runCorrectMo1969Dates — touches ONLY rows scoped by `vote_date = VOTE_DATE_1969_SENTINEL` (the
// brief's own guard: "touch ONLY these ≤10 rows"); every delete/update additionally re-guards on
// the exact vote id AND the sentinel value at write time, so a row that a concurrent process
// already corrected can never be double-processed. Never refreshes aggregates (controller does
// that after the live pass, per the brief's "Out of scope").
export async function runCorrectMo1969Dates(client, {
  dryRun = false, limit = null, runId = null,
} = {}) {
  let query = client
    .from('votes').select('id,bill_id,chamber,vote_date,source_url')
    .eq('vote_date', VOTE_DATE_1969_SENTINEL).eq('jurisdiction_id', 'mo-legislature')
    .order('id', { ascending: true });
  if (limit != null) query = query.limit(limit);
  const { data: sentinelRows, error } = await query;
  if (error) throw new Error(`correct-data: mo-1969-dates scope query failed: ${error.message}`);

  const rows = sentinelRows ?? [];
  const failures = [];
  const matches = [];
  let deletedAsDuplicate = 0;
  let redatedFromSource = 0;
  let unresolvableDate = 0;

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- sequential over at most a handful of rows
    // (brief: "touch ONLY these ≤10 rows"), same "small/infrequent backlog" precedent used
    // throughout this codebase's batch CLIs.
    const result = await processSentinelRow(client, row, { dryRun, runId });
    if (result.outcome === 'deleted') {
      deletedAsDuplicate += 1;
      // Review requirement 2: every delete DECISION (dry-run or live) is recorded here, not just
      // counted — the human-review surface for a 10-row-total correction.
      matches.push(result.matchDetail);
    } else if (result.outcome === 'redated') redatedFromSource += 1;
    else if (result.outcome === 'unresolvable') unresolvableDate += 1;
    else {
      failures.push({
        voteId: row.id, reason: result.reason, error: String(result.error?.message ?? result.error),
      });
    }
  }

  return {
    seen: rows.length, deletedAsDuplicate, redatedFromSource, unresolvableDate, matches, failures,
  };
}

// ============================================================================================
// Correction C — mo-2026-session-merge: the MO 2026 session split (TODO 25)
// ============================================================================================
//
// CANONICAL_MO_2026_SESSION_IDENTIFIER / DUPLICATE_MO_2026_SESSION_IDENTIFIER — the brief's own
// verified pair: '261' (legiscan_session_id=2239, LegiScan-sourced, the real session) vs '2026'
// (legiscan_session_id=NULL — the only MO session missing one, created by ingest-mo-senate.js's
// own ensureSessionRow/insertIfAbsent on every Senate-journal run, independent of the LegiScan
// import). Named identifiers, not derived — this correction is scoped to exactly this one known
// split, never a general "find any two sessions that look alike" heuristic.
export const CANONICAL_MO_2026_SESSION_IDENTIFIER = '261';
export const DUPLICATE_MO_2026_SESSION_IDENTIFIER = '2026';

// DUP_BILL_MUST_BE_EMPTY_TABLES — the brief names bill_texts/bill_sponsors/summaries explicitly
// (all confirmed zero on the duplicate side at brief-writing time, re-verified live below, never
// trusted from the brief's own numbers). bill_actions is ALSO a bills(id) foreign key this brief's
// prose doesn't name — added here defensively (same "never silently redirect a table this brief
// didn't anticipate" spirit the brief states for the other three): if it's ever non-zero, this
// STOPS and reports that bill too, exactly like the three named tables, rather than assuming its
// silence means "safe to ignore."
export const DUP_BILL_MUST_BE_EMPTY_TABLES = ['bill_texts', 'bill_sponsors', 'summaries', 'bill_actions'];

const MO_JURISDICTION_ID = 'mo-legislature';

// parseLegiscanRollCallSourceKey — the exact inverse of legiscan-votes.js's own
// buildLegiscanVoteSourceKey('legiscan-<sessionId>-rollcall-<rollCallId>'), so Phase B never
// guesses a LegiScan roll_call_id: it parses it back out of the LegiScan vote's own stored
// source_key. Any source_key that doesn't cleanly match this exact shape returns null (an honest
// "can't parse", counted separately below) rather than a best-effort guess.
const LEGISCAN_ROLLCALL_SOURCE_KEY_PATTERN = /^legiscan-(\d+)-rollcall-(\d+)$/;
export function parseLegiscanRollCallSourceKey(sourceKey) {
  const m = LEGISCAN_ROLLCALL_SOURCE_KEY_PATTERN.exec(String(sourceKey ?? ''));
  if (!m) return null;
  return { legiscanSessionId: m[1], rollCallId: m[2] };
}

// processDuplicateBill — one duplicate bill (session '2026') -> 'merged' | 'stopped' | 'failed'.
// Brief step 1: the canonical twin is found by an EXACT `identifier` match under the canonical
// session — the `bills` table's own `unique (session_id, identifier)` constraint (migration 0001)
// guarantees at most one twin can ever exist per session, so only 0-vs-1 needs handling here (>1
// is unreachable given that constraint, but checked anyway — never assumed from a comment).
// dryRun performs every READ this would (twin lookup, related-table counts, the vote rows that
// WOULD be redirected) but never an update/delete — `voteRows` is still returned, projected onto
// the canonical bill id, so Phase B can run its own read-only comparison against what a live pass
// would actually produce.
async function processDuplicateBill(client, dupBill, canonicalSessionId, { dryRun, runId }) {
  const { data: twins, error: twinErr } = await client
    .from('bills').select('id').eq('session_id', canonicalSessionId).eq('identifier', dupBill.identifier);
  if (twinErr) {
    return {
      outcome: 'failed',
      detail: {
        billId: dupBill.id, identifier: dupBill.identifier, reason: 'twin_lookup_failed', error: String(twinErr.message ?? twinErr),
      },
    };
  }
  if (!twins || twins.length !== 1) {
    return {
      outcome: 'stopped',
      detail: {
        billId: dupBill.id,
        identifier: dupBill.identifier,
        reason: twins && twins.length > 1 ? 'multiple_canonical_twins' : 'no_canonical_twin',
      },
    };
  }
  const canonicalBillId = twins[0].id;

  const nonZeroTables = [];
  for (const table of DUP_BILL_MUST_BE_EMPTY_TABLES) {
    // eslint-disable-next-line no-await-in-loop -- four small count-only checks per bill, same
    // "small/infrequent, sequential" precedent as the rest of this file's per-row loops.
    const { count, error } = await client
      .from(table).select('id', { count: 'exact', head: true }).eq('bill_id', dupBill.id);
    if (error) {
      return {
        outcome: 'failed',
        detail: {
          billId: dupBill.id, identifier: dupBill.identifier, reason: `${table}_check_failed`, error: String(error.message ?? error),
        },
      };
    }
    if ((count ?? 0) > 0) nonZeroTables.push({ table, count });
  }
  if (nonZeroTables.length > 0) {
    return {
      outcome: 'stopped',
      detail: {
        billId: dupBill.id, identifier: dupBill.identifier, reason: 'non_zero_related_tables', nonZeroTables,
      },
    };
  }

  const { data: dupVoteRows, error: voteSelErr } = await client
    .from('votes').select('id,bill_id,chamber,vote_date,source_key,result').eq('bill_id', dupBill.id);
  if (voteSelErr) {
    return {
      outcome: 'failed',
      detail: {
        billId: dupBill.id, identifier: dupBill.identifier, reason: 'votes_lookup_failed', error: String(voteSelErr.message ?? voteSelErr),
      },
    };
  }
  // Projected onto the canonical bill id in EVERY branch (dry-run and live) — in live mode this is
  // simply true after the redirect below; in dry-run mode nothing actually moved, but Phase B needs
  // to know what WOULD be true post-redirect to look up LegiScan candidates on the right bill.
  const projectedVoteRows = (dupVoteRows ?? []).map((v) => ({ ...v, bill_id: canonicalBillId }));

  if (dryRun) {
    return {
      outcome: 'merged',
      votesRedirected: projectedVoteRows.length,
      detail: {
        billId: dupBill.id,
        identifier: dupBill.identifier,
        canonicalBillId,
        votesRedirected: projectedVoteRows.length,
        voteRows: projectedVoteRows,
        billDeleted: false,
        dryRun: true,
      },
    };
  }

  const { data: updatedVotes, error: updErr } = await client
    .from('votes').update({ bill_id: canonicalBillId, run_id: runId }).eq('bill_id', dupBill.id).select('id', { count: 'exact' });
  if (updErr) {
    return {
      outcome: 'failed',
      detail: {
        billId: dupBill.id, identifier: dupBill.identifier, reason: 'vote_redirect_failed', error: String(updErr.message ?? updErr),
      },
    };
  }
  const redirectedCount = updatedVotes ? updatedVotes.length : 0;

  // Re-verify LIVE (brief step 4): zero remaining votes.bill_id references to the duplicate bill —
  // the actual guard the delete below depends on, not just an assumption that the update above
  // matched everything.
  const { count: remainingVotes, error: remErr } = await client
    .from('votes').select('id', { count: 'exact', head: true }).eq('bill_id', dupBill.id);
  if (remErr) {
    return {
      outcome: 'failed',
      detail: {
        billId: dupBill.id, identifier: dupBill.identifier, reason: 'vote_redirect_recheck_failed', error: String(remErr.message ?? remErr),
      },
    };
  }
  if ((remainingVotes ?? 0) > 0) {
    return {
      outcome: 'failed',
      detail: {
        billId: dupBill.id, identifier: dupBill.identifier, reason: 'vote_redirect_incomplete', remaining: remainingVotes,
      },
    };
  }

  const { data: deletedBills, error: delErr } = await client.from('bills').delete().eq('id', dupBill.id).select('id');
  if (delErr) {
    return {
      outcome: 'failed',
      detail: {
        billId: dupBill.id, identifier: dupBill.identifier, reason: 'bill_delete_failed', error: String(delErr.message ?? delErr),
      },
    };
  }
  if (!deletedBills || deletedBills.length !== 1) {
    return {
      outcome: 'failed',
      detail: {
        billId: dupBill.id, identifier: dupBill.identifier, reason: 'bill_delete_guard_mismatch', got: deletedBills?.length ?? 0,
      },
    };
  }

  return {
    outcome: 'merged',
    votesRedirected: redirectedCount,
    detail: {
      billId: dupBill.id,
      identifier: dupBill.identifier,
      canonicalBillId,
      votesRedirected: redirectedCount,
      voteRows: projectedVoteRows,
      billDeleted: true,
      dryRun: false,
    },
  };
}

// runMergeMo2026Session — Phase A. `merges[]` doubles as the human-review surface (same "≤ a few
// dozen rows, Lance can eyeball every decision" precedent as runCorrectMo1969Dates's own `matches`)
// AND the input Phase B consumes (each entry's `voteRows`, already projected onto the canonical
// bill id) — one pass produces both, never two independently-derived views of the same merge.
export async function runMergeMo2026Session(client, {
  dryRun = false, limit = null, runId = null,
} = {}) {
  const { data: sessionRows, error: sessErr } = await client
    .from('sessions').select('id,identifier,legiscan_session_id')
    .eq('jurisdiction_id', MO_JURISDICTION_ID)
    .in('identifier', [CANONICAL_MO_2026_SESSION_IDENTIFIER, DUPLICATE_MO_2026_SESSION_IDENTIFIER]);
  if (sessErr) throw new Error(`mo-2026-session-merge: session lookup failed: ${sessErr.message}`);
  const canonical = (sessionRows ?? []).find((r) => r.identifier === CANONICAL_MO_2026_SESSION_IDENTIFIER);
  const dup = (sessionRows ?? []).find((r) => r.identifier === DUPLICATE_MO_2026_SESSION_IDENTIFIER);

  const emptyReport = (overrides) => ({
    canonicalSessionFound: !!canonical,
    dupSessionFound: !!dup,
    canonicalSessionId: canonical?.id ?? null,
    dupSessionId: dup?.id ?? null,
    dupBillsTotal: 0,
    dupBillsSeen: 0,
    billsMerged: 0,
    votesRedirected: 0,
    sessionDeleted: false,
    sessionDeletionEligible: false,
    stopped: [],
    merges: [],
    failures: [],
    ...overrides,
  });

  // Canonical session missing entirely is a red flag worth surfacing (it's supposed to be the real,
  // populated session) — but ONLY if a duplicate is also present (i.e. there's actually something
  // this correction would need the canonical row for); if BOTH are absent there's simply nothing to
  // do (a prior run may have already fully merged and cleaned up), never an error.
  if (!canonical) {
    return emptyReport({
      failures: dup ? [{ reason: 'canonical_session_missing_but_duplicate_present', dupSessionId: dup.id }] : [],
    });
  }
  if (!dup) return emptyReport({});

  const { data: dupBillsAll, error: dupBillsErr } = await selectAll(client, 'bills', 'id,identifier', {
    filter: (q) => q.eq('session_id', dup.id),
  });
  if (dupBillsErr) throw new Error(`mo-2026-session-merge: duplicate bill lookup failed: ${dupBillsErr.message}`);
  const dupBillsTotal = (dupBillsAll ?? []).length;
  const sortedDupBills = [...(dupBillsAll ?? [])].sort((a, b) => (a.id > b.id ? 1 : -1));
  const dupBillsScoped = limit != null ? sortedDupBills.slice(0, limit) : sortedDupBills;

  const stopped = [];
  const merges = [];
  const failures = [];
  let billsMerged = 0;
  let votesRedirected = 0;

  for (const b of dupBillsScoped) {
    // eslint-disable-next-line no-await-in-loop -- sequential over at most a few dozen bills (brief:
    // ~34), same "small/infrequent backlog" precedent as this file's other corrections.
    const result = await processDuplicateBill(client, b, canonical.id, { dryRun, runId });
    if (result.outcome === 'merged') {
      billsMerged += 1;
      votesRedirected += result.votesRedirected;
      merges.push(result.detail);
    } else if (result.outcome === 'stopped') {
      stopped.push(result.detail);
    } else {
      failures.push(result.detail);
    }
  }

  // sessionDeletionEligible — every duplicate bill (not just the ones a --limit scoped in) merged
  // cleanly, with nothing stopped or failed. Reported honestly in BOTH modes (brief: "report...
  // session deleted or not"); only LIVE mode ever acts on it, and even then via its own independent
  // re-check immediately below (brief step 5's own guard), never by trusting this in-memory count.
  const sessionDeletionEligible = dupBillsScoped.length === dupBillsTotal && stopped.length === 0 && failures.length === 0;
  let sessionDeleted = false;

  if (!dryRun) {
    const { count: remainingBillCount, error: remErr } = await client
      .from('bills').select('id', { count: 'exact', head: true }).eq('session_id', dup.id);
    if (remErr) {
      failures.push({ reason: 'session_bill_recount_failed', error: String(remErr.message ?? remErr) });
    } else if ((remainingBillCount ?? 0) === 0) {
      const { data: deletedSessions, error: sessDelErr } = await client
        .from('sessions').delete().eq('id', dup.id).select('id');
      if (sessDelErr) {
        failures.push({ reason: 'session_delete_failed', error: String(sessDelErr.message ?? sessDelErr) });
      } else if (deletedSessions && deletedSessions.length === 1) {
        sessionDeleted = true;
      } else {
        failures.push({ reason: 'session_delete_guard_mismatch', got: deletedSessions?.length ?? 0 });
      }
    }
    // remainingBillCount > 0: the session still owns bills (a stopped bill, a failure, or a
    // --limit-truncated pass) — never deleted, no failure either; this is the guard doing exactly
    // what it's for.
  }

  return {
    canonicalSessionFound: true,
    dupSessionFound: true,
    canonicalSessionId: canonical.id,
    dupSessionId: dup.id,
    dupBillsTotal,
    dupBillsSeen: dupBillsScoped.length,
    billsMerged,
    votesRedirected,
    sessionDeleted,
    sessionDeletionEligible,
    stopped,
    merges,
    failures,
  };
}

// reconcileOneVote — Phase B, one redirected mo-senate-web vote (already on its merged/canonical
// bill_id). Brief step 1: matching LegiScan vote(s) by (bill_id, jurisdiction, chamber,
// sameCalendarDate) — 0 -> 'no_match', >1 -> 'ambiguous', both honestly reported, never guessed.
// On exactly one match, reuses summarizePrimaryCastPositions (generic over any position set, per
// the brief, applied to BOTH sides) and compareTalliesForCrossCheck (the SAME hard/soft comparison
// crossCheckAgainstPrimarySource's own single-candidate branch uses) — never a hand-rolled second
// comparison. Clean (0 hard, 0 soft) writes nothing. Any mismatch writes ONE vote_reconciliation_flags
// row via the reused, idempotent writeReconciliationFlag — `voteId` is the mo-senate-web vote's OWN
// id (matches the live system's "vote_id always points at the PRIMARY-source row" convention),
// `sourceB: 'mo-senate-web'`. dryRun never calls writeReconciliationFlag at all (that function isn't
// dry-run-aware — this file's own DRAFT-THEN-APPLY convention keeps the actual write client-side,
// gated here, not inside the reused function).
async function reconcileOneVote(client, dupVote, { dryRun, runId }) {
  const { data: candidateRows, error: candErr } = await client
    .from('votes').select('id,vote_date,chamber,source_key,result')
    .eq('bill_id', dupVote.bill_id).eq('jurisdiction_id', MO_JURISDICTION_ID).eq('chamber', dupVote.chamber)
    .like('source_key', 'legiscan-%');
  if (candErr) {
    return {
      outcome: 'failed',
      detail: { voteId: dupVote.id, reason: 'legiscan_candidate_lookup_failed', error: String(candErr.message ?? candErr) },
    };
  }

  const candidates = (candidateRows ?? []).filter((c) => sameCalendarDate(c.vote_date, dupVote.vote_date));

  if (candidates.length === 0) {
    return {
      outcome: 'no_match',
      detail: {
        voteId: dupVote.id, billId: dupVote.bill_id, chamber: dupVote.chamber, voteDate: dupVote.vote_date,
      },
    };
  }
  if (candidates.length > 1) {
    return {
      outcome: 'ambiguous',
      detail: {
        voteId: dupVote.id,
        billId: dupVote.bill_id,
        candidates: candidates.map((c) => ({ id: c.id, source_key: c.source_key, vote_date: c.vote_date })),
      },
    };
  }

  const legiscanVote = candidates[0];
  const parsedRollCall = parseLegiscanRollCallSourceKey(legiscanVote.source_key);
  if (!parsedRollCall) {
    return {
      outcome: 'unparseable',
      detail: { voteId: dupVote.id, legiscanVoteId: legiscanVote.id, sourceKey: legiscanVote.source_key },
    };
  }

  const { data: primaryCastRows, error: primaryCastErr } = await client
    .from('vote_casts').select('position').eq('vote_id', dupVote.id);
  if (primaryCastErr) {
    return {
      outcome: 'failed',
      detail: { voteId: dupVote.id, reason: 'primary_casts_lookup_failed', error: String(primaryCastErr.message ?? primaryCastErr) },
    };
  }
  const { data: legiscanCastRows, error: legiscanCastErr } = await client
    .from('vote_casts').select('position').eq('vote_id', legiscanVote.id);
  if (legiscanCastErr) {
    return {
      outcome: 'failed',
      detail: { voteId: dupVote.id, reason: 'legiscan_casts_lookup_failed', error: String(legiscanCastErr.message ?? legiscanCastErr) },
    };
  }

  const primaryCounts = summarizePrimaryCastPositions(primaryCastRows ?? []);
  const legiscanCounts = summarizePrimaryCastPositions(legiscanCastRows ?? []);
  const legiscanTallies = {
    tallies: {
      yea: legiscanCounts.yea, nay: legiscanCounts.nay, not_voting: legiscanCounts.not_voting, absent: legiscanCounts.absent,
    },
    chamber: dupVote.chamber,
    date: legiscanVote.vote_date,
    runId,
    rollCallId: parsedRollCall.rollCallId,
  };

  const { hardMismatches, softMismatches } = compareTalliesForCrossCheck(legiscanTallies, primaryCounts);

  if (hardMismatches.length === 0 && softMismatches.length === 0) {
    return {
      outcome: 'clean',
      detail: {
        voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, chamber: dupVote.chamber, matched: true, flag: null,
      },
    };
  }

  const discrepancy = {
    source_a_tallies: legiscanTallies.tallies,
    source_b_tallies: primaryCounts,
    source_b_result: dupVote.result ?? null,
    source_b_vote_id: dupVote.id,
    source_b_source_key: dupVote.source_key,
    hard_mismatches: hardMismatches,
    soft_mismatches: softMismatches,
  };
  if (softMismatches.length > 0) discrepancy.caveat = PRESENT_CATEGORY_CAVEAT;
  const reason = hardMismatches.length > 0 ? 'hard_mismatch' : 'soft_mismatch';

  if (dryRun) {
    return {
      outcome: 'flagged',
      detail: {
        voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason, discrepancy, wouldWrite: true,
      },
    };
  }

  const flag = await writeReconciliationFlag(client, {
    voteId: dupVote.id, sourceB: 'mo-senate-web', discrepancy, runId, rollCallId: parsedRollCall.rollCallId, reason,
  });

  return {
    outcome: 'flagged',
    detail: {
      voteId: dupVote.id, legiscanVoteId: legiscanVote.id, billId: dupVote.bill_id, reason, flag,
    },
  };
}

// runReconcileMo2026Votes — Phase B driver. Only ever looks at mo-senate-web-prefixed votes among
// `mergedBills[].voteRows` (defensive: the brief's live verification found all 31 redirected votes
// were mo-senate-web, but this never assumes that holds forever) — never touches a vote this run
// didn't itself just merge.
export async function runReconcileMo2026Votes(client, {
  dryRun = false, runId = null, mergedBills = [],
} = {}) {
  const votesToCheck = mergedBills.flatMap((m) => (m.voteRows ?? [])
    .filter((v) => String(v.source_key ?? '').startsWith('mo-senate-web-')));

  const cleanMatchDetails = [];
  const flagged = [];
  const noMatch = [];
  const ambiguous = [];
  const unparseable = [];
  const failures = [];

  for (const dupVote of votesToCheck) {
    // eslint-disable-next-line no-await-in-loop -- sequential over at most a few dozen votes (brief:
    // 31), same "small/infrequent backlog" precedent as the rest of this file.
    const result = await reconcileOneVote(client, dupVote, { dryRun, runId });
    if (result.outcome === 'clean') cleanMatchDetails.push(result.detail);
    else if (result.outcome === 'flagged') flagged.push(result.detail);
    else if (result.outcome === 'no_match') noMatch.push(result.detail);
    else if (result.outcome === 'ambiguous') ambiguous.push(result.detail);
    else if (result.outcome === 'unparseable') unparseable.push(result.detail);
    else failures.push(result.detail);
  }

  return {
    votesChecked: votesToCheck.length,
    cleanMatches: cleanMatchDetails.length,
    flaggedCount: flagged.length,
    noMatchCount: noMatch.length,
    ambiguousCount: ambiguous.length,
    unparseableCount: unparseable.length,
    cleanMatchDetails,
    flagged,
    noMatch,
    ambiguous,
    unparseable,
    failures,
  };
}

// runCorrectMo2026SessionMerge — Phase A then Phase B, combined report + combined failures.
export async function runCorrectMo2026SessionMerge(client, {
  dryRun = false, limit = null, runId = null,
} = {}) {
  const merge = await runMergeMo2026Session(client, { dryRun, limit, runId });
  const reconciliation = await runReconcileMo2026Votes(client, { dryRun, runId, mergedBills: merge.merges });
  return {
    merge, reconciliation, failures: [...merge.failures, ...reconciliation.failures],
  };
}

// ============================================================================================
// Top-level dispatcher
// ============================================================================================

export async function runCorrectData(client, {
  which, dryRun = false, limit = null, runId = null,
} = {}) {
  const out = { mode: dryRun ? 'dry-run' : 'live', which };
  const failures = [];

  if (which === 'mo-status' || which === 'all') {
    out.moStatus = await runCorrectMoStatus(client, { dryRun, limit, runId });
    failures.push(...out.moStatus.failures);
  }
  if (which === 'mo-1969-dates' || which === 'all') {
    out.mo1969Dates = await runCorrectMo1969Dates(client, { dryRun, limit, runId });
    failures.push(...out.mo1969Dates.failures);
  }
  // Deliberately EXCLUDED from 'all' (brief, explicit): bill/session merge + FK redirect + guarded
  // deletes is higher-stakes than A/B's in-place rewrites — an operator must name this one, never
  // sweep it in by omission.
  if (which === 'mo-2026-session-merge') {
    out.mo2026SessionMerge = await runCorrectMo2026SessionMerge(client, { dryRun, limit, runId });
    failures.push(...out.mo2026SessionMerge.failures);
  }

  out.failures = failures;
  return out;
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    const report = await runCorrectData(client, { which: args.which, dryRun: true, limit: args.limit });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }

  const runId = await openRun(client, SOURCE);
  try {
    const report = await runCorrectData(client, {
      which: args.which, dryRun: false, limit: args.limit, runId,
    });
    const status = report.failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { which: args.which, report });
    console.log(JSON.stringify({
      mode: 'live', run_id: runId, status, source: SOURCE, ...report,
    }, null, 2));
    if (report.failures.length > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
