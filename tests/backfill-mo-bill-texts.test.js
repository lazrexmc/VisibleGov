import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  pickLatestTextEntry,
  pickLimiterForUrl,
  planBillTextWork,
  loadBillTextVersionIndex,
  loadPassageBillIds,
  fetchAndStoreMoBillText,
  runBackfillMoBillTexts,
  EmptyExtractionError,
} from '../src/cli/backfill-mo-bill-texts.js';
import { InvalidFlagValueError, SourceFetchError } from '../src/lib/errors.js';
import { OversizeTextError, MAX_TEXT_CHARS } from '../src/lib/summarizer.js';
import { normalizeBillIdentifier } from '../src/adapters/legiscan-dataset.js';
import { SOURCE as MO_HOUSE_SOURCE, moHouseLimiter } from '../src/adapters/mo-house-xml.js';
import { SOURCE as MO_SENATE_SOURCE, moSenateLimiter } from '../src/adapters/mo-senate-web.js';
import { listCachedDatasetFiles } from '../src/cli/backfill-nicknames.js';
import { readCachedDatasetBills } from '../src/cli/backfill-mo-bill-meta.js';

const REAL_CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';

// MO bill-text fetcher (.superpowers/sdd/2026-07-31-mo-bill-texts/brief.md): closes the bottleneck
// between VisibleGov's vote data and its plain-language summaries by fetching bill PDFs from the
// state's own official document servers (documents.house.mo.gov / senate.mo.gov), using ONLY the
// texts[].state_link already sitting in the 31 cached LegiScan dataset ZIPs — zero LegiScan API
// queries, zero model calls, zero live network in this test file (fake clients + injected fetch/
// extract functions throughout, per project law).

// ---- parseArgs ----

test('parseArgs defaults dryRun to false, limit/session to null', () => {
  const out = parseArgs([]);
  assert.equal(out.dryRun, false);
  assert.equal(out.limit, null);
  assert.equal(out.session, null);
});

test('parseArgs accepts --dry-run', () => {
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

test('parseArgs: --limit 12 works', () => {
  assert.equal(parseArgs(['--limit', '12']).limit, 12);
});

test('parseArgs: --limit 5O (letter O) throws InvalidFlagValueError, never silently "no limit"', () => {
  assert.throws(() => parseArgs(['--limit', '5O']), InvalidFlagValueError);
});

test('parseArgs: --limit 0 throws', () => {
  assert.throws(() => parseArgs(['--limit', '0']), InvalidFlagValueError);
});

test('parseArgs: --session 2239 works', () => {
  assert.equal(parseArgs(['--session', '2239']).session, 2239);
});

test('parseArgs: --session with a malformed value throws, never silently "all sessions"', () => {
  assert.throws(() => parseArgs(['--session', 'abc']), InvalidFlagValueError);
});

// ---- pickLatestTextEntry (version selection, v1 ruling) ----

test('pickLatestTextEntry: a single entry is returned as-is', () => {
  const entry = {
    doc_id: 1, date: '2025-12-01', type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/1.pdf',
  };
  assert.deepEqual(pickLatestTextEntry([entry]), entry);
});

test('pickLatestTextEntry: multi-entry, out-of-order dates — the latest date wins regardless of array order', () => {
  const older = {
    doc_id: 1, date: '2025-11-01', type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/1.pdf',
  };
  const newer = {
    doc_id: 2, date: '2025-12-15', type: 'Enrolled', mime: 'application/pdf', state_link: 'https://x/2.pdf',
  };
  const middle = {
    doc_id: 3, date: '2025-12-01', type: 'Engrossed', mime: 'application/pdf', state_link: 'https://x/3.pdf',
  };
  assert.deepEqual(pickLatestTextEntry([older, newer, middle]), newer);
  assert.deepEqual(pickLatestTextEntry([newer, middle, older]), newer);
});

test('pickLatestTextEntry: a date tie is broken by the HIGHER doc_id', () => {
  const a = {
    doc_id: 100, date: '2025-12-01', type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/a.pdf',
  };
  const b = {
    doc_id: 200, date: '2025-12-01', type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/b.pdf',
  };
  assert.deepEqual(pickLatestTextEntry([a, b]), b);
  assert.deepEqual(pickLatestTextEntry([b, a]), b);
});

test('pickLatestTextEntry: version is the selected entry\'s printed `type` string verbatim, never normalized', () => {
  const entry = {
    doc_id: 1, date: '2025-12-01', type: 'Conference Sub', mime: 'application/pdf', state_link: 'https://x/1.pdf',
  };
  assert.equal(pickLatestTextEntry([entry]).type, 'Conference Sub');
});

test('pickLatestTextEntry: empty or missing texts[] returns null, never throws', () => {
  assert.equal(pickLatestTextEntry([]), null);
  assert.equal(pickLatestTextEntry(undefined), null);
  assert.equal(pickLatestTextEntry(null), null);
});

// ---- pickLatestTextEntry: robust version selection (MED, code review — the reviewer's six
// constructions). Bug: `entry.date > best.date` is always false when EITHER side's date is
// null/undefined/non-ISO (JS `>` against a non-comparable value never succeeds), so a bad-date
// entry seen FIRST (arbitrary array order) could never be displaced by a later, perfectly good
// entry. A same-date tie was also broken by a bare `doc_id >`, wrong when doc_id is a string. ----

test('pickLatestTextEntry: a null-date entry seen FIRST is displaced by a later entry with a real date (the core bug — was: never displaced, every comparison against null is false)', () => {
  const badFirst = {
    doc_id: 1, date: null, type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/1.pdf',
  };
  const goodLater = {
    doc_id: 2, date: '2025-12-01', type: 'Enrolled', mime: 'application/pdf', state_link: 'https://x/2.pdf',
  };
  assert.deepEqual(pickLatestTextEntry([badFirst, goodLater]), goodLater);
});

test('pickLatestTextEntry: a null-date entry seen LATER never displaces an earlier real-dated entry (no regression from the fix)', () => {
  const good = {
    doc_id: 1, date: '2025-12-01', type: 'Enrolled', mime: 'application/pdf', state_link: 'https://x/1.pdf',
  };
  const badLater = {
    doc_id: 2, date: null, type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/2.pdf',
  };
  assert.deepEqual(pickLatestTextEntry([good, badLater]), good);
});

test('pickLatestTextEntry: an absent/missing `date` key (undefined, not just null) and a non-ISO string ("TBD") are BOTH treated as unusable, never win over a real date regardless of position', () => {
  const missingDate = {
    doc_id: 1, type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/1.pdf',
  }; // no `date` property at all
  const malformed = {
    doc_id: 2, date: 'TBD', type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/2.pdf',
  };
  const real = {
    doc_id: 3, date: '2025-06-01', type: 'Engrossed', mime: 'application/pdf', state_link: 'https://x/3.pdf',
  };
  assert.deepEqual(pickLatestTextEntry([missingDate, malformed, real]), real);
  assert.deepEqual(pickLatestTextEntry([real, malformed, missingDate]), real);
});

test('pickLatestTextEntry: when EVERY entry has an unusable date, falls back to the numeric doc_id tiebreak rather than throwing or picking arbitrarily', () => {
  const a = {
    doc_id: 5, date: null, type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/5.pdf',
  };
  const b = {
    doc_id: 9, date: undefined, type: 'Enrolled', mime: 'application/pdf', state_link: 'https://x/9.pdf',
  };
  assert.deepEqual(pickLatestTextEntry([a, b]), b);
  assert.deepEqual(pickLatestTextEntry([b, a]), b);
});

test('pickLatestTextEntry: a same-date tie with STRING doc_ids breaks NUMERICALLY, not lexicographically ("10" > "9" numerically, even though "10" < "9" as strings)', () => {
  const nine = {
    doc_id: '9', date: '2025-12-01', type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/9.pdf',
  };
  const ten = {
    doc_id: '10', date: '2025-12-01', type: 'Enrolled', mime: 'application/pdf', state_link: 'https://x/10.pdf',
  };
  assert.deepEqual(pickLatestTextEntry([nine, ten]), ten);
  assert.deepEqual(pickLatestTextEntry([ten, nine]), ten);
});

test('pickLatestTextEntry: a genuinely later ISO date wins even when its doc_id is numerically smaller than the earlier entry\'s (date always outranks doc_id when both dates are usable and distinct)', () => {
  const earlierHighId = {
    doc_id: 999, date: '2025-01-01', type: 'Introduced', mime: 'application/pdf', state_link: 'https://x/999.pdf',
  };
  const laterLowId = {
    doc_id: 1, date: '2025-12-01', type: 'Enrolled', mime: 'application/pdf', state_link: 'https://x/1.pdf',
  };
  assert.deepEqual(pickLatestTextEntry([earlierHighId, laterLowId]), laterLowId);
  assert.deepEqual(pickLatestTextEntry([laterLowId, earlierHighId]), laterLowId);
});

// ---- pickLimiterForUrl (politeness: reuse the SAME shared limiters mo-house-xml.js/
// mo-senate-web.js already established, not new ones — match their cadence) ----

test('pickLimiterForUrl: a documents.house.mo.gov URL resolves to the shared moHouseLimiter/SOURCE', () => {
  const result = pickLimiterForUrl('https://documents.house.mo.gov/billtracking/bills261/hlrbillspdf/5106H.01I.pdf');
  assert.equal(result.source, MO_HOUSE_SOURCE);
  assert.equal(result.limiter, moHouseLimiter);
});

test('pickLimiterForUrl: a www.senate.mo.gov URL resolves to the shared moSenateLimiter/SOURCE', () => {
  const result = pickLimiterForUrl('https://www.senate.mo.gov/18info/pdf-bill/E1/intro/SB1.pdf');
  assert.equal(result.source, MO_SENATE_SOURCE);
  assert.equal(result.limiter, moSenateLimiter);
});

test('pickLimiterForUrl: an unrecognized host throws a typed SourceFetchError, never fetches ungated', () => {
  assert.throws(() => pickLimiterForUrl('https://evil.example.com/x.pdf'), SourceFetchError);
});

test('pickLimiterForUrl: a malformed URL throws a typed SourceFetchError', () => {
  assert.throws(() => pickLimiterForUrl('not a url'), SourceFetchError);
});

// ---- planBillTextWork (pure — no I/O) ----

function moBill({
  billNumber, texts = [], billId = null,
}) {
  return { bill_number: billNumber, texts, __billId: billId };
}

function pdfEntry({
  docId, date, type, url = `https://documents.house.mo.gov/${docId}.pdf`,
}) {
  return {
    doc_id: docId, date, type, mime: 'application/pdf', mime_id: 2, state_link: url,
  };
}

test('planBillTextWork: an unmatched bill (no bills row for its session+identifier) -> billUnmatched, never added to toFetch', () => {
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }) }];
  const { counts, toFetch } = planBillTextWork(candidates, {
    billIndex: new Map(), textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(counts.billsSeen, 1);
  assert.equal(counts.billMatched, 0);
  assert.equal(counts.billUnmatched, 1);
  assert.deepEqual(toFetch, []);
});

test('planBillTextWork: a bill whose dataset session never resolved (sessionRowId null) is also billUnmatched, never guessed', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: null, bill: moBill({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }) }];
  const { counts, toFetch } = planBillTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(counts.billUnmatched, 1);
  assert.equal(counts.billMatched, 0);
  assert.deepEqual(toFetch, []);
});

test('planBillTextWork: a matched bill already carrying a bill_texts row for the selected version -> alreadyHasVersion, no fetch attempted', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const textVersionIndex = new Set(['bill-1|Introduced']);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }) }];
  const { counts, toFetch } = planBillTextWork(candidates, {
    billIndex, textVersionIndex, passageBillIds: new Set(),
  });
  assert.equal(counts.billMatched, 1);
  assert.equal(counts.alreadyHasVersion, 1);
  assert.deepEqual(toFetch, []);
});

test('planBillTextWork: a matched bill whose SELECTED (latest) entry is non-PDF -> skippedNonPdf, no fetch attempted', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const htmlEntry = {
    doc_id: 1, date: '2025-12-01', type: 'Introduced', mime: 'text/html', mime_id: 1, state_link: 'https://documents.house.mo.gov/1.htm',
  };
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [htmlEntry] }) }];
  const { counts, toFetch } = planBillTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(counts.billMatched, 1);
  assert.equal(counts.skippedNonPdf, 1);
  assert.deepEqual(toFetch, []);
});

test('planBillTextWork: a matched, not-yet-stored, PDF bill lands in toFetch carrying billId/identifier/version(verbatim)/url', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{
    sessionRowId: 'sess-1',
    bill: moBill({
      billNumber: 'HB1607',
      texts: [pdfEntry({
        docId: 1, date: '2025-12-01', type: 'Introduced', url: 'https://documents.house.mo.gov/billtracking/bills261/hlrbillspdf/5106H.01I.pdf',
      })],
    }),
  }];
  const { toFetch } = planBillTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(toFetch.length, 1);
  assert.deepEqual(toFetch[0], {
    billId: 'bill-1',
    identifier: normalizeBillIdentifier('HB1607'),
    version: 'Introduced',
    url: 'https://documents.house.mo.gov/billtracking/bills261/hlrbillspdf/5106H.01I.pdf',
    priority: 'other',
  });
});

test('planBillTextWork: version selection is applied BEFORE the mime gate — the LATEST entry is selected first, and only ITS mime is checked (an earlier PDF entry does not rescue a non-PDF latest entry)', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const olderPdf = pdfEntry({ docId: 1, date: '2025-11-01', type: 'Introduced' });
  const latestHtml = {
    doc_id: 2, date: '2025-12-01', type: 'Amended', mime: 'text/html', mime_id: 1, state_link: 'https://documents.house.mo.gov/2.htm',
  };
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [olderPdf, latestHtml] }) }];
  const { counts, toFetch } = planBillTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(counts.skippedNonPdf, 1);
  assert.deepEqual(toFetch, []);
});

test('planBillTextWork: a matched bill with NO text entries at all lands in the noTextEntry bucket (HIGH, code review — was: silently uncounted, billMatched never reconciled)', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [] }) }];
  const { counts, toFetch } = planBillTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(counts.billMatched, 1);
  assert.equal(counts.noTextEntry, 1);
  assert.deepEqual(toFetch, []);
});

test('planBillTextWork: a matched bill whose selected entry\'s state_link is a non-state host (the LegiScan reflect.legiscan.com/Proxy.php placeholder) is refused at PLANNING TIME as skippedNonStateHost — excluded from toFetch, never burns a --limit slot, never mislabeled fetchFailed (HIGH, code review)', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const placeholderEntry = pdfEntry({
    docId: 1, date: '2025-12-01', type: 'Introduced', url: 'http://reflect.legiscan.com/Proxy.php',
  });
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [placeholderEntry] }) }];
  const { counts, toFetch } = planBillTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(counts.billMatched, 1);
  assert.equal(counts.skippedNonStateHost, 1);
  assert.deepEqual(toFetch, []);
});

test('planBillTextWork: a matched bill whose selected entry resolves to a REAL state host (documents.house.mo.gov) is NOT refused — reaches toFetch normally', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }) }];
  const { counts, toFetch } = planBillTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(counts.skippedNonStateHost, 0);
  assert.equal(toFetch.length, 1);
});

test('planBillTextWork: reconciliation invariant — billMatched EXACTLY equals alreadyHasVersion + skippedNonPdf + noTextEntry + skippedNonStateHost + toFetch.length (a mixed batch exercising every bucket, nothing silently vanishes)', () => {
  const billIndex = new Map([
    [`sess-1|${normalizeBillIdentifier('HB1')}`, { id: 'bill-1' }], // -> alreadyHasVersion
    [`sess-1|${normalizeBillIdentifier('HB2')}`, { id: 'bill-2' }], // -> skippedNonPdf
    [`sess-1|${normalizeBillIdentifier('HB3')}`, { id: 'bill-3' }], // -> noTextEntry
    [`sess-1|${normalizeBillIdentifier('HB4')}`, { id: 'bill-4' }], // -> skippedNonStateHost
    [`sess-1|${normalizeBillIdentifier('HB5')}`, { id: 'bill-5' }], // -> toFetch
    // HB6 has no billIndex entry at all -> billUnmatched (outside the reconciliation equation)
  ]);
  const textVersionIndex = new Set(['bill-1|Introduced']);
  const candidates = [
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }) },
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB2', texts: [{ doc_id: 2, date: '2025-12-01', type: 'Introduced', mime: 'text/html', state_link: 'https://documents.house.mo.gov/2.htm' }] }) },
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB3', texts: [] }) },
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB4', texts: [pdfEntry({ docId: 4, date: '2025-12-01', type: 'Introduced', url: 'http://reflect.legiscan.com/Proxy.php' })] }) },
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB5', texts: [pdfEntry({ docId: 5, date: '2025-12-01', type: 'Introduced' })] }) },
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB6', texts: [pdfEntry({ docId: 6, date: '2025-12-01', type: 'Introduced' })] }) },
  ];
  const { counts, toFetch } = planBillTextWork(candidates, {
    billIndex, textVersionIndex, passageBillIds: new Set(),
  });
  assert.equal(counts.billsSeen, 6);
  assert.equal(counts.billUnmatched, 1);
  assert.equal(counts.alreadyHasVersion, 1);
  assert.equal(counts.skippedNonPdf, 1);
  assert.equal(counts.noTextEntry, 1);
  assert.equal(counts.skippedNonStateHost, 1);
  assert.equal(toFetch.length, 1);
  assert.equal(
    counts.billMatched,
    counts.alreadyHasVersion + counts.skippedNonPdf + counts.noTextEntry + counts.skippedNonStateHost + toFetch.length,
  );
});

test('planBillTextWork: passage-priority ordering — a bill carrying a passage/third-reading vote sorts ahead of a non-voted bill, regardless of input order; both counts reported', () => {
  const billIndexEntries = [
    [`sess-1|${normalizeBillIdentifier('HB1')}`, { id: 'bill-passage' }],
    [`sess-1|${normalizeBillIdentifier('HB2')}`, { id: 'bill-other' }],
  ];
  const billIndex = new Map(billIndexEntries);
  const candidates = [
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB2', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }) },
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1', texts: [pdfEntry({ docId: 2, date: '2025-12-01', type: 'Introduced' })] }) },
  ];
  const passageBillIds = new Set(['bill-passage']);
  const { toFetch, passagePriority } = planBillTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds,
  });
  assert.equal(toFetch.length, 2);
  assert.equal(toFetch[0].billId, 'bill-passage', 'the passage-vote bill sorts first even though HB2 (non-voted) appeared first in input order');
  assert.equal(toFetch[0].priority, 'passage');
  assert.equal(toFetch[1].billId, 'bill-other');
  assert.equal(toFetch[1].priority, 'other');
  assert.deepEqual(passagePriority, { passage: 1, other: 1 });
});

// ---- loadBillTextVersionIndex / loadPassageBillIds (selectAll-shaped fake client) ----

function makeSelectAllFakeClient(seed = {}) {
  const tables = { bill_texts: [], votes: [], ...seed };
  return {
    from(table) {
      return {
        select: () => ({
          order: () => ({
            range: async (from, to) => ({ data: tables[table].slice(from, to + 1).map((r) => ({ ...r })), error: null }),
          }),
        }),
      };
    },
  };
}

test('loadBillTextVersionIndex: builds a Set of "billId|version" from every existing bill_texts row', async () => {
  const client = makeSelectAllFakeClient({
    bill_texts: [
      { bill_id: 'bill-1', version: 'Introduced' },
      { bill_id: 'bill-1', version: 'Perfected' },
      { bill_id: 'bill-2', version: 'Introduced' },
    ],
  });
  const index = await loadBillTextVersionIndex(client);
  assert.equal(index.size, 3);
  assert.ok(index.has('bill-1|Introduced'));
  assert.ok(index.has('bill-1|Perfected'));
  assert.ok(index.has('bill-2|Introduced'));
  assert.equal(index.has('bill-2|Perfected'), false);
});

test('loadPassageBillIds: builds a Set of bill_id for every bill with at least one passage/third-reading vote, reusing summary-queue.js\'s own isPassageVote (not a re-derived regex)', async () => {
  const client = makeSelectAllFakeClient({
    votes: [
      { bill_id: 'bill-1', question: 'On the passage of the bill' },
      { bill_id: 'bill-2', question: 'On the motion to adopt the committee substitute' },
      { bill_id: 'bill-3', question: 'SBs 3rd READ - INFORMAL' },
      { bill_id: null, question: 'On passage' },
    ],
  });
  const ids = await loadPassageBillIds(client);
  assert.ok(ids.has('bill-1'));
  assert.ok(ids.has('bill-3'));
  assert.equal(ids.has('bill-2'), false);
  assert.equal(ids.size, 2);
});

// ---- fetchAndStoreMoBillText (fetch -> extract -> hash -> insert-if-absent, one unit) ----

function makeBillTextWriteClient({ rejectVersion = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        insert: (row) => {
          calls.push({ table, row });
          if (table === 'bill_texts' && rejectVersion && row.version === rejectVersion) {
            return Promise.resolve({
              error: { code: '23505', message: 'duplicate key value violates unique constraint "bill_texts_bill_id_version_key"' },
            });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const HOUSE_WORK = {
  billId: 'bill-1', identifier: 'HB 1607', version: 'Introduced', url: 'https://documents.house.mo.gov/billtracking/bills261/hlrbillspdf/5106H.01I.pdf',
};

test('fetchAndStoreMoBillText: happy path — fetches, extracts, hashes, and inserts a bill_texts row with source_url=state_link', async () => {
  const client = makeBillTextWriteClient();
  const result = await fetchAndStoreMoBillText(client, 'run-1', HOUSE_WORK, {
    fetchFn: async (url, opts) => {
      assert.equal(url, HOUSE_WORK.url);
      assert.equal(opts.source, MO_HOUSE_SOURCE);
      assert.equal(opts.as, 'arrayBuffer');
      return new TextEncoder().encode('Section 1. Hello world.').buffer;
    },
    extractFn: async () => 'Section 1. Hello world.',
  });
  assert.equal(result.outcome, 'inserted');
  assert.equal(client.calls.length, 1);
  const row = client.calls[0].row;
  assert.equal(row.bill_id, 'bill-1');
  assert.equal(row.version, 'Introduced');
  assert.equal(row.content, 'Section 1. Hello world.');
  assert.match(row.content_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.source_url, HOUSE_WORK.url);
  assert.equal(row.run_id, 'run-1');
  assert.ok(row.retrieved_at);
});

test('fetchAndStoreMoBillText: oversize extraction throws OversizeTextError and never reaches the DB — never truncated', async () => {
  const client = makeBillTextWriteClient();
  await assert.rejects(
    () => fetchAndStoreMoBillText(client, 'run-1', HOUSE_WORK, {
      fetchFn: async () => new ArrayBuffer(10),
      extractFn: async () => 'x'.repeat(MAX_TEXT_CHARS + 1),
    }),
    (err) => err instanceof OversizeTextError,
  );
  assert.deepEqual(client.calls, []);
});

test('fetchAndStoreMoBillText: an extraction that yields zero characters throws EmptyExtractionError and never reaches the DB', async () => {
  const client = makeBillTextWriteClient();
  await assert.rejects(
    () => fetchAndStoreMoBillText(client, 'run-1', HOUSE_WORK, {
      fetchFn: async () => new ArrayBuffer(10),
      extractFn: async () => '   \n\n  ',
    }),
    (err) => err instanceof EmptyExtractionError,
  );
  assert.deepEqual(client.calls, []);
});

test('fetchAndStoreMoBillText: a PDF parse exception (corrupted bytes despite a 200 response) is folded into EmptyExtractionError — "fetched, but no usable text resulted"', async () => {
  const client = makeBillTextWriteClient();
  await assert.rejects(
    () => fetchAndStoreMoBillText(client, 'run-1', HOUSE_WORK, {
      fetchFn: async () => new ArrayBuffer(10),
      extractFn: async () => { throw new Error('bad XRef entry'); },
    }),
    (err) => err instanceof EmptyExtractionError,
  );
  assert.deepEqual(client.calls, []);
});

test('fetchAndStoreMoBillText: an empty response body throws a typed SourceFetchError, never reaches extraction or the DB', async () => {
  const client = makeBillTextWriteClient();
  let extractCalled = false;
  await assert.rejects(
    () => fetchAndStoreMoBillText(client, 'run-1', HOUSE_WORK, {
      fetchFn: async () => new ArrayBuffer(0),
      extractFn: async () => { extractCalled = true; return 'text'; },
    }),
    (err) => err instanceof SourceFetchError,
  );
  assert.equal(extractCalled, false);
  assert.deepEqual(client.calls, []);
});

test('fetchAndStoreMoBillText: a non-200 fetch failure propagates as the SAME typed SourceFetchError the injected fetchFn threw, run continues at the caller level', async () => {
  const client = makeBillTextWriteClient();
  await assert.rejects(
    () => fetchAndStoreMoBillText(client, 'run-1', HOUSE_WORK, {
      fetchFn: async () => { throw new SourceFetchError('HTTP 404 from mo-house-xml', { status: 404 }); },
      extractFn: async () => 'unreachable',
    }),
    (err) => err instanceof SourceFetchError,
  );
  assert.deepEqual(client.calls, []);
});

test('fetchAndStoreMoBillText: a 23505 on insert (a genuine concurrent-write race the pre-fetch DB-keyed check missed) is tolerated as alreadyPresent, never fatal', async () => {
  const client = makeBillTextWriteClient({ rejectVersion: 'Introduced' });
  const result = await fetchAndStoreMoBillText(client, 'run-1', HOUSE_WORK, {
    fetchFn: async () => new TextEncoder().encode('Section 1.').buffer,
    extractFn: async () => 'Section 1.',
  });
  assert.equal(result.outcome, 'alreadyPresent');
});

test('fetchAndStoreMoBillText: an unrelated DB error is thrown, never silently swallowed', async () => {
  const client = {
    from: () => ({
      insert: async () => ({ error: { code: '500', message: 'connection reset' } }),
    }),
  };
  await assert.rejects(
    () => fetchAndStoreMoBillText(client, 'run-1', HOUSE_WORK, {
      fetchFn: async () => new TextEncoder().encode('Section 1.').buffer,
      extractFn: async () => 'Section 1.',
    }),
    /connection reset/,
  );
});

// ---- runBackfillMoBillTexts: orchestration ----

function fakeDataset({ sessionId, bills }) {
  return { ok: true, sessionId, bills };
}

function billFixture({ billNumber, texts }) {
  return { bill_number: billNumber, texts };
}

function makeFakeWriteClient() {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        insert: (row) => {
          calls.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const baseLoaders = () => ({
  loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
  loadBillIndexFn: async () => new Map([[`sess-1608|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1', status: null }]]),
  loadTextVersionIndexFn: async () => new Set(),
  loadPassageBillIdsFn: async () => new Set(),
});

test('runBackfillMoBillTexts: --dry-run performs zero fetches and zero writes, and reports every count it can know without fetching', async () => {
  const client = makeFakeWriteClient();
  let fetchTextCalled = false;
  const files = ['a.json'];
  const report = await runBackfillMoBillTexts(client, {
    dryRun: true,
    listFilesFn: () => files,
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
    }),
    ...baseLoaders(),
    fetchTextFn: async () => { fetchTextCalled = true; return { outcome: 'inserted' }; },
  });

  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.counts, {
    datasetsRead: 1,
    datasetsMissing: 0,
    billsSeen: 1,
    billMatched: 1,
    billUnmatched: 0,
    noTextEntry: 0,
    alreadyHasVersion: 0,
    skippedNonPdf: 0,
    skippedNonStateHost: 0,
    fetched: 0,
    fetchFailed: 0,
    extractEmpty: 0,
    oversizeRefused: 0,
    inserted: 0,
    alreadyPresent: 0,
  });
  assert.deepEqual(report.passagePriority, { passage: 0, other: 1 });
  assert.equal(fetchTextCalled, false, 'dry-run performs zero fetches');
  assert.deepEqual(client.calls, [], 'dry-run performs zero writes');
});

test('runBackfillMoBillTexts: live mode happy path — a matched PDF bill is fetched, extracted, and inserted', async () => {
  const client = makeFakeWriteClient();
  const files = ['a.json'];
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => files,
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
    }),
    ...baseLoaders(),
    fetchTextFn: async () => ({ outcome: 'inserted' }),
  });
  assert.equal(report.mode, 'live');
  assert.equal(report.counts.fetched, 1);
  assert.equal(report.counts.inserted, 1);
  assert.equal(report.counts.fetchFailed, 0);
  assert.deepEqual(report.failures, []);
});

test('runBackfillMoBillTexts: an unmatched bill is billUnmatched and never reaches fetchTextFn', async () => {
  const client = makeFakeWriteClient();
  let fetchCalls = 0;
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({ billNumber: 'HB9999', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
    }),
    ...baseLoaders(),
    fetchTextFn: async () => { fetchCalls += 1; return { outcome: 'inserted' }; },
  });
  assert.equal(report.counts.billUnmatched, 1);
  assert.equal(fetchCalls, 0);
});

test('runBackfillMoBillTexts: a bill already carrying the selected version is alreadyHasVersion, never fetched', async () => {
  const client = makeFakeWriteClient();
  let fetchCalls = 0;
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
    }),
    loadSessionIndexFn: baseLoaders().loadSessionIndexFn,
    loadBillIndexFn: baseLoaders().loadBillIndexFn,
    loadTextVersionIndexFn: async () => new Set(['bill-1|Introduced']),
    loadPassageBillIdsFn: baseLoaders().loadPassageBillIdsFn,
    fetchTextFn: async () => { fetchCalls += 1; return { outcome: 'inserted' }; },
  });
  assert.equal(report.counts.alreadyHasVersion, 1);
  assert.equal(fetchCalls, 0);
});

test('runBackfillMoBillTexts: a non-PDF selected version is skippedNonPdf, never fetched (HTML is a later task)', async () => {
  const client = makeFakeWriteClient();
  let fetchCalls = 0;
  const htmlEntry = {
    doc_id: 1, date: '2025-12-01', type: 'Introduced', mime: 'text/html', mime_id: 1, state_link: 'https://documents.house.mo.gov/1.htm',
  };
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({ sessionId: 1608, bills: [billFixture({ billNumber: 'HB1607', texts: [htmlEntry] })] }),
    ...baseLoaders(),
    fetchTextFn: async () => { fetchCalls += 1; return { outcome: 'inserted' }; },
  });
  assert.equal(report.counts.skippedNonPdf, 1);
  assert.equal(fetchCalls, 0);
});

test('runBackfillMoBillTexts: oversize extraction is counted oversizeRefused, nothing stored, run continues', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
    }),
    ...baseLoaders(),
    fetchTextFn: async () => { throw new OversizeTextError('too big', { identifier: 'HB 1607', length: 999999 }); },
  });
  assert.equal(report.counts.oversizeRefused, 1);
  assert.equal(report.counts.fetched, 1, 'the fetch itself succeeded; only the content-quality gate refused it');
  assert.equal(report.counts.inserted, 0);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].step, 'oversize');
  assert.deepEqual(client.calls, []);
});

test('runBackfillMoBillTexts: empty extraction is counted extractEmpty, nothing stored; failures[].step is "extract" by default when the thrown error carries no step meta', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
    }),
    ...baseLoaders(),
    fetchTextFn: async () => { throw new EmptyExtractionError('zero chars', { identifier: 'HB 1607' }); },
  });
  assert.equal(report.counts.extractEmpty, 1);
  assert.equal(report.counts.inserted, 0);
  assert.equal(report.failures[0].step, 'extract');
  assert.deepEqual(client.calls, []);
});

// FIX (MED, code review): failures[].step used to collapse a raw pdfjs PARSE exception (corrupted/
// non-PDF bytes) and a legitimately-EMPTY text layer into the SAME 'extract' string — an operator
// reading failures[] could not tell "this PDF is corrupt" from "this PDF genuinely has no text
// layer." Both still count as extractEmpty (no 14th count field — the fix is to failures[].step
// only), driven end-to-end here through the REAL fetchAndStoreMoBillText (not a stubbed fetchTextFn)
// so the step actually reaches runBackfillMoBillTexts's catch via err.step, proving the wiring.
test('runBackfillMoBillTexts: failures[].step differentiates "parse" (a raw pdfjs exception on corrupted bytes) from "extract" (a legitimately empty text layer) — both still count as extractEmpty', async () => {
  const client = makeFakeWriteClient();
  const reportParse = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
    }),
    ...baseLoaders(),
    fetchTextFn: (c, runId, work) => fetchAndStoreMoBillText(c, runId, work, {
      fetchFn: async () => new ArrayBuffer(10),
      extractFn: async () => { throw new Error('bad XRef entry'); }, // real pdfjs-style parse exception
    }),
  });
  assert.equal(reportParse.counts.extractEmpty, 1);
  assert.equal(reportParse.failures[0].step, 'parse');

  const client2 = makeFakeWriteClient();
  const reportEmpty = await runBackfillMoBillTexts(client2, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
    }),
    ...baseLoaders(),
    fetchTextFn: (c, runId, work) => fetchAndStoreMoBillText(c, runId, work, {
      fetchFn: async () => new ArrayBuffer(10),
      extractFn: async () => '   \n\n  ', // parses fine, zero usable characters
    }),
  });
  assert.equal(reportEmpty.counts.extractEmpty, 1);
  assert.equal(reportEmpty.failures[0].step, 'extract');
});

test('runBackfillMoBillTexts: failures[] entries carry billId and url alongside identifier (identifier alone repeats across the 31 cached sessions)', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({
        billNumber: 'HB1607',
        texts: [pdfEntry({
          docId: 1, date: '2025-12-01', type: 'Introduced', url: 'https://documents.house.mo.gov/billtracking/bills261/hlrbillspdf/5106H.01I.pdf',
        })],
      })],
    }),
    ...baseLoaders(),
    fetchTextFn: async () => { throw new SourceFetchError('HTTP 404', { status: 404 }); },
  });
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].billId, 'bill-1');
  assert.equal(report.failures[0].url, 'https://documents.house.mo.gov/billtracking/bills261/hlrbillspdf/5106H.01I.pdf');
});

test('runBackfillMoBillTexts: a fetch non-200 is a counted failure (fetchFailed); the run continues to the next bill; nothing is stored for the failed one', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [
        billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }),
        billFixture({ billNumber: 'HB1608', texts: [pdfEntry({ docId: 2, date: '2025-12-01', type: 'Introduced' })] }),
      ],
    }),
    loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
    loadBillIndexFn: async () => new Map([
      [`sess-1608|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }],
      [`sess-1608|${normalizeBillIdentifier('HB1608')}`, { id: 'bill-2' }],
    ]),
    loadTextVersionIndexFn: async () => new Set(),
    loadPassageBillIdsFn: async () => new Set(),
    fetchTextFn: async (client_, runId, work) => {
      if (work.identifier === normalizeBillIdentifier('HB1607')) {
        throw new SourceFetchError('HTTP 404 from mo-house-xml', { status: 404 });
      }
      return { outcome: 'inserted' };
    },
  });
  assert.equal(report.counts.fetchFailed, 1);
  assert.equal(report.counts.inserted, 1, 'the SECOND bill still processed — one failure does not abort the run');
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].step, 'fetch');
  assert.equal(report.failures[0].identifier, normalizeBillIdentifier('HB1607'));
});

test('runBackfillMoBillTexts: a 23505 race on insert is tolerated as alreadyPresent, never fatal, run continues', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
    }),
    ...baseLoaders(),
    fetchTextFn: async () => ({ outcome: 'alreadyPresent' }),
  });
  assert.equal(report.counts.alreadyPresent, 1);
  assert.equal(report.counts.inserted, 0);
  assert.equal(report.counts.fetched, 1);
});

test('runBackfillMoBillTexts: --limit 12 slices the (priority-sorted) worklist actually processed', async () => {
  const client = makeFakeWriteClient();
  const bills = Array.from({ length: 20 }, (_, i) => billFixture({
    billNumber: `HB${i + 1}`, texts: [pdfEntry({ docId: i + 1, date: '2025-12-01', type: 'Introduced' })],
  }));
  const billIndex = new Map(bills.map((b, i) => [`sess-1608|${normalizeBillIdentifier(b.bill_number)}`, { id: `bill-${i + 1}` }]));
  let calls = 0;
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    limit: 12,
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({ sessionId: 1608, bills }),
    loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
    loadBillIndexFn: async () => billIndex,
    loadTextVersionIndexFn: async () => new Set(),
    loadPassageBillIdsFn: async () => new Set(),
    fetchTextFn: async () => { calls += 1; return { outcome: 'inserted' }; },
  });
  assert.equal(calls, 12);
  assert.equal(report.counts.inserted, 12);
  assert.equal(report.counts.billMatched, 20, 'the plan still saw all 20 — only the processing loop was capped');
});

test('runBackfillMoBillTexts: a missing/corrupt cache file is skipped with an honest datasetsMissing count — skip != empty, the other dataset still processes', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => ['good.json', 'bad.json'],
    readDatasetFn: async (filePath) => {
      if (filePath === 'good.json') {
        return fakeDataset({
          sessionId: 1608,
          bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
        });
      }
      return { ok: false, filePath };
    },
    ...baseLoaders(),
    fetchTextFn: async () => ({ outcome: 'inserted' }),
  });
  assert.equal(report.counts.datasetsRead, 1);
  assert.equal(report.counts.datasetsMissing, 1);
  assert.equal(report.counts.inserted, 1, 'the good dataset still fully processed');
});

test('runBackfillMoBillTexts: --session filters to only the matching cached dataset file, by its documented ${legiscanSessionId}-${hash}.json naming convention', async () => {
  const client = makeFakeWriteClient();
  const readCalls = [];
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    session: 1608,
    listFilesFn: () => ['1579-aaa.json', '1608-bbb.json', '2239-ccc.json'],
    readDatasetFn: async (filePath) => {
      readCalls.push(filePath);
      return fakeDataset({
        sessionId: 1608,
        bills: [billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] })],
      });
    },
    ...baseLoaders(),
    fetchTextFn: async () => ({ outcome: 'inserted' }),
  });
  assert.deepEqual(readCalls, ['1608-bbb.json'], 'only the session-1608 file was ever read');
  assert.equal(report.counts.datasetsRead, 1);
  assert.equal(report.sessionUncached, false, 'a session that DID match a cached file is honestly reported as not-uncached');
});

// FIX (LOW, code review): --session <a legiscan_session_id with no matching cached file at all>
// used to fall straight through to an all-zero report — mechanically indistinguishable from "the
// session was found and genuinely had zero bills." sessionUncached makes that distinction honest.
test('runBackfillMoBillTexts: --session <not cached> reports sessionUncached:true rather than a silently indistinguishable all-zero report', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    session: 9999,
    listFilesFn: () => ['1579-aaa.json', '1608-bbb.json'],
    readDatasetFn: async () => { throw new Error('must never read a dataset file — no file matches session 9999'); },
    ...baseLoaders(),
    fetchTextFn: async () => ({ outcome: 'inserted' }),
  });
  assert.equal(report.sessionUncached, true);
  assert.equal(report.counts.datasetsRead, 0);
  assert.equal(report.counts.billsSeen, 0);
});

test('runBackfillMoBillTexts: --session omitted entirely reports sessionUncached:false (not applicable, never a false positive)', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: true,
    listFilesFn: () => [],
    ...baseLoaders(),
  });
  assert.equal(report.sessionUncached, false);
});

test('runBackfillMoBillTexts: passagePriority breakdown is reported in BOTH dry-run and live mode', async () => {
  const passageIds = new Set(['bill-1']);
  const deps = {
    listFilesFn: () => ['a.json'],
    readDatasetFn: async () => fakeDataset({
      sessionId: 1608,
      bills: [
        billFixture({ billNumber: 'HB1607', texts: [pdfEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }),
        billFixture({ billNumber: 'HB1608', texts: [pdfEntry({ docId: 2, date: '2025-12-01', type: 'Introduced' })] }),
      ],
    }),
    loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
    loadBillIndexFn: async () => new Map([
      [`sess-1608|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }],
      [`sess-1608|${normalizeBillIdentifier('HB1608')}`, { id: 'bill-2' }],
    ]),
    loadTextVersionIndexFn: async () => new Set(),
    loadPassageBillIdsFn: async () => passageIds,
    fetchTextFn: async () => ({ outcome: 'inserted' }),
  };

  const dryReport = await runBackfillMoBillTexts(makeFakeWriteClient(), { dryRun: true, ...deps });
  assert.deepEqual(dryReport.passagePriority, { passage: 1, other: 1 });

  const liveReport = await runBackfillMoBillTexts(makeFakeWriteClient(), { dryRun: false, runId: 'run-1', ...deps });
  assert.deepEqual(liveReport.passagePriority, { passage: 1, other: 1 });
});

// ---- real end-to-end file decode (no live DB, no live fetch — empty index maps, just proving the
// FILE side of the pipeline against the actual 31 cached archives; mirrors backfill-mo-bill-meta-
// cli.test.js's own precedent for the same real cache dir) ----

test('runBackfillMoBillTexts: real cache dir end-to-end file decode — every one of the 31 real cached archives decodes cleanly, billsSeen > 0, zero API queries, zero fetches, zero writes (empty session index -> nothing resolves deeper)', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    cacheDir: REAL_CACHE_DIR,
    loadSessionIndexFn: async () => new Map(),
    loadBillIndexFn: async () => new Map(),
    loadTextVersionIndexFn: async () => new Set(),
    loadPassageBillIdsFn: async () => new Set(),
  });
  // Not hardcoded to a fixed file count — LegiScan datasets refresh weekly and this real cache dir
  // grows over time (32 as of 2026-08-03, up from 31 at task-writing time).
  assert.equal(report.counts.datasetsRead, listCachedDatasetFiles(REAL_CACHE_DIR).length);
  assert.equal(report.counts.datasetsMissing, 0);
  assert.ok(report.counts.billsSeen > 0);
  assert.equal(report.counts.billUnmatched, report.counts.billsSeen, 'empty session index: every bill goes unmatched, nothing deeper is ever attempted');
  assert.equal(report.counts.billMatched, 0);
  assert.equal(report.counts.fetched, 0);
  assert.deepEqual(client.calls, []);
});

// FIX (HIGH, code review): a matched bill with an empty/absent texts[] used to fall through
// `if (!entry) continue;` uncounted — 252 real bills in the live 31-session corpus do exactly
// this — so billMatched never reconciled against its own sub-buckets. This test builds a
// self-consistent synthetic session/bill index FROM the real corpus itself (every real bill
// resolves — no live DB needed) so the reconciliation equation is exercised on the actual data
// shape, not a hand-picked toy case, and pins the corpus's own known noTextEntry/
// skippedNonStateHost counts (independently verified against the raw cache: 252 bills with no
// text entries at all; 2,202 bills whose selected PDF entry points at one of two LegiScan-hosted
// placeholder hosts — reflect.legiscan.com/Proxy.php x2,177, proxy2.legiscan.com/Proxy.php x25 —
// neither is a real state document server).
test('runBackfillMoBillTexts: real cache dir RECONCILIATION — billMatched EXACTLY equals alreadyHasVersion + skippedNonPdf + noTextEntry + skippedNonStateHost + toFetch.length over the full real 31-session corpus; noTextEntry pins the known 252; skippedNonStateHost is visible in --dry-run', async () => {
  const files = listCachedDatasetFiles(REAL_CACHE_DIR);
  const sessionIndex = new Map();
  const billIndex = new Map();
  let nextSessionRowId = 1;
  let nextBillRowId = 1;
  for (const filePath of files) {
    // eslint-disable-next-line no-await-in-loop -- one-time synthetic-index build over 31 files, test setup only
    const decoded = await readCachedDatasetBills(filePath);
    if (!decoded.ok) continue;
    if (!sessionIndex.has(decoded.sessionId)) {
      sessionIndex.set(decoded.sessionId, { id: `sess-${nextSessionRowId}` });
      nextSessionRowId += 1;
    }
    const sessionRowId = sessionIndex.get(decoded.sessionId).id;
    for (const bill of decoded.bills) {
      const key = `${sessionRowId}|${normalizeBillIdentifier(bill.bill_number)}`;
      if (!billIndex.has(key)) {
        billIndex.set(key, { id: `bill-${nextBillRowId}` });
        nextBillRowId += 1;
      }
    }
  }

  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: true, // zero live fetches — we only need the PLAN's counts, per this file's own $0-network law
    cacheDir: REAL_CACHE_DIR,
    loadSessionIndexFn: async () => sessionIndex,
    loadBillIndexFn: async () => billIndex,
    loadTextVersionIndexFn: async () => new Set(),
    loadPassageBillIdsFn: async () => new Set(),
  });

  assert.equal(report.counts.billUnmatched, 0, 'the synthetic index resolves every real bill in the corpus');
  assert.equal(report.counts.noTextEntry, 252, 'known real-corpus count of bills with an empty/absent texts[]');
  assert.equal(report.counts.skippedNonStateHost, 2202, 'known real-corpus count of LegiScan-placeholder-hosted selected entries (2,177 reflect.legiscan.com + 25 proxy2.legiscan.com)');
  assert.equal(
    report.counts.billMatched,
    report.counts.alreadyHasVersion + report.counts.skippedNonPdf + report.counts.noTextEntry + report.counts.skippedNonStateHost + report.toProcessCount,
    'every one of the corpus\'s real matched bills is accounted for by exactly one bucket',
  );
});

test('runBackfillMoBillTexts: zero cache files found -> all-zero counts, no client calls, never fetches', async () => {
  const client = makeFakeWriteClient();
  const report = await runBackfillMoBillTexts(client, {
    dryRun: false,
    runId: 'run-1',
    listFilesFn: () => [],
    ...baseLoaders(),
    fetchTextFn: async () => ({ outcome: 'inserted' }),
  });
  assert.deepEqual(report.counts, {
    datasetsRead: 0,
    datasetsMissing: 0,
    billsSeen: 0,
    billMatched: 0,
    billUnmatched: 0,
    noTextEntry: 0,
    alreadyHasVersion: 0,
    skippedNonPdf: 0,
    skippedNonStateHost: 0,
    fetched: 0,
    fetchFailed: 0,
    extractEmpty: 0,
    oversizeRefused: 0,
    inserted: 0,
    alreadyPresent: 0,
  });
  assert.deepEqual(client.calls, []);
});
