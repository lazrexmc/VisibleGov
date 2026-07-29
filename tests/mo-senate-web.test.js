import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  SOURCE, MO_SENATE_MIN_INTERVAL_MS, moSenateLimiter,
  parseSenateRosterHtml, parseSenateRosterPdf, parseJournalIndex,
  fetchSenateRoster, fetchJournalIndex, fetchSenateJournalPdf,
} from '../src/adapters/mo-senate-web.js';

const FIXTURES = 'tests/fixtures/research/mo-senate';

// ---- PDF text extraction, inlined per task-3-brief.md CONTROLLER RULING 1: the real pdfjs-dist
// legacy-build extraction pattern belongs to Task 4's extractJournalText - THIS task's tests
// reproduce it inline (byte-for-byte the same row-reconstruction approach as
// src/adapters/mo-rollcall-pdf.js's reconstructPageText) rather than creating that module early. ----

const ROW_Y_EPSILON = 2;

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

async function extractPdfText(pdfBuffer) {
  const data = new Uint8Array(pdfBuffer);
  const doc = await getDocument({ data }).promise;
  const pageTexts = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    pageTexts.push(reconstructPageText(content.items));
  }
  return pageTexts.join('\n\n');
}

const rosterHtml = readFileSync(`${FIXTURES}/roster-current.html`, 'utf8');
const roster2018PdfBuffer = readFileSync(`${FIXTURES}/roster-2018-wayback.pdf`);
const roster2018Text = await extractPdfText(roster2018PdfBuffer);
const journalCurrentHtml = readFileSync(`${FIXTURES}/journallist-current.html`, 'utf8');
const journal2018Html = readFileSync(`${FIXTURES}/journallist-2018.html`, 'utf8');

// ---- constants / fetch wiring ----

test('SOURCE and moSenateLimiter are set up per the House-conservative cadence (30 min, plan Q4)', () => {
  assert.equal(SOURCE, 'mo-senate-web');
  assert.equal(MO_SENATE_MIN_INTERVAL_MS, 30 * 60 * 1000);
  assert.ok(moSenateLimiter && typeof moSenateLimiter.take === 'function');
});

test('fetchSenateRoster / fetchJournalIndex / fetchSenateJournalPdf are exported functions (no network exercised in tests)', () => {
  assert.equal(typeof fetchSenateRoster, 'function');
  assert.equal(typeof fetchJournalIndex, 'function');
  assert.equal(typeof fetchSenateJournalPdf, 'function');
});

// ---- parseSenateRosterHtml (roster-current.html, real fixture - 34 cards: 33 named senators +
// 1 vacancy at district 10, per task-1-report.md) ----

test('parseSenateRosterHtml (real fixture): 33 members + 1 vacancy, the REAL counts task-1-report.md found', () => {
  const { members, vacancies } = parseSenateRosterHtml(rosterHtml);
  assert.equal(members.length, 33);
  assert.equal(vacancies, 1);
});

test('parseSenateRosterHtml (real fixture): districts are 1-9 and 11-34 (10 is the vacancy, excluded from members)', () => {
  const { members } = parseSenateRosterHtml(rosterHtml);
  const districts = members.map((m) => Number(m.mo_senate_id)).sort((a, b) => a - b);
  const expected = Array.from({ length: 34 }, (_, i) => i + 1).filter((d) => d !== 10);
  assert.deepEqual(districts, expected);
});

test('parseSenateRosterHtml (real fixture): spot-check Jason Bean (district 25) and party is always null (never printed on this page)', () => {
  const { members } = parseSenateRosterHtml(rosterHtml);
  const bean = members.find((m) => m.surname === 'Bean');
  assert.deepEqual(bean, {
    mo_senate_id: '25', surname: 'Bean', full_name: 'Jason Bean', party: null,
  });
  assert.ok(members.every((m) => m.party === null));
});

test('parseSenateRosterHtml (real fixture): a multi-word first name yields the correct last-token surname (Mary Elizabeth Coleman)', () => {
  const { members } = parseSenateRosterHtml(rosterHtml);
  const coleman = members.find((m) => m.surname === 'Coleman');
  assert.deepEqual(coleman, {
    mo_senate_id: '22', surname: 'Coleman', full_name: 'Mary Elizabeth Coleman', party: null,
  });
});

test('parseSenateRosterHtml (real fixture): an HTML-entity-encoded apostrophe in the name decodes correctly (Cindy O\'Laughlin)', () => {
  const { members } = parseSenateRosterHtml(rosterHtml);
  const olaughlin = members.find((m) => m.mo_senate_id === '18');
  assert.deepEqual(olaughlin, {
    mo_senate_id: '18', surname: "O'Laughlin", full_name: "Cindy O'Laughlin", party: null,
  });
});

test('parseSenateRosterHtml: throws (never returns []) on structurally unrecognizable HTML', () => {
  assert.throws(() => parseSenateRosterHtml('<html><body>nothing here</body></html>'), /no recognizable senator cards/);
});

test('parseSenateRosterHtml: throws on a card whose link is neither a Member nor a VacantSenator URL', () => {
  const badHtml = '<a href="https://www.senate.mo.gov/Senators/SomethingElse?x=1" aria-label="View Senator Test Person details page">'
    + '<div class="card__footer">Senator Test Person <br/> District 5</div></a>';
  assert.throws(() => parseSenateRosterHtml(badHtml), /unrecognized link shape/);
});

test('parseSenateRosterHtml: throws on a member card with no "District N" text in the footer', () => {
  const badHtml = '<a href="https://www.senate.mo.gov/Senators/Member?id=99" aria-label="View Senator Test Person details page">'
    + '<div class="card__footer">Senator Test Person</div></a>';
  assert.throws(() => parseSenateRosterHtml(badHtml), /no "District N" text/);
});

// ---- parseSenateRosterPdf (roster-2018-wayback.pdf, real fixture - CONTROLLER RULING 1: 33
// named senators + 1 vacancy (VACANT-17), a structurally different SURNAME, FIRSTNAME-DISTRICT
// text shape, not a variant of the HTML parser) ----

test('parseSenateRosterPdf (real fixture): 33 members + 1 vacancy, matching the HTML roster\'s 34-seat chamber size', () => {
  const { members, vacancies } = parseSenateRosterPdf(roster2018Text);
  assert.equal(members.length, 33);
  assert.equal(vacancies, 1);
});

test('parseSenateRosterPdf (real fixture): districts are 1-16 and 18-34 (17 is VACANT-17, excluded from members)', () => {
  const { members } = parseSenateRosterPdf(roster2018Text);
  const districts = members.map((m) => Number(m.mo_senate_id)).sort((a, b) => a - b);
  const expected = Array.from({ length: 34 }, (_, i) => i + 1).filter((d) => d !== 17);
  assert.deepEqual(districts, expected);
});

test('parseSenateRosterPdf (real fixture): spot-check Onder - surname "Onder", district "2" (task-3-brief.md\'s named ground truth)', () => {
  const { members } = parseSenateRosterPdf(roster2018Text);
  const onder = members.find((m) => m.mo_senate_id === '2');
  assert.deepEqual(onder, {
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  });
  assert.ok(members.every((m) => m.party === null), 'no party is printed in this document either (task-1-report.md)');
});

test('parseSenateRosterPdf (real fixture): a hyphenated surname title-cases correctly (Chappelle-Nadal)', () => {
  const { members } = parseSenateRosterPdf(roster2018Text);
  const chappelleNadal = members.find((m) => m.mo_senate_id === '14');
  assert.deepEqual(chappelleNadal, {
    mo_senate_id: '14', surname: 'Chappelle-Nadal', full_name: 'Maria Chappelle-Nadal', party: null,
  });
});

test('parseSenateRosterPdf: throws (never returns []) on structurally unrecognizable text', () => {
  assert.throws(() => parseSenateRosterPdf('this is not a roster document'), /no recognizable .* entries/);
});

// ---- parseJournalIndex (journallist-current.html + journallist-2018.html, real fixtures -
// CONTROLLER RULING 2: same .journal-entry-card markup in both years) ----

test('parseJournalIndex (journallist-current.html, real fixture): 70 day entries', () => {
  const rows = parseJournalIndex(journalCurrentHtml);
  assert.equal(rows.length, 70);
  assert.deepEqual(rows[0], {
    day_label: 'Day 01',
    journal_url: 'https://www.senate.mo.gov/26info/Journals/RDay0101071-116.pdf',
    journal_date: '2026-01-07',
  });
});

test('parseJournalIndex (journallist-2018.html, real fixture): 88 day entries, including the REAL Day 37 URL', () => {
  const rows = parseJournalIndex(journal2018Html);
  assert.equal(rows.length, 88);
  const day37 = rows.find((r) => r.day_label === 'Day 37');
  assert.deepEqual(day37, {
    day_label: 'Day 37',
    journal_url: 'https://www.senate.mo.gov/18info/Journals/RDay370308587-610.pdf',
    journal_date: '2018-03-08',
  });
});

test('parseJournalIndex: every row carries an absolute https:// senate.mo.gov URL', () => {
  const rows = parseJournalIndex(journal2018Html);
  assert.ok(rows.every((r) => r.journal_url.startsWith('https://www.senate.mo.gov/')), 'expected every journal_url to be absolute');
});

test('parseJournalIndex: journal_date is null (never guessed from the filename) when the printed date does not parse', () => {
  const oddDateHtml = '<div class="w-100 journal-entry-card">'
    + '<h6 class="mb-0"><strong>Day 99</strong></h6>'
    + '<p class="mb-0 no-wrap"><strong>TBD</strong></p>'
    + '<a href="/26info/Journals/RDay9901010001-002.pdf">Open PDF</a></div>';
  const rows = parseJournalIndex(oddDateHtml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].journal_date, null);
  // the filename DOES encode a date (0101) - proving journal_date isn't silently derived from it
  assert.notEqual(rows[0].journal_url.includes('0101'), false);
});

test('parseJournalIndex: throws (never returns []) on structurally unrecognizable HTML', () => {
  assert.throws(() => parseJournalIndex('<html><body>nothing here</body></html>'), /no recognizable \.journal-entry-card entries/);
});
