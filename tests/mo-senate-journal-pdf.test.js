import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JournalParseError, extractJournalText, extractBillRefs, parseJournalVotes, resolveMoSenator,
} from '../src/adapters/mo-senate-journal-pdf.js';

const FIXTURES = 'tests/fixtures/research/mo-senate';

// Loaded once and reused - extractJournalText is the only async step. Both real fixtures per
// task-4-brief.md: Day 37 (2018, Onder era, 13 votes, incl. hyphenated Chappelle-Nadal) and Day 39
// (2026, 11 YEAS blocks = 10 passages + 1 emergency-clause adoption, incl. district-suffix
// collisions Brown (16)/Brown (26) and Gregory (15)/Gregory (21)).
const day37Buffer = readFileSync(`${FIXTURES}/2018-day37-journal-onder-era.pdf`);
const day37Text = await extractJournalText(day37Buffer);
const day37 = parseJournalVotes(day37Text);

const day39Buffer = readFileSync(`${FIXTURES}/2026-day39-journal.pdf`);
const day39Text = await extractJournalText(day39Buffer);
const day39 = parseJournalVotes(day39Text);

// ---- extractJournalText (real PDFs, pdfjs-dist legacy build, coordinate-based reconstruction) ----

test('extractJournalText (Day 37, real fixture): returns page-ordered text containing known content', () => {
  assert.equal(typeof day37Text, 'string');
  assert.ok(day37Text.includes('SECOND REGULAR SESSION'));
  assert.ok(day37Text.includes('The Senate met pursuant to adjournment.'));
  assert.ok(day37Text.includes('Chappelle-Nadal'), 'hyphenated surname must survive extraction');
});

test('extractJournalText (Day 39, real fixture): returns page-ordered text containing known content', () => {
  assert.equal(typeof day39Text, 'string');
  assert.ok(day39Text.includes('SECOND REGULAR SESSION'));
  assert.ok(day39Text.includes('Brown (16)') && day39Text.includes('Brown (26)'), 'district-suffixed collision must survive extraction');
});

test('extractJournalText: page chrome (bare page numbers, "Journal of the Senate" running headers, "<Day> Day<dash><Weekday>..." running headers) is stripped, not left interleaved mid-content', () => {
  // Real finding (task-4-report.md): Day 37 block 4's YEAS list wraps across a page boundary; the
  // raw pdfjs-dist row reconstruction interleaves 'Thirty-Seventh Day—Thursday, March 8, 2018 591'
  // between 'Riddle Rizzo' and 'Romine Rowden' unless stripped first. Prove it's gone.
  assert.ok(!day37Text.includes('Thirty-Seventh Day—Thursday, March 8, 2018 591'));
  assert.ok(!/^\d+$/m.test(day37Text.split('\n').find((l) => l.trim() === '587') ?? ''));
});

// ---- parseJournalVotes (Day 37, real fixture): 13 blocks, research-verified count ----

test('parseJournalVotes (Day 37, real fixture): all 13 vote blocks parse, zero failures', () => {
  assert.equal(day37.votes.length, 13);
  assert.equal(day37.failures.length, 0);
});

test('parseJournalVotes (Day 37, real fixture): ordinals are stable 1-based sequential order', () => {
  assert.deepEqual(day37.votes.map((v) => v.ordinal), Array.from({ length: 13 }, (_, i) => i + 1));
});

test('parseJournalVotes (Day 37, real fixture): the SBs 894 & 921 block matches the exact known shape (ordinal, motion, bill_refs, Onder in yeas, tallies, vacancies)', () => {
  const block = day37.votes.find((v) => v.bill_refs.includes('SB 894'));
  assert.ok(block, 'expected a block referencing SB 894');
  assert.deepEqual(block, {
    ordinal: 6,
    motion: 'On motion of Senator Libla, SS for SCS for SBs 894 and 921 was read the 3rd time and passed by the following vote:',
    bill_refs: ['SB 894', 'SB 921'],
    yeas: [
      'Brown', 'Chappelle-Nadal', 'Cierpiot', 'Crawford', 'Cunningham', 'Curls', 'Dixon', 'Eigel',
      'Emery', 'Hegeman', 'Holsman', 'Hoskins', 'Hummel', 'Koenig', 'Libla', 'Munzlinger', 'Nasheed',
      'Onder', 'Richard', 'Riddle', 'Rizzo', 'Romine', 'Rowden', 'Schaaf', 'Schatz', 'Schupp',
      'Sifton', 'Wallingford', 'Walsh', 'Wasson', 'Wieland',
    ].map((surname) => ({ surname, district: null })),
    nays: [],
    absent: [],
    absentWithLeave: [{ surname: 'Kehoe', district: null }, { surname: 'Sater', district: null }],
    vacancies: 1,
    tallies: { yeas: 31, nays: 0, absent: 0 },
  });
});

test('parseJournalVotes (Day 37, real fixture): substitute prefixes (SS/SCS) are preserved verbatim in motion but never leak into bill_refs', () => {
  const block = day37.votes.find((v) => v.bill_refs.includes('SB 894'));
  assert.match(block.motion, /SS for SCS for SBs 894 and 921/);
  assert.ok(block.bill_refs.every((r) => !/SS|SCS/.test(r)));
});

test('parseJournalVotes (Day 37, real fixture): every block reconciles - parsed array lengths equal their printed tallies/counts', () => {
  for (const v of day37.votes) {
    assert.equal(v.yeas.length, v.tallies.yeas, `block ${v.ordinal} yeas`);
    assert.equal(v.nays.length, v.tallies.nays, `block ${v.ordinal} nays`);
    assert.equal(v.absent.length, v.tallies.absent, `block ${v.ordinal} absent`);
  }
});

test('parseJournalVotes (Day 37, real fixture): Absent with leave is always Kehoe + Sater (2), the known daily-attendance ground truth for this session', () => {
  for (const v of day37.votes) {
    assert.deepEqual(v.absentWithLeave.map((t) => t.surname).sort(), ['Kehoe', 'Sater']);
  }
});

test('parseJournalVotes (Day 37, real fixture): a singular "—Senator <Name>—1" category (no line break, no plural "Senators") parses as a 1-element array', () => {
  // Block 2 (SS for SB 882): "Absent—Senator Wasson—1"
  const block = day37.votes.find((v) => v.bill_refs.includes('SB 882'));
  assert.deepEqual(block.absent, [{ surname: 'Wasson', district: null }]);
  assert.equal(block.tallies.absent, 1);
});

test('parseJournalVotes (Day 37, real fixture): a "—None" category (zero case) parses as an empty array with tallies count 0', () => {
  const block = day37.votes.find((v) => v.bill_refs.includes('SB 894'));
  assert.deepEqual(block.nays, []);
  assert.equal(block.tallies.nays, 0);
});

test('parseJournalVotes (Day 37, real fixture): bill_refs for combined-vehicle motions using "and" as the separator (no ampersand in this fixture\'s real vote motions)', () => {
  const scs632 = day37.votes.find((v) => v.motion.includes('632'));
  assert.deepEqual(scs632.bill_refs, ['SB 632', 'SB 675']);
  const scs627 = day37.votes.find((v) => v.motion.includes('627'));
  assert.deepEqual(scs627.bill_refs, ['SB 627', 'SB 925']);
  const scs946 = day37.votes.find((v) => v.motion.includes('946'));
  assert.deepEqual(scs946.bill_refs, ['SB 946', 'SB 947']);
});

test('parseJournalVotes (Day 37, real fixture): single-bill motions with no substitute prefix at all (bare "SB <N> was read...")', () => {
  const sb793 = day37.votes.find((v) => v.bill_refs.includes('SB 793'));
  assert.deepEqual(sb793.bill_refs, ['SB 793']);
  assert.match(sb793.motion, /^On motion of Senator Wallingford, SB 793 was read the 3rd time/);
});

// ---- parseJournalVotes (Day 39, real fixture): format stability across sessions ----

test('parseJournalVotes (Day 39, real fixture): all 11 YEAS blocks parse (10 third-reading passages + 1 emergency-clause adoption), zero failures - CONTROLLER RULING 1 ground truth', () => {
  assert.equal(day39.votes.length, 11);
  assert.equal(day39.failures.length, 0);
});

test('parseJournalVotes (Day 39, real fixture): every block reconciles', () => {
  for (const v of day39.votes) {
    assert.equal(v.yeas.length, v.tallies.yeas, `block ${v.ordinal} yeas`);
    assert.equal(v.nays.length, v.tallies.nays, `block ${v.ordinal} nays`);
    assert.equal(v.absent.length, v.tallies.absent, `block ${v.ordinal} absent`);
  }
});

test('parseJournalVotes (Day 39, real fixture): the emergency-clause adoption block has NO bill reference (motion text names no bill at all) but still reconciles', () => {
  const block = day39.votes.find((v) => /emergency clause/i.test(v.motion));
  assert.ok(block, 'expected an emergency-clause block');
  assert.equal(block.motion, 'The emergency clause was adopted by the following vote:');
  assert.deepEqual(block.bill_refs, []);
  assert.equal(block.tallies.yeas, 33);
});

test('parseJournalVotes (Day 39, real fixture): a 3-bill combined vehicle with an Oxford comma ("SBs 907, 1154, and 1272")', () => {
  const block = day39.votes.find((v) => v.bill_refs.includes('SB 907'));
  assert.deepEqual(block.bill_refs, ['SB 907', 'SB 1154', 'SB 1272']);
});

test('parseJournalVotes (Day 39, real fixture): district-suffix collisions (Brown (16)/Brown (26), Gregory (15)/Gregory (21)) parse as distinct { surname, district } tokens, not merged or dropped - CONTROLLER RULING 2', () => {
  const block = day39.votes[0];
  const browns = block.yeas.filter((t) => t.surname === 'Brown');
  assert.deepEqual(browns.map((t) => t.district).sort(), ['16', '26']);
  const gregorys = block.yeas.filter((t) => t.surname === 'Gregory');
  assert.deepEqual(gregorys.map((t) => t.district).sort(), ['15', '21']);
});

test('parseJournalVotes (Day 39, real fixture): a joint resolution motion (SJR, not SB/HB) is recognized', () => {
  const block = day39.votes.find((v) => v.bill_refs.includes('SJR 87'));
  assert.ok(block);
  assert.match(block.motion, /SS for SJR 87 was read the 3rd time and passed/);
});

// ---- reconcile gate: corruption test against the REAL Day 37 fixture (task-4-brief.md) ----

test('parseJournalVotes: a deliberately corrupted copy of the real Day 37 text (one surname dropped from one block\'s YEAS list) fails ONLY that block, naming its ordinal and category, while the other 12 blocks still parse', () => {
  // Target block 7 (SS for SCS for SB 592) via a marker unique in the whole document (the bill's
  // own introduction line), then surgically remove one name from ONLY that block's own YEAS span
  // (bounded by the next 'NAYS' occurrence) - never a blind global replace, since several blocks
  // share near-identical YEAS rosters and a global replace would corrupt more than one block.
  const marker = 'SS for SCS for SB 592, introduced by Senator Hegeman';
  const markerIdx = day37Text.indexOf(marker);
  assert.notEqual(markerIdx, -1, 'test setup: marker not found in the real fixture');
  const yeasIdx = day37Text.indexOf('YEAS', markerIdx);
  const naysIdx = day37Text.indexOf('NAYS', yeasIdx);
  const segment = day37Text.slice(yeasIdx, naysIdx);
  const corruptedSegment = segment.replace('Munzlinger ', '');
  assert.notEqual(corruptedSegment, segment, 'test setup: name not found in the targeted segment');
  const corruptedText = day37Text.slice(0, yeasIdx) + corruptedSegment + day37Text.slice(naysIdx);

  const { votes, failures } = parseJournalVotes(corruptedText);
  assert.equal(votes.length, 12);
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof JournalParseError);
  assert.equal(failures[0].name, 'JournalParseError');
  assert.equal(failures[0].ordinal, 7);
  assert.equal(failures[0].category, 'yeas');
  assert.match(failures[0].message, /block 7.*yeas.*does not reconcile/);

  // The other blocks - including the untouched SBs 894 & 921 block far away in the document -
  // are completely unaffected by this block's corruption.
  const untouched = votes.find((v) => v.bill_refs.includes('SB 894'));
  assert.ok(untouched);
  assert.equal(untouched.yeas.length, 31);
  assert.deepEqual(votes.map((v) => v.ordinal), [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]);
});

// ---- synthetic unit tests: minimal, documented edge cases independent of fixture layout ----

test('parseJournalVotes: the anchor phrase tolerates an internal line-wrap (CONTROLLER RULING 1)', () => {
  const text = 'Prior sentence ends here. On motion of Senator Test, SB 100 was read the 3rd time and passed by the\n'
    + 'following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.equal(failures.length, 0);
  assert.equal(votes.length, 1);
  assert.equal(votes[0].motion, 'On motion of Senator Test, SB 100 was read the 3rd time and passed by the following vote:');
});

test('parseJournalVotes: a "—None" printed for every non-YEAS category parses as empty arrays / zero counts, never throws', () => {
  const text = 'Was taken up. On motion of Senator Test, SB 100 was read the 3rd time and passed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.equal(failures.length, 0);
  const [vote] = votes;
  assert.deepEqual(vote.nays, []);
  assert.deepEqual(vote.absent, []);
  assert.deepEqual(vote.absentWithLeave, []);
  assert.equal(vote.vacancies, 0);
  assert.deepEqual(vote.tallies, { yeas: 2, nays: 0, absent: 0 });
});

test('parseJournalVotes: one malformed block (Absent-with-leave count does not reconcile) fails alone; the good block before it AND the good block after it both still parse - minimal synthetic repro of the reconcile-gate/return-shape contract', () => {
  const goodBlock = (n) => `On motion of Senator Test, SB ${n} was read the 3rd time and passed by the following vote:\n`
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n'
    + 'The President declared the bill passed.\n';
  const badBlock = 'On motion of Senator Test, SB 999 was read the 3rd time and passed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    // printed count says 5, only 1 name (Gamma) actually listed - must not reconcile
    + 'Absent with leave—Senators\nGamma—5\n'
    + 'Vacancies—None\n'
    + 'The President declared the bill passed.\n';
  const text = goodBlock(1) + badBlock + goodBlock(3);

  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes.map((v) => v.ordinal), [1, 3]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].ordinal, 2);
  assert.equal(failures[0].category, 'absentWithLeave');
});

test('parseJournalVotes: a block missing a category header entirely fails loud (typed error naming the category), never silently returns a partial vote', () => {
  const text = 'On motion of Senator Test, SB 200 was read the 3rd time and passed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'This block has no NAYS/Absent/Vacancies section at all - structurally broken.\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.equal(votes.length, 0);
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof JournalParseError);
  assert.equal(failures[0].category, 'nays');
});

test('parseJournalVotes: an empty/unrelated document produces zero votes and zero failures (never throws)', () => {
  const { votes, failures } = parseJournalVotes('this document has no vote blocks in it whatsoever.');
  assert.deepEqual(votes, []);
  assert.deepEqual(failures, []);
});

test('JournalParseError: carries name, message, and meta (ordinal/category), mirrors RollCallParseError\'s shape', () => {
  const err = new JournalParseError('test message', { ordinal: 4, category: 'yeas' });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'JournalParseError');
  assert.equal(err.message, 'test message');
  assert.equal(err.ordinal, 4);
  assert.equal(err.category, 'yeas');
});

// ---- extractBillRefs: bill-reference normalization (task-4-brief.md's mechanical rule) ----

test('extractBillRefs: a single bill with no substitute prefix', () => {
  assert.deepEqual(extractBillRefs('On motion of Senator Trent, SB 1119 was read the 3rd time and passed by the following vote:'), ['SB 1119']);
});

test('extractBillRefs: substitute prefixes (SS/SCS) are consumed but never appear in the identifier', () => {
  assert.deepEqual(extractBillRefs('SS for SCS for SB 600 was read the 3rd time and passed by the following vote:'), ['SB 600']);
});

test('extractBillRefs: a combined vehicle using "and" as the separator, no comma ("SBs 894 and 921")', () => {
  assert.deepEqual(extractBillRefs('SS for SCS for SBs 894 and 921 was read the 3rd time'), ['SB 894', 'SB 921']);
});

test('extractBillRefs: a combined vehicle with an Oxford comma before "and" ("SBs 907, 1154, and 1272")', () => {
  assert.deepEqual(extractBillRefs('SS for SCS for SBs 907, 1154, and 1272 was read the 3rd time'), ['SB 907', 'SB 1154', 'SB 1272']);
});

test('extractBillRefs: real substrings from the Day 37 fixture\'s "SECOND READING" lists (not vote-block motions themselves, but the same bill-token grammar) - a 3-item ampersand+comma list and a bare-ampersand 2-item list', () => {
  assert.deepEqual(extractBillRefs('SBs 617, 611 & 667-Eigel, with SCS'), ['SB 617', 'SB 611', 'SB 667']);
  assert.deepEqual(extractBillRefs('SBs 555 & 609-Brown, with SCS'), ['SB 555', 'SB 609']);
});

test('extractBillRefs: a joint resolution (SJR) is recognized alongside SB/HB', () => {
  assert.deepEqual(extractBillRefs('On motion of Senator Carter, SS for SJR 87 was read the 3rd time'), ['SJR 87']);
});

test('extractBillRefs: a motion with no bill token at all (the emergency-clause variant) returns an empty array, never throws', () => {
  assert.deepEqual(extractBillRefs('The emergency clause was adopted by the following vote:'), []);
});

// ---- resolveMoSenator: fail-loud resolution (task-4-brief.md + CONTROLLER RULING 2/3) ----
//
// Deviation from task-4-brief.md's ASCII sketch `resolveMoSenator(surname, roster)`, documented in
// task-4-report.md: CONTROLLER RULING 2 requires the House's two-branch district-aware logic,
// which needs both surname AND district per call - the first argument here is the whole
// { surname, district } token (one element of a vote's yeas/nays/absent/absentWithLeave array),
// exactly mirroring mo-rollcall-pdf.js's resolveMoRep(cast, roster).

const ROSTER = [
  { legislator_id: 'leg-onder', surname: 'Onder', mo_senate_id: '2' },
  { legislator_id: 'leg-chappelle-nadal', surname: 'Chappelle-Nadal', mo_senate_id: '14' },
  { legislator_id: 'leg-brown-16', surname: 'Brown', mo_senate_id: '16' },
  { legislator_id: 'leg-brown-26', surname: 'Brown', mo_senate_id: '26' },
  { legislator_id: 'leg-gregory-15', surname: 'Gregory', mo_senate_id: '15' },
  { legislator_id: 'leg-gregory-21', surname: 'Gregory', mo_senate_id: '21' },
];

test('resolveMoSenator: a unique surname with no district suffix resolves (Onder)', () => {
  assert.equal(resolveMoSenator({ surname: 'Onder', district: null }, ROSTER), 'leg-onder');
});

test('resolveMoSenator: an unknown surname -> null (0 matches, never guessed)', () => {
  assert.equal(resolveMoSenator({ surname: 'Nosuchsenator', district: null }, ROSTER), null);
});

test('resolveMoSenator: a collision surname WITHOUT a printed district suffix -> null, even though the roster could theoretically disambiguate elsewhere - journal text alone gives no district, so this must fail loud (2018-style: no suffix ever printed in that era\'s fixture)', () => {
  assert.equal(resolveMoSenator({ surname: 'Brown', district: null }, ROSTER), null);
});

test('resolveMoSenator: a collision surname WITH a printed district suffix resolves to exactly the matching roster row (Brown (16), Brown (26), Gregory (15), Gregory (21)) - CONTROLLER RULING 2', () => {
  assert.equal(resolveMoSenator({ surname: 'Brown', district: '16' }, ROSTER), 'leg-brown-16');
  assert.equal(resolveMoSenator({ surname: 'Brown', district: '26' }, ROSTER), 'leg-brown-26');
  assert.equal(resolveMoSenator({ surname: 'Gregory', district: '15' }, ROSTER), 'leg-gregory-15');
  assert.equal(resolveMoSenator({ surname: 'Gregory', district: '21' }, ROSTER), 'leg-gregory-21');
});

test('resolveMoSenator: a district suffix that does not match any roster row for that surname -> null (miss, not a guess)', () => {
  assert.equal(resolveMoSenator({ surname: 'Brown', district: '99' }, ROSTER), null);
});

test('resolveMoSenator: matches case-insensitively and trims whitespace on both surname and district', () => {
  assert.equal(resolveMoSenator({ surname: ' onder ', district: null }, ROSTER), 'leg-onder');
  assert.equal(resolveMoSenator({ surname: ' brown ', district: ' 16 ' }, ROSTER), 'leg-brown-16');
});

test('resolveMoSenator: a hyphenated surname resolves via exact match (Chappelle-Nadal, real in the 2018 fixture)', () => {
  assert.equal(resolveMoSenator({ surname: 'Chappelle-Nadal', district: null }, ROSTER), 'leg-chappelle-nadal');
});

test('resolveMoSenator: returns null against an empty roster', () => {
  assert.equal(resolveMoSenator({ surname: 'Onder', district: null }, []), null);
});

// ---- end-to-end sanity: real Day 39 casts resolve against a minimal roster built the way Task 3's
// mo-senate-web.js parsers actually shape rows (surname + mo_senate_id) ----

test('end-to-end: real Day 39 yeas tokens (including the Brown/Gregory collisions) resolve correctly against a Task-3-shaped roster; a non-roster surname is left unresolved, never guessed', () => {
  const roster = [
    { legislator_id: 'leg-brown-16', surname: 'Brown', mo_senate_id: '16' },
    { legislator_id: 'leg-brown-26', surname: 'Brown', mo_senate_id: '26' },
    { legislator_id: 'leg-bean', surname: 'Bean', mo_senate_id: '25' },
    // Gregory (15) deliberately omitted - a realistic "roster not fully ingested yet" gap.
  ];
  const block = day39.votes[0];
  const brown16 = block.yeas.find((t) => t.surname === 'Brown' && t.district === '16');
  const bean = block.yeas.find((t) => t.surname === 'Bean');
  const gregory15 = block.yeas.find((t) => t.surname === 'Gregory' && t.district === '15');
  assert.equal(resolveMoSenator(brown16, roster), 'leg-brown-16');
  assert.equal(resolveMoSenator(bean, roster), 'leg-bean');
  assert.equal(resolveMoSenator(gregory15, roster), null);
});
