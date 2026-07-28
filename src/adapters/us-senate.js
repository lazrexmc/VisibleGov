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
