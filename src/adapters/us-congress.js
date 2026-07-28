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

export function parseMemberList(json) {
  return (json.members ?? []).map((m) => {
    const items = m.terms?.item ?? [];
    const latest = items[items.length - 1] ?? {};
    let chamber;
    if (/senate/i.test(latest.chamber ?? '')) chamber = 'senate';
    else if (/house/i.test(latest.chamber ?? '')) chamber = 'house';
    else throw new Error(`unknown chamber for member ${m.bioguideId}`);
    return {
      bioguide_id: m.bioguideId,
      full_name: m.name,
      party: m.partyName ?? null,
      chamber,
      district: m.district != null ? String(m.district) : null,
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
export function fetchMemberPage(offset, limit = 250, limiter = congressLimiter) {
  const url = `https://api.congress.gov/v3/member?limit=${limit}&offset=${offset}`;
  return fetchWithLimit(url, { source: SOURCE, limiter, headers: apiKeyHeaders(), as: 'json' });
}
