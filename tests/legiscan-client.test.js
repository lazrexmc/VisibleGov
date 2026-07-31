import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redactUrl } from '../src/lib/http.js';
import {
  SOURCE, ATTRIBUTION, LEGISCAN_MIN_INTERVAL_MS, legiscanLimiter,
  LegiScanApiError, DatasetHashMismatchError, QueryBudgetExceededError,
  checkStatus, decodeDatasetHashGate, getMonthlyQueryUsage, assertUnderBudget,
  getSessionList, getDatasetList, getDataset, getBill, getRollCall, getBillText,
} from '../src/adapters/legiscan.js';

const FIXDIR = 'tests/fixtures/research/legiscan';
const sessionsFixture = JSON.parse(readFileSync(`${FIXDIR}/mo-sessions.json`, 'utf8'));
const billFixture = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-SB894.json`, 'utf8'));
const rollCallFixture = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-rollcall-747209.json`, 'utf8'));
const billTextFixture = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-SB894-billtext-1680835.json`, 'utf8'));

// ---- module shape sanity (SOURCE/ATTRIBUTION/limiter constant, no live network) ----

test('SOURCE/ATTRIBUTION are the documented constants', () => {
  assert.equal(SOURCE, 'legiscan');
  assert.deepEqual(ATTRIBUTION, { license: 'CC BY 4.0', holder: 'LegiScan', url: 'https://legiscan.com' });
});

test('LEGISCAN_MIN_INTERVAL_MS resolves to the Q3 fallback (1000ms) — the manual\'s real Page 7 '
  + 'content is a per-operation data-refresh cadence table ("Frequency"), not a request-pacing/'
  + 'rate-limit value; no such value exists anywhere in the 43-page manual (Task 2 WebFetch)', () => {
  assert.equal(LEGISCAN_MIN_INTERVAL_MS, 1000);
});

test('legiscanLimiter is built from LEGISCAN_MIN_INTERVAL_MS and exposes the shared take() contract', () => {
  assert.equal(typeof legiscanLimiter.take, 'function');
});

// ---- checkStatus (skip≠empty: every response's status is checked, typed error on non-OK) ----

test('checkStatus passes through an OK payload unchanged (real mo-sessions.json fixture)', () => {
  assert.equal(checkStatus(sessionsFixture), sessionsFixture);
});

test('checkStatus throws LegiScanApiError on a non-OK status (synthetic ERROR fixture — no real '
  + 'ERROR payload captured yet)', () => {
  const bad = { status: 'ERROR', alert: { message: 'API key expired or invalid' } };
  assert.throws(() => checkStatus(bad), (err) => {
    assert.ok(err instanceof LegiScanApiError);
    assert.equal(err.name, 'LegiScanApiError');
    assert.equal(err.status, 'ERROR');
    assert.equal(err.alertMessage, 'API key expired or invalid');
    return true;
  });
});

test('checkStatus throws on a payload with no status field at all, and on null/undefined', () => {
  assert.throws(() => checkStatus({}), LegiScanApiError);
  assert.throws(() => checkStatus(null), LegiScanApiError);
  assert.throws(() => checkStatus(undefined), LegiScanApiError);
});

// ---- real fixtures are the source of truth — field names asserted verbatim, not renamed ----

test('getSessionList shape: checkStatus passes, all 31 real MO sessions parse (mo-sessions.json)', () => {
  const payload = checkStatus(sessionsFixture);
  assert.equal(payload.sessions.length, 31);
  for (const s of payload.sessions) {
    assert.equal(typeof s.session_id, 'number');
    assert.equal(s.state_abbr, 'MO');
    assert.equal(typeof s.dataset_hash, 'string');
    assert.ok(s.dataset_hash.length > 0);
  }
  // Spot-check both Regular and Special sessions are present (session_tag verbatim, not renamed).
  assert.ok(payload.sessions.some((s) => s.session_tag === 'Regular Session'));
  assert.ok(payload.sessions.some((s) => /Special Session/.test(s.session_tag)));
});

test('getBill shape (SB894): sponsors[].people_id and votes[].roll_call_id verbatim '
  + '(mo-2018-SB894.json)', () => {
  const payload = checkStatus(billFixture);
  assert.equal(payload.bill.bill_number, 'SB894');
  assert.deepEqual(payload.bill.sponsors.map((s) => s.people_id), [14996, 17512]);
  assert.equal(payload.bill.sponsors[0].name, 'Douglas Libla');
  assert.equal(payload.bill.sponsors[1].name, 'Travis Fitzwater');
  assert.equal(payload.bill.votes.length, 1);
  assert.equal(payload.bill.votes[0].roll_call_id, 747209);
});

test('getRollCall shape (747209): roll_call.votes[].{people_id,vote_id,vote_text} verbatim, own '
  + 'printed tallies match the 161 individual casts exactly (mo-2018-rollcall-747209.json)', () => {
  const payload = checkStatus(rollCallFixture);
  assert.equal(payload.roll_call.roll_call_id, 747209);
  assert.equal(payload.roll_call.bill_id, 1050440);
  assert.equal(payload.roll_call.yea, 121);
  assert.equal(payload.roll_call.nay, 19);
  assert.equal(payload.roll_call.nv, 0);
  assert.equal(payload.roll_call.absent, 21);
  assert.equal(payload.roll_call.total, 161);
  assert.equal(payload.roll_call.votes.length, 161);
  for (const v of payload.roll_call.votes) {
    assert.equal(typeof v.people_id, 'number');
    assert.equal(typeof v.vote_id, 'number');
    assert.equal(typeof v.vote_text, 'string');
  }
  const tally = { yea: 0, nay: 0, absent: 0 };
  for (const v of payload.roll_call.votes) {
    if (v.vote_text === 'Yea') tally.yea += 1;
    else if (v.vote_text === 'Nay') tally.nay += 1;
    else if (v.vote_text === 'Absent') tally.absent += 1;
  }
  assert.equal(tally.yea, 121);
  assert.equal(tally.nay, 19);
  assert.equal(tally.absent, 21);
});

// ---- getBillText shape (real ONE-probe fixture — LegiScan bill-text volume path,
// .superpowers/sdd/2026-07-31-legiscan-bill-text/brief.md): doc_id 1680835, SB894 "Introduced" ----

test('getBillText shape: checkStatus passes on the real ONE-probe fixture; fields verbatim, '
  + 'including the real-but-originally-unassumed url/state_link/alt_* fields', () => {
  const payload = checkStatus(billTextFixture);
  assert.equal(payload.text.doc_id, 1680835);
  assert.equal(payload.text.bill_id, 1050440);
  assert.equal(payload.text.type, 'Introduced');
  assert.equal(payload.text.mime, 'application/pdf');
  assert.equal(payload.text.url, 'https://legiscan.com/MO/text/SB894/id/1680835');
  assert.equal(payload.text.state_link, 'https://www.senate.mo.gov/18info/pdf-bill/intro/SB894.pdf');
  assert.equal(typeof payload.text.doc, 'string');
  assert.equal(payload.text.alt_bill_text, 0);
});

// ---- redactUrl coverage of LegiScan's real URL shape (verified, not assumed — brief's explicit
// ask) — Pull API: "https://api.legiscan.com/?key=APIKEY&op=OPERATION&PARAMS" per the manual ----

test('redactUrl redacts the LegiScan key= query param (first param, as this adapter always emits it)', () => {
  const url = 'https://api.legiscan.com/?key=SUPERSECRET123&op=getSessionList&state=MO';
  const redacted = redactUrl(url);
  assert.equal(redacted, 'https://api.legiscan.com/?key=REDACTED&op=getSessionList&state=MO');
  assert.ok(!redacted.includes('SUPERSECRET123'));
});

test('redactUrl redacts BOTH key= and access_key= on a getDataset-shaped URL — the account API '
  + 'key AND the per-dataset access_key (a real credential-shaped token from getDatasetList, '
  + 'threaded through by this adapter\'s own getDataset call) are both secrets and must both be '
  + 'redacted (Task 3 ruling 2: this was a real gap in the prior `(?:api_?key|key)` pattern, which '
  + 'did not match `access_key=` by construction — closed in src/lib/http.js before any live call)', () => {
  const url = 'https://api.legiscan.com/?key=SUPERSECRET123&op=getDataset&id=1608&access_key=DatasetTicketABC';
  const redacted = redactUrl(url);
  assert.equal(redacted, 'https://api.legiscan.com/?key=REDACTED&op=getDataset&id=1608&access_key=REDACTED');
  assert.ok(!redacted.includes('SUPERSECRET123'));
  assert.ok(!redacted.includes('DatasetTicketABC'));
});

test('redactUrl redacts key= on a getBill-shaped URL regardless of trailing params', () => {
  const url = 'https://api.legiscan.com/?key=SUPERSECRET123&op=getBill&id=1050440';
  assert.equal(redactUrl(url), 'https://api.legiscan.com/?key=REDACTED&op=getBill&id=1050440');
});

test('redactUrl redacts key= on a getBillText-shaped URL (the volume path\'s own op) regardless of '
  + 'trailing params — the key must never survive into a redacted URL', () => {
  const url = 'https://api.legiscan.com/?key=SUPERSECRET123&op=getBillText&id=1680835';
  const redacted = redactUrl(url);
  assert.equal(redacted, 'https://api.legiscan.com/?key=REDACTED&op=getBillText&id=1680835');
  assert.ok(!redacted.includes('SUPERSECRET123'));
});

// ---- decodeDatasetHashGate (pure, no DB/network — THE mandatory suspension-level gate) ----

test('decodeDatasetHashGate: no ledger row -> shouldFetch true (never fetched)', () => {
  const result = decodeDatasetHashGate(1530, 'abc123', null);
  assert.equal(result.shouldFetch, true);
  assert.equal(result.reason, 'never_fetched');
});

test('decodeDatasetHashGate: ledger row present, hash matches -> shouldFetch false', () => {
  const ledgerRow = { legiscan_session_id: 1530, dataset_hash: 'abc123' };
  const result = decodeDatasetHashGate(1530, 'abc123', ledgerRow);
  assert.equal(result.shouldFetch, false);
});

test('decodeDatasetHashGate: ledger row present, hash differs (a real dataset update) -> '
  + 'shouldFetch true, reason "hash_changed"', () => {
  const ledgerRow = { legiscan_session_id: 1530, dataset_hash: 'old-hash-value' };
  const result = decodeDatasetHashGate(1530, 'new-hash-value', ledgerRow);
  assert.equal(result.shouldFetch, true);
  assert.equal(result.reason, 'hash_changed');
});

// ---- decodeDatasetHashGate: sessionId-vs-ledgerRow defensive assert (Task 9 review item (c)) ----

test('decodeDatasetHashGate: a ledgerRow whose own legiscan_session_id does NOT match the '
  + 'requested sessionId throws — never gates a fetch decision against the wrong session\'s row', () => {
  const wrongSessionLedgerRow = { legiscan_session_id: 9999, dataset_hash: 'abc123' };
  assert.throws(
    () => decodeDatasetHashGate(1530, 'abc123', wrongSessionLedgerRow),
    /does not match the requested sessionId=1530/,
  );
});

// ---- getMonthlyQueryUsage / assertUnderBudget — fake ingestion_runs client, UTC month boundary
// (ruling Q5), and the selectAll-pagination proof the brief explicitly asks for ----

// Fake client shaped like Supabase's own query builder, enforcing the SAME 1000-row-per-.range()
// server cap the real Supabase/PostgREST instance enforces (db.test.js's makeCappedTableClient
// precedent) — a fake that always returns however many rows it was seeded with in one shot can't
// prove pagination is actually happening; this one can't be fooled by a bare unpaginated .select().
function makeFakeIngestionRunsClient(rows, { serverCap = 1000 } = {}) {
  const rangeCalls = [];
  return {
    rangeCalls,
    from(table) {
      const predicates = [];
      const builder = {
        select() { return this; },
        eq(col, val) { predicates.push((r) => r[col] === val); return this; },
        gte(col, val) { predicates.push((r) => r[col] >= val); return this; },
        lt(col, val) { predicates.push((r) => r[col] < val); return this; },
        order() { return this; },
        range(from, to) {
          rangeCalls.push({ table, from, to });
          const filtered = rows
            .filter((r) => predicates.every((p) => p(r)))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const requestedSize = to - from + 1;
          const cappedSize = Math.min(requestedSize, serverCap);
          return Promise.resolve({ data: filtered.slice(from, from + cappedSize), error: null });
        },
      };
      return builder;
    },
  };
}

test('getMonthlyQueryUsage sums detail.queries_used for the given source within the current UTC '
  + 'calendar month, excluding the prior month, the next month, and other sources — spans a month '
  + 'boundary as required', async () => {
  const rows = [
    { id: '00001', source: 'legiscan', started_at: '2026-07-01T00:00:00.000Z', detail: { queries_used: 10 } },
    { id: '00002', source: 'legiscan', started_at: '2026-07-15T12:00:00.000Z', detail: { queries_used: 25 } },
    { id: '00003', source: 'legiscan', started_at: '2026-07-31T23:59:59.999Z', detail: { queries_used: 5 } },
    // previous month — must be excluded even though it's less than 24h before monthStart
    { id: '00004', source: 'legiscan', started_at: '2026-06-30T23:59:59.999Z', detail: { queries_used: 999 } },
    // next month — must be excluded even though it's exactly monthEnd (exclusive upper bound)
    { id: '00005', source: 'legiscan', started_at: '2026-08-01T00:00:00.000Z', detail: { queries_used: 999 } },
    // different source — must be excluded
    { id: '00006', source: 'mo-house-xml', started_at: '2026-07-10T00:00:00.000Z', detail: { queries_used: 999 } },
  ];
  const client = makeFakeIngestionRunsClient(rows);
  const usage = await getMonthlyQueryUsage(client, { now: new Date('2026-07-20T00:00:00.000Z') });
  assert.equal(usage, 40);
});

test('getMonthlyQueryUsage treats missing/null detail or missing queries_used as 0, never NaNs the sum', async () => {
  const rows = [
    { id: '00001', source: 'legiscan', started_at: '2026-07-01T00:00:00.000Z', detail: { queries_used: 10 } },
    { id: '00002', source: 'legiscan', started_at: '2026-07-02T00:00:00.000Z', detail: {} },
    { id: '00003', source: 'legiscan', started_at: '2026-07-03T00:00:00.000Z', detail: null },
  ];
  const client = makeFakeIngestionRunsClient(rows);
  const usage = await getMonthlyQueryUsage(client, { now: new Date('2026-07-20T00:00:00.000Z') });
  assert.equal(usage, 10);
});

test('getMonthlyQueryUsage calls through selectAll — a busy month past the 1000-row server cap is '
  + 'still fully counted, never silently undercounted (the exact bug class selectAll was written to '
  + 'close; a bare hand-rolled single .range() call would truncate here and return 1000, not 1500)', async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => ({
    id: String(i).padStart(5, '0'),
    source: 'legiscan',
    started_at: '2026-07-15T00:00:00.000Z',
    detail: { queries_used: 1 },
  }));
  const client = makeFakeIngestionRunsClient(rows); // serverCap defaults to 1000, same as live Supabase
  const usage = await getMonthlyQueryUsage(client, { now: new Date('2026-07-20T00:00:00.000Z') });
  assert.equal(usage, 1500);
  assert.ok(client.rangeCalls.length >= 2, 'must have paged past the first 1000-row server cap');
});

test('getMonthlyQueryUsage propagates a selectAll read error rather than swallowing it', async () => {
  const client = {
    from: () => ({
      select() { return this; },
      eq() { return this; },
      gte() { return this; },
      lt() { return this; },
      order() { return this; },
      range: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }),
    }),
  };
  await assert.rejects(
    () => getMonthlyQueryUsage(client, { now: new Date('2026-07-20T00:00:00.000Z') }),
    /getMonthlyQueryUsage.*connection reset/,
  );
});

// ---- assertUnderBudget (pure) ----

test('assertUnderBudget does not throw when usage + planned stays strictly under the cap', () => {
  assert.doesNotThrow(() => assertUnderBudget(100, 49, 150));
});

test('assertUnderBudget throws QueryBudgetExceededError when usage + planned would exceed the cap', () => {
  assert.throws(() => assertUnderBudget(4990, 20, 5000), (err) => {
    assert.ok(err instanceof QueryBudgetExceededError);
    assert.equal(err.name, 'QueryBudgetExceededError');
    assert.equal(err.usage, 4990);
    assert.equal(err.plannedQueries, 20);
    assert.equal(err.capPerMonth, 5000);
    assert.equal(err.projected, 5010);
    return true;
  });
});

// ---- Minor 2 (progress.md ruling, folded into Task 9): refuse AT the cap too, not only past it ----

test('assertUnderBudget: minor 2 — refuses AT the cap (projected === capPerMonth), not only strictly past it', () => {
  assert.throws(() => assertUnderBudget(100, 50, 150), QueryBudgetExceededError);
  assert.throws(() => assertUnderBudget(0, 0, 0), QueryBudgetExceededError);
});

// ---- buildUrl missing-key fail-fast (Task 9 review item (c)) — every public fetcher builds its
// URL (buildUrl, unexported) BEFORE ever awaiting fetchWithLimit, so a missing key throws
// synchronously inside the async function body and the returned promise rejects before any network
// call is attempted — safe to assert here with zero live network risk. ----

test('buildUrl missing-key fail-fast: every live-call wrapper rejects with LegiScanApiError when key is falsy, before any network call is attempted', async () => {
  await assert.rejects(() => getSessionList('MO', { key: undefined }), (err) => {
    assert.ok(err instanceof LegiScanApiError);
    assert.match(err.message, /missing API key/);
    assert.equal(err.op, 'getSessionList');
    return true;
  });
  await assert.rejects(() => getDatasetList('MO', { key: '' }), /missing API key/);
  await assert.rejects(() => getDataset(1608, 'ak', { key: null }), /missing API key/);
  await assert.rejects(() => getBill(1050440, { key: undefined }), /missing API key/);
  await assert.rejects(() => getRollCall(747209, { key: undefined }), /missing API key/);
  await assert.rejects(() => getBillText(1680835, { key: undefined }), /missing API key/);
});

// ---- DatasetHashMismatchError (defined/exported per interface; throw site belongs to Task 9) ----

test('DatasetHashMismatchError is a meta-carrying Error subclass, constructible and instanceof-safe', () => {
  const err = new DatasetHashMismatchError('dataset_hash changed mid-run', { sessionId: 1530, expected: 'a', actual: 'b' });
  assert.ok(err instanceof Error);
  assert.ok(err instanceof DatasetHashMismatchError);
  assert.equal(err.name, 'DatasetHashMismatchError');
  assert.equal(err.sessionId, 1530);
});
