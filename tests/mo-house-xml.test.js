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
