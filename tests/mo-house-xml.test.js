import {
  readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE, moHouseLimiter, MO_HOUSE_MIN_INTERVAL_MS,
  normalizeMoBillIdentifier, parseMoBillList, parseMoMemberList, parseMoRepresentative,
  parseMoBillXml, joinRollcalls, buildMoVoteRows,
} from '../src/adapters/mo-house-xml.js';
import {
  parseMoHouseArgs, remainingCooldownMs, formatCooldownWait, selectTargets, reconstructSurnameHeuristic,
  enforceDurableCooldown, CooldownConvergenceError,
  writeFailureArtifact, readFailureArtifact, excludeQuarantinedPdfs, ROLLCALL_MAX_FAILED_ATTEMPTS,
  replayArtifacts,
  persistBillDetail, hasEnrichedMarker, writeEnrichedMarker, backfillEnrichedMarkers,
  shouldRefetchBillList, readCachedBillList, writeCachedBillList, MO_BILL_LIST_MAX_AGE_MS,
  countPendingBills, runMoHouse, LiveRequestLimitError,
} from '../src/cli/ingest-mo-house.js';
// 2026-08-01 fast-follow (GAP 2): the scheduler's own predicate, pinned against the LITERAL new
// run-detail shapes runMoHouse now emits — never a hand-approximated copy of the shape. Imported
// straight from the scheduler script (already exported there; no changes to that file).
import { moHouseWroteSomething } from '../scripts/scheduled-ingest.js';

const FIXTURES = 'tests/fixtures/research/mo-house-xml';
const billListXml = readFileSync(`${FIXTURES}/bill-list-sample-truncated.xml`, 'utf8');
const memberListXml = readFileSync(`${FIXTURES}/member-list-sample-truncated.xml`, 'utf8');
const representativeXml = readFileSync(`${FIXTURES}/representative-107.xml`, 'utf8');
const hb1800Xml = readFileSync(`${FIXTURES}/HB1800-with-rollcall-tallies.xml`, 'utf8');
const hb2Xml = readFileSync(`${FIXTURES}/HB2-bill-text-pdf-only.xml`, 'utf8');
// Real captured 4-column roll-call PDF (ground truth, task-4b-brief.md, also used by
// tests/mo-rollcall-pdf.test.js): 82 yes / 61 no / 2 present / 13 absent / 5 vacancies, MATTHIESEN
// voted Y. Read as raw bytes (no encoding) — processRollCallPdf's live branch does
// `Buffer.from(await fetchRollCallPdf(...))`, so the injected fake fetcher must return something
// Buffer.from can consume, exactly like the real ArrayBuffer fetchMoRollCallPdf returns.
const rollcallPdfBuffer = readFileSync(`${FIXTURES}/rollcall-034.008.pdf`);

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

test('buildMoVoteRows derives chamber from the motion text\'s trailing (H)/(S) marker instead of hardcoding house — a House bill\'s action history includes Senate actions', () => {
  const rollcalls = [
    { date: '2026-01-22', motion: 'Reported Do Pass (H)', yes: 6, no: 3, present: 0, pdf_url: null },
    { date: '2026-05-05', motion: 'Third Read and Passed with Amendments (S)', yes: 23, no: 8, present: 0, pdf_url: null },
    { date: '2026-06-01', motion: 'Truly Agreed To and Finally Passed', yes: 144, no: 2, present: 0, pdf_url: null },
  ];
  const rows = buildMoVoteRows('HB 1800', rollcalls);
  assert.equal(rows[0].chamber, 'house');
  assert.equal(rows[1].chamber, 'senate');
  // No trailing (H)/(S) marker at all (e.g. final-passage actions) keeps the prior default —
  // confirmed against live data: both real no-marker rows are genuinely House-sized tallies.
  assert.equal(rows[2].chamber, 'house');
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

// ---- enforceDurableCooldown (final-review FINDING 1: cooldown convergence race) ----
//
// Bug found in whole-branch review: the pre-fix implementation read ingestion_runs ONCE, slept
// out whatever remaining cooldown that single read implied, then proceeded unconditionally — two
// processes starting within the same cooldown window would read the same last started_at, sleep
// to the same wake time, and both proceed. Fixed by looping: after every sleep, re-query from
// scratch and only proceed once a FRESH read shows remaining <= 0. sleep is injected (never a real
// setTimeout in these tests) so the loop's re-check behavior can be observed deterministically and
// instantly.

// Stubs the exact chain enforceDurableCooldown drives (.from('ingestion_runs').select().eq()
// .order().limit().maybeSingle()) and returns queued responses in order, one per call (repeating
// the last one if called more times than responses provided) — lets a single test simulate
// successive DB reads returning different rows, which the static-per-table fakeClient pattern
// used elsewhere in this repo (tests/review-logic.test.js) does not support.
function queuedIngestionRunsClient(responses) {
  let call = 0;
  const client = {
    from(table) {
      assert.equal(table, 'ingestion_runs', 'enforceDurableCooldown must only query ingestion_runs');
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => {
                  const response = responses[Math.min(call, responses.length - 1)];
                  call += 1;
                  return response;
                },
              }),
            }),
          }),
        }),
      };
    },
  };
  return { client, callCount: () => call };
}

test('enforceDurableCooldown: no prior run at all — proceeds on the first read, never sleeps', async () => {
  const { client, callCount } = queuedIngestionRunsClient([{ data: null, error: null }]);
  const sleep = async () => { throw new Error('must not sleep when there is no prior run'); };
  await enforceDurableCooldown(client, 30 * 60 * 1000, { sleep });
  assert.equal(callCount(), 1);
});

test('enforceDurableCooldown: loops on a fresh re-check after each sleep, converging only once a FRESH read shows remaining <= 0 (regression: convergence race)', async () => {
  const minIntervalMs = 30 * 60 * 1000;
  const now = Date.now();
  const responses = [
    // 1st read: last run started ~5 min ago -> ~25 min remaining
    { data: { started_at: new Date(now - 5 * 60 * 1000).toISOString() }, error: null },
    // 2nd read (after the 1st sleep): a NEWER started_at appeared — another process claimed the
    // slot mid-sleep — so remaining actually went UP, not down (~29 min remaining). Proves the
    // loop used a genuinely fresh read, not a cached/stale one.
    { data: { started_at: new Date(now - 1 * 60 * 1000).toISOString() }, error: null },
    // 3rd read (after the 2nd sleep): clear — cooldown has fully elapsed, proceed.
    { data: { started_at: new Date(now - minIntervalMs).toISOString() }, error: null },
  ];
  const { client, callCount } = queuedIngestionRunsClient(responses);
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  await enforceDurableCooldown(client, minIntervalMs, { sleep });
  assert.equal(callCount(), 3, 'expected 3 fresh reads: the initial read + one re-check after each of the 2 sleeps');
  assert.equal(sleeps.length, 2, 'expected exactly 2 sleeps, one after read 1 and one after read 2');
  assert.ok(sleeps[0] > 24 * 60 * 1000 && sleeps[0] <= 25 * 60 * 1000, `expected ~25min first wait, got ${sleeps[0]}ms`);
  assert.ok(sleeps[1] > 28 * 60 * 1000 && sleeps[1] <= 29 * 60 * 1000, `expected ~29min second wait, got ${sleeps[1]}ms`);
  assert.ok(sleeps[1] > sleeps[0], 'second wait must reflect the newer, later started_at (a bigger remaining time) — proof the re-check used a fresh read, not the first one');
});

test('enforceDurableCooldown: throws a typed CooldownConvergenceError after maxIterations fresh re-checks that never converge (fail loud, not forever)', async () => {
  const minIntervalMs = 30 * 60 * 1000;
  const { client, callCount } = queuedIngestionRunsClient([
    // every read is "just started" relative to the real clock — never converges
    { data: { started_at: new Date().toISOString() }, error: null },
  ]);
  let sleepCalls = 0;
  const sleep = async () => { sleepCalls += 1; };
  await assert.rejects(
    () => enforceDurableCooldown(client, minIntervalMs, { sleep, maxIterations: 3 }),
    (err) => {
      assert.ok(err instanceof CooldownConvergenceError);
      assert.equal(err.name, 'CooldownConvergenceError');
      assert.equal(err.maxIterations, 3);
      return true;
    },
  );
  assert.equal(callCount(), 3, 'expected exactly maxIterations fresh reads before giving up');
  assert.equal(sleepCalls, 3, 'expected a sleep after each of the 3 non-converging reads');
});

test('enforceDurableCooldown: a lookup failure is a hard error, never silently swallowed by the loop', async () => {
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: null, error: { message: 'connection refused' } }),
            }),
          }),
        }),
      }),
    }),
  };
  await assert.rejects(
    () => enforceDurableCooldown(client, 30 * 60 * 1000, { sleep: async () => {} }),
    /mo-house cooldown lookup failed: connection refused/,
  );
});

// ---- failing-PDF quarantine (final-review FINDING 2: a permanently-failing PDF must not wedge
// the queue) ----
//
// Bug found in whole-branch review: a PDF that persistently fails extraction/reconciliation
// (RollCallParseError) stayed "pending" forever, sorted first (source_key ascending), and got a
// fresh LIVE re-fetch every 30-minute cooldown slot. Fixed: a failure writes a `<source_key>
// .failed.json` artifact with an incrementing `attempts` counter; once attempts reaches
// ROLLCALL_MAX_FAILED_ATTEMPTS (3), excludeQuarantinedPdfs drops that source_key from the queue.
// dir is injected (a scratch temp dir, never the real ROLLCALL_ARTIFACT_DIR) so these tests never
// touch the gitignored artifacts dir a live driver process may be using concurrently.

function withScratchArtifactDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-rollcall-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeFailureArtifact: first failure writes attempts=1 with the error name+message and pdf_url', () => {
  withScratchArtifactDir((dir) => {
    const err = Object.assign(new Error('parsed cast counts do not reconcile: yes: parsed 2 vs printed 5'), { name: 'RollCallParseError' });
    const record = writeFailureArtifact('mo-house-xml-HB1800-4', 'https://documents.house.mo.gov/billtracking/bills261/rollcalls/034.008.pdf', err, dir);
    assert.equal(record.attempts, 1);
    assert.equal(record.source_key, 'mo-house-xml-HB1800-4');
    assert.equal(record.pdf_url, 'https://documents.house.mo.gov/billtracking/bills261/rollcalls/034.008.pdf');
    assert.deepEqual(record.error, { name: 'RollCallParseError', message: err.message });
    assert.ok(record.failed_at);

    const onDisk = readFailureArtifact('mo-house-xml-HB1800-4', dir);
    assert.deepEqual(onDisk, record);
  });
});

test('writeFailureArtifact: attempts increments (never resets) across repeated failures of the SAME source_key', () => {
  withScratchArtifactDir((dir) => {
    const err = Object.assign(new Error('boom'), { name: 'RollCallParseError' });
    const first = writeFailureArtifact('mo-house-xml-HB1800-4', 'https://x/034.008.pdf', err, dir);
    const second = writeFailureArtifact('mo-house-xml-HB1800-4', 'https://x/034.008.pdf', err, dir);
    const third = writeFailureArtifact('mo-house-xml-HB1800-4', 'https://x/034.008.pdf', err, dir);
    assert.equal(first.attempts, 1);
    assert.equal(second.attempts, 2);
    assert.equal(third.attempts, 3);
  });
});

test('excludeQuarantinedPdfs: a source_key below the retry cap (attempts < 3) is kept in the queue', () => {
  withScratchArtifactDir((dir) => {
    const err = Object.assign(new Error('boom'), { name: 'RollCallParseError' });
    writeFailureArtifact('mo-house-xml-HB1-1', 'https://x/1.pdf', err, dir); // attempts=1
    writeFailureArtifact('mo-house-xml-HB1-1', 'https://x/1.pdf', err, dir); // attempts=2
    const candidates = [{ id: 'v1', source_key: 'mo-house-xml-HB1-1' }];
    const { kept, skippedFailed } = excludeQuarantinedPdfs(candidates, dir);
    assert.equal(skippedFailed, 0);
    assert.deepEqual(kept, candidates);
  });
});

test('excludeQuarantinedPdfs: skips a source_key once attempts reaches ROLLCALL_MAX_FAILED_ATTEMPTS (3), while an unrelated never-failed source_key stays in the queue', () => {
  withScratchArtifactDir((dir) => {
    assert.equal(ROLLCALL_MAX_FAILED_ATTEMPTS, 3);
    const err = Object.assign(new Error('boom'), { name: 'RollCallParseError' });
    writeFailureArtifact('mo-house-xml-HB1-1', 'https://x/1.pdf', err, dir);
    writeFailureArtifact('mo-house-xml-HB1-1', 'https://x/1.pdf', err, dir);
    writeFailureArtifact('mo-house-xml-HB1-1', 'https://x/1.pdf', err, dir); // 3rd failure -> quarantined
    const candidates = [
      { id: 'v1', source_key: 'mo-house-xml-HB1-1' },
      { id: 'v2', source_key: 'mo-house-xml-HB2-1' }, // never failed — must stay in the queue
    ];
    const { kept, skippedFailed, skippedKeys } = excludeQuarantinedPdfs(candidates, dir);
    assert.equal(skippedFailed, 1);
    assert.deepEqual(kept, [{ id: 'v2', source_key: 'mo-house-xml-HB2-1' }]);
    // Re-review: a bare count gives an operator no way to know WHICH document is quarantined
    // without listing the artifacts dir by hand — skippedKeys names it directly.
    assert.deepEqual(skippedKeys, ['mo-house-xml-HB1-1']);
  });
});

test('excludeQuarantinedPdfs: a manually-deleted .failed.json re-enables the PDF — the skip is driven purely by file presence, no other state', () => {
  withScratchArtifactDir((dir) => {
    const err = Object.assign(new Error('boom'), { name: 'RollCallParseError' });
    writeFailureArtifact('mo-house-xml-HB1-1', 'https://x/1.pdf', err, dir);
    writeFailureArtifact('mo-house-xml-HB1-1', 'https://x/1.pdf', err, dir);
    writeFailureArtifact('mo-house-xml-HB1-1', 'https://x/1.pdf', err, dir); // attempts=3, quarantined
    const candidates = [{ id: 'v1', source_key: 'mo-house-xml-HB1-1' }];

    const before = excludeQuarantinedPdfs(candidates, dir);
    assert.equal(before.skippedFailed, 1);
    assert.deepEqual(before.kept, []);

    const failedPath = join(dir, 'mo-house-xml-HB1-1.failed.json');
    assert.ok(existsSync(failedPath), 'sanity: the failure artifact must actually exist on disk before deletion');
    rmSync(failedPath); // simulates an operator's manual reset — no code path in this driver does this

    const after = excludeQuarantinedPdfs(candidates, dir);
    assert.equal(after.skippedFailed, 0);
    assert.deepEqual(after.kept, candidates);
  });
});

// ---- replayArtifacts must ignore .failed.json (re-review regression: a plain '.json' suffix
// filter also matched the quarantine artifacts writeFailureArtifact writes, and those carry no
// `casts` field — replayArtifacts's `for (const cast of artifact.casts)` threw an UNCAUGHT
// TypeError on every invocation the moment any PDF had failed even once, a total driver outage
// that gets worse once migrations 0005/0006 land, since this function runs unconditionally on
// every invocation regardless of the migration gate) ----

async function withScratchArtifactDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-rollcall-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Minimal fake client covering exactly the two tables replayArtifacts's happy path touches:
// legislators (loadMoRoster) and vote_casts (insertIfAbsent). Any other table is a test bug.
function fakeReplayClient(legislatorsRows) {
  return {
    from(table) {
      if (table === 'legislators') {
        return { select: () => ({ not: async () => ({ data: legislatorsRows, error: null }) }) };
      }
      if (table === 'vote_casts') {
        return { upsert: async () => ({ error: null }) };
      }
      throw new Error(`fakeReplayClient: unexpected table "${table}"`);
    },
  };
}

test('replayArtifacts: a directory containing ONLY a .failed.json (no real gate artifact) is skipped cleanly — no throw, not counted in attempted', async () => {
  await withScratchArtifactDirAsync(async (dir) => {
    const err = Object.assign(new Error('boom'), { name: 'RollCallParseError' });
    writeFailureArtifact('mo-house-xml-HB2-1', 'https://x/2.pdf', err, dir);

    const result = await replayArtifacts(fakeReplayClient([]), 'run-1', dir);
    assert.deepEqual(result, {
      attempted: 0, replayed: 0, stillGated: false, unresolved: 0, unresolvedSample: [],
    });
    // the .failed.json itself must be untouched — replayArtifacts never even looked at it
    assert.ok(existsSync(join(dir, 'mo-house-xml-HB2-1.failed.json')));
  });
});

test('replayArtifacts: a mixed directory (a real gate artifact alongside an unrelated .failed.json) replays only the real one — the .failed.json is never counted, never read as a cast list, and survives untouched', async () => {
  await withScratchArtifactDirAsync(async (dir) => {
    // Real gate artifact, same shape persistRollCallCasts writes when migration 0005/0006 isn't
    // applied yet: { vote_id, source_key, tallies, casts, extracted_run_id, note }.
    const gateArtifact = {
      vote_id: 'vote-1',
      source_key: 'mo-house-xml-HB1-1',
      tallies: { yes: 1, no: 0, present: 0, absent: 0, vacancies: 0 },
      casts: [{ surname: 'MATTHIESEN', district: null, position: 'yea' }],
      extracted_run_id: 'run-0',
      note: 'test fixture',
    };
    writeFileSync(join(dir, 'mo-house-xml-HB1-1.json'), JSON.stringify(gateArtifact, null, 2));

    // A DIFFERENT source_key's failure artifact, sitting in the same directory (the realistic
    // case: one PDF gated on the migration, an unrelated PDF permanently failing extraction).
    const err = Object.assign(new Error('boom'), { name: 'RollCallParseError' });
    writeFailureArtifact('mo-house-xml-HB2-1', 'https://x/2.pdf', err, dir);

    const roster = [{
      id: 'leg-matthiesen', full_name: 'Mark Matthiesen', surname: 'Matthiesen', mo_house_id: '107',
    }];
    const result = await replayArtifacts(fakeReplayClient(roster), 'run-2', dir);

    assert.equal(result.attempted, 1, 'only the real .json artifact counts — the .failed.json must not');
    assert.equal(result.replayed, 1, 'MATTHIESEN resolves against the roster, so the gate artifact fully replays');
    assert.equal(result.unresolved, 0);

    // the real artifact is deleted once fully replayed (existing behavior, unchanged)...
    assert.equal(existsSync(join(dir, 'mo-house-xml-HB1-1.json')), false);
    // ...but the unrelated .failed.json must still be there, completely untouched.
    assert.ok(existsSync(join(dir, 'mo-house-xml-HB2-1.failed.json')));
    const stillFailed = readFailureArtifact('mo-house-xml-HB2-1', dir);
    assert.equal(stillFailed.attempts, 1);

    // sanity: exactly the one remaining file in the directory.
    assert.deepEqual(readdirSync(dir), ['mo-house-xml-HB2-1.failed.json']);
  });
});

// ---- Task fix-mo-enrichment ----
//
// LIVE BUG: selectTargets's default branch used to be `entries.slice(0, args.limit)` with zero
// enrichment-state awareness, so every invocation without an explicit --bill re-selected the
// exact same top-of-list bill(s) forever. Verified live: HB 2 (entry #1 in the real session-261
// list) was fetched on 11 of 12 real half-hour cooldown slots (2026-07-28T04:50Z-10:54Z) with zero
// net enrichment progress — additivePatch (already wired since this file's first commit) correctly
// produced an empty patch on every refetch after the first, but selectTargets never advanced past
// HB 2 to begin with. These tests pin: (1) additivePatch really is wired end-to-end through
// persistBillDetail with a stubbed client (not just at the pure-function level — see
// tests/db.test.js for that), (2) the new marker-file mechanism that lets selectTargets actually
// advance, and (3) the bill-list refetch cadence fix (every invocation used to burn its entire
// cooldown slot re-fetching the list before ever reaching the per-bill fetch, live-proven by every
// ingestion_runs started_at/finished_at pair for this source being exactly 30 minutes apart).

// Minimal fake 'bills' client covering exactly what persistBillDetail's UPDATE path touches
// (select().eq().eq().maybeSingle(), then update().eq()). parsed.actions/rollcalls are left empty
// in these tests so insertIfAbsent's own `rows.length === 0` early return (src/lib/db.js) means
// bill_actions/votes are never touched — the client never needs to stub those tables.
function fakeBillsUpdateClient(existingRow, updateSpy) {
  return {
    from(table) {
      assert.equal(table, 'bills', 'this fake only stubs the bills table (parsed.actions/rollcalls are empty, so bill_actions/votes never get touched — see insertIfAbsent\'s empty-rows early return)');
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: existingRow, error: null }),
            }),
          }),
        }),
        update: (patch) => ({
          eq: async (col, val) => { updateSpy(patch, col, val); return { error: null }; },
        }),
      };
    },
  };
}

test('persistBillDetail: additivePatch is wired end-to-end — a stub row with title=null gets updated with the freshly parsed title', async () => {
  const existing = {
    id: 'bill-1', title: null, status: null, canonical_url: null,
  };
  const updateCalls = [];
  const client = fakeBillsUpdateClient(existing, (patch, col, val) => updateCalls.push({ patch, col, val }));
  const parsed = {
    bill: {
      identifier: 'HB 2', title: 'X', status: null, canonical_url: null,
    },
    actions: [],
    rollcalls: [],
  };
  const result = await persistBillDetail(client, 'run-1', { id: 'session-1' }, parsed);
  assert.equal(updateCalls.length, 1, 'existing.title was null — additivePatch must produce a non-empty patch, triggering exactly one update()');
  assert.deepEqual(updateCalls[0].patch, { title: 'X', run_id: 'run-1' });
  assert.equal(updateCalls[0].col, 'id');
  assert.equal(updateCalls[0].val, 'bill-1');
  assert.equal(result.bill_id, 'bill-1');
});

test('persistBillDetail: a bill already fully enriched (non-null title) is never updated on refetch — the exact "zero progress" behavior observed live on HB 2', async () => {
  const existing = {
    id: 'bill-2', title: 'Already Set', status: null, canonical_url: null,
  };
  const updateCalls = [];
  const client = fakeBillsUpdateClient(existing, (patch, col, val) => updateCalls.push({ patch, col, val }));
  const parsed = {
    bill: {
      identifier: 'HB 2', title: 'A different value the refetch parsed', status: null, canonical_url: null,
    },
    actions: [],
    rollcalls: [],
  };
  const result = await persistBillDetail(client, 'run-2', { id: 'session-1' }, parsed);
  assert.equal(updateCalls.length, 0, 'existing.title was already non-null — additivePatch must produce an empty patch, so update() must never be called');
  assert.equal(result.bill_id, 'bill-2');
});

// ---- hasEnrichedMarker / writeEnrichedMarker (the actual fix: selectTargets now advances past
// already-enriched bills via file presence, not any DB column) ----

test('hasEnrichedMarker: false when no marker file exists yet', () => {
  withScratchArtifactDir((dir) => {
    assert.equal(hasEnrichedMarker('HB 2', dir), false);
  });
});

test('writeEnrichedMarker then hasEnrichedMarker: true once written, keyed on the space-stripped identifier (mirrors buildMoVoteRows source_key convention)', () => {
  withScratchArtifactDir((dir) => {
    writeEnrichedMarker('HB 2', { run_id: 'run-1', bill_id: 'bill-1' }, dir);
    assert.equal(hasEnrichedMarker('HB 2', dir), true);
    assert.ok(existsSync(join(dir, 'HB2.json')));
    const onDisk = JSON.parse(readFileSync(join(dir, 'HB2.json'), 'utf8'));
    assert.equal(onDisk.identifier, 'HB 2');
    assert.equal(onDisk.run_id, 'run-1');
    assert.equal(onDisk.bill_id, 'bill-1');
    assert.ok(onDisk.enriched_at);
  });
});

test('a manually-deleted marker re-enables the bill for selection — file-presence-driven, same idiom as the PDF quarantine', () => {
  withScratchArtifactDir((dir) => {
    writeEnrichedMarker('HB 2', {}, dir);
    assert.equal(hasEnrichedMarker('HB 2', dir), true);
    rmSync(join(dir, 'HB2.json'));
    assert.equal(hasEnrichedMarker('HB 2', dir), false);
  });
});

// ---- selectTargets: the actual regression test for the live bug (HB 2 selected forever) ----

test('selectTargets (no explicit --bill): a bill with an enriched marker is excluded, so the driver advances to the next not-yet-enriched bill — regression test for the live no-op loop', () => {
  withScratchArtifactDir((dir) => {
    const entries = [
      { identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' },
      { identifier: 'HB 3', bill_xml_url: 'https://x/HB3.xml' },
      { identifier: 'HB 4', bill_xml_url: 'https://x/HB4.xml' },
    ];
    writeEnrichedMarker('HB 2', {}, dir); // simulates HB 2 having already completed its cycle
    const args = parseMoHouseArgs(['--limit', '1']);
    const targets = selectTargets(entries, args, dir);
    assert.deepEqual(targets, [{ identifier: 'HB 3', bill_xml_url: 'https://x/HB3.xml' }], 'must skip the already-enriched HB 2 and select HB 3 next, not reselect HB 2 forever');
  });
});

test('selectTargets (no explicit --bill): with nothing enriched yet, behaves exactly as before (list-order, sliced to --limit)', () => {
  withScratchArtifactDir((dir) => {
    const entries = [
      { identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' },
      { identifier: 'HB 3', bill_xml_url: 'https://x/HB3.xml' },
    ];
    const args = parseMoHouseArgs(['--limit', '1']);
    const targets = selectTargets(entries, args, dir);
    assert.deepEqual(targets, [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }]);
  });
});

test('selectTargets: an explicit --bill bypasses the enriched-marker filter — an operator asking for a specific bill is honored even if it was already enriched', () => {
  withScratchArtifactDir((dir) => {
    const entries = [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }];
    writeEnrichedMarker('HB 2', {}, dir);
    const args = parseMoHouseArgs(['--bill', 'HB 2']);
    const targets = selectTargets(entries, args, dir);
    assert.deepEqual(targets, [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }]);
  });
});

test('selectTargets: --limit larger than the pending backlog returns only what is actually pending, never throws', () => {
  withScratchArtifactDir((dir) => {
    const entries = [
      { identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' },
      { identifier: 'HB 3', bill_xml_url: 'https://x/HB3.xml' },
    ];
    writeEnrichedMarker('HB 2', {}, dir);
    writeEnrichedMarker('HB 3', {}, dir);
    const args = parseMoHouseArgs(['--limit', '5']);
    const targets = selectTargets(entries, args, dir);
    assert.deepEqual(targets, []);
  });
});

// ---- backfillEnrichedMarkers (one-time migration helper: bills enriched under the OLD
// title-only signal, before this marker mechanism existed, need a marker backfilled so
// selectTargets doesn't reselect each of them exactly once more) ----

function fakeBillsSelectClient(rows) {
  return {
    from(table) {
      assert.equal(table, 'bills');
      return { select: () => ({ eq: () => ({ not: async () => ({ data: rows, error: null }) }) }) };
    },
  };
}

test('backfillEnrichedMarkers: writes a marker for every bill that already has a non-null title, reports the count', async () => {
  await withScratchArtifactDirAsync(async (dir) => {
    const client = fakeBillsSelectClient([{ identifier: 'HB 2' }, { identifier: 'HB 3' }]);
    const result = await backfillEnrichedMarkers(client, 'session-1', dir);
    assert.deepEqual(result, { backfilled: 2 });
    assert.equal(hasEnrichedMarker('HB 2', dir), true);
    assert.equal(hasEnrichedMarker('HB 3', dir), true);
    assert.equal(hasEnrichedMarker('HB 4', dir), false);
  });
});

test('backfillEnrichedMarkers: idempotent — running it twice does not throw or duplicate anything odd', async () => {
  await withScratchArtifactDirAsync(async (dir) => {
    const client = fakeBillsSelectClient([{ identifier: 'HB 2' }]);
    await backfillEnrichedMarkers(client, 'session-1', dir);
    const second = await backfillEnrichedMarkers(client, 'session-1', dir);
    assert.deepEqual(second, { backfilled: 1 });
    assert.equal(hasEnrichedMarker('HB 2', dir), true);
  });
});

// ---- shouldRefetchBillList / readCachedBillList / writeCachedBillList (bill-list refetch
// cadence: live-proven that every invocation used to burn its entire 30-min cooldown slot on a
// redundant list re-fetch, since the list fetch and the per-bill fetch share the same in-process
// moHouseLimiter — see this function's own comment in src/cli/ingest-mo-house.js) ----

test('shouldRefetchBillList: true when there is no prior cached fetch at all', () => {
  assert.equal(shouldRefetchBillList(null), true);
  assert.equal(shouldRefetchBillList(undefined), true);
});

test('shouldRefetchBillList: false when the cache is fresh (well under the max age)', () => {
  const now = Date.parse('2026-07-28T10:00:00Z');
  const fetchedAt = '2026-07-28T09:45:00Z'; // 15 minutes old
  assert.equal(shouldRefetchBillList(fetchedAt, 60 * 60 * 1000, now), false);
});

test('shouldRefetchBillList: true once the cache reaches maxAgeMs (>=, never waits past it)', () => {
  const now = Date.parse('2026-07-28T10:00:00Z');
  const fetchedAt = '2026-07-28T09:00:00Z'; // exactly 60 minutes old
  assert.equal(shouldRefetchBillList(fetchedAt, 60 * 60 * 1000, now), true);
});

test('shouldRefetchBillList: false just under maxAgeMs, true just over — boundary check', () => {
  const now = Date.parse('2026-07-28T10:00:00Z');
  assert.equal(shouldRefetchBillList('2026-07-28T09:00:01Z', 60 * 60 * 1000, now), false); // 59:59 old
  assert.equal(shouldRefetchBillList('2026-07-28T08:59:59Z', 60 * 60 * 1000, now), true); // 60:01 old
});

test('readCachedBillList: null when no cache file exists', () => {
  withScratchArtifactDir((dir) => {
    assert.equal(readCachedBillList('261', dir), null);
  });
});

test('readCachedBillList: null (never throws) on a corrupt cache file', () => {
  withScratchArtifactDir((dir) => {
    writeFileSync(join(dir, '261.json'), 'not valid json{{{');
    assert.equal(readCachedBillList('261', dir), null);
  });
});

test('writeCachedBillList then readCachedBillList: round-trips session, entries, and a fetched_at timestamp', () => {
  withScratchArtifactDir((dir) => {
    const entries = [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }];
    writeCachedBillList('261', entries, dir);
    const cached = readCachedBillList('261', dir);
    assert.equal(cached.session, '261');
    assert.deepEqual(cached.entries, entries);
    assert.ok(cached.fetched_at);
    assert.equal(shouldRefetchBillList(cached.fetched_at), false, 'a cache just written must not be considered stale');
  });
});

test('MO_BILL_LIST_MAX_AGE_MS is 24 hours (2026-08-01 one-request-per-run fix — raised from 60 minutes; see the constant\'s own comment in src/cli/ingest-mo-house.js for why)', () => {
  assert.equal(MO_BILL_LIST_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

// ---- countPendingBills ----

test('countPendingBills: counts entries without an enriched marker, excludes those with one', () => {
  withScratchArtifactDir((dir) => {
    const entries = [{ identifier: 'HB 2' }, { identifier: 'HB 3' }, { identifier: 'HB 4' }];
    writeEnrichedMarker('HB 3', {}, dir);
    assert.equal(countPendingBills(entries, dir), 2);
  });
});

// ---- runMoHouse (2026-08-01 one-request-per-run rebuild) ----
//
// THE DIAGNOSED DEFECT: a single invocation could need TWO live requests (a stale BillList.XML
// refresh, then a per-bill XML fetch) — both routed through the SAME shared moHouseLimiter, so the
// second request slept out ~30 minutes and the scheduler killed the process before it could ever
// finish (3-for-3 ETIMEDOUT). These tests pin the fix: runMoHouse makes at most one live request
// per invocation, chosen by a stale-list-vs-fresh-list slot decision, and never both in one run —
// using injected fetchBillList/fetchBillXml spies (never the real network) plus a minimal
// generic in-memory fake DB client (same style as ingest-mo-senate.js's runMoSenate test suite).

const threeBillListXml = `<ROOT>
<BillXML><BillType>HB</BillType><BillNumber>2</BillNumber><BillXMLLink>https://x/HB2.xml</BillXMLLink></BillXML>
<BillXML><BillType>HB</BillType><BillNumber>3</BillNumber><BillXMLLink>https://x/HB3.xml</BillXMLLink></BillXML>
<BillXML><BillType>HB</BillType><BillNumber>4</BillNumber><BillXMLLink>https://x/HB4.xml</BillXMLLink></BillXML>
</ROOT>`;

// Generic upsert/select/insert/update table — same shape/rationale as ingest-mo-senate.js's own
// makeGenericTable (generalized across table name so one fake client can cover
// sessions/bills/bill_actions/votes/legislators without five near-identical copies), extended with
// maybeSingle/update/insert().select().single()/like()/not() since persistBillDetail and the
// pending-roll-call-PDF query (listPendingRollCallPdfs) need those shapes too. `.order()` is a
// TERMINAL call here (resolves directly) — the only table this generic builder serves where
// `.order()` is used at all is `votes`' pending-PDF query, where it genuinely IS the last call in
// the chain; ingestion_runs (whose OWN `.order()` is followed by `.limit().maybeSingle()`) gets its
// own dedicated stub below instead, exactly like ingest-mo-senate.js's
// makeFakeMoSenateRunClient does.
function makeMoHouseTable(store, idPrefix) {
  let counter = 0;
  // builder is a genuine THENABLE (like the real Supabase/PostgREST query builder) rather than a
  // set of pseudo-terminal async methods guessing which call ends a chain: `.eq()`/`.in()`
  // COLLECT real filters and return `builder` for further chaining; `.like()`/`.not()`/`.order()`
  // are accepted (this fake never needs to actually filter/sort on them — every row this file
  // seeds already matches them by construction) but otherwise no-ops; `await builder` (at ANY
  // point in the chain, e.g. after `.not()` for loadMoRoster's roster query, or after `.order()`
  // for listPendingRollCallPdfs's pending-PDF query) resolves via `.then()` to the rows matching
  // whatever `.eq()`/`.in()` filters were actually set. FOUND WHILE BUILDING THIS FAST-FOLLOW:
  // an earlier draft made `.not()` a bare passthrough with NO `.then()` on the builder at all —
  // `await builder` (non-thenable) resolved to the builder object ITSELF, so `{ data, error } =
  // await ...` silently destructured to `{data: undefined, error: undefined}`, and
  // `(data ?? []).map(...)` in loadMoRoster happened to produce the same `[]` an empty roster
  // legitimately would — the PDF-priority test below would have passed for the WRONG reason and
  // silently returned `[]` even for a non-empty legislators store on any future test.
  const builderFor = (rows) => {
    const filters = [];
    const inFilters = [];
    const matching = () => rows.filter((r) => filters.every(([c, v]) => r[c] === v)
      && inFilters.every(([c, vals]) => vals.includes(r[c])));
    const builder = {
      eq(col, val) { filters.push([col, val]); return builder; },
      in(col, vals) { inFilters.push([col, vals]); return builder; },
      like() { return builder; },
      not() { return builder; },
      order() { return builder; },
      maybeSingle: async () => {
        const found = matching();
        return { data: found[0] ?? null, error: null };
      },
      single: async () => {
        const found = matching();
        if (found.length !== 1) return { data: null, error: { message: `expected 1 row for a fake table, got ${found.length}` } };
        return { data: found[0], error: null };
      },
      then(resolve) { resolve({ data: matching(), error: null }); },
    };
    return builder;
  };
  return {
    upsert: async (rows, opts) => {
      const conflictCols = (opts?.onConflict || '').split(',').filter(Boolean);
      for (const row of rows) {
        const exists = conflictCols.length > 0
          && store.some((r) => conflictCols.every((c) => r[c] === row[c]));
        if (!exists) { counter += 1; store.push({ id: `${idPrefix}-${counter}`, ...row }); }
      }
      return { error: null };
    },
    insert: (row) => ({
      select: () => ({
        single: async () => {
          counter += 1;
          const inserted = { id: `${idPrefix}-${counter}`, ...row };
          store.push(inserted);
          return { data: inserted, error: null };
        },
      }),
    }),
    update: (patch) => ({
      eq: async (col, val) => {
        const row = store.find((r) => r[col] === val);
        if (row) Object.assign(row, patch);
        return { error: null };
      },
    }),
    select: () => builderFor(store),
  };
}

// Covers exactly the tables runMoHouse's own steps touch: sessions (ensureSessionRow), bills
// (persistBillStubs/persistBillDetail), bill_actions (persistBillDetail), votes (persistBillDetail
// + selectPendingPdf's pending-roll-call-PDF query — always empty in these tests, so the PDF-queue
// branch never short-circuits a scenario meant to exercise the list/bill-detail slot decision),
// legislators (persistRoster). ingestion_runs gets its own dedicated stub (insert/select-cooldown/
// update), same convention as ingest-mo-senate.js's makeFakeMoSenateRunClient.
function makeFakeMoHouseRunClient() {
  const store = {
    sessions: [], bills: [], bill_actions: [], votes: [], legislators: [], vote_casts: [],
  };
  const closeCalls = [];
  let runCounter = 0;
  return {
    store,
    closeCalls,
    client: {
      from(table) {
        if (table === 'ingestion_runs') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => {
                  runCounter += 1;
                  return { data: { id: `run-${runCounter}` }, error: null };
                },
              }),
            }),
            select: () => {
              const builder = {
                eq: () => builder,
                order: () => builder,
                limit: () => builder,
                maybeSingle: async () => ({ data: null, error: null }), // no prior run -> zero cooldown wait
              };
              return builder;
            },
            update: (detail) => ({
              eq: async (col, val) => {
                closeCalls.push({ id: val, ...detail });
                return { error: null };
              },
            }),
          };
        }
        if (table in store) return makeMoHouseTable(store[table], table);
        throw new Error(`fake mo-house run client: unexpected table ${table}`);
      },
    },
  };
}

// ---- --limit semantics ----

test('runMoHouse: --limit > 1 throws a typed LiveRequestLimitError before touching the DB at all', async () => {
  const client = { from: () => { throw new Error('must not touch the DB when --limit > 1'); } };
  const args = parseMoHouseArgs(['--limit', '2']);
  await assert.rejects(
    () => runMoHouse(client, args),
    (err) => {
      assert.ok(err instanceof LiveRequestLimitError);
      assert.equal(err.limit, 2);
      assert.match(err.message, /ONE live house\.mo\.gov/);
      return true;
    },
  );
});

test('runMoHouse: --limit 1 (the scheduler\'s own frozen invocation) is unaffected', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const { client } = makeFakeMoHouseRunClient();
    const args = parseMoHouseArgs(['--limit', '1']);
    const result = await runMoHouse(client, args, {
      billsDir: join(base, 'bills'),
      billListDir: join(base, 'bill-list'),
      rollcallDir: join(base, 'rollcalls'),
      fetchBillList: async () => threeBillListXml,
      fetchBillXml: async () => hb2Xml,
    });
    assert.equal(result.status, 'succeeded');
  });
});

// ---- slot decision: stale/missing list -> list slot ----

test('runMoHouse: SLOT (a) — a missing bill-list cache spends this run\'s one request on fetchMoBillList and STOPS (never reaches fetchMoBillXml)', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list'); // empty -> no cache at all
    const rollcallDir = join(base, 'rollcalls');
    const { client } = makeFakeMoHouseRunClient();

    let listCalls = 0;
    let xmlCalls = 0;
    const fetchBillList = async (session) => { listCalls += 1; assert.equal(session, '261'); return threeBillListXml; };
    const fetchBillXml = async () => { xmlCalls += 1; return hb2Xml; };

    const args = parseMoHouseArgs(['--limit', '1']);
    const result = await runMoHouse(client, args, {
      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
    });

    assert.equal(listCalls, 1);
    assert.equal(xmlCalls, 0, 'slot (a) must never also fetch a bill this same run — the exact defect this fix closes');
    assert.equal(result.status, 'succeeded');
    assert.equal(result.counts.slot, 'list-refresh');
    assert.equal(result.counts.list_fetch_mode, 'live');
    assert.equal(result.counts.bills_detailed, 0);
    assert.equal(result.counts.bills_listed, 3);
    assert.equal(result.counts.total_pending_bills, 3);
    assert.ok(existsSync(join(billListDir, '261.json')), 'the freshly-fetched list must be cached for the NEXT invocation to read');
  });
});

test('runMoHouse: SLOT (a) — a bill-list cache older than MO_BILL_LIST_MAX_AGE_MS is treated the same as missing', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list');
    const rollcallDir = join(base, 'rollcalls');
    writeCachedBillList('261', [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }], billListDir);
    // Back-date the cache file's fetched_at past the 24h threshold directly (writeCachedBillList
    // always stamps "now").
    const cachePath = join(billListDir, '261.json');
    const stale = JSON.parse(readFileSync(cachePath, 'utf8'));
    stale.fetched_at = new Date(Date.now() - (MO_BILL_LIST_MAX_AGE_MS + 60000)).toISOString();
    writeFileSync(cachePath, JSON.stringify(stale, null, 2));

    const { client } = makeFakeMoHouseRunClient();
    let listCalls = 0;
    const fetchBillList = async () => { listCalls += 1; return threeBillListXml; };
    const fetchBillXml = async () => { throw new Error('must not fetch a bill this run'); };

    const args = parseMoHouseArgs(['--limit', '1']);
    const result = await runMoHouse(client, args, {
      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
    });

    assert.equal(listCalls, 1);
    assert.equal(result.counts.slot, 'list-refresh');
  });
});

// ---- slot decision: fresh list -> bill slot ----

test('runMoHouse: SLOT (b) — a fresh cached list reads it (zero live list fetches) and spends this run\'s one request on exactly ONE pending bill, not all pending bills', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list');
    const rollcallDir = join(base, 'rollcalls');
    const entries = [
      { identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' },
      { identifier: 'HB 3', bill_xml_url: 'https://x/HB3.xml' },
      { identifier: 'HB 4', bill_xml_url: 'https://x/HB4.xml' },
    ];
    writeCachedBillList('261', entries, billListDir); // fresh -> shouldRefetchBillList is false
    const { client } = makeFakeMoHouseRunClient();

    let listCalls = 0;
    let xmlCalls = 0;
    const fetchBillList = async () => { listCalls += 1; throw new Error('must not fetch the list live — the cache is fresh'); };
    const fetchBillXml = async () => { xmlCalls += 1; return hb2Xml; };

    const args = parseMoHouseArgs(['--limit', '1']);
    const result = await runMoHouse(client, args, {
      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
    });

    assert.equal(listCalls, 0);
    assert.equal(xmlCalls, 1, 'exactly one bill fetched, not 3 — the one-live-request-per-run invariant');
    assert.equal(result.status, 'succeeded');
    assert.equal(result.counts.slot, 'bill-detail');
    assert.equal(result.counts.list_fetch_mode, 'cached');
    assert.equal(result.counts.bills_detailed, 1);
    assert.equal(result.counts.total_pending_bills, 3, 'reports the backlog size BEFORE this run\'s own selection, mirroring ingest-mo-senate.js\'s total_pending_days');
  });
});

// ---- slot decision: nothing pending -> honest no-op ----

test('runMoHouse: SLOT (b) — nothing pending (every entry already enriched) is an honest no-op: zero live requests at all, status succeeded, bills_detailed 0', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list');
    const rollcallDir = join(base, 'rollcalls');
    const entries = [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }];
    writeCachedBillList('261', entries, billListDir);
    writeEnrichedMarker('HB 2', {}, billsDir);
    const { client } = makeFakeMoHouseRunClient();

    let listCalls = 0;
    let xmlCalls = 0;
    const fetchBillList = async () => { listCalls += 1; throw new Error('must not fetch live'); };
    const fetchBillXml = async () => { xmlCalls += 1; throw new Error('must not fetch live'); };

    const args = parseMoHouseArgs(['--limit', '1']);
    const result = await runMoHouse(client, args, {
      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
    });

    assert.equal(listCalls, 0);
    assert.equal(xmlCalls, 0);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.counts.slot, 'bill-detail');
    assert.equal(result.counts.bills_detailed, 0);
    assert.equal(result.counts.total_pending_bills, 0);
  });
});

// ---- explicit-file modes stay unaffected (point 6 of the fix) ----

test('runMoHouse: --bill-xml-file makes ZERO live requests regardless of a missing bill-list cache — unaffected by the slot decision', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list'); // empty -> would normally force slot (a)
    const rollcallDir = join(base, 'rollcalls');
    const { client } = makeFakeMoHouseRunClient();

    let listCalls = 0;
    let xmlCalls = 0;
    const fetchBillList = async () => { listCalls += 1; throw new Error('must not fetch the list live — --bill-xml-file needs no list at all'); };
    const fetchBillXml = async () => { xmlCalls += 1; throw new Error('must not fetch live — --bill-xml-file is a local fixture read'); };

    const args = parseMoHouseArgs(['--bill', 'HB 2', '--bill-xml-file', `${FIXTURES}/HB2-bill-text-pdf-only.xml`]);
    const result = await runMoHouse(client, args, {
      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml,
    });

    assert.equal(listCalls, 0);
    assert.equal(xmlCalls, 0);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.counts.bills_detailed, 1);
    assert.equal(result.counts.list_fetch_mode, 'fixture');
    assert.equal(result.counts.bills_listed, null);
    assert.equal(result.counts.total_pending_bills, null);
  });
});

// ---- the one-live-request-per-run invariant, named explicitly ----

test('runMoHouse: the one-live-request-per-run invariant — a multi-target scenario with a missing/stale list would have needed 2 live fetches under the old shape (list + bill); this run makes exactly 1 across ALL THREE live fetchers (list, bill XML, roll-call PDF)', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list'); // no cache at all -> stale/missing
    const rollcallDir = join(base, 'rollcalls');
    const { client } = makeFakeMoHouseRunClient();

    // Combined counter across ALL THREE live fetchers — the actual invariant under test. Routing
    // fetchRollCallPdf through the SAME counter (even though this scenario's fake `votes` table
    // has no pending PDF, so it never fires) makes the assertion airtight against a future
    // regression where a run somehow tried the PDF slot AND the list/bill-detail slot together.
    let liveFetchCount = 0;
    const fetchBillList = async () => { liveFetchCount += 1; return threeBillListXml; };
    const fetchBillXml = async () => { liveFetchCount += 1; return hb2Xml; };
    const fetchRollCallPdf = async () => { liveFetchCount += 1; return rollcallPdfBuffer; };

    const args = parseMoHouseArgs(['--limit', '1']);
    const result = await runMoHouse(client, args, {
      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml, fetchRollCallPdf,
    });

    assert.equal(liveFetchCount, 1, 'exactly one live house.mo.gov request this run, regardless of how many bills are pending or whether the list was also stale');
    assert.equal(result.status, 'succeeded');
  });
});

// ---- GAP 1 fast-follow (2026-08-01 review): the PDF-priority slot had zero test coverage —
// its one-request safety rested entirely on the reviewer's code-reading proof, not an executed
// test. These pin it directly, using the same real PDF fixture mo-rollcall-pdf.test.js already
// proves parses/reconciles cleanly, injected through the newly-added fetchRollCallPdf seam. ----

test('runMoHouse: PDF-PRIORITY slot — a pending roll-call PDF takes the slot with exactly ONE live request; neither list-refresh nor bill-detail fires in the same invocation', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list'); // empty -> would normally force slot (a) if reached
    const rollcallDir = join(base, 'rollcalls'); // scratch -> selectPendingPdf's existsSync/quarantine checks land here, not the real dir
    const { client, closeCalls, store } = makeFakeMoHouseRunClient();
    // A pending roll-call PDF: source_key matches the mo-house-xml-% prefix
    // listPendingRollCallPdfs scopes to, source_url is non-null (the RollCallPDF link), and no
    // vote_casts row exists yet for its vote_id — exactly what selectPendingPdf selects on.
    store.votes.push({ id: 'vote-1', source_key: 'mo-house-xml-HB9-1', source_url: 'https://documents.house.mo.gov/billtracking/bills261/rollcalls/034.008.pdf' });

    let listCalls = 0;
    let xmlCalls = 0;
    let pdfCalls = 0;
    const fetchBillList = async () => { listCalls += 1; throw new Error('must not fetch the list live — the PDF slot takes priority and returns before the list is ever consulted'); };
    const fetchBillXml = async () => { xmlCalls += 1; throw new Error('must not fetch a bill live — the PDF slot takes priority'); };
    const fetchRollCallPdf = async (url) => {
      pdfCalls += 1;
      assert.equal(url, 'https://documents.house.mo.gov/billtracking/bills261/rollcalls/034.008.pdf');
      return rollcallPdfBuffer;
    };

    const args = parseMoHouseArgs(['--limit', '1']);
    const result = await runMoHouse(client, args, {
      billsDir, billListDir, rollcallDir, fetchBillList, fetchBillXml, fetchRollCallPdf,
    });

    // (a) exactly one live request — the roll-call PDF, nothing else.
    assert.equal(pdfCalls, 1);
    assert.equal(listCalls, 0);
    assert.equal(xmlCalls, 0);
    // (b) neither the list-refresh nor the bill-detail slot ran this invocation — proven both by
    // the fetcher spies above (they'd have thrown) AND by the run's own detail shape, which stays
    // the pre-existing rollcall-pdf shape (no `slot`/list_fetch_mode field ever gets added to it).
    assert.equal(result.status, 'succeeded');
    assert.equal(result.counts.document_type, 'rollcall-pdf');
    assert.equal(result.counts.slot, undefined);
    assert.equal(result.counts.list_fetch_mode, undefined);
    assert.equal(closeCalls.length, 1);
    assert.equal(closeCalls[0].status, 'succeeded');
    assert.equal(closeCalls[0].detail.counts.document_type, 'rollcall-pdf');
    // The real fixture's known ground truth (task-4b-brief.md) — proves a REAL parse ran, not a
    // stub: 82/61/2 tallies, and with an empty legislators roster (persistRoster never runs on
    // this slot — see runMoHouse's own comment) every cast is honestly unresolved, never guessed.
    const { rollCallResult } = closeCalls[0].detail;
    assert.equal(rollCallResult.tallies.yes, 82);
    assert.equal(rollCallResult.tallies.no, 61);
    assert.equal(rollCallResult.castCount, 158);
    assert.equal(rollCallResult.resolved, 0);
    assert.equal(rollCallResult.unresolved, 158);
    assert.equal(existsSync(billListDir), false, 'no bill-list cache directory was ever created — the list slot never ran this invocation');
  });
});

// ---- GAP 2 fast-follow (2026-08-01 review): scripts/scheduled-ingest.js's moHouseWroteSomething
// predicate (already exported there — no changes to that file) was never pinned against the NEW
// run-detail shapes runMoHouse emits (list-refresh / bill-detail / honest-no-op) — exactly the
// LegiScan NEW-1 regression class (an unpinned predicate silently reading the wrong shape). These
// feed it the LITERAL detail runMoHouse just closed a real run with (closeCalls[0].detail — the
// exact object shape written to ingestion_runs.detail), never a hand-typed approximation, so a
// future field rename in either file breaks the test that actually connects them. ----

test('moHouseWroteSomething: fed the LITERAL list-refresh slot detail runMoHouse just emitted -> false (stub rows only, no bill was actually detailed)', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list'); // empty -> forces slot (a)
    const rollcallDir = join(base, 'rollcalls');
    const { client, closeCalls } = makeFakeMoHouseRunClient();

    const args = parseMoHouseArgs(['--limit', '1']);
    await runMoHouse(client, args, {
      billsDir,
      billListDir,
      rollcallDir,
      fetchBillList: async () => threeBillListXml,
      fetchBillXml: async () => { throw new Error('must not fetch a bill live — this is the list-refresh slot'); },
    });

    assert.equal(closeCalls.length, 1);
    assert.equal(closeCalls[0].detail.counts.slot, 'list-refresh', 'sanity: this really is the new slot this gap is about');
    assert.equal(
      moHouseWroteSomething(closeCalls[0].detail, closeCalls[0].status),
      false,
      'a list-refresh run only persists bill STUBS (title/status/canonical_url all null) — bills_detailed stays 0, so wroteSomething must be false',
    );
  });
});

test('moHouseWroteSomething: fed the LITERAL bill-detail slot detail runMoHouse just emitted with a real write -> true', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list');
    const rollcallDir = join(base, 'rollcalls');
    writeCachedBillList('261', [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }], billListDir); // fresh -> forces slot (b)
    const { client, closeCalls } = makeFakeMoHouseRunClient();

    const args = parseMoHouseArgs(['--limit', '1']);
    await runMoHouse(client, args, {
      billsDir,
      billListDir,
      rollcallDir,
      fetchBillList: async () => { throw new Error('must not fetch the list live — the cache is fresh'); },
      fetchBillXml: async () => hb2Xml,
    });

    assert.equal(closeCalls.length, 1);
    assert.equal(closeCalls[0].detail.counts.slot, 'bill-detail');
    assert.equal(closeCalls[0].detail.counts.bills_detailed, 1, 'sanity: a real bill actually got detailed this run');
    assert.equal(
      moHouseWroteSomething(closeCalls[0].detail, closeCalls[0].status),
      true,
      'bills_detailed:1 is a real write (title/status/canonical_url/actions/votes for an actual bill) — wroteSomething must be true',
    );
  });
});

test('moHouseWroteSomething: fed the LITERAL honest-no-op detail runMoHouse just emitted (nothing pending) -> false', async () => {
  await withScratchArtifactDirAsync(async (base) => {
    const billsDir = join(base, 'bills');
    const billListDir = join(base, 'bill-list');
    const rollcallDir = join(base, 'rollcalls');
    writeCachedBillList('261', [{ identifier: 'HB 2', bill_xml_url: 'https://x/HB2.xml' }], billListDir);
    writeEnrichedMarker('HB 2', {}, billsDir); // already enriched -> nothing pending
    const { client, closeCalls } = makeFakeMoHouseRunClient();

    const args = parseMoHouseArgs(['--limit', '1']);
    await runMoHouse(client, args, {
      billsDir,
      billListDir,
      rollcallDir,
      fetchBillList: async () => { throw new Error('must not fetch live'); },
      fetchBillXml: async () => { throw new Error('must not fetch live'); },
    });

    assert.equal(closeCalls.length, 1);
    assert.equal(closeCalls[0].detail.counts.slot, 'bill-detail');
    assert.equal(closeCalls[0].detail.counts.bills_detailed, 0, 'sanity: this really is the honest no-op — zero live requests, zero bills detailed');
    assert.equal(
      moHouseWroteSomething(closeCalls[0].detail, closeCalls[0].status),
      false,
      'an honest no-op (nothing pending) wrote nothing at all — wroteSomething must be false, never fail open just because status is succeeded',
    );
  });
});
