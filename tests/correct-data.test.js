import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseArgs,
  MO_STATUS_WORD_MAP,
  MO_STATUS_MAPPED_CODES,
  MO_STATUS_PROGRESS_ONLY_CODES,
  MO_STATUS_UNMAPPED_CODE,
  mapMoStatusCode,
  parseMoSenateJournalDateFromUrl,
  VOTE_DATE_1969_SENTINEL,
  runCorrectMoStatus,
  runCorrectMo1969Dates,
  runCorrectPartyNormalize,
  runCorrectData,
  CANONICAL_MO_2026_SESSION_IDENTIFIER,
  DUPLICATE_MO_2026_SESSION_IDENTIFIER,
  DUP_BILL_MUST_BE_EMPTY_TABLES,
  runMergeMo2026Session,
  runReconcileMo2026Votes,
  runReconcileMo2026VotesStandalone,
  runCorrectMo2026SessionMerge,
  classifyLegiscanSourceRow,
  LEGISCAN_TEXTS_ERROR_MARKERS,
  runCorrectLegiscanSourceSplit,
  runCorrectVoteDuplicates,
  runCorrectMoHouseChamber,
  PIERSON_WRONG_PERSON_ID,
  PIERSON_LEGISLATOR_IDS,
  runCorrectPiersonSplit,
} from '../src/cli/correct-data.js';

// Data-corrections CLI (.superpowers/sdd/2026-07-31-data-corrections/brief.md). Two REVERSIBLE
// production-data corrections (both re-derivable from cached LegiScan datasets / the primary MO
// Senate journal source), draft-then-apply — this test file proves the dry-run/live orchestration
// logic entirely against a fake in-memory client; ZERO live DB writes anywhere in this file, and no
// live run is ever performed from this repo (Lance's own separate explicit word, per the brief).

// ---- fake Supabase-ish client: eq/in/order/limit + select/update/delete, thenable builder ----
// A single generic in-memory fake (not one bespoke mock per call site) because both corrections
// issue a handful of genuinely different call shapes (plain select, count-only head select,
// update+select(count:exact), delete+select) against three small tables (bills, votes,
// vote_casts) — mirrors real supabase-js closely enough (fluent + thenable) to exercise this
// module's actual query construction, not just its counting arithmetic.
function likeToRegExp(pattern) {
  const escaped = String(pattern).split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`);
}

function makeFakeClient(seed = {}, { forceError = null, afterExecute = null } = {}) {
  const tables = {
    bills: [],
    votes: [],
    vote_casts: [],
    sessions: [],
    bill_texts: [],
    bill_sponsors: [],
    summaries: [],
    bill_actions: [],
    vote_reconciliation_flags: [],
    legislators: [],
    // legiscan-source-split (TODO-33) reads this table too — defaulted empty so every EXISTING
    // 'all' test (none of which seed it) still works as a harmless no-op, not an undefined-table
    // crash.
    ingestion_runs: [],
    // vote-duplicates (2026-08-03) — same reasoning as ingestion_runs above.
    vote_duplicates: [],
    // pierson-split (accuracy audit, 2026-08-03) — same reasoning as ingestion_runs above.
    persons: [],
    person_links: [],
    ...seed,
  };
  for (const t of Object.keys(tables)) tables[t] = tables[t].map((r) => ({ ...r }));
  const calls = [];
  let insertCounter = 0;

  function matchesFilters(row, filters) {
    return filters.every((f) => {
      if (f.op === 'eq') return row[f.col] === f.val;
      if (f.op === 'in') return f.vals.includes(row[f.col]);
      if (f.op === 'like') return likeToRegExp(f.val).test(String(row[f.col] ?? ''));
      return true;
    });
  }

  function makeBuilder(table, mode, patch) {
    const filters = [];
    let orderCol = null;
    let orderAsc = true;
    let limitVal = null;
    let rangeVal = null;
    let selectCols = null;
    let selectOpts = {};

    const builder = {
      eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
      in(col, vals) { filters.push({ op: 'in', col, vals }); return builder; },
      like(col, val) { filters.push({ op: 'like', col, val }); return builder; },
      order(col, { ascending = true } = {}) { orderCol = col; orderAsc = ascending; return builder; },
      limit(n) { limitVal = n; return builder; },
      range(from, to) { rangeVal = [from, to]; return builder; },
      select(cols, opts = {}) { selectCols = cols; selectOpts = opts; return builder; },
      then(resolve, reject) {
        try {
          resolve(execute());
        } catch (e) {
          if (reject) reject(e); else throw e;
        }
      },
    };

    function execute() {
      const callInfo = {
        table, mode, patch, filters: [...filters], select: selectCols, selectOpts, orderCol, limitVal, rangeVal,
      };
      calls.push(callInfo);
      // 4th arg (selectOpts) is new — lets a test distinguish two calls that share the same
      // table/mode/filters shape but differ in intent (e.g. a plain multi-row select vs. a
      // count-only `head:true` recount against the SAME table/filter). Every EXISTING forceError
      // callback in this file only reads the first 3 params, so this is purely additive.
      const injected = forceError && forceError(table, mode, filters, selectOpts);
      if (injected) return { data: null, error: injected, count: null };

      const rows = tables[table];
      let matched = rows.filter((r) => matchesFilters(r, filters));
      let result;

      if (mode === 'select') {
        if (orderCol) {
          matched = [...matched].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : -1) * (orderAsc ? 1 : -1));
        }
        let out = matched;
        if (rangeVal) out = out.slice(rangeVal[0], rangeVal[1] + 1);
        else if (limitVal != null) out = out.slice(0, limitVal);
        if (selectOpts.head) result = { data: null, error: null, count: matched.length };
        else if (selectOpts.count === 'exact') result = { data: out.map((r) => ({ ...r })), error: null, count: matched.length };
        else result = { data: out.map((r) => ({ ...r })), error: null };
      } else if (mode === 'update') {
        for (const row of matched) Object.assign(row, patch);
        if (selectCols) {
          const data = matched.map((r) => ({ id: r.id }));
          // FIX (2026-08-02, found live): the real Supabase/PostgREST endpoint this project talks
          // to does NOT populate `count` for .update().select({count:'exact'}) — verified by direct
          // probe against production (party-normalize's live run reported updated:0 while the DATA
          // genuinely changed for 601 rows). `data` is always populated correctly regardless. This
          // fake previously computed a faithful `count: matched.length` here, which is MORE
          // accurate than reality and was silently masking every call site that read `count`
          // instead of `data.length` — mirror the real (broken) behavior so a test proves the
          // production code path actually works, not just that it works against a too-generous
          // fake. SELECT's own count:'exact' (the `mode === 'select'` branch above) is unaffected
          // — that's a genuinely different, more standard PostgREST feature, not disproven here.
          result = { data, error: null, count: null };
        } else {
          result = { data: null, error: null };
        }
      } else if (mode === 'delete') {
        const idsToDelete = new Set(matched.map((r) => r.id));
        tables[table] = rows.filter((r) => !idsToDelete.has(r.id));
        result = selectCols ? { data: matched.map((r) => ({ id: r.id })), error: null } : { data: null, error: null };
      } else {
        throw new Error(`unsupported mode ${mode}`);
      }

      // Fires AFTER this call's own result is already computed (a snapshot, unaffected by any
      // mutation the hook makes below) but BEFORE returning — lets a test simulate a concurrent
      // writer racing between two awaited calls (e.g. mutating a row's status right after an
      // id-select returns, so a LATER update in the same code path sees the raced-away state).
      if (afterExecute) afterExecute(callInfo, tables);

      return result;
    }

    return builder;
  }

  // makeInsertBuilder — only vote_reconciliation_flags (via legiscan-votes.js's own
  // writeReconciliationFlag, reused unmodified by the mo-2026-session-merge reconciliation phase)
  // ever inserts through this fake client. Mirrors tests/legiscan-votes.test.js's own
  // makeFakeVotesDb insert shape (`.insert(row).select().single()`) closely enough to drive that
  // real function's actual call chain, not a bespoke re-derivation of it.
  function makeInsertBuilder(table, row) {
    return {
      select: () => ({
        single: async () => {
          // 4th arg (the row being inserted) is new — lets a test selectively fail ONE insert (e.g.
          // "the flag write for vote-2 only") without a bespoke mock, by inspecting `row` inside its
          // own forceError callback. Every EXISTING forceError callback in this file only reads the
          // first 3 params, so this is purely additive.
          const injected = forceError && forceError(table, 'insert', [], row);
          if (injected) return { data: null, error: injected };
          insertCounter += 1;
          const inserted = {
            id: `${table}-${insertCounter}`, resolved: false, created_at: 'test-time', ...row,
          };
          tables[table].push(inserted);
          calls.push({
            table, mode: 'insert', patch: row, filters: [], select: null, selectOpts: {}, orderCol: null, limitVal: null, rangeVal: null,
          });
          return { data: { ...inserted }, error: null };
        },
      }),
    };
  }

  return {
    tables,
    calls,
    from(table) {
      return {
        select: (cols, opts) => makeBuilder(table, 'select', null).select(cols, opts),
        update: (patch) => makeBuilder(table, 'update', patch),
        delete: () => makeBuilder(table, 'delete', null),
        insert: (row) => makeInsertBuilder(table, row),
      };
    },
  };
}

// ---- vote-duplicates (2026-08-03): the never-built "primary-source row wins for display" ruling,
// backfilled for the existing cross-adapter duplicate backlog. Reuses
// crossCheckAgainstPrimarySource directly (not a parallel reimplementation) — see that function's
// own tests (tests/legiscan-votes.test.js) for its matching/disambiguation behavior; these tests
// only prove the dry-run/live orchestration and idempotency around it. ----

const MO_BILL_ID = 'bill-mo-1';

function seedVoteDuplicateFixture({ withMismatch = false } = {}) {
  const legiscanVote = {
    id: 'v-legiscan-1', bill_id: MO_BILL_ID, jurisdiction_id: 'mo-legislature', chamber: 'house',
    vote_date: '2018-09-12T00:00:00Z', source_key: 'legiscan-1530-rollcall-774312',
  };
  const primaryVote = {
    id: 'v-primary-1', bill_id: MO_BILL_ID, jurisdiction_id: 'mo-legislature', chamber: 'house',
    vote_date: '2018-09-12T00:00:00Z', source_key: 'mo-house-xml-2018-hb3-vote1',
  };
  const legiscanCasts = [
    { id: 'c1', vote_id: 'v-legiscan-1', legislator_id: 'l1', position: 'yea' },
    { id: 'c2', vote_id: 'v-legiscan-1', legislator_id: 'l2', position: withMismatch ? 'yea' : 'nay' },
  ];
  const primaryCasts = [
    { id: 'c3', vote_id: 'v-primary-1', legislator_id: 'l1', position: 'yea' },
    { id: 'c4', vote_id: 'v-primary-1', legislator_id: 'l2', position: 'nay' },
  ];
  return {
    votes: [legiscanVote, primaryVote],
    vote_casts: [...legiscanCasts, ...primaryCasts],
  };
}

test('runCorrectVoteDuplicates: dry-run finds a genuine clean match and reports it without writing', async () => {
  const client = makeFakeClient(seedVoteDuplicateFixture());
  const result = await runCorrectVoteDuplicates(client, { dryRun: true });
  assert.equal(result.matched, 1);
  assert.equal(result.alreadyMarked, 0);
  assert.deepEqual(result.failures, []);
  assert.equal(client.tables.vote_duplicates.length, 0, 'dry-run must never write');
});

test('runCorrectVoteDuplicates: live run writes the exact pair dry-run reported', async () => {
  const client = makeFakeClient(seedVoteDuplicateFixture());
  const dry = await runCorrectVoteDuplicates(client, { dryRun: true });
  const live = await runCorrectVoteDuplicates(client, { dryRun: false, runId: 'run-1' });
  assert.equal(live.matched, dry.matched);
  const inserted = client.tables.vote_duplicates;
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].canonical_vote_id, 'v-primary-1');
  assert.equal(inserted[0].superseded_vote_id, 'v-legiscan-1');
});

test('runCorrectVoteDuplicates: a pair already marked in vote_duplicates is not re-counted or re-written', async () => {
  const client = makeFakeClient({
    ...seedVoteDuplicateFixture(),
    vote_duplicates: [{
      id: 'vd-1', canonical_vote_id: 'v-primary-1', superseded_vote_id: 'v-legiscan-1', reason: 'existing', created_at: 'test-time',
    }],
  });
  const result = await runCorrectVoteDuplicates(client, { dryRun: true });
  assert.equal(result.matched, 0);
  assert.equal(result.alreadyMarked, 1);
});

test('runCorrectVoteDuplicates: a genuine tally mismatch is never marked as a duplicate', async () => {
  const client = makeFakeClient(seedVoteDuplicateFixture({ withMismatch: true }));
  const result = await runCorrectVoteDuplicates(client, { dryRun: true });
  assert.equal(result.matched, 0);
  assert.equal(client.tables.vote_duplicates.length, 0);
});

test('runCorrectVoteDuplicates: an unparseable LegiScan source_key is counted, never guessed', async () => {
  const client = makeFakeClient({
    votes: [
      { id: 'v-bad', bill_id: MO_BILL_ID, jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12T00:00:00Z', source_key: 'legiscan-not-a-real-shape' },
    ],
    vote_casts: [],
  });
  const result = await runCorrectVoteDuplicates(client, { dryRun: true });
  assert.equal(result.unparseable, 1);
  assert.equal(result.matched, 0);
});

// ---- runCorrectMoHouseChamber ----
// FOUND LIVE (accuracy audit, 2026-08-03): buildMoVoteRows (src/adapters/mo-house-xml.js) used to
// stamp chamber:'house' on every roll call in a House bill's own action history, including real
// Senate floor actions embedded in it (their motion text ends in the literal "(S)" marker). Fixed
// at the source going forward; this is the one-time backfill for the rows that already landed
// mislabeled.

test('runCorrectMoHouseChamber: dry-run finds a mo-house-xml row whose question ends "(S)" but is stamped chamber=house, without writing', async () => {
  const client = makeFakeClient({
    votes: [
      { id: 'v-mislabeled', source_key: 'mo-house-xml-HB1644-4', question: 'Third Read and Passed with Amendments (S)', chamber: 'house', result: '23-8' },
      { id: 'v-correct-house', source_key: 'mo-house-xml-HB1644-1', question: 'Reported Do Pass (H)', chamber: 'house', result: '6-3' },
      { id: 'v-already-senate', source_key: 'mo-house-xml-HB1740-5', question: 'Third Read and Passed (S)', chamber: 'senate', result: '32-0' },
      { id: 'v-final-passage', source_key: 'mo-house-xml-HB1696-6', question: 'Truly Agreed To and Finally Passed', chamber: 'house', result: '139-3' },
      { id: 'v-not-mo-house', source_key: 'legiscan-2239-rollcall-1', question: 'Senate: Third Reading', chamber: 'senate', result: '29-0' },
    ],
  });
  const result = await runCorrectMoHouseChamber(client, { dryRun: true });
  assert.equal(result.matched, 1);
  assert.deepEqual(result.ids, ['v-mislabeled']);
  assert.deepEqual(result.failures, []);
  assert.equal(client.tables.votes.find((v) => v.id === 'v-mislabeled').chamber, 'house', 'dry-run must never write');
});

test('runCorrectMoHouseChamber: live run corrects exactly the rows dry-run reported, to chamber=senate', async () => {
  const client = makeFakeClient({
    votes: [
      { id: 'v-mislabeled-1', source_key: 'mo-house-xml-HB1644-4', question: 'Third Read and Passed with Amendments (S)', chamber: 'house', result: '23-8' },
      { id: 'v-mislabeled-2', source_key: 'mo-house-xml-HB1740-5', question: 'Third Read and Passed (S)', chamber: 'house', result: '32-0' },
      { id: 'v-correct-house', source_key: 'mo-house-xml-HB1644-1', question: 'Reported Do Pass (H)', chamber: 'house', result: '6-3' },
    ],
  });
  const dry = await runCorrectMoHouseChamber(client, { dryRun: true });
  const live = await runCorrectMoHouseChamber(client, { dryRun: false, runId: 'run-1' });
  assert.equal(live.matched, dry.matched);
  assert.equal(live.matched, 2);
  assert.equal(client.tables.votes.find((v) => v.id === 'v-mislabeled-1').chamber, 'senate');
  assert.equal(client.tables.votes.find((v) => v.id === 'v-mislabeled-2').chamber, 'senate');
  assert.equal(client.tables.votes.find((v) => v.id === 'v-mislabeled-1').run_id, 'run-1');
  assert.equal(client.tables.votes.find((v) => v.id === 'v-correct-house').chamber, 'house', 'must never touch a correctly-labeled row');
});

// ---- runCorrectPiersonSplit ----
// FOUND LIVE (accuracy audit, 2026-08-03): Tommie Pierson Sr. and Jr. — father and son, distinct
// LegiScan ids, clean non-overlapping vote-year footprints — auto-merged into one person with
// empty seat evidence. Non-destructive: mirrors 0012_identity_merge.sql's own design ("a wrong
// link is one UPDATE to undo") — delete the person_links rows, null legislators.person_id on
// both, delete the now-empty person row. Neither legislator row nor any vote_casts/terms row is
// ever touched beyond person_id itself.

function seedPiersonFixture() {
  return {
    legislators: [
      { id: PIERSON_LEGISLATOR_IDS[0], full_name: 'Tommie Pierson', legiscan_people_id: 15900, person_id: PIERSON_WRONG_PERSON_ID },
      { id: PIERSON_LEGISLATOR_IDS[1], full_name: 'Tommie Pierson', legiscan_people_id: 18826, person_id: PIERSON_WRONG_PERSON_ID },
    ],
    persons: [{ id: PIERSON_WRONG_PERSON_ID, display_name: 'Tommie Pierson', display_name_source: 'legiscan' }],
    person_links: [
      { id: 'pl-1', person_id: PIERSON_WRONG_PERSON_ID, legislator_id: PIERSON_LEGISLATOR_IDS[0], evidence: {}, decided_by: 'auto' },
      { id: 'pl-2', person_id: PIERSON_WRONG_PERSON_ID, legislator_id: PIERSON_LEGISLATOR_IDS[1], evidence: {}, decided_by: 'auto' },
    ],
  };
}

test('runCorrectPiersonSplit: dry-run reports the exact rows it would touch, without writing', async () => {
  const client = makeFakeClient(seedPiersonFixture());
  const result = await runCorrectPiersonSplit(client, { dryRun: true });
  assert.equal(result.matched, 2);
  assert.deepEqual(result.legislatorIds.slice().sort(), [...PIERSON_LEGISLATOR_IDS].sort());
  assert.deepEqual(result.failures, []);
  assert.equal(client.tables.persons.length, 1, 'dry-run must never write');
  assert.equal(client.tables.person_links.length, 2, 'dry-run must never write');
});

test('runCorrectPiersonSplit: live run deletes both person_links rows, nulls person_id on both legislators, and deletes the now-empty person row', async () => {
  const client = makeFakeClient(seedPiersonFixture());
  const dry = await runCorrectPiersonSplit(client, { dryRun: true });
  const live = await runCorrectPiersonSplit(client, { dryRun: false });
  assert.equal(live.matched, dry.matched);
  assert.equal(live.personDeleted, true);
  assert.deepEqual(client.tables.person_links, []);
  assert.deepEqual(client.tables.persons, []);
  for (const id of PIERSON_LEGISLATOR_IDS) {
    assert.equal(client.tables.legislators.find((l) => l.id === id).person_id, null);
  }
});

test('runCorrectPiersonSplit: a second run after the split is a clean, honest no-op — never re-deletes or errors', async () => {
  const client = makeFakeClient(seedPiersonFixture());
  await runCorrectPiersonSplit(client, { dryRun: false });
  const second = await runCorrectPiersonSplit(client, { dryRun: false });
  assert.equal(second.matched, 0);
  assert.equal(second.alreadySplit, true);
  assert.deepEqual(second.failures, []);
});

test('runCorrectPiersonSplit: never touches an unrelated person/legislator row', async () => {
  const client = makeFakeClient({
    ...seedPiersonFixture(),
    legislators: [
      ...seedPiersonFixture().legislators,
      { id: 'leg-unrelated', full_name: 'Someone Else', person_id: 'person-unrelated' },
    ],
    persons: [
      ...seedPiersonFixture().persons,
      { id: 'person-unrelated', display_name: 'Someone Else', display_name_source: 'legiscan' },
    ],
    person_links: [
      ...seedPiersonFixture().person_links,
      { id: 'pl-unrelated', person_id: 'person-unrelated', legislator_id: 'leg-unrelated', evidence: {}, decided_by: 'auto' },
    ],
  });
  await runCorrectPiersonSplit(client, { dryRun: false });
  assert.equal(client.tables.persons.find((p) => p.id === 'person-unrelated') != null, true);
  assert.equal(client.tables.legislators.find((l) => l.id === 'leg-unrelated').person_id, 'person-unrelated');
  assert.equal(client.tables.person_links.find((l) => l.id === 'pl-unrelated') != null, true);
});

// ---- parseArgs ----

test('parseArgs: requires exactly one <which> positional, no default (no accidental "all" run)', () => {
  assert.throws(() => parseArgs([]), /requires exactly one/);
  assert.throws(() => parseArgs(['--dry-run']), /requires exactly one/);
});

test('parseArgs: accepts mo-status | mo-1969-dates | all, rejects anything else', () => {
  assert.equal(parseArgs(['mo-status']).which, 'mo-status');
  assert.equal(parseArgs(['mo-1969-dates']).which, 'mo-1969-dates');
  assert.equal(parseArgs(['all']).which, 'all');
  assert.throws(() => parseArgs(['bogus']), /unknown <which>/);
});

test('parseArgs: --dry-run and --limit both parse, --limit uses the shared fail-loud positive-integer validation', () => {
  const args = parseArgs(['mo-status', '--dry-run', '--limit', '5']);
  assert.equal(args.dryRun, true);
  assert.equal(args.limit, 5);
  assert.throws(() => parseArgs(['mo-status', '--limit', '0']), /positive integer/);
  assert.throws(() => parseArgs(['mo-status', '--limit', 'abc']), /positive integer/);
});

test('parseArgs: rejects unknown flags', () => {
  assert.throws(() => parseArgs(['mo-status', '--bogus']), /unknown flag/);
});

// ---- MO_STATUS_WORD_MAP — SOURCED from LegiScan's own API manual, page 42, "Status / Progress"
// table (tests/fixtures/research/legiscan/LegiScan_API_User_Manual.pdf). Pins each of 1-6 to its
// printed word and asserts 0 and 7-12 are NEVER in the "safe to write" set. ----

test('MO_STATUS_WORD_MAP: pins each of 1-6 to LegiScan\'s own printed word, exactly', () => {
  assert.deepEqual(MO_STATUS_WORD_MAP, {
    1: 'Introduced', 2: 'Engrossed', 3: 'Enrolled', 4: 'Passed', 5: 'Vetoed', 6: 'Failed',
  });
  assert.deepEqual(MO_STATUS_MAPPED_CODES, [1, 2, 3, 4, 5, 6]);
});

test('MO_STATUS_WORD_MAP: 0 and 7-12 are NOT in the safe-to-write set — 0 has no honest single word, 7-12 are progress-array-only per the manual, never a bill\'s overall status', () => {
  assert.equal(MO_STATUS_WORD_MAP[0], undefined);
  for (const code of [7, 8, 9, 10, 11, 12]) assert.equal(MO_STATUS_WORD_MAP[code], undefined);
  assert.equal(MO_STATUS_UNMAPPED_CODE, 0);
  assert.deepEqual(MO_STATUS_PROGRESS_ONLY_CODES, [7, 8, 9, 10, 11, 12]);
});

test('mapMoStatusCode: maps 1-6 to their word, returns null for 0/7-12/anything undocumented — never guessed', () => {
  assert.equal(mapMoStatusCode(1), 'Introduced');
  assert.equal(mapMoStatusCode(6), 'Failed');
  assert.equal(mapMoStatusCode(0), null);
  assert.equal(mapMoStatusCode(7), null);
  assert.equal(mapMoStatusCode(99), null);
});

// ---- parseMoSenateJournalDateFromUrl — verified against the ACTUAL cached MO Senate journal
// filenames on disk (.superpowers/artifacts/mo-senate-journal-index/2018.json,
// .superpowers/artifacts/mo-senate-journals/) before trusting this regex. ----

test('parseMoSenateJournalDateFromUrl: the brief\'s own example — RDay330301462-486 under /18info/ -> 2018-03-01', () => {
  const url = 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf#470';
  assert.equal(parseMoSenateJournalDateFromUrl(url), '2018-03-01');
});

test('parseMoSenateJournalDateFromUrl: real cached filenames verified against the journal index\'s own journal_date field, zero mismatches — Day 01 (RDay0101031-86, /18info/) -> 2018-01-03, Day 07 (RDay070116141-151) -> 2018-01-16', () => {
  assert.equal(parseMoSenateJournalDateFromUrl('https://www.senate.mo.gov/18info/Journals/RDay0101031-86.pdf'), '2018-01-03');
  assert.equal(parseMoSenateJournalDateFromUrl('https://www.senate.mo.gov/18info/Journals/RDay070116141-151.pdf'), '2018-01-16');
});

test('parseMoSenateJournalDateFromUrl: case-insensitive on the RDay/Rday prefix — real 2026 index has "Rday" lowercase-d variants (Rday360319651-660.pdf under /26info/ -> 2026-03-19)', () => {
  assert.equal(parseMoSenateJournalDateFromUrl('https://www.senate.mo.gov/26info/Journals/Rday360319651-660.pdf'), '2026-03-19');
});

test('parseMoSenateJournalDateFromUrl: does NOT guess on a genuinely different real filename scheme — the real 2018 index also has T1Day/S1Day (special-session) filenames that do not match the Regular-session RDay pattern at all; refuses rather than mis-parsing', () => {
  assert.equal(parseMoSenateJournalDateFromUrl('https://www.senate.mo.gov/18info/Journals/T1Day0109101-18.pdf'), null);
  assert.equal(parseMoSenateJournalDateFromUrl('https://www.senate.mo.gov/18info/Journals/S1Day0105181-3.pdf'), null);
});

test('parseMoSenateJournalDateFromUrl: unparseable/missing url -> null, never throws, never guesses', () => {
  assert.equal(parseMoSenateJournalDateFromUrl(null), null);
  assert.equal(parseMoSenateJournalDateFromUrl(undefined), null);
  assert.equal(parseMoSenateJournalDateFromUrl(''), null);
  assert.equal(parseMoSenateJournalDateFromUrl('https://www.senate.mo.gov/18info/Journals/not-a-journal.pdf'), null);
  assert.equal(parseMoSenateJournalDateFromUrl('https://www.senate.mo.gov/Journals/RDay330301462-486.pdf'), null, 'no /NNinfo/ year segment at all');
});

// ---- runCorrectMoStatus ----

function billRow(id, status) { return { id, status }; }

test('runCorrectMoStatus: an update only fires against an EXACT numeric match — a word-status row and a federal (text) row are never touched, per-code counts reconcile to updated', async () => {
  const client = makeFakeClient({
    bills: [
      billRow('b1', '1'), billRow('b2', '1'), billRow('b3', '2'),
      billRow('b4', 'Introduced'), // already-corrected word — must NEVER match a numeric .eq()
      billRow('b5', 'Signed by Governor'), // federal/primary-source text status
      billRow('b6', '0'), billRow('b7', '7'),
    ],
  });
  const report = await runCorrectMoStatus(client, { dryRun: false, runId: 'run-1' });

  assert.deepEqual(report.perCode, {
    1: 2, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0,
  });
  assert.equal(report.updated, 3, 'sum of perCode');
  assert.equal(report.leftUntouchedZero, 1);
  assert.equal(report.unexpectedMappedCode, 1);
  assert.deepEqual(report.failures, []);

  // the word-status and text-status rows are byte-for-byte untouched
  assert.equal(client.tables.bills.find((b) => b.id === 'b4').status, 'Introduced');
  assert.equal(client.tables.bills.find((b) => b.id === 'b5').status, 'Signed by Governor');
  // the numeric-status rows were actually rewritten to the mapped word
  assert.equal(client.tables.bills.find((b) => b.id === 'b1').status, 'Introduced');
  assert.equal(client.tables.bills.find((b) => b.id === 'b3').status, 'Engrossed');
  // 0 and 7 are left untouched (no safe word exists / progress-array-only)
  assert.equal(client.tables.bills.find((b) => b.id === 'b6').status, '0');
  assert.equal(client.tables.bills.find((b) => b.id === 'b7').status, '7');

  // every update call carries the exact-match .eq('status', code) guard
  const updateCalls = client.calls.filter((c) => c.mode === 'update' && c.table === 'bills');
  for (const c of updateCalls) {
    assert.ok(c.filters.some((f) => f.op === 'eq' && f.col === 'status'), 'guarded by an exact status .eq()');
  }
});

test('runCorrectMoStatus: --dry-run performs ZERO writes — reports the same honest matched counts (so a dry-run reproduces the live target numbers) but nothing in the table changes', async () => {
  const client = makeFakeClient({
    bills: [billRow('b1', '1'), billRow('b2', '4'), billRow('b3', '0')],
  });
  const before = JSON.stringify(client.tables.bills);
  const report = await runCorrectMoStatus(client, { dryRun: true });

  assert.equal(report.perCode[1], 1);
  assert.equal(report.perCode[4], 1);
  assert.equal(report.updated, 2);
  assert.equal(report.leftUntouchedZero, 1);
  assert.equal(JSON.stringify(client.tables.bills), before, 'zero writes — table is byte-for-byte unchanged');
  assert.equal(client.calls.some((c) => c.mode === 'update'), false, 'dry-run never issues an update call at all');
});

test('runCorrectMoStatus: --limit caps how many rows get corrected per code, deterministically (ordered), and unaffected codes still report 0 correctly', async () => {
  const client = makeFakeClient({
    bills: [
      billRow('b1', '1'), billRow('b2', '1'), billRow('b3', '1'),
      billRow('b4', '2'),
    ],
  });
  const report = await runCorrectMoStatus(client, { dryRun: false, limit: 2, runId: 'run-1' });
  assert.equal(report.perCode[1], 2, 'code 1 capped at the limit even though 3 rows matched');
  assert.equal(report.perCode[2], 0, 'budget exhausted before code 2 is reached');
  assert.equal(report.updated, 2);
  const stillNumeric = client.tables.bills.filter((b) => b.status === '1');
  assert.equal(stillNumeric.length, 1, 'exactly one code-1 row is left uncorrected by the limit');
  assert.equal(client.tables.bills.find((b) => b.id === 'b4').status, '2', 'code 2 never attempted once budget hit 0');
});

// REVIEW FIX (MEDIUM finding): the --limit-active live branch used to report `matched: ids.length`
// (the pre-update SELECT count) instead of the update's own returned `count` — a race between the
// id-select and the update (another process changing one of those exact rows' status in between)
// would silently OVERCOUNT. This simulates that race directly: right after the id-select for code 1
// returns (3 ids), a "concurrent process" mutates one of those rows away from status '1' before the
// update executes — the update's own `.eq('status','1')` guard then correctly excludes it, and the
// reported count must reflect that (2, not 3).
test('runCorrectMoStatus: --limit live path reports the update\'s ACTUAL returned count, not the pre-update selected id count — proven with a simulated select-then-update race', async () => {
  const client = makeFakeClient(
    { bills: [billRow('b1', '1'), billRow('b2', '1'), billRow('b3', '1')] },
    {
      afterExecute(callInfo, tables) {
        // Only the id-fetch select for code 1 (select 'id' with no count/head option) triggers the
        // simulated race — not the subsequent update itself.
        if (callInfo.table === 'bills' && callInfo.mode === 'select' && callInfo.select === 'id' && !callInfo.selectOpts.count) {
          const raced = tables.bills.find((b) => b.id === 'b2');
          if (raced) raced.status = 'Introduced'; // a concurrent process already corrected it
        }
      },
    },
  );

  const report = await runCorrectMoStatus(client, { dryRun: false, limit: 3, runId: 'run-1' });

  assert.equal(report.perCode[1], 2, 'the update itself only actually matched/changed 2 rows — b2 raced away between select and update');
  assert.equal(report.updated, 2);
  assert.equal(client.tables.bills.find((b) => b.id === 'b1').status, 'Introduced');
  assert.equal(client.tables.bills.find((b) => b.id === 'b3').status, 'Introduced');
  assert.equal(client.tables.bills.find((b) => b.id === 'b2').status, 'Introduced', 'still corrected — just NOT by this update, and not counted as if it were');
});

test('runCorrectMoStatus: a query failure for one code is an honest, named failure — other codes still process (skip != empty), never thrown out of the whole run', async () => {
  const client = makeFakeClient(
    { bills: [billRow('b1', '1'), billRow('b2', '2')] },
    { forceError: (table, mode, filters) => (table === 'bills' && mode === 'update' && filters.some((f) => f.val === '1') ? { message: 'connection reset' } : null) },
  );
  const report = await runCorrectMoStatus(client, { dryRun: false, runId: 'run-1' });
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].code, 1);
  assert.match(report.failures[0].error, /connection reset/);
  assert.equal(report.perCode[2], 1, 'code 2 still processed despite code 1 failing');
  assert.equal(client.tables.bills.find((b) => b.id === 'b2').status, 'Engrossed');
});

// ---- runCorrectPartyNormalize ----

function legislatorRow(id, party) { return { id, party }; }

test('runCorrectPartyNormalize: R/D decode to full words; Independent, Independent Democrat, and NULL are never touched; empty string becomes NULL', async () => {
  const client = makeFakeClient({
    legislators: [
      legislatorRow('l1', 'R'), legislatorRow('l2', 'R'), legislatorRow('l3', 'D'),
      legislatorRow('l4', 'Independent'), // already a full word — must never be rewritten
      legislatorRow('l5', 'Independent Democrat'), // Lieberman's real affiliation — never collapsed
      legislatorRow('l6', null), // genuinely unknown — stays null, not normalized to anything
      legislatorRow('l7', ''), // LegiScan's blank — becomes null, not a word
    ],
  });
  const report = await runCorrectPartyNormalize(client, { dryRun: false, runId: 'run-1' });

  assert.deepEqual(report.perCode, { R: 2, D: 1 });
  assert.equal(report.emptyStringToNull, 1);
  assert.equal(report.updated, 4, 'sum of perCode + emptyStringToNull');
  assert.deepEqual(report.failures, []);

  assert.equal(client.tables.legislators.find((l) => l.id === 'l1').party, 'Republican');
  assert.equal(client.tables.legislators.find((l) => l.id === 'l2').party, 'Republican');
  assert.equal(client.tables.legislators.find((l) => l.id === 'l3').party, 'Democratic');
  assert.equal(client.tables.legislators.find((l) => l.id === 'l4').party, 'Independent', 'already a word — untouched');
  assert.equal(client.tables.legislators.find((l) => l.id === 'l5').party, 'Independent Democrat', 'Lieberman — never collapsed into a different party');
  assert.equal(client.tables.legislators.find((l) => l.id === 'l6').party, null, 'genuinely unknown — stays null');
  assert.equal(client.tables.legislators.find((l) => l.id === 'l7').party, null, 'blank string normalized to null, not a guessed word');

  const updateCalls = client.calls.filter((c) => c.mode === 'update' && c.table === 'legislators');
  for (const c of updateCalls) {
    assert.ok(c.filters.some((f) => f.op === 'eq' && f.col === 'party'), 'every write is guarded by an exact party .eq()');
  }
});

test('runCorrectPartyNormalize: --dry-run performs ZERO writes — reports the same honest matched counts', async () => {
  const client = makeFakeClient({
    legislators: [legislatorRow('l1', 'R'), legislatorRow('l2', 'D'), legislatorRow('l3', '')],
  });
  const before = JSON.stringify(client.tables.legislators);
  const report = await runCorrectPartyNormalize(client, { dryRun: true, runId: null });

  assert.deepEqual(report.perCode, { R: 1, D: 1 });
  assert.equal(report.emptyStringToNull, 1);
  assert.equal(report.updated, 3, 'sum of perCode (2) + emptyStringToNull (1)');
  assert.equal(JSON.stringify(client.tables.legislators), before, 'zero writes in dry-run');
  assert.equal(client.calls.filter((c) => c.mode === 'update').length, 0);
});

test('runCorrectPartyNormalize: a write failure on one value is recorded and does not block the other', async () => {
  const client = makeFakeClient(
    { legislators: [legislatorRow('l1', 'R'), legislatorRow('l2', 'D')] },
    { forceError: (table, mode, filters) => (table === 'legislators' && mode === 'update' && filters.some((f) => f.val === 'R') ? { message: 'connection reset' } : null) },
  );
  const report = await runCorrectPartyNormalize(client, { dryRun: false, runId: 'run-1' });
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].code, 'R');
  assert.match(report.failures[0].error, /connection reset/);
  assert.equal(report.perCode.D, 1, 'D still processed despite R failing');
  assert.equal(client.tables.legislators.find((l) => l.id === 'l2').party, 'Democratic');
  assert.equal(client.tables.legislators.find((l) => l.id === 'l1').party, 'R', 'the failed write left the source value untouched, not corrupted');
});

// ---- runCorrectMo1969Dates ----

const SENTINEL = VOTE_DATE_1969_SENTINEL;

test('runCorrectMo1969Dates: a sentinel row with a dated primary duplicate (same bill/chamber, matching yea/nay tallies AND the exact same set of casting legislators) -> delete path (votes row + its casts), never re-dated; report.matches records the decision', async () => {
  const client = makeFakeClient({
    votes: [
      {
        id: 'v-sentinel', bill_id: 'bill-1', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf#470',
      },
      {
        id: 'v-primary', bill_id: 'bill-1', chamber: 'senate', vote_date: '2018-03-01', jurisdiction_id: 'mo-legislature', source_key: 'mo-senate-web-2018-RDay330301462-486-vote1',
      },
    ],
    vote_casts: [
      { id: 'c1', vote_id: 'v-sentinel', position: 'yea', legislator_id: 'L1' },
      { id: 'c2', vote_id: 'v-sentinel', position: 'yea', legislator_id: 'L2' },
      { id: 'c3', vote_id: 'v-sentinel', position: 'nay', legislator_id: 'L3' },
      // SAME legislators voting the SAME way — the corroborating signal a genuine duplicate (two
      // sources describing the SAME real event) actually has.
      { id: 'c4', vote_id: 'v-primary', position: 'yea', legislator_id: 'L1' },
      { id: 'c5', vote_id: 'v-primary', position: 'yea', legislator_id: 'L2' },
      { id: 'c6', vote_id: 'v-primary', position: 'nay', legislator_id: 'L3' },
    ],
  });

  const report = await runCorrectMo1969Dates(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.seen, 1);
  assert.equal(report.deletedAsDuplicate, 1);
  assert.equal(report.redatedFromSource, 0);
  assert.equal(report.unresolvableDate, 0);
  assert.deepEqual(report.failures, []);

  assert.equal(client.tables.votes.some((v) => v.id === 'v-sentinel'), false, 'sentinel row deleted');
  assert.equal(client.tables.votes.some((v) => v.id === 'v-primary'), true, 'primary row untouched');
  assert.equal(client.tables.vote_casts.some((c) => c.vote_id === 'v-sentinel'), false, 'sentinel casts deleted too');
  assert.equal(client.tables.vote_casts.filter((c) => c.vote_id === 'v-primary').length, 3, 'primary casts untouched');

  assert.equal(report.matches.length, 1, 'the delete decision is recorded in the human-review surface');
  assert.deepEqual(report.matches[0], {
    sentinelVoteId: 'v-sentinel',
    matchedPrimaryVoteId: 'v-primary',
    billId: 'bill-1',
    chamber: 'senate',
    sentinelTally: { yea: 2, nay: 1 },
    primaryTally: { yea: 2, nay: 1 },
    signal: 'exact_legislator_id_set_match',
  });
});

// REVIEW FIX (false-positive proven by execution): two DIFFERENT real senate roll calls on the
// SAME bill/chamber that coincidentally share a yea/nay TALLY (2 yea / 1 nay here — the reviewer's
// own construction used 20/5, the bug class is identical at any scale) but are cast by DIFFERENT
// legislators. The original tally-only check accepted this as a confident single-candidate match
// and deleted the sentinel row even though the "duplicate" was a genuinely different vote. The
// legislator-id-set signal must now correctly refuse this — 0 confident matches, falls through to
// the URL-derive path (given an unparseable URL here, so the outcome is unambiguously
// unresolvableDate, proving the row was NOT deleted).
test('runCorrectMo1969Dates: false-positive proof — a candidate that coincidentally shares the sentinel\'s yea/nay TALLY but NOT its actual casters is correctly rejected, never deleted', async () => {
  const client = makeFakeClient({
    votes: [
      {
        id: 'v-sentinel', bill_id: 'bill-fp', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/T1Day0109101-18.pdf',
      },
      {
        id: 'v-different-rollcall', bill_id: 'bill-fp', chamber: 'senate', vote_date: '2018-04-10', jurisdiction_id: 'mo-legislature', source_key: 'mo-senate-web-2018-y-vote1',
      },
    ],
    vote_casts: [
      { id: 'c1', vote_id: 'v-sentinel', position: 'yea', legislator_id: 'L1' },
      { id: 'c2', vote_id: 'v-sentinel', position: 'yea', legislator_id: 'L2' },
      { id: 'c3', vote_id: 'v-sentinel', position: 'nay', legislator_id: 'L3' },
      // same 2-1 tally, but a completely different set of legislators — a genuinely different vote
      { id: 'c4', vote_id: 'v-different-rollcall', position: 'yea', legislator_id: 'L4' },
      { id: 'c5', vote_id: 'v-different-rollcall', position: 'yea', legislator_id: 'L5' },
      { id: 'c6', vote_id: 'v-different-rollcall', position: 'nay', legislator_id: 'L6' },
    ],
  });

  const report = await runCorrectMo1969Dates(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.deletedAsDuplicate, 0, 'never deletes on a bare tally coincidence');
  assert.equal(report.unresolvableDate, 1, 'falls through — no confident duplicate, and this URL does not parse');
  assert.deepEqual(report.matches, [], 'nothing was accepted as a duplicate, so nothing is recorded as one');
  assert.equal(client.tables.votes.some((v) => v.id === 'v-sentinel'), true, 'the sentinel row is UNTOUCHED — the wrong-vote deletion the review caught is fixed');
  assert.equal(client.tables.votes.some((v) => v.id === 'v-different-rollcall'), true, 'the genuinely different roll call is also untouched');
});

test('runCorrectMo1969Dates: a sentinel row with NO duplicate but a parseable primary source_url -> re-dated to the parsed date, never deleted', async () => {
  const client = makeFakeClient({
    votes: [
      {
        id: 'v-sentinel', bill_id: 'bill-2', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf#470',
      },
    ],
    vote_casts: [{ id: 'c1', vote_id: 'v-sentinel', position: 'yea', legislator_id: 'L1' }],
  });

  const report = await runCorrectMo1969Dates(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.seen, 1);
  assert.equal(report.deletedAsDuplicate, 0);
  assert.equal(report.redatedFromSource, 1);
  assert.equal(report.unresolvableDate, 0);
  assert.deepEqual(report.matches, []);
  assert.deepEqual(report.failures, []);

  const row = client.tables.votes.find((v) => v.id === 'v-sentinel');
  assert.ok(row, 'row still exists — re-dated, not deleted');
  assert.equal(row.vote_date, '2018-03-01');
  assert.equal(row.run_id, 'run-1');
});

test('runCorrectMo1969Dates: a sentinel row whose url won\'t parse AND has no duplicate -> unresolvableDate, untouched (a wrong date is worse than a sentinel we already flag)', async () => {
  const client = makeFakeClient({
    votes: [
      {
        id: 'v-sentinel', bill_id: 'bill-3', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/T1Day0109101-18.pdf',
      },
    ],
    vote_casts: [{ id: 'c1', vote_id: 'v-sentinel', position: 'yea', legislator_id: 'L1' }],
  });

  const report = await runCorrectMo1969Dates(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.seen, 1);
  assert.equal(report.deletedAsDuplicate, 0);
  assert.equal(report.redatedFromSource, 0);
  assert.equal(report.unresolvableDate, 1);
  assert.deepEqual(report.matches, []);
  assert.deepEqual(report.failures, []);

  const row = client.tables.votes.find((v) => v.id === 'v-sentinel');
  assert.ok(row, 'row untouched — still exists');
  assert.equal(row.vote_date, SENTINEL, 'never overwritten with a guess');
});

test('runCorrectMo1969Dates: ambiguous duplicate match (0 or >1 candidates whose caster sets EXACTLY match the sentinel) falls through to the URL-parse path rather than deleting speculatively', async () => {
  const client = makeFakeClient({
    votes: [
      {
        id: 'v-sentinel', bill_id: 'bill-4', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf#470',
      },
      {
        id: 'v-primary-a', bill_id: 'bill-4', chamber: 'senate', vote_date: '2018-02-01', jurisdiction_id: 'mo-legislature', source_key: 'mo-senate-web-2018-a-vote1',
      },
      {
        id: 'v-primary-b', bill_id: 'bill-4', chamber: 'senate', vote_date: '2018-02-05', jurisdiction_id: 'mo-legislature', source_key: 'mo-senate-web-2018-b-vote1',
      },
    ],
    vote_casts: [
      { id: 'c1', vote_id: 'v-sentinel', position: 'yea', legislator_id: 'L1' },
      { id: 'c2', vote_id: 'v-sentinel', position: 'nay', legislator_id: 'L2' },
      // both primary candidates coincidentally have the EXACT SAME caster-id sets as the sentinel
      // (contrived to prove the ambiguity path specifically, not the tally-only false positive —
      // see the false-positive proof test above for that) — genuinely ambiguous, never guessed
      // which one it corresponds to.
      { id: 'c3', vote_id: 'v-primary-a', position: 'yea', legislator_id: 'L1' },
      { id: 'c4', vote_id: 'v-primary-a', position: 'nay', legislator_id: 'L2' },
      { id: 'c5', vote_id: 'v-primary-b', position: 'yea', legislator_id: 'L1' },
      { id: 'c6', vote_id: 'v-primary-b', position: 'nay', legislator_id: 'L2' },
    ],
  });

  const report = await runCorrectMo1969Dates(client, { dryRun: false, runId: 'run-1' });
  assert.equal(report.deletedAsDuplicate, 0);
  assert.equal(report.redatedFromSource, 1, 'falls through to the URL-derive path instead');
  assert.deepEqual(report.matches, []);
  assert.equal(client.tables.votes.length, 3, 'nothing deleted');
});

test('runCorrectMo1969Dates: a NON-sentinel vote (a real dated MO senate row) is never touched — the scope query only ever selects vote_date = the sentinel', async () => {
  const client = makeFakeClient({
    votes: [
      {
        id: 'v-real', bill_id: 'bill-5', chamber: 'senate', vote_date: '2018-05-01', jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/RDay410315703-725.pdf',
      },
    ],
    vote_casts: [],
  });

  const report = await runCorrectMo1969Dates(client, { dryRun: false, runId: 'run-1' });
  assert.equal(report.seen, 0);
  assert.equal(report.deletedAsDuplicate, 0);
  assert.equal(report.redatedFromSource, 0);
  assert.equal(report.unresolvableDate, 0);
  assert.equal(client.tables.votes.find((v) => v.id === 'v-real').vote_date, '2018-05-01', 'byte-for-byte untouched');

  const initialSelect = client.calls.find((c) => c.table === 'votes' && c.mode === 'select');
  assert.ok(initialSelect.filters.some((f) => f.op === 'eq' && f.col === 'vote_date' && f.val === SENTINEL), 'scope query itself is guarded on the sentinel value');
});

test('runCorrectMo1969Dates: --dry-run performs ZERO writes/deletes for either path, but still reports the honest counts a live run would produce', async () => {
  const client = makeFakeClient({
    votes: [
      {
        id: 'v-dup', bill_id: 'bill-1', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf#470',
      },
      {
        id: 'v-dup-primary', bill_id: 'bill-1', chamber: 'senate', vote_date: '2018-03-01', jurisdiction_id: 'mo-legislature', source_key: 'mo-senate-web-2018-x-vote1',
      },
      {
        id: 'v-redate', bill_id: 'bill-2', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf#470',
      },
      {
        id: 'v-unresolvable', bill_id: 'bill-3', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/T1Day0109101-18.pdf',
      },
    ],
    vote_casts: [
      { id: 'c1', vote_id: 'v-dup', position: 'yea', legislator_id: 'L1' },
      { id: 'c2', vote_id: 'v-dup-primary', position: 'yea', legislator_id: 'L1' },
    ],
  });
  const before = JSON.stringify([client.tables.votes, client.tables.vote_casts]);

  const report = await runCorrectMo1969Dates(client, { dryRun: true });

  assert.equal(report.seen, 3);
  assert.equal(report.deletedAsDuplicate, 1);
  assert.equal(report.redatedFromSource, 1);
  assert.equal(report.unresolvableDate, 1);
  assert.equal(JSON.stringify([client.tables.votes, client.tables.vote_casts]), before, 'zero writes — both tables byte-for-byte unchanged');
  assert.equal(client.calls.some((c) => c.mode === 'delete'), false);
  assert.equal(client.calls.some((c) => c.mode === 'update'), false);

  // review requirement 2: the human-review surface is populated in DRY-RUN too, not just live —
  // Lance should be able to eyeball every delete decision BEFORE authorizing the live pass.
  assert.equal(report.matches.length, 1, 'exactly the one duplicate decision, not the redate/unresolvable rows');
  assert.deepEqual(report.matches[0], {
    sentinelVoteId: 'v-dup',
    matchedPrimaryVoteId: 'v-dup-primary',
    billId: 'bill-1',
    chamber: 'senate',
    sentinelTally: { yea: 1, nay: 0 },
    primaryTally: { yea: 1, nay: 0 },
    signal: 'exact_legislator_id_set_match',
  });
});

// ---- runCorrectData (top-level dispatcher) ----

test('runCorrectData: "mo-status" runs only the status correction; "mo-1969-dates" runs only the date correction; "all" runs both', async () => {
  const seed = {
    bills: [billRow('b1', '1')],
    votes: [{
      id: 'v1', bill_id: 'bill-x', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf#470',
    }],
    vote_casts: [],
  };

  const statusOnly = await runCorrectData(makeFakeClient(seed), { which: 'mo-status', dryRun: true });
  assert.ok(statusOnly.moStatus);
  assert.equal(statusOnly.mo1969Dates, undefined);

  const datesOnly = await runCorrectData(makeFakeClient(seed), { which: 'mo-1969-dates', dryRun: true });
  assert.equal(datesOnly.moStatus, undefined);
  assert.ok(datesOnly.mo1969Dates);

  const both = await runCorrectData(makeFakeClient(seed), { which: 'all', dryRun: true });
  assert.ok(both.moStatus);
  assert.ok(both.mo1969Dates);
  assert.equal(both.failures.length, 0);
  assert.equal(both.mode, 'dry-run');
});

// ============================================================================================
// mo-2026-session-merge (TODO 25 / .superpowers/sdd/2026-08-01-mo-2026-session-merge/brief.md) —
// Phase A (bill/session merge) + Phase B (vote reconciliation, additive-only, NO deletes).
// ============================================================================================

test('parseArgs: accepts mo-2026-session-merge as a fourth <which> value', () => {
  assert.equal(parseArgs(['mo-2026-session-merge']).which, 'mo-2026-session-merge');
  assert.equal(parseArgs(['mo-2026-session-merge', '--dry-run']).dryRun, true);
});

test('CANONICAL_MO_2026_SESSION_IDENTIFIER / DUPLICATE_MO_2026_SESSION_IDENTIFIER / DUP_BILL_MUST_BE_EMPTY_TABLES: pinned to the brief\'s verified values', () => {
  assert.equal(CANONICAL_MO_2026_SESSION_IDENTIFIER, '261');
  assert.equal(DUPLICATE_MO_2026_SESSION_IDENTIFIER, '2026');
  assert.ok(DUP_BILL_MUST_BE_EMPTY_TABLES.includes('bill_texts'));
  assert.ok(DUP_BILL_MUST_BE_EMPTY_TABLES.includes('bill_sponsors'));
  assert.ok(DUP_BILL_MUST_BE_EMPTY_TABLES.includes('summaries'));
});

test('correct-data.js source: never IMPORTS or CALLS crossCheckAgainstPrimarySource or retractLegiscanVoteIfStored — the two sanctioned-elsewhere functions the brief forbids this file from invoking (a bare mention in an explanatory comment, documenting WHY they are never called, is fine)', () => {
  const src = readFileSync(new URL('../src/cli/correct-data.js', import.meta.url), 'utf8');
  assert.equal(/\bcrossCheckAgainstPrimarySource\(/.test(src), false, 'must never CALL the live pre-store gate against already-published data');
  assert.equal(/import\s*\{[^}]*\bcrossCheckAgainstPrimarySource\b/.test(src), false, 'must never IMPORT it either');
  assert.equal(/\bretractLegiscanVoteIfStored\(/.test(src), false, 'must never CALL this repo\'s one sanctioned delete — Phase B never deletes anything');
  assert.equal(/import\s*\{[^}]*\bretractLegiscanVoteIfStored\b/.test(src), false, 'must never IMPORT it either');
});

function sessionRow(id, identifier, legiscanSessionId = null) {
  return {
    id, jurisdiction_id: 'mo-legislature', identifier, legiscan_session_id: legiscanSessionId,
  };
}
function moBillRow(id, sessionId, identifier) {
  return { id, session_id: sessionId, identifier };
}
function moVoteRow(overrides) {
  return {
    jurisdiction_id: 'mo-legislature', chamber: 'senate', result: null, ...overrides,
  };
}
function castRow(id, voteId, position, legislatorId) {
  return {
    id, vote_id: voteId, position, legislator_id: legislatorId,
  };
}

const CANON = sessionRow('sess-261', '261', 2239);
const DUP = sessionRow('sess-2026', '2026', null);

// ---- runMergeMo2026Session (Phase A) ----

test('runMergeMo2026Session: happy path — exact-identifier twin found, zero related tables, votes redirected, duplicate bill deleted, session deleted once empty', async () => {
  const client = makeFakeClient({
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
    ],
    votes: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
    })],
    vote_casts: [],
  });

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.canonicalSessionFound, true);
  assert.equal(report.dupSessionFound, true);
  assert.equal(report.dupBillsTotal, 1);
  assert.equal(report.dupBillsSeen, 1);
  assert.equal(report.billsMerged, 1);
  assert.equal(report.votesRedirected, 1);
  assert.equal(report.stopped.length, 0);
  assert.equal(report.failures.length, 0);
  assert.equal(report.sessionDeletionEligible, true);
  assert.equal(report.sessionDeleted, true);

  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), false, 'duplicate bill deleted');
  assert.equal(client.tables.bills.some((b) => b.id === 'bill-canon-1'), true, 'canonical bill untouched');
  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), false, 'duplicate session deleted');
  assert.equal(client.tables.votes.find((v) => v.id === 'vote-dup-1').bill_id, 'bill-canon-1', 'vote redirected to the canonical bill');

  assert.equal(report.merges.length, 1);
  assert.equal(report.merges[0].canonicalBillId, 'bill-canon-1');
  assert.equal(report.merges[0].billDeleted, true);
});

test('runMergeMo2026Session: no canonical twin for a duplicate identifier — STOPS and reports, never invents a merge target, bill/session untouched', async () => {
  const client = makeFakeClient({
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
      moBillRow('bill-dup-orphan', 'sess-2026', 'SB 99'), // no SB 99 under the canonical session
    ],
    votes: [],
  });

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.billsMerged, 0);
  assert.equal(report.stopped.length, 1);
  assert.equal(report.stopped[0].reason, 'no_canonical_twin');
  assert.equal(report.stopped[0].billId, 'bill-dup-orphan');
  assert.equal(report.sessionDeletionEligible, false, 'a stopped bill blocks session-delete eligibility');
  assert.equal(report.sessionDeleted, false);
  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-orphan'), true, 'never deleted — no twin to redirect its votes to');
  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true, 'session not deleted — still owns a bill');
});

test('runMergeMo2026Session: a duplicate bill with a non-zero related table (bill_texts here) STOPS and reports, never silently redirects', async () => {
  const client = makeFakeClient({
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
    ],
    bill_texts: [{
      id: 'bt-1', bill_id: 'bill-dup-1', version: 'introduced',
    }],
    votes: [],
  });

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.billsMerged, 0);
  assert.equal(report.stopped.length, 1);
  assert.equal(report.stopped[0].reason, 'non_zero_related_tables');
  assert.deepEqual(report.stopped[0].nonZeroTables, [{ table: 'bill_texts', count: 1 }]);
  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — a table this brief didn\'t anticipate redirecting is non-zero');
});

test('runMergeMo2026Session: --dry-run performs ZERO writes but reports the same honest counts a live run would produce', async () => {
  const client = makeFakeClient({
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
    ],
    votes: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
    })],
  });
  const before = JSON.stringify([client.tables.bills, client.tables.votes, client.tables.sessions]);

  const report = await runMergeMo2026Session(client, { dryRun: true });

  assert.equal(report.billsMerged, 1);
  assert.equal(report.votesRedirected, 1);
  assert.equal(report.sessionDeletionEligible, true);
  assert.equal(report.sessionDeleted, false, 'dry-run never actually deletes the session, even when eligible');
  assert.equal(JSON.stringify([client.tables.bills, client.tables.votes, client.tables.sessions]), before, 'zero writes — every table byte-for-byte unchanged');
  assert.equal(client.calls.some((c) => c.mode === 'update' || c.mode === 'delete'), false);
});

test('runMergeMo2026Session: --limit caps how many duplicate bills are processed; a partial pass never deletes the still-non-empty session', async () => {
  const client = makeFakeClient({
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
      moBillRow('bill-canon-2', 'sess-261', 'SB 2'),
      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
      moBillRow('bill-dup-2', 'sess-2026', 'SB 2'),
    ],
    votes: [],
  });

  const report = await runMergeMo2026Session(client, { dryRun: false, limit: 1, runId: 'run-1' });

  assert.equal(report.dupBillsTotal, 2);
  assert.equal(report.dupBillsSeen, 1);
  assert.equal(report.billsMerged, 1);
  assert.equal(report.sessionDeletionEligible, false, 'the limit left a bill unprocessed');
  assert.equal(report.sessionDeleted, false);
  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true, 'session still owns bill-dup-2 — the guard refuses');
});

test('runMergeMo2026Session: no duplicate session present -> nothing to do, clean empty report, never an error', async () => {
  const client = makeFakeClient({
    sessions: [CANON],
    bills: [moBillRow('bill-canon-1', 'sess-261', 'SB 1')],
  });

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.dupSessionFound, false);
  assert.equal(report.billsMerged, 0);
  assert.equal(report.sessionDeleted, false);
  assert.deepEqual(report.failures, []);
});

// ---- runReconcileMo2026Votes (Phase B) ----

test('runReconcileMo2026Votes: exactly one same-day LegiScan candidate with matching tallies -> clean match, writes NOTHING', async () => {
  const client = makeFakeClient({
    votes: [
      moVoteRow({
        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
      }),
    ],
    vote_casts: [
      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
      castRow('c2', 'vote-dup-1', 'yea', 'L2'),
      castRow('c3', 'vote-dup-1', 'nay', 'L3'),
      castRow('c4', 'vote-ls-1', 'yea', 'L1'),
      castRow('c5', 'vote-ls-1', 'yea', 'L2'),
      castRow('c6', 'vote-ls-1', 'nay', 'L3'),
    ],
  });
  const mergedBills = [{
    billId: 'bill-dup-1',
    canonicalBillId: 'bill-canon-1',
    voteRows: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
    })],
  }];

  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });

  assert.equal(report.votesChecked, 1);
  assert.equal(report.cleanMatches, 1);
  assert.equal(report.flaggedCount, 0);
  assert.equal(client.tables.vote_reconciliation_flags.length, 0, 'a clean match writes nothing to the DB');
});

test('runReconcileMo2026Votes: a HARD (yea/nay) mismatch writes a vote_reconciliation_flags row keyed on the mo-senate-web vote\'s own id, reason hard_mismatch', async () => {
  const client = makeFakeClient({
    votes: [
      moVoteRow({
        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
      }),
    ],
    vote_casts: [
      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
      castRow('c2', 'vote-dup-1', 'yea', 'L2'),
      castRow('c3', 'vote-dup-1', 'nay', 'L3'),
      // legiscan side: all three yea — a real hard yea/nay divergence
      castRow('c4', 'vote-ls-1', 'yea', 'L1'),
      castRow('c5', 'vote-ls-1', 'yea', 'L2'),
      castRow('c6', 'vote-ls-1', 'yea', 'L3'),
    ],
  });
  const mergedBills = [{
    billId: 'bill-dup-1',
    canonicalBillId: 'bill-canon-1',
    voteRows: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
    })],
  }];

  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });

  assert.equal(report.cleanMatches, 0);
  assert.equal(report.flaggedCount, 1);
  assert.equal(client.tables.vote_reconciliation_flags.length, 1);
  const flag = client.tables.vote_reconciliation_flags[0];
  assert.equal(flag.vote_id, 'vote-dup-1', 'vote_id points at the PRIMARY-source (mo-senate-web) row, matching the live system\'s own convention');
  assert.equal(flag.source_a, 'legiscan');
  assert.equal(flag.source_b, 'mo-senate-web');
  assert.equal(flag.discrepancy.reason, 'hard_mismatch');
  assert.ok(flag.discrepancy.hard_mismatches.length > 0);
  assert.deepEqual(flag.discrepancy.source_b_tallies.yea !== undefined, true);
  assert.equal(flag.discrepancy.source_b_vote_id, 'vote-dup-1');
  assert.equal(flag.discrepancy.source_b_source_key, 'mo-senate-web-2026-x-vote1');
});

test('runReconcileMo2026Votes: a SOFT-only mismatch (yea/nay agree, non-yea/non-nay bucket differs) writes reason soft_mismatch with the PRESENT_CATEGORY_CAVEAT attached', async () => {
  const client = makeFakeClient({
    votes: [
      moVoteRow({
        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
      }),
    ],
    vote_casts: [
      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
      castRow('c2', 'vote-dup-1', 'yea', 'L2'),
      castRow('c3', 'vote-dup-1', 'nay', 'L3'),
      castRow('c4', 'vote-dup-1', 'present', 'L4'), // primary-only category, no LegiScan analog
      castRow('c5', 'vote-ls-1', 'yea', 'L1'),
      castRow('c6', 'vote-ls-1', 'yea', 'L2'),
      castRow('c7', 'vote-ls-1', 'nay', 'L3'),
    ],
  });
  const mergedBills = [{
    billId: 'bill-dup-1',
    canonicalBillId: 'bill-canon-1',
    voteRows: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
    })],
  }];

  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });

  assert.equal(report.flaggedCount, 1);
  const flag = client.tables.vote_reconciliation_flags[0];
  assert.equal(flag.discrepancy.reason, 'soft_mismatch');
  assert.equal(flag.discrepancy.hard_mismatches.length, 0);
  assert.ok(flag.discrepancy.soft_mismatches.length > 0);
  assert.ok(flag.discrepancy.caveat, 'the Present-category caveat is attached whenever a soft mismatch is present');
});

test('runReconcileMo2026Votes: zero LegiScan candidates -> honest no-match report, no flag written', async () => {
  const client = makeFakeClient({ votes: [], vote_casts: [] });
  const mergedBills = [{
    billId: 'bill-dup-1',
    canonicalBillId: 'bill-canon-1',
    voteRows: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
    })],
  }];

  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });

  assert.equal(report.noMatchCount, 1);
  assert.equal(report.flaggedCount, 0);
  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
});

test('runReconcileMo2026Votes: more than one same-day LegiScan candidate -> reported ambiguous, never guessed, no flag written', async () => {
  const client = makeFakeClient({
    votes: [
      moVoteRow({
        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
      }),
      moVoteRow({
        id: 'vote-ls-2', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641860',
      }),
    ],
    vote_casts: [],
  });
  const mergedBills = [{
    billId: 'bill-dup-1',
    canonicalBillId: 'bill-canon-1',
    voteRows: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
    })],
  }];

  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });

  assert.equal(report.ambiguousCount, 1);
  assert.equal(report.flaggedCount, 0);
  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
});

test('runReconcileMo2026Votes: --dry-run performs ZERO writes even on a mismatch, reports wouldWrite honestly', async () => {
  const client = makeFakeClient({
    votes: [
      moVoteRow({
        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
      }),
    ],
    vote_casts: [
      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
      castRow('c4', 'vote-ls-1', 'yea', 'L1'),
      castRow('c5', 'vote-ls-1', 'nay', 'L2'), // hard mismatch: primary has no nay caster at all
    ],
  });
  const mergedBills = [{
    billId: 'bill-dup-1',
    canonicalBillId: 'bill-canon-1',
    voteRows: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
    })],
  }];

  const report = await runReconcileMo2026Votes(client, { dryRun: true, mergedBills });

  assert.equal(report.flaggedCount, 1);
  assert.equal(report.flagged[0].wouldWrite, true);
  assert.equal(client.tables.vote_reconciliation_flags.length, 0, 'dry-run never writes a flag row');
});

// ---- runCorrectMo2026SessionMerge (combined) + runCorrectData dispatcher wiring ----

test('runCorrectMo2026SessionMerge: runs Phase A then Phase B against the bills Phase A actually merged, combining failures', async () => {
  const client = makeFakeClient({
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
    ],
    votes: [
      moVoteRow({
        id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
      }),
      moVoteRow({
        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
      }),
    ],
    vote_casts: [
      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
      castRow('c2', 'vote-ls-1', 'yea', 'L1'),
    ],
  });

  const report = await runCorrectMo2026SessionMerge(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.merge.billsMerged, 1);
  assert.equal(report.merge.sessionDeleted, true);
  assert.equal(report.reconciliation.votesChecked, 1);
  assert.equal(report.reconciliation.cleanMatches, 1);
  assert.deepEqual(report.failures, []);
});

test('runCorrectData: "mo-2026-session-merge" runs only when explicitly named — "all" never sweeps it in, given its higher stakes (deletes + FK redirects)', async () => {
  const seed = {
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
    ],
    votes: [],
  };

  const explicit = await runCorrectData(makeFakeClient(seed), { which: 'mo-2026-session-merge', dryRun: true });
  assert.ok(explicit.mo2026SessionMerge);

  const all = await runCorrectData(makeFakeClient(seed), { which: 'all', dryRun: true });
  assert.equal(all.mo2026SessionMerge, undefined, '"all" must never run the session-merge correction implicitly');
  assert.equal(all.moStatus !== undefined && all.mo1969Dates !== undefined, true, 'the other two corrections are unaffected');
});

// ============================================================================================
// Review fix round (task-review.md, 2026-08-01 — SHIP verdict, two Important findings closed
// before the operator briefing): Important 2 (Phase B isolation + standalone re-run) and
// Important 3 (the delete-ordering safety chain was previously untested). Important 4 (the
// isPrimaryCastDataComparable gate) folded in too — see correct-data.js's own header comment for
// the two smaller items left as documented residuals.
// ============================================================================================

// ---- Important 3: the delete-ordering chain, proven by test, not just read ----

test('runMergeMo2026Session: the vote redirect UPDATE and its live re-count both complete BEFORE the bill DELETE fires — order-sensitive proof, not just an end-state assertion', async () => {
  const client = makeFakeClient({
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
    ],
    votes: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
    })],
  });

  await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  const votesUpdateIdx = client.calls.findIndex((c) => c.table === 'votes' && c.mode === 'update' && c.patch?.bill_id === 'bill-canon-1');
  const votesRecountIdx = client.calls.findIndex((c, i) => (
    i > votesUpdateIdx && c.table === 'votes' && c.mode === 'select' && c.selectOpts.head
    && c.filters.some((f) => f.op === 'eq' && f.col === 'bill_id' && f.val === 'bill-dup-1')
  ));
  const billDeleteIdx = client.calls.findIndex((c) => c.table === 'bills' && c.mode === 'delete');

  assert.notEqual(votesUpdateIdx, -1, 'the redirect update call happened');
  assert.notEqual(votesRecountIdx, -1, 'a live re-count select happened after the update');
  assert.notEqual(billDeleteIdx, -1, 'the bill delete happened');
  assert.ok(votesUpdateIdx < votesRecountIdx, 'redirect fires before the re-count');
  assert.ok(votesRecountIdx < billDeleteIdx, 're-count fires before the delete — the delete never races ahead of its own guard');
});

test('runMergeMo2026Session: a race that inserts a NEW vote onto the duplicate bill between the redirect and the delete is caught by the LIVE re-count (not trusted from the update\'s own result) — bill reported vote_redirect_incomplete, never deleted', async () => {
  const client = makeFakeClient(
    {
      sessions: [CANON, DUP],
      bills: [
        moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
        moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
      ],
      votes: [moVoteRow({
        id: 'vote-dup-1', bill_id: 'bill-dup-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
      })],
    },
    {
      afterExecute(callInfo, tables) {
        // Right after the redirect UPDATE for bill-dup-1 executes (its own result already computed),
        // a "concurrent writer" lands a brand-new vote row still pointing at the duplicate bill —
        // the exact TOCTOU window task-review.md Q2(b) names. The re-count immediately after MUST
        // see this, proving it is a fresh live query, not the update's own stale count.
        if (callInfo.table === 'votes' && callInfo.mode === 'update' && callInfo.patch?.bill_id === 'bill-canon-1') {
          tables.votes.push({
            id: 'vote-raced-in', bill_id: 'bill-dup-1', chamber: 'senate', vote_date: '2026-02-24T00:00:00+00:00', jurisdiction_id: 'mo-legislature', source_key: 'mo-senate-web-2026-race-vote1', result: null,
          });
        }
      },
    },
  );

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.billsMerged, 0);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].reason, 'vote_redirect_incomplete');
  assert.equal(report.failures[0].remaining, 1);
  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — the live re-count refused it');
  assert.equal(client.calls.some((c) => c.table === 'bills' && c.mode === 'delete'), false, 'delete never even attempted');
});

test('runMergeMo2026Session: a forced failure on the vote redirect UPDATE for one bill reports that bill failed and NEVER deletes it, while a sibling bill in the same batch still merges cleanly (per-bill isolation on the redirect step specifically)', async () => {
  const client = makeFakeClient(
    {
      sessions: [CANON, DUP],
      bills: [
        moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
        moBillRow('bill-canon-2', 'sess-261', 'SB 2'),
        moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
        moBillRow('bill-dup-2', 'sess-2026', 'SB 2'),
      ],
      votes: [],
    },
    {
      forceError: (table, mode, filters) => (
        table === 'votes' && mode === 'update' && filters.some((f) => f.op === 'eq' && f.col === 'bill_id' && f.val === 'bill-dup-1')
          ? { message: 'connection reset' }
          : null
      ),
    },
  );

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.billsMerged, 1, 'bill-dup-2 still merges despite bill-dup-1\'s redirect failure');
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].billId, 'bill-dup-1');
  assert.equal(report.failures[0].reason, 'vote_redirect_failed');
  assert.match(report.failures[0].error, /connection reset/);

  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — the redirect it depends on failed');
  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-2'), false, 'the sibling bill was deleted normally — one bill\'s failure does not corrupt the batch');
  assert.equal(report.sessionDeleted, false, 'session still owns bill-dup-1');
});

test('runMergeMo2026Session: a bill vanishing (raced away) between the live re-count and the delete itself is caught by the delete\'s own RETURNING-row guard, never silently treated as success', async () => {
  const client = makeFakeClient(
    {
      sessions: [CANON, DUP],
      bills: [
        moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
        moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
      ],
      votes: [],
    },
    {
      afterExecute(callInfo, tables) {
        // Simulates a concurrent process deleting bill-dup-1 itself in the window between the
        // redirect re-count (which found 0 remaining votes, correctly) and this run's own delete.
        if (callInfo.table === 'votes' && callInfo.mode === 'select' && callInfo.selectOpts.head
          && callInfo.filters.some((f) => f.op === 'eq' && f.col === 'bill_id' && f.val === 'bill-dup-1')) {
          tables.bills = tables.bills.filter((b) => b.id !== 'bill-dup-1');
        }
      },
    },
  );

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.billsMerged, 0);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].reason, 'bill_delete_guard_mismatch');
  assert.equal(report.failures[0].got, 0);
});

test('runMergeMo2026Session: two canonical rows sharing one identifier (defensive — the DB\'s own unique constraint should prevent this in production) is reported multiple_canonical_twins, never guessed at', async () => {
  const client = makeFakeClient({
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1a', 'sess-261', 'SB 1'),
      moBillRow('bill-canon-1b', 'sess-261', 'SB 1'),
      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
    ],
    votes: [],
  });

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.stopped.length, 1);
  assert.equal(report.stopped[0].reason, 'multiple_canonical_twins');
  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — ambiguous, never guessed');
});

test('runMergeMo2026Session: a failed live re-count of the duplicate session\'s remaining bills is an honest failure, never silently treated as "safe to delete"', async () => {
  const client = makeFakeClient(
    {
      sessions: [CANON, DUP],
      bills: [moBillRow('bill-canon-1', 'sess-261', 'SB 1'), moBillRow('bill-dup-1', 'sess-2026', 'SB 1')],
      votes: [],
    },
    {
      // head:true disambiguates the FINAL recount (a count-only select) from the initial selectAll
      // load of duplicate bills earlier in the same run, which shares the same table/filter shape
      // but is a plain multi-row select, not a head-count.
      forceError: (table, mode, filters, selectOpts) => (
        table === 'bills' && mode === 'select' && selectOpts?.head
        && filters.some((f) => f.op === 'eq' && f.col === 'session_id' && f.val === 'sess-2026')
          ? { message: 'timeout' }
          : null
      ),
    },
  );

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.billsMerged, 1, 'the bill itself still merged');
  assert.equal(report.sessionDeleted, false);
  assert.ok(report.failures.some((f) => f.reason === 'session_bill_recount_failed'));
  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true, 'never deleted on an unconfirmed recount');
});

test('runMergeMo2026Session: a failed session DELETE (after a genuinely zero recount) is an honest failure, session row untouched', async () => {
  const client = makeFakeClient(
    {
      sessions: [CANON, DUP],
      bills: [moBillRow('bill-canon-1', 'sess-261', 'SB 1'), moBillRow('bill-dup-1', 'sess-2026', 'SB 1')],
      votes: [],
    },
    {
      forceError: (table, mode) => (table === 'sessions' && mode === 'delete' ? { message: 'lock timeout' } : null),
    },
  );

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.billsMerged, 1);
  assert.equal(report.sessionDeleted, false);
  assert.ok(report.failures.some((f) => f.reason === 'session_delete_failed'));
  assert.equal(client.tables.sessions.some((s) => s.id === 'sess-2026'), true);
});

test('DUP_BILL_MUST_BE_EMPTY_TABLES: all four entries are actually enforced, including bill_actions (the one the brief\'s own prose does not name) — not just bill_texts/bill_sponsors/summaries', async () => {
  assert.deepEqual(DUP_BILL_MUST_BE_EMPTY_TABLES, ['bill_texts', 'bill_sponsors', 'summaries', 'bill_actions']);

  const client = makeFakeClient({
    sessions: [CANON, DUP],
    bills: [
      moBillRow('bill-canon-1', 'sess-261', 'SB 1'),
      moBillRow('bill-dup-1', 'sess-2026', 'SB 1'),
    ],
    bill_actions: [{
      id: 'ba-1', bill_id: 'bill-dup-1', action_date: '2026-01-01', description: 'x',
    }],
    votes: [],
  });

  const report = await runMergeMo2026Session(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.stopped.length, 1);
  assert.equal(report.stopped[0].reason, 'non_zero_related_tables');
  assert.deepEqual(report.stopped[0].nonZeroTables, [{ table: 'bill_actions', count: 1 }]);
  assert.equal(client.tables.bills.some((b) => b.id === 'bill-dup-1'), true, 'never deleted — bill_actions alone is enough to stop it');
});

// ---- Important 2: Phase B per-vote flag-write isolation + standalone re-run ----

test('runReconcileMo2026Votes: an unexpected writeReconciliationFlag failure for ONE vote is isolated — recorded in failures, does not lose the remaining votes\' flags; a clean re-run afterward completes the missing flag WITHOUT duplicating the ones that already wrote', async () => {
  let allowVote2Failure = true;
  const client = makeFakeClient(
    {
      votes: [
        moVoteRow({
          id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
        }),
        moVoteRow({
          id: 'vote-ls-2', bill_id: 'bill-canon-2', vote_date: '2026-02-24T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641900',
        }),
        moVoteRow({
          id: 'vote-ls-3', bill_id: 'bill-canon-3', vote_date: '2026-02-25T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1642000',
        }),
      ],
      vote_casts: [
        // each pair is a deliberate hard mismatch (legiscan has an extra yea caster) so every vote
        // reaches the flag-write step.
        castRow('c1', 'vote-dup-1', 'yea', 'L1'),
        castRow('c2', 'vote-ls-1', 'yea', 'L1'),
        castRow('c3', 'vote-ls-1', 'yea', 'L2'),
        castRow('c4', 'vote-dup-2', 'yea', 'L1'),
        castRow('c5', 'vote-ls-2', 'yea', 'L1'),
        castRow('c6', 'vote-ls-2', 'yea', 'L2'),
        castRow('c7', 'vote-dup-3', 'yea', 'L1'),
        castRow('c8', 'vote-ls-3', 'yea', 'L1'),
        castRow('c9', 'vote-ls-3', 'yea', 'L2'),
      ],
    },
    {
      forceError: (table, mode, filters, row) => (
        table === 'vote_reconciliation_flags' && mode === 'insert' && row?.vote_id === 'vote-dup-2' && allowVote2Failure
          ? { message: 'connection reset mid-write' }
          : null
      ),
    },
  );
  const mergedBills = [{
    voteRows: [
      moVoteRow({
        id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
      }),
      moVoteRow({
        id: 'vote-dup-2', bill_id: 'bill-canon-2', vote_date: '2026-02-24T00:00:00+00:00', source_key: 'mo-senate-web-2026-y-vote1',
      }),
      moVoteRow({
        id: 'vote-dup-3', bill_id: 'bill-canon-3', vote_date: '2026-02-25T00:00:00+00:00', source_key: 'mo-senate-web-2026-z-vote1',
      }),
    ],
  }];

  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });

  assert.equal(report.flaggedCount, 2, 'votes 1 and 3 still got their flags written despite vote 2 failing mid-batch');
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].voteId, 'vote-dup-2');
  assert.equal(report.failures[0].reason, 'flag_write_failed');
  assert.match(report.failures[0].error, /connection reset mid-write/);
  assert.equal(client.tables.vote_reconciliation_flags.length, 2, 'votes 1 and 3 wrote; vote 2 did not');
  assert.equal(client.tables.vote_reconciliation_flags.some((f) => f.vote_id === 'vote-dup-1'), true);
  assert.equal(client.tables.vote_reconciliation_flags.some((f) => f.vote_id === 'vote-dup-3'), true);

  // A clean re-run (the transient error has cleared) must complete the missing flag for vote-dup-2
  // WITHOUT duplicating the two that already wrote — writeReconciliationFlag's own idempotency
  // dedupe (reused unmodified) must hold through this plumbing.
  allowVote2Failure = false;
  const rerun = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-2', mergedBills });
  assert.equal(rerun.flaggedCount, 3, 'all three report flagged on re-run (2 deduped, 1 newly written)');
  assert.equal(rerun.failures.length, 0);
  assert.equal(client.tables.vote_reconciliation_flags.length, 3, 'exactly 3 flag rows total — no duplicates for votes 1/3, the missing one for vote 2 now exists');
});

test('runReconcileMo2026VotesStandalone: re-runs the SAME reconciliation comparison directly against already-merged mo-senate-web-2026 votes, found by their own source_key — no Phase-A merge object needed (the concrete fix for "Phase B cannot be re-run once the duplicate session is gone")', async () => {
  const client = makeFakeClient({
    votes: [
      moVoteRow({
        id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1',
      }),
      // a DIFFERENT year's mo-senate-web vote — must NOT be swept in by the standalone query.
      moVoteRow({
        id: 'vote-other-year', bill_id: 'bill-canon-1', vote_date: '2018-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2018-x-vote1',
      }),
      moVoteRow({
        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
      }),
    ],
    vote_casts: [
      castRow('c1', 'vote-dup-1', 'yea', 'L1'),
      castRow('c2', 'vote-dup-1', 'nay', 'L2'),
      castRow('c3', 'vote-ls-1', 'yea', 'L1'),
      castRow('c4', 'vote-ls-1', 'nay', 'L2'),
    ],
  });

  const report = await runReconcileMo2026VotesStandalone(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.votesChecked, 1, 'only the 2026 mo-senate-web vote is picked up — the 2018 one is a different year, never swept in');
  assert.equal(report.cleanMatches, 1);
  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
});

test('runReconcileMo2026VotesStandalone: --dry-run performs zero writes; --limit caps how many votes are checked', async () => {
  const client = makeFakeClient({
    votes: [
      moVoteRow({
        id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-a-vote1',
      }),
      moVoteRow({
        id: 'vote-dup-2', bill_id: 'bill-canon-2', vote_date: '2026-02-24T00:00:00+00:00', source_key: 'mo-senate-web-2026-b-vote1',
      }),
    ],
    vote_casts: [],
  });

  const limited = await runReconcileMo2026VotesStandalone(client, { dryRun: true, limit: 1 });
  assert.equal(limited.votesChecked, 1);
  assert.equal(client.tables.vote_reconciliation_flags.length, 0, 'dry-run never writes, even against a real DB query path');
});

test('runCorrectData: "mo-2026-vote-reconcile" is a distinct, explicit <which> value — also excluded from "all"', async () => {
  const seed = {
    votes: [
      moVoteRow({
        id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-a-vote1',
      }),
    ],
    vote_casts: [],
  };
  const explicit = await runCorrectData(makeFakeClient(seed), { which: 'mo-2026-vote-reconcile', dryRun: true });
  assert.ok(explicit.mo2026VoteReconcile);

  const all = await runCorrectData(makeFakeClient(seed), { which: 'all', dryRun: true });
  assert.equal(all.mo2026VoteReconcile, undefined);
});

// ---- Important 4 (folded in): the isPrimaryCastDataComparable gate ----

test('reconcileOneVote (via runReconcileMo2026Votes): a primary (mo-senate-web) row whose casts have not landed yet is reported not_comparable, never mistaken for a real hard mismatch', async () => {
  const client = makeFakeClient({
    votes: [
      moVoteRow({
        id: 'vote-ls-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'legiscan-2239-rollcall-1641859',
      }),
    ],
    vote_casts: [
      // legiscan side fully cast; primary (mo-senate-web) side: ZERO casts landed yet.
      castRow('c1', 'vote-ls-1', 'yea', 'L1'),
      castRow('c2', 'vote-ls-1', 'nay', 'L2'),
    ],
  });
  const mergedBills = [{
    voteRows: [moVoteRow({
      id: 'vote-dup-1', bill_id: 'bill-canon-1', vote_date: '2026-02-23T00:00:00+00:00', source_key: 'mo-senate-web-2026-x-vote1', result: null,
    })],
  }];

  const report = await runReconcileMo2026Votes(client, { dryRun: false, runId: 'run-1', mergedBills });

  assert.equal(report.flaggedCount, 0, 'never hard-flags on incomplete primary cast data');
  assert.equal(report.notComparableCount, 1);
  assert.equal(client.tables.vote_reconciliation_flags.length, 0);
});

// ============================================================================================
// legiscan-source-split (TODO-33 — .superpowers/sdd/2026-08-02-todo-33-legiscan-source-split/
// brief.md, part 3): historical `ingestion_runs.source='legiscan'` rows that were actually written
// by ingest-legiscan-texts.js (before that CLI got its own distinct 'legiscan-texts' label) are
// relabeled. Classification rule, verified against ALL 54 real live rows at implementation time
// (48 votes-shape / 2 texts-shape / 4 error-marker / 0 unclassified — exactly the brief's own
// counts, re-confirmed live, not stale):
//   - detail.votes is a number, no detail.counts object -> ingest-legiscan.js's OWN shape -> stays
//     'legiscan'.
//   - no top-level detail.votes, detail.counts IS an object -> ingest-legiscan-texts.js's OWN shape
//     -> relabel to 'legiscan-texts'.
//   - neither shape (a bare {error, queries_used} failure detail) -> classified by an exact,
//     sourced error-string marker only ingest-legiscan.js's own code paths can produce -> stays
//     'legiscan'.
//   - anything matching NONE of the above is NEVER guessed — left as 'legiscan' (today's safe
//     default) and reported explicitly, never silently folded into "unchanged."
// ============================================================================================

const votesShapeDetail = () => ({
  votes: 12, casts: 40, sessions: 1, bills: 5, queriesUsed: 2, attribution: { license: 'CC BY 4.0' },
});
const textsShapeDetail = () => ({
  counts: {
    billsPlanned: 5, docCacheHits: 2, queriesSpent: 3, inserted: 3,
  },
  failures: [],
  queries_used: 3,
});
const insertVotesErrorDetail = () => ({
  error: 'Error: insertIfAbsent(votes) failed: date/time field value out of range: "0000-00-00"', queries_used: 2,
});
const legiscanVotesModuleErrorDetail = () => ({
  error: 'Error: legiscan-votes: could not write vote_reconciliation_flags row: duplicate key value violates unique constraint "vote_reconciliation_flags_dedup_key"', queries_used: 1,
});
const genuinelyUnclassifiableDetail = () => ({
  error: 'Error: some totally unrelated failure with no recognizable marker', queries_used: 1,
});

// ---- classifyLegiscanSourceRow (pure) ----

test('classifyLegiscanSourceRow: votes-shape (detail.votes number, no detail.counts object) classifies "legiscan" (unchanged)', () => {
  assert.equal(classifyLegiscanSourceRow(votesShapeDetail()), 'legiscan');
});

test('classifyLegiscanSourceRow: texts-shape (no detail.votes, detail.counts IS an object) classifies "legiscan-texts" (relabel)', () => {
  assert.equal(classifyLegiscanSourceRow(textsShapeDetail()), 'legiscan-texts');
});

test('classifyLegiscanSourceRow: a bare failure detail carrying the "insertIfAbsent(votes) failed" marker classifies "legiscan" (unchanged)', () => {
  assert.equal(classifyLegiscanSourceRow(insertVotesErrorDetail()), 'legiscan');
});

test('classifyLegiscanSourceRow: a bare failure detail carrying the "legiscan-votes:" marker classifies "legiscan" (unchanged)', () => {
  assert.equal(classifyLegiscanSourceRow(legiscanVotesModuleErrorDetail()), 'legiscan');
});

test('classifyLegiscanSourceRow: a genuinely unrecognized shape (no votes number, no counts object, no known error marker) is NEVER guessed — returns null', () => {
  assert.equal(classifyLegiscanSourceRow(genuinelyUnclassifiableDetail()), null);
});

test('classifyLegiscanSourceRow: null/undefined/empty detail is never guessed — returns null', () => {
  assert.equal(classifyLegiscanSourceRow(null), null);
  assert.equal(classifyLegiscanSourceRow(undefined), null);
  assert.equal(classifyLegiscanSourceRow({}), null);
});

test('LEGISCAN_TEXTS_ERROR_MARKERS: exactly the two real, sourced markers named in the brief', () => {
  assert.deepEqual(LEGISCAN_TEXTS_ERROR_MARKERS, ['insertIfAbsent(votes) failed', 'legiscan-votes:']);
});

// ---- runCorrectLegiscanSourceSplit ----

function legiscanRunRow(id, detail, { source = 'legiscan' } = {}) {
  return {
    id, source, status: 'succeeded', started_at: '2026-07-30T00:00:00.000Z', detail,
  };
}

test('runCorrectLegiscanSourceSplit: --dry-run classifies all rows correctly and performs ZERO writes, reporting the exact counts a live run would produce', async () => {
  const seed = {
    ingestion_runs: [
      legiscanRunRow('r1', votesShapeDetail()),
      legiscanRunRow('r2', votesShapeDetail()),
      legiscanRunRow('r3', textsShapeDetail()),
      legiscanRunRow('r4', textsShapeDetail()),
      legiscanRunRow('r5', insertVotesErrorDetail()),
      legiscanRunRow('r6', legiscanVotesModuleErrorDetail()),
      legiscanRunRow('r7', genuinelyUnclassifiableDetail()),
      // a different source entirely — must never be touched/counted at all (scope query only reads source='legiscan')
      legiscanRunRow('r8', votesShapeDetail(), { source: 'mo-house-xml' }),
    ],
  };
  const client = makeFakeClient(seed);
  const report = await runCorrectLegiscanSourceSplit(client, { dryRun: true });

  assert.equal(report.seen, 7, 'only source=legiscan rows are in scope — the mo-house-xml row is excluded entirely');
  assert.equal(report.relabeledToTexts, 2);
  assert.deepEqual(report.relabeled.map((r) => r.id).sort(), ['r3', 'r4']);
  assert.equal(report.unchangedLegiscan, 4, '2 votes-shape + 2 error-marker rows');
  assert.equal(report.unclassified, 1);
  assert.deepEqual(report.unclassifiedRows.map((r) => r.id), ['r7']);
  assert.equal(report.failures.length, 0);

  assert.equal(
    client.calls.some((c) => c.table === 'ingestion_runs' && c.mode === 'update'),
    false,
    'dry-run must perform ZERO writes',
  );
  // Reconciliation invariant, same convention as runCorrectMoStatus's own "updated always equals
  // the sum of perCode": every seen row lands in exactly one of the three honest buckets.
  assert.equal(report.relabeledToTexts + report.unchangedLegiscan + report.unclassified, report.seen);
});

test('runCorrectLegiscanSourceSplit: LIVE — relabels ONLY the texts-shape rows to \'legiscan-texts\', leaves every other row\'s source untouched, and reproduces the dry-run\'s own counts', async () => {
  const seed = {
    ingestion_runs: [
      legiscanRunRow('r1', votesShapeDetail()),
      legiscanRunRow('r2', textsShapeDetail()),
      legiscanRunRow('r3', insertVotesErrorDetail()),
      legiscanRunRow('r4', genuinelyUnclassifiableDetail()),
    ],
  };
  const client = makeFakeClient(seed);
  const report = await runCorrectLegiscanSourceSplit(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.relabeledToTexts, 1);
  assert.equal(report.unchangedLegiscan, 2);
  assert.equal(report.unclassified, 1);

  const byId = Object.fromEntries(client.tables.ingestion_runs.map((r) => [r.id, r]));
  assert.equal(byId.r1.source, 'legiscan', 'votes-shape row: untouched');
  assert.equal(byId.r2.source, 'legiscan-texts', 'texts-shape row: relabeled live');
  assert.equal(byId.r3.source, 'legiscan', 'error-marker row: untouched');
  assert.equal(byId.r4.source, 'legiscan', 'genuinely unclassifiable row: left as legiscan, the safe default');
});

test('runCorrectLegiscanSourceSplit: a genuinely unrelated DB error on ONE relabel is isolated into failures[] — the run continues and still relabels the OTHER texts-shape row', async () => {
  const seed = {
    ingestion_runs: [
      legiscanRunRow('r1', textsShapeDetail()),
      legiscanRunRow('r2', textsShapeDetail()),
    ],
  };
  const client = makeFakeClient(
    seed,
    {
      forceError: (table, mode, filters) => (
        table === 'ingestion_runs' && mode === 'update' && filters.some((f) => f.op === 'eq' && f.col === 'id' && f.val === 'r1')
          ? { message: 'connection reset' }
          : null
      ),
    },
  );
  const report = await runCorrectLegiscanSourceSplit(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.relabeledToTexts, 1, 'r2 still relabels despite r1\'s failure');
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].id, 'r1');
  assert.match(report.failures[0].error, /connection reset/);
  const byId = Object.fromEntries(client.tables.ingestion_runs.map((r) => [r.id, r]));
  assert.equal(byId.r1.source, 'legiscan', 'never relabeled — its update failed');
  assert.equal(byId.r2.source, 'legiscan-texts');
});

test('runCorrectLegiscanSourceSplit: --limit scopes which rows are processed (deterministic id order), same convention as this file\'s other corrections', async () => {
  const seed = {
    ingestion_runs: [
      legiscanRunRow('r1', textsShapeDetail()),
      legiscanRunRow('r2', textsShapeDetail()),
      legiscanRunRow('r3', textsShapeDetail()),
    ],
  };
  const client = makeFakeClient(seed);
  const report = await runCorrectLegiscanSourceSplit(client, { dryRun: true, limit: 2 });
  assert.equal(report.seen, 2);
  assert.deepEqual(report.relabeled.map((r) => r.id).sort(), ['r1', 'r2']);
});

// ---- wiring: parseArgs + runCorrectData dispatcher ----

test('parseArgs: accepts legiscan-source-split as a <which> value', () => {
  assert.equal(parseArgs(['legiscan-source-split']).which, 'legiscan-source-split');
  assert.equal(parseArgs(['legiscan-source-split', '--dry-run']).dryRun, true);
});

test('runCorrectData: "legiscan-source-split" runs only that correction, and it also participates in "all" (a guarded single-column UPDATE by primary key, same in-place-rewrite risk class as mo-status/party-normalize, never a delete or FK redirect)', async () => {
  const seed = { ingestion_runs: [legiscanRunRow('r1', textsShapeDetail())] };

  const onlyThis = await runCorrectData(makeFakeClient(seed), { which: 'legiscan-source-split', dryRun: true });
  assert.ok(onlyThis.legiscanSourceSplit);
  assert.equal(onlyThis.moStatus, undefined);
  assert.equal(onlyThis.legiscanSourceSplit.relabeledToTexts, 1);

  const all = await runCorrectData(makeFakeClient({
    ...seed, bills: [], votes: [], vote_casts: [],
  }), { which: 'all', dryRun: true });
  assert.ok(all.legiscanSourceSplit, '"all" must include this correction');
  assert.ok(all.moStatus);
  assert.equal(all.failures.length, 0);
});
