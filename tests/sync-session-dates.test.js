import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs, executePlan, earliestHistoryDate, legiscanEarliestActions, fetchInputs, summarize,
} from '../src/cli/sync-session-dates.js';

// Minimal fake of the Supabase client surface executePlan uses:
//   from('sessions').update({start_date}).eq('id', id).is('start_date', null).select(cols) -> { data: affectedRows, error }
//   from('sessions').select(cols).eq('id', id).single()                                     -> { data, error }
// `rows` is the live table; the guard only writes when start_date is still null, exactly like
// PostgREST's `.is('start_date', null)` filter would.
function makeFakeClient(rows, { failOnIdentifier = null } = {}) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls = [];
  return {
    calls,
    rowsById: table,
    from(name) {
      assert.equal(name, 'sessions');
      return {
        update(patch) {
          return {
            eq(col, id) {
              assert.equal(col, 'id');
              return {
                is(guardCol, guardVal) {
                  assert.equal(guardCol, 'start_date'); assert.equal(guardVal, null);
                  return {
                    select() {
                      const row = table.get(id);
                      calls.push({ op: 'update', id, patch });
                      if (row && row.identifier === failOnIdentifier) return Promise.resolve({ data: null, error: { message: 'boom' } });
                      if (row && row.start_date == null) { Object.assign(row, patch); return Promise.resolve({ data: [{ ...row }], error: null }); }
                      return Promise.resolve({ data: [], error: null }); // guard matched nothing: PostgREST returns an empty set
                    },
                  };
                },
              };
            },
          };
        },
        select() {
          return {
            eq(col, id) {
              return { single: () => Promise.resolve({ data: table.get(id) ?? null, error: table.has(id) ? null : { message: 'no row' } }) };
            },
          };
        },
      };
    },
  };
}

// Fake of the selectAll chain (from().select().order().range()) fetchInputs reads sessions through.
function makeSelectAllClient(rows) {
  return {
    from() {
      return {
        select() {
          const q = {
            order() { return q; },
            range(from, to) { return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
          };
          return q;
        },
      };
    },
  };
}

const patch = (id, identifier, start_date) => ({ id, identifier, name: identifier, kind: 'regular', start_date, source: 'mo-const-art3-s20', notes: [] });

test('parseArgs: dry-run by default; --apply, --openstates-file, --no-legiscan-check; unknown args and a missing path refused', () => {
  assert.deepEqual(parseArgs([]), { apply: false, openstatesFile: null, legiscanCheck: true });
  assert.deepEqual(parseArgs(['--apply', '--openstates-file', 'x.json', '--no-legiscan-check']), { apply: true, openstatesFile: 'x.json', legiscanCheck: false });
  assert.throws(() => parseArgs(['--aply']), /unknown argument/);
  assert.throws(() => parseArgs(['--apply', '--openstates-file']), /requires a path/);
  assert.throws(() => parseArgs(['--openstates-file', '--apply']), /requires a path/);
});

test('executePlan writes only rows still NULL and reports a guarded row as a skip — never an overwrite', async () => {
  const client = makeFakeClient([
    { id: 'a', identifier: '2025', start_date: null },
    { id: 'b', identifier: '2022', start_date: '2022-01-05' }, // someone dated it between plan and apply
  ]);
  const result = await executePlan(client, 'run-1', { patches: [patch('a', '2025', '2025-01-08'), patch('b', '2022', '2022-01-06')] });
  assert.deepEqual(result.written.map((w) => [w.identifier, w.start_date]), [['2025', '2025-01-08']]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /guard: row now carries start_date=2022-01-05 \(affected 0 rows\)/);
  assert.equal(result.skipped[0].wanted, '2022-01-06');
  assert.equal(client.rowsById.get('b').start_date, '2022-01-05', 'the guarded row keeps its existing value');
  assert.equal(result.run_id, 'run-1');
});

test('executePlan: a mid-run failure throws with partialResult naming the rows committed and the patch that failed', async () => {
  const client = makeFakeClient([
    { id: 'a', identifier: '2024', start_date: null },
    { id: 'b', identifier: '2025', start_date: null },
    { id: 'c', identifier: '2026', start_date: null },
  ], { failOnIdentifier: '2025' });
  await assert.rejects(
    () => executePlan(client, 'run-2', { patches: [patch('a', '2024', '2024-01-03'), patch('b', '2025', '2025-01-08'), patch('c', '2026', '2026-01-07')] }),
    (err) => {
      assert.match(err.message, /sessions update failed for 2025: boom/);
      assert.deepEqual(err.partialResult.written.map((w) => w.identifier), ['2024']);
      assert.deepEqual(err.partialResult.skipped, []);
      assert.deepEqual(err.partialResult.failed, { id: 'b', identifier: '2025', wanted: '2025-01-08' });
      return true;
    },
  );
  assert.equal(client.rowsById.get('a').start_date, '2024-01-03');
  assert.equal(client.rowsById.get('c').start_date, null, 'nothing after the failure is written');
});

test('earliestHistoryDate returns the earliest bill-history RECORD from the real extractDatasetFiles shape (bills only; rollCalls/people/failures ignored)', () => {
  const parsed = {
    bills: [
      { bill_number: 'HB2', history: [{ date: '2017-05-22', action: 'Introduced and Read First Time (H)' }, { date: '2017-05-30', action: 'Passed' }] },
      { bill_number: 'HB3', history: [{ date: '2017-05-23', action: 'Introduced' }] },
      { bill_number: 'HB4', history: [] },
    ],
    people: [{ people_id: 9, name: 'x' }],
    rollCalls: [{ roll_call_id: 5, date: '2016-01-01', desc: 'a roll call date must never count' }],
    datasetHash: 'abc',
    failures: [{ file: 'bill/HB1.json', date: '2000-01-01', reason: 'unparseable' }],
  };
  assert.deepEqual(earliestHistoryDate(parsed), { date: '2017-05-22', bill_number: 'HB2', action: 'Introduced and Read First Time (H)' });
  assert.equal(earliestHistoryDate({ bills: [], rollCalls: [{ date: '2016-01-01' }] }), null);
  assert.equal(earliestHistoryDate({}), null);
  // the LegiScan wrapper shape ({bill: {...}}) is unwrapped too
  assert.deepEqual(earliestHistoryDate({ bills: [{ bill: { bill_number: 'SB1', history: [{ date: '2020-07-27', action: 'S First Read' }] } }] }), { date: '2020-07-27', bill_number: 'SB1', action: 'S First Read' });
});

test('legiscanEarliestActions over a scratch cache: real MO 2018 envelopes, minimum per session, every non-contributing file reported, file provenance carried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legiscan-cache-'));
  try {
    const env1579 = JSON.parse(readFileSync('tests/fixtures/research/legiscan/mo-2018-dataset.json', 'utf8')).dataset;
    const env1608 = JSON.parse(readFileSync('tests/fixtures/research/legiscan/mo-2018-dataset-1608.json', 'utf8')).dataset;
    writeFileSync(join(dir, '1579-aaaa.json'), JSON.stringify(env1579));
    writeFileSync(join(dir, '1608-bbbb.json'), JSON.stringify(env1608));
    writeFileSync(join(dir, '1608-cccc.json'), JSON.stringify(env1608)); // a second cache file for the same session, identical content
    writeFileSync(join(dir, 'broken.json'), '{not json');
    writeFileSync(join(dir, 'no-zip.json'), JSON.stringify({ session_id: 1, session_name: 'x' }));
    writeFileSync(join(dir, 'README.txt'), 'ignored: not .json');
    const { bySessionId, skipped, disagreements } = await legiscanEarliestActions(dir);
    assert.deepEqual([...bySessionId.keys()].sort(), [1579, 1608]);
    for (const [sid, rec] of bySessionId) {
      assert.match(rec.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(rec.date.slice(0, 4), '2018', `session ${sid} earliest action is inside its year`);
      assert.match(rec.file, new RegExp(`^${sid}-`));
      assert.ok(rec.bill_number, 'the record names the bill');
    }
    assert.deepEqual(skipped.map((s) => s.file).sort(), ['broken.json', 'no-zip.json']);
    assert.match(skipped.find((s) => s.file === 'no-zip.json').reason, /no zip or session_id/);
    assert.deepEqual(disagreements, [], 'identical files for one session do not disagree');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchInputs: joins LegiScan records onto rows by legiscan_session_id, hashes the OpenStates payload, and refuses an empty session list', async () => {
  const rows = [
    { id: 'r1', jurisdiction_id: 'mo-legislature', identifier: '2025-special-2216', name: '2025 1st Special Session', start_date: null, end_date: null, legiscan_session_id: 2216 },
    { id: 'r2', jurisdiction_id: 'mo-legislature', identifier: '2025', name: '2025 Regular Session', start_date: null, end_date: null, legiscan_session_id: 2169 },
    { id: 'r3', jurisdiction_id: 'us-congress', identifier: '119', name: '119th Congress', start_date: '2025-01-03', end_date: null, legiscan_session_id: null },
  ];
  const payload = { legislative_sessions: [{ identifier: '2025S1', name: '2025 1st Extraordinary Session', start_date: '2025-06-02', end_date: '2025-06-13' }] };
  const deps = {
    fetchSessions: async () => payload,
    legiscanEarliestActions: async () => ({ bySessionId: new Map([[2216, { date: '2025-06-02', bill_number: 'HB1', action: 'Introduced', file: '2216-x.json' }]]), skipped: [{ file: 'z.json', reason: 'x' }], disagreements: [] }),
  };
  const inputs = await fetchInputs(makeSelectAllClient(rows), {}, deps);
  assert.equal(inputs.rows.length, 3);
  assert.equal(inputs.openstates.length, 1);
  assert.match(inputs.openstatesSha256, /^[0-9a-f]{64}$/);
  assert.equal(inputs.openstatesSource, 'live v3.openstates.org');
  assert.deepEqual([...inputs.legiscanEarliestAction.keys()], ['r1']);
  assert.equal(inputs.legiscanEarliestAction.get('r1').file, '2216-x.json');
  assert.equal(inputs.legiscanSkipped.length, 1);
  // --no-legiscan-check leaves the map empty
  const without = await fetchInputs(makeSelectAllClient(rows), { legiscanCheck: false }, deps);
  assert.equal(without.legiscanEarliestAction.size, 0);
  // an empty OpenStates list is a refusal, never a plan full of "no OpenStates entry" notes
  await assert.rejects(() => fetchInputs(makeSelectAllClient(rows), {}, { ...deps, fetchSessions: async () => ({}) }), /returned no legislative_sessions/);
  // summarize carries the provenance into the run record
  const summary = summarize({ apply: false }, inputs, { patches: [], unchanged: [], unmatched: [], unclassified: [], corroboration: {} });
  assert.equal(summary.openstates.payload_sha256, inputs.openstatesSha256);
  assert.equal(summary.openstates.sessions, 1);
  assert.equal(summary.legiscan_cache.skipped, 1);
});
