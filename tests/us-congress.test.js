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
// Task 3 (profile-completeness) fixtures — live-captured 2026-07-29, politely (2 requests, one
// bill detail + one unfiltered member-roster page, both routed through the real adapter shape).
const billHr845Json = JSON.parse(readFileSync('tests/fixtures/us-congress/bill-detail-hr845.json', 'utf8'));
const memberPageJson = JSON.parse(readFileSync('tests/fixtures/us-congress/member-page-unfiltered.json', 'utf8'));

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

// ---- Task 3: sponsors (real fixtures — HR 498's existing fixture + a second real bill, HR 845) ----

test('parseBillDetail extracts sponsors as {bioguide_id, sponsor_type: "primary"} (HR 498, real fixture)', () => {
  const bill = parseBillDetail(billJson);
  assert.deepEqual(bill.sponsors, [{ bioguide_id: 'C001120', sponsor_type: 'primary' }]);
});

test('parseBillDetail sponsors generalizes to a second real bill (HR 845, live-captured 2026-07-29)', () => {
  const bill = parseBillDetail(billHr845Json);
  assert.deepEqual(bill.sponsors, [{ bioguide_id: 'B000825', sponsor_type: 'primary' }]);
});

test('parseBillDetail: a bill with no sponsors array yields an empty sponsors list, never throws', () => {
  const bill = parseBillDetail({ bill: { type: 'HR', number: '1', congress: 119 } });
  assert.deepEqual(bill.sponsors, []);
});

// ---- Task 3: parseMemberList against the real UNFILTERED roster page (fetchMemberPage's own
// shape — the endpoint enrich-federal-bills.js actually pages through for member metadata,
// distinct from the state-filtered fetchMemberList fixture above) ----

test('parseMemberList extracts party/state/district for every member on a real unfiltered roster page', () => {
  const members = parseMemberList(memberPageJson);
  assert.equal(members.length, 20);
  for (const m of members) {
    assert.ok(m.bioguide_id);
    assert.ok(m.full_name);
    assert.ok(['house', 'senate'].includes(m.chamber));
    assert.ok(m.state, `member ${m.bioguide_id} must carry a state`);
  }
  const gallagher = members.find((m) => m.bioguide_id === 'G000607');
  assert.ok(gallagher, 'fixture must contain Gallagher, James (a freshly-elected 2026 member with no endYear)');
  assert.equal(gallagher.party, 'Republican');
  assert.equal(gallagher.state, 'California');
  assert.equal(gallagher.district, '1');
  assert.equal(gallagher.chamber, 'house');
});
