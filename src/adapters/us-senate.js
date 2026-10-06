import { XMLParser } from 'fast-xml-parser';
import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';
import { SourceFetchError, RollCallNotYetPublishedError } from '../lib/errors.js';
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
  // Senior engineering audit (2026-08-03, finding 8): the SAME unguarded-root crash class
  // parseSenateRollCall (below) already guards against — this function never got the same fix.
  // senate.gov can return HTTP 200 with a non-menu body (a template change, a truncated transfer);
  // without this guard the very next line crashes the whole ingest run with a raw
  // `TypeError: Cannot read properties of undefined (reading 'congress_year')`. A plain, loud
  // Error, not a typed SourceFetchError — never silently swallowed as an expected miss.
  if (!root) {
    throw new Error(
      'parseSenateVoteMenu: response has no <vote_summary> root — senate.gov returned an '
      + 'unexpected HTTP 200 body (not a real vote-menu XML document), genuine parse failure, not '
      + `an expected miss (first 200 chars: ${JSON.stringify(String(xmlString).slice(0, 200))})`,
    );
  }
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

// Thrown by parseSenateRollCall for a not-yet-cast vote number. Extends SourceFetchError (not a
// bare Error, unlike uscode.js's UscSectionNotFoundError) so it flows through collectUsSenate's
// existing `if (!(err instanceof SourceFetchError)) throw err;` per-vote catch unchanged - same
// expected-miss handling us-congress already gets for a real HTTP 404 on a tail roll number.
//
// DEFINITION MOVED to src/lib/errors.js (2026-10-06) because clerk.house.gov turned out to do the
// same thing - serve "no such vote yet" as an HTTP 200 stub - and us-congress.js could not import
// it from here: this file imports normalizeBillIdentifier from us-congress.js, so that would be a
// cycle. Re-exported rather than relocated silently, so every existing `import { ... } from
// './us-senate.js'` keeps working.
export { RollCallNotYetPublishedError };

// Verified live 2026-08-01 against real senate.gov (session 119-2, vote numbers 220/250/999 -
// all three byte-identical: one generic template, not per-vote content; see tests/fixtures/
// us-senate/roll-call-unavailable.html for the captured body). A not-yet-cast/not-yet-published
// roll call number is HTTP 200 (NOT a 404 - fetchWithLimit's !res.ok check never fires) with an
// HTML page instead of roll-call XML: <title>U.S. Senate: Roll Call Vote Unavailable</title>,
// <h1>Roll Call Vote Unavailable</h1>, body text "Results of roll call votes are published
// approximately an hour after they have been announced." fast-xml-parser is lenient and does not
// throw on this (confirmed empirically against this exact payload plus several other malformed
// inputs - it never throws with this module's parser config); it silently parses the HTML into a
// tree with no roll_call_vote key at all, which used to surface downstream as
// `TypeError: Cannot read properties of undefined (reading 'congress')` the moment root.congress
// was read - a crash, not a classified miss, on every hourly scheduler probe during a recess.
//
// CHANGED about 2026-09-18 (verified live 2026-09-26 on vote numbers 245-250 and 999): the same
// request now gets a 301 to /legislative/roll-call-vote-not-available.htm, and fetch follows it to
// a full site page with the same <title> and <h1> (tests/fixtures/us-senate/
// roll-call-not-available-2026-09.html). fast-xml-parser THROWS on that page (`TypeError: Cannot
// read properties of undefined (reading 'tagName')`), so "never throws" above held for the old page
// only, and a marker check placed after the parse never ran: every hourly tail probe crashed the
// run before openRun, 2026-09-18 to 2026-09-26 (PLAYBOOK_DELTA lesson 65). The marker is now
// checked on the raw text, before the parse.
const ROLL_CALL_UNAVAILABLE_MARKER = 'Roll Call Vote Unavailable';

export function parseSenateRollCall(xmlString) {
  // Distinguish the known "not yet published" stub (expected miss - honestly counted, run stays
  // healthy-partial) from any other reason a roll call might be missing (truncated transfer,
  // senate.gov template change, genuine corruption on what should be a real, existing vote) - the
  // latter must still fail loudly, never silently reclassified as a routine miss. Only the
  // recognized stub shape gets the typed SourceFetchError-style error. It is recognized on the RAW
  // text, before the parse (the current stub page makes the parser throw - see the marker's comment
  // above), and only in a body that is not a roll call.
  const text = String(xmlString);
  if (!text.includes('<roll_call_vote') && text.includes(ROLL_CALL_UNAVAILABLE_MARKER)) {
    throw new RollCallNotYetPublishedError(
      'senate.gov has no roll call at this vote number yet (LIS serves an HTML "Roll Call Vote '
      + 'Unavailable" page, not a 404, for a not-yet-cast vote) - expected miss, not a parse bug',
      { source: SOURCE },
    );
  }
  const doc = xmlParser.parse(text);
  const root = doc.roll_call_vote;
  if (!root) {
    throw new Error(
      'parseSenateRollCall: response has no <roll_call_vote> root and does not match the known '
      + '"Roll Call Vote Unavailable" not-yet-published stub either - genuine parse failure, not '
      + `an expected miss (first 200 chars: ${JSON.stringify(String(xmlString).slice(0, 200))})`,
    );
  }
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

// Fold diacritics + casefold, e.g. 'Lujan' (with acute accent) -> 'lujan'. Live Task-3 backfill
// (869 votes, ~87k casts) found senate.gov roll-call XML strips accents from cast last names
// ('Lujan', no accent) while our legislators table (sourced from congress.gov) keeps them
// ('Lujan' with accent, i.e. 'Luján, Ben Ray') - folding on BOTH sides of the comparison is
// what makes that pair equal.
function fold(s) {
  // Filters out Unicode combining diacritical marks (code points 0x0300-0x036F) after NFD
  // normalization decomposes an accented letter (e.g. the 'a' in Luján)
  // into a base letter plus a combining mark, so this leaves the bare base letter behind.
  const decomposed = String(s ?? '').normalize('NFD');
  let out = '';
  for (const ch of decomposed) {
    const code = ch.codePointAt(0);
    if (code >= 0x0300 && code <= 0x036f) continue;
    out += ch;
  }
  return out.trim().toLowerCase();
}

// Design ruling #1: match on (state, last_name), diacritic-folded + case-insensitive/trimmed.
// 0 matches -> null. >1 matches -> attempt a first-name tiebreak (also live-discovered: congress.gov's
// unfiltered /member list has no reliable "current member" signal — see ensureSenateMembers — so
// e.g. AK/Murkowski legitimately matches both Lisa (current) and Frank H. (1981-2002) once both
// are ingested). Tiebreak compares cast.first_name against the first token of the senator's
// 'Last, First [Middle]' full_name, prefix-tolerant in either direction (folded/casefolded) to
// absorb nickname/short-form mismatches. Still 0 or >1 after the tiebreak -> null, same as before
// — never guessed, never placeholder-inserted; caller records the cast's identity into
// unresolved[] and skips it. `senators` rows: { legislator_id, state, last_name, first_name }.
export function resolveSenator(cast, senators) {
  const state = fold(cast.state);
  const lastName = fold(cast.last_name);
  const matches = senators.filter((s) => fold(s.state) === state && fold(s.last_name) === lastName);
  if (matches.length === 1) return matches[0].legislator_id;
  if (matches.length === 0) return null;

  const castFirst = fold(cast.first_name);
  if (!castFirst) return null;
  const tieBroken = matches.filter((s) => {
    const dbFirst = fold(s.first_name);
    return dbFirst.length > 0 && (dbFirst.startsWith(castFirst) || castFirst.startsWith(dbFirst));
  });
  return tieBroken.length === 1 ? tieBroken[0].legislator_id : null;
}

// congress.gov member names are 'Last, First [Middle]' (verified against
// tests/fixtures/us-congress/members-mo.json, e.g. 'Onder, Robert F.'). Used by
// ensureSenateMembers/loadCurrentSenators to build the last_name resolveSenator matches on.
export function lastNameFromFullName(fullName) {
  const s = String(fullName ?? '').trim();
  const i = s.indexOf(',');
  return (i === -1 ? s : s.slice(0, i)).trim();
}

// Companion to lastNameFromFullName, for resolveSenator's ambiguity tiebreak — e.g.
// 'Warner, Mark R.' -> 'Mark' (first token after the comma; middle initials dropped).
export function firstNameFromFullName(fullName) {
  const s = String(fullName ?? '').trim();
  const i = s.indexOf(',');
  if (i === -1) return '';
  return s.slice(i + 1).trim().split(/\s+/)[0] ?? '';
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
