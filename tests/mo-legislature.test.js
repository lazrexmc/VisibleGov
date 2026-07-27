import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSessions, parsePerson, parseBillsWithVotes } from '../src/adapters/mo-legislature.js';

const cfg = JSON.parse(readFileSync('slice.config.json', 'utf8'));
const sessionsJson = JSON.parse(readFileSync('tests/fixtures/mo-legislature/sessions.json', 'utf8'));
const peopleJson = JSON.parse(readFileSync('tests/fixtures/mo-legislature/people-onder.json', 'utf8'));
const billsJson = JSON.parse(readFileSync('tests/fixtures/mo-legislature/bills-with-votes.json', 'utf8'));

const POSITIONS = new Set(['yea', 'nay', 'present', 'not_voting', 'absent', 'other']);

test('parseSessions returns identified sessions', () => {
  const sessions = parseSessions(sessionsJson);
  assert.ok(sessions.length > 0);
  for (const s of sessions) assert.ok(s.identifier.length > 0);
  const wanted = new Set(cfg.mo_sessions);
  assert.ok(sessions.some((s) => wanted.has(s.identifier)), 'config sessions must exist upstream');
});

test('parsePerson extracts Onder (real fixture has no current_role/other_roles)', () => {
  const person = parsePerson(peopleJson);
  assert.equal(person.openstates_id, cfg.onder.openstates_id);
  assert.match(person.full_name, /Onder/);
  assert.equal(person.party, 'Republican');
  // Real people-onder.json fixture: retired member, no current_role, no other_roles.
  assert.deepEqual(person.roles, []);
});

test('parseBillsWithVotes yields canonical bills and enum-safe casts', () => {
  const items = parseBillsWithVotes(billsJson);
  assert.ok(items.length > 0);
  let totalVoteEvents = 0;
  for (const { bill, votes } of items) {
    assert.ok(bill.identifier.length > 0);
    assert.ok(bill.canonical_url.startsWith('https://'));
    for (const { vote, casts } of votes) {
      totalVoteEvents++;
      assert.ok(['house', 'senate'].includes(vote.chamber));
      assert.ok(vote.source_key.startsWith('mo-'));
      assert.ok(Array.isArray(casts));
      for (const c of casts) {
        assert.ok(POSITIONS.has(c.position), `bad position: ${c.position}`);
        assert.ok(c.voter_name.length > 0);
      }
    }
  }
  // Real bills-with-votes.json fixture: 95 vote events across 20 bills, all with empty
  // votes[]/counts[] upstream (per-cast assertions above are therefore vacuous but still
  // pinned as legal). 17/20 bills have a non-empty votes array.
  assert.equal(totalVoteEvents, 95);
  const billsWithVotes = items.filter((i) => i.votes.length > 0);
  assert.ok(billsWithVotes.length > 0, 'at least one bill has a non-empty votes array');
});
