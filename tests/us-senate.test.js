import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBillIdentifier } from '../src/adapters/us-congress.js';
import {
  parseSenateVoteMenu, parseSenateRollCall, mapSenatePosition, RollCallNotYetPublishedError,
} from '../src/adapters/us-senate.js';
import { SourceFetchError } from '../src/lib/errors.js';

const cfg = JSON.parse(readFileSync('slice.config.json', 'utf8'));
const menuXml = readFileSync('tests/fixtures/us-senate/vote-menu.xml', 'utf8');
const rollXml = readFileSync('tests/fixtures/us-senate/roll-call.xml', 'utf8');
// Live-captured 2026-08-01 against real senate.gov (session 119-2, vote numbers 220/250/999 -
// byte-identical across all three, confirming it's a fixed template, not per-vote content): the
// HTML "Roll Call Vote Unavailable" stub LIS serves with HTTP 200 for a vote number not yet cast.
const notYetPublishedHtml = readFileSync('tests/fixtures/us-senate/roll-call-unavailable.html', 'utf8');
// Live-captured 2026-09-26: since about 2026-09-18 senate.gov answers a not-yet-published vote
// number with a 301 to /legislative/roll-call-vote-not-available.htm; fetch follows it and gets
// this full site page, which fast-xml-parser throws on (the us-senate outage, 09-18 to 09-26).
const notAvailablePage = readFileSync('tests/fixtures/us-senate/roll-call-not-available-2026-09.html', 'utf8');

const POSITIONS = new Set(['yea', 'nay', 'present', 'not_voting', 'other']);

test('parseSenateVoteMenu yields well over 100 votes with int vote_number and ISO date', () => {
  const menu = parseSenateVoteMenu(menuXml);
  assert.ok(menu.length > 100, `expected >100 votes, got ${menu.length}`);
  for (const v of menu) {
    assert.equal(typeof v.vote_number, 'number');
    assert.ok(Number.isInteger(v.vote_number));
    assert.match(v.date, /^\d{4}-\d{2}-\d{2}$/, `bad date for vote ${v.vote_number}: ${v.date}`);
  }
});

test('parseSenateVoteMenu normalizes bill identifier on an On-Passage entry that has one', () => {
  const menu = parseSenateVoteMenu(menuXml);
  const entry = menu.find((v) => v.vote_number === cfg.us_senate.fixture_vote_number);
  assert.ok(entry, 'fixture vote number must be present in the menu fixture');
  assert.equal(entry.issue, cfg.us_senate.fixture_bill);
  assert.equal(normalizeBillIdentifier(entry.issue), 'HR 5371');
  assert.match(entry.question, /On Passage/i);
  assert.equal(entry.result, 'Passed');
});

test('parseSenateVoteMenu tolerates entries with no single issue (en bloc groups)', () => {
  const menu = parseSenateVoteMenu(menuXml);
  const enBlocLike = menu.filter((v) => v.issue === null);
  assert.ok(enBlocLike.length > 0, 'fixture is expected to contain en-bloc grouped votes with no top-level issue');
});

test('parseSenateRollCall yields a full-chamber cast list including both MO senators', () => {
  const { vote, casts } = parseSenateRollCall(rollXml);
  assert.equal(vote.chamber, 'senate');
  assert.equal(
    vote.source_key,
    `us-senate-${cfg.us_senate.fixture_congress}-${cfg.us_senate.fixture_session}-${cfg.us_senate.fixture_vote_number}`,
  );
  assert.equal(vote.vote_date, '2025-11-10');
  assert.match(vote.question, /On Passage/i);
  assert.ok(vote.result.length > 0);
  assert.equal(vote.bill_identifier, 'HR 5371');
  assert.ok(vote.source_url.startsWith('https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/'));

  assert.ok(casts.length >= 98 && casts.length <= 100, `expected 98-100 casts, got ${casts.length}`);
  for (const c of casts) {
    assert.ok(POSITIONS.has(c.position), `bad position: ${c.position}`);
    assert.ok(c.last_name.length > 0);
    assert.ok(['D', 'R', 'I', 'ID'].includes(c.party), `unexpected party: ${c.party}`);
  }
  const moSenators = casts.filter((c) => c.state === 'MO');
  assert.ok(moSenators.length > 0, 'at least one MO senator must be present');
  assert.ok(moSenators.some((c) => c.last_name === 'Hawley'));
});

// ---- defect fix (live scheduler crash, us-senate ingestion_runs row 2026-08-01T05:45:29Z):
// probing one vote number ahead of the last-cast vote during a recess used to crash the whole
// run with `TypeError: Cannot read properties of undefined (reading 'congress')`, because
// senate.gov's LIS system answers a not-yet-cast vote number with HTTP 200 (never a 404) and an
// HTML "Roll Call Vote Unavailable" stub instead of roll-call XML - so fetchSenateRollCall never
// throws, and parseSenateRollCall blew up reading a property off the (nonexistent) XML root.
// us-congress's sibling tail-probe already survives this exact scenario because clerk.house.gov
// answers with a real 404, which fetchWithLimit already turns into a SourceFetchError that
// collectUsSenate's per-vote `if (!(err instanceof SourceFetchError)) throw err;` catches,
// counts, and continues past. The fix makes parseSenateRollCall raise that same typed error for
// the equivalent senate.gov shape, so the existing catch handles it identically. ----

test('parseSenateRollCall throws RollCallNotYetPublishedError (a SourceFetchError) on the real senate.gov "Roll Call Vote Unavailable" stub, not a TypeError', () => {
  assert.throws(
    () => parseSenateRollCall(notYetPublishedHtml),
    (err) => {
      assert.ok(err instanceof RollCallNotYetPublishedError, `expected RollCallNotYetPublishedError, got ${err.constructor.name}`);
      // The load-bearing property: collectUsSenate's per-vote catch is `if (!(err instanceof
      // SourceFetchError)) throw err;` - unless this holds, the crash reproduces unchanged.
      assert.ok(err instanceof SourceFetchError, 'must be a SourceFetchError so collectUsSenate treats it as an expected miss, not a crash');
      assert.notEqual(err.constructor.name, 'TypeError');
      assert.equal(err.source, 'us-senate');
      assert.match(err.message, /not yet|unavailable/i);
      return true;
    },
  );
});

test('parseSenateRollCall still fails loudly (not a SourceFetchError) on a genuinely malformed payload for an existing vote, never confused with the not-yet-published stub', () => {
  // Well-formed enough for fast-xml-parser to accept without a parser-level exception (a raw XML
  // syntax error, e.g. an unclosed tag from mid-stream truncation, already fails loudly on its
  // own - fast-xml-parser throws directly and parseSenateRollCall does not wrap that call in a
  // try/catch, so nothing here needs to convert it). This is the OTHER malformed shape: a
  // response that parses fine but is neither a real roll call NOR the recognized "Roll Call Vote
  // Unavailable" stub (e.g. an unexpected error page, a differently-shaped upstream response) -
  // proving the fix's guard is scoped to the one recognized stub, not a blanket swallow of every
  // rootless payload.
  const corrupted = '<?xml version="1.0" encoding="UTF-8"?><corrupted_response>truncated mid-stream</corrupted_response>';
  assert.throws(
    () => parseSenateRollCall(corrupted),
    (err) => {
      assert.ok(!(err instanceof RollCallNotYetPublishedError), 'must not be misclassified as the not-yet-published case');
      assert.ok(!(err instanceof SourceFetchError), 'must NOT be a SourceFetchError - collectUsSenate must not swallow real corruption as an expected miss');
      assert.match(err.message, /genuine parse failure/);
      return true;
    },
  );
});

test('parseSenateRollCall lets a raw XML syntax error (e.g. mid-stream truncation cutting off the XML declaration itself) propagate unmodified - never reclassified as an expected miss', () => {
  // Real observed behavior: fast-xml-parser itself throws ("Pi Tag is not closed.") for input
  // this badly truncated, before parseSenateRollCall's own root-check ever runs. Confirms the fix
  // does not wrap xmlParser.parse() in a try/catch anywhere - a genuine parser-level exception
  // must reach the caller exactly as fast-xml-parser raised it.
  const truncated = rollXml.slice(0, 20);
  assert.throws(
    () => parseSenateRollCall(truncated),
    (err) => {
      assert.ok(!(err instanceof SourceFetchError), 'a raw parser exception must not be a SourceFetchError either');
      return true;
    },
  );
});

// ---- defect fix (2026-09-26, the 43-run us-senate outage of 2026-09-18 to 09-26): the stub moved
// behind a 301 to a full site page that fast-xml-parser throws on, and the marker check ran only
// after the parse, so it never ran. The check now reads the raw text first (PLAYBOOK_DELTA 65). ----

test('parseSenateRollCall classifies the 2026-09 not-available page (the 301 target) as not yet published, not a parser TypeError', () => {
  assert.throws(
    () => parseSenateRollCall(notAvailablePage),
    (err) => {
      assert.ok(err instanceof RollCallNotYetPublishedError, `expected RollCallNotYetPublishedError, got ${err.constructor.name}: ${err.message}`);
      assert.ok(err instanceof SourceFetchError, 'must be a SourceFetchError so collectUsSenate records an absence, not a crash');
      return true;
    },
  );
});

test('parseSenateRollCall never lets the marker text override a real roll call', () => {
  const withMarker = rollXml.replace('</roll_call_vote>', '<!-- Roll Call Vote Unavailable --></roll_call_vote>');
  assert.notEqual(withMarker, rollXml);
  const { vote } = parseSenateRollCall(withMarker);
  assert.equal(vote.bill_identifier, 'HR 5371');
});

// Senior engineering audit (2026-08-03, finding 8): parseSenateVoteMenu had the SAME unguarded
// `doc.vote_summary` root access parseSenateRollCall was already fixed for above — it just never
// got the same fix, so a malformed HTTP-200 response here crashed the WHOLE ingest run with a raw
// TypeError instead of a clean, loud Error. No known "not yet published" stub exists for the
// session-wide vote menu (that's a per-vote-number concept), so every rootless response here is
// treated as a genuine parse failure - proven against the SAME real captured fixture used above.
test('parseSenateVoteMenu throws a plain, descriptive Error (never a raw TypeError) on a response with no <vote_summary> root', () => {
  assert.throws(
    () => parseSenateVoteMenu(notYetPublishedHtml),
    (err) => {
      assert.notEqual(err.constructor.name, 'TypeError');
      assert.ok(!(err instanceof SourceFetchError), 'must not be misclassified as an expected miss - this needs to fail loudly');
      assert.match(err.message, /genuine parse failure/);
      assert.match(err.message, /<vote_summary>/);
      return true;
    },
  );
});

test('mapSenatePosition covers the documented enum, including impeachment-style Guilty/Not Guilty', () => {
  assert.equal(mapSenatePosition('Yea'), 'yea');
  assert.equal(mapSenatePosition('Guilty'), 'yea');
  assert.equal(mapSenatePosition('Nay'), 'nay');
  assert.equal(mapSenatePosition('Not Guilty'), 'nay');
  assert.equal(mapSenatePosition('Present'), 'present');
  assert.equal(mapSenatePosition('Not Voting'), 'not_voting');
  assert.equal(mapSenatePosition('Absent'), 'other');
});
