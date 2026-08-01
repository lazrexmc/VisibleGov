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
  runCorrectData,
  CANONICAL_MO_2026_SESSION_IDENTIFIER,
  DUPLICATE_MO_2026_SESSION_IDENTIFIER,
  DUP_BILL_MUST_BE_EMPTY_TABLES,
  runMergeMo2026Session,
  runReconcileMo2026Votes,
  runCorrectMo2026SessionMerge,
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
      const injected = forceError && forceError(table, mode, filters);
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
          result = selectOpts.count === 'exact' ? { data, error: null, count: matched.length } : { data, error: null };
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
          const injected = forceError && forceError(table, 'insert', []);
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
