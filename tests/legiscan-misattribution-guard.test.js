import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPerVoteUrlOwners } from '../src/cli/ingest-legiscan.js';

// 2026-08-26. LegiScan's 2023 MO dataset minted a SEPARATE roll_call_id per bill for one physical
// House floor vote: three HB 10 roll calls arrived 232 times each, against 232 different bills, and
// every copy was stored — because source_key IS the provider's roll_call_id and each one was
// genuinely unique. 693 phantom vote rows, 112,728 casts, no error at any layer. This map is what
// lets the ingest refuse the second occurrence.

// Minimal stand-in for the paginated read selectAll performs: .select().order().order().range().
function fakeClient(rows, { error = null } = {}) {
  return {
    from() {
      const q = {
        select() { return q; },
        order() { return q; },
        range(from, to) { return Promise.resolve(error ? { data: null, error } : { data: rows.slice(from, to + 1), error: null }); },
      };
      return q;
    },
  };
}

const MO_HOUSE_A = 'https://www.house.mo.gov/billtracking/bills231/rollcalls/046.022.pdf';
const MO_HOUSE_B = 'https://www.house.mo.gov/billtracking/bills231/rollcalls/067.019.pdf';
const MO_SENATE = 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf';

test('loadPerVoteUrlOwners maps each per-vote document to the bill that already owns it', async () => {
  const owners = await loadPerVoteUrlOwners(fakeClient([
    { id: 'v1', bill_id: 'b-hb10', source_url: MO_HOUSE_A, source_key: 'legiscan-2012-rollcall-1' },
    { id: 'v2', bill_id: 'b-hb10', source_url: MO_HOUSE_B, source_key: 'legiscan-2012-rollcall-2' },
  ]));
  assert.equal(owners.size, 2);
  assert.deepEqual(owners.get(MO_HOUSE_A), { bill_id: 'b-hb10', source_key: 'legiscan-2012-rollcall-1' });
});

test('loadPerVoteUrlOwners IGNORES container documents — guarding them would refuse real votes', async () => {
  // A MO Senate journal PDF is one sitting and legitimately carries many bills' roll calls.
  // Measured: guarding on container URLs would have refused 408 genuine votes.
  const owners = await loadPerVoteUrlOwners(fakeClient([
    { id: 'v1', bill_id: 'b-1', source_url: MO_SENATE, source_key: 'k1' },
    { id: 'v2', bill_id: 'b-2', source_url: MO_SENATE, source_key: 'k2' },
    { id: 'v3', bill_id: 'b-3', source_url: `${MO_SENATE}#1126`, source_key: 'k3' },
  ]));
  assert.equal(owners.size, 0);
});

test('loadPerVoteUrlOwners: first writer wins, so a pre-existing collision is not silently re-picked', async () => {
  const owners = await loadPerVoteUrlOwners(fakeClient([
    { id: 'v1', bill_id: 'b-hb10', source_url: MO_HOUSE_A, source_key: 'first' },
    { id: 'v2', bill_id: 'b-hb114', source_url: MO_HOUSE_A, source_key: 'second' },
  ]));
  assert.equal(owners.size, 1);
  assert.equal(owners.get(MO_HOUSE_A).source_key, 'first');
});

test('loadPerVoteUrlOwners skips rows with no source_url rather than keying on empty string', async () => {
  const owners = await loadPerVoteUrlOwners(fakeClient([
    { id: 'v1', bill_id: 'b-1', source_url: null, source_key: 'k1' },
    { id: 'v2', bill_id: 'b-2', source_url: '', source_key: 'k2' },
  ]));
  assert.equal(owners.size, 0);
});

test('loadPerVoteUrlOwners THROWS on a read error — it must never return a half-empty map', async () => {
  // A silently-empty owner map disables the guard completely while looking like "nothing to guard".
  await assert.rejects(
    () => loadPerVoteUrlOwners(fakeClient([], { error: { message: 'connection reset' } })),
    /loading per-vote url owners failed: connection reset/,
  );
});
