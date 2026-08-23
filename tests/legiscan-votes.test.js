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
  LegiscanRollCallDateError,
  assertRollCallDateWithinSession,
  LEGISCAN_MISSING_DATE_SENTINELS,
  deriveDateFromHistory,
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

// ---- the DATE gate (FINAL REVIEW, finding 3) ----
//
// Ten MO roll calls are stored in production with vote_date 1969-12-31 — LegiScan's own
// missing-date sentinel, stored verbatim by the "store only what's printed" rule and now visible
// as a 1969 bucket on a real profile's chart. The code half of that finding is this guard; the
// correction of the already-stored rows is Lance-gated and deliberately not done here. Same shape
// as the tally gate above: a self-contradicting roll call is REFUSED and counted, never corrected,
// clamped, or nulled into looking plausible.

test('assertRollCallDateWithinSession: every real fixture roll call passes against its own dataset years (2018)', () => {
  for (const rc of rollCalls) {
    assert.equal(assertRollCallDateWithinSession(rc.roll_call_id, rc.date, { yearStart: 2018, yearEnd: 2018 }), rc.date);
  }
  assert.equal(assertRollCallDateWithinSession(747209, rc747209.date, { yearStart: 2018, yearEnd: 2018 }), rc747209.date);
});

test("assertRollCallDateWithinSession: the 1969-12-31 sentinel is REFUSED against a real session's years, with the reason typed", () => {
  assert.throws(() => assertRollCallDateWithinSession(714402, '1969-12-31', { yearStart: 2019, yearEnd: 2019 }), (err) => {
    assert.ok(err instanceof LegiscanRollCallDateError);
    assert.equal(err.name, 'LegiscanRollCallDateError');
    assert.equal(err.reason, 'outside_session_years');
    assert.equal(err.rollCallId, 714402);
    assert.equal(err.date, '1969-12-31');
    assert.equal(err.year, 1969);
    assert.equal(err.yearStart, 2019);
    assert.equal(err.yearEnd, 2019);
    return true;
  });
});

test('assertRollCallDateWithinSession: bounds are inclusive on both ends and span a two-year session', () => {
  assert.equal(assertRollCallDateWithinSession(1, '2019-01-01', { yearStart: 2019, yearEnd: 2020 }), '2019-01-01');
  assert.equal(assertRollCallDateWithinSession(1, '2020-12-31', { yearStart: 2019, yearEnd: 2020 }), '2020-12-31');
  assert.throws(() => assertRollCallDateWithinSession(1, '2018-12-31', { yearStart: 2019, yearEnd: 2020 }), LegiscanRollCallDateError);
  assert.throws(() => assertRollCallDateWithinSession(1, '2021-01-01', { yearStart: 2019, yearEnd: 2020 }), LegiscanRollCallDateError);
});

test('assertRollCallDateWithinSession: a missing year_end defaults to year_start (single-year session)', () => {
  assert.equal(assertRollCallDateWithinSession(1, '2019-06-01', { yearStart: 2019 }), '2019-06-01');
  assert.throws(() => assertRollCallDateWithinSession(1, '2020-06-01', { yearStart: 2019 }), LegiscanRollCallDateError);
});

test('assertRollCallDateWithinSession: an absent/unparseable printed date is refused too (a vote that cannot be placed in time is never stored)', () => {
  for (const bad of [null, undefined, '', '   ', 'unknown', '2019-13-01x', 20190101]) {
    assert.throws(() => assertRollCallDateWithinSession(1, bad, { yearStart: 2019, yearEnd: 2019 }), (err) => {
      assert.ok(err instanceof LegiscanRollCallDateError, `expected a typed refusal for ${JSON.stringify(bad)}`);
      assert.equal(err.reason, 'unparseable_date');
      return true;
    });
  }
});

test('reconcileLegiscanTallies: runs the date gate when the dataset years are supplied — the 1969-12-31 construction on a REAL roll call refuses', () => {
  const real = findRc(774312); // real date 2018-09-12, tallies all reconcile
  assert.ok(reconcileLegiscanTallies(real, { yearStart: 2018, yearEnd: 2018 }), 'the unmutated real roll call still reconciles with bounds supplied');
  const mutated = { ...real, date: '1969-12-31' };
  assert.throws(() => reconcileLegiscanTallies(mutated, { yearStart: 2018, yearEnd: 2018 }), (err) => {
    assert.ok(err instanceof LegiscanRollCallDateError);
    assert.equal(err.reason, 'outside_session_years');
    assert.equal(err.rollCallId, 774312);
    return true;
  });
});

test('reconcileLegiscanTallies: with NO dataset years supplied, the date SHAPE is still checked (an unparseable date never becomes a stored vote)', () => {
  const real = findRc(774312);
  assert.ok(reconcileLegiscanTallies(real));
  assert.throws(() => reconcileLegiscanTallies({ ...real, date: null }), LegiscanRollCallDateError);
  // ...but a well-formed date outside some other session's years cannot be judged without bounds,
  // so it passes here rather than being guessed at. The driver ALWAYS supplies bounds.
  assert.ok(reconcileLegiscanTallies({ ...real, date: '1969-12-31' }));
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
    assert.deepEqual(err.expectedVoteText, ['Yea']);
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
function makeFakeVotesDb({
  voteRows = [], castRows = [], missingFlagsTable = false, forceUniqueViolationOnce = false,
} = {}) {
  const votes = [...voteRows];
  const voteCasts = [...castRows];
  const flags = [];
  let flagCounter = 0;
  let uniqueViolationTriggered = false;
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
          // IMPORTANT 6 (final-review-findings.md) — findExistingReconciliationFlag's own
          // pre-insert idempotency check issues a `.select(...).eq().eq().eq()` and awaits it
          // directly (no `.single()`/`.maybeSingle()`), same chainable-thenable shape as the
          // `votes` table's own builder above.
          select: () => {
            const buildQuery = (filters) => ({
              eq: (c, v) => buildQuery([...filters, [c, v]]),
              then: (resolve, reject) => {
                try {
                  if (missingFlagsTable) {
                    resolve({
                      data: null,
                      error: { code: 'PGRST205', message: "Could not find the table 'public.vote_reconciliation_flags' in the schema cache" },
                    });
                    return;
                  }
                  const matched = flags.filter((r) => filters.every(([c, v]) => r[c] === v));
                  resolve({ data: matched.map((r) => ({ ...r })), error: null });
                } catch (err) {
                  reject(err);
                }
              },
            });
            return buildQuery([]);
          },
          insert: (row) => ({
            select: () => ({
              single: async () => {
                if (missingFlagsTable) {
                  return {
                    data: null,
                    error: { code: 'PGRST205', message: "Could not find the table 'public.vote_reconciliation_flags' in the schema cache" },
                  };
                }
                // Simulates migration 0011's own unique index catching a genuine concurrent-write
                // race the app-level pre-check missed: a "competing process" wins by inserting the
                // row directly (bypassing this insert path, exactly like a real second DB session
                // would), and THIS call is told 23505 — writeReconciliationFlag's own recheck must
                // then find the row that just landed.
                if (forceUniqueViolationOnce && !uniqueViolationTriggered) {
                  uniqueViolationTriggered = true;
                  flagCounter += 1;
                  const raced = {
                    id: `flag-${flagCounter}`, resolved: false, created_at: 'test-time', ...row,
                  };
                  flags.push(raced);
                  return {
                    data: null,
                    error: { code: '23505', message: 'duplicate key value violates unique constraint "vote_reconciliation_flags_dedup_key"' },
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

// ---- FIX (IMPORTANT 5, final-review-findings.md — SUPERSEDES FIX ROUND 1's quarantine-on-hard-
// mismatch design for this branch): "align branch B with C/D semantics" — a hard mismatch resting
// ONLY on two-sided tuple-singleton-ness (no siblings on either side to corroborate correspondence)
// must never quarantine; it stores + flags instead, exactly like branches C/D's own zero-/
// ambiguous-match outcomes. Quarantine is reserved for a CORROBORATED correspondence, which by
// construction (branches C/D only ever compare a candidate AFTER selecting it BY tally equality)
// can never itself coincide with a hard mismatch — so after this fix, no branch of this function
// can produce quarantine:true from real correspondence evidence alone; the `quarantine` field/
// contract and CRITICAL 2's retraction machinery remain as defense-in-depth (see
// ingest-legiscan.js's own crossCheckFn-injection comment for how that is still directly tested). ----

test('crossCheckAgainstPrimarySource: IMPORTANT 5 fix — a YEA mismatch (nay/bucket both agree) on a lone singleton/singleton candidate is NEVER quarantined; it stores + flags (non-correspondence, not asserted contradiction). The flag attaches to the PRIMARY-source vote\'s own id.', async () => {
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
  assert.equal(result.quarantine, false, 'singleton correspondence alone is never sufficient corroboration to quarantine — store + flag instead');
  assert.ok(result.flag);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].vote_id, primaryVoteId, 'the flag attaches to the PRIMARY-source vote');
  assert.equal(flags[0].source_a, 'legiscan');
  assert.equal(flags[0].source_b, 'mo-house-xml');
  assert.equal(flags[0].run_id, 'run-9');
  assert.deepEqual(flags[0].discrepancy.hard_mismatches, ['yea: legiscan 119 vs primary 115']);
  assert.equal(flags[0].discrepancy.reason, 'hard_mismatch');
  assert.equal(flags[0].discrepancy.roll_call_id, 774312);
  assert.equal(flags[0].discrepancy.quarantine, false);
  assert.equal(flags[0].discrepancy.caveat, undefined, 'the Present-category caveat does not explain a real yea mismatch — it must not be attached here');
  // This function itself never inserts a row into `votes`/`vote_casts` (that decision belongs to
  // the DRIVER) — the fake DB's own arrays are asserted unchanged either way, unaffected by this fix.
  assert.equal(votes.length, votesBefore);
  assert.equal(voteCasts.length, castsBefore);
});

test('crossCheckAgainstPrimarySource: IMPORTANT 5 fix — a NAY mismatch (yea/bucket both agree) on a lone singleton/singleton candidate is likewise never quarantined, same store+flag treatment', async () => {
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
  assert.equal(result.quarantine, false, 'never quarantine on singleton-ness alone — the vote stores, flagged');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].vote_id, primaryVoteId);
  assert.deepEqual(flags[0].discrepancy.hard_mismatches, ['nay: legiscan 23 vs primary 25']);
  assert.deepEqual(flags[0].discrepancy.soft_mismatches, []);
  assert.equal(flags[0].discrepancy.reason, 'hard_mismatch');
  assert.equal(flags[0].discrepancy.caveat, undefined, 'no soft/bucket mismatch here — the caveat must not be attached to an unrelated hard mismatch');
});

test('crossCheckAgainstPrimarySource: IMPORTANT 5 fix — a mismatch touching BOTH a hard (yea) AND the soft bucket still never quarantines (Finding 5 applies regardless of what else also differs) — the caveat IS still attached since the bucket genuinely is part of what disagrees', async () => {
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
  assert.equal(result.quarantine, false);
  assert.equal(flags[0].discrepancy.hard_mismatches.length, 1);
  assert.equal(flags[0].discrepancy.soft_mismatches.length, 1);
  assert.equal(flags[0].discrepancy.reason, 'hard_mismatch', 'a reason must be classifiable as hard_mismatch whenever ANY hard mismatch is present, even alongside a soft one too');
  assert.equal(flags[0].discrepancy.caveat, PRESENT_CATEGORY_CAVEAT, 'the bucket IS part of the real disagreement here, so the caveat correctly explains that piece even though a hard mismatch is ALSO present');
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

// ---- CRITICAL 3 fix (final-review-findings.md): zero-/partial-cast primary rows are NOT
// COMPARABLE — never hard-quarantine (or hard-flag) on undercounted castRows data. ----

test('crossCheckAgainstPrimarySource: CRITICAL 3 fix — a mo-senate-shaped primary candidate with ZERO casts (result:null by ruling, no printed aggregate to fall back on — the routine "votes row landed, casts have not yet" backlog state) is NOT COMPARABLE: never hard-quarantine, store+soft-flag instead', async () => {
  const primaryVoteId = 'primary-senate-zero-casts';
  const legiscanTallies774411 = reconcileLegiscanTallies(findRc(774411));
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'senate', vote_date: '2018-09-14', source_key: 'mo-senate-web-2018-x-vote1', result: null,
    }],
    castRows: [], // zero casts — the designed routine backlog state, not an anomaly
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774411);
  assert.equal(result.checked, true);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, false, 'zero primary casts with no result aggregate must never hard-quarantine');
  assert.equal(result.reason, 'primary_cast_data_not_comparable');
  assert.ok(result.flag);
  assert.equal(result.flag.discrepancy.reason, 'primary_cast_data_not_comparable');
  assert.equal(result.flag.discrepancy.source_b_cast_count, 0);
  assert.equal(result.flag.discrepancy.source_b_result, null);
  assert.equal(flags.length, 1);
});

test('crossCheckAgainstPrimarySource: CRITICAL 3 fix — a mo-house-shaped primary candidate whose casts are SHORT of its own printed result aggregate (two-phase ingestion backlog: votes row from bill XML, casts from a later PDF) is NOT COMPARABLE, even though a naive cast-only comparison would show a wild "5 vs 119" mismatch', async () => {
  const primaryVoteId = 'primary-house-partial-casts';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      // 774312's true aggregate, known immediately from the bill XML — independent of the cast PDF backlog below.
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1', result: '119-23',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 5), // PDF backlog: only 5 of the eventual 119 have landed
    ],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.checked, true);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, false, 'a naive castRows-only comparison (5 vs 119) would look like a wild hard mismatch — must never quarantine on that basis');
  assert.equal(result.reason, 'primary_cast_data_not_comparable');
  assert.ok(result.flag);
  assert.equal(result.flag.discrepancy.reason, 'primary_cast_data_not_comparable');
  assert.equal(result.flag.discrepancy.source_b_result, '119-23');
  assert.equal(result.flag.discrepancy.source_b_cast_count, 5);
  assert.equal(flags.length, 1);
});

test('crossCheckAgainstPrimarySource: CRITICAL 3 fix — once casts genuinely catch up to (or exceed) the result aggregate\'s own total, comparability resumes and the AGGREGATE (not the possibly-wrong raw cast count) is what gets compared — a real hard mismatch is still caught, never permanently exempted', async () => {
  const primaryVoteId = 'primary-house-aggregate-preferred';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      // The aggregate itself disagrees with LegiScan's real 119-23.
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1', result: '110-23',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 200), // deliberately WRONG relative to the aggregate — proves the aggregate wins, not the raw (sufficient, but inaccurate) cast count
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14),
    ],
  });
  // total casts (200+23+14=237) exceeds the aggregate's own total (110+23=133) -> comparable
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.quarantine, false, 'IMPORTANT 5 — singleton correspondence alone is never sufficient corroboration for quarantine, regardless of comparability');
  assert.equal(result.matched, false);
  assert.equal(flags.length, 1);
  assert.deepEqual(flags[0].discrepancy.hard_mismatches, ['yea: legiscan 119 vs primary 110'], 'the AGGREGATE\'s own yea (110), not the raw (wrong) cast-derived count (200), must be what is compared');
  assert.equal(flags[0].discrepancy.reason, 'hard_mismatch');
});

// ---- IMPORTANT 6 fix (final-review-findings.md): vote_reconciliation_flags writes are idempotent,
// keyed on (vote_id, source_a, source_b, roll_call_id, reason) — re-detecting the SAME discrepancy
// across re-runs must never insert a duplicate row, and a human-resolved row must stay resolved. ----

test('crossCheckAgainstPrimarySource: IMPORTANT 6 fix — 3 identical re-runs of the SAME discrepancy write exactly ONE flag row, never a duplicate per run', async () => {
  const primaryVoteId = 'primary-vote-idempotency';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 115), // real is 119 -> hard mismatch, same every run
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14),
    ],
  });
  await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(flags.length, 1, 'the SAME discrepancy (same vote, same LegiScan roll call, same classification) re-detected across 3 runs must dedupe to exactly one durable row');
});

test('crossCheckAgainstPrimarySource: FIX (2026-08-02, found live) — an existing flag whose roll_call_id was stored as a STRING (a different writer\'s type, e.g. a regex-parsed source_key never coerced to Number) is still recognized as the SAME discrepancy when re-detected with a NUMBER rollCallId — a real live legiscan run failed with an unhandled duplicate-key error because this comparison used strict === and missed exactly this type mismatch', async () => {
  const primaryVoteId = 'primary-vote-type-mismatch';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 115),
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14),
    ],
  });
  await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(flags.length, 1, 'first detection writes exactly one flag');
  // Simulate a DIFFERENT writer (this repo's own TODO-25 correction, live-confirmed) having stored
  // this exact discrepancy with roll_call_id as a string — the DB's unique index (::integer cast on
  // both sides) already treats this as the identical row; the app-level check must too.
  flags[0].discrepancy = { ...flags[0].discrepancy, roll_call_id: String(flags[0].discrepancy.roll_call_id) };
  await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(flags.length, 1, 'a differently-typed existing roll_call_id must still be recognized as the same discrepancy — never a second row, never an unhandled duplicate-key error');
});

test('crossCheckAgainstPrimarySource: IMPORTANT 6 fix — a human-resolved flag STAYS resolved across a re-run; re-detection never inserts a fresh resolved:false duplicate', async () => {
  const primaryVoteId = 'primary-vote-resolved-stays';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 115),
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14),
    ],
  });
  await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(flags.length, 1);
  flags[0].resolved = true; // simulates a human staff review resolving it

  await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);

  assert.equal(flags.length, 1, 'no new row — the pre-existing (now resolved) row must be found and reused, never duplicated');
  assert.equal(flags[0].resolved, true, 'resolution must be preserved, never reset by re-detection');
});

test('crossCheckAgainstPrimarySource: IMPORTANT 6 fix — a genuinely DIFFERENT LegiScan roll call flagging the SAME primary vote gets its OWN separate flag row (the idempotency key includes roll_call_id, never collapsing distinct discrepancies)', async () => {
  const primaryVoteId = 'primary-vote-distinct-rollcalls';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'senate', vote_date: '2018-09-14', source_key: 'mo-senate-web-2018-x-vote1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 1), // wildly mismatches BOTH 774411 (28-1) and 774412 (29-0)
    ],
  });
  const legiscanTallies774411 = reconcileLegiscanTallies(findRc(774411));
  const legiscanTallies774412 = reconcileLegiscanTallies(findRc(774412));
  await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774411); // senate, 2018-09-14
  await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774412); // ALSO senate, 2018-09-14, a DIFFERENT roll call
  assert.equal(flags.length, 2, 'two distinct LegiScan roll calls contradicting the same primary row must produce two distinct flags, not dedupe against each other');
  assert.deepEqual(flags.map((f) => f.discrepancy.roll_call_id).sort(), [774411, 774412]);
});

test('crossCheckAgainstPrimarySource: IMPORTANT 6 fix — a 23505 unique-violation from migration 0011\'s own index (a genuine post-migration race the app-level check missed) is caught and treated as "already exists", never surfaced as an error', async () => {
  const primaryVoteId = 'primary-vote-race';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 115),
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14),
    ],
    forceUniqueViolationOnce: true,
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.ok(result.flag, 'must return the row that won the race, not throw');
  assert.equal(result.flag.deduped, true);
  assert.equal(flags.length, 1, 'no duplicate row created — the raced-in row and the recheck result are the same row');
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

test('crossCheckAgainstPrimarySource: tally_unique_match ALWAYS carries primaryVoteId — the matched primary-source votes.id, for the dedup-marking caller to use', async () => {
  const { voteRows, castRows } = buildHb3HouseCandidates(HB3_HOUSE_TALLIES);
  const { client } = makeFakeVotesDb({ voteRows, castRows });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312);
  assert.equal(result.reason, 'tally_unique_match');
  // legiscanTallies774312 corresponds to HB3_HOUSE_TALLIES' ordinal 1 (yea:119/nay:23) ->
  // buildHb3HouseCandidates' own id convention: 'primary-hb3-1'.
  assert.equal(result.primaryVoteId, 'primary-hb3-1');
});

test('crossCheckAgainstPrimarySource: a FLAGGED (non-clean) result never carries primaryVoteId — the field is absent, not null, so a caller checking `in` never mistakes a flagged row for a clean match', async () => {
  const mismatchedTallies = { ...legiscanTallies774312, tallies: { yea: 999, nay: 999 } };
  const { voteRows, castRows } = buildHb3HouseCandidates(HB3_HOUSE_TALLIES);
  const { client } = makeFakeVotesDb({ voteRows, castRows });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', mismatchedTallies);
  assert.notEqual(result.reason, 'tally_unique_match');
  assert.equal('primaryVoteId' in result, false);
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

test('crossCheckAgainstPrimarySource: migration 0010 not applied (vote_reconciliation_flags relation missing) degrades gracefully — gated:true, discrepancy preserved, quarantine STILL reported correctly (false, IMPORTANT 5), NEVER thrown', async () => {
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
  assert.equal(result.quarantine, false, 'IMPORTANT 5 — singleton-ness alone is never grounds to quarantine, migration-gated or not; the gate only affects whether the flag can be DURABLY recorded, never the quarantine decision itself');
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

// ---- FIX ROUND (Task 9 review finding): the MIRROR of the same-day disambiguation above — ONE
// primary-source row, but MULTIPLE LegiScan roll calls in the current dataset share the exact same
// (bill, chamber, date) tuple. Found empirically during Task 9's own driver-level testing: without
// this, every one of the 5 real same-day HB3 roll calls would independently see the SAME single
// primary candidate and get compared against it in isolation, wrongly quarantining every one whose
// own tallies don't happen to match — not just the one that's genuinely contradicted. ----

const legiscanTallies774313 = reconcileLegiscanTallies(findRc(774313));
const legiscanTallies774314 = reconcileLegiscanTallies(findRc(774314));
const legiscanTallies774315 = reconcileLegiscanTallies(findRc(774315));
const legiscanTallies774316 = reconcileLegiscanTallies(findRc(774316));
const HB3_HOUSE_LEGISCAN_TALLIES = [
  { rollCallId: 774312, legiscanTallies: legiscanTallies774312 },
  { rollCallId: 774313, legiscanTallies: legiscanTallies774313 },
  { rollCallId: 774314, legiscanTallies: legiscanTallies774314 },
  { rollCallId: 774315, legiscanTallies: legiscanTallies774315 },
  { rollCallId: 774316, legiscanTallies: legiscanTallies774316 },
];

function siblingsExcluding(rollCallId) {
  return HB3_HOUSE_LEGISCAN_TALLIES
    .filter((e) => e.rollCallId !== rollCallId)
    .map((e) => ({ rollCallId: e.rollCallId, tallies: e.legiscanTallies.tallies }));
}

test('crossCheckAgainstPrimarySource: THE REVIEWER\'S EXACT SCENARIO — one primary row (774312\'s true tallies) + all 5 real same-day HB3 roll calls as each other\'s siblings -> 774312 alone verifies (tally_unique_match), the other 4 are simply uncorresponded (no flag, no quarantine, not treated as contradicted)', async () => {
  const primaryVoteId = 'primary-hb3-single';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 119),
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14),
    ],
  });

  const result312 = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312, siblingsExcluding(774312));
  assert.equal(result312.checked, true);
  assert.equal(result312.matched, true);
  assert.equal(result312.quarantine, false);
  assert.equal(result312.flag, null);
  assert.equal(result312.reason, 'tally_unique_match');
  assert.equal(result312.primaryVoteId, primaryVoteId, 'the tally-uniquely-selected candidate\'s own id must be reported, not just that a match happened');

  for (const rollCallId of [774313, 774314, 774315, 774316]) {
    const entry = HB3_HOUSE_LEGISCAN_TALLIES.find((e) => e.rollCallId === rollCallId);
    // eslint-disable-next-line no-await-in-loop
    const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', entry.legiscanTallies, siblingsExcluding(rollCallId));
    assert.equal(result.checked, true, `roll call ${rollCallId}`);
    assert.equal(result.matched, false, `roll call ${rollCallId} does not correspond to the primary — 774312 does`);
    assert.equal(result.quarantine, false, `roll call ${rollCallId} must NEVER be collateral-quarantined just because it shares the tuple with the one that DOES correspond`);
    assert.equal(result.flag, null, `roll call ${rollCallId} gets no flag — it is simply uncorresponded, not contradicted`);
    assert.equal(result.reason, 'corresponds_to_sibling');
  }

  assert.equal(flags.length, 0, 'exactly one flag-free run: the single genuine correspondence verified cleanly, everything else honestly deferred');
});

test('crossCheckAgainstPrimarySource: the ONE primary row matches NONE of the 5 same-day siblings -> every one that checks it gets store+flag "no_tally_corresponding_primary", never quarantined', async () => {
  const primaryVoteId = 'primary-hb3-no-match';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 999), // matches none of 119/36/33/41/96
      ...castRowsOfPosition(primaryVoteId, 'nay', 999),
    ],
  });

  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312, siblingsExcluding(774312));
  assert.equal(result.checked, true);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, false, 'no assertable 1:1 correspondence anywhere in the group -> never quarantine');
  assert.ok(result.flag);
  assert.equal(result.flag.discrepancy.reason, 'no_tally_corresponding_primary');
  assert.equal(result.flag.discrepancy.sibling_legiscan_roll_calls.length, 4);
  assert.equal(flags.length, 1);
});

test('crossCheckAgainstPrimarySource: this roll call AND a sibling both share the primary\'s exact tallies -> genuinely ambiguous which one corresponds -> store+flag "ambiguous_tally_match", never quarantined', async () => {
  const primaryVoteId = 'primary-hb3-ambiguous';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 119), // matches 774312's real tally exactly
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14),
    ],
  });
  // A synthetic "sibling" that happens to share 774312's own real (yea, nay) — genuinely possible
  // (two procedural votes with an identical head count), not assumed impossible; this is data the
  // caller (the driver) constructs from ITS OWN dataset, not something this function invents.
  const siblingsWithCollision = [
    { rollCallId: 774313, tallies: { yea: 119, nay: 23, not_voting: 0, absent: 14, total: 156 } },
    ...siblingsExcluding(774312).filter((s) => s.rollCallId !== 774313),
  ];

  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312, siblingsWithCollision);
  assert.equal(result.checked, true);
  assert.equal(result.matched, false);
  assert.equal(result.quarantine, false, 'ambiguity is never grounds to quarantine — every match AGREES on the tally, it\'s which row corresponds that\'s unresolved');
  assert.ok(result.flag);
  assert.equal(result.flag.discrepancy.reason, 'ambiguous_tally_match');
  assert.deepEqual(
    result.flag.discrepancy.matching_legiscan_roll_calls.map((c) => c.roll_call_id).sort(),
    [774312, 774313],
  );
  assert.equal(flags.length, 1);
});

test('crossCheckAgainstPrimarySource: siblingTallies defaulting to [] still takes the singleton (Branch B) path — IMPORTANT 5 fix means a genuine hard mismatch there stores + flags, never quarantines, proving the omitted-4th-arg call site is unaffected by argument shape, only by the Finding 5 behavior change itself', async () => {
  const primaryVoteId = 'primary-vote-no-siblings';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 115), // real is 119 -> hard mismatch
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14),
    ],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312); // no 4th arg at all
  assert.equal(result.quarantine, false, 'IMPORTANT 5 — a lone (no-sibling) roll call with a hard mismatch stores + flags, never quarantines');
  assert.equal(result.matched, false);
  assert.equal(flags.length, 1);
  assert.deepEqual(flags[0].discrepancy.hard_mismatches, ['yea: legiscan 119 vs primary 115']);
});

// Vote-duplicate dedup (2026-08-03) — the singleton/singleton clean-match branch (Branch B's own
// happy path) carries NO `reason` at all (found live, during Task 3's own test run: a
// reason-string-based gate silently missed this branch entirely, since it's the ONE clean-match
// return site that predates the tally_unique_match disambiguation branches and was never given a
// reason string). `matched: true` is the correct, existing signal every clean-match branch sets —
// this locks in that `primaryVoteId` is ALSO present here, not just on the two reason-carrying
// branches already covered above.
test('crossCheckAgainstPrimarySource: the plain singleton/singleton clean match (no siblings on either side, tallies genuinely agree) carries primaryVoteId even though it carries no `reason` at all', async () => {
  const primaryVoteId = 'primary-vote-no-siblings-clean';
  const { client, flags } = makeFakeVotesDb({
    voteRows: [{
      id: primaryVoteId, bill_id: 'bill-hb3', jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
    }],
    castRows: [
      ...castRowsOfPosition(primaryVoteId, 'yea', 119), // matches legiscanTallies774312 exactly
      ...castRowsOfPosition(primaryVoteId, 'nay', 23),
      ...castRowsOfPosition(primaryVoteId, 'absent', 14),
    ],
  });
  const result = await crossCheckAgainstPrimarySource(client, 'bill-hb3', legiscanTallies774312); // no 4th arg — no siblings
  assert.equal(result.matched, true);
  assert.equal(result.quarantine, false);
  assert.equal(result.flag, null);
  assert.equal('reason' in result, false, 'this specific branch has never set reason — a dedup gate must not rely on it');
  assert.equal(result.primaryVoteId, primaryVoteId);
  assert.equal(flags.length, 0);
});

test('VOTE_TEXT_BY_ID: vote_id 3 accepts BOTH evidenced live forms ("NV") and the schema long form ("Not Voting")', () => {
  // First live sweep (2026-07-29): every real vote_id-3 cast printed "NV", not schema-mysql.sql's
  // "Not Voting" — 1,817 roll calls correctly refused by the strict-equality version of the check.
  // Both evidenced forms now pass; any OTHER live variant must still throw.
  const base = { roll_call_id: 1, bill_id: 1, yea: 1, nay: 0, nv: 1, absent: 0, total: 2, chamber: 'S', date: '2018-01-01', desc: 'x' };
  for (const form of ['NV', 'Not Voting']) {
    const rc = { ...base, votes: [
      { people_id: 1, vote_id: 1, vote_text: 'Yea' },
      { people_id: 2, vote_id: 3, vote_text: form },
    ] };
    const out = reconcileLegiscanTallies(rc);
    assert.equal(out.tallies.not_voting, 1, 'form "' + form + '" must reconcile');
  }
  const bad = { ...base, votes: [
    { people_id: 1, vote_id: 1, vote_text: 'Yea' },
    { people_id: 2, vote_id: 3, vote_text: 'N.V.' },
  ] };
  assert.throws(() => reconcileLegiscanTallies(bad), (e) => e.name === 'VoteIdMapError');
});

// ---- 2026-08-23: dating LegiScan's undated roll calls from the bill's own printed history ----
//
// LegiScan prints every 2024 MO House floor roll call (275 of the session's 351) with the date
// sentinel 0000-00-00 — in the bulk dataset AND from getRollCall (spot-checked live 2026-08-23) —
// so the date guard above refused them all. The bill's HISTORY, in the same dataset, prints the
// floor actions WITH dates and tallies: "2024-03-27 Third Read and Passed (H) - AYES: 108 NOES: 46".
// Tier 1 rule (Lance, 2026-08-23, "proceed as you would recommend"): a sentinel-dated roll call
// takes the date of the ONE House/Senate action whose printed AYES/NOES equal its own yea/nay;
// zero or several matches -> still refused. Fixture: four real 2024 bills + their 23 roll calls.
const undated2024 = JSON.parse(readFileSync(`${FIXDIR}/mo-2024-undated-rollcalls.json`, 'utf8'));
const bill2024 = (number) => undated2024.bills.find((b) => b.bill_number === number);
const rc2024 = (id) => undated2024.rollCalls.find((r) => r.roll_call_id === id);
const years2024 = { yearStart: undated2024.session.year_start, yearEnd: undated2024.session.year_end };

test('deriveDateFromHistory: exactly one dated House action printing this roll call\'s AYES/NOES -> that date, with the action as the receipt (HB 1413 third reading, 108-46)', () => {
  const d = deriveDateFromHistory(rc2024(1416690), bill2024('HB1413').history);
  assert.equal(d.date, '2024-03-27');
  assert.equal(d.source, 'legiscan_history_tally_match');
  assert.equal(d.action.date, '2024-03-27');
  assert.match(d.action.action, /^Third Read and Passed \(H\) - AYES: 108 NOES: 46/);
  assert.equal(d.action.chamber, 'H');
});

test('deriveDateFromHistory: a perfection vote whose "Perfected (H)" action prints no tally -> null (never a stage-day guess)', () => {
  assert.equal(deriveDateFromHistory(rc2024(1408305), bill2024('HB1413').history), null);
});

test('deriveDateFromHistory: two dated actions with the same tally (HB 1912, 151-0 third reading AND 151-0 adoption of SS) -> null, ambiguity is refused', () => {
  assert.equal(deriveDateFromHistory(rc2024(1399425), bill2024('HB1912').history), null);
  assert.equal(deriveDateFromHistory(rc2024(1441817), bill2024('HB1912').history), null);
});

test('deriveDateFromHistory: the acting chamber is the action text\'s (H)/(S) suffix, never LegiScan\'s history tag; the same tally printed twice anywhere in the history is ambiguous', () => {
  // Real shape (HB 2634, 2024): "Third Read and Passed (S) - AYES: 23 NOES: 10" carries the TAG H.
  const senateActionTaggedHouse = [{ date: '2024-04-09', action: 'Third Read and Passed (S) - AYES: 23 NOES: 10 PRESENT: 0', chamber: 'H' }];
  assert.equal(deriveDateFromHistory({ roll_call_id: 1, chamber: 'H', date: '0000-00-00', yea: 23, nay: 10 }, senateActionTaggedHouse), null, 'a House vote never takes a Senate action\'s date, whatever the tag says');
  const s = deriveDateFromHistory({ roll_call_id: 1, chamber: 'S', date: '0000-00-00', yea: 23, nay: 10 }, senateActionTaggedHouse);
  assert.equal(s.date, '2024-04-09');
  assert.equal(s.action.chamber, 'S');
  assert.equal(s.action.chamber_source, 'action_suffix');
  // Two actions printing the same tally — one per chamber — are ambiguous for BOTH chambers
  // (ambiguity is counted over the whole history before any chamber filter).
  const both = [
    { date: '2024-04-09', action: 'Third Read and Passed (S) - AYES: 23 NOES: 10 PRESENT: 0', chamber: 'S' },
    { date: '2024-03-04', action: 'Third Read and Passed (H) - AYES: 23 NOES: 10 PRESENT: 0', chamber: 'H' },
  ];
  assert.equal(deriveDateFromHistory({ roll_call_id: 1, chamber: 'H', date: '0000-00-00', yea: 23, nay: 10 }, both), null);
  assert.equal(deriveDateFromHistory({ roll_call_id: 1, chamber: 'S', date: '0000-00-00', yea: 23, nay: 10 }, both), null);
  // A suffix-less action ("Truly Agreed To and Finally Passed - AYES ...") counts only when its tag
  // agrees with the roll call's chamber.
  const tafpTaggedH = [{ date: '2024-05-09', action: 'Truly Agreed To and Finally Passed - AYES: 148 NOES: 0 PRESENT: 0', chamber: 'H' }];
  const t = deriveDateFromHistory({ roll_call_id: 1, chamber: 'H', date: '0000-00-00', yea: 148, nay: 0 }, tafpTaggedH);
  assert.equal(t.date, '2024-05-09');
  assert.equal(t.action.chamber_source, 'history_tag');
  assert.equal(deriveDateFromHistory({ roll_call_id: 1, chamber: 'H', date: '0000-00-00', yea: 148, nay: 0 }, [{ ...tafpTaggedH[0], chamber: 'S' }]), null);
});

test('deriveDateFromHistory: two-sided uniqueness — a sibling roll call of the same bill and chamber printing the same tally refuses both (HB 2634\'s 106-48 pair), while a lone sibling-free tally dates', () => {
  const hb2634 = bill2024('HB2634');
  // the real history already prints a suffix-less 106-48 ("Truly Agreed To and Finally Passed",
  // tagged S) — drop it so the doctored (H) action is the ONLY 106-48 candidate and the sibling
  // rule, not ambiguity, is what decides
  const withoutTafp = hb2634.history.filter((h) => !/AYES: 106 NOES: 48/.test(h.action));
  const doctored = [...withoutTafp, { date: '2024-04-24', action: 'House Adopts (H) - SS#2 AYES: 106 NOES: 48 PRESENT: 0', chamber: 'H' }];
  const siblings = undated2024.rollCalls.filter((r) => r.bill_id === hb2634.bill_id);
  assert.equal(deriveDateFromHistory(rc2024(1433443), doctored, siblings), null, '1433443 shares 106-48 with 1433445');
  assert.equal(deriveDateFromHistory(rc2024(1433445), doctored, siblings), null);
  assert.equal(deriveDateFromHistory(rc2024(1433443), doctored, []).date, '2024-04-24', 'without siblings the same action would date it — the sibling rule is what refuses');
  // the real 1433444 (106-49) is unique among its siblings and its action is House-suffixed but
  // tagged S in LegiScan's data — dated 2024-04-24 by the suffix rule
  const real = deriveDateFromHistory(rc2024(1433444), hb2634.history, siblings);
  assert.equal(real.date, '2024-04-24');
  assert.equal(real.action.chamber_source, 'action_suffix');
});

test('deriveDateFromHistory: a candidate whose own date is a sentinel or not a real calendar date never matches; yea/nay must be genuine non-negative integers', () => {
  const action = (date) => [{ date, action: 'Third Read and Passed (H) - AYES: 108 NOES: 46 PRESENT: 0', chamber: 'H' }];
  const rc = { roll_call_id: 1, chamber: 'H', date: '0000-00-00', yea: 108, nay: 46 };
  assert.equal(deriveDateFromHistory(rc, action('0000-00-00')), null);
  assert.equal(deriveDateFromHistory(rc, action('1969-12-31')), null);
  assert.equal(deriveDateFromHistory(rc, action('2024-13-45')), null);
  assert.equal(deriveDateFromHistory(rc, action('2024-02-30')), null);
  assert.equal(deriveDateFromHistory(rc, action('2024-02-29')).date, '2024-02-29');
  const zero = [{ date: '2024-02-29', action: 'Motion Adopted (H) - AYES: 0 NOES: 0 PRESENT: 0', chamber: 'H' }];
  for (const bad of [{ yea: null, nay: null }, { yea: '', nay: '' }, { yea: [0], nay: [0] }, { yea: false, nay: false }, { yea: -0.5, nay: 0 }]) {
    assert.equal(deriveDateFromHistory({ roll_call_id: 1, chamber: 'H', date: '0000-00-00', ...bad }, zero), null, JSON.stringify(bad));
  }
  assert.equal(deriveDateFromHistory({ roll_call_id: 1, chamber: 'H', date: '0000-00-00', yea: 0, nay: 0 }, zero).date, '2024-02-29');
  assert.equal(deriveDateFromHistory({ roll_call_id: 1, chamber: 'H', date: '0000-00-00', yea: '0', nay: '0' }, zero).date, '2024-02-29');
});

test('reconcileLegiscanTallies: the 1969-12-31 sentinel derives like 0000-00-00 does, and a refused DERIVED date is reported as derived, not printed', () => {
  const rc = { ...rc2024(1416690), date: '1969-12-31' };
  const r = reconcileLegiscanTallies(rc, years2024, { history: bill2024('HB1413').history });
  assert.equal(r.date, '2024-03-27');
  assert.equal(r.dateProvenance.printed_date, '1969-12-31');
  assert.throws(() => reconcileLegiscanTallies(rc, years2024), (err) => err instanceof LegiscanRollCallDateError && err.reason === 'outside_session_years' && err.derived === false);
  const wrongYear = [{ date: '2019-03-27', action: 'Third Read and Passed (H) - AYES: 108 NOES: 46 PRESENT: 0', chamber: 'H' }];
  assert.throws(() => reconcileLegiscanTallies(rc, years2024, { history: wrongYear }), (err) => err instanceof LegiscanRollCallDateError && err.reason === 'outside_session_years' && err.derived === true && /derived date 2019-03-27/.test(err.message));
});

test('deriveDateFromHistory: the tally must match as whole numbers (AYES: 108 never matches yea 10 or 1080), and a reconsideration action carrying a tally is a legitimate match (HB 1886, 131-5)', () => {
  const history = [{ date: '2024-03-01', action: 'Third Read and Passed (H) - AYES: 108 NOES: 46 PRESENT: 0', chamber: 'H' }];
  assert.equal(deriveDateFromHistory({ roll_call_id: 1, chamber: 'H', date: '0000-00-00', yea: 10, nay: 46 }, history), null);
  assert.equal(deriveDateFromHistory({ roll_call_id: 1, chamber: 'H', date: '0000-00-00', yea: 108, nay: 4 }, history), null);
  const d = deriveDateFromHistory(rc2024(1391718), bill2024('HB1886').history);
  assert.equal(d.date, '2024-02-22');
  assert.match(d.action.action, /Motion to Reconsider Adopted \(H\).*AYES: 131 NOES: 5/);
});

test('deriveDateFromHistory: a printed date is never overridden — only the known sentinels are derived', () => {
  const dated = rc2024(1441522); // Senate third reading, 2024-05-08, printed
  assert.equal(dated.date, '2024-05-08');
  assert.equal(deriveDateFromHistory(dated, bill2024('HB1912').history), null);
  assert.deepEqual(LEGISCAN_MISSING_DATE_SENTINELS, ['0000-00-00', '1969-12-31']);
});

test('reconcileLegiscanTallies: with the bill history, a sentinel-dated roll call reconciles under the derived date and carries dateProvenance', () => {
  const r = reconcileLegiscanTallies(rc2024(1416690), years2024, { history: bill2024('HB1413').history });
  assert.equal(r.date, '2024-03-27');
  assert.equal(r.dateProvenance.source, 'legiscan_history_tally_match');
  assert.equal(r.dateProvenance.printed_date, '0000-00-00');
  assert.equal(r.dateProvenance.action.date, '2024-03-27');
  assert.match(r.dateProvenance.action.action, /AYES: 108 NOES: 46/);
  assert.equal(r.tallies.yea, 108);
  assert.equal(r.tallies.nay, 46);
  assert.equal(r.casts.length, r.tallies.total);
});

test('reconcileLegiscanTallies: a printed date carries NO dateProvenance; a sentinel with no unique tally match is still refused by the session-years guard', () => {
  const printed = reconcileLegiscanTallies(rc2024(1441522), years2024, { history: bill2024('HB1912').history });
  assert.equal(printed.date, '2024-05-08');
  assert.equal(printed.dateProvenance, null);
  // '0000-00-00' has the YYYY-MM-DD SHAPE, so the pre-existing guard refuses it one step later as
  // outside_session_years (year 0) — unchanged behaviour, with or without the history in hand.
  assert.throws(() => reconcileLegiscanTallies(rc2024(1408305), years2024, { history: bill2024('HB1413').history }), (err) => err instanceof LegiscanRollCallDateError && err.reason === 'outside_session_years');
  assert.throws(() => reconcileLegiscanTallies(rc2024(1408305), years2024), (err) => err instanceof LegiscanRollCallDateError && err.reason === 'outside_session_years');
});

test('reconcileLegiscanTallies: a derived date still has to fall inside the dataset\'s own session years', () => {
  const rc = { ...rc2024(1416690) };
  const history = [{ date: '2019-03-27', action: 'Third Read and Passed (H) - AYES: 108 NOES: 46 PRESENT: 0', chamber: 'H' }];
  assert.throws(() => reconcileLegiscanTallies(rc, years2024, { history }), (err) => err instanceof LegiscanRollCallDateError && err.reason === 'outside_session_years');
});

test('2024 corpus (fixture): the Tier 1 rule dates exactly the roll calls it should — 9 of the 20 undated, never an ambiguous or tally-less one', () => {
  const dated = [];
  const refused = [];
  for (const rc of undated2024.rollCalls.filter((r) => r.date === '0000-00-00')) {
    const bill = undated2024.bills.find((b) => b.bill_id === rc.bill_id);
    const siblings = undated2024.rollCalls.filter((r) => r.bill_id === rc.bill_id);
    const d = deriveDateFromHistory(rc, bill.history, siblings);
    (d ? dated : refused).push(rc.roll_call_id);
  }
  // ground truth read off the fixture's own history actions (2026-08-23): 8 dated, 12 refused —
  // 1387728 (108-47) has no tallied action; 1389792 shows some 'Perfected (H)' actions DO print a
  // tally (150-0) and are then legitimately matched.
  // 1433444 (HB 2634, 106-49) joins after the review hardening: its "House Adopts (H) - SS#2"
  // action is House-suffixed but tagged S by LegiScan; the suffix rule dates it 2024-04-24.
  assert.deepEqual(dated, [1416690, 1387729, 1391718, 1427484, 1389792, 1441818, 1402442, 1402443, 1433444]);
  assert.equal(refused.length, 11);
});
