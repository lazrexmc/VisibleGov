import { XMLParser } from 'fast-xml-parser';
import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';

export const SOURCE = 'us-congress';
// Congress.gov allows 1000 req/hr => 1 per 3.6s; Clerk XML is separate but be polite anyway.
export const congressLimiter = createLimiter({ minIntervalMs: 3600 });
export const clerkLimiter = createLimiter({ minIntervalMs: 1000 });

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export function normalizeBillIdentifier(legisNum) {
  const s = String(legisNum).trim().toUpperCase();
  const m = s.match(/^([A-Z .]+?)\s+(\d+)$/);
  if (!m) return s;
  return `${m[1].replace(/[ .]/g, '')} ${m[2]}`;
}

export function billTypeSlug(identifier) {
  return identifier.split(' ')[0].toLowerCase();
}

const POSITION_MAP = new Map([
  ['yea', 'yea'], ['aye', 'yea'],
  ['nay', 'nay'], ['no', 'nay'],
  ['present', 'present'],
  ['not voting', 'not_voting'],
]);

export function mapHousePosition(raw) {
  return POSITION_MAP.get(String(raw).trim().toLowerCase()) ?? 'other';
}

// AT_LARGE_STATE_NAMES — task-8b-brief.md D3: states with exactly one, statewide congressional
// district in the 119th Congress (source: the same six states documented at site/js/districts.js's
// matchReps at-large bridge comment — AK, DE, ND, SD, VT, WY). Congress.gov's own member list
// prints NO `district` field at all for these members (live-verified per Task 8's review, MAJOR-2)
// rather than a printed '0' or '00' — the Census Geocoder's OWN at-large convention (CD='00',
// normalized to '0' by site/js/districts.js's normalizeDistrict) is what this bridges toward.
// Matched against the member's own full state name as congress.gov prints it (e.g. 'Wyoming'),
// not a 2-letter abbreviation — avoids importing us-senate.js's stateAbbreviation, which itself
// imports normalizeBillIdentifier FROM this module (a circular import).
const AT_LARGE_STATE_NAMES = new Set([
  'alaska', 'delaware', 'north dakota', 'south dakota', 'vermont', 'wyoming',
]);

export function parseMemberList(json) {
  return (json.members ?? []).map((m) => {
    const items = m.terms?.item ?? [];
    const latest = items[items.length - 1] ?? {};
    let chamber;
    if (/senate/i.test(latest.chamber ?? '')) chamber = 'senate';
    else if (/house/i.test(latest.chamber ?? '')) chamber = 'house';
    else throw new Error(`unknown chamber for member ${m.bioguideId}`);
    // At-large bridge (D3): House-only, and only when the source printed no real district value —
    // a genuinely-printed district (even on an at-large-list state, defensive/never observed) is
    // never overwritten.
    const isAtLarge = chamber === 'house' && m.district == null
      && AT_LARGE_STATE_NAMES.has(String(m.state ?? '').trim().toLowerCase());
    return {
      bioguide_id: m.bioguideId,
      full_name: m.name,
      party: m.partyName ?? null,
      chamber,
      district: isAtLarge ? '0' : (m.district != null ? String(m.district) : null),
      // Full state name as congress.gov returns it (e.g. 'Missouri'), not an abbreviation.
      // Unused by the House delegation path; added for us-senate.js's ensureSenateMembers
      // (Task 2), which needs it to match against Senate roll-call XML's 2-letter state codes.
      state: m.state ?? null,
    };
  });
}

function parseClerkDate(s) {
  // e.g. "10-Apr-2025"
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const m = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${months[m[2]]}-${m[1].padStart(2, '0')}`;
}

export function parseHouseRollCall(xmlString, { year }) {
  const doc = xml.parse(xmlString);
  const root = doc['rollcall-vote'];
  // Senior engineering audit (2026-08-03, finding 8): clerk.house.gov can return HTTP 200 with a
  // non-roll-call HTML page (an error/interstitial page, a template change) — fetchWithLimit's
  // !res.ok check never fires on a 200, and fast-xml-parser does not throw on this shape, it just
  // silently parses to a tree with no `rollcall-vote` key. Without this guard, the very next line
  // crashes the WHOLE ingest run with a raw `TypeError: Cannot read properties of undefined
  // (reading 'vote-metadata')` — the exact bug class us-senate.js's parseSenateRollCall already
  // guards against for the Senate side (this file had never gotten the same fix). A plain, loud
  // Error (not a typed SourceFetchError) is deliberate: this must never be silently swallowed as
  // an "expected miss" the way a genuine tail-probe 404 is.
  if (!root) {
    throw new Error(
      'parseHouseRollCall: response has no <rollcall-vote> root — clerk.house.gov returned an '
      + 'unexpected HTTP 200 body (not a real roll-call XML document), genuine parse failure, not '
      + `an expected miss (first 200 chars: ${JSON.stringify(String(xmlString).slice(0, 200))})`,
    );
  }
  const meta = root['vote-metadata'];
  const roll = Number(meta['rollcall-num']);
  const legisNum = meta['legis-num'] ? normalizeBillIdentifier(meta['legis-num']) : null;
  let recorded = root['vote-data']['recorded-vote'] ?? [];
  if (!Array.isArray(recorded)) recorded = [recorded];
  return {
    vote: {
      source_key: `us-house-${meta.congress}-${year}-${roll}`,
      chamber: 'house',
      vote_date: parseClerkDate(meta['action-date']),
      question: String(meta['vote-question'] ?? ''),
      result: String(meta['vote-result'] ?? ''),
      bill_identifier: legisNum,
      source_url: `https://clerk.house.gov/evs/${year}/roll${String(roll).padStart(3, '0')}.xml`,
    },
    casts: recorded.map((rv) => ({
      bioguide_id: rv.legislator['@_name-id'],
      position: mapHousePosition(rv.vote),
    })),
  };
}

export function parseBillDetail(json) {
  const b = json.bill;
  const identifier = normalizeBillIdentifier(`${b.type} ${b.number}`);
  return {
    identifier,
    title: b.title ?? '',
    status: b.latestAction?.text ?? null,
    canonical_url: `https://www.congress.gov/bill/${b.congress}th-congress/${slugToPath(b.type)}/${b.number}`,
    // Task 3 (profile-completeness) addition. Congress.gov's bill-detail response distinguishes
    // `sponsors` (the official introducing sponsor(s), embedded directly here) from a SEPARATE
    // `cosponsors` sub-resource (count+url only on this endpoint, its own bill/.../cosponsors
    // fetch) — cosponsors are out of scope (an extra live request per bill for a field the task
    // brief doesn't ask for), so every entry in `sponsors` maps to sponsor_type 'primary'. Not a
    // guess: Congress.gov's own field split is what draws this line, verified against two real
    // bills (tests/fixtures/us-congress/bill-detail.json HR 498, bill-detail-hr845.json HR 845 —
    // both single-primary-sponsor, matching this endpoint's documented shape).
    sponsors: (b.sponsors ?? []).map((s) => ({ bioguide_id: s.bioguideId, sponsor_type: 'primary' })),
  };
}

function slugToPath(type) {
  const paths = {
    HR: 'house-bill', S: 'senate-bill', HRES: 'house-resolution', SRES: 'senate-resolution',
    HJRES: 'house-joint-resolution', SJRES: 'senate-joint-resolution',
    HCONRES: 'house-concurrent-resolution', SCONRES: 'senate-concurrent-resolution',
  };
  return paths[String(type).toUpperCase()] ?? 'bill';
}

export function fetchHouseRollCall(rollNumber, year, limiter = clerkLimiter) {
  const url = `https://clerk.house.gov/evs/${year}/roll${String(rollNumber).padStart(3, '0')}.xml`;
  return fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
}

function apiKeyHeaders() {
  return { 'X-Api-Key': process.env.CONGRESS_API_KEY };
}

export function fetchBillDetail(congress, typeSlug, number, limiter = congressLimiter) {
  const url = `https://api.congress.gov/v3/bill/${congress}/${typeSlug}/${number}`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: apiKeyHeaders(), as: 'json' });
}

export function fetchMemberList(stateCode, limiter = congressLimiter) {
  const url = `https://api.congress.gov/v3/member/${stateCode}?limit=250`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: apiKeyHeaders(), as: 'json' });
}

// Full-chamber paging (unfiltered by state) — used by us-senate.js's ensureSenateMembers
// (Task 2) to build the whole current-Senate roster. Caller loops offset by 250 until a page
// comes back shorter than the requested limit.
//
// `congress` (task-8b-brief.md D2, minimal addition — no parallel parser): when provided, routes
// to `/member/congress/{congress}` instead of the unfiltered `/member` list. That endpoint returns
// every member who EVER served in the named congress, including ones no longer serving — the
// current-member-only `/member` endpoint (every existing caller, unchanged) can never see a
// departed member at all. Every existing caller passes no 4th argument, so this is purely
// additive. Same response shape either way (parseMemberList does not care which endpoint produced
// it).
export function fetchMemberPage(offset, limit = 250, limiter = congressLimiter, congress = null) {
  const path = congress != null ? `/member/congress/${congress}` : '/member';
  const url = `https://api.congress.gov/v3${path}?limit=${limit}&offset=${offset}`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: apiKeyHeaders(), as: 'json' });
}
