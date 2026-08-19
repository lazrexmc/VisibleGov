import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMoCitationBackfill } from '../src/cli/backfill-mo-glossary-citations.js';

const T = (id, term, extra = {}) => ({
  id, term, kind: 'statute', citation: null, needs_mapping: true, gloss_md: null,
  created_at: '2026-08-01T00:00:00Z', hasVerifications: false, hasNotes: false, ...extra,
});
const MO = 'mo-legislature'; const FED = 'us-congress';

test('update in place: a clean MO-referenced section term maps', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'section 536.010')],
    linksByTermId: new Map([['t1', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.deepEqual(plan.updates, [{ id: 't1', term: 'section 536.010', citation: 'RSMo 536.010' }]);
  assert.deepEqual(plan.merges, []);
});

test('jurisdiction guard: mixed or federal references never map; zero links never map', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'chapter 303'), T('t2', 'section 33.080'), T('t3', '302.309')],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s2']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', FED]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skips.guardBlocked, 2);
  assert.equal(plan.skips.zeroLinks, 1);
});

test('intra-batch collision: most-linked row survives; tie -> earliest created_at -> smallest id', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('t1', 'section 536.010'),
      T('t2', '536.010, RSMo', { created_at: '2026-07-01T00:00:00Z' }),
    ],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s3']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', MO], ['s3', MO]]),
  });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, 't1'); // most links wins despite t2 being older
  assert.deepEqual(plan.merges, [{ survivorId: 't1', loserId: 't2', citation: 'RSMo 536.010', linkMoves: ['s3'] }]);
});

test('collision with an existing mapped row: the mapped row always survives', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('m1', 'ignored', { citation: 'RSMo 536.010', needs_mapping: false }),
      T('t1', 'section 536.010'),
    ],
    linksByTermId: new Map([['t1', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.deepEqual(plan.merges, [{ survivorId: 'm1', loserId: 't1', citation: 'RSMo 536.010', linkMoves: ['s1'] }]);
});

test('stub assertion: a merge loser with gloss content/verifications/notes is skipped, never merged', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('t1', 'section 536.010'),
      T('t2', '536.010', { hasVerifications: true }),
    ],
    linksByTermId: new Map([['t1', ['s1', 's2']], ['t2', ['s3']]]),
    jurisdictionBySummaryId: new Map([['s1', MO], ['s2', MO], ['s3', MO]]),
  });
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.skips.stubViolations.length, 1);
  assert.equal(plan.skips.stubViolations[0].id, 't2');
  assert.equal(plan.updates.length, 1); // the survivor still updates
});

test('kinds are separate namespaces: same citation under different kinds never merges', () => {
  const plan = planMoCitationBackfill({
    terms: [T('t1', 'section 536.010'), T('t2', 'section 536.010', { kind: 'program' })],
    linksByTermId: new Map([['t1', ['s1']], ['t2', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 2);
  assert.equal(plan.merges.length, 0);
});

test('already-mapped rows and unparseable terms are never updates', () => {
  const plan = planMoCitationBackfill({
    terms: [
      T('m1', 'x', { citation: '42 U.S.C. 1396b', needs_mapping: false }),
      T('t1', 'sections 302.302 to 302.309'),
      T('t2', 'RSMo'),
    ],
    linksByTermId: new Map([['t1', ['s1']], ['t2', ['s1']]]),
    jurisdictionBySummaryId: new Map([['s1', MO]]),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.skips.parseFailed, 2);
});
