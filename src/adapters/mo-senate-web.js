import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';

export const SOURCE = 'mo-senate-web';

// senate.mo.gov publishes no ToU on request cadence that research turned up (plan's Q4) - rather
// than assume silence means "no limit", this mirrors house.mo.gov's own documented half-hour
// minimum (mo-house-xml.js) defensively. Same createLimiter shape, own instance (different host).
export const MO_SENATE_MIN_INTERVAL_MS = 30 * 60 * 1000;
export const moSenateLimiter = createLimiter({ minIntervalMs: MO_SENATE_MIN_INTERVAL_MS });

const SENATE_BASE = 'https://www.senate.mo.gov';

// ---- shared text helpers ----

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/g, ' ');
}

// The 2018 PDF roster prints every name in ALL CAPS (see parseSenateRosterPdf below) - title-case
// it so surname/full_name read like every other adapter's roster shape (e.g. mo-house-xml.js's
// parseMoRepresentative: 'Matthiesen', not 'MATTHIESEN'). Capitalizes the first letter after the
// start of string or any of the punctuation the real fixture's names actually contain (space,
// hyphen for double-barreled surnames like CHAPPELLE-NADAL, curly/straight quotes for a bracketed
// nickname like SHALONN "KIKI", parens).
function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/(^|[\s\-'"“”().])([a-z])/g, (_, boundary, ch) => boundary + ch.toUpperCase());
}

// ---- roster: current session, live Blazor app (roster-current.html) ----
//
// One <a> per senator: href -> either .../Senators/Member?id=<internal-site-id> (a real senator)
// or .../Senators/VacantSenator?district=<N> (an empty seat - a DIFFERENT link shape, not a member
// row with a blank name). aria-label carries "View Senator <FULL NAME> details page"; the district
// number is only printed in the card__footer text ("Senator <NAME> <br/> District <N>" for a real
// senator, "Vacant District <N>" for an empty seat - no "Senator" prefix, no <br/>). No party is
// printed anywhere on this page (task-1-report.md, grepped absent across the whole fixture) - party
// is always null here. mo_senate_id is the DISTRICT number (migration 0008's identity key), never
// the site's own internal `id=` query value, which is a different, unrelated numbering.
const HTML_CARD_RE = /<a\s+href="([^"]+)"\s+aria-label="View Senator ([^"]*) details page"[\s\S]*?<div class="card__footer"[^>]*>([\s\S]*?)<\/div>/g;

export function parseSenateRosterHtml(html) {
  const re = new RegExp(HTML_CARD_RE);
  const members = [];
  let vacancies = 0;
  let cardCount = 0;
  let m;
  while ((m = re.exec(html))) {
    cardCount += 1;
    const [, href, ariaName, footerRaw] = m;
    const footer = footerRaw.replace(/\s+/g, ' ').trim();

    if (/\/Senators\/VacantSenator\?district=\d+/.test(href)) {
      vacancies += 1;
      continue;
    }
    if (!/\/Senators\/Member\?id=\d+/.test(href)) {
      throw new Error(`senate roster HTML: senator card has an unrecognized link shape (neither Member nor VacantSenator): ${href}`);
    }
    const districtMatch = footer.match(/District\s+(\d+)/);
    if (!districtMatch) {
      throw new Error(`senate roster HTML: no "District N" text found in the card footer for "${ariaName}"`);
    }
    const fullName = decodeHtmlEntities(ariaName).trim();
    const nameParts = fullName.split(/\s+/).filter(Boolean);
    const surname = nameParts[nameParts.length - 1] ?? '';
    members.push({
      mo_senate_id: districtMatch[1],
      surname,
      full_name: fullName,
      party: null,
    });
  }
  // Fail loud, not empty: zero matched cards means the grid markup changed shape, not that the
  // chamber genuinely has no senators - never silently return [] for a page that doesn't parse.
  if (cardCount === 0) {
    throw new Error('senate roster HTML has no recognizable senator cards (expected "aria-label=\\"View Senator ...\\"" / ".card__footer" markup) - structure may have changed');
  }
  return { members, vacancies };
}

// ---- roster: 2018-era archived directory (roster-2018-wayback.pdf) ----
//
// senate.mo.gov never served an HTML roster for 2018 (task-1-report.md's Wayback follow-up); the
// only consolidated artifact is this PDF, a phone/room staff directory. Each senator's header line
// reads 'SURNAME, FIRSTNAME<dash>DISTRICT' (comma-separated, entirely upper-case in the source),
// then dot-leader padding into room/phone columns; an empty seat prints 'VACANT<dash>DISTRICT' with
// no comma/first-name part at all. The real extracted text (pdfjs-dist row-reconstruction, same
// coordinate-based pattern as mo-rollcall-pdf.js's reconstructPageText - extraction itself is Task
// 4's extractJournalText, exercised inline in this task's own tests only) uses an EN DASH (U+2013,
// "-") before the district, not a hyphen-minus - a plain hyphen is matched too, defensively, since
// nothing guarantees every future capture reproduces the exact glyph. The document's 2-column
// layout means one reconstructed text row often holds BOTH columns' header lines back-to-back with
// NO separating whitespace (the left column's trailing phone-number digits run directly into the
// right column's next all-caps surname) - the regex anchors on the dot-leader run that always
// follows the district number, not on any preceding boundary, so this needs no lookbehind.
// No party is printed anywhere in this document either (task-1-report.md, grepped absent) - null.
const PDF_ENTRY_RE = /([A-Z][A-Z“”'".() -]*?)(?:,\s*([A-Z“”'".() -]*?))?[–-](\d{1,2})(?=\s*\.)/g;

export function parseSenateRosterPdf(text) {
  const re = new RegExp(PDF_ENTRY_RE);
  const members = [];
  let vacancies = 0;
  let entryCount = 0;
  let m;
  while ((m = re.exec(text))) {
    entryCount += 1;
    const [, surnameRaw, firstRaw, district] = m;
    const surnameUpper = surnameRaw.trim();
    if (surnameUpper === 'VACANT') {
      vacancies += 1;
      continue;
    }
    const surname = titleCase(surnameUpper);
    const first = titleCase((firstRaw ?? '').trim());
    members.push({
      mo_senate_id: district,
      surname,
      full_name: [first, surname].filter(Boolean).join(' '),
      party: null,
    });
  }
  if (entryCount === 0) {
    throw new Error('senate roster PDF text has no recognizable "SURNAME, FIRSTNAME-DISTRICT" entries - structure may have changed');
  }
  return { members, vacancies };
}

// ---- journal index (journallist-current.html / journallist-2018.html) ----
//
// Every observed year (2026 live, 2018 via ?SelectedYear=2018) renders the SAME markup: one
// '.journal-entry-card' div per day, an <h6><strong>Day NN</strong></h6> label, a
// '<p class="mb-0 no-wrap"><strong>M/D/YYYY</strong></p>' printed date, and an '<a href="...">'
// pointing at that day's journal PDF (task-1-report.md - the controller ruling's "2026 uses
// .journal-entry-card divs; 2018 uses Day-N h6 headers with RDay... hrefs" describes the SAME
// markup from two angles, confirmed against both real fixtures: identical structure, only the
// data differs). journal_date comes ONLY from the printed date text ('3/8/2018' -> '2018-03-08'),
// never derived from the PDF filename (which also encodes a date, but per the controller ruling
// the printed date is authoritative and the filename is not parsed for one). journal_url is
// resolved to an absolute URL against senate.mo.gov (the href is always a site-relative path,
// e.g. '/18info/Journals/RDay370308587-610.pdf').
const JOURNAL_CARD_RE = /<div class="w-100 journal-entry-card">[\s\S]*?<h6[^>]*><strong>([^<]+)<\/strong><\/h6>[\s\S]*?<p class="mb-0 no-wrap"><strong>([^<]+)<\/strong><\/p>[\s\S]*?<a href="([^"]+)"/g;

function printedDateToIso(printed) {
  const m = printed.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, day, yr] = m;
  return `${yr}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function parseJournalIndex(html) {
  const re = new RegExp(JOURNAL_CARD_RE);
  const rows = [];
  let m;
  while ((m = re.exec(html))) {
    const [, dayLabel, printedDate, href] = m;
    rows.push({
      day_label: dayLabel.trim(),
      journal_url: new URL(href, SENATE_BASE).toString(),
      journal_date: printedDateToIso(printedDate),
    });
  }
  if (rows.length === 0) {
    throw new Error('journal index HTML has no recognizable .journal-entry-card entries - structure may have changed');
  }
  return rows;
}

// ---- fetchers (all through moSenateLimiter by default - see the limiter comment above) ----

export function fetchSenateRoster(url, limiter = moSenateLimiter) {
  return fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
}

export function fetchJournalIndex(url, limiter = moSenateLimiter) {
  return fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
}

export function fetchSenateJournalPdf(url, limiter = moSenateLimiter) {
  return fetchWithLimit(url, { source: SOURCE, limiter, as: 'arrayBuffer' });
}
