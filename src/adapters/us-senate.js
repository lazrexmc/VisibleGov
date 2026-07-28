import { XMLParser } from 'fast-xml-parser';
import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';
import { normalizeBillIdentifier } from './us-congress.js';

export const SOURCE = 'us-senate';
// senate.gov LIS XML needs no auth/key; be polite anyway (PLAYBOOK §3.2 - shared limiter).
export const senateLimiter = createLimiter({ minIntervalMs: 1000 });

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const SENATE_POSITION_MAP = new Map([
  ['yea', 'yea'], ['guilty', 'yea'],
  ['nay', 'nay'], ['not guilty', 'nay'],
  ['present', 'present'],
  ['not voting', 'not_voting'],
]);

export function mapSenatePosition(raw) {
  return SENATE_POSITION_MAP.get(String(raw).trim().toLowerCase()) ?? 'other';
}

const MENU_MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// vote_menu <vote_date> is day-month only (e.g. "18-Dec"); the year lives once at
// document level in <congress_year>, so both are needed to build an ISO date.
function parseMenuDate(dayMon, year) {
  const m = String(dayMon).trim().match(/^(\d{1,2})-([A-Za-z]{3})$/);
  if (!m) return null;
  const mon = MENU_MONTHS[m[2]];
  if (!mon) return null;
  return `${year}-${mon}-${m[1].padStart(2, '0')}`;
}

const ROLLCALL_MONTHS = {
  January: '01', February: '02', March: '03', April: '04', May: '05', June: '06',
  July: '07', August: '08', September: '09', October: '10', November: '11', December: '12',
};

// roll_call_vote <vote_date> is a full timestamp, e.g. "November 10, 2025,  08:58 PM"
// (note: source has irregular internal spacing before the time - tolerate it).
function parseRollCallDate(s) {
  const m = String(s).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mon = ROLLCALL_MONTHS[m[1]];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
}

// <question> is plain text on most votes, but on amendment-related votes it carries a
// nested <measure> child too (e.g. "On the Amendment" + measure "S.Amdt. 3937"), which
// fast-xml-parser represents as { '#text': ..., measure: ... } instead of a plain string.
function textOf(node) {
  if (node == null) return null;
  if (typeof node === 'object') return String(node['#text'] ?? '').trim() || null;
  const s = String(node).trim();
  return s || null;
}

export function parseSenateVoteMenu(xmlString) {
  const doc = xmlParser.parse(xmlString);
  const root = doc.vote_summary;
  const year = String(root.congress_year);
  let votes = root.votes?.vote ?? [];
  if (!Array.isArray(votes)) votes = [votes];
  return votes.map((v) => ({
    vote_number: Number(v.vote_number),
    date: parseMenuDate(v.vote_date, year),
    question: textOf(v.question),
    result: textOf(v.result),
    issue: textOf(v.issue),
  }));
}

export function parseSenateRollCall(xmlString) {
  const doc = xmlParser.parse(xmlString);
  const root = doc.roll_call_vote;
  const congress = Number(root.congress);
  const session = Number(root.session);
  const number = Number(root.vote_number);
  const billName = root.document?.document_name;
  let members = root.members?.member ?? [];
  if (!Array.isArray(members)) members = [members];
  return {
    vote: {
      source_key: `us-senate-${congress}-${session}-${number}`,
      chamber: 'senate',
      vote_date: parseRollCallDate(root.vote_date),
      question: textOf(root.question) ?? '',
      result: textOf(root.vote_result) ?? '',
      bill_identifier: billName ? normalizeBillIdentifier(billName) : null,
      source_url: senateRollCallUrl(congress, session, number),
    },
    // Senate XML identifies members by LIS id + name/party/state, not bioguide - identity
    // resolution to bioguide happens downstream (Task 2), not here.
    casts: members.map((m) => ({
      last_name: textOf(m.last_name) ?? '',
      first_name: textOf(m.first_name) ?? '',
      party: textOf(m.party) ?? '',
      state: textOf(m.state) ?? '',
      position: mapSenatePosition(m.vote_cast),
    })),
  };
}

function senateVoteMenuUrl(congress, session) {
  return `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`;
}

function senateRollCallUrl(congress, session, number) {
  const num = String(number).padStart(5, '0');
  return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${num}.xml`;
}

export function fetchSenateVoteMenu(congress, session, limiter = senateLimiter) {
  return fetchWithLimit(senateVoteMenuUrl(congress, session), { source: SOURCE, limiter, as: 'text' });
}

export function fetchSenateRollCall(congress, session, number, limiter = senateLimiter) {
  return fetchWithLimit(senateRollCallUrl(congress, session, number), { source: SOURCE, limiter, as: 'text' });
}

// ---- Task 2: member resolution + non-bill (nomination/treaty) question composition ----
// All pure — no fetch, no DB. ingest.js orchestrates these against live data.

// Same congress.gov bill-type vocabulary used by us-congress.js's slugToPath. A Senate roll
// call's own <document> node can carry a non-bill identifier (most commonly none at all, e.g.
// nomination/treaty votes) — normalizeBillIdentifier() will happily reshape whatever string is
// there, so we still need an explicit allow-list to decide whether it's actually a bill.
const KNOWN_BILL_TYPES = new Set(['HR', 'S', 'HRES', 'SRES', 'HJRES', 'SJRES', 'HCONRES', 'SCONRES']);

export function isKnownBillIdentifier(identifier) {
  if (!identifier) return false;
  return KNOWN_BILL_TYPES.has(String(identifier).split(' ')[0]);
}

// Design ruling #3 (task-2-brief.md): nominations/treaties don't normalize to a bill identifier,
// so bill_id ends up null downstream. Without this, a nomination vote's profile page would show
// only a generic "On the Cloture Motion" with no indication of WHAT was being voted on — so when
// bill_id would be null AND the menu carries an issue string (e.g. 'PN373'), fold it into the
// question. `issue` comes from the vote-menu entry, not the roll-call XML itself (the roll call
// has no <issue> field of its own) — pass null when no menu entry is available (e.g. an
// explicit --votes run that skipped the menu) and the question is left honestly as-is.
//
// Verified against a live senate.gov "On the Amendment" vote (119-1-616, H.R. 5371): the roll
// call's own <document> node is only populated on passage votes, so vote.bill_identifier comes
// back null for amendment votes on a perfectly real bill — while the menu's issue field ('H.R.
// 5371') correctly names it. So the menu issue is tried as a bill identifier FIRST (normalized
// the same way the roll call's own document is), and only treated as a non-bill nomination/treaty
// string when normalizing it doesn't land on a known bill type either.
export function finalizeSenateVote(vote, issue) {
  let billIdentifier = isKnownBillIdentifier(vote.bill_identifier) ? vote.bill_identifier : null;
  if (!billIdentifier && issue) {
    const normalizedIssue = normalizeBillIdentifier(issue);
    if (isKnownBillIdentifier(normalizedIssue)) billIdentifier = normalizedIssue;
  }
  const question = !billIdentifier && issue ? `${vote.question} — ${issue}` : vote.question;
  return { ...vote, bill_identifier: billIdentifier, question };
}

// Design ruling #1: match on (state, last_name) case-insensitive/trim; 0 or >1 matches → null
// (caller records the cast's identity fields into unresolved[] and skips the cast — never
// guessed, never placeholder-inserted). `senators` rows: { legislator_id, state, last_name }.
export function resolveSenator(cast, senators) {
  const state = String(cast.state ?? '').trim().toLowerCase();
  const lastName = String(cast.last_name ?? '').trim().toLowerCase();
  const matches = senators.filter((s) => (
    String(s.state ?? '').trim().toLowerCase() === state
    && String(s.last_name ?? '').trim().toLowerCase() === lastName
  ));
  return matches.length === 1 ? matches[0].legislator_id : null;
}

// congress.gov member names are 'Last, First [Middle]' (verified against
// tests/fixtures/us-congress/members-mo.json, e.g. 'Onder, Robert F.'). Used by
// ensureSenateMembers/loadCurrentSenators to build the last_name resolveSenator matches on.
export function lastNameFromFullName(fullName) {
  const s = String(fullName ?? '').trim();
  const i = s.indexOf(',');
  return (i === -1 ? s : s.slice(0, i)).trim();
}

// congress.gov's /member endpoints return the full state name (e.g. 'Missouri'), but Senate
// roll-call XML casts carry the 2-letter USPS code (e.g. 'MO') — this is the bridge. DC has no
// senators but is harmless to include; territories are omitted (no Senate seats to resolve).
const STATE_ABBREVIATIONS = new Map(Object.entries({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
}));

export function stateAbbreviation(fullName) {
  if (!fullName) return null;
  return STATE_ABBREVIATIONS.get(String(fullName).trim().toLowerCase()) ?? null;
}
