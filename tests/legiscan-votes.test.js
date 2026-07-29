import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOTE_ID_MAP,
  VoteIdMapError,
  UnrecognizedLegiscanChamberError,
  LegiscanRollCallReconcileError,
  mapLegiscanChamber,
  buildLegiscanVoteSourceKey,
  reconcileLegiscanTallies,
  buildLegiscanVoteCasts,
  crossCheckAgainstPrimarySource,
  PRIMARY_SOURCE_KEY_PREFIXES,
  PRESENT_CATEGORY_CAVEAT,
} from '../src/adapters/legiscan-votes.js';
import { decodeDatasetZip, extractDatasetFiles } from '../src/adapters/legiscan-dataset.js';

// Task 6 (docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md) — votes + casts ingestion.
// Test bed per CONTROLLER RULING 5 (task-6-brief.md, binding): the 8 REAL roll calls in
// dataset-2018-1608, loaded through the SAME decode pipeline Tasks 4/5's own tests use (not a
// parallel raw-JSON read) so this file exercises the identical real payload every other adapter
// test in this plan does. The standalone real roll-call-747209 fixture (task-6-brief.md's own
// illustrative example, captured separately via a live getRollCall call, NOT part of dataset-2018-
// 1608) is ALSO real data and used as supplementary coverage below — never a substitute for the 8
// dataset roll calls, which remain the primary, controller-ruled test bed.
const FIXDIR = 'tests/fixtures/research/legiscan';
const envelope1608 = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-dataset-1608.json`, 'utf8'));
const dataset1608 = await extractDatasetFiles(decodeDatasetZip(envelope1608.dataset.zip));
const rollCalls = dataset1608.rollCalls;
assert.equal(rollCalls.length, 8, 'sanity: the fixture test bed must be exactly the 8 real roll calls');

const rc747209 = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-rollcall-747209.json`, 'utf8')).roll_call;

function findRc(rollCallId) {
  const rc = rollCalls.find((r) => r.roll_call_id === rollCallId);
  assert.ok(rc, `fixture must contain roll call ${rollCallId}`);
  return rc;
}

// ---- VOTE_ID_MAP: the empirically-derived mapping (CONTROLLER RULING 1) ----

test('VOTE_ID_MAP: covers 1/2/3/4 exactly, matching the schema-mysql.sql ls_vote citation (docs/research/2026-07-27-mo-data-sources.md Q2)', () => {
  assert.deepEqual(VOTE_ID_MAP, {
    1: 'yea', 2: 'nay', 3: 'not_voting', 4: 'absent',
  });
});

// CONTROLLER RULING 1, literal: "assert vote_id<->vote_text consistency across all 8 real roll
// calls" — derived from vote_text, not trusted from a recalled doc. This checks EVERY cast in
// EVERY one of the 8 real roll calls (6*156 + 2*33 = 1002 casts) PLUS the standalone 747209
// fixture (161 more casts, 1163 total) and proves vote_id 1 always prints "Yea", 2 always "Nay", 4
// always "Absent" — zero exceptions. vote_id 3 has NO example anywhere in this repo's real
// captured LegiScan data — noted, not fabricated (see the module's own header comment).
test('vote_id <-> vote_text consistency: 1=Yea, 2=Nay, 4=Absent hold with ZERO exceptions across all 1163 real casts (8 dataset roll calls + roll-call-747209); vote_id 3 has no real-fixture example anywhere', () => {
  const expectedText = { 1: 'Yea', 2: 'Nay', 4: 'Absent' };
  const observedVoteIds = new Set();
  let totalCasts = 0;
  for (const rc of [...rollCalls, rc747209]) {
    for (const v of rc.votes) {
      totalCasts += 1;
      observedVoteIds.add(v.vote_id);
      assert.equal(
        v.vote_text,
        expectedText[v.vote_id],
        `roll call ${rc.roll_call_id}, people_id ${v.people_id}: vote_id ${v.vote_id} printed vote_text "${v.vote_text}", expected "${expectedText[v.vote_id]}"`,
      );
    }
  }
  assert.equal(totalCasts, 1002 + 161, 'sanity: exact total cast count across all 9 real roll-call payloads checked');
  assert.deepEqual([...observedVoteIds].sort(), [1, 2, 4], 'only vote_id 1/2/4 appear anywhere in the real fixtures — 3 is never observed');
});

test('VoteIdMapError is exported and named correctly (never silently defaults to "other")', () => {
  const err = new VoteIdMapError('test', { voteId: 5 });
  assert.equal(err.name, 'VoteIdMapError');
  assert.equal(err.voteId, 5);
});

// ---- mapLegiscanChamber ----

test('mapLegiscanChamber: "H" -> house, "S" -> senate (verified-exhaustive against all 8 real roll calls: 6 H, 2 S)', () => {
  assert.equal(mapLegiscanChamber('H'), 'house');
  assert.equal(mapLegiscanChamber('S'), 'senate');
  const hCount = rollCalls.filter((rc) => rc.chamber === 'H').length;
  const sCount = rollCalls.filter((rc) => rc.chamber === 'S').length;
  assert.equal(hCount, 6);
  assert.equal(sCount, 2);
});

test('mapLegiscanChamber: an unrecognized chamber code throws UnrecognizedLegiscanChamberError, never guessed', () => {
  assert.throws(() => mapLegiscanChamber('J'), UnrecognizedLegiscanChamberError);
});

// ---- buildLegiscanVoteSourceKey (CONTROLLER RULING 2, binding — 2-argument scheme) ----

test('buildLegiscanVoteSourceKey(1608, 774312) -> "legiscan-1608-rollcall-774312"', () => {
  assert.equal(buildLegiscanVoteSourceKey(1608, 774312), 'legiscan-1608-rollcall-774312');
});

test('buildLegiscanVoteSourceKey: collision-safe by construction — never matches the mo-senate-web-* or mo-house-xml-* prefixes, for every real roll_call_id in the fixture', () => {
  for (const rc of rollCalls) {
    const key = buildLegiscanVoteSourceKey(1608, rc.roll_call_id);
    assert.doesNotMatch(key, /^mo-senate-web-/);
    assert.doesNotMatch(key, /^mo-house-xml-/);
    assert.match(key, /^legiscan-1608-rollcall-\d+$/);
  }
});

test('PRIMARY_SOURCE_KEY_PREFIXES: the REAL prefixes verified from the live driver code (mo-house-xml.js/ingest-mo-senate.js), not the plan\'s own guessed "mo-senate-journal-pdf-"', () => {
  assert.deepEqual(PRIMARY_SOURCE_KEY_PREFIXES, ['mo-house-xml-', 'mo-senate-web-']);
});

// ---- reconcileLegiscanTallies: the internal gate, against all 8 REAL roll calls ----

const EXPECTED_TALLIES = {
  774311: {
    legiscanBillId: 1126109, chamber: 'house', date: '2018-09-12', tallies: {
      yea: 141, nay: 1, not_voting: 0, absent: 14, total: 156,
    },
  },
  774312: {
    legiscanBillId: 1126108, chamber: 'house', date: '2018-09-12', tallies: {
      yea: 119, nay: 23, not_voting: 0, absent: 14, total: 156,
    },
  },
  774313: {
    legiscanBillId: 1126108, chamber: 'house', date: '2018-09-12', tallies: {
      yea: 36, nay: 92, not_voting: 0, absent: 28, total: 156,
    },
  },
  774314: {
    legiscanBillId: 1126108, chamber: 'house', date: '2018-09-12', tallies: {
      yea: 33, nay: 103, not_voting: 0, absent: 20, total: 156,
    },
  },
  774315: {
    legiscanBillId: 1126108, chamber: 'house', date: '2018-09-12', tallies: {
      yea: 41, nay: 100, not_voting: 0, absent: 15, total: 156,
    },
  },
  774316: {
    legiscanBillId: 1126108, chamber: 'house', date: '2018-09-12', tallies: {
      yea: 96, nay: 38, not_voting: 0, absent: 22, total: 156,
    },
  },
  774411: {
    legiscanBillId: 1126108, chamber: 'senate', date: '2018-09-14', tallies: {
      yea: 28, nay: 1, not_voting: 0, absent: 4, total: 33,
    },
  },
  774412: {
    legiscanBillId: 1126109, chamber: 'senate', date: '2018-09-14', tallies: {
      yea: 29, nay: 0, not_voting: 0, absent: 4, total: 33,
    },
  },
};

test('reconcileLegiscanTallies: passes on all 8 REAL roll calls, exact printed totals (no fabricated numbers)', () => {
  assert.equal(Object.keys(EXPECTED_TALLIES).length, 8);
  for (const rc of rollCalls) {
    const expected = EXPECTED_TALLIES[rc.roll_call_id];
    assert.ok(expected, `unexpected roll_call_id ${rc.roll_call_id} in fixture`);
    const result = reconcileLegiscanTallies(rc);
    assert.equal(result.rollCallId, rc.roll_call_id);
    assert.equal(result.legiscanBillId, expected.legiscanBillId);
    assert.equal(result.chamber, expected.chamber);
    assert.equal(result.date, expected.date);
    assert.deepEqual(result.tallies, expected.tallies);
    assert.equal(result.casts.length, expected.tallies.total);
  }
});

test('reconcileLegiscanTallies: passes on the standalone real roll-call-747209 fixture (yea=121, nay=19, nv=0, absent=21, total=161 — 161 individual casts)', () => {
  const result = reconcileLegiscanTallies(rc747209);
  assert.equal(result.rollCallId, 747209);
  assert.equal(result.legiscanBillId, 1050440);
  assert.equal(result.chamber, 'house');
  assert.deepEqual(result.tallies, {
    yea: 121, nay: 19, not_voting: 0, absent: 21, total: 161,
  });
  assert.equal(result.casts.length, 161);
});

test('reconcileLegiscanTallies: question/date carried through verbatim from the roll call\'s own printed fields', () => {
  const rc = findRc(774312);
  const result = reconcileLegiscanTallies(rc);
  assert.equal(result.question, 'House: HB 3  HBs FOR THIRD READING');
  assert.equal(result.date, '2018-09-12');
});

// ---- reconcileLegiscanTallies: the integrity gate (mutation tests, never edit the real fixture data) ----

test('reconcileLegiscanTallies throws LegiscanRollCallReconcileError when a Yea cast is dropped from a real roll call (never silently stored)', () => {
  const real = findRc(774312); // real: yea=119, nay=23, absent=14, total=156
  const yeaIdx = real.votes.findIndex((v) => v.vote_id === 1);
  const mutated = { ...real, votes: [...real.votes.slice(0, yeaIdx), ...real.votes.slice(yeaIdx + 1)] };
  assert.throws(() => reconcileLegiscanTallies(mutated), (err) => {
    assert.ok(err instanceof LegiscanRollCallReconcileError);
    assert.equal(err.name, 'LegiscanRollCallReconcileError');
    assert.equal(err.rollCallId, 774312);
    assert.equal(err.tallies.yea, 119);
    assert.equal(err.counted.yea, 118);
    assert.ok(err.mismatches.some((m) => m.startsWith('yea:')));
    assert.ok(err.mismatches.some((m) => m.startsWith('total:')));
    assert.equal(err.castCount, 155);
    return true;
  });
});

test('reconcileLegiscanTallies throws when ONLY the printed total disagrees (every position count still reconciles individually) — proves total is checked, not just implied', () => {
  const real = findRc(774411); // real: total=33
  const mutated = { ...real, total: 34 };
  assert.throws(() => reconcileLegiscanTallies(mutated), (err) => {
    assert.ok(err instanceof LegiscanRollCallReconcileError);
    assert.deepEqual(err.mismatches, ['total: parsed 33 vs printed 34']);
    return true;
  });
});

test('reconcileLegiscanTallies throws VoteIdMapError (never a silent "other") on a synthetic unrecognized vote_id 5', () => {
  const real = findRc(774312);
  const mutated = {
    ...real,
    votes: [{ people_id: 999999, vote_id: 5, vote_text: 'Excused' }, ...real.votes.slice(1)],
  };
  assert.throws(() => reconcileLegiscanTallies(mutated), (err) => {
    assert.ok(err instanceof VoteIdMapError);
    assert.equal(err.name, 'VoteIdMapError');
    assert.equal(err.voteId, 5);
    assert.equal(err.peopleId, 999999);
    assert.equal(err.rollCallId, 774312);
    return true;
  });
});

test('reconcileLegiscanTallies: a reconciling roll call is unaffected by cast ORDER (mutation sanity — the gate is on counts, not position)', () => {
  const real = findRc(774313);
  const shuffled = { ...real, votes: [...real.votes].reverse() };
  const result = reconcileLegiscanTallies(shuffled);
  assert.deepEqual(result.tallies, EXPECTED_TALLIES[774313].tallies);
});

// FIX ROUND 2, MINOR 1: a runtime vote_id<->vote_text consistency check per record, locking the
// same guarantee the corpus-level test above already proves empirically across 1163 real casts.
test('reconcileLegiscanTallies (FIX ROUND 2, MINOR 1): a cast whose printed vote_text disagrees with its own vote_id throws VoteIdMapError naming both values', () => {
  const real = findRc(774312);
  // real.votes[0] is { people_id: 7523, vote_id: 1, vote_text: "Yea" } — mutate ONLY the printed
  // text, leaving vote_id untouched, so this is a pure vote_id/vote_text disagreement, not an
  // unrecognized-vote_id case (already covered by the test above).
  assert.equal(real.votes[0].vote_id, 1);
  assert.equal(real.votes[0].vote_text, 'Yea');
  const mutated = {
    ...real,
    votes: [{ ...real.votes[0], vote_text: 'Nay' }, ...real.votes.slice(1)],
  };
  assert.throws(() => reconcileLegiscanTallies(mutated), (err) => {
    assert.ok(err instanceof VoteIdMapError);
    assert.equal(err.rollCallId, 774312);
    assert.equal(err.voteId, 1);
    assert.equal(err.peopleId, 7523);
    assert.equal(err.voteText, 'Nay');
    assert.equal(err.expectedVoteText, 'Yea');
    assert.match(err.message, /vote_id\/vote_text disagree/);
    return true;
  });
});

test('reconcileLegiscanTallies (FIX ROUND 2, MINOR 1): absent/empty vote_text is never checked — no crash, no false positive, since some payload shapes may omit the field', () => {
  const real = findRc(774312);
  const withoutVoteText = {
    ...real,
    votes: [{ people_id: real.votes[0].people_id, vote_id: real.votes[0].vote_id }, ...real.votes.slice(1)],
  };
  const withEmptyVoteText = {
    ...real,
    votes: [{ ...real.votes[0], vote_text: '' }, ...real.votes.slice(1)],
  };
  assert.doesNotThrow(() => reconcileLegiscanTallies(withoutVoteText));
  assert.doesNotThrow(() => reconcileLegiscanTallies(withEmptyVoteText));
});

// ---- buildLegiscanVoteCasts (CONTROLLER RULING 3: honest unresolved count + sample, never guessed) ----

test('buildLegiscanVoteCasts: resolved casts get vote_id/legislator_id/position/run_id rows via the people_id map', () => {
  const casts = [
    { people_id: 1, position: 'yea' },
    { people_id: 2, position: 'nay' },
  ];
  const map = new Map([[1, 'leg-1'], [2, 'leg-2']]);
  const result = buildLegiscanVoteCasts({
    voteId: 'vote-1', runId: 'run-1', casts, legislatorIdByPeopleId: map,
  });
  assert.deepEqual(result.casts, [
    {
      vote_id: 'vote-1', legislator_id: 'leg-1', position: 'yea', run_id: 'run-1',
    },
    {
      vote_id: 'vote-1', legislator_id: 'leg-2', position: 'nay', run_id: 'run-1',
    },
  ]);
  assert.deepEqual(result.unresolved, { count: 0, sample: [] });
});

test('buildLegiscanVoteCasts: an unmapped people_id is an unresolved cast — honest count + sample, never guessed, never dropped', () => {
  const casts = [
    { people_id: 1, position: 'yea' },
    { people_id: 999, position: 'nay' }, // not in the map
  ];
  const map = new Map([[1, 'leg-1']]);
  const result = buildLegiscanVoteCasts({
    voteId: 'vote-1', runId: 'run-1', casts, legislatorIdByPeopleId: map,
  });
  assert.equal(result.casts.length, 1);
  assert.deepEqual(result.unresolved, { count: 1, sample: [{ people_id: 999, position: 'nay' }] });
});

test('buildLegiscanVoteCasts: unresolved sample caps at 10 even when far more are unresolved (matches ingest-mo-senate.js\'s own slicing convention)', () => {
  const casts = Array.from({ length: 15 }, (_, i) => ({ people_id: i, position: 'yea' }));
  const result = buildLegiscanVoteCasts({
    voteId: 'vote-1', runId: 'run-1', casts, legislatorIdByPeopleId: new Map(),
  });
  assert.equal(result.casts.length, 0);
  assert.equal(result.unresolved.count, 15);
  assert.equal(result.unresolved.sample.length, 10);
});

test('buildLegiscanVoteCasts: real roll call 774312\'s 156 casts, end to end — a partial identity map resolves some, honestly leaves the rest unresolved', () => {
  const { casts } = reconcileLegiscanTallies(findRc(774312));
  const map = new Map(casts.slice(0, 100).map((c) => [c.people_id, `leg-${c.people_id}`]));
  const result = buildLegiscanVoteCasts({
    voteId: 'vote-774312', runId: 'run-1', casts, legislatorIdByPeopleId: map,
  });
  assert.equal(result.casts.length, 100);
  assert.equal(result.unresolved.count, 56);
  assert.ok(result.casts.every((c) => c.vote_id === 'vote-774312'));
});

// ---- crossCheckAgainstPrimarySource: fake Supabase-shaped client (no network, no live DB) ----
//
// Same chainable-builder-of-plain-objects convention as tests/legiscan-identity.test.js's
// makeFakeDb: enough of the real supabase-js query-builder shape to drive the actual call chains,
// nothing more.
function makeFakeVotesDb({ voteRows = [], castRows = [], missingFlagsTable = false } = {}) {
  const votes = [...voteRows];
  const voteCasts = [...castRows];
  const flags = [];
  let flagCounter = 0;
  const client = {
    from(table) {
      if (table === 'votes') {
        return {
          select: () => {
            const buildQuery = (filters) => ({
              eq: (c, v) => buildQuery([...filters, [c, v]]),
              then: (resolve, reject) => {
                try {
                  const matched = votes.filter((r) => filters.every(([c, v]) => r[c] === v));
                  resolve({ data: matched.map((r) => ({ ...r })), error: null });
                } catch (err) {
                  reject(err);
                }
              },
            });
            return buildQuery([]);
          },
        };
      }
      if (table === 'vote_casts') {
        return {
          select: () => ({
            eq: async (c, v) => ({ data: voteCasts.filter((r) => r[c] === v).map((r) => ({ ...r })), error: null }),
          }),
        };
      }
      if (table === 'vote_reconciliation_flags') {
        return {
          insert: (row) => ({
            select: () => ({
              single: async () => {
                if (missingFlagsTable) {
                  return {
                    data: null,
                    error: { code: 'PGRST205', message: "Could not find the table 'public.vote_reconciliation_flags' in the schema cache" },
                  };
                }
                flagCounter += 1;
                const inserted = {
                  id: `flag-${flagCounter}`, resolved: false, created_at: 'test-time', ...row,
                };
                flags.push(inserted);
                return { data: inserted, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`makeFakeVotesDb: unexpected table "${table}"`);
    },
  };
  return {
    client, votes, voteCasts, flags,
  };
}

function castRowsOfPosition(voteId, position, count) {
  return Array.from({ length: count }, () => ({ vote_id: voteId, position }));
}

// Real reconciled LegiScan tallies for roll call 774312 (house, 2018-09-12, HB 3): yea=119, nay=23,
// absent=14, not_voting=0. Reused across several tests below as the "LegiScan side" of a
// cross-check. FIX ROUND 1: no `voteId`/`runId` pre-attachment needed on the happy-path shape
// anymore (flag rows attach to the PRIMARY-source vote's id, discovered from the lookup itself) —
// `runId` is still optional pure provenance, attached only where a test cares to check it rides
// through to the flag row.
const legiscanTallies774312 = reconcileLegiscanTallies(findRc(774312));

test('crossCheckAgainstPrimarySource: no existing primary-source vote for this bill/chamber/date -> checked:false, matched:null, quarantine:false, no flag (opportunistic, not blocking)', async () => {
  const { client, flags } = makeFakeVotesDb({ voteRows: [] });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.deepEqual(result, {
    checked: false, matched: null, flag: null, quarantine: false,
  });
  assert.equal(flags.length, 0);
});

test('crossCheckAgainstPrimarySource: matching tallies -> matched:true, quarantine:false, no flag row written', async () => {
  const primaryVoteId = 'primary-vote-1';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 119),
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14), // House PDF has no not_voting category
    ],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.checked, true);
  assert.equal(result.matched, true);
  assert.equal(result.quarantine, false);
  assert.equal(result.flag, null);
  assert.equal(flags.length, 0);
});

// ---- FIX ROUND 1: yea/nay mismatches are REAL divergence -> quarantine (never stored) ----

test('crossCheckAgainstPrimarySource: a YEA mismatch (nay/bucket both agree) -> QUARANTINED (quarantine:true) + flagged; the flag attaches to the PRIMARY-source vote\'s own id, not a LegiScan vote_id (none is ever inserted for a quarantined vote)', async () => {
  const primaryVoteId = 'primary-vote-yea-mismatch';
  const { client, votes, voteCasts, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 115), // real LegiScan yea is 119 -> hard mismatch
      ...castRowsOfPosition(primaryVoteId, 'nay', 23), // matches
      ...castRowsOfPosition(primaryVoteId, 'absent', 14), // bucket(14) matches legiscan's not_voting(0)+absent(14)=14 exactly - ONLY yea disagrees
    ],
  });
  const votesBefore = votes.length;
  const castsBefore = voteCasts.length;
  const legiscanTalliesWithRun = { ...legiscanTallies774312, runId: 'run-9' };
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTalliesWithRun);
  assert.equal(result.checked, true);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, true, 'a yea mismatch must quarantine — the vote is never stored');
  assert.ok(result.flag);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].vote_id, primaryVoteId, 'the flag attaches to the PRIMARY-source vote, which is guaranteed to already exist — never a LegiScan votes.id, which does not exist for a quarantined vote');
  assert.equal(flags[0].source_a, 'legiscan');
  assert.equal(flags[0].source_b, 'mo-house-xml');
  assert.equal(flags[0].run_id, 'run-9');
  assert.deepEqual(flags[0].discrepancy.hard_mismatches, ['yea: legiscan 119 vs primary 115']);
  assert.equal(flags[0].discrepancy.quarantine, true);
  assert.equal(flags[0].discrepancy.caveat, undefined, 'the Present-category caveat does not explain a real yea mismatch — it must not be attached here');
  // Nothing was written into `votes`/`vote_casts` at all — this function never inserts a row into
  // either table itself (that decision belongs to the DRIVER, which must consult `quarantine`
  // BEFORE ever calling insertIfAbsent('votes', ...) for the LegiScan side); the fake DB's own
  // votes/vote_casts arrays (which stand in for "what's publicly, anon-readably stored") are
  // asserted unchanged, proving nothing LegiScan-sourced is reachable through this fake in the
  // quarantine case, exactly as the real driver must guarantee.
  assert.equal(votes.length, votesBefore);
  assert.equal(voteCasts.length, castsBefore);
});

test('crossCheckAgainstPrimarySource: a NAY mismatch (yea/bucket both agree) -> QUARANTINED (quarantine:true) + flagged, same treatment as a yea mismatch', async () => {
  const primaryVoteId = 'primary-vote-nay-mismatch';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 119), // matches
      ...castRowsOfPosition(primaryVoteId, 'nay', 25), // real LegiScan nay is 23 -> hard mismatch
      ...castRowsOfPosition(primaryVoteId, 'absent', 14), // bucket(14) matches legiscan's not_voting(0)+absent(14)=14 exactly - ONLY nay disagrees
    ],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, true, 'a nay mismatch must quarantine — the vote is never stored');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].vote_id, primaryVoteId);
  assert.deepEqual(flags[0].discrepancy.hard_mismatches, ['nay: legiscan 23 vs primary 25']);
  assert.deepEqual(flags[0].discrepancy.soft_mismatches, []);
  assert.equal(flags[0].discrepancy.caveat, undefined, 'no soft/bucket mismatch here — the caveat must not be attached to an unrelated hard mismatch');
});

test('crossCheckAgainstPrimarySource: a mismatch touching BOTH a hard (yea) AND the soft bucket still quarantines (any hard mismatch quarantines, regardless of what else also differs) — and the caveat IS attached since the bucket genuinely is part of what disagrees', async () => {
  const primaryVoteId = 'primary-vote-mixed-mismatch';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 110), // hard mismatch (real 119)
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'present', 5),
      ...castRowsOfPosition(primaryVoteId, 'absent', 18), // 110+23+5+18=156, bucket(5+18=23) != legiscan(0+14=14) -> also soft
    ],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.quarantine, true);
  assert.equal(flags[0].discrepancy.hard_mismatches.length, 1);
  assert.equal(flags[0].discrepancy.soft_mismatches.length, 1);
  assert.equal(flags[0].discrepancy.caveat, PRESENT_CATEGORY_CAVEAT, 'the bucket IS part of the real disagreement here, so the caveat correctly explains that piece even though the vote is ALSO quarantined for the hard mismatch');
});

// ---- FIX ROUND 1: a bucket-ONLY (soft) mismatch flags but stores — accounting difference, not contradiction ----

test('crossCheckAgainstPrimarySource: the Present-category caveat in practice — yea/nay agree exactly, only the combined non-yea/non-nay bucket disagrees -> flagged but NOT quarantined (stores), caveat attached', async () => {
  const primaryVoteId = 'primary-vote-present';
  // yea/nay both agree with LegiScan exactly (119/23 — the two unambiguous, strictly-compared
  // categories). The primary source additionally records 8 genuine "Present" casts (no LegiScan
  // vote_id maps to this) plus 10 Absent — 18 total in the combined non-yea/non-nay bucket, vs
  // LegiScan's own not_voting(0)+absent(14)=14. A bare "18 vs 14" number alone could misread as 4
  // people LegiScan simply missed; the caveat clarifies the more likely explanation is the
  // category-vocabulary gap itself (real "Present" casts LegiScan's ls_vote schema has no code
  // for) — an accounting difference, not a contradiction, so the vote stores despite the flag.
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 119),
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'present', 8), // a genuine Present category, no LegiScan analog
      ...castRowsOfPosition(primaryVoteId, 'absent', 10),
    ],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, false, 'a bucket-only mismatch must NOT quarantine — the vote stores');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].vote_id, primaryVoteId);
  assert.deepEqual(flags[0].discrepancy.hard_mismatches, [], 'yea/nay themselves agree exactly — only the combined bucket disagrees, precisely the caveat\'s scenario');
  assert.ok(flags[0].discrepancy.soft_mismatches.some((m) => m.startsWith('non-yea/non-nay bucket:')));
  assert.equal(flags[0].discrepancy.quarantine, false);
  assert.equal(flags[0].discrepancy.caveat, PRESENT_CATEGORY_CAVEAT);
});

// ---- ambiguous cross-reference: internally reconciled + uncontradicted -> stores, flagged ----

// ---- FIX ROUND 2: same-day multi-roll-call disambiguation (review finding — the plan's own brief
// text wrongly assumed "at most one primary-source vote per real roll call"; the reviewer traced
// this to the real HB 3 fixture's own pattern: 5 separate House roll calls, all on 2018-09-12) ----
//
// The REAL 5 HB 3 house roll calls' true tallies (774312-774316, all house, all 2018-09-12) —
// mirrored here as 5 primary-source candidate rows, exactly the shape a real mo-house-xml driver
// run would have produced for the same day.
const HB3_HOUSE_TALLIES = [
  {
    ordinal: 1, yea: 119, nay: 23, absent: 14,
  }, // 774312 (real)
  {
    ordinal: 2, yea: 36, nay: 92, absent: 28,
  }, // 774313 (real)
  {
    ordinal: 3, yea: 33, nay: 103, absent: 20,
  }, // 774314 (real)
  {
    ordinal: 4, yea: 41, nay: 100, absent: 15,
  }, // 774315 (real)
  {
    ordinal: 5, yea: 96, nay: 38, absent: 22,
  }, // 774316 (real)
];

function buildHb3HouseCandidates(talliesList) {
  const voteRows = talliesList.map((t) => ({
    id: `primary-hb3-${t.ordinal}`, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: `mo-house-xml-HB3-${t.ordinal}`,
  }));
  const castRows = talliesList.flatMap((t) => [
    ...castRowsOfPosition(`primary-hb3-${t.ordinal}`, 'yea', t.yea),
    ...castRowsOfPosition(`primary-hb3-${t.ordinal}`, 'nay', t.nay),
    ...castRowsOfPosition(`primary-hb3-${t.ordinal}`, 'absent', t.absent),
  ]);
  return { voteRows, castRows };
}

test('crossCheckAgainstPrimarySource: the REAL HB 3 same-day pattern (5 real House roll calls, all 2018-09-12) — LegiScan 774312 tally-disambiguates uniquely against its own true match among the 5 -> tally_unique_match, matched:true, no flag', async () => {
  const { voteRows, castRows } = buildHb3HouseCandidates(HB3_HOUSE_TALLIES);
  const { client, flags } = makeFakeVotesDb({ voteRows, castRows });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.checked, true);
  assert.equal(result.matched, true);
  assert.equal(result.quarantine, false);
  assert.equal(result.flag, null);
  assert.equal(result.reason, 'tally_unique_match');
  assert.equal(flags.length, 0, 'exact-match verification passing writes no flag');
});

// FIX ROUND 3 (re-review, execution-caught regression): round 2 returned matched:true the instant
// exactly one candidate's (yea, nay) matched, without ever checking that candidate's own soft
// (present/absent/not_voting) bucket — the re-reviewer proved this by construction: 500 doctored
// Present casts on the uniquely-matched candidate still came back matched:true, zero flags, even
// though the single-candidate path DOES flag the identical scenario (see the "Present-category
// caveat in practice" test above). Mirrored here as the reviewer's own control case.
test('crossCheckAgainstPrimarySource: FIX ROUND 3 regression check — the tally-uniquely-selected candidate STILL gets the full soft-bucket check; 500 doctored Present casts on it are caught, not waved through by tally-selection alone', async () => {
  const { voteRows, castRows: realCastRows } = buildHb3HouseCandidates(HB3_HOUSE_TALLIES);
  // Doctor ONLY the uniquely-matching candidate (774312-mirror, ordinal 1: real yea=119/nay=23,
  // still the unique tally match) by adding 500 extra Present casts nothing on the LegiScan side
  // has any analog for — its yea/nay are untouched (still uniquely selected), but its own bucket
  // (present+absent+not_voting+other = 500+14 = 514) now wildly disagrees with LegiScan's own
  // not_voting+absent = 0+14 = 14.
  const castRows = [...realCastRows, ...castRowsOfPosition('primary-hb3-1', 'present', 500)];
  const { client, flags } = makeFakeVotesDb({ voteRows, castRows });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.checked, true);
  assert.equal(result.matched, false, 'tally-unique SELECTION happened, but verification must NOT pass silently on top of a real bucket blowout');
  assert.equal(result.quarantine, false, 'still a soft-only mismatch (yea/nay both agree exactly) — never quarantined');
  assert.ok(result.flag, 'a flag row must be returned, not null — this is the whole point of the regression fix');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].discrepancy.hard_mismatches.length, 0, 'yea/nay still agree exactly — the selection criterion itself');
  assert.ok(flags[0].discrepancy.soft_mismatches.length > 0, 'the 500-cast bucket blowout must be caught');
  assert.equal(flags[0].discrepancy.caveat, PRESENT_CATEGORY_CAVEAT);
  assert.match(flags[0].discrepancy.note, /tally-unique/);
  assert.match(flags[0].discrepancy.note, /among 5 same-day candidates/);
  assert.equal(flags[0].vote_id, 'primary-hb3-1', 'the flag attaches to the actual selected candidate');
});

test('crossCheckAgainstPrimarySource: a doctored ZERO-tally-match case among the 5 same-day HB 3 candidates -> no assertable 1:1 correspondence, so quarantine:false — stores, flagged "no_tally_corresponding_primary" listing every candidate', async () => {
  const { voteRows, castRows } = buildHb3HouseCandidates(HB3_HOUSE_TALLIES);
  const { client, flags } = makeFakeVotesDb({ voteRows, castRows });
  // Doctored LegiScan tallies that match NONE of the 5 real candidates' own (yea, nay) pairs
  // ((119,23),(36,92),(33,103),(41,100),(96,38)).
  const legiscanTalliesNoMatch = {
    ...legiscanTallies774312,
    tallies: {
      yea: 200, nay: 1, not_voting: 0, absent: 155, total: 356,
    },
  };
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTalliesNoMatch);
  assert.equal(result.checked, true);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, false, 'no assertable 1:1 correspondence -> never quarantine, even though something on this day genuinely disagrees');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].discrepancy.reason, 'no_tally_corresponding_primary');
  assert.equal(flags[0].discrepancy.quarantine, false);
  assert.equal(flags[0].discrepancy.candidates.length, 5, 'every same-day candidate is listed for human review, not just one');
  assert.deepEqual(
    flags[0].discrepancy.candidates.map((c) => c.source_key).sort(),
    ['mo-house-xml-HB3-1', 'mo-house-xml-HB3-2', 'mo-house-xml-HB3-3', 'mo-house-xml-HB3-4', 'mo-house-xml-HB3-5'],
  );
});

test('crossCheckAgainstPrimarySource: a doctored TWO-IDENTICAL-tallies case among the same-day HB 3 candidates -> genuinely ambiguous which row corresponds -> stores, flagged "ambiguous_tally_match" with the matching subset listed', async () => {
  // 774313's own candidate row is doctored to share 774312's real (119, 23) tally exactly — two
  // same-day candidates now both match LegiScan's 774312 tallies, and picking between them would
  // be a guess.
  const doctoredTallies = HB3_HOUSE_TALLIES.map((t, i) => (
    i === 1 ? {
      ordinal: t.ordinal, yea: 119, nay: 23, absent: 14,
    } : t
  ));
  const { voteRows, castRows } = buildHb3HouseCandidates(doctoredTallies);
  const { client, flags } = makeFakeVotesDb({ voteRows, castRows });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.checked, true);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, false, 'ambiguity is never grounds to quarantine — every match AGREES on the tally, it\'s which row corresponds that\'s unresolved');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].discrepancy.reason, 'ambiguous_tally_match');
  assert.equal(flags[0].discrepancy.matching_candidates.length, 2);
  assert.deepEqual(
    flags[0].discrepancy.matching_candidates.map((c) => c.source_key).sort(),
    ['mo-house-xml-HB3-1', 'mo-house-xml-HB3-2'],
  );
});

test('crossCheckAgainstPrimarySource: a vote row on a DIFFERENT date is not a candidate at all (checked:false) — date matching is exact-day, not "close enough"', async () => {
  const { client } = makeFakeVotesDb({
    voteRows: [{
      id: 'primary-x', bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-13', source_key: 'mo-house-xml-HB3-1',
    }],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.deepEqual(result, {
    checked: false, matched: null, flag: null, quarantine: false,
  });
});

test('crossCheckAgainstPrimarySource: a vote row that is NOT primary-source (e.g. another legiscan-* row) is never treated as a cross-check candidate', async () => {
  const { client } = makeFakeVotesDb({
    voteRows: [{
      id: 'legiscan-other', bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'legiscan-1608-rollcall-999999',
    }],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.deepEqual(result, {
    checked: false, matched: null, flag: null, quarantine: false,
  });
});

test('crossCheckAgainstPrimarySource: mo-senate-web primary source is recognized too (not just mo-house-xml) — matching tallies, matched:true, quarantine:false', async () => {
  const primaryVoteId = 'primary-senate-1';
  const legiscanTallies774411 = reconcileLegiscanTallies(findRc(774411));
  const { client } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'senate', vote_date: '2018-09-14', source_key: 'mo-senate-web-2018-RDay-vote1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 28),
      ...castRowsOfPosition(primaryVoteId, 'nay', 1),
      ...castRowsOfPosition(primaryVoteId, 'absent', 4), // MO Senate journal has no not_voting either (absentWithLeave -> absent)
    ],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774411);
  assert.equal(result.matched, true);
  assert.equal(result.quarantine, false);
});

test('crossCheckAgainstPrimarySource: migration 0010 not applied (vote_reconciliation_flags relation missing) degrades gracefully — gated:true, discrepancy preserved, quarantine STILL reported correctly, NEVER thrown', async () => {
  const primaryVoteId = 'primary-vote-3';
  const { client } = makeFakeVotesDb({
    missingFlagsTable: true,
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 1), // wildly different from real 119 -> a hard (yea) mismatch
    ],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.checked, true);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, true, 'the quarantine DECISION is independent of whether the flag could be durably recorded — a gated flags table must never silently let a contradicted vote through');
  assert.equal(result.flag.gated, true);
  assert.match(result.flag.note, /migration 0010/);
  assert.ok(result.flag.discrepancy, 'the detected discrepancy is preserved even though it could not be durably recorded');
});

test('crossCheckAgainstPrimarySource: a votes-table lookup error (unrelated to the missing-table gate) throws, never silently returns checked:false', async () => {
  const client = {
    from(table) {
      if (table === 'votes') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: async () => ({ data: null, error: { message: 'connection reset' } }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  await assert.rejects(
    () => crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312),
    /connection reset/,
  );
});
