import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceFamily, normalizeSourceUrl, urlPinsOneVote, castFingerprint, candidateKey,
  confirmDuplicateGroup, sourceRecordId, chooseCanonical, DEFAULT_CAST_FLOOR,
} from '../src/lib/same-source-dedup.js';

// 2026-08-26 audit, defect D1. Every rejection test below is a REAL group from the live database
// that a weaker version of this rule accepted. They are the whole value of this file: the rule is
// only trustworthy to the extent it refuses these.
//
// Conditions 4a and 4b (the two REGRESSION blocks) were added AFTER the first version of this rule
// was applied to production and 17 of its 38 pairs turned out to hide real votes. That is the
// costliest mistake in this file's history and these tests are its wall.

// ---- sourceFamily ----

test('sourceFamily reads the adapter from the source_key shape', () => {
  assert.equal(sourceFamily('legiscan-2169-rollcall-1497726'), 'legiscan');
  assert.equal(sourceFamily('us-house-119-2026-283'), 'us-house');
  assert.equal(sourceFamily('us-senate-119-1-332'), 'us-senate');
  assert.equal(sourceFamily('mo-senate-web-2026-RDay6305071560-1614-vote3'), 'mo-senate-web');
  assert.equal(sourceFamily('mo-house-xml-HB2010-4'), 'mo-house-xml');
});

test('sourceFamily returns null for an empty key rather than a bogus family', () => {
  assert.equal(sourceFamily(''), null);
  assert.equal(sourceFamily(null), null);
});

// ---- normalizeSourceUrl / urlPinsOneVote ----

test('normalizeSourceUrl erases ONLY the scheme — most real pairs differ by http vs https', () => {
  const a = 'http://www.senate.mo.gov/25info/Journals/RDay250220426-442.pdf#430.2';
  const b = 'https://www.senate.mo.gov/25info/Journals/RDay250220426-442.pdf#430.2';
  assert.equal(normalizeSourceUrl(a), normalizeSourceUrl(b));
  assert.equal(normalizeSourceUrl(a), 'www.senate.mo.gov/25info/Journals/RDay250220426-442.pdf#430.2');
});

test('normalizeSourceUrl PRESERVES the fragment — the anchor is the evidence, not noise', () => {
  const n = normalizeSourceUrl('https://www.senate.mo.gov/26info/Journals/RDay62.pdf#1540.2');
  assert.match(n, /#1540\.2$/);
  assert.notEqual(
    normalizeSourceUrl('https://x/RDay62.pdf#1540'),
    normalizeSourceUrl('https://x/RDay62.pdf#1540.2'),
    'adjacent anchors are DIFFERENT votes and must never normalize together',
  );
});

test('normalizeSourceUrl returns null for empty/absent, never an empty string that could match', () => {
  assert.equal(normalizeSourceUrl(''), null);
  assert.equal(normalizeSourceUrl('   '), null);
  assert.equal(normalizeSourceUrl(null), null);
  assert.equal(normalizeSourceUrl(undefined), null);
});

test('urlPinsOneVote: a bare journal PDF pins nothing; an anchored one pins a vote', () => {
  assert.equal(urlPinsOneVote('www.senate.mo.gov/26info/Journals/RDay6305071560-1614.pdf'), false);
  assert.equal(urlPinsOneVote('www.senate.mo.gov/25info/Journals/RDay250220426-442.pdf#430.2'), true);
  assert.equal(urlPinsOneVote('www.senate.mo.gov/x.pdf#'), false, 'an empty fragment pins nothing');
  assert.equal(urlPinsOneVote(null), false);
});

// ---- castFingerprint ----

test('castFingerprint is order-independent', () => {
  const a = [{ legislator_id: 'b', position: 'yea' }, { legislator_id: 'a', position: 'nay' }];
  const b = [{ legislator_id: 'a', position: 'nay' }, { legislator_id: 'b', position: 'yea' }];
  assert.equal(castFingerprint(a), castFingerprint(b));
});

test('castFingerprint separates who from how — a flipped position is a different fingerprint', () => {
  assert.notEqual(
    castFingerprint([{ legislator_id: 'a', position: 'yea' }]),
    castFingerprint([{ legislator_id: 'a', position: 'nay' }]),
  );
});

test('castFingerprint of no casts is empty — never accidentally equal to a real one', () => {
  assert.equal(castFingerprint([]), '');
  assert.equal(castFingerprint(null), '');
});

// ---- candidateKey ----

test('candidateKey separates rows that cannot be the same vote', () => {
  const base = {
    source_key: 'legiscan-2169-rollcall-1', jurisdiction_id: 'mo-legislature',
    chamber: 'senate', vote_date: '2025-02-20T00:00:00+00:00', bill_id: 'bill-1',
  };
  assert.equal(candidateKey(base), candidateKey({ ...base, source_key: 'legiscan-2169-rollcall-2' }));
  assert.notEqual(candidateKey(base), candidateKey({ ...base, chamber: 'house' }));
  assert.notEqual(candidateKey(base), candidateKey({ ...base, vote_date: '2025-02-21T00:00:00+00:00' }));
  assert.notEqual(candidateKey(base), candidateKey({ ...base, bill_id: 'bill-2' }));
  assert.notEqual(candidateKey(base), candidateKey({ ...base, source_key: 'mo-senate-web-x-1' }),
    'a different adapter is the CROSS-source case migration 0022 owns, not this one');
});

// ---- the accepting case ----

const anchored = 'https://www.senate.mo.gov/25info/Journals/RDay250220426-442.pdf#430.2';

function legiscanPair(over = {}) {
  return [
    {
      source_key: 'legiscan-2169-rollcall-1495613', source_url: anchored.replace('https', 'http'),
      result: '32-0', question: 'Senate: Third Reading', ...over,
    },
    {
      source_key: 'legiscan-2169-rollcall-1497726', source_url: anchored,
      result: '32-0', question: 'Senate: Third Reading', ...over,
    },
  ];
}

test('CONFIRMS the real duplicate: two LegiScan roll_calls on one anchored journal location', () => {
  const v = confirmDuplicateGroup(legiscanPair(), { castCount: 32 });
  assert.equal(v.duplicate, true);
  assert.equal(v.reason, 'identical_casts_result_question_and_anchored_source_url');
  assert.equal(v.result, '32-0');
});

// ---- REGRESSION: conditions 4a and 4b, added after 17 false pairs reached production ----

test('REGRESSION 4a: a "#0" fragment pins nothing — LegiScan emits it when it has no location', () => {
  // 4 of the first applied batch rested on this. "#0" satisfied "has a fragment" while carrying
  // exactly as much evidence as the bare journal URLs condition 2 already refused.
  assert.equal(urlPinsOneVote('www.senate.mo.gov/25info/Journals/RDay02010981-89.pdf#0'), false);
  assert.equal(urlPinsOneVote('x.pdf#00'), false);
  assert.equal(urlPinsOneVote('x.pdf#0.0'), false);
  assert.equal(urlPinsOneVote('x.pdf#430.2'), true, 'a real anchor must still pass');
  assert.equal(urlPinsOneVote('x.pdf#1126'), true, 'a bare page anchor is still a location');
  const rows = legiscanPair({ source_url: 'https://www.senate.mo.gov/25info/Journals/RDay02010981-89.pdf#0' });
  const v = confirmDuplicateGroup(rows, { castCount: 34 });
  assert.equal(v.duplicate, false);
  assert.equal(v.reason, 'source_url_pins_no_specific_vote');
});

test('REGRESSION 4b: "Adopt Substitute" and "Third Reading" are TWO real votes with one fingerprint', () => {
  // 13 of the first applied batch were this. The MO Senate adopts a substitute and then third-reads
  // the same bill the same day; both pass with the identical tally from the identical members, and
  // a journal anchor is a PAGE pointer, so both rows legitimately carry it. Superseding one hid a
  // real recorded vote — precisely the failure this project exists to prevent.
  const rows = [
    {
      source_key: 'legiscan-1640-rollcall-863858', source_url: 'https://x/RDay66.pdf#1240',
      result: '25-8', question: 'Senate: Adopt Substitute',
    },
    {
      source_key: 'legiscan-1640-rollcall-863859', source_url: 'https://x/RDay66.pdf#1240',
      result: '25-8', question: 'Senate: Third Reading',
    },
  ];
  const v = confirmDuplicateGroup(rows, { castCount: 33 });
  assert.equal(v.duplicate, false);
  assert.equal(v.reason, 'different_question');
});

test('REGRESSION 4b: a missing question is vacuous agreement, not agreement', () => {
  assert.equal(confirmDuplicateGroup(legiscanPair({ question: null }), { castCount: 32 }).reason, 'question_missing');
  assert.equal(confirmDuplicateGroup(legiscanPair({ question: '   ' }), { castCount: 32 }).reason, 'question_missing');
});

test('REGRESSION 4b: question comparison trims whitespace only, never wording', () => {
  const rows = legiscanPair();
  rows[1].question = '  Senate: Third Reading  ';
  assert.equal(confirmDuplicateGroup(rows, { castCount: 32 }).duplicate, true);
  rows[1].question = 'Senate: Third Readings';
  assert.equal(confirmDuplicateGroup(rows, { castCount: 32 }).reason, 'different_question');
});

// ---- every other rejection is also a real group from the live database ----

test('REFUSES the US Senate vote-a-rama — ten identical party-line roll calls are ten real votes', () => {
  // 2025-06-30, one bill, one day: identical 100-cast lists, identical question ("On the Motion")
  // and identical result ("Motion Rejected"). Only the per-vote source URL tells them apart.
  const rows = [332, 335, 339].map((n) => ({
    source_key: `us-senate-119-1-${n}`,
    source_url: `https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00${n}.xml`,
    result: 'Motion Rejected',
    question: 'On the Motion',
  }));
  const v = confirmDuplicateGroup(rows, { castCount: 100 });
  assert.equal(v.duplicate, false);
  assert.equal(v.reason, 'different_source_url');
});

test('REFUSES a bare journal PDF shared by several distinct votes (mo-senate-web vote3/vote4)', () => {
  const url = 'https://www.senate.mo.gov/26info/Journals/RDay6305071560-1614.pdf';
  const rows = [
    { source_key: 'mo-senate-web-2026-RDay6305071560-1614-vote3', source_url: url, result: '30-0', question: 'Third Reading' },
    { source_key: 'mo-senate-web-2026-RDay6305071560-1614-vote4', source_url: url, result: '30-0', question: 'Third Reading' },
  ];
  const v = confirmDuplicateGroup(rows, { castCount: 32 });
  assert.equal(v.duplicate, false);
  assert.equal(v.reason, 'source_url_pins_no_specific_vote');
});

test('REFUSES a NULL result — two nulls satisfy "same result" vacuously, which is no evidence', () => {
  const v = confirmDuplicateGroup(legiscanPair({ result: null }), { castCount: 32 });
  assert.equal(v.duplicate, false);
  assert.equal(v.reason, 'result_missing');
});

test('REFUSES differing results on one anchor — #521 (2019-03-14) carries both 29-4 and 33-0', () => {
  const url = 'https://www.senate.mo.gov/19info/Journals/RDay370314512-532.pdf#521';
  const rows = [
    { source_key: 'legiscan-1640-rollcall-821639', source_url: url, result: '33-0', question: 'Senate: Third Reading' },
    { source_key: 'legiscan-1640-rollcall-821723', source_url: url, result: '29-4', question: 'Senate: Third Reading' },
  ];
  const v = confirmDuplicateGroup(rows, { castCount: 33 });
  assert.equal(v.duplicate, false);
  assert.equal(v.reason, 'different_result');
});

test('REFUSES a tiny cast list — mo-house-xml resolves against a one-legislator roster', () => {
  // HB2010-4 (conference report, 133-17) and HB2010-5 (third reading, 132-17) both carry ONE
  // resolved cast, so their fingerprints matched. Different votes entirely.
  const url = 'https://www.house.mo.gov/billtracking/bills261/rollcalls/067.019.pdf#x';
  const rows = [
    { source_key: 'mo-house-xml-HB2010-4', source_url: url, result: '133-17', question: 'Third Read and Passed' },
    { source_key: 'mo-house-xml-HB2010-5', source_url: url, result: '133-17', question: 'Third Read and Passed' },
  ];
  const v = confirmDuplicateGroup(rows, { castCount: 1 });
  assert.equal(v.duplicate, false);
  assert.equal(v.reason, 'cast_list_too_small');
});

test('REFUSES a cross-source pair — that is migration 0022 territory, never this rule', () => {
  const rows = [
    { source_key: 'legiscan-2169-rollcall-1495613', source_url: anchored, result: '32-0', question: 'Senate: Third Reading' },
    { source_key: 'mo-senate-web-2025-RDay25-vote1', source_url: anchored, result: '32-0', question: 'Senate: Third Reading' },
  ];
  const v = confirmDuplicateGroup(rows, { castCount: 32 });
  assert.equal(v.duplicate, false);
  assert.equal(v.reason, 'not_same_source');
});

test('REFUSES a single row, and refuses a missing source_url', () => {
  assert.equal(confirmDuplicateGroup([legiscanPair()[0]], { castCount: 32 }).reason, 'not_a_group');
  assert.equal(confirmDuplicateGroup(legiscanPair({ source_url: null }), { castCount: 32 }).reason, 'different_source_url');
});

test('the cast floor is exclusive at the boundary and defaults to DEFAULT_CAST_FLOOR', () => {
  assert.equal(confirmDuplicateGroup(legiscanPair(), { castCount: DEFAULT_CAST_FLOOR - 1 }).reason, 'cast_list_too_small');
  assert.equal(confirmDuplicateGroup(legiscanPair(), { castCount: DEFAULT_CAST_FLOOR }).duplicate, true);
});

// ---- canonical choice ----

test('sourceRecordId reads the trailing source record number', () => {
  assert.equal(sourceRecordId('legiscan-2169-rollcall-1497726'), 1497726);
  assert.equal(sourceRecordId('us-senate-119-1-332'), 332);
  assert.equal(sourceRecordId('no-trailing-number-'), null);
});

test('chooseCanonical picks the LOWEST source record id, regardless of array order', () => {
  const [a, b] = legiscanPair();          // a = ...1495613, b = ...1497726
  assert.equal(chooseCanonical([a, b]).canonical.source_key, 'legiscan-2169-rollcall-1495613');
  assert.equal(chooseCanonical([b, a]).canonical.source_key, 'legiscan-2169-rollcall-1495613');
  assert.equal(chooseCanonical([b, a]).superseded.length, 1);
  assert.equal(chooseCanonical([b, a]).superseded[0].source_key, 'legiscan-2169-rollcall-1497726');
});

test('chooseCanonical is stable across a rebuild — it reads the DATA, never insertion order', () => {
  // The whole reason the ruling is "lowest source record id" and not "earliest ingested": a
  // rebuild-from-scratch re-inserts in a different order, and a display that flips on rebuild is a
  // defect even though both rows remain stored.
  const rows = legiscanPair();
  assert.equal(
    chooseCanonical(rows).canonical.source_key,
    chooseCanonical([...rows].reverse()).canonical.source_key,
  );
});

test('chooseCanonical falls back to lexicographic order when there is no trailing number', () => {
  const rows = [
    { source_key: 'weird-key-b', source_url: anchored, result: '1-0', question: 'Q' },
    { source_key: 'weird-key-a', source_url: anchored, result: '1-0', question: 'Q' },
  ];
  assert.equal(chooseCanonical(rows).canonical.source_key, 'weird-key-a');
});
