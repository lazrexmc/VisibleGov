import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE, moHouseLimiter, MO_HOUSE_MIN_INTERVAL_MS,
  normalizeMoBillIdentifier, parseMoBillList, parseMoMemberList, parseMoRepresentative,
  parseMoBillXml, joinRollcalls, buildMoVoteRows,
} from '../src/adapters/mo-house-xml.js';
import {
  parseMoHouseArgs, remainingCooldownMs, formatCooldownWait, selectTargets, reconstructSurnameHeuristic,
} from '../src/cli/ingest-mo-house.js';

const FIXTURES = 'tests/fixtures/research/mo-house-xml';
const billListXml = readFileSync(`${FIXTURES}/bill-list-sample-truncated.xml`, 'utf8');
const memberListXml = readFileSync(`${FIXTURES}/member-list-sample-truncated.xml`, 'utf8');
const representativeXml = readFileSync(`${FIXTURES}/representative-107.xml`, 'utf8');
const hb1800Xml = readFileSync(`${FIXTURES}/HB1800-with-rollcall-tallies.xml`, 'utf8');
const hb2Xml = readFileSync(`${FIXTURES}/HB2-bill-text-pdf-only.xml`, 'utf8');

// ---- constants ----

test('SOURCE and moHouseLimiter are set up per house.mo.gov ToU (>= 30 min between requests)', () => {
  assert.equal(SOURCE, 'mo-house-xml');
  assert.equal(MO_HOUSE_MIN_INTERVAL_MS, 30 * 60 * 1000);
  assert.ok(moHouseLimiter && typeof moHouseLimiter.take === 'function');
});

// ---- normalizeMoBillIdentifier ----

test('normalizeMoBillIdentifier splits a bare BillNumber into "TYPE NNN"', () => {
  assert.equal(normalizeMoBillIdentifier('HB1800'), 'HB 1800');
  assert.equal(normalizeMoBillIdentifier('HB2'), 'HB 2');
  assert.equal(normalizeMoBillIdentifier('HJR28'), 'HJR 28');
});

test('normalizeMoBillIdentifier upper-cases and trims', () => {
  assert.equal(normalizeMoBillIdentifier(' hb1800 '), 'HB 1800');
});

// ---- parseMoBillList (real fixture is the source of truth — the brief's proposed shape with
// title/sponsor/last_action_date does NOT match the real BillList.XML, which only carries
// BillType/BillNumber/SessionYear/SessionCode/BillXMLLink/LastTimeRun per bill) ----

test('parseMoBillList yields many entries with the fields the real XML actually has', () => {
  const entries = parseMoBillList(billListXml);
  assert.ok(entries.length > 50, `expected >50 entries, got ${entries.length}`);
  const first = entries[0];
  assert.equal(first.bill_type, 'HB');
  assert.equal(first.bill_number, '2');
  assert.equal(first.identifier, 'HB 2');
  assert.equal(first.session_year, '2026');
  assert.equal(first.session_code, 'R');
  assert.equal(first.bill_xml_url, 'https://documents.house.mo.gov/xml/261-HB2.xml');
  assert.ok(first.last_time_run);
});

test('parseMoBillList entries all have a fetchable bill_xml_url', () => {
  const entries = parseMoBillList(billListXml);
  // The fixture is DELIBERATELY byte-truncated mid-document (see the file's own trailing
  // comment) — its last entry is cut off mid-element ('SessionCo' instead of 'SessionCode',
  // no BillXMLLink at all) as a direct artifact of that truncation, not a real parsing gap.
  // Every entry the real (untruncated) BillList.XML serves has a link; assert that here on
  // every entry except the known-incomplete final one.
  const complete = entries.slice(0, -1);
  assert.ok(complete.length > 40, `expected >40 complete entries, got ${complete.length}`);
  for (const e of complete) assert.ok(/^https:\/\/documents\.house\.mo\.gov\/xml\/.+\.xml$/i.test(e.bill_xml_url), e.bill_xml_url);
});

// ---- parseMoMemberList / parseMoRepresentative ----

test('parseMoMemberList yields district -> representative-XML-link entries', () => {
  const entries = parseMoMemberList(memberListXml);
  assert.ok(entries.length > 20, `expected >20 entries, got ${entries.length}`);
  const first = entries[0];
  assert.equal(first.district, '1'); // fast-xml-parser numeric-coerces "001" -> 1; String(1) === '1'
  assert.equal(first.representative_xml_url, 'https://documents.house.mo.gov/xml/261-001.xml');
});

test('parseMoRepresentative extracts the roster shape the brief specifies', () => {
  const rep = parseMoRepresentative(representativeXml);
  assert.deepEqual(rep, {
    mo_house_id: '107',
    surname: 'Matthiesen',
    full_name: 'Mark Matthiesen',
    party: 'Republican',
  });
});

// ---- parseMoBillXml ----

test('parseMoBillXml (HB1800): bill metadata', () => {
  const { bill } = parseMoBillXml(hb1800Xml);
  assert.equal(bill.identifier, 'HB 1800');
  assert.equal(bill.title, 'Changes the percentage of the cap on the inflationary growth factor for the assessment growth of real or personal property occurring within a political subdivision, defines assessment value, and adds provisions related to the sales ratio studies performed by the State Tax Commission');
  assert.equal(bill.status, '03/23/2026 - Second read and referred: Select Committee on Property Taxes and the State Tax Commission(S)');
  assert.equal(bill.canonical_url, 'https://house.mo.gov/bill.aspx?bill=HB1800&year=2026&code=R');
  assert.equal(bill.sponsor_name, 'Mark Matthiesen');
  assert.equal(bill.sponsor_district, '107');
});

test('parseMoBillXml (HB1800): every Action becomes an action row', () => {
  const { actions } = parseMoBillXml(hb1800Xml);
  assert.equal(actions.length, 26); // verified directly against the fixture
  assert.equal(actions[0].description, 'Prefiled (H)');
  assert.equal(actions[0].date, '2025-12-01');
  assert.ok(actions.every((a) => a.description && a.date));
});

test('parseMoBillXml (HB1800): 4 aggregate roll calls, only the floor vote carries a PDF link', () => {
  const { rollcalls } = parseMoBillXml(hb1800Xml);
  assert.equal(rollcalls.length, 4);
  // 3 committee "Reported Do Pass" votes have no matching BillText-level RollCalls entry
  assert.deepEqual(rollcalls.slice(0, 3).map((r) => ({ yes: r.yes, no: r.no, present: r.present, pdf_url: r.pdf_url })), [
    { yes: 6, no: 3, present: 0, pdf_url: null },
    { yes: 9, no: 3, present: 0, pdf_url: null },
    { yes: 5, no: 2, present: 0, pdf_url: null },
  ]);
  const floor = rollcalls[3];
  assert.equal(floor.yes, 82);
  assert.equal(floor.no, 61);
  assert.equal(floor.present, 2);
  assert.equal(floor.motion, 'Third Read and Passed (H)');
  assert.equal(floor.date, '2026-03-09');
  assert.equal(floor.pdf_url, 'https://documents.house.mo.gov/billtracking/bills261/rollcalls/034.008.pdf');
  assert.equal(floor.session_day, '34');
  assert.equal(floor.roll_call_number, '8');
});

test('parseMoBillXml (HB2): a bill with no roll calls and a single non-array Action/Sponsor', () => {
  const { bill, actions, rollcalls } = parseMoBillXml(hb2Xml);
  assert.equal(bill.identifier, 'HB 2');
  assert.equal(bill.sponsor_name, 'Dirk Deaton');
  assert.equal(bill.sponsor_district, '159');
  assert.equal(actions.length, 1);
  assert.equal(rollcalls.length, 0);
});

// SCHEMA-DERIVED SYNTHETIC FIXTURE — NOT a real capture. Built directly from
// xml-bill-exports-schema-doc.html's documented Amendment > RollCalls > RollCall shape
// (lines ~111-137), which the schema doc describes as identical in shape to BillText's
// RollCalls > RollCall (already verified against the real HB1800 fixture: RollCallPDF,
// SessionDay, RollCallNumber, TotalYes, TotalNo, TotalPresent). No real captured research
// fixture contains an Amendment-level RollCall — this exists purely to cover the documented
// (but unobserved-in-the-wild) code path added for the durable-cooldown/amendment-rollcall fix.
const syntheticAmendmentRollCallXml = '<ROOT><BillInformation>'
  + '<BillNumber>HB9999</BillNumber>'
  + '<Title><ShortTitle>SYNTHETIC</ShortTitle><LongTitle>Synthetic bill for schema-derived Amendment RollCall coverage</LongTitle></Title>'
  + '<LastAction>synthetic</LastAction>'
  + '<Action><Link>https://house.mo.gov/bill.aspx?bill=HB9999&amp;year=2026&amp;code=R</Link>'
  + '<Description>Adopted Amendment (H)</Description><Guid>1</Guid><ActivitySequence>100</ActivitySequence>'
  + '<PubDate>2026-04-01</PubDate>'
  + '<RollCall><TotalYes>90</TotalYes><TotalNo>50</TotalNo><TotalPresent>1</TotalPresent></RollCall></Action>'
  + '<Amendment><AmendmentText>https://documents.house.mo.gov/billtracking/bills261/amendpdf/9999H01.01H.pdf</AmendmentText>'
  + '<LRNumber>9999H01.01H</LRNumber><Status>A</Status><StatusDescription>Adopted</StatusDescription>'
  + '<AmendmentDescription>HA 1</AmendmentDescription><Sponsor>Synthetic Sponsor</Sponsor>'
  + '<RollCalls><RollCall><RollCallPDF>https://documents.house.mo.gov/billtracking/bills261/rollcalls/099.001.pdf</RollCallPDF>'
  + '<SessionDay>99</SessionDay><RollCallNumber>1</RollCallNumber>'
  + '<TotalYes>90</TotalYes><TotalNo>50</TotalNo><TotalPresent>1</TotalPresent></RollCall></RollCalls></Amendment>'
  + '<Sponsor><SponsorType>Sponsor</SponsorType><FullName>Synthetic Sponsor</FullName><District>1</District></Sponsor>'
  + '</BillInformation></ROOT>';

test('parseMoBillXml matches an Amendment-level RollCalls > RollCall (schema-derived synthetic — no real capture has one)', () => {
  const { rollcalls } = parseMoBillXml(syntheticAmendmentRollCallXml);
  assert.equal(rollcalls.length, 1);
  assert.equal(rollcalls[0].yes, 90);
  assert.equal(rollcalls[0].no, 50);
  assert.equal(rollcalls[0].present, 1);
  assert.equal(rollcalls[0].pdf_url, 'https://documents.house.mo.gov/billtracking/bills261/rollcalls/099.001.pdf');
  assert.equal(rollcalls[0].session_day, '99');
  assert.equal(rollcalls[0].roll_call_number, '1');
});

test('buildMoVoteRows on the synthetic Amendment-rollcall bill yields a votes row carrying the amendment PDF as source_url', () => {
  const parsed = parseMoBillXml(syntheticAmendmentRollCallXml);
  const rows = buildMoVoteRows(parsed.bill.identifier, parsed.rollcalls);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_key, 'mo-house-xml-HB9999-1');
  assert.equal(rows[0].result, '90-50');
  assert.equal(rows[0].source_url, 'https://documents.house.mo.gov/billtracking/bills261/rollcalls/099.001.pdf');
});

// ---- joinRollcalls (pure tally-matching helper) ----

test('joinRollcalls attaches pdf_url only to the action-rollcall whose tallies match exactly', () => {
  const actionRollcalls = [
    { date: '2026-01-22', motion: 'Reported Do Pass (H)', yes: 6, no: 3, present: 0 },
    { date: '2026-03-09', motion: 'Third Read and Passed (H)', yes: 82, no: 61, present: 2 },
  ];
  const pdfRollcalls = [
    { yes: 82, no: 61, present: 2, pdf_url: 'https://x/034.008.pdf', session_day: '34', roll_call_number: '8' },
  ];
  const joined = joinRollcalls(actionRollcalls, pdfRollcalls);
  assert.equal(joined[0].pdf_url, null);
  assert.equal(joined[1].pdf_url, 'https://x/034.008.pdf');
});

test('joinRollcalls never double-matches the same pdf rollcall to two action rollcalls', () => {
  const actionRollcalls = [
    { date: 'd1', motion: 'm1', yes: 5, no: 2, present: 0 },
    { date: 'd2', motion: 'm2', yes: 5, no: 2, present: 0 }, // identical tally, ambiguous
  ];
  const pdfRollcalls = [{ yes: 5, no: 2, present: 0, pdf_url: 'https://x/only-one.pdf', session_day: '1', roll_call_number: '1' }];
  const joined = joinRollcalls(actionRollcalls, pdfRollcalls);
  const withPdf = joined.filter((r) => r.pdf_url);
  assert.equal(withPdf.length, 1, 'only one of the two identical-tally rollcalls may claim the single pdf match');
});

// ---- buildMoVoteRows ----

test('buildMoVoteRows produces source_key mo-house-xml-<identifier>-<ordinal> and a numeric Y-N result (no computed judgment)', () => {
  const rollcalls = [
    { date: '2026-01-22', motion: 'Reported Do Pass (H)', yes: 6, no: 3, present: 0, pdf_url: null },
    { date: '2026-03-09', motion: 'Third Read and Passed (H)', yes: 82, no: 61, present: 2, pdf_url: 'https://x/034.008.pdf' },
  ];
  const rows = buildMoVoteRows('HB 1800', rollcalls);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_key, 'mo-house-xml-HB1800-1');
  assert.equal(rows[0].chamber, 'house');
  assert.equal(rows[0].question, 'Reported Do Pass (H)');
  assert.equal(rows[0].result, '6-3');
  assert.equal(rows[0].source_url, null);
  assert.equal(rows[1].source_key, 'mo-house-xml-HB1800-2');
  assert.equal(rows[1].result, '82-61');
  assert.equal(rows[1].source_url, 'https://x/034.008.pdf');
});

// ---- driver CLI arg parsing ----

test('parseMoHouseArgs: defaults', () => {
  const args = parseMoHouseArgs([]);
  assert.equal(args.session, '261');
  assert.equal(args.limit, 1);
  assert.equal(args.dryRun, false);
  assert.equal(args.billIdentifier, null);
  assert.equal(args.billXmlFile, null);
  assert.equal(args.rollcallPdfFile, null);
});

test('parseMoHouseArgs: --limit, --session, --bill, --bill-xml-file, --rollcall-pdf-file, --dry-run', () => {
  const args = parseMoHouseArgs([
    '--session', '261', '--limit', '5', '--bill', 'HB 1800', '--bill-xml-file', '/tmp/x.xml',
    '--rollcall-pdf-file', '/tmp/roll.pdf', '--dry-run',
  ]);
  assert.equal(args.session, '261');
  assert.equal(args.limit, 5);
  assert.equal(args.billIdentifier, 'HB 1800');
  assert.equal(args.billXmlFile, '/tmp/x.xml');
  assert.equal(args.rollcallPdfFile, '/tmp/roll.pdf');
  assert.equal(args.dryRun, true);
});

test('parseMoHouseArgs rejects unknown flags', () => {
  assert.throws(() => parseMoHouseArgs(['--nope', '1']), /unknown flag/);
});

test('parseMoHouseArgs normalizes --bill (case/space-insensitive) through normalizeMoBillIdentifier', () => {
  assert.equal(parseMoHouseArgs(['--bill', 'hb1800']).billIdentifier, 'HB 1800');
  assert.equal(parseMoHouseArgs(['--bill', 'Hb1800']).billIdentifier, 'HB 1800');
  assert.equal(parseMoHouseArgs(['--bill', 'HB 1800']).billIdentifier, 'HB 1800');
  assert.equal(parseMoHouseArgs(['--bill', ' hb1800 ']).billIdentifier, 'HB 1800');
});

// ---- selectTargets (integration check: a lowercase/unspaced --bill still matches a
// normalized bill-list entry, end to end) ----

test('selectTargets matches --bill against the fetched list after normalization', () => {
  const entries = [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }, { identifier: 'HB 1800', bill_xml_url: 'https://x/HB1800.xml' }];
  const args = parseMoHouseArgs(['--bill', 'hb1800']);
  const targets = selectTargets(entries, args);
  assert.deepEqual(targets, [{ identifier: 'HB 1800', bill_xml_url: 'https://x/HB1800.xml' }]);
});

// ---- durable cross-process ToU cooldown (pure helpers; the DB-querying wrapper
// enforceDurableCooldown is exercised live, same convention as ingest.js's other
// DB-touching collect/persist functions) ----

test('remainingCooldownMs: 0 when there is no prior run', () => {
  assert.equal(remainingCooldownMs(null, 30 * 60 * 1000), 0);
  assert.equal(remainingCooldownMs(undefined, 30 * 60 * 1000), 0);
});

test('remainingCooldownMs: full interval when the prior run just started', () => {
  const now = Date.parse('2026-07-28T05:00:00Z');
  const lastStart = '2026-07-28T05:00:00Z';
  assert.equal(remainingCooldownMs(lastStart, 30 * 60 * 1000, now), 30 * 60 * 1000);
});

test('remainingCooldownMs: partial wait when partway through the interval', () => {
  const now = Date.parse('2026-07-28T05:04:00Z'); // 4 minutes after lastStart
  const lastStart = '2026-07-28T05:00:00Z';
  assert.equal(remainingCooldownMs(lastStart, 30 * 60 * 1000, now), 26 * 60 * 1000);
});

test('remainingCooldownMs: 0 once the interval has fully elapsed (never negative)', () => {
  const now = Date.parse('2026-07-28T06:00:00Z'); // 60 minutes after lastStart
  const lastStart = '2026-07-28T05:00:00Z';
  assert.equal(remainingCooldownMs(lastStart, 30 * 60 * 1000, now), 0);
});

test('formatCooldownWait formats whole minutes and seconds, rounding up to the next second', () => {
  assert.equal(formatCooldownWait(26 * 60 * 1000), '26m 0s');
  assert.equal(formatCooldownWait(90 * 1000), '1m 30s');
  assert.equal(formatCooldownWait(500), '0m 1s');
  assert.equal(formatCooldownWait(0), '0m 0s');
});

// ---- reconstructSurnameHeuristic (loadMoRoster's fallback-only path — Task 4b fix round) ----
//
// legislators.surname (migration 0006) is now the PRIMARY source loadMoRoster uses, populated
// straight from the real fixture's <LastName> element (parseMoRepresentative). This heuristic only
// runs when a row's surname is somehow still null despite the column existing. Pinned here exactly
// so the real failure mode is documented, not glossed over as mere "fragility": it is CORRECT for
// a single-token first name and WRONG for a multi-word first name — never merely imprecise.

test('reconstructSurnameHeuristic: correct for the real fixture shape (single-token first name)', () => {
  assert.equal(reconstructSurnameHeuristic('Mark Matthiesen'), 'Matthiesen');
});

test('reconstructSurnameHeuristic: WRONG for a multi-word first name — this is the real, non-silent failure mode', () => {
  // "Mary Jane Smith" (first name "Mary Jane", surname "Smith") — the heuristic has no way to
  // know where the first name ends, so it takes "everything after the first space" and produces
  // "Jane Smith", not the real surname "Smith". See resolveMoRep's own test in
  // tests/mo-rollcall-pdf.test.js for proof this wrong value still can't silently misattribute a
  // vote — it just fails to match, landing the cast in unresolved[].
  assert.equal(reconstructSurnameHeuristic('Mary Jane Smith'), 'Jane Smith');
});

test('reconstructSurnameHeuristic: empty/null input yields an empty string, not a throw', () => {
  assert.equal(reconstructSurnameHeuristic(''), '');
  assert.equal(reconstructSurnameHeuristic(null), '');
  assert.equal(reconstructSurnameHeuristic(undefined), '');
});

test('reconstructSurnameHeuristic: a bare single-token full_name (no space at all) yields an empty surname', () => {
  // Realistic edge case: no first name on record at all — the heuristic can't invent one.
  assert.equal(reconstructSurnameHeuristic('Matthiesen'), '');
});
