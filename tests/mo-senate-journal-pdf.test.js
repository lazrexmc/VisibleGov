import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JournalParseError, extractJournalText, extractBillRefs, parseJournalVotes, resolveMoSenator,
  stripPageChrome,
} from '../src/adapters/mo-senate-journal-pdf.js';

const FIXTURES = 'tests/fixtures/research/mo-senate';

// Loaded once and reused - extractJournalText is the only async step. Both real fixtures per
// task-4-brief.md: Day 37 (2018, Onder era, 13 votes, incl. hyphenated Chappelle-Nadal) and Day 39
// (2026, 11 YEAS blocks = 10 passages + 1 emergency-clause adoption, incl. district-suffix
// collisions Brown (16)/Brown (26) and Gregory (15)/Gregory (21)). CODE REVIEW FIX ROUND 1 (finding
// 2) diverted any zero-bill-ref motion to `failures`, which briefly meant Day 39's emergency-clause
// block landed in `failures` too. CODE REVIEW FIX ROUND 2 (controller ruling) narrowed that: an
// emergency-clause motion specifically gets mechanical attribution from the nearest preceding
// "taken up" line instead, so it is back in `votes` - Day 39 is 11 votes, 0 failures (see the
// dedicated tests below for both the round-1 gate on OTHER zero-ref motions, still in force, and
// round-2's emergency-clause attribution).
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

// ---- stripPageChrome: context-anchored chrome stripping (code review fix round 1, finding 1) ----
//
// The bug this guards against: PAGE_NUMBER_ONLY_RE matches ANY bare digits-only line - including
// one that could be a category's own printed count, isolated onto its own reconstructed row by a
// page break (the exact same failure class already fixed for name-list text in Day 37 block 4,
// applied to a COUNT digit instead of a surname). If that digit were stripped, extractCategory's
// lazy terminator would overshoot searching for the next em-dash+digit, silently reconciling
// against the WRONG count - the one failure mode this pipeline must never produce. The fix strips a
// bare digits-only line ONLY when it is adjacent (nearest non-blank neighbor, either side) to a
// known chrome header line - never blindly.

test('stripPageChrome: a real chrome shape (page-footer number immediately adjacent to the next page\'s "Journal of the Senate" header, exactly as it appears in the Day 37 fixture) is still stripped', () => {
  const realChromeShape = 'Kehoe Sater—2\nVacancies—1\nThe Lieutenant Governor was present.\n587\n\n588Journal of the Senate\nRESOLUTIONS\n';
  const cleaned = stripPageChrome(realChromeShape);
  assert.ok(!cleaned.includes('587'), 'the adjacent page-footer number must still be stripped');
  assert.ok(!cleaned.includes('Journal of the Senate'));
  assert.ok(cleaned.includes('Kehoe Sater—2') && cleaned.includes('RESOLUTIONS'), 'real content around the chrome must survive');
});

test('stripPageChrome: a real chrome shape using the day-header form (page number immediately adjacent to a "<Ordinal> Day<dash><Weekday>..." header, as in the Day 39 fixture) is still stripped', () => {
  const realChromeShape = 'was adopted.\n772\n\n773 Thirty-Ninth Day - Wednesday, March 25, 2026\nSenator Bean offered Senate Resolution No. 829.\n';
  const cleaned = stripPageChrome(realChromeShape);
  assert.ok(!cleaned.includes('772'), 'the adjacent page-footer number must still be stripped');
  assert.ok(!cleaned.includes('Thirty-Ninth Day'));
});

test('stripPageChrome: an isolated digits-only line with NO adjacent chrome header is preserved, even though it has the exact same bare-digit shape as real chrome - never stripped by shape alone', () => {
  // Hypothetical (never observed in either real fixture): a category's own printed count lands
  // alone on its own reconstructed row, with ordinary vote content - not a chrome header - on
  // both sides.
  const isolatedCountDigit = 'YEAS—Senators\nAlpha Beta Gamma Delta Epsilon Zeta—\n6\nNAYS—Senators—None\n';
  const cleaned = stripPageChrome(isolatedCountDigit);
  assert.ok(cleaned.includes('\n6\n'), 'an isolated real count digit with no adjacent chrome header must survive stripping');
});

test('parseJournalVotes: a category whose printed count digit is isolated onto its own line (simulating a page break landing between the em-dash and the digit) still reconciles correctly end to end, because stripPageChrome leaves it in place', () => {
  const text = 'On motion of Senator Test, SB 300 was read the 3rd time and passed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta Gamma Delta Epsilon Zeta—\n6\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.equal(failures.length, 0);
  assert.equal(votes.length, 1);
  assert.equal(votes[0].tallies.yeas, 6);
  assert.equal(votes[0].yeas.length, 6);
});

// ---- parseJournalVotes (Day 37, real fixture): 13 blocks, research-verified count ----

test('parseJournalVotes (Day 37, real fixture): all 13 vote blocks parse, zero failures', () => {
  assert.equal(day37.votes.length, 13);
  assert.equal(day37.failures.length, 0);
});

test('parseJournalVotes (Day 37, real fixture): every block attributes from its own motion (no emergency-clause continuations exist in this fixture)', () => {
  assert.ok(day37.votes.every((v) => v.attribution === 'motion'));
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
    attribution: 'motion',
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

test('parseJournalVotes (Day 39, real fixture): CODE REVIEW FIX ROUND 2 (controller ruling) - all 11 blocks parse, 0 failures. Round 1 had diverted the bill-less emergency-clause block to `failures`; the ruling requires it back in `votes` (EC votes are genuine recorded votes, and a day containing one must be able to complete) via mechanical attribution, not a guess', () => {
  assert.equal(day39.votes.length, 11);
  assert.equal(day39.failures.length, 0);
});

test('parseJournalVotes (Day 39, real fixture): every vote reconciles', () => {
  for (const v of day39.votes) {
    assert.equal(v.yeas.length, v.tallies.yeas, `block ${v.ordinal} yeas`);
    assert.equal(v.nays.length, v.tallies.nays, `block ${v.ordinal} nays`);
    assert.equal(v.absent.length, v.tallies.absent, `block ${v.ordinal} absent`);
  }
});

test('parseJournalVotes (Day 39, real fixture): every vote carries an `attribution` field, and every Day 39 vote is \'motion\' EXCEPT the emergency-clause block', () => {
  for (const v of day39.votes) {
    assert.ok(v.attribution === 'motion' || v.attribution === 'preceding_taken_up', `block ${v.ordinal} has an unrecognized attribution value: ${v.attribution}`);
  }
  const nonMotion = day39.votes.filter((v) => v.attribution !== 'motion');
  assert.equal(nonMotion.length, 1);
  assert.equal(nonMotion[0].ordinal, 9);
});

test('parseJournalVotes (Day 39, real fixture): CODE REVIEW FIX ROUND 2 - the emergency-clause block (ordinal 9) has bill_refs mechanically attributed from the nearest preceding "taken up" line (SB 1421\'s own introduction/description text), attribution \'preceding_taken_up\', motion left verbatim and un-edited', () => {
  const ec = day39.votes.find((v) => v.ordinal === 9);
  assert.ok(ec, 'expected the emergency-clause block to be present in votes');
  assert.equal(ec.motion, 'The emergency clause was adopted by the following vote:', 'the motion string itself must stay verbatim - attribution provenance is a separate field, not an edit to motion');
  assert.deepEqual(ec.bill_refs, ['SB 1421']);
  assert.equal(ec.attribution, 'preceding_taken_up');
  // Cross-check: SB 1421's own passage vote (the immediately preceding block, ordinal 8) has the
  // SAME primary bill ref - proving the two independent sources (the taken-up-line scan and the
  // preceding vote block) actually agree on the real fixture, not just individually non-empty.
  const precedingPassage = day39.votes.find((v) => v.ordinal === 8);
  assert.equal(precedingPassage.bill_refs[0], 'SB 1421');
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

// ---- code review fix round 1, finding 2: extractMotionSentence's period-boundary heuristic +
// the zero-bill-refs-fails-loud gate ----

test('parseJournalVotes: a motion sentence with an internal period BEFORE the bill reference (simulating an abbreviated title extractMotionSentence has no defense against) still yields the CORRECT bill_refs - truncation only drops the sentence prefix, never the reference itself, because the reference sits after the false boundary', () => {
  // "Sen." here plays the role of a hypothetical dotted abbreviation - never observed in either
  // real fixture (both spell "Senator" in full in every motion, and bill-description prose uses
  // "RSMo," with a comma, never a period) but exercised here as the documented edge case.
  const text = 'Was taken up. On motion of Sen. Test, SB 400 was read the 3rd time and passed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.equal(failures.length, 0);
  assert.equal(votes.length, 1);
  // The internal period DOES truncate `motion` (it starts after "Sen." instead of "On motion of
  // Sen.") - proving the boundary heuristic is imperfect, exactly as finding 2 describes - but
  // bill_refs is still correct because "SB 400" appears after the false boundary, not before it.
  assert.equal(votes[0].motion, 'Test, SB 400 was read the 3rd time and passed by the following vote:');
  assert.deepEqual(votes[0].bill_refs, ['SB 400']);
});

test('parseJournalVotes: a genuinely bill-less motion (no bill token anywhere in the sentence) is diverted to `failures` with the human-review reason, never silently stored as an unattributed vote - the load-bearing half of finding 2\'s fix', () => {
  const text = 'The President declared the bill passed. The Senate observed a moment of silence, and by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.equal(votes.length, 0);
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof JournalParseError);
  assert.equal(failures[0].category, 'bill_refs');
  assert.equal(failures[0].reason, 'no bill reference found in motion - needs human review');
  assert.match(failures[0].message, /no bill reference found in motion/);
});

// ---- code review fix round 2 (controller ruling): emergency-clause continuations attribute
// mechanically from the nearest preceding "taken up" line - but ONLY when that line (and a bill
// reference near it) actually exists; otherwise this still fails loud like any other unresolved
// zero-ref motion, never a guess. ----

test('parseJournalVotes: an emergency-clause block with NO preceding "taken up" line anywhere in the text fails loud - the taken-up line is required, not optional, even though it names the fallback path', () => {
  const text = 'SB 500, entitled: An Act relating to widgets. On motion of Senator Test, SB 500 was read the 3rd time and passed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n'
    + 'The President declared the bill passed.\n'
    // No "taken up" phrase anywhere between the SB 500 passage and the EC block below.
    + 'The emergency clause was adopted by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes.map((v) => v.ordinal), [1]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].ordinal, 2);
  assert.equal(failures[0].category, 'bill_refs');
  assert.match(failures[0].reason, /no preceding taken-up line found/);
});

test('parseJournalVotes: an emergency-clause block whose nearest preceding "taken up" line names a DIFFERENT bill than the immediately preceding vote block\'s primary ref fails loud, naming the discrepancy - never silently picks one', () => {
  const text = 'SB 100, introduced by Senator Test, entitled: An Act relating to widgets. Was taken up.\n'
    + 'On motion of Senator Test, SB 200 was read the 3rd time and passed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n'
    + 'The President declared the bill passed.\n'
    + 'The emergency clause was adopted by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  // Block 1's own motion genuinely reads "SB 200" (not SB 100 - the "taken up" line a sentence
  // earlier names a different bill entirely), so block 1 itself parses fine with bill_refs
  // ['SB 200']; it is the EC block's cross-check against that SB 200 that must fail, naming both.
  assert.deepEqual(votes.map((v) => v.ordinal), [1]);
  assert.equal(votes[0].bill_refs[0], 'SB 200');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].ordinal, 2);
  assert.equal(failures[0].category, 'bill_refs');
  assert.match(failures[0].reason, /discrepancy/);
  assert.equal(failures[0].takenUpRef, 'SB 100');
  assert.equal(failures[0].precedingVoteRef, 'SB 200');
  assert.match(failures[0].message, /SB 100.*SB 200|SB 200.*SB 100/);
});

// ---- code review fix round 3 (controller ruling): the preceding-vote-block cross-check is
// REQUIRED for emergency-clause attribution, not optional corroboration - a missing or FAILED
// immediately-preceding block must fail the EC block outright, before the backward scan even runs,
// rather than trusting a single unverified source. ----

test('parseJournalVotes: an emergency-clause block whose immediately preceding block FAILED (so there is no successful vote to cross-check against) fails loud with the unverifiable reason, even though a "taken up" line and a bill reference both genuinely exist nearby', () => {
  const text = 'SB 300, entitled: An Act relating to widgets. Was taken up.\n'
    // Block 1's own motion genuinely has a bill reference (SB 300), but its Absent-with-leave
    // count is doctored to 5 while only 1 name (Gamma) is printed - deliberately fails reconcile,
    // so block 1 lands in `failures`, not `votes`.
    + 'On motion of Senator Test, SB 300 was read the 3rd time and passed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators\nGamma—5\n'
    + 'Vacancies—None\n'
    + 'The President declared the bill passed.\n'
    + 'The emergency clause was adopted by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes, [], 'block 1 failed reconcile, so nothing lands in votes at all');
  assert.equal(failures.length, 2);
  const block1Failure = failures.find((f) => f.ordinal === 1);
  assert.ok(block1Failure, 'expected block 1 itself to be a failure (the reconcile mismatch)');
  const ecFailure = failures.find((f) => f.ordinal === 2);
  assert.ok(ecFailure, 'expected the EC block to ALSO be a failure - unverifiable, not silently attributed via the still-findable "taken up" line/bill reference');
  assert.ok(ecFailure instanceof JournalParseError);
  assert.equal(ecFailure.category, 'bill_refs');
  assert.equal(ecFailure.reason, 'emergency-clause attribution unverifiable - preceding vote block missing or failed');
});

test('parseJournalVotes: an emergency-clause block as the very FIRST block in the day (ordinal 1, no preceding vote can possibly exist) fails loud with the unverifiable reason, never silently attributing to unrelated preamble text', () => {
  const text = 'SB 999, entitled: An Act relating to widgets, was taken up earlier and is unrelated to this test.\n'
    + 'The emergency clause was adopted by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\n'
    + 'NAYS—Senators—None\n'
    + 'Absent—Senators—None\n'
    + 'Absent with leave—Senators—None\n'
    + 'Vacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].ordinal, 1);
  assert.ok(failures[0] instanceof JournalParseError);
  assert.equal(failures[0].category, 'bill_refs');
  assert.equal(failures[0].reason, 'emergency-clause attribution unverifiable - preceding vote block missing or failed');
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
