import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fetchWithLimit } from '../lib/http.js';
import { SOURCE as MO_HOUSE_SOURCE, moHouseLimiter } from './mo-house-xml.js';

// Task 4b: individual MO House votes, extracted from the per-roll-call PDF a bill's own XML links
// (mo-house-xml.js's RollCallPDF). documents.house.mo.gov serves both the XML exports and these
// PDFs, so PDF fetches reuse the SAME SOURCE id + the SAME shared moHouseLimiter instance as
// mo-house-xml.js (not a new limiter) - that is what makes the 30-min ToU cooldown durable across
// both document types within one process (see mo-house-xml.js's own comment for the ToU itself,
// and ingest-mo-house.js's enforceDurableCooldown for the cross-process version, keyed on
// ingestion_runs.source = 'mo-house-xml' regardless of which document type a given run fetched).
export const SOURCE = MO_HOUSE_SOURCE;

export class RollCallParseError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'RollCallParseError';
    Object.assign(this, meta);
  }
}

// ---- text extraction ----
//
// Node has no browser APIs (no DOM, no Worker by default in this usage) - pdfjs-dist's STANDARD
// build assumes them; the LEGACY build (pdfjs-dist/legacy/build/pdf.mjs) is the one meant for
// exactly this environment. getDocument({data}) -> getPage(n) -> getTextContent() -> items[].str,
// per pdfjs-dist's own documented API.
//
// REAL-PDF FINDING (verified against tests/fixtures/research/mo-house-xml/rollcall-034.008.pdf,
// a genuine 4-column roll-call layout): pdfjs-dist's own text-item STREAM order for this PDF is
// ALREADY correct row-major reading order - each printed row's 4 columns come out left-to-right
// before the next row starts, not column-by-column. That is a property of how this PDF's content
// stream happens to have been generated, not a pdfjs-dist guarantee (nothing in the text-content
// API promises reading order for a multi-column layout). Rather than depend on that happening to
// hold for every MO House roll-call PDF, reconstruction below ALWAYS re-derives line order from
// each item's own transform coordinates: group items into rows by descending y (PDF y grows
// upward - a smaller/later y is further down the page), sort each row's items by ascending x. For
// the real fixture this produces byte-identical output to "just concatenate items in stream
// order" - confirmed while building this adapter - but it is the only approach actually guaranteed
// correct if a future MO House PDF's generator writes its content stream in a different order.
const ROW_Y_EPSILON = 2; // pt tolerance for "same printed row". Real grid rows in the fixture share
// the exact same y across all 4 columns; a couple of unrelated header items (independently-sized
// text on the same visual line) differ by <0.3pt due to font-metric rounding - both comfortably
// under this tolerance, while distinct rows are ~13pt apart.

function reconstructPageText(items) {
  const visible = items.filter((it) => it.str !== '');
  const sorted = [...visible].sort((a, b) => b.transform[5] - a.transform[5]);
  const rows = [];
  for (const item of sorted) {
    const y = item.transform[5];
    const current = rows[rows.length - 1];
    if (current && Math.abs(current.y - y) <= ROW_Y_EPSILON) current.items.push(item);
    else rows.push({ y, items: [item] });
  }
  return rows
    .map((row) => row.items.slice().sort((a, b) => a.transform[4] - b.transform[4]).map((it) => it.str).join(''))
    .join('\n');
}

// pdfBuffer: a Buffer/Uint8Array/ArrayBuffer of raw PDF bytes (never a file path - callers decide
// whether that came from a local fixture read or a live fetch). Multi-page PDFs (not needed by the
// 163-seat MO House on one page, but not assumed away) are joined page-by-page in document order.
//
// Always rebuilt as a plain `Uint8Array` (never passed through as-is): pdfjs-dist explicitly
// rejects a Node `Buffer` ("Please provide binary data as Uint8Array, rather than Buffer") even
// though Buffer IS-A Uint8Array - readFileSync (the fixture/live-fetch-buffer path in
// ingest-mo-house.js) returns a Buffer, so this conversion is required, not defensive filler.
export async function extractRollCallText(pdfBuffer) {
  const data = new Uint8Array(pdfBuffer);
  const doc = await getDocument({ data }).promise;
  const pageTexts = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    // sequential (not Promise.all) is deliberate: pages must be read in document order.
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    pageTexts.push(reconstructPageText(content.items));
  }
  return pageTexts.join('\n\n');
}

// ---- parsing ----

// Printed vote-code -> vote_casts.position (schema check constraint: yea|nay|present|not_voting|
// absent|other). MO House roll-call PDFs never print 'not_voting' - 'not_voting' has no printed
// symbol here; a missing member is either P (present, i.e. present-not-voting) or @ (absent).
const POSITION_MAP = new Map([['Y', 'yea'], ['N', 'nay'], ['P', 'present'], ['@', 'absent']]);

// Roll-call body is a flat run of "<CODE> - <SURNAME>[ <DISTRICT>]" tokens (4 printed per row,
// reconstructed as one space-joined line per row - see reconstructPageText) - this scans the whole
// body in one pass rather than trying to stay row-aware, since row boundaries carry no parsing
// significance once reconstructed. Surnames are matched as letters/digits/spaces only: verified
// against the real fixture, which contains two genuine 2-word surnames (FOUNTAIN HENDERS, WALSH
// MOORE) and one non-surname line (MR SPEAKER, the Speaker's own vote, printed alphabetically last)
// - none of the three has a hyphen or apostrophe. A hyphenated or apostrophe'd surname (neither
// observed in this fixture) is a known gap for a future MO House roll call - see task-4b-report.md.
const CAST_RE = /([YNP@])\s*-\s*([A-Z0-9][A-Z0-9 ]*?)(?=\s+[YNP@]\s*-\s*[A-Z0-9]|\s*$)/g;

const TALLY_RE = /Total\s*Yes\s*:\s*(\d+)[\s\S]*?Total\s*Present\s*:\s*(\d+)[\s\S]*?Total\s*No\s*:\s*(\d+)[\s\S]*?Total\s*Absent\s*:\s*(\d+)[\s\S]*?Vacancies\s*:\s*(\d+)/i;

// Duplicate-surname entries print a trailing district number to disambiguate (SMITH 46/68/74,
// TAYLOR 48/84, JONES 12/88, per task-4b-brief.md's known ground truth) - everything else (the
// overwhelming majority) prints a bare surname with no district. Never guessed which case applies:
// purely mechanical - a trailing run of digits is a district, otherwise there is none.
function splitSurnameDistrict(raw) {
  const m = raw.match(/^(.+?)\s+(\d+)$/);
  if (!m) return { surname: raw, district: null };
  return { surname: m[1], district: m[2] };
}

// parseMoRollCall(text) -> { tallies, casts }. THE INTEGRITY GATE (task-4b-brief.md, non-
// negotiable): parsed cast counts per position MUST equal the printed tallies or this throws
// RollCallParseError - a roll call that doesn't reconcile is NEVER stored. Never store what you
// can't reconcile.
export function parseMoRollCall(text) {
  const rollCallAnchor = text.match(/Roll\s*Call\s*:\s*\d+/i);
  const totalYesIdx = text.search(/Total\s*Yes\s*:/i);
  if (!rollCallAnchor || totalYesIdx === -1) {
    throw new RollCallParseError(
      'roll-call text is missing the "Roll Call :" and/or "Total Yes :" anchor - cannot safely locate the cast list or tallies',
      { textPreview: text.slice(0, 200) },
    );
  }
  const bodyStart = rollCallAnchor.index + rollCallAnchor[0].length;
  const body = text.slice(bodyStart, totalYesIdx);

  const tallyMatch = text.slice(totalYesIdx).match(TALLY_RE);
  if (!tallyMatch) {
    throw new RollCallParseError(
      'could not parse the printed tallies (Total Yes / Total Present / Total No / Total Absent / Vacancies)',
      { tallyTextPreview: text.slice(totalYesIdx, totalYesIdx + 200) },
    );
  }
  const tallies = {
    yes: Number(tallyMatch[1]),
    present: Number(tallyMatch[2]),
    no: Number(tallyMatch[3]),
    absent: Number(tallyMatch[4]),
    vacancies: Number(tallyMatch[5]),
  };

  const casts = [...body.matchAll(CAST_RE)].map((m) => {
    const position = POSITION_MAP.get(m[1]);
    const { surname, district } = splitSurnameDistrict(m[2].trim());
    return { surname, district, position };
  });

  const counted = { yes: 0, no: 0, present: 0, absent: 0 };
  for (const c of casts) {
    if (c.position === 'yea') counted.yes += 1;
    else if (c.position === 'nay') counted.no += 1;
    else if (c.position === 'present') counted.present += 1;
    else if (c.position === 'absent') counted.absent += 1;
  }
  // Vacancies is a seat count (empty seat, no member to cast), never a cast - reported alongside
  // the other tallies but deliberately NOT cross-checked against casts.length here: this
  // function's contract is "the individual casts reconcile against the individual-position
  // tallies actually printed," not an assumption about the chamber's total seat count (163 for
  // the current MO House, verified against this fixture: 82+61+2+13+5 = 163 - but that arithmetic
  // is a fact about THIS session, not a rule this parser should bake in and silently rely on).
  const mismatches = [];
  for (const key of ['yes', 'no', 'present', 'absent']) {
    if (counted[key] !== tallies[key]) mismatches.push(`${key}: parsed ${counted[key]} vs printed ${tallies[key]}`);
  }
  if (mismatches.length > 0) {
    throw new RollCallParseError(
      `parsed cast counts do not reconcile with the printed tallies: ${mismatches.join('; ')}`,
      { tallies, counted, castCount: casts.length },
    );
  }

  return { tallies, casts };
}

// ---- resolution ----
//
// roster rows: { legislator_id, surname, mo_house_id } - mo_house_id is the district number as
// text (Task 4's parseMoRepresentative shape, mo-house-xml.js). Same fail-loud convention as
// resolveSenator (us-senate.js): 0 or >1 matches -> null, NEVER guessed, NEVER placeholder-
// inserted - the caller records the cast's identity fields into unresolved[] and skips it.
export function resolveMoRep(cast, roster) {
  const surname = String(cast.surname ?? '').trim().toLowerCase();
  if (cast.district) {
    const district = String(cast.district).trim();
    const matches = roster.filter((r) => (
      String(r.surname ?? '').trim().toLowerCase() === surname
      && String(r.mo_house_id ?? '').trim() === district
    ));
    return matches.length === 1 ? matches[0].legislator_id : null;
  }
  const matches = roster.filter((r) => String(r.surname ?? '').trim().toLowerCase() === surname);
  return matches.length === 1 ? matches[0].legislator_id : null;
}

// ---- fetch ----
//
// Deliberately reuses mo-house-xml.js's SOURCE/moHouseLimiter (imported above), not new ones - see
// the module-level comment. `as: 'arrayBuffer'` on fetchWithLimit is this task's one addition to
// src/lib/http.js (purely additive: 'json'/'text' behavior is unchanged).
export function fetchMoRollCallPdf(pdfUrl, limiter = moHouseLimiter) {
  return fetchWithLimit(pdfUrl, { source: SOURCE, limiter, as: 'arrayBuffer' });
}
