import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeBillIdentifier, billTypeSlug, parseMemberList, parseHouseRollCall, parseBillDetail,
} from '../src/adapters/us-congress.js';

const cfg = JSON.parse(readFileSync('slice.config.json', 'utf8'));
const membersJson = JSON.parse(readFileSync('tests/fixtures/us-congress/members-mo.json', 'utf8'));
const rollXml = readFileSync('tests/fixtures/us-congress/roll-call.xml', 'utf8');
const billJson = JSON.parse(readFileSync('tests/fixtures/us-congress/bill-detail.json', 'utf8'));

const POSITIONS = new Set(['yea', 'nay', 'present', 'not_voting', 'absent', 'other']);

test('normalizeBillIdentifier collapses Clerk spacing', () => {
  assert.equal(normalizeBillIdentifier('H R 22'), 'HR 22');
  assert.equal(normalizeBillIdentifier('S 5'), 'S 5');
  assert.equal(normalizeBillIdentifier('H J RES 7'), 'HJRES 7');
  assert.equal(normalizeBillIdentifier('H CON RES 14'), 'HCONRES 14');
});

test('billTypeSlug lowers the type part', () => {
  assert.equal(billTypeSlug('HR 22'), 'hr');
  assert.equal(billTypeSlug('SJRES 3'), 'sjres');
});

test('parseMemberList finds Onder with verified identity', () => {
  const members = parseMemberList(membersJson);
  assert.ok(members.length > 0);
  const onder = members.find((m) => m.bioguide_id === cfg.onder.bioguide_id);
  assert.ok(onder, 'Onder must be present in the MO delegation fixture');
  assert.match(onder.full_name, /Onder/);
  for (const m of members) assert.ok(['house', 'senate'].includes(m.chamber));
});

test('parseHouseRollCall yields a full-chamber cast list including Onder', () => {
  const { vote, casts } = parseHouseRollCall(rollXml, { year: 2025 });
  assert.equal(vote.chamber, 'house');
  assert.ok(vote.source_key.startsWith('us-house-'));
  assert.ok(vote.question.length > 0);
  assert.ok(vote.result.length > 0);
  // self-consistency: one cast per <recorded-vote> element in the raw XML
  const rawCount = (rollXml.match(/<recorded-vote>/g) || []).length;
  assert.equal(casts.length, rawCount);
  assert.ok(casts.length > 300, 'a full House roll call has 400+ voting members');
  for (const c of casts) assert.ok(POSITIONS.has(c.position), `bad position: ${c.position}`);
  assert.ok(casts.some((c) => c.bioguide_id === cfg.onder.bioguide_id));
});

test('parseMemberList throws on a member with no chamber signal', () => {
  const bad = { members: [{ bioguideId: 'X000000', name: 'Test', partyName: 'I', terms: { item: [] } }] };
  assert.throws(() => parseMemberList(bad), /unknown chamber/);
});

test('parseBillDetail extracts canonical bill fields', () => {
  const bill = parseBillDetail(billJson);
  assert.match(bill.identifier, /^(HR|S|HRES|SRES|HJRES|SJRES|HCONRES|SCONRES) \d+$/);
  assert.ok(bill.title.length > 0);
  assert.ok(bill.canonical_url.startsWith('https://www.congress.gov/'));
});
