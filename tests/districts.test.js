// tests/districts.test.js — TDD for site/js/districts.js (task-8-brief.md, Step 1). Written
// BEFORE site/js/districts.js exists (fails first per the brief's TDD discipline).
//
// parseGeographies is exercised against a REAL captured Census Geocoder payload
// (tests/fixtures/census/capitol.json — the MO State Capitol, a public landmark, never a
// private address). CENSUS-SHAPE SURPRISE vs the brief's field guesses (both noted in the task
// report): (1) the live vintage value is `Current_Current`, not `Current` — the brief's draft
// geocode.js code uses the wrong value and would 400 on every real request; corrected in
// site/functions/geocode.js. (2) the live geography layer keys carry a year/congress-number
// PREFIX the brief did not anticipate — `"119th Congressional Districts"` and `"2024 State
// Legislative Districts - Upper/Lower"`, not the bare `"Congressional Districts"` / `"State
// Legislative Districts - Upper/Lower"` the brief's prefix-match guess assumed. Matching by
// PREFIX (`startsWith`) would therefore never match live data — parseGeographies matches by
// substring (`includes`) instead, which is robust to both the current prefix and any future
// congress/year the Bureau ships. The FIELD names themselves (STUSAB, CD119, BASENAME, SLDU,
// SLDL) matched the brief's guesses exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseGeographies, normalizeDistrict, matchReps, termDateEvidence,
} from '../site/js/districts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPITOL_FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/census/capitol.json'), 'utf8'),
);

// ============================================================================
// normalizeDistrict
// ============================================================================

test('normalizeDistrict: strips leading zeros', () => {
  assert.equal(normalizeDistrict('02'), '2');
  assert.equal(normalizeDistrict('060'), '60');
  assert.equal(normalizeDistrict('3'), '3');
});

test('normalizeDistrict: an all-zero district ("00", at-large) normalizes to "0", not empty', () => {
  assert.equal(normalizeDistrict('00'), '0');
  assert.equal(normalizeDistrict('0'), '0');
});

test('normalizeDistrict: null/undefined/empty -> null, never throws', () => {
  assert.equal(normalizeDistrict(null), null);
  assert.equal(normalizeDistrict(undefined), null);
  assert.equal(normalizeDistrict(''), null);
  assert.equal(normalizeDistrict('   '), null);
});

test('normalizeDistrict: a non-numeric district string passes through unchanged (e.g. an at-large "MO"-shaped value would be handled by callers, not here)', () => {
  assert.equal(normalizeDistrict('AL'), 'AL');
});

// ============================================================================
// parseGeographies — real captured Census payload (Step 1: capture once, commit as fixture)
// ============================================================================

test('parseGeographies: the real MO State Capitol payload parses to the exact expected districts', () => {
  const result = parseGeographies(CAPITOL_FIXTURE);
  assert.deepEqual(result, {
    state: 'MO', cd: '3', sldu: '6', sldl: '60',
  });
});

test('parseGeographies: no addressMatches (garbage/unmatched address) -> all nulls, never throws', () => {
  const noMatch = { result: { input: {}, addressMatches: [] } };
  assert.deepEqual(parseGeographies(noMatch), {
    state: null, cd: null, sldu: null, sldl: null,
  });
});

test('parseGeographies: malformed/empty input never throws -> all nulls', () => {
  assert.deepEqual(parseGeographies(null), {
    state: null, cd: null, sldu: null, sldl: null,
  });
  assert.deepEqual(parseGeographies(undefined), {
    state: null, cd: null, sldu: null, sldl: null,
  });
  assert.deepEqual(parseGeographies({}), {
    state: null, cd: null, sldu: null, sldl: null,
  });
  assert.deepEqual(parseGeographies({ result: {} }), {
    state: null, cd: null, sldu: null, sldl: null,
  });
});

// Live-shape regression: the real layer keys carry a year/congress prefix
// ("119th Congressional Districts", "2024 State Legislative Districts - Upper/Lower") that the
// brief's own prefix-match guess ('Congressional Districts', 'State Legislative Districts -
// Upper') would NOT have matched with startsWith. This constructs a hand-built payload using a
// DIFFERENT (future-plausible) prefix to prove the matcher is substring-based, not tied to one
// hardcoded congress number.
test('parseGeographies: layer-key matching is substring-based, robust to a different congress/year prefix', () => {
  const futureShaped = {
    result: {
      addressMatches: [{
        geographies: {
          States: [{ STUSAB: 'MO' }],
          '120th Congressional Districts': [{ CD119: undefined, BASENAME: '3', CD120: '03' }],
          '2026 State Legislative Districts - Upper': [{ SLDU: '006', BASENAME: '6' }],
          '2026 State Legislative Districts - Lower': [{ SLDL: '060', BASENAME: '60' }],
        },
      }],
    },
  };
  const result = parseGeographies(futureShaped);
  // A future congress's own numbered field (CD120) isn't specifically named by this module (it
  // only knows CD119 today) — BASENAME is the congress-number-agnostic fallback field, and this
  // proves the layer gets FOUND (substring match) and its BASENAME read correctly either way.
  assert.equal(result.state, 'MO');
  assert.equal(result.cd, '3');
  assert.equal(result.sldu, '6');
  assert.equal(result.sldl, '60');
});

// MED-5 (task-8 review): a geocode result that matches a state but is missing one specific
// district layer (the Census Geocoder can legitimately omit a layer for some addresses — PO
// boxes, edge cases) must parse to a null for JUST that field, never throw and never silently
// fabricate a district from a different layer. site/js/directory-page.js's renderMatchedReps
// renders an honest "the geocoder didn't return your district" message for this exact case,
// distinct from "we checked and found no representative."
test('parseGeographies: state matched but the Congressional Districts layer is entirely absent -> cd is null, sldu/sldl still parse normally', () => {
  const missingCdLayer = {
    result: {
      addressMatches: [{
        geographies: {
          States: [{ STUSAB: 'MO' }],
          '2024 State Legislative Districts - Upper': [{ SLDU: '006', BASENAME: '6' }],
          '2024 State Legislative Districts - Lower': [{ SLDL: '060', BASENAME: '60' }],
          // no Congressional Districts layer at all
        },
      }],
    },
  };
  const result = parseGeographies(missingCdLayer);
  assert.equal(result.state, 'MO');
  assert.equal(result.cd, null);
  assert.equal(result.sldu, '6');
  assert.equal(result.sldl, '60');
});

// ============================================================================
// matchReps — currency-honest district matching against a terms/legislators fixture
// ============================================================================

const LEG = {
  senA: { id: 'leg-sen-a', full_name: 'Senator A', party: 'Democratic' },
  senB: { id: 'leg-sen-b', full_name: 'Senator B', party: 'Republican' },
  houseRep: { id: 'leg-house-3', full_name: 'Rep House Three', party: 'Republican' },
  moSenOld: { id: 'leg-mo-sen-old', full_name: 'Old MO Senator', party: 'Democratic' },
  moSenNew: { id: 'leg-mo-sen-new', full_name: 'New MO Senator', party: 'Republican' },
  moHouseRep: { id: 'leg-mo-house-60', full_name: 'MO House Sixty', party: 'Democratic' },
  otherStateSen: { id: 'leg-other-state', full_name: 'Other State Senator', party: 'Independent' },
};
const ALL_LEGISLATORS = Object.values(LEG);

const MATCH_TARGET = {
  state: 'MO', cd: '3', sldu: '6', sldl: '60',
};

test('matchReps: matches us senators (state via term.state), us house (state+district), MO senate/house (district only, MO gated), with real dates -> asOf never says "current"', () => {
  const terms = [
    {
      legislator_id: 'leg-sen-a', jurisdiction_id: 'us-congress', chamber: 'senate', state: 'MO', district: null, start_date: '2019-01-03', end_date: null,
    },
    {
      legislator_id: 'leg-sen-b', jurisdiction_id: 'us-congress', chamber: 'senate', state: null, district: 'MO', start_date: '2023-01-03', end_date: null,
    },
    {
      legislator_id: 'leg-house-3', jurisdiction_id: 'us-congress', chamber: 'house', state: 'MO', district: '3', start_date: '2023-01-03', end_date: null,
    },
    {
      legislator_id: 'leg-mo-sen-new', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '006', start_date: '2021-01-06', end_date: null,
    },
    {
      legislator_id: 'leg-mo-house-60', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '060', start_date: '2025-01-08', end_date: null,
    },
    // A non-matching row: a different state's US senator, must never appear.
    {
      legislator_id: 'leg-other-state', jurisdiction_id: 'us-congress', chamber: 'senate', state: 'KS', district: null, start_date: '2020-01-03', end_date: null,
    },
  ];

  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, MATCH_TARGET);

  assert.equal(result.usSenators.length, 2, 'both MO US senators matched (state via term.state, and via term.district fallback)');
  assert.deepEqual(
    result.usSenators.map((c) => c.legislator.id).sort(),
    ['leg-sen-a', 'leg-sen-b'],
  );

  assert.equal(result.usHouse.length, 1);
  assert.equal(result.usHouse[0].legislator.id, 'leg-house-3');

  assert.equal(result.moSenate.length, 1);
  assert.equal(result.moSenate[0].legislator.id, 'leg-mo-sen-new');

  assert.equal(result.moHouse.length, 1);
  assert.equal(result.moHouse[0].legislator.id, 'leg-mo-house-60');

  assert.doesNotMatch(result.asOf.toLowerCase(), /current/, 'the word "current" must never appear in the as-of label');
  assert.match(result.asOf, /2025-01-08/, 'asOf reflects the most recent matched term start_date when dates are present');
});

test('matchReps: ambiguous MO Senate seat (era overlap unprovable) returns ALL matching legislators, not a guessed winner', () => {
  const terms = [
    {
      legislator_id: 'leg-mo-sen-old', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '6', start_date: '2017-01-04', end_date: '2021-01-05',
    },
    {
      legislator_id: 'leg-mo-sen-new', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '6', start_date: '2021-01-06', end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, MATCH_TARGET);
  assert.equal(result.moSenate.length, 2, 'both candidates for the same seat are returned honestly, never picked between');
  assert.deepEqual(
    result.moSenate.map((c) => c.legislator.id).sort(),
    ['leg-mo-sen-new', 'leg-mo-sen-old'],
  );
  // Each candidate carries its OWN term (the "date evidence" the UI renders per candidate).
  const old = result.moSenate.find((c) => c.legislator.id === 'leg-mo-sen-old');
  assert.equal(old.term.end_date, '2021-01-05');
});

test('matchReps: no matched term carries a start_date -> asOf is the exact honest fallback string, verbatim', () => {
  const terms = [
    {
      legislator_id: 'leg-mo-house-60', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '60', start_date: null, end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, MATCH_TARGET);
  assert.equal(result.moHouse.length, 1);
  assert.equal(result.asOf, 'per the most recent term evidence in our data (dates unrecorded)');
});

// Fix round 1 (task-8 review, LOW-6): the dates-present asOf form is a variant of the SAME lead-in
// sentence as the fallback, not a differently-worded one.
test('matchReps: with real dates present, asOf reads "...(most recent: <date>)", the exact new format', () => {
  const terms = [
    {
      legislator_id: 'leg-house-3', jurisdiction_id: 'us-congress', chamber: 'house', state: 'MO', district: '3', start_date: '2023-01-03', end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, MATCH_TARGET);
  assert.equal(result.asOf, 'per the most recent term evidence in our data (most recent: 2023-01-03)');
});

// MAJOR-2 (task-8 review, live-verified): six states (AK/DE/ND/SD/VT/WY) have exactly one,
// at-large, statewide U.S. House seat. The federal ingestion adapter stores that seat's
// `district` as null (its own convention), while the Census Geocoder returns CD119='00' for an
// at-large address, normalized to '0' by normalizeDistrict. Without the bridge, null can never
// equal '0' and the at-large state's House seat wrongly reports "not found" despite real data
// existing for it. Reviewer's own construction: Wyoming.
test('matchReps: MAJOR-2 at-large bridge — a null-district U.S. House term matches when cd is "0" (Wyoming construction)', () => {
  const wyRep = { id: 'leg-wy-house', full_name: 'WY At-Large Rep', party: 'Republican' };
  const terms = [
    {
      legislator_id: 'leg-wy-house', jurisdiction_id: 'us-congress', chamber: 'house', state: 'WY', district: null, start_date: '2023-01-03', end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: [wyRep] }, {
    state: 'WY', cd: '0', sldu: null, sldl: null,
  });
  assert.equal(result.usHouse.length, 1, 'the at-large seat matches despite term.district being null');
  assert.equal(result.usHouse[0].legislator.id, 'leg-wy-house');
});

test('matchReps: the at-large bridge is narrow — a null-district term does NOT match any OTHER cd value, only "0"', () => {
  const terms = [
    {
      legislator_id: 'leg-wy-house', jurisdiction_id: 'us-congress', chamber: 'house', state: 'WY', district: null, start_date: '2023-01-03', end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, {
    state: 'WY', cd: '3', sldu: null, sldl: null,
  });
  assert.equal(result.usHouse.length, 0, 'a null district only bridges to cd==="0", never any other real district number');
});

test('matchReps: the at-large bridge does not fire for a normal (non-at-large) state with a real numbered district', () => {
  const terms = [
    {
      legislator_id: 'leg-house-3', jurisdiction_id: 'us-congress', chamber: 'house', state: 'MO', district: '3', start_date: '2023-01-03', end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, {
    state: 'MO', cd: '0', sldu: null, sldl: null,
  });
  assert.equal(result.usHouse.length, 0, 'MO district 3 must never match a stray cd="0" target');
});

// LOW-13 (task-8 review): state comparisons are case-insensitive on both sides — STUSAB from
// Census is always uppercase in practice, but terms.state/district values are filled by several
// independent adapters/backfills, so matching must not depend on every writer's casing matching
// Census's by coincidence.
test('matchReps: LOW-13 — state comparisons are case-insensitive (a lowercase term.state still matches an uppercase target state)', () => {
  const terms = [
    {
      legislator_id: 'leg-sen-a', jurisdiction_id: 'us-congress', chamber: 'senate', state: 'mo', district: null, start_date: '2019-01-03', end_date: null,
    },
    {
      legislator_id: 'leg-house-3', jurisdiction_id: 'us-congress', chamber: 'house', state: 'mo', district: '3', start_date: '2023-01-03', end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, MATCH_TARGET);
  assert.equal(result.usSenators.length, 1);
  assert.equal(result.usHouse.length, 1);
});

test('matchReps: LOW-13 — a lowercase target state still matches MO Senate/House seats (isMO check is case-insensitive too)', () => {
  const terms = [
    {
      legislator_id: 'leg-mo-sen-new', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '6', start_date: '2021-01-06', end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, {
    state: 'mo', cd: '3', sldu: '6', sldl: '60',
  });
  assert.equal(result.moSenate.length, 1);
});

test('matchReps: a non-MO state never matches MO seats even if district numbers coincidentally line up', () => {
  const terms = [
    {
      legislator_id: 'leg-mo-sen-new', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '6', start_date: '2021-01-06', end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, {
    state: 'KS', cd: '3', sldu: '6', sldl: '60',
  });
  assert.equal(result.moSenate.length, 0);
  assert.equal(result.moHouse.length, 0);
});

test('matchReps: nothing matches -> empty arrays everywhere and the honest fallback asOf, never throws', () => {
  const result = matchReps({ terms: [], legislators: [] }, MATCH_TARGET);
  assert.deepEqual(result.usSenators, []);
  assert.deepEqual(result.usHouse, []);
  assert.deepEqual(result.moSenate, []);
  assert.deepEqual(result.moHouse, []);
  assert.equal(result.asOf, 'per the most recent term evidence in our data (dates unrecorded)');
});

test('matchReps: a null cd/sldu/sldl target (geocoder found the state but not a district) matches nothing for that category', () => {
  const terms = [
    {
      legislator_id: 'leg-house-3', jurisdiction_id: 'us-congress', chamber: 'house', state: 'MO', district: '3', start_date: '2023-01-03', end_date: null,
    },
  ];
  const result = matchReps({ terms, legislators: ALL_LEGISLATORS }, {
    state: 'MO', cd: null, sldu: null, sldl: null,
  });
  assert.equal(result.usHouse.length, 0);
  assert.equal(result.moSenate.length, 0);
  assert.equal(result.moHouse.length, 0);
});

test('matchReps: malformed/missing inputs never throw', () => {
  assert.doesNotThrow(() => matchReps({}, {}));
  assert.doesNotThrow(() => matchReps({ terms: null, legislators: null }, { state: null, cd: null, sldu: null, sldl: null }));
});

// ============================================================================
// termDateEvidence — per-candidate honest date rendering (the "date evidence" the brief requires
// on ambiguous-seat multi-match results). Mirrors profile-model.js's careerSpan honesty rules
// (never "present"/"current"; an open end says so) at the single-term level.
// ============================================================================

test('termDateEvidence: a term with both dates renders the range', () => {
  assert.equal(termDateEvidence({ start_date: '2021-01-06', end_date: '2025-01-08' }), '2021-01-06 – 2025-01-08');
});

// Changed 2026-08-30 alongside careerSpan. These two describe the same term in two different
// places, and a district lookup wording it differently from the profile is exactly the drift that
// makes a reader distrust both. The rule that survives is the narrower one: "present" is earned by
// an OPEN END and never by an absent START, which is genuinely unknown rather than open.
test('termDateEvidence: an open end_date renders "present", matching careerSpan', () => {
  const evidence = termDateEvidence({ start_date: '2021-01-06', end_date: null });
  assert.match(evidence, /present$/);
  assert.match(evidence, /^2021-01-06/, 'the start date is a fact we hold and must still be shown');

  // A missing start is NOT an open end. It must never borrow "present".
  const noStart = termDateEvidence({ start_date: null, end_date: null });
  assert.doesNotMatch(noStart.toLowerCase(), /present|current/);
});

test('termDateEvidence: no start_date at all -> "dates unrecorded"', () => {
  assert.equal(termDateEvidence({ start_date: null, end_date: null }), 'dates unrecorded');
  assert.equal(termDateEvidence(null), 'dates unrecorded');
  assert.equal(termDateEvidence(undefined), 'dates unrecorded');
});
