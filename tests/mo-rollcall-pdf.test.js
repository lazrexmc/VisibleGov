import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE, extractRollCallText, parseMoRollCall, resolveMoRep, RollCallParseError,
} from '../src/adapters/mo-rollcall-pdf.js';
import { SOURCE as MO_HOUSE_SOURCE, moHouseLimiter } from '../src/adapters/mo-house-xml.js';

const FIXTURE_PDF = 'tests/fixtures/research/mo-house-xml/rollcall-034.008.pdf';

// Known ground truth (task-4b-brief.md): 82 yes / 61 no / 2 present / 13 absent / 5 vacancies;
// MATTHIESEN voted Y; duplicate-surname suffixes appear as SMITH 46/68/74, TAYLOR 48/84, JONES
// 12/88. Loaded once and reused - extractRollCallText is the only async step, and every test below
// exercises the real fixture (never a hand-written PDF byte string).
const pdfBuffer = readFileSync(FIXTURE_PDF);
const realText = await extractRollCallText(pdfBuffer);
const realParsed = parseMoRollCall(realText);

// ---- constants / fetch wiring ----

test('SOURCE and the fetch limiter are shared with mo-house-xml.js (same host, same 30-min ToU cooldown)', () => {
  assert.equal(SOURCE, 'mo-house-xml');
  assert.equal(SOURCE, MO_HOUSE_SOURCE);
});

test('moHouseLimiter re-exported by mo-house-xml.js is the actual limiter instance PDF fetches share', () => {
  assert.ok(moHouseLimiter && typeof moHouseLimiter.take === 'function');
});

// ---- extractRollCallText (real PDF, pdfjs-dist legacy build) ----

test('extractRollCallText returns page-ordered text containing the known roll-call header and body', () => {
  assert.equal(typeof realText, 'string');
  assert.ok(realText.includes('Roll Call'));
  assert.ok(realText.includes('MATTHIESEN'));
  assert.ok(realText.includes('Total Yes'));
});

// ---- parseMoRollCall: reconciliation against the real fixture ----

test('parseMoRollCall (real fixture): tallies match the known ground truth exactly', () => {
  assert.deepEqual(realParsed.tallies, { yes: 82, no: 61, present: 2, absent: 13, vacancies: 5 });
});

test('parseMoRollCall (real fixture): parsed cast count equals yes+no+present+absent (vacancies are empty seats, not casts)', () => {
  assert.equal(realParsed.casts.length, 82 + 61 + 2 + 13);
});

test('parseMoRollCall (real fixture): MATTHIESEN voted yea, no district printed (unique surname)', () => {
  const matthiesen = realParsed.casts.find((c) => c.surname === 'MATTHIESEN');
  assert.ok(matthiesen, 'MATTHIESEN must appear in the parsed casts');
  assert.equal(matthiesen.position, 'yea');
  assert.equal(matthiesen.district, null);
});

test('parseMoRollCall (real fixture): duplicate-surname entries carry the printed district number', () => {
  const bySurname = (surname) => realParsed.casts.filter((c) => c.surname === surname);
  assert.deepEqual(
    bySurname('SMITH').map((c) => c.district).sort(),
    ['46', '68', '74'],
  );
  assert.ok(bySurname('SMITH').every((c) => c.position === 'nay'));
  assert.deepEqual(bySurname('TAYLOR').map((c) => c.district).sort(), ['48', '84']);
  assert.deepEqual(bySurname('JONES').map((c) => c.district).sort(), ['12', '88']);
  assert.ok(bySurname('JONES').every((c) => c.position === 'yea'));
});

test('parseMoRollCall (real fixture): surnames are printed uppercase, exactly as in the source', () => {
  for (const c of realParsed.casts) {
    assert.equal(c.surname, c.surname.toUpperCase(), `expected uppercase surname, got "${c.surname}"`);
  }
});

test('parseMoRollCall (real fixture): non-duplicate entries carry no district', () => {
  const nonDuplicateSurnames = new Set(['SMITH', 'TAYLOR', 'JONES', 'SHARP', 'SHARPE']);
  for (const c of realParsed.casts) {
    if (!nonDuplicateSurnames.has(c.surname)) assert.equal(c.district, null, `unexpected district on ${c.surname}`);
  }
});

test('parseMoRollCall (real fixture): multi-word surnames parse whole (no hyphen/apostrophe in this fixture)', () => {
  assert.ok(realParsed.casts.some((c) => c.surname === 'FOUNTAIN HENDERS' && c.position === 'nay'));
  assert.ok(realParsed.casts.some((c) => c.surname === 'WALSH MOORE' && c.position === 'nay'));
});

test('parseMoRollCall (real fixture): the Speaker\'s own line (MR SPEAKER, printed alphabetically last, not a real surname) parses as an ordinary cast', () => {
  const speaker = realParsed.casts.find((c) => c.surname === 'MR SPEAKER');
  assert.ok(speaker);
  assert.equal(speaker.position, 'yea');
  assert.equal(speaker.district, null);
});

// ---- parseMoRollCall: reconciliation failure (integrity gate) ----
//
// Per task-4b-brief.md: constructed via a synthetic TEXT string fed directly to the parser, never
// by editing the real PDF - the real fixture's own tallies always reconcile (that's the whole
// point of it being the ground-truth fixture).

test('parseMoRollCall throws RollCallParseError (never returns) when a cast count does not reconcile with the printed tally', () => {
  const doctored = 'Roll Call : 1\n'
    + 'Y - ALLEN N - BAKER Y - CARTER\n'
    + 'Total Yes : 5\nTotal Present : 0\nTotal No : 1\nTotal Absent : 0\nVacancies : 0';
  // printed says 5 yes, but only 2 Y tokens are actually present above - must not reconcile
  assert.throws(() => parseMoRollCall(doctored), (err) => {
    assert.ok(err instanceof RollCallParseError);
    assert.equal(err.name, 'RollCallParseError');
    assert.match(err.message, /do not reconcile/);
    assert.equal(err.tallies.yes, 5);
    assert.equal(err.counted.yes, 2);
    return true;
  });
});

test('parseMoRollCall reconciliation failure carries enough detail to debug without re-parsing (tallies + counted + castCount on the error)', () => {
  const doctored = 'Roll Call : 1\nN - ONLYNAY\nTotal Yes : 1\nTotal Present : 0\nTotal No : 0\nTotal Absent : 0\nVacancies : 0';
  try {
    parseMoRollCall(doctored);
    assert.fail('expected RollCallParseError');
  } catch (err) {
    assert.ok(err instanceof RollCallParseError);
    assert.deepEqual(err.tallies, { yes: 1, present: 0, no: 0, absent: 0, vacancies: 0 });
    assert.deepEqual(err.counted, { yes: 0, no: 1, present: 0, absent: 0 });
    assert.equal(err.castCount, 1);
  }
});

test('parseMoRollCall throws RollCallParseError when the text has no recognizable roll-call anchors at all', () => {
  assert.throws(() => parseMoRollCall('this is not a roll call document'), (err) => {
    assert.ok(err instanceof RollCallParseError);
    return true;
  });
});

// A reconciling-but-doctored input (surname text edited, tallies untouched, counts still add up)
// must NOT throw - the gate is on counts, not content, and this is the mechanism buildMoVoteRows-
// style callers rely on to trust a reconciling result is safe to store.
test('parseMoRollCall does not throw when a synthetic roll call reconciles cleanly', () => {
  const clean = 'Roll Call : 2\n'
    + 'Y - ALLEN N - BAKER P - CARTER @ - DOE\n'
    + 'Total Yes : 1\nTotal Present : 1\nTotal No : 1\nTotal Absent : 1\nVacancies : 0';
  const { tallies, casts } = parseMoRollCall(clean);
  assert.deepEqual(tallies, { yes: 1, present: 1, no: 1, absent: 1, vacancies: 0 });
  assert.equal(casts.length, 4);
});

// ---- resolveMoRep ----

const ROSTER = [
  { legislator_id: 'leg-matthiesen', surname: 'Matthiesen', mo_house_id: '107' },
  { legislator_id: 'leg-smith-46', surname: 'Smith', mo_house_id: '46' },
  { legislator_id: 'leg-smith-68', surname: 'Smith', mo_house_id: '68' },
  { legislator_id: 'leg-smith-74', surname: 'Smith', mo_house_id: '74' },
];

test('resolveMoRep: unique surname resolves without needing a district (MATTHIESEN)', () => {
  const cast = { surname: 'MATTHIESEN', district: null, position: 'yea' };
  assert.equal(resolveMoRep(cast, ROSTER), 'leg-matthiesen');
});

test('resolveMoRep: exact surname+district match resolves a duplicate surname (SMITH 46)', () => {
  const cast = { surname: 'SMITH', district: '46', position: 'nay' };
  assert.equal(resolveMoRep(cast, ROSTER), 'leg-smith-46');
});

test('resolveMoRep: matches case-insensitively and trims whitespace', () => {
  const cast = { surname: ' smith ', district: ' 68 ', position: 'nay' };
  assert.equal(resolveMoRep(cast, ROSTER), 'leg-smith-68');
});

test('resolveMoRep: a SMITH cast WITHOUT a district is ambiguous against 3 SMITH roster rows -> null (never guessed)', () => {
  const cast = { surname: 'SMITH', district: null, position: 'nay' };
  assert.equal(resolveMoRep(cast, ROSTER), null);
});

test('resolveMoRep: a district that does not match any roster row for that surname -> null (miss, not a guess)', () => {
  const cast = { surname: 'SMITH', district: '99', position: 'nay' };
  assert.equal(resolveMoRep(cast, ROSTER), null);
});

test('resolveMoRep: an unknown surname -> null (miss)', () => {
  const cast = { surname: 'NOSUCHREP', district: null, position: 'yea' };
  assert.equal(resolveMoRep(cast, ROSTER), null);
});

test('resolveMoRep: the Speaker\'s "MR SPEAKER" line does not resolve against a normal surname roster -> null, unresolved (same fail-loud pattern as everywhere else)', () => {
  const cast = { surname: 'MR SPEAKER', district: null, position: 'yea' };
  assert.equal(resolveMoRep(cast, ROSTER), null);
});

test('resolveMoRep: returns null against an empty roster', () => {
  const cast = { surname: 'MATTHIESEN', district: null, position: 'yea' };
  assert.equal(resolveMoRep(cast, []), null);
});

// ---- end-to-end sanity: real fixture casts resolve against a roster built the way Task 4's
// mo-house-xml roster ingestion actually shapes rows (surname + mo_house_id) ----

test('end-to-end: resolveMoRep against a roster containing the real fixture\'s legislators resolves MATTHIESEN and a districted SMITH, and leaves a non-roster SMITH unresolved', () => {
  const roster = [
    { legislator_id: 'leg-matthiesen', surname: 'MATTHIESEN', mo_house_id: '107' },
    { legislator_id: 'leg-smith-46', surname: 'SMITH', mo_house_id: '46' },
    // deliberately omit SMITH 68 / SMITH 74 from the roster - a realistic "roster not fully
    // ingested yet" gap, exercising the miss path end to end against real parsed casts.
  ];
  const matthiesen = realParsed.casts.find((c) => c.surname === 'MATTHIESEN');
  const smith46 = realParsed.casts.find((c) => c.surname === 'SMITH' && c.district === '46');
  const smith68 = realParsed.casts.find((c) => c.surname === 'SMITH' && c.district === '68');
  assert.equal(resolveMoRep(matthiesen, roster), 'leg-matthiesen');
  assert.equal(resolveMoRep(smith46, roster), 'leg-smith-46');
  assert.equal(resolveMoRep(smith68, roster), null);
});

// ---- Task 4b fix round: proving loadMoRoster's fallback heuristic can never silently misattribute
// a vote, only ever miss (fail-loud, same as everywhere else in this codebase) ----
//
// Review finding: ingest-mo-house.js's loadMoRoster ONLY falls back to reconstructing a surname
// from full_name ("everything after the first space") when legislators.surname (migration 0006)
// is null despite the column existing — the primary path now uses the real ingested surname. This
// test proves the CONSEQUENCE of that fallback ever firing for a multi-word-first-name legislator:
// resolveMoRep's exact-match semantics mean the wrong reconstructed surname simply fails to match
// the real printed surname on any cast — it can never accidentally match a DIFFERENT legislator
// either, since the match is on the (wrong) string itself, not a lookup that could collide.
test('resolveMoRep: a roster surname reconstructed via the full_name fallback heuristic misses a legislator with a multi-word first name (recorded unresolved, never silently dropped)', () => {
  // "Mary Jane Smith" would reconstruct (loadMoRoster's fallback) to "Jane Smith" - see
  // reconstructSurnameHeuristic's own test in tests/mo-house-xml.test.js for that value directly.
  const rosterWithBadFallback = [
    { legislator_id: 'leg-real-smith', surname: 'Jane Smith', mo_house_id: '46' },
  ];
  // The real roll call prints the legislator's actual surname, 'SMITH', with district '46'.
  const cast = { surname: 'SMITH', district: '46', position: 'nay' };
  const resolved = resolveMoRep(cast, rosterWithBadFallback);
  assert.equal(resolved, null, 'a wrong reconstructed surname must miss, not silently resolve to the wrong-looking entry');
  // Simulate exactly what persistRollCallCasts/replayArtifacts do with a miss: it lands in
  // unresolved[], never dropped and never inserted anywhere.
  const unresolved = [];
  const resolvedRows = [];
  const legislatorId = resolveMoRep(cast, rosterWithBadFallback);
  if (legislatorId) resolvedRows.push({ legislator_id: legislatorId, ...cast });
  else unresolved.push(cast);
  assert.deepEqual(resolvedRows, []);
  assert.deepEqual(unresolved, [cast]);
});
