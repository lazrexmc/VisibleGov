import { test } from 'node:test';
import assert from 'node:assert/strict';
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
function makeFakeClient(seed = {}, { forceError = null } = {}) {
  const tables = { bills: [], votes: [], vote_casts: [], ...seed };
  for (const t of Object.keys(tables)) tables[t] = tables[t].map((r) => ({ ...r }));
  const calls = [];

  function matchesFilters(row, filters) {
    return filters.every((f) => {
      if (f.op === 'eq') return row[f.col] === f.val;
      if (f.op === 'in') return f.vals.includes(row[f.col]);
      return true;
    });
  }

  function makeBuilder(table, mode, patch) {
    const filters = [];
    let orderCol = null;
    let orderAsc = true;
    let limitVal = null;
    let selectCols = null;
    let selectOpts = {};

    const builder = {
      eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
      in(col, vals) { filters.push({ op: 'in', col, vals }); return builder; },
      order(col, { ascending = true } = {}) { orderCol = col; orderAsc = ascending; return builder; },
      limit(n) { limitVal = n; return builder; },
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
      calls.push({
        table, mode, patch, filters: [...filters], select: selectCols, selectOpts, orderCol, limitVal,
      });
      const injected = forceError && forceError(table, mode, filters);
      if (injected) return { data: null, error: injected, count: null };

      const rows = tables[table];
      let matched = rows.filter((r) => matchesFilters(r, filters));

      if (mode === 'select') {
        if (orderCol) {
          matched = [...matched].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : -1) * (orderAsc ? 1 : -1));
        }
        let out = matched;
        if (limitVal != null) out = out.slice(0, limitVal);
        if (selectOpts.head) return { data: null, error: null, count: matched.length };
        if (selectOpts.count === 'exact') return { data: out.map((r) => ({ ...r })), error: null, count: matched.length };
        return { data: out.map((r) => ({ ...r })), error: null };
      }

      if (mode === 'update') {
        for (const row of matched) Object.assign(row, patch);
        if (selectCols) {
          const data = matched.map((r) => ({ id: r.id }));
          if (selectOpts.count === 'exact') return { data, error: null, count: matched.length };
          return { data, error: null };
        }
        return { data: null, error: null };
      }

      if (mode === 'delete') {
        const idsToDelete = new Set(matched.map((r) => r.id));
        tables[table] = rows.filter((r) => !idsToDelete.has(r.id));
        if (selectCols) return { data: matched.map((r) => ({ id: r.id })), error: null };
        return { data: null, error: null };
      }

      throw new Error(`unsupported mode ${mode}`);
    }

    return builder;
  }

  return {
    tables,
    calls,
    from(table) {
      return {
        select: (cols, opts) => makeBuilder(table, 'select', null).select(cols, opts),
        update: (patch) => makeBuilder(table, 'update', patch),
        delete: () => makeBuilder(table, 'delete', null),
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

test('runCorrectMo1969Dates: a sentinel row with a dated primary duplicate (same bill/chamber, matching yea/nay tallies) -> delete path (votes row + its casts), never re-dated', async () => {
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
      { id: 'c1', vote_id: 'v-sentinel', position: 'yea' },
      { id: 'c2', vote_id: 'v-sentinel', position: 'yea' },
      { id: 'c3', vote_id: 'v-sentinel', position: 'nay' },
      { id: 'c4', vote_id: 'v-primary', position: 'yea' },
      { id: 'c5', vote_id: 'v-primary', position: 'yea' },
      { id: 'c6', vote_id: 'v-primary', position: 'nay' },
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
});

test('runCorrectMo1969Dates: a sentinel row with NO duplicate but a parseable primary source_url -> re-dated to the parsed date, never deleted', async () => {
  const client = makeFakeClient({
    votes: [
      {
        id: 'v-sentinel', bill_id: 'bill-2', chamber: 'senate', vote_date: SENTINEL, jurisdiction_id: 'mo-legislature', source_url: 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf#470',
      },
    ],
    vote_casts: [{ id: 'c1', vote_id: 'v-sentinel', position: 'yea' }],
  });

  const report = await runCorrectMo1969Dates(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.seen, 1);
  assert.equal(report.deletedAsDuplicate, 0);
  assert.equal(report.redatedFromSource, 1);
  assert.equal(report.unresolvableDate, 0);
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
    vote_casts: [{ id: 'c1', vote_id: 'v-sentinel', position: 'yea' }],
  });

  const report = await runCorrectMo1969Dates(client, { dryRun: false, runId: 'run-1' });

  assert.equal(report.seen, 1);
  assert.equal(report.deletedAsDuplicate, 0);
  assert.equal(report.redatedFromSource, 0);
  assert.equal(report.unresolvableDate, 1);
  assert.deepEqual(report.failures, []);

  const row = client.tables.votes.find((v) => v.id === 'v-sentinel');
  assert.ok(row, 'row untouched — still exists');
  assert.equal(row.vote_date, SENTINEL, 'never overwritten with a guess');
});

test('runCorrectMo1969Dates: ambiguous duplicate match (0 or >1 tally-matching candidates) falls through to the URL-parse path rather than deleting speculatively', async () => {
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
      { id: 'c1', vote_id: 'v-sentinel', position: 'yea' },
      { id: 'c2', vote_id: 'v-sentinel', position: 'nay' },
      // both primary candidates coincidentally share the SAME (yea,nay) tally as the sentinel —
      // ambiguous, never guessed which one it corresponds to
      { id: 'c3', vote_id: 'v-primary-a', position: 'yea' },
      { id: 'c4', vote_id: 'v-primary-a', position: 'nay' },
      { id: 'c5', vote_id: 'v-primary-b', position: 'yea' },
      { id: 'c6', vote_id: 'v-primary-b', position: 'nay' },
    ],
  });

  const report = await runCorrectMo1969Dates(client, { dryRun: false, runId: 'run-1' });
  assert.equal(report.deletedAsDuplicate, 0);
  assert.equal(report.redatedFromSource, 1, 'falls through to the URL-derive path instead');
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
      { id: 'c1', vote_id: 'v-dup', position: 'yea' },
      { id: 'c2', vote_id: 'v-dup-primary', position: 'yea' },
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
