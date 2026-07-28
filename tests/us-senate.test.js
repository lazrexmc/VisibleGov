import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBillIdentifier } from '../src/adapters/us-congress.js';
import { parseSenateVoteMenu, parseSenateRollCall, mapSenatePosition } from '../src/adapters/us-senate.js';

const cfg = JSON.parse(readFileSync('slice.config.json', 'utf8'));
const menuXml = readFileSync('tests/fixtures/us-senate/vote-menu.xml', 'utf8');
const rollXml = readFileSync('tests/fixtures/us-senate/roll-call.xml', 'utf8');

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

test('mapSenatePosition covers the documented enum, including impeachment-style Guilty/Not Guilty', () => {
  assert.equal(mapSenatePosition('Yea'), 'yea');
  assert.equal(mapSenatePosition('Guilty'), 'yea');
  assert.equal(mapSenatePosition('Nay'), 'nay');
  assert.equal(mapSenatePosition('Not Guilty'), 'nay');
  assert.equal(mapSenatePosition('Present'), 'present');
  assert.equal(mapSenatePosition('Not Voting'), 'not_voting');
  assert.equal(mapSenatePosition('Absent'), 'other');
});
