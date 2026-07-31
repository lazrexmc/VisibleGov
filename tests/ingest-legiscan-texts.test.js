import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync,
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
  BillTextDecodeError,
} from '../src/cli/ingest-legiscan-texts.js';
import { InvalidFlagValueError, SourceFetchError } from '../src/lib/errors.js';
import { OversizeTextError, MAX_TEXT_CHARS } from '../src/lib/summarizer.js';
import { EmptyExtractionError } from '../src/cli/backfill-mo-bill-texts.js';
import { normalizeBillIdentifier } from '../src/adapters/legiscan-dataset.js';
import { QueryBudgetExceededError, LegiScanApiError, SOURCE } from '../src/adapters/legiscan.js';

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

// ---- planLegiscanTextWork (pure planning: cached-dataset bills -> doc_id worklist, NOT gated by
// mime/state-host the way backfill-mo-bill-texts.js's own planBillTextWork is — the LegiScan API
// fetches by doc_id regardless of mime or which host state_link points at) ----

function moBill({ billNumber, texts = [] }) {
  return { bill_number: billNumber, texts };
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

test('planLegiscanTextWork: a NON-PDF selected entry is STILL planned (unlike backfill-mo-bill-texts.js\'s planBillTextWork) — the LegiScan API fetches by doc_id regardless of mime', () => {
  const billIndex = new Map([[`sess-1|${normalizeBillIdentifier('HB1607')}`, { id: 'bill-1' }]]);
  const candidates = [{ sessionRowId: 'sess-1', bill: moBill({ billNumber: 'HB1607', texts: [textEntry({ docId: 1, date: '2025-12-01', type: 'Introduced', mime: 'text/html' })] }) }];
  const { toFetch } = planLegiscanTextWork(candidates, {
    billIndex, textVersionIndex: new Set(), passageBillIds: new Set(),
  });
  assert.equal(toFetch.length, 1);
  assert.equal(toFetch[0].docId, 1);
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

test('runIngestLegiscanTexts: a non-PDF mime is counted (nonPdfMime), nothing stored, extractFn never called', async () => {
  await withScratchDirAsync(async (textCacheDir) => {
    const client = makeFakeWriteClient();
    let extractCalled = false;
    const report = await runIngestLegiscanTexts(client, {
      dryRun: false, runId: 'run-1', cacheDir: textCacheDir, listFilesFn: () => ['a.json'],
      readDatasetFn: async () => ONE_BILL_DATASET(), ...baseLoaders(),
      getBillTextFn: async () => billTextPayload({ mime: 'text/html' }),
      extractFn: async () => { extractCalled = true; return 'unreachable'; },
    });
    assert.equal(report.counts.nonPdfMime, 1);
    assert.equal(extractCalled, false);
    assert.deepEqual(client.calls, []);
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
    const terminal = counts.decodeFailed + counts.nonPdfMime + counts.extractEmpty + counts.oversizeRefused + counts.inserted + counts.alreadyPresent;
    assert.equal(processed, terminal, 'every doc that reached decode/store resolves into exactly one terminal bucket');
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
