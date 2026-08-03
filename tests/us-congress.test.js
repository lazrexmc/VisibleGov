import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeBillIdentifier, billTypeSlug, parseMemberList, parseHouseRollCall, parseBillDetail,
  fetchMemberPage,
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

// Senior engineering audit (2026-08-03, finding 8): parseHouseRollCall read `root['vote-metadata']`
// immediately after an unguarded `doc['rollcall-vote']` lookup — clerk.house.gov returning HTTP 200
// with anything other than real roll-call XML (an error/interstitial page, a template change) used
// to crash the WHOLE ingest run with a raw TypeError, since fast-xml-parser does not throw on this
// shape, it just parses to a tree with no `rollcall-vote` key. The fix mirrors us-senate.js's own
// already-guarded parseSenateRollCall: fail loudly with a plain, descriptive Error, never a raw
// TypeError.
test('parseHouseRollCall throws a plain, descriptive Error (never a raw TypeError) on a response with no <rollcall-vote> root', () => {
  const noRoot = '<?xml version="1.0" encoding="UTF-8"?><unexpected_response>not a roll call</unexpected_response>';
  assert.throws(
    () => parseHouseRollCall(noRoot, { year: 2025 }),
    (err) => {
      assert.notEqual(err.constructor.name, 'TypeError');
      assert.match(err.message, /genuine parse failure/);
      assert.match(err.message, /<rollcall-vote>/);
      return true;
    },
  );
});

test('parseHouseRollCall lets a raw XML syntax error (mid-stream truncation) propagate unmodified — never reclassified', () => {
  const truncated = rollXml.slice(0, 20);
  assert.throws(() => parseHouseRollCall(truncated, { year: 2025 }));
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

// ---- Task 8b (public-site plan, D3): at-large House members yield district '0', not null ----
//
// MAJOR-2 (task-8 review, live-verified): congress.gov omits `district` entirely for the six
// single-seat states (AK, DE, ND, SD, VT, WY — source: states with exactly one congressional
// district in the 119th Congress, same list documented at site/js/districts.js's matchReps
// at-large bridge). Neither committed fixture contains a real at-large member (verified: no
// member-page-unfiltered.json/members-mo.json entry has state in that set), so this is a
// synthetic-but-real-shaped construction (same style as backfill-term-states.test.js's own
// rawMember() helper), mirroring exactly what congress.gov's real response omits.
function atLargeRawMember(bioguideId, stateName, { district } = {}) {
  const member = {
    bioguideId, name: `Member, ${bioguideId}`, partyName: 'Republican', state: stateName,
    terms: { item: [{ chamber: 'House of Representatives', startYear: 2025 }] },
  };
  if (district !== undefined) member.district = district;
  return member;
}

test('parseMemberList: an at-large House member (no district field at all) from each of the six single-seat states yields district "0"', () => {
  const states = ['Alaska', 'Delaware', 'North Dakota', 'South Dakota', 'Vermont', 'Wyoming'];
  const members = parseMemberList({
    members: states.map((s, i) => atLargeRawMember(`X${String(i).padStart(6, '0')}`, s)),
  });
  assert.equal(members.length, 6);
  for (const m of members) {
    assert.equal(m.district, '0', `${m.state} at-large member must get district '0'`);
    assert.equal(m.chamber, 'house');
  }
});

test('parseMemberList: an at-large House member whose district arrives as literal null also yields "0"', () => {
  const members = parseMemberList({ members: [atLargeRawMember('X000009', 'Wyoming', { district: null })] });
  assert.equal(members[0].district, '0');
});

test('parseMemberList: a NON-at-large House member with no district field stays null — the bridge is narrow, not a blanket house default', () => {
  const members = parseMemberList({ members: [atLargeRawMember('X000010', 'Missouri')] });
  assert.equal(members[0].district, null);
});

test('parseMemberList: a Senate member from an at-large-list state is untouched (never given district "0" — the bridge is House-only)', () => {
  const member = {
    bioguideId: 'X000011', name: 'Member, X000011', partyName: 'Republican', state: 'Wyoming',
    terms: { item: [{ chamber: 'Senate', startYear: 2023 }] },
  };
  const members = parseMemberList({ members: [member] });
  assert.equal(members[0].chamber, 'senate');
  assert.equal(members[0].district, null);
});

test('parseMemberList: an at-large state member who DOES carry a real district value is left unchanged (never overwritten by the bridge)', () => {
  // Defensive: if congress.gov ever DOES print a district for one of these states (edge case,
  // not observed in any real fixture), the bridge must never override real source data.
  const members = parseMemberList({ members: [atLargeRawMember('X000012', 'Wyoming', { district: 5 })] });
  assert.equal(members[0].district, '5');
});

// ---- Task 8b (public-site plan, D2): fetchMemberPage accepts an optional congress override ----

const NOOP_LIMITER = { take: async () => {} }; // avoids the real 3.6s congressLimiter in tests

test('fetchMemberPage: with no congress argument, hits the unfiltered /member endpoint (unchanged from every existing caller)', async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ members: [] }) };
  };
  try {
    await fetchMemberPage(0, 250, NOOP_LIMITER);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(seenUrls.length, 1);
  assert.match(seenUrls[0], /^https:\/\/api\.congress\.gov\/v3\/member\?limit=250&offset=0$/);
});

test('fetchMemberPage: a congress argument routes to /member/congress/{congress} (covers departed members, per task-8b-brief.md D2)', async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ members: [] }) };
  };
  try {
    await fetchMemberPage(250, 250, NOOP_LIMITER, 119);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(seenUrls.length, 1);
  assert.match(seenUrls[0], /^https:\/\/api\.congress\.gov\/v3\/member\/congress\/119\?limit=250&offset=250$/);
});
