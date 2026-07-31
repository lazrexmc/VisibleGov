import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  planLegiscanTextWork,
  decodeBillTextDoc,
  resolveTextSourceUrl,
  runIngestLegiscanTexts,
  buildAbortCloseDetail,
  closeRunOnAbort,
  computeLiveRunStatus,
  BillTextDecodeError,
} from '../src/cli/ingest-legiscan-texts.js';
import { InvalidFlagValueError, SourceFetchError, RateLimitedError } from '../src/lib/errors.js';
import { OversizeTextError, MAX_TEXT_CHARS } from '../src/lib/summarizer.js';
import { EmptyExtractionError } from '../src/cli/backfill-mo-bill-texts.js';
import { normalizeBillIdentifier } from '../src/adapters/legiscan-dataset.js';
import { QueryBudgetExceededError, LegiScanApiError, SOURCE } from '../src/adapters/legiscan.js';
import { closeRun } from '../src/lib/db.js';

// LegiScan getBillText volume path (.superpowers/sdd/2026-07-31-legiscan-bill-text/brief.md).
// EXACTLY ONE live LegiScan query was permitted for this whole task and was already spent capturing
// tests/fixtures/research/legiscan/mo-2018-SB894-billtext-1680835.json (doc_id 1680835, real MO
// SB894 "Introduced" text) — every test below is a fake client / injected function, zero live
// network, zero live DB, per project law.

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-legiscan-texts-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withScratchDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-legiscan-texts-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- real fixture: the ONE probe (shape ground truth) ----

const REAL_BILLTEXT = JSON.parse(
  readFileSync('tests/fixtures/research/legiscan/mo-2018-SB894-billtext-1680835.json', 'utf8'),
).text;

// A small, self-contained valid PDF-shaped base64 blob (not the real truncated fixture's — that one
// is deliberately incomplete/truncated for fixture size, not decodable end-to-end). `doc` only needs
// to survive Buffer.from(..., 'base64') with a non-empty result for decode tests that don't also
// exercise extractPdfText (extractFn is always injected in these tests, never the real pdfjs parse).
function billTextPayload({
  docId = 1680835,
  billId = 1050440,
  type = 'Introduced',
  mime = 'application/pdf',
  doc = 'JVBERi0xLjQNCg==',
  url = `https://legiscan.com/MO/text/SB894/id/${docId}`,
  stateLink = 'https://www.senate.mo.gov/18info/pdf-bill/intro/SB894.pdf',
} = {}) {
  return {
    doc_id: docId, bill_id: billId, date: '2018-01-10', type, type_id: 1, mime, mime_id: 2,
    url, state_link: stateLink, text_size: 130829, text_hash: 'f1b2c358cf394ff59ba9b10c3f58ed41', doc,
  };
}

// ---- parseArgs ----

test('parseArgs defaults: dryRun false, limit/session null, priorityOnly false', () => {
  const out = parseArgs([]);
  assert.deepEqual(out, {
    dryRun: false, limit: null, session: null, priorityOnly: false,
  });
});

test('parseArgs accepts --dry-run and --priority-only as bare flags', () => {
  const out = parseArgs(['--dry-run', '--priority-only']);
  assert.equal(out.dryRun, true);
  assert.equal(out.priorityOnly, true);
});

test('parseArgs: --limit N and --session N both parse as positive integers', () => {
  const out = parseArgs(['--limit', '10', '--session', '2239']);
  assert.equal(out.limit, 10);
  assert.equal(out.session, 2239);
});

test('parseArgs: --limit uses the shared fail-loud positive-integer validation — malformed throws', () => {
  assert.throws(() => parseArgs(['--limit', '5O']), InvalidFlagValueError);
  assert.throws(() => parseArgs(['--limit', '0']), InvalidFlagValueError);
  assert.throws(() => parseArgs(['--limit']), InvalidFlagValueError);
});

test('parseArgs: --session uses the same fail-loud positive-integer validation', () => {
  assert.throws(() => parseArgs(['--session', 'abc']), InvalidFlagValueError);
});

test('parseArgs: rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

// ---- decodeBillTextDoc (base64 decode, typed failure) ----

test('decodeBillTextDoc: decodes a real-shaped base64 doc field to a non-empty Buffer', () => {
  const buf = decodeBillTextDoc(billTextPayload({ doc: 'JVBERi0xLjQNCg==' }));
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 0);
});

test('decodeBillTextDoc: a missing `doc` field throws BillTextDecodeError, never a bare crash', () => {
  const { doc, ...rest } = billTextPayload();
  assert.throws(() => decodeBillTextDoc(rest), BillTextDecodeError);
});

test('decodeBillTextDoc: an empty-string `doc` field throws BillTextDecodeError', () => {
  assert.throws(() => decodeBillTextDoc(billTextPayload({ doc: '' })), BillTextDecodeError);
});

test('decodeBillTextDoc: a whitespace-only `doc` field throws BillTextDecodeError (decodes to zero usable bytes)', () => {
  assert.throws(() => decodeBillTextDoc(billTextPayload({ doc: '   ' })), BillTextDecodeError);
});

// ---- resolveTextSourceUrl (provenance: prefer the real state host, else LegiScan's own printed url) ----

test('resolveTextSourceUrl: a real house.mo.gov-family state_link is preferred', () => {
  const text = billTextPayload({ stateLink: 'https://documents.house.mo.gov/billtracking/bills261/x.pdf' });
  assert.equal(resolveTextSourceUrl(text), text.state_link);
});

test('resolveTextSourceUrl: a real senate.mo.gov-family state_link is preferred', () => {
  const text = billTextPayload({ stateLink: 'https://www.senate.mo.gov/18info/pdf-bill/intro/SB894.pdf' });
  assert.equal(resolveTextSourceUrl(text), text.state_link);
});

test('resolveTextSourceUrl: a LegiScan proxy-placeholder state_link falls back to the response\'s OWN printed `url` field, never hand-constructed', () => {
  const text = billTextPayload({ stateLink: 'http://reflect.legiscan.com/Proxy.php', url: 'https://legiscan.com/MO/text/SB894/id/1680835' });
  assert.equal(resolveTextSourceUrl(text), 'https://legiscan.com/MO/text/SB894/id/1680835');
});

test('resolveTextSourceUrl: a malformed state_link URL also falls back to `url`, never throws', () => {
  const text = billTextPayload({ stateLink: 'not a url', url: 'https://legiscan.com/MO/text/SB894/id/1680835' });
  assert.equal(resolveTextSourceUrl(text), text.url);
});

test('resolveTextSourceUrl: real ONE-probe fixture resolves to its own real state_link (senate.mo.gov)', () => {
  assert.equal(resolveTextSourceUrl(REAL_BILLTEXT), REAL_BILLTEXT.state_link);
});

// ---- planLegiscanTextWork (pure planning: cached-dataset bills -> doc_id worklist. Per MED-1
// (controller ruling, fix-round review, corpus-verified): the mime gate IS restored here (0 of
// 2,202 real proxy-placeholder targets are non-PDF; all 6,225 text/html bills sit on state hosts
// the sibling CLI can already reach). The state-HOST gate stays dropped — the doc_id is all that
// matters for a proxy-placeholder state_link. ----

// billId defaults to 1050440 to match billTextPayload()'s own default `billId` — every test not
// specifically exercising HIGH-2 (identity mismatch) gets a naturally-matching legiscanBillId
// without having to say so.
function moBill({ billNumber, texts = [], billId = 1050440 }) {
  return { bill_number: billNumber, bill_id: billId, texts };
}

function textEntry({
  docId, date, type, mime = 'application/pdf', stateLink = `https://documents.house.mo.gov/${docId}.pdf`,
}) {
  return {
    doc_id: docId, date, type, mime, mime_id: mime === 'application/pdf' ? 2 : 1, state_link: stateLink,
  };
}

test('planLegiscanTextWork: an unmatched bill is billUnmatched, never added to toFetch', () => {
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [textEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }) }];
  const { counts, toFetch } = planLegiscanTextWork(candidates, {
    billIndex: new Map(), textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(counts.billMatched, 0);
  assert.equal(counts.billUnmatched, 1);
  assert.deepEqual(toFetch, []);
});

test('planLegiscanTextWork: a matched bill with no texts[] entry is noTextEntry', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [] }) }];
  const { counts, toFetch } = planLegiscanTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(counts.noTextEntry, 1);
  assert.deepEqual(toFetch, []);
});

test('planLegiscanTextWork: a bill already carrying the selected version in bill_texts is alreadyHasVersion, never re-planned', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [textEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }) }];
  const { counts, toFetch } = planLegiscanTextWork(candidates, {
    billIndex, textVersionIndex: new Set(['bill-1|Introduced']), passageBillIds: new Set(),
  });
  assert.equal(counts.alreadyHasVersion, 1);
  assert.deepEqual(toFetch, []);
});

test('planLegiscanTextWork: MED-1 (controller ruling, corpus-verified) — a NON-PDF selected entry is now skippedNonPdfMime, never planned', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [textEntry({ docId: 1, date: '2025-12-01', type: 'Introduced', mime: 'text/html' })] }) }];
  const { counts, toFetch } = planLegiscanTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(toFetch.length, 0);
  assert.equal(counts.skippedNonPdfMime, 1);
});

test('planLegiscanTextWork: HIGH-1 — the same doc_id appearing in TWO different candidate entries (e.g. a regenerated dataset re-listing the same bill) is deduped; only the FIRST reaches toFetch, counted duplicateDocId', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const sameEntry = () => textEntry({
    docId: 1680835, date: '2025-12-01', type: 'Introduced',
  });
  const candidates = [
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [sameEntry()] }) },
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [sameEntry()] }) },
  ];
  const { counts, toFetch } = planLegiscanTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(toFetch.length, 1);
  assert.equal(counts.duplicateDocId, 1);
});

test('planLegiscanTextWork: HIGH-2 — legiscanBillId is carried onto the worklist entry from the candidate bill\'s own bill_id', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', billId: 1050440, texts: [textEntry({ docId: 1, date: '2025-12-01', type: 'Introduced' })] }) }];
  const { toFetch } = planLegiscanTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(toFetch[0].legiscanBillId, 1050440);
});

test('planLegiscanTextWork: a state_link pointing at a LegiScan proxy placeholder is STILL planned (unlike backfill-mo-bill-texts.js\'s skippedNonStateHost) — the doc_id is the only thing that matters', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [textEntry({ docId: 1, date: '2025-12-01', type: 'Introduced', stateLink: 'http://reflect.legiscan.com/Proxy.php' })] }) }];
  const { toFetch } = planLegiscanTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(toFetch.length, 1);
});

test('planLegiscanTextWork: passage bills are sorted ahead of others; passagePriority reports the split', () => {
  const billIndex = new Map([
    [`sess-1|${normalizeBillIdentifier('HB1')}`, { id: 'bill-other' }],
    [`sess-1|${normalizeBillIdentifier('HB2')}`, { id: 'bill-passage' }],
  ]);
  const candidates = [
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Introduced' })] }) },
    { sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB2', texts: [textEntry({ docId: 2, date: '2025-01-01', type: 'Introduced' })] }) },
  ];
  const { toFetch, passagePriority } = planLegiscanTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(['bill-passage']),
  });
  assert.equal(toFetch[0].billId, 'bill-passage');
  assert.equal(toFetch[0].priority, 'passage');
  assert.equal(toFetch[1].priority, 'other');
  assert.deepEqual(passagePriority, { passage: 1, other: 1 });
});

test('planLegiscanTextWork: version is the selected entry\'s own printed `type`, verbatim, never normalized', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Conference Sub' })] }) }];
  const { toFetch } = planLegiscanTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(toFetch[0].version, 'Conference Sub');
});

// ---- runIngestLegiscanTexts: orchestration (fake DB client + injected getBillTextFn/extractFn,
// real scratch-dir doc cache — mirrors ingest-legiscan-cli.test.js's resolveDatasetBytes tests'
// own withScratchDirAsync + real-fs convention) ----

// makeFakeWriteClient — a bill_texts insert-recorder PLUS enough of the ingestion_runs shape
// (select/order/range for getMonthlyQueryUsage's selectAll, update for recordQueryUsage's
// write-ahead) that the real assertRunUnderBudget/recordQueryUsage machinery this CLI reuses
// verbatim can run against it with zero usage seeded (plenty of headroom, matching every ordinary
// test's intent) unless a test explicitly composes its own ingestion_runs handling instead (see the
// budget-refusal tests below, which route 'ingestion_runs' through makeFakeUsageClient instead).
function makeFakeWriteClient({ rejectVersions = [] } = {}) {
  const calls = [];
  const runsTable = [];
  return {
    calls,
    runsTable,
    from(table) {
      if (table === 'ingestion_runs') {
        const predicates = [];
        const builder = {
          select() { return this; },
          eq(col, val) { predicates.push((r) => r[col] === val); return this; },
          gte(col, val) { predicates.push((r) => r[col] >= val); return this; },
          lt(col, val) { predicates.push((r) => r[col] < val); return this; },
          order() { return this; },
          range(from, to) {
            const filtered = runsTable.filter((r) => predicates.every((p) => p(r)));
            return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
          },
          // maybeSingle — needed by buildFailureCloseDetail/buildAbortCloseDetail's own best-effort
          // re-read of ingestion_runs.detail.queries_used (src/cli/ingest-legiscan.js). Without this,
          // the real function's own try/catch would silently swallow the missing method and default
          // queriesUsedSoFar to 0 — exactly the kind of false-negative a fake client must not produce.
          maybeSingle: async () => {
            const matched = runsTable.filter((r) => predicates.every((p) => p(r)));
            return { data: matched[0] ? { ...matched[0] } : null, error: null };
          },
          update(patch) {
            return {
              eq: async (col, val) => {
                const row = runsTable.find((r) => r[col] === val);
                if (row) Object.assign(row, patch);
                return { error: null };
              },
            };
          },
        };
        return builder;
      }
      return {
        insert: (row) => {
          calls.push({ table, row });
          if (table === 'bill_texts' && rejectVersions.includes(row.version)) {
            return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "bill_texts_bill_id_version_key"' } });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

function fakeDataset({ sessionId, bills }) {
  return { ok: true, sessionId, bills };
}

const baseLoaders = (overrides = {}) => ({
  loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
  loadBillIndexFn: async () => new Map([[`sess-1608|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1', status: null }]]),
  loadTextVersionIndexFn: async () => new Set(),
  loadPassageBillIdsFn: async () => new Set(),
  ...overrides,
});

const ONE_BILL_DATASET = () => fakeDataset({
  sessionId: 1608,
  bills: [moBill({ billNumber: 'HB1607', texts: [textEntry({ docId: 1680835, date: '2025-12-01', type: 'Introduced' })] })],
});

test('runIngestLegiscanTexts: --dry-run performs zero fetches and zero writes, reports billsPlanned + docCacheHits (a pure fs fact) without querying', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    writeFileSync(join(textCacheDir, '1680835.json'), JSON.stringify({ status: 'OK', text: billTextPayload() }));
    const client = makeFakeWriteClient();
    let getBillTextCalled = false;
    const report = await runIngestLegiscanTexts(client, {
      dryRun: true,
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(),
      ...baseLoaders(),
      getBillTextFn: async () => { getBillTextCalled = true; return billTextPayload(); },
    });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.counts.billsPlanned, 1);
    assert.equal(report.counts.docCacheHits, 1, 'a pure filesystem fact, knowable without querying');
    assert.equal(report.counts.queriesSpent, 0);
    assert.equal(getBillTextCalled, false);
    assert.deepEqual(client.calls, [], 'dry-run performs zero writes');
  });
});

test('runIngestLegiscanTexts: cache-hit spends no query — getBillTextFn is never invoked, the cached payload is decoded/stored instead', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    writeFileSync(join(textCacheDir, '1680835.json'), JSON.stringify({ status: 'OK', text: billTextPayload() }));
    const client = makeFakeWriteClient();
    let getBillTextCalled = false;
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(),
      ...baseLoaders(),
      getBillTextFn: async () => { getBillTextCalled = true; return billTextPayload(); },
      extractFn: async () => 'Section 1. Hello world.',
    });
    assert.equal(getBillTextCalled, false, 'a cached doc_id must NEVER be re-queried');
    assert.equal(report.counts.docCacheHits, 1);
    assert.equal(report.counts.queriesSpent, 0);
    assert.equal(report.counts.inserted, 1);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].row.version, 'Introduced');
  });
});

test('runIngestLegiscanTexts: a cache MISS spends exactly one query, caches the raw response, and stores the result', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    let queryCount = 0;
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(),
      ...baseLoaders(),
      getBillTextFn: async (docId) => { queryCount += 1; assert.equal(docId, 1680835); return billTextPayload(); },
      extractFn: async () => 'Section 1. Hello world.',
    });
    assert.equal(queryCount, 1);
    assert.equal(report.counts.queriesSpent, 1);
    assert.equal(report.counts.docCacheHits, 0);
    assert.equal(report.counts.inserted, 1);
    assert.ok(existsSync(join(textCacheDir, '1680835.json')), 'Rule 7 — the raw response is cached per doc_id after a successful query');
    const cached = JSON.parse(readFileSync(join(textCacheDir, '1680835.json'), 'utf8'));
    assert.equal(cached.text.doc_id, 1680835);
  });
});

test('runIngestLegiscanTexts: a repeat run over the SAME doc_id never spends a second query, even after the bill_texts row is gone (Rule 7: cached forever, in this run or any future one)', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    let queryCount = 0;
    const getBillTextFn = async () => { queryCount += 1; return billTextPayload(); };
    await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(), getBillTextFn, extractFn: async () => 'text',
    });
    assert.equal(queryCount, 1);
    // Second run, same doc_id, even though loadTextVersionIndexFn now reports the version is ALREADY
    // stored (simulating "the row exists") — still must not requery even if we force it back through
    // by reporting the version as NOT yet stored (simulating "the row was deleted").
    await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-2', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(), getBillTextFn, extractFn: async () => 'text',
    });
    assert.equal(queryCount, 1, 'the SAME doc_id must never be re-queried, ever, even on a later run');
  });
});

test('runIngestLegiscanTexts: status:\'ERROR\' from getBillText is a typed error, counted, and the run continues to the next bill', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const twoBillDataset = fakeDataset({
      sessionId: 1608,
      bills: [
        moBill({ billNumber: 'HB1607', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Introduced' })] }),
        moBill({ billNumber: 'HB1608', texts: [textEntry({ docId: 2, date: '2025-01-01', type: 'Introduced' })] }),
      ],
    });
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => twoBillDataset,
      loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
      loadBillIndexFn: async () => new Map([
        [`sess-1608|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }],
        [`sess-1608|${normalizeBillIdentifier('HB1608')}`, { id: 'bill-2' }],
      ]),
      loadTextVersionIndexFn: async () => new Set(),
      loadPassageBillIdsFn: async () => new Set(),
      getBillTextFn: async (docId) => {
        if (docId === 1) throw new LegiScanApiError('LegiScan API error: status=ERROR', { status: 'ERROR' });
        return billTextPayload({ docId: 2 });
      },
      extractFn: async () => 'text',
    });
    assert.equal(report.counts.statusError, 1);
    assert.equal(report.counts.inserted, 1, 'the OTHER bill in the same run still stores');
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].step, 'query');
    assert.equal(report.failures[0].docId, 1);
    assert.equal(existsSync(join(textCacheDir, '1.json')), false, 'an ERROR response is never cached — never blocks a future retry');
  });
});

test('runIngestLegiscanTexts: a base64 decode failure is counted (decodeFailed), never stored', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload({ doc: '' }),
      extractFn: async () => 'unreachable',
    });
    assert.equal(report.counts.decodeFailed, 1);
    assert.equal(report.failures[0].step, 'decode');
    assert.deepEqual(client.calls, []);
  });
});

test('runIngestLegiscanTexts: a RUNTIME non-PDF mime (dataset advertised PDF at planning time, per MED-1\'s gate, but the live response disagrees — the runtime check is a backstop) is counted (nonPdfMime), nothing stored, extractFn never called, and (LOW fix) gets a failures[] entry so a run that spent queries and stored nothing never silently reports "succeeded"', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    let extractCalled = false;
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(), // dataset entry says application/pdf
      getBillTextFn: async () => billTextPayload({ mime: 'text/html' }), // live response disagrees
      extractFn: async () => { extractCalled = true; return 'unreachable'; },
    });
    assert.equal(report.counts.nonPdfMime, 1);
    assert.equal(extractCalled, false);
    assert.deepEqual(client.calls, []);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].step, 'nonPdfMime');
  });
});

test('runIngestLegiscanTexts: oversize extraction is refused (oversizeRefused) and never stored — never truncated', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload(),
      extractFn: async () => 'x'.repeat(MAX_TEXT_CHARS + 1),
    });
    assert.equal(report.counts.oversizeRefused, 1);
    assert.equal(report.failures[0].step, 'oversize');
    assert.deepEqual(client.calls, []);
  });
});

test('runIngestLegiscanTexts: an extraction that yields zero characters is extractEmpty, step "extract"', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload(),
      extractFn: async () => '   \n  ',
    });
    assert.equal(report.counts.extractEmpty, 1);
    assert.equal(report.failures[0].step, 'extract');
  });
});

test('runIngestLegiscanTexts: a pdfjs parse exception is folded into extractEmpty, step "parse"', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload(),
      extractFn: async () => { throw new Error('bad XRef entry'); },
    });
    assert.equal(report.counts.extractEmpty, 1);
    assert.equal(report.failures[0].step, 'parse');
  });
});

test('runIngestLegiscanTexts: version is stored verbatim from the selected entry\'s own `type`, never normalized', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const dataset = fakeDataset({
      sessionId: 1608,
      bills: [moBill({ billNumber: 'HB1607', texts: [textEntry({ docId: 1680835, date: '2025-12-01', type: 'Conference Sub' })] })],
    });
    await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => dataset, ...baseLoaders(),
      getBillTextFn: async () => billTextPayload({ type: 'Conference Sub' }),
      extractFn: async () => 'text',
    });
    assert.equal(client.calls[0].row.version, 'Conference Sub');
  });
});

test('runIngestLegiscanTexts: a 23505 on insert is tolerated as alreadyPresent, never fatal, run continues', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient({ rejectVersions: ['Introduced'] });
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload(),
      extractFn: async () => 'text',
    });
    assert.equal(report.counts.alreadyPresent, 1);
    assert.equal(report.counts.inserted, 0);
  });
});

test('runIngestLegiscanTexts: an unrelated DB error on insert is thrown, never silently swallowed', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = {
      from: (table) => {
        if (table === 'ingestion_runs') {
          return {
            select() { return this; },
            eq() { return this; },
            gte() { return this; },
            lt() { return this; },
            order() { return this; },
            range: () => Promise.resolve({ data: [], error: null }),
            update: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        return { insert: async () => ({ error: { code: '500', message: 'connection reset' } }) };
      },
    };
    await assert.rejects(
      () => runIngestLegiscanTexts(client, {
        dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
        readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
        getBillTextFn: async () => billTextPayload(),
        extractFn: async () => 'text',
      }),
      /connection reset/,
    );
  });
});

test('runIngestLegiscanTexts: --limit caps the worklist size after passage-priority sort', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const dataset = fakeDataset({
      sessionId: 1608,
      bills: [
        moBill({ billNumber: 'HB1', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Introduced' })] }),
        moBill({ billNumber: 'HB2', texts: [textEntry({ docId: 2, date: '2025-01-01', type: 'Introduced' })] }),
      ],
    });
    const report = await runIngestLegiscanTexts(client, {
      dryRun: true,
      limit: 1,
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => dataset,
      loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
      loadBillIndexFn: async () => new Map([
        [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-1' }],
        [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-2' }],
      ]),
      loadTextVersionIndexFn: async () => new Set(),
      loadPassageBillIdsFn: async () => new Set(),
    });
    assert.equal(report.counts.billsPlanned, 1);
  });
});

test('runIngestLegiscanTexts: --priority-only restricts the worklist to passage/third-reading bills only', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const dataset = fakeDataset({
      sessionId: 1608,
      bills: [
        moBill({ billNumber: 'HB1', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Introduced' })] }),
        moBill({ billNumber: 'HB2', texts: [textEntry({ docId: 2, date: '2025-01-01', type: 'Introduced' })] }),
      ],
    });
    const report = await runIngestLegiscanTexts(client, {
      dryRun: true,
      priorityOnly: true,
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => dataset,
      loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
      loadBillIndexFn: async () => new Map([
        [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-1' }],
        [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-2' }],
      ]),
      loadTextVersionIndexFn: async () => new Set(),
      loadPassageBillIdsFn: async () => new Set(['bill-2']),
    });
    assert.equal(report.counts.billsPlanned, 1);
  });
});

// ---- budget gate: refuses to start, before any query (binding rule 1) ----

function makeFakeUsageClient(rows) {
  return {
    from(table) {
      assert.equal(table, 'ingestion_runs');
      const predicates = [];
      const builder = {
        select() { return this; },
        eq(col, val) { predicates.push((r) => r[col] === val); return this; },
        gte(col, val) { predicates.push((r) => r[col] >= val); return this; },
        lt(col, val) { predicates.push((r) => r[col] < val); return this; },
        order() { return this; },
        range(from, to) {
          const filtered = rows.filter((r) => predicates.every((p) => p(r)));
          return Promise.resolve({ data: filtered.slice(from, to + 1), error: null });
        },
      };
      return builder;
    },
  };
}

test('runIngestLegiscanTexts: budget-cap refusal happens BEFORE any query — getBillTextFn is never invoked, nothing is written', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const usageRows = [{
      id: '1', source: SOURCE, started_at: new Date().toISOString(), detail: { queries_used: 99 },
    }];
    // A composed fake: budget reads go to the ingestion_runs shape above, bill_texts writes go to
    // the ordinary insert-recording shape — both routed through one `from(table)` dispatcher.
    const writeClient = makeFakeWriteClient();
    const usageClient = makeFakeUsageClient(usageRows);
    const client = {
      from: (table) => (table === 'ingestion_runs' ? usageClient.from(table) : writeClient.from(table)),
      calls: writeClient.calls,
    };
    let getBillTextCalled = false;
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      capPerMonth: 100,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(),
      ...baseLoaders(),
      getBillTextFn: async () => { getBillTextCalled = true; return billTextPayload(); },
      extractFn: async () => 'text',
    });
    assert.equal(getBillTextCalled, false, 'refuses to start — zero live queries attempted');
    assert.equal(report.counts.queriesSpent, 0);
    assert.equal(report.counts.budgetRefused, 1);
    assert.deepEqual(writeClient.calls, [], 'nothing written when budget-refused');
    assert.ok(report.budgetError instanceof Object);
  });
});

test('runIngestLegiscanTexts: a budget refusal still processes already-cached doc_ids (zero cost against the query budget) — only the docs that would need a FRESH query are refused', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    writeFileSync(join(textCacheDir, '1680835.json'), JSON.stringify({ status: 'OK', text: billTextPayload() }));
    const usageRows = [{
      id: '1', source: SOURCE, started_at: new Date().toISOString(), detail: { queries_used: 99 },
    }];
    const writeClient = makeFakeWriteClient();
    const usageClient = makeFakeUsageClient(usageRows);
    const client = {
      from: (table) => (table === 'ingestion_runs' ? usageClient.from(table) : writeClient.from(table)),
    };
    const dataset = fakeDataset({
      sessionId: 1608,
      bills: [
        moBill({ billNumber: 'HB1', texts: [textEntry({ docId: 1680835, date: '2025-01-01', type: 'Introduced' })] }), // cached
        moBill({ billNumber: 'HB2', texts: [textEntry({ docId: 999, date: '2025-01-01', type: 'Introduced' })] }), // needs a fresh query
      ],
    });
    let getBillTextCalled = false;
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      capPerMonth: 100,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => dataset,
      loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
      loadBillIndexFn: async () => new Map([
        [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-1' }],
        [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-2' }],
      ]),
      loadTextVersionIndexFn: async () => new Set(),
      loadPassageBillIdsFn: async () => new Set(),
      getBillTextFn: async () => { getBillTextCalled = true; return billTextPayload({ docId: 999 }); },
      extractFn: async () => 'text',
    });
    assert.equal(getBillTextCalled, false, 'the fresh query is refused');
    assert.equal(report.counts.docCacheHits, 1, 'the cached doc_id still processes — it costs zero queries');
    assert.equal(report.counts.inserted, 1);
    assert.equal(report.counts.budgetRefused, 1);
    assert.equal(report.counts.queriesSpent, 0);
  });
});

test('runIngestLegiscanTexts: real headroom (usage well under cap) proceeds normally, budgetRefused stays 0', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    // makeFakeWriteClient's own ingestion_runs handling already seeds zero usage (real headroom)
    // AND supports the write-ahead .update() recordQueryUsage needs — no separate usage client
    // required here, unlike the budget-REFUSAL tests above which need to seed real prior usage.
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, capPerMonth: 5000,
      listFilesFn: () => ['a.json'], readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload(), extractFn: async () => 'text',
    });
    assert.equal(report.counts.budgetRefused, 0);
    assert.equal(report.counts.queriesSpent, 1);
    assert.equal(report.counts.inserted, 1);
  });
});

// ---- honest counts reconcile (the sibling's own HIGH finding — asserted directly here) ----

test('runIngestLegiscanTexts: counts reconcile — billsPlanned = docCacheHits + queriesSpent + budgetRefused, and every queried/cached doc resolves into exactly one terminal outcome bucket', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    // One cache hit (inserted), one fresh query that errors (statusError), one fresh query that
    // decode-fails, one fresh query that's non-PDF, one fresh query that's oversize, one fresh query
    // that inserts cleanly — six bills total, six distinct terminal paths. extractFn reads a marker
    // encoded INTO the fake doc buffer itself (via `doc`'s base64 content) so each doc_id can drive
    // a different extraction outcome without needing extractFn to see the doc_id directly (the real
    // implementation's extractFn signature is (buffer) only, mirroring extractPdfText's own).
    writeFileSync(join(textCacheDir, '1.json'), JSON.stringify({ status: 'OK', text: billTextPayload({ docId: 1, doc: Buffer.from('marker:1').toString('base64') }) }));
    const client = makeFakeWriteClient();
    const dataset = fakeDataset({
      sessionId: 1608,
      bills: [
        moBill({ billNumber: 'HB1', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Introduced' })] }), // cache hit -> inserted
        moBill({ billNumber: 'HB2', texts: [textEntry({ docId: 2, date: '2025-01-01', type: 'Introduced' })] }), // statusError
        moBill({ billNumber: 'HB3', texts: [textEntry({ docId: 3, date: '2025-01-01', type: 'Introduced' })] }), // decodeFailed
        moBill({ billNumber: 'HB4', texts: [textEntry({ docId: 4, date: '2025-01-01', type: 'Introduced' })] }), // nonPdfMime
        moBill({ billNumber: 'HB5', texts: [textEntry({ docId: 5, date: '2025-01-01', type: 'Introduced' })] }), // oversizeRefused
        moBill({ billNumber: 'HB6', texts: [textEntry({ docId: 6, date: '2025-01-01', type: 'Introduced' })] }), // inserted (fresh)
      ],
    });
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => dataset,
      loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
      loadBillIndexFn: async () => new Map([
        [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-1' }],
        [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-2' }],
        [`sess-1608|${normalizeBillIdentifier('HB3')}`, { id: 'bill-3' }],
        [`sess-1608|${normalizeBillIdentifier('HB4')}`, { id: 'bill-4' }],
        [`sess-1608|${normalizeBillIdentifier('HB5')}`, { id: 'bill-5' }],
        [`sess-1608|${normalizeBillIdentifier('HB6')}`, { id: 'bill-6' }],
      ]),
      loadTextVersionIndexFn: async () => new Set(),
      loadPassageBillIdsFn: async () => new Set(),
      getBillTextFn: async (docId) => {
        if (docId === 2) throw new LegiScanApiError('status=ERROR', { status: 'ERROR' });
        if (docId === 3) return billTextPayload({ docId: 3, doc: '' });
        if (docId === 4) return billTextPayload({ docId: 4, mime: 'text/html' });
        return billTextPayload({ docId, doc: Buffer.from(`marker:${docId}`).toString('base64') });
      },
      extractFn: async (buf) => {
        const marker = buf.toString('utf8');
        if (marker === 'marker:5') return 'x'.repeat(MAX_TEXT_CHARS + 1); // oversize
        return `extracted text for ${marker}`;
      },
    });

    assert.equal(report.counts.docCacheHits, 1);
    assert.equal(report.counts.queriesSpent, 5);
    assert.equal(report.counts.statusError, 1);
    assert.equal(report.counts.decodeFailed, 1);
    assert.equal(report.counts.nonPdfMime, 1);
    assert.equal(report.counts.oversizeRefused, 1);
    assert.equal(report.counts.inserted, 2, 'doc 1 (cache hit) and doc 6 (fresh) both insert cleanly');
    assert.equal(report.counts.budgetRefused, 0);

    const { counts } = report;
    assert.equal(counts.billsPlanned, counts.docCacheHits + counts.queriesSpent + counts.budgetRefused, 'every planned bill lands in exactly one of: cached, queried, or budget-refused');
    const processed = counts.docCacheHits + counts.queriesSpent - counts.statusError;
    const terminal = counts.decodeFailed + counts.nonPdfMime + counts.extractEmpty + counts.oversizeRefused
      + counts.inserted + counts.alreadyPresent + counts.identityMismatch + counts.cacheCorrupt + counts.missingSourceUrl;
    assert.equal(processed, terminal, 'every doc that reached decode/store resolves into exactly one terminal bucket (widened to include the fix-round\'s new buckets)');
  });
});

// ---- HIGH-1 (Rule 7 dedup, both halves) — end-to-end, at the orchestrator level ----

test('runIngestLegiscanTexts: HIGH-1 — a regenerated dataset (two cache files both matching --session 1608 via startsWith; ingest-legiscan.js never deletes the prior hash\'s file) must query doc 1680835 at most ONCE, not twice — the reviewer\'s exact executed construction', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    let queryCount = 0;
    const dataset = ONE_BILL_DATASET(); // both cache files decode to the SAME bill/doc_id
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      listFilesFn: () => ['1608-hashA.json', '1608-hashB.json'],
      readDatasetFn: async () => dataset,
      ...baseLoaders(),
      getBillTextFn: async (docId) => { queryCount += 1; assert.equal(docId, 1680835); return billTextPayload(); },
      extractFn: async () => 'text',
    });
    assert.equal(queryCount, 1, 'doc_id 1680835 must be queried at most once, even though it was planned twice (once per cache file)');
    assert.equal(report.counts.queriesSpent, 1);
    assert.equal(report.planCounts.duplicateDocId, 1);
  });
});

test('runIngestLegiscanTexts: HIGH-1, half 2 — the cache-hit check is re-verified FRESH at each iteration, never a stale pre-loop snapshot: a cache file that materializes DURING the run is honored for a later item, never double-queried', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const dataset = fakeDataset({
      sessionId: 1608,
      bills: [
        moBill({ billNumber: 'HB1', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Introduced' })] }),
        moBill({ billNumber: 'HB2', texts: [textEntry({ docId: 2, date: '2025-01-01', type: 'Introduced' })] }),
      ],
    });
    let doc2QueryCount = 0;
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => dataset,
      loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
      loadBillIndexFn: async () => new Map([
        [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-1' }],
        [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-2' }],
      ]),
      loadTextVersionIndexFn: async () => new Set(),
      loadPassageBillIdsFn: async () => new Set(),
      getBillTextFn: async (docId) => {
        if (docId === 1) {
          // Simulate a cache file for doc 2 materializing DURING this run (this run's own earlier
          // iteration, or any other process) — landing AFTER the pre-loop snapshot was taken but
          // BEFORE the loop reaches doc 2's own item.
          writeFileSync(join(textCacheDir, '2.json'), JSON.stringify({ status: 'OK', text: billTextPayload({ docId: 2 }) }));
          return billTextPayload({ docId: 1 });
        }
        doc2QueryCount += 1;
        return billTextPayload({ docId: 2 });
      },
      extractFn: async () => 'text',
    });
    assert.equal(doc2QueryCount, 0, 'doc 2\'s cache file materialized mid-run must be honored — never queried once a cache file exists, even one that appeared after the pre-loop snapshot');
    assert.equal(report.counts.docCacheHits, 1, 'doc 2 is picked up as a cache hit despite the stale pre-loop snapshot saying otherwise');
    assert.equal(report.counts.queriesSpent, 1, 'only doc 1 was actually queried');
  });
});

// ---- HIGH-2 (response identity check) ----

test('runIngestLegiscanTexts: HIGH-2 — a CACHED file containing a mismatched doc_id/bill_id ("a cache file named 1680835.json containing doc_id:999999/bill_id:777777" — the reviewer\'s exact executed construction) is refused, never stored, never re-queried', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    writeFileSync(join(textCacheDir, '1680835.json'), JSON.stringify({
      status: 'OK',
      text: billTextPayload({ docId: 999999, billId: 777777, doc: Buffer.from('WRONG BILL BODY').toString('base64') }),
    }));
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => { throw new Error('must not query — a cache file already exists for this doc_id'); },
      extractFn: async () => 'WRONG BILL BODY',
    });
    assert.equal(report.counts.identityMismatch, 1);
    assert.equal(report.counts.inserted, 0);
    assert.deepEqual(client.calls, [], 'never stored under the wrong bill');
    assert.equal(report.failures[0].step, 'identity');
  });
});

test('runIngestLegiscanTexts: HIGH-2 — a mismatched LIVE response is refused, never stored, and never written to the doc cache (never poisons a Rule-7-permanent cache entry)', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload({ docId: 999999, billId: 777777 }),
      extractFn: async () => 'text',
    });
    assert.equal(report.counts.identityMismatch, 1);
    assert.equal(report.counts.inserted, 0);
    assert.deepEqual(client.calls, []);
    assert.equal(existsSync(join(textCacheDir, '1680835.json')), false, 'never cached under the REQUESTED doc_id — a mismatched response must never poison the cache Rule 7 says can never be re-fetched');
  });
});

test('runIngestLegiscanTexts: HIGH-2 — a doc_id-only mismatch (bill_id matches) is still refused', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload({ docId: 999999 }), // bill_id stays the matching default
      extractFn: async () => 'text',
    });
    assert.equal(report.counts.identityMismatch, 1);
  });
});

test('runIngestLegiscanTexts: HIGH-2 — a bill_id-only mismatch (doc_id matches) is still refused', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload({ billId: 777777 }), // doc_id stays the matching default
      extractFn: async () => 'text',
    });
    assert.equal(report.counts.identityMismatch, 1);
  });
});

// ---- HIGH-3 (rate-limit abort, consecutive-failure circuit breaker, alertMessage) ----

test('runIngestLegiscanTexts: HIGH-3 — a RateLimitedError (429) ABORTS the whole run immediately; the reviewer\'s executed construction was "500 requests issued at 1/s for 8 minutes after LegiScan said stop" — this must never happen again', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    client.runsTable.push({
      id: 'run-1', source: SOURCE, status: 'running', detail: {},
    });
    let queryCount = 0;
    const dataset = fakeDataset({
      sessionId: 1608,
      bills: [
        moBill({ billNumber: 'HB1', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Introduced' })] }),
        moBill({ billNumber: 'HB2', texts: [textEntry({ docId: 2, date: '2025-01-01', type: 'Introduced' })] }),
      ],
    });
    await assert.rejects(
      () => runIngestLegiscanTexts(client, {
        dryRun: false,
        runId: 'run-1',
        cacheDir: textCacheDir,
        listFilesFn: () => ['a.json'],
        readDatasetFn: async () => dataset,
        loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
        loadBillIndexFn: async () => new Map([
          [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-1' }],
          [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-2' }],
        ]),
        loadTextVersionIndexFn: async () => new Set(),
        loadPassageBillIdsFn: async () => new Set(),
        getBillTextFn: async () => { queryCount += 1; throw new RateLimitedError('rate limited by legiscan', { source: 'legiscan', status: 429 }); },
        extractFn: async () => 'text',
      }),
      RateLimitedError,
    );
    assert.equal(queryCount, 1, 'the run aborts after the FIRST 429 — never continues to the second bill');
    assert.equal(client.runsTable.find((r) => r.id === 'run-1')?.detail?.queries_used, 1, 'write-ahead already persisted the one query attempted before the abort — queries_used survives through the failure close path');
  });
});

test('runIngestLegiscanTexts: HIGH-3 — a consecutive-statusError circuit breaker aborts after N=5 consecutive query failures, never burns the whole worklist against a systemic condition (e.g. "Subscription monthly query limit exceeded")', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    let queryCount = 0;
    const bills = Array.from({ length: 8 }, (_, i) => moBill({ billNumber: `HB${i + 1}`, texts: [textEntry({ docId: i + 1, date: '2025-01-01', type: 'Introduced' })] }));
    const dataset = fakeDataset({ sessionId: 1608, bills });
    const billIndexEntries = bills.map((_, i) => [`sess-1608|${normalizeBillIdentifier(`HB${i + 1}`)}`, { id: `bill-${i + 1}` }]);
    await assert.rejects(
      () => runIngestLegiscanTexts(client, {
        dryRun: false,
        runId: 'run-1',
        cacheDir: textCacheDir,
        listFilesFn: () => ['a.json'],
        readDatasetFn: async () => dataset,
        loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
        loadBillIndexFn: async () => new Map(billIndexEntries),
        loadTextVersionIndexFn: async () => new Set(),
        loadPassageBillIdsFn: async () => new Set(),
        getBillTextFn: async () => {
          queryCount += 1;
          throw new LegiScanApiError('LegiScan API error: status=ERROR', { status: 'ERROR', alertMessage: 'Subscription monthly query limit exceeded' });
        },
        extractFn: async () => 'text',
      }),
      /consecutive/i,
    );
    assert.equal(queryCount, 5, 'aborts after exactly 5 consecutive failures — never issues the 6th-8th requests');
  });
});

test('runIngestLegiscanTexts: HIGH-3 — a status:ERROR failure carries err.alertMessage into failures[] (e.g. "Subscription monthly query limit exceeded"), so an operator can see WHY', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => { throw new LegiScanApiError('LegiScan API error: status=ERROR', { status: 'ERROR', alertMessage: 'Subscription monthly query limit exceeded' }); },
      extractFn: async () => 'text',
    });
    assert.equal(report.failures[0].alertMessage, 'Subscription monthly query limit exceeded');
  });
});

test('runIngestLegiscanTexts: HIGH-3 — a query failure with no alertMessage at all reports null, never throws trying to read it', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => { throw new LegiScanApiError('LegiScan API error: status=ERROR', { status: 'ERROR' }); },
      extractFn: async () => 'text',
    });
    assert.equal(report.failures[0].alertMessage, null);
  });
});

// ---- fix-round-2 (coordinator ruling): an abort must not discard the run's own ledger — mirrors
// ingest-mo-senate.js's own partialCounts fix for the same defect class. Both abort throw sites
// attach `.partialReport` (counts/planCounts/passagePriority/failures/abortReason) onto the thrown
// error; buildAbortCloseDetail reads it back into the failed-close detail. ----

test('runIngestLegiscanTexts: a RateLimitedError abort attaches .partialReport (counts/planCounts/passagePriority/failures/abortReason) onto the thrown error itself', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const dataset = fakeDataset({
      sessionId: 1608,
      bills: [
        moBill({ billNumber: 'HB1', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Introduced' })] }),
        moBill({ billNumber: 'HB2', texts: [textEntry({ docId: 2, date: '2025-01-01', type: 'Introduced' })] }),
      ],
    });
    const err = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => dataset,
      loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
      loadBillIndexFn: async () => new Map([
        [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-1' }],
        [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-2' }],
      ]),
      loadTextVersionIndexFn: async () => new Set(),
      loadPassageBillIdsFn: async () => new Set(),
      getBillTextFn: async (docId) => {
        if (docId === 1) return billTextPayload({ docId: 1 });
        throw new RateLimitedError('rate limited by legiscan', { source: 'legiscan', status: 429 });
      },
      extractFn: async () => 'text',
    }).then(
      () => { throw new Error('expected the run to reject'); },
      (e) => e,
    );
    assert.ok(err instanceof RateLimitedError);
    assert.equal(err.partialReport.abortReason, 'rate_limited');
    assert.equal(err.partialReport.counts.inserted, 1, 'HB1 completed before the abort');
    assert.equal(err.partialReport.counts.queriesSpent, 2, 'HB1 succeeded, HB2 triggered the 429');
    assert.equal(typeof err.partialReport.planCounts.billsSeen, 'number');
    assert.deepEqual(err.partialReport.passagePriority, { passage: 0, other: 2 });
  });
});

test('buildAbortCloseDetail: carries err.partialReport forward (abort_reason, counts, planCounts, passagePriority, failures) alongside the base queries_used re-read', async () => {
  const client = makeFakeWriteClient();
  client.runsTable.push({
    id: 'run-x', source: SOURCE, status: 'running', detail: { queries_used: 4 },
  });
  const err = new RateLimitedError('rate limited', { source: 'legiscan', status: 429 });
  err.partialReport = {
    counts: { inserted: 2, queriesSpent: 3 },
    planCounts: { billsSeen: 5 },
    passagePriority: { passage: 1, other: 2 },
    failures: [{ step: 'query', message: 'x' }],
    abortReason: 'rate_limited',
  };
  const detail = await buildAbortCloseDetail(client, 'run-x', err);
  assert.equal(detail.abort_reason, 'rate_limited');
  assert.equal(detail.queries_used, 4, 'the base queries_used re-read (write-ahead) is preserved');
  assert.equal(detail.counts.inserted, 2);
  assert.deepEqual(detail.planCounts, { billsSeen: 5 });
  assert.deepEqual(detail.passagePriority, { passage: 1, other: 2 });
  assert.equal(detail.failures.length, 1);
  assert.match(detail.error, /rate limited/);
});

test('buildAbortCloseDetail: gracefully degrades to buildFailureCloseDetail\'s own plain {error, queries_used} shape when err carries no partialReport (a genuinely unexpected crash)', async () => {
  const client = makeFakeWriteClient();
  client.runsTable.push({
    id: 'run-y', source: SOURCE, status: 'running', detail: { queries_used: 1 },
  });
  const err = new Error('a totally unrelated bug');
  const detail = await buildAbortCloseDetail(client, 'run-y', err);
  assert.equal(detail.queries_used, 1);
  assert.equal(detail.abort_reason, undefined);
  assert.equal(detail.counts, undefined);
  assert.match(detail.error, /a totally unrelated bug/);
});

test('full composition (mirrors ingest-mo-senate.js\'s own partialCounts fix): an abort at item 3 of 3 closes \'failed\' with a detail carrying the abort reason, queries_used, AND the partial counts reflecting the N-1 (2) completed items — a specific bucket, not just presence', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    client.runsTable.push({
      id: 'run-1', source: SOURCE, status: 'running', detail: {},
    });
    const dataset = fakeDataset({
      sessionId: 1608,
      bills: [
        moBill({ billNumber: 'HB1', texts: [textEntry({ docId: 1, date: '2025-01-01', type: 'Introduced' })] }),
        moBill({ billNumber: 'HB2', texts: [textEntry({ docId: 2, date: '2025-01-01', type: 'Introduced' })] }),
        moBill({ billNumber: 'HB3', texts: [textEntry({ docId: 3, date: '2025-01-01', type: 'Introduced' })] }),
      ],
    });
    const caughtErr = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => dataset,
      loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
      loadBillIndexFn: async () => new Map([
        [`sess-1608|${normalizeBillIdentifier('HB1')}`, { id: 'bill-1' }],
        [`sess-1608|${normalizeBillIdentifier('HB2')}`, { id: 'bill-2' }],
        [`sess-1608|${normalizeBillIdentifier('HB3')}`, { id: 'bill-3' }],
      ]),
      loadTextVersionIndexFn: async () => new Set(),
      loadPassageBillIdsFn: async () => new Set(),
      getBillTextFn: async (docId) => {
        // Item 3 of 3 triggers the abort (N=3) — items 1 and 2 (N-1=2) complete first.
        if (docId === 3) throw new RateLimitedError('rate limited by legiscan', { source: 'legiscan', status: 429 });
        return billTextPayload({ docId });
      },
      extractFn: async () => 'text',
    }).then(
      () => { throw new Error('expected the run to reject'); },
      (e) => e,
    );

    const closeDetail = await buildAbortCloseDetail(client, 'run-1', caughtErr);
    await closeRun(client, 'run-1', 'failed', closeDetail);

    const row = client.runsTable.find((r) => r.id === 'run-1');
    assert.equal(row.status, 'failed');
    assert.equal(row.detail.abort_reason, 'rate_limited');
    assert.equal(row.detail.queries_used, 3, 'write-ahead recorded 3 queries: HB1, HB2 succeeded, HB3 triggered the abort');
    assert.equal(row.detail.counts.inserted, 2, 'the partial counts reflect the N-1 (2) completed items before the abort');
    assert.equal(row.detail.counts.queriesSpent, 3);
  });
});

test('full composition: a consecutive-statusError circuit-breaker abort ALSO closes \'failed\' with abort_reason "consecutive_status_errors" and the partial counts up to the break', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    client.runsTable.push({
      id: 'run-2', source: SOURCE, status: 'running', detail: {},
    });
    // 1 cache hit (inserted) + 5 fresh failures (the N=5 breaker limit) + 2 more bills never reached.
    writeFileSync(join(textCacheDir, '100.json'), JSON.stringify({ status: 'OK', text: billTextPayload({ docId: 100 }) }));
    const bills = [
      moBill({ billNumber: 'HB100', texts: [textEntry({ docId: 100, date: '2025-01-01', type: 'Introduced' })] }),
      ...Array.from({ length: 7 }, (_, i) => moBill({ billNumber: `HB${i + 1}`, texts: [textEntry({ docId: i + 1, date: '2025-01-01', type: 'Introduced' })] })),
    ];
    const dataset = fakeDataset({ sessionId: 1608, bills });
    const billIndexEntries = [
      [`sess-1608|${normalizeBillIdentifier('HB100')}`, { id: 'bill-100' }],
      ...Array.from({ length: 7 }, (_, i) => [`sess-1608|${normalizeBillIdentifier(`HB${i + 1}`)}`, { id: `bill-${i + 1}` }]),
    ];
    const caughtErr = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-2',
      cacheDir: textCacheDir,
      listFilesFn: () => ['a.json'],
      readDatasetFn: async () => dataset,
      loadSessionIndexFn: async () => new Map([[1608, { id: 'sess-1608' }]]),
      loadBillIndexFn: async () => new Map(billIndexEntries),
      loadTextVersionIndexFn: async () => new Set(),
      loadPassageBillIdsFn: async () => new Set(),
      getBillTextFn: async (docId) => {
        throw new LegiScanApiError('LegiScan API error: status=ERROR', { status: 'ERROR', alertMessage: `boom ${docId}` });
      },
      extractFn: async () => 'text',
    }).then(
      () => { throw new Error('expected the run to reject'); },
      (e) => e,
    );

    const closeDetail = await buildAbortCloseDetail(client, 'run-2', caughtErr);
    await closeRun(client, 'run-2', 'failed', closeDetail);

    const row = client.runsTable.find((r) => r.id === 'run-2');
    assert.equal(row.detail.abort_reason, 'consecutive_status_errors');
    assert.equal(row.detail.counts.inserted, 1, 'the cache-hit bill (HB100) completed before the breaker tripped');
    assert.equal(row.detail.counts.statusError, 5, 'the breaker trips at exactly 5 consecutive query failures');
    assert.equal(row.detail.counts.queriesSpent, 5);
  });
});

// ---- fix-round-3 (coordinator ruling, IMPORTANT-1(a)): buildAbortCloseDetail's queries_used must
// never regress BELOW the TRUE in-process counts.queriesSpent already known from err.partialReport,
// even when the underlying DB re-read fails (mirrors the same reviewer-proven regression fixed in
// buildFailureCloseDetail/closeRunOnFailure — IMPORTANT-1(b), src/cli/ingest-legiscan.js). ----

function makeLedgerReadFailureClient(seedRow) {
  const runsTable = seedRow ? [{ ...seedRow }] : [];
  return {
    runsTable,
    from(table) {
      assert.equal(table, 'ingestion_runs');
      return {
        select() { return this; },
        eq() { return this; },
        // The reviewer's exact construction: a transient read error (57014, statement_timeout),
        // never thrown — postgrest-js resolves.
        maybeSingle: async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }),
        update(patch) {
          return {
            eq: async (col, val) => {
              const row = runsTable.find((r) => r[col] === val);
              if (row) Object.assign(row, patch);
              return { error: null };
            },
          };
        },
      };
    },
  };
}

test('buildAbortCloseDetail: IMPORTANT-1(a) — a ledger read failure (base.queries_used defaults to 0) never regresses BELOW the true in-process counts.queriesSpent already known from err.partialReport', async () => {
  const client = makeLedgerReadFailureClient({
    id: 'run-a', source: SOURCE, status: 'running', detail: { queries_used: 6 },
  });
  const err = new RateLimitedError('rate limited', { source: 'legiscan', status: 429 });
  err.partialReport = {
    counts: { inserted: 2, queriesSpent: 6 }, planCounts: {}, passagePriority: { passage: 0, other: 6 }, failures: [], abortReason: 'rate_limited',
  };
  const detail = await buildAbortCloseDetail(client, 'run-a', err);
  assert.equal(detail.ledgerReadFailed, true, 'the underlying re-read DID fail');
  assert.equal(detail.queries_used, 6, 'recovered from the in-process partialReport, never the read-failure default of 0');
});

test('closeRunOnAbort: on a ledger read failure with NO partialReport (a genuinely unexpected crash, no in-process fallback), closeRun is SKIPPED — the row stays \'running\' with its prior nonzero detail intact', async () => {
  const client = makeLedgerReadFailureClient({
    id: 'run-b', source: SOURCE, status: 'running', detail: { queries_used: 6 },
  });
  const result = await closeRunOnAbort(client, 'run-b', new Error('a totally unrelated bug'));
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'ledger_read_failed');
  const row = client.runsTable.find((r) => r.id === 'run-b');
  assert.equal(row.status, 'running', 'never closed — closeRun must never be called over an unverifiable ledger');
  assert.deepEqual(row.detail, { queries_used: 6 });
});

test('closeRunOnAbort: on a ledger read failure WITH a partialReport (a named abort), closeRun still proceeds — the Math.max recovery already guarantees a correct queries_used', async () => {
  const client = makeLedgerReadFailureClient({
    id: 'run-c', source: SOURCE, status: 'running', detail: { queries_used: 6 },
  });
  const err = new RateLimitedError('rate limited', { source: 'legiscan', status: 429 });
  err.partialReport = {
    counts: { inserted: 2, queriesSpent: 6 }, planCounts: {}, passagePriority: { passage: 0, other: 6 }, failures: [], abortReason: 'rate_limited',
  };
  const result = await closeRunOnAbort(client, 'run-c', err);
  assert.equal(result.closed, true);
  const row = client.runsTable.find((r) => r.id === 'run-c');
  assert.equal(row.status, 'failed');
  assert.equal(row.detail.queries_used, 6, 'the recovered value, never a false 0');
  assert.equal(row.detail.abort_reason, 'rate_limited');
});

// ---- fix-round-3 (coordinator ruling, IMPORTANT-2, live-execution-proven): a dataset-cache read
// failure or an uncached --session used to be invisible to status/exit-code — a run could close
// 'succeeded' with exit 0 while whole sessions' worth of bills silently vanished. Sharp case proven:
// 1 of 3 cache files readable -> billsPlanned=2, inserted=2, failures=[], 'succeeded', exit 0. ----

test('computeLiveRunStatus: a clean run (no failures, no dataset issues) is succeeded, no partialReason', () => {
  const report = {
    refused: false, failures: [], counts: { datasetsMissing: 0 }, sessionUncached: false,
  };
  const { status, partialReason } = computeLiveRunStatus(report);
  assert.equal(status, 'succeeded');
  assert.equal(partialReason, undefined);
});

test('computeLiveRunStatus: datasetsMissing > 0 with ZERO per-bill failures is still \'partial\', named "dataset_read_failure" — the exact regression that used to close \'succeeded\'', () => {
  const report = {
    refused: false, failures: [], counts: { datasetsMissing: 2 }, sessionUncached: false,
  };
  const { status, partialReason } = computeLiveRunStatus(report);
  assert.equal(status, 'partial');
  assert.equal(partialReason, 'dataset_read_failure');
});

test('computeLiveRunStatus: sessionUncached with ZERO per-bill failures is also \'partial\', named "dataset_read_failure"', () => {
  const report = {
    refused: false, failures: [], counts: { datasetsMissing: 0 }, sessionUncached: true,
  };
  const { status, partialReason } = computeLiveRunStatus(report);
  assert.equal(status, 'partial');
  assert.equal(partialReason, 'dataset_read_failure');
});

test('computeLiveRunStatus: an ordinary per-bill failure still reports \'partial\' with no partialReason (unrelated to the dataset-read fix)', () => {
  const report = {
    refused: false, failures: [{ step: 'query' }], counts: { datasetsMissing: 0 }, sessionUncached: false,
  };
  const { status, partialReason } = computeLiveRunStatus(report);
  assert.equal(status, 'partial');
  assert.equal(partialReason, undefined);
});

test('computeLiveRunStatus: a budget refusal is always \'failed\', regardless of dataset issues', () => {
  const report = {
    refused: true, failures: [], counts: { datasetsMissing: 3 }, sessionUncached: true,
  };
  const { status, partialReason } = computeLiveRunStatus(report);
  assert.equal(status, 'failed');
  assert.equal(partialReason, undefined);
});

test('runIngestLegiscanTexts + computeLiveRunStatus: the reviewer\'s exact sharp case — 1 of 3 dataset cache files readable closes \'partial\' (not \'succeeded\'), with datasetsMissing surfacing in counts (moved back in, matching the sibling)', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      listFilesFn: () => ['good.json', 'bad1.json', 'bad2.json'],
      readDatasetFn: async (filePath) => (filePath === 'good.json' ? ONE_BILL_DATASET() : { ok: false, filePath }),
      ...baseLoaders(),
      getBillTextFn: async () => billTextPayload(),
      extractFn: async () => 'text',
    });
    assert.equal(report.counts.datasetsRead, 1);
    assert.equal(report.counts.datasetsMissing, 2, 'two whole sessions\' worth of bills silently vanished — must be visible in the ledger, not just baseReport');
    assert.equal(report.counts.billsPlanned, 1);
    assert.equal(report.counts.inserted, 1);
    assert.deepEqual(report.failures, [], 'no per-bill failures — the dataset read failures never produce one');

    const { status, partialReason } = computeLiveRunStatus(report);
    assert.equal(status, 'partial', 'must NEVER close \'succeeded\' when whole sessions vanished from the worklist');
    assert.equal(partialReason, 'dataset_read_failure');
  });
});

test('runIngestLegiscanTexts + computeLiveRunStatus: --session with NO matching cached file (sessionUncached) also forces \'partial\', never a silent \'succeeded\'', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false,
      runId: 'run-1',
      cacheDir: textCacheDir,
      session: 9999,
      listFilesFn: () => ['1608-hashA.json'], // none of these match --session 9999
      readDatasetFn: async () => ONE_BILL_DATASET(),
      ...baseLoaders(),
      getBillTextFn: async () => billTextPayload(),
      extractFn: async () => 'text',
    });
    assert.equal(report.sessionUncached, true);
    assert.equal(report.counts.billsPlanned, 0);
    assert.deepEqual(report.failures, []);

    const { status, partialReason } = computeLiveRunStatus(report);
    assert.equal(status, 'partial');
    assert.equal(partialReason, 'dataset_read_failure');
  });
});

// ---- MED-2 (atomic cache writes + cacheCorrupt) ----

test('runIngestLegiscanTexts: MED-2 — a successful cache write leaves no stray temp file, and the final file is valid JSON (atomic temp+rename)', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload(),
      extractFn: async () => 'text',
    });
    const files = readdirSync(textCacheDir);
    assert.deepEqual(files, ['1680835.json'], 'no leftover .tmp/partial file after a successful write');
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(textCacheDir, '1680835.json'), 'utf8')));
  });
});

test('runIngestLegiscanTexts: MED-2 — a truncated/corrupt cache file is refused (cacheCorrupt), NEVER re-queried (Rule 7 forbids re-fetching a doc_id with a cache file present, corrupt or not), and the run continues', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    writeFileSync(join(textCacheDir, '1680835.json'), '{not valid json, truncated mid-write');
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => { throw new Error('must not query — Rule 7 forbids re-fetching a cached doc_id, corrupt or not'); },
      extractFn: async () => 'text',
    });
    assert.equal(report.counts.cacheCorrupt, 1);
    assert.equal(report.counts.docCacheHits, 1, 'a cache file WAS found — the hit is real, only the parse is corrupt');
    assert.equal(report.counts.queriesSpent, 0);
    assert.equal(report.counts.inserted, 0);
    assert.equal(report.failures[0].step, 'cacheCorrupt');
  });
});

// ---- MED-3 (refuse a receipt-less row) ----

test('runIngestLegiscanTexts: MED-3 — a response with neither a real state_link nor a usable `url` field is refused (missingSourceUrl), never stored with a null/empty receipt', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload({ stateLink: 'http://reflect.legiscan.com/Proxy.php', url: '' }),
      extractFn: async () => 'text',
    });
    assert.equal(report.counts.missingSourceUrl, 1);
    assert.equal(report.counts.inserted, 0);
    assert.deepEqual(client.calls, []);
    assert.equal(report.failures[0].step, 'sourceUrl');
  });
});

// ---- MED-4 (surface plan.counts as a sibling field) ----

test('runIngestLegiscanTexts: MED-4 — planCounts surfaces the raw planning-time breakdown as a sibling of counts (never folded into the closed counts list), in BOTH dry-run and live reports', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const dryReport = await runIngestLegiscanTexts(client, {
      dryRun: true, cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
    });
    assert.equal(dryReport.planCounts.billsSeen, 1);
    assert.equal(dryReport.planCounts.billMatched, 1);
    assert.equal(typeof dryReport.planCounts.billUnmatched, 'number');
    assert.equal(typeof dryReport.planCounts.noTextEntry, 'number');
    assert.equal(typeof dryReport.planCounts.noDocId, 'number');
    assert.equal(typeof dryReport.planCounts.skippedNonPdfMime, 'number');
    assert.equal(typeof dryReport.planCounts.duplicateDocId, 'number');
    assert.equal(typeof dryReport.planCounts.alreadyHasVersion, 'number');
    assert.equal(dryReport.counts.alreadyHasVersion, dryReport.planCounts.alreadyHasVersion, 'the closed-list copy and the raw planning breakdown must agree');

    const liveReport = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload(), extractFn: async () => 'text',
    });
    assert.equal(liveReport.planCounts.billsSeen, 1);
  });
});

// ---- key redaction: the key never appears in any run-detail/failure payload ----

test('runIngestLegiscanTexts: the LegiScan API key never appears in failures[] even when getBillTextFn\'s own thrown error message happens to embed a URL', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    const SECRET = 'TOTALLY_SECRET_KEY_VALUE_123';
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, apiKey: SECRET,
      listFilesFn: () => ['a.json'], readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => { throw new LegiScanApiError('LegiScan API error: status=ERROR', { status: 'ERROR' }); },
      extractFn: async () => 'text',
    });
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(SECRET), 'the API key must never leak into any run-detail/failure payload');
  });
});
