import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  convenesOn, parseOrdinal, sessionYear, classifyMoSessionRow, classifyOpenStatesSession,
  planSessionDates, sessionRecencyKey, MO_CONST_SOURCE, OPENSTATES_SOURCE, LEGISCAN_ACTION_SOURCE, BOTH_SOURCES,
} from '../src/lib/session-dates.js';
import { parseSessions } from '../src/adapters/mo-legislature.js';

// The real OpenStates jurisdiction fixture (tests/fixtures/mo-legislature/sessions.json) — 26
// Missouri sessions 2012-2026 with published dates, including the specials.
const OPENSTATES = parseSessions(JSON.parse(readFileSync('tests/fixtures/mo-legislature/sessions.json', 'utf8')));

const MO = 'mo-legislature';
const row = (identifier, name, extra = {}) => ({ id: `id-${identifier}`, jurisdiction_id: MO, identifier, name, start_date: null, ...extra });

test('convenesOn: first Wednesday after the first Monday in January (Mo. Const. art. III §20), every weekday case', () => {
  // Jan 1 falls on: Sun 2012, Mon 2018, Tue 2013, Wed 2014, Thu 2015, Fri 2016, Sat 2022
  assert.equal(convenesOn(2012), '2012-01-04');
  assert.equal(convenesOn(2018), '2018-01-03');
  assert.equal(convenesOn(2013), '2013-01-09');
  assert.equal(convenesOn(2014), '2014-01-08');
  assert.equal(convenesOn(2015), '2015-01-07');
  assert.equal(convenesOn(2016), '2016-01-06');
  assert.equal(convenesOn(2022), '2022-01-05');
  assert.equal(convenesOn(2026), '2026-01-07');
  assert.throws(() => convenesOn(1980), /outside the 1988 rule/);
});

test('convenesOn agrees with every OpenStates-published regular-session start except 2018 (prefiling date)', () => {
  const regular = OPENSTATES.filter((s) => /^\d{4}$/.test(s.identifier));
  assert.ok(regular.length >= 14);
  const disagreements = regular.filter((s) => s.start_date !== convenesOn(Number(s.identifier))).map((s) => s.identifier);
  assert.deepEqual(disagreements, ['2018']);
});

test('parseOrdinal and sessionYear read our names and identifiers', () => {
  assert.equal(parseOrdinal('2025 1st Special Session'), 1);
  assert.equal(parseOrdinal('2017 Second Extraordinary Session'), 2);
  assert.equal(parseOrdinal('2025 Regular Session'), null);
  assert.equal(sessionYear({ identifier: '2025-special-2216', name: '2025 1st Special Session' }), 2025);
  assert.equal(sessionYear({ identifier: '261', name: '2026 2nd Regular, 103rd General Assembly' }), 2026);
  assert.equal(sessionYear({ identifier: '119', name: '119th Congress' }), null);
});

test('classifyMoSessionRow: bare-year regular, the 261 case, specials by ordinal; unclassifiable -> null', () => {
  assert.deepEqual(classifyMoSessionRow(row('2025', '2025 Regular Session')), { year: 2025, kind: 'regular', ordinal: null });
  assert.deepEqual(classifyMoSessionRow(row('261', '2026 2nd Regular, 103rd General Assembly')), { year: 2026, kind: 'regular', ordinal: null });
  assert.deepEqual(classifyMoSessionRow(row('2025-special-2226', '2025 2nd Special Session')), { year: 2025, kind: 'special', ordinal: 2 });
  assert.deepEqual(classifyMoSessionRow(row('2018', '2018 Regular Session (MO Senate journals)')), { year: 2018, kind: 'regular', ordinal: null });
  assert.equal(classifyMoSessionRow(row('2019-special-1711', 'Special Session')), null, 'a special with no year is unclassifiable');
  assert.equal(classifyMoSessionRow(row('x', null)), null);
});

test('classifyOpenStatesSession ignores the unreliable classification field and reads YYYYS<n>', () => {
  assert.deepEqual(classifyOpenStatesSession({ identifier: '2020S2', name: '2020 Second Extraordinary Session' }), { year: 2020, kind: 'special', ordinal: 2 });
  assert.deepEqual(classifyOpenStatesSession({ identifier: '2024' }), { year: 2024, kind: 'regular', ordinal: null });
  assert.equal(classifyOpenStatesSession({ identifier: 'weird' }), null);
});

test('planSessionDates: regular sessions get the constitutional date (source recorded), OpenStates corroborates, 2018 disagreement is recorded', () => {
  const plan = planSessionDates({ rows: [row('2025', '2025 Regular Session'), row('2018', '2018 Regular Session (MO Senate journals)'), row('2010', '2010 Regular Session')], openstates: OPENSTATES });
  const by = Object.fromEntries(plan.patches.map((p) => [p.identifier, p]));
  assert.equal(by['2025'].start_date, '2025-01-08');
  assert.equal(by['2025'].source, MO_CONST_SOURCE);
  assert.deepEqual(by['2025'].notes, []);
  assert.equal(by['2018'].start_date, '2018-01-03');
  assert.match(by['2018'].notes[0], /2017-12-01/);
  assert.equal(by['2010'].start_date, '2010-01-06');
  assert.match(by['2010'].notes[0], /no OpenStates entry/);
  assert.equal(plan.corroboration.regularAgree, 1);
  assert.deepEqual(plan.corroboration.regularDisagree, [{ identifier: '2018', openstates: '2017-12-01', rule: '2018-01-03' }]);
});

test('planSessionDates: specials come from OpenStates by year+ordinal when no LegiScan dataset is on hand; specials with NEITHER source stay NULL and are reported', () => {
  const plan = planSessionDates({ rows: [row('2025-special-2216', '2025 1st Special Session'), row('2020-special-1774', '2020 2nd Special Session'), row('2013-special-1094', '2013 1st Special Session')], openstates: OPENSTATES });
  const by = Object.fromEntries(plan.patches.map((p) => [p.identifier, p]));
  assert.equal(by['2025-special-2216'].start_date, '2025-06-02');
  assert.equal(by['2025-special-2216'].source, OPENSTATES_SOURCE);
  assert.equal(by['2025-special-2216'].openstates_identifier, '2025S1');
  assert.match(by['2025-special-2216'].notes[0], /no LegiScan dataset on hand/);
  assert.equal(by['2020-special-1774'].start_date, '2020-11-05');
  assert.equal(plan.unmatched.length, 1);
  assert.equal(plan.unmatched[0].identifier, '2013-special-1094');
});

test('planSessionDates: the OpenStates 2022S1 end-before-start typo is noted and never written; end_date is never in a patch', () => {
  const plan = planSessionDates({ rows: [row('2022-special-1995', '2022 1st Special Session')], openstates: OPENSTATES });
  assert.equal(plan.patches.length, 1);
  assert.equal(plan.patches[0].start_date, '2022-09-15');
  assert.match(plan.patches[0].notes[0], /2021-09-23 precedes/);
  for (const p of plan.patches) assert.equal('end_date' in p, false);
});

test('planSessionDates: a special takes the EARLIER of OpenStates and LegiScan earliest action, naming the source (the real 2017/2018/2022 cases)', () => {
  const rows = [
    row('2017-special-1460', '2017 1st Special Session'), // OpenStates 2017-06-01; LegiScan 2017-05-22 (the session convened May 22)
    row('2018-special-1579', '2018 1st Special Session'), // OpenStates 2018-05-21; LegiScan 2018-05-18
    row('2025-special-2226', '2025 2nd Special Session'), // both 2025-09-03
    row('2020-special-1758', '2020 1st Special Session'), // OpenStates 2020-07-27; LegiScan later (corroborates)
    row('2013-special-1094', '2013 1st Special Session'), // no OpenStates entry; LegiScan 2013-12-02
  ];
  const plan = planSessionDates({
    rows, openstates: OPENSTATES,
    legiscanEarliestAction: new Map([
      ['id-2017-special-1460', '2017-05-22'], ['id-2018-special-1579', '2018-05-18'],
      ['id-2025-special-2226', '2025-09-03'], ['id-2020-special-1758', '2020-07-30'], ['id-2013-special-1094', '2013-12-02'],
    ]),
  });
  const by = Object.fromEntries(plan.patches.map((p) => [p.identifier, p]));
  assert.equal(plan.patches.length, 5);
  assert.equal(plan.unmatched.length, 0);
  assert.equal(by['2017-special-1460'].start_date, '2017-05-22');
  assert.equal(by['2017-special-1460'].source, LEGISCAN_ACTION_SOURCE);
  assert.match(by['2017-special-1460'].notes[0], /openstates publishes 2017-06-01/);
  assert.equal(by['2018-special-1579'].start_date, '2018-05-18');
  assert.equal(by['2025-special-2226'].start_date, '2025-09-03');
  assert.equal(by['2025-special-2226'].source, BOTH_SOURCES);
  assert.match(by['2025-special-2226'].notes[0], /both sources agree: LegiScan's earliest recorded action 2025-09-03/);
  // a LATER first action neither contradicts nor corroborates: OpenStates alone, and the note says so
  assert.equal(by['2020-special-1758'].start_date, '2020-07-27');
  assert.equal(by['2020-special-1758'].source, OPENSTATES_SOURCE);
  assert.match(by['2020-special-1758'].notes[0], /3 days after the OpenStates start — not contradicted, not corroborated/);
  assert.equal(by['2013-special-1094'].start_date, '2013-12-02');
  assert.equal(by['2013-special-1094'].source, LEGISCAN_ACTION_SOURCE);
  assert.equal(plan.corroboration.specialAgree, 1, 'only an IDENTICAL date counts as agreement');
  assert.deepEqual(plan.corroboration.specialLegiscanEarlier.map((x) => x.identifier), ['2017-special-1460', '2018-special-1579']);
  assert.deepEqual(plan.corroboration.specialLegiscanLater, [{ identifier: '2020-special-1758', openstates: '2020-07-27', legiscan: '2020-07-30', days: 3 }]);
  // a regular session never takes the LegiScan date (its earliest action is the Dec 1 prefiling)
  const reg = planSessionDates({ rows: [row('2025', '2025 Regular Session')], openstates: OPENSTATES, legiscanEarliestAction: new Map([['id-2025', '2024-12-01']]) });
  assert.equal(reg.patches[0].start_date, '2025-01-08');
  assert.equal(reg.patches[0].source, MO_CONST_SOURCE);
});

test('planSessionDates: a LegiScan record form names its evidence in the note; an OUT-OF-YEAR LegiScan date is a stray — reported, never written', () => {
  const rows = [row('2017-special-1460', '2017 1st Special Session'), row('2013-special-1094', '2013 1st Special Session')];
  const plan = planSessionDates({
    rows, openstates: OPENSTATES,
    legiscanEarliestAction: new Map([
      ['id-2017-special-1460', { date: '2016-01-06', bill_number: 'HR9', action: 'Offered (H)', file: '1460-x.json' }], // the real stray shape seen in the 2017 Regular dataset
      ['id-2013-special-1094', { date: '2012-10-17', bill_number: 'HB3001', action: 'Message Received from the Governor', file: '1094-y.json' }],
    ]),
  });
  const by = Object.fromEntries(plan.patches.map((p) => [p.identifier, p]));
  // OpenStates exists for 2017 S1 -> its date is written alone, with the stray named
  assert.equal(by['2017-special-1460'].start_date, '2017-06-01');
  assert.equal(by['2017-special-1460'].source, OPENSTATES_SOURCE);
  assert.match(by['2017-special-1460'].notes[0], /2016-01-06 \(HR9 Offered \(H\), 1460-x.json\) lies outside 2017 — treated as a stray entry, not used/);
  // no OpenStates entry for 2013 S1 and the only LegiScan date is out of year -> stays NULL, reported
  assert.equal(by['2013-special-1094'], undefined);
  assert.equal(plan.unmatched.length, 1);
  assert.equal(plan.unmatched[0].identifier, '2013-special-1094');
  assert.match(plan.unmatched[0].notes[0], /lies outside 2013/);
  assert.deepEqual(plan.corroboration.legiscanOutOfYear.map((x) => x.identifier), ['2017-special-1460', '2013-special-1094']);
  // the record form also names the evidence on the happy path
  const ok = planSessionDates({ rows: [row('2017-special-1460', '2017 1st Special Session')], openstates: OPENSTATES, legiscanEarliestAction: new Map([['id-2017-special-1460', { date: '2017-05-22', bill_number: 'HB2', action: 'Introduced and Read First Time (H)', file: '1460-x.json' }]]) });
  assert.equal(ok.patches[0].start_date, '2017-05-22');
  assert.match(ok.patches[0].notes[0], /2017-05-22 \(HB2 Introduced and Read First Time \(H\), 1460-x.json\)/);
});

test('classifyMoSessionRow: a MO House session code must agree with the name year (261 = 2026); a stale name is unclassified, not dated', () => {
  assert.deepEqual(classifyMoSessionRow(row('261', '2026 2nd Regular, 103rd General Assembly')), { year: 2026, kind: 'regular', ordinal: null });
  assert.equal(classifyMoSessionRow(row('271', '2026 2nd Regular, 103rd General Assembly')), null, "code says 2027, name says 2026");
  const plan = planSessionDates({ rows: [row('271', '2026 2nd Regular, 103rd General Assembly')], openstates: OPENSTATES });
  assert.equal(plan.patches.length, 0);
  assert.deepEqual(plan.unclassified.map((u) => u.identifier), ['271']);
});

test('planSessionDates is additive: dated rows are untouched; non-MO rows are ignored; unclassifiable rows are reported', () => {
  const plan = planSessionDates({
    rows: [row('2022', '2022 Regular Session', { start_date: '2022-01-05' }), { id: 'us', jurisdiction_id: 'us-congress', identifier: '119', name: '119th Congress', start_date: null }, row('odd', 'Session')],
    openstates: OPENSTATES,
  });
  assert.equal(plan.patches.length, 0);
  assert.deepEqual(plan.unchanged.map((u) => u.identifier), ['2022']);
  assert.deepEqual(plan.unclassified.map((u) => u.identifier), ['odd']);
});

test('planSessionDates over the real 31-row shape (no LegiScan data): 27 patches, 3 unmatched (2010/2011/2013 specials), 1 unchanged', () => {
  const rows = [
    row('2010', '2010 Regular Session'), row('2010-special-497', '2010 1st Special Session'),
    row('2011', '2011 Regular Session'), row('2011-special-498', '2011 1st Special Session'),
    row('2012', '2012 Regular Session'), row('2013', '2013 Regular Session'), row('2013-special-1094', '2013 1st Special Session'),
    row('2014', '2014 Regular Session'), row('2015', '2015 Regular Session'), row('2016', '2016 Regular Session'),
    row('2017', '2017 Regular Session'), row('2017-special-1460', '2017 1st Special Session'), row('2017-special-1465', '2017 2nd Special Session'),
    row('2018', '2018 Regular Session (MO Senate journals)'), row('2018-special-1579', '2018 1st Special Session'), row('2018-special-1608', '2018 2nd Special Session'),
    row('2019', '2019 Regular Session'), row('2019-special-1711', '2019 1st Special Session'),
    row('2020', '2020 Regular Session'), row('2020-special-1758', '2020 1st Special Session'), row('2020-special-1774', '2020 2nd Special Session'),
    row('2021', '2021 Regular Session'), row('2021-special-1842', '2021 1st Special Session'),
    row('2022', '2022 Regular Session', { start_date: '2022-01-05' }), row('2022-special-1995', '2022 1st Special Session'),
    row('2023', '2023 Regular Session'), row('2024', '2024 Regular Session'),
    row('2025', '2025 Regular Session'), row('2025-special-2216', '2025 1st Special Session'), row('2025-special-2226', '2025 2nd Special Session'),
    row('261', '2026 2nd Regular, 103rd General Assembly'),
  ];
  const plan = planSessionDates({ rows, openstates: OPENSTATES });
  assert.equal(plan.patches.length, 27);
  assert.deepEqual(plan.unmatched.map((u) => u.identifier).sort(), ['2010-special-497', '2011-special-498', '2013-special-1094']);
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.unclassified.length, 0);
  // every patched date is a valid ISO date inside the session's own year
  for (const p of plan.patches) {
    assert.match(p.start_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(p.start_date.slice(0, 4), String(sessionYear(p)));
  }
  assert.equal(plan.patches.find((p) => p.identifier === '261').start_date, '2026-01-07');
});

test('sessionRecencyKey: real date wins; undated rows fall back to their name/identifier year and say so', () => {
  assert.deepEqual(sessionRecencyKey({ start_date: '2025-01-08', identifier: '2025' }), { key: '2025-01-08', dated: true });
  assert.deepEqual(sessionRecencyKey({ start_date: null, identifier: '261', name: '2026 2nd Regular, 103rd General Assembly' }), { key: '2026-00-00', dated: false });
  assert.deepEqual(sessionRecencyKey({ start_date: null, identifier: '119', name: '119th Congress' }), { key: '', dated: false });
  // ordering, newest first: an undated 2025 row falls to the year's start, so it sorts AFTER the dated 2025 regular session and BEFORE anything from 2024
  const keys = ['2026-00-00', '2025-01-08', '2025-00-00'].sort((a, b) => b.localeCompare(a));
  assert.deepEqual(keys, ['2026-00-00', '2025-01-08', '2025-00-00']);
});
