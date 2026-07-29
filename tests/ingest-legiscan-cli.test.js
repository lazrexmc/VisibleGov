import {
  readFileSync, writeFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLegiscanArgs,
  billSourceUrl, rollCallSourceUrl,
  isLegiscanRegularSession, buildLegiscanSpecialSessionIdentifier,
  ensureLegiscanSessionRow, AmbiguousLegiscanSessionMatchError, LegiscanSessionIdentityConflictError,
  runLegiscanIngest, resolveDatasetBytes, assertRunUnderBudget, dryRunReportFromDb,
  planFromParsedDataset,
} from '../src/cli/ingest-legiscan.js';
import { QueryBudgetExceededError, DatasetHashMismatchError } from '../src/adapters/legiscan.js';
import { decodeDatasetZip, extractDatasetFiles } from '../src/adapters/legiscan-dataset.js';

// Task 9 (docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md) — the driver that composes
// Tasks 2/4/5/6/7 into the full dataset-bulk backfill pipeline. Real fixtures throughout (no
// synthetic dataset payloads for the end-to-end tests) per CONTROLLER RULING 11: session 1579
// (2018 1st Special Session, ZERO votes) and session 1608 (2018 2nd Special Session, 8 real roll
// calls) — the exact two fixtures every other adapter test in this plan is built against.

const FIXDIR = 'tests/fixtures/research/legiscan';

async function withScratchDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-legiscan-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- generic in-memory fake Supabase client ----------------------------------------------------
//
// This driver composes calls into legiscan-identity.js and legiscan-votes.js, whose own query
// shapes are ALREADY fixed by their existing (reviewed, tested) code — this fake must match every
// shape those modules issue, plus this file's own sessions/bills/votes/legiscan_datasets/
// ingestion_runs calls. Built generically (one query-builder engine reused per table) rather than
// hand-rolling a bespoke shape per call site, the same "enough of the real supabase-js shape to
// drive the actual call chains, nothing more" convention tests/legiscan-identity.test.js's
// makeFakeDb and tests/legiscan-votes.test.js's makeFakeVotesDb each use for their own narrower
// scope — this one is wider because the DRIVER touches every table those two modules touch, at
// once, in one composed pipeline.

function likeToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/%/g, '.*')}$`);
}

function applyFilters(rows, filters) {
  return rows.filter((row) => filters.every((f) => {
    if (f.type === 'eq') return row[f.col] === f.val;
    if (f.type === 'gte') return row[f.col] >= f.val;
    if (f.type === 'lt') return row[f.col] < f.val;
    if (f.type === 'like') return likeToRegExp(f.pattern).test(String(row[f.col] ?? ''));
    throw new Error(`unsupported filter type ${f.type}`);
  }));
}

function makeQueryBuilder(getRows, opts = {}) {
  function build(filters) {
    const api = {
      eq: (col, val) => build([...filters, { type: 'eq', col, val }]),
      gte: (col, val) => build([...filters, { type: 'gte', col, val }]),
      lt: (col, val) => build([...filters, { type: 'lt', col, val }]),
      like: (col, pattern) => build([...filters, { type: 'like', col, pattern }]),
      order: () => api,
      range: (from, to) => {
        const matched = applyFilters(getRows(), filters);
        return Promise.resolve({ data: matched.slice(from, to + 1).map((r) => ({ ...r })), error: null });
      },
      maybeSingle: async () => {
        const matched = applyFilters(getRows(), filters);
        return { data: matched[0] ? { ...matched[0] } : null, error: null };
      },
      single: async () => {
        const matched = applyFilters(getRows(), filters);
        if (matched.length !== 1) return { data: null, error: { message: `fake db: expected 1 row, got ${matched.length}` } };
        return { data: { ...matched[0] }, error: null };
      },
      then: (resolve, reject) => {
        try {
          const matched = applyFilters(getRows(), filters);
          const result = { data: matched.map((r) => ({ ...r })), error: null };
          if (opts.count === 'exact') result.count = matched.length;
          resolve(result);
        } catch (err) { reject(err); }
      },
    };
    return api;
  }
  return build([]);
}

function makeFakeLegiscanClient(seed = {}) {
  const tables = {
    sessions: [], bills: [], legislators: [], terms: [], votes: [], vote_casts: [],
    vote_reconciliation_flags: [], legiscan_datasets: [], ingestion_runs: [], ...seed,
  };
  const counters = {};
  const writeLog = [];
  const nextId = (table) => {
    counters[table] = (counters[table] ?? 0) + 1;
    return `${table}-${counters[table]}`;
  };

  function rowsFor(table) {
    if (table === 'terms') {
      // terms carries a legislator_id FK — join legislators.full_name in-memory exactly the way
      // `.select('...,legislators(full_name)')` resolves server-side (mirrors legiscan-identity
      // .test.js's own makeFakeDb terms handling).
      return tables.terms.map((t) => ({
        ...t, legislators: { full_name: tables.legislators.find((l) => l.id === t.legislator_id)?.full_name ?? null },
      }));
    }
    return tables[table];
  }

  const client = {
    from(table) {
      if (!(table in tables)) throw new Error(`fake db: unexpected table "${table}"`);
      return {
        select: (cols, selectOpts) => makeQueryBuilder(() => rowsFor(table), selectOpts ?? {}),
        insert: (rowOrRows) => ({
          select: () => ({
            single: async () => {
              const row = Array.isArray(rowOrRows) ? rowOrRows[0] : rowOrRows;
              const inserted = { id: nextId(table), ...row };
              tables[table].push(inserted);
              writeLog.push({ table, op: 'insert', row: inserted });
              return { data: inserted, error: null };
            },
          }),
        }),
        update: (patch) => ({
          eq: async (col, val) => {
            const row = tables[table].find((r) => r[col] === val);
            if (row) {
              Object.assign(row, patch);
              writeLog.push({ table, op: 'update', col, val, patch });
            }
            return { error: null };
          },
        }),
        upsert: (rowsOrRow, upsertOpts = {}) => {
          const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const conflictCols = (upsertOpts.onConflict || '').split(',').filter(Boolean);
          for (const row of rows) {
            const existing = conflictCols.length > 0
              ? tables[table].find((r) => conflictCols.every((c) => r[c] === row[c]))
              : null;
            if (existing) {
              if (!upsertOpts.ignoreDuplicates) Object.assign(existing, row);
            } else {
              tables[table].push({ id: row.id ?? nextId(table), ...row });
            }
          }
          writeLog.push({ table, op: 'upsert', rows, opts: upsertOpts });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return {
    client, tables, writeLog,
  };
}

// ---- parseLegiscanArgs -----------------------------------------------------------------------

test('parseLegiscanArgs: parses --session/--limit/--dry-run/--dataset-file', () => {
  const args = parseLegiscanArgs(['--session', '1608', '--limit', '5', '--dry-run', '--dataset-file', 'x.json']);
  assert.deepEqual(args, {
    session: 1608, limit: 5, dryRun: true, datasetFile: 'x.json',
  });
});

test('parseLegiscanArgs: --session is required unless --dataset-file is given', () => {
  assert.throws(() => parseLegiscanArgs([]), /--session <legiscan_session_id> is required/);
  assert.doesNotThrow(() => parseLegiscanArgs(['--dataset-file', 'x.json']));
});

test('parseLegiscanArgs: defaults limit null, dryRun false, datasetFile null', () => {
  const args = parseLegiscanArgs(['--session', '1608']);
  assert.equal(args.limit, null);
  assert.equal(args.dryRun, false);
  assert.equal(args.datasetFile, null);
});

test('parseLegiscanArgs: throws on an unknown flag', () => {
  assert.throws(() => parseLegiscanArgs(['--session', '1608', '--bogus']), /unknown flag: --bogus/);
});

// ---- provenance: source_url resolution (CONTROLLER RULINGS 5 & 10) ----------------------------

const sb894Bill = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-SB894.json`, 'utf8')).bill;

test('billSourceUrl: prefers state_link (the STATE\'s own page) over legiscan.com\'s own url, on the REAL SB894 fixture', () => {
  assert.equal(sb894Bill.state_link, 'https://www.senate.mo.gov/18info/BTS_Web/Bill.aspx?SessionType=R&BillID=71289930');
  assert.equal(billSourceUrl(sb894Bill), sb894Bill.state_link);
  assert.notEqual(billSourceUrl(sb894Bill), sb894Bill.url);
});

test('billSourceUrl: falls back to url when state_link is absent/blank', () => {
  assert.equal(billSourceUrl({ url: 'https://legiscan.com/x', state_link: '' }), 'https://legiscan.com/x');
  assert.equal(billSourceUrl({ url: 'https://legiscan.com/x' }), 'https://legiscan.com/x');
  assert.equal(billSourceUrl({}), null);
});

test('rollCallSourceUrl (CONTROLLER RULING 5): roll_call payloads carry NO url field at all — the '
  + 'source_url comes from the PARENT BILL\'s own votes[] array, keyed by roll_call_id, real SB894 data', () => {
  const url = rollCallSourceUrl(sb894Bill, 747209);
  assert.equal(url, 'https://www.house.mo.gov/billtracking/bills181/rollcalls/065.005.pdf'); // state_link preferred
});

test('rollCallSourceUrl: a roll_call_id absent from the bill\'s own votes[] array resolves to null, never guessed', () => {
  assert.equal(rollCallSourceUrl(sb894Bill, 999999), null);
});

// ---- session-type classification (CONTROLLER RULING 4) ----------------------------------------

const mo2018SpecialDataset = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-dataset.json`, 'utf8')).dataset;
const mo2018Special2Dataset = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-dataset-1608.json`, 'utf8')).dataset;
const moSessions = JSON.parse(readFileSync(`${FIXDIR}/mo-sessions.json`, 'utf8')).sessions;
const mo2026Regular = moSessions.find((s) => s.session_id === 2239);

test('isLegiscanRegularSession: both REAL dataset fixtures (1579/1608) are Special Sessions', () => {
  assert.equal(isLegiscanRegularSession(mo2018SpecialDataset), false);
  assert.equal(isLegiscanRegularSession(mo2018Special2Dataset), false);
});

test('isLegiscanRegularSession: the REAL 2026 Regular Session (session_id 2239, mo-sessions.json) is Regular', () => {
  assert.ok(mo2026Regular, 'fixture must contain session_id 2239');
  assert.equal(mo2026Regular.year_start, 2026);
  assert.equal(isLegiscanRegularSession(mo2026Regular), true);
});

test('buildLegiscanSpecialSessionIdentifier: distinct identifiers for the two REAL 2018 Special Sessions, never colliding with the bare year or each other', () => {
  const id1579 = buildLegiscanSpecialSessionIdentifier(mo2018SpecialDataset);
  const id1608 = buildLegiscanSpecialSessionIdentifier(mo2018Special2Dataset);
  assert.equal(id1579, '2018-special-1579');
  assert.equal(id1608, '2018-special-1608');
  assert.notEqual(id1579, id1608);
  assert.notEqual(id1579, '2018');
});

// ---- ensureLegiscanSessionRow (CONTROLLER RULING 4, binding) -----------------------------------
//
// Seeded with the REAL live prod state (task-1-report.md's pre-flight probe, verbatim):
// identifiers '2018'/'2022' (bare-year, mo-senate-web/OpenStates) and '261' (mo-house-xml's own
// session id, name "2026 2nd Regular, 103rd General Assembly", 2,099 bills attached — abbreviated
// here to a small fake row since bill COUNT is irrelevant to session-matching logic).
function seedProdSessions() {
  return [
    {
      id: 'sess-2018', jurisdiction_id: 'mo-legislature', identifier: '2018', name: '2018 Regular Session', legiscan_session_id: null,
    },
    {
      id: 'sess-2022', jurisdiction_id: 'mo-legislature', identifier: '2022', name: '2022 Regular Session', legiscan_session_id: null,
    },
    {
      id: 'sess-261', jurisdiction_id: 'mo-legislature', identifier: '261', name: '2026 2nd Regular, 103rd General Assembly', legiscan_session_id: null,
    },
  ];
}

test('ensureLegiscanSessionRow: a Regular Session for a year that ALREADY has a bare-year row (2018) dedupes onto it — never mints a duplicate', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  const regular2018 = {
    session_id: 1530, year_start: 2018, special: 0, session_tag: 'Regular Session', session_title: '2018 Regular Session', session_name: '2018 Regular Session',
  };
  const result = await ensureLegiscanSessionRow(client, regular2018);
  assert.equal(result.id, 'sess-2018');
  assert.equal(result.identifier, '2018');
  assert.equal(tables.sessions.length, 3, 'no new row created');
  assert.equal(tables.sessions.find((s) => s.id === 'sess-2018').legiscan_session_id, 1530);
});

test('ensureLegiscanSessionRow: CONTROLLER RULING 4 — the REAL 2026 Regular Session (session_id 2239) resolves onto the EXISTING \'261\' row via year+name mapping, never mints a duplicate \'2026\' row', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  const result = await ensureLegiscanSessionRow(client, mo2026Regular);
  assert.equal(result.id, 'sess-261');
  assert.equal(result.identifier, '261');
  assert.equal(tables.sessions.length, 3, 'no new \'2026\' row was created');
  assert.equal(tables.sessions.find((s) => s.id === 'sess-261').legiscan_session_id, 2239);
  assert.equal(tables.sessions.some((s) => s.identifier === '2026'), false);
});

test('ensureLegiscanSessionRow: a genuinely new Regular Session year (no existing bare-year or name-matching row) creates a fresh bare-year row', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  const regular2024 = {
    session_id: 2122, year_start: 2024, special: 0, session_tag: 'Regular Session', session_title: '2024 Regular Session', session_name: '2024 Regular Session',
  };
  const result = await ensureLegiscanSessionRow(client, regular2024);
  assert.equal(result.identifier, '2024');
  assert.equal(result.created, true);
  assert.equal(tables.sessions.length, 4);
  assert.equal(tables.sessions.find((s) => s.identifier === '2024').legiscan_session_id, 2122);
});

test('ensureLegiscanSessionRow: two same-year name-matching candidates is genuinely ambiguous — fails loud, never guesses', async () => {
  const seeded = [
    ...seedProdSessions(),
    {
      id: 'sess-extra', jurisdiction_id: 'mo-legislature', identifier: 'extra-2026-row', name: '2026 Special Legislative Something', legiscan_session_id: null,
    },
  ];
  const { client } = makeFakeLegiscanClient({ sessions: seeded });
  await assert.rejects(
    () => ensureLegiscanSessionRow(client, mo2026Regular),
    AmbiguousLegiscanSessionMatchError,
  );
});

test('ensureLegiscanSessionRow: BOTH real 2018 Special Sessions get distinct identifiers, never colliding with the \'2018\' bare-year row or each other', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  const r1579 = await ensureLegiscanSessionRow(client, mo2018SpecialDataset);
  const r1608 = await ensureLegiscanSessionRow(client, mo2018Special2Dataset);
  assert.equal(r1579.identifier, '2018-special-1579');
  assert.equal(r1608.identifier, '2018-special-1608');
  assert.notEqual(r1579.id, r1608.id);
  assert.equal(tables.sessions.length, 5, '2 new special rows alongside the 3 seeded prod rows');
  assert.equal(tables.sessions.find((s) => s.identifier === '2018').legiscan_session_id, null, 'the bare-year 2018 row is untouched by either special session');
});

test('ensureLegiscanSessionRow: a Special session row this driver itself minted never falsely matches a LATER Regular-session year+name search for the same year (false-ambiguity guard)', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  // Ingest BOTH real 2018 Specials first (their own `name` fields both start with "2018", same as
  // any Regular-session year+name candidate search for 2018 would look for).
  await ensureLegiscanSessionRow(client, mo2018SpecialDataset);
  await ensureLegiscanSessionRow(client, mo2018Special2Dataset);
  assert.equal(tables.sessions.length, 5);

  // Now a (synthetic) Regular Session for 2018 that has NOT yet been resolved — the bare-year
  // '2018' row already exists, so this must dedupe onto IT directly, never get confused into
  // thinking the 2 Special rows are ambiguous year+name candidates.
  const anotherRegular2018 = {
    session_id: 999999, year_start: 2018, special: 0, session_tag: 'Regular Session', session_title: '2018 Regular Session', session_name: '2018 Regular Session',
  };
  const result = await ensureLegiscanSessionRow(client, anotherRegular2018);
  assert.equal(result.id, 'sess-2018');
  assert.equal(tables.sessions.length, 5, 'no new row, no false ambiguity error');
});

test('ensureLegiscanSessionRow: idempotent repeat — a session already carrying its own legiscan_session_id takes the exact-key fast path, no year/name matching re-run', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  await ensureLegiscanSessionRow(client, mo2026Regular);
  const result = await ensureLegiscanSessionRow(client, mo2026Regular);
  assert.equal(result.reason, 'exact_key');
  assert.equal(result.id, 'sess-261');
  assert.equal(tables.sessions.length, 3, 'still no duplicate row on the repeat call');
});

test('ensureLegiscanSessionRow: a row already carrying a DIFFERENT legiscan_session_id is a hard conflict, never silently overwritten', async () => {
  const seeded = seedProdSessions();
  seeded[2].legiscan_session_id = 1111; // '261' already claimed by a different (synthetic) session
  const { client } = makeFakeLegiscanClient({ sessions: seeded });
  await assert.rejects(
    () => ensureLegiscanSessionRow(client, mo2026Regular),
    LegiscanSessionIdentityConflictError,
  );
});

// ---- budget gate (brief step 1) ----------------------------------------------------------------
//
// Reuses the same fake-ingestion_runs-client shape as tests/legiscan-client.test.js's
// makeFakeIngestionRunsClient (paginated .range()-based), proving the DRIVER's own composition
// (getMonthlyQueryUsage -> assertUnderBudget) refuses correctly, not just the underlying pure
// functions (already unit-tested in legiscan.js's own suite).

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

test('assertRunUnderBudget: refuses (QueryBudgetExceededError) when this run\'s planned queries would reach or exceed the configured cap — BEFORE any live call', async () => {
  const client = makeFakeUsageClient([
    { id: '1', source: 'legiscan', started_at: new Date().toISOString(), detail: { queries_used: 4998 } },
  ]);
  await assert.rejects(
    () => assertRunUnderBudget(client, { plannedQueries: 2, capPerMonth: 5000 }),
    (err) => {
      assert.ok(err instanceof QueryBudgetExceededError);
      assert.equal(err.usage, 4998);
      assert.equal(err.plannedQueries, 2);
      assert.equal(err.projected, 5000);
      return true;
    },
  );
});

test('assertRunUnderBudget: does not throw with real headroom, and honors an explicit capPerMonth over the env default', async () => {
  const client = makeFakeUsageClient([]);
  const result = await assertRunUnderBudget(client, { plannedQueries: 2, capPerMonth: 100 });
  assert.deepEqual(result, { usage: 0, plannedQueries: 2, capPerMonth: 100 });
});

// ---- resolveDatasetBytes: hash gate + local cache + write-ahead query accounting (CONTROLLER
// RULINGS 2, 3, 9) — every live call here is an injected fake, zero real network/DB. -------------

test('resolveDatasetBytes: no ledger row -> fetches live (both queries), writes the ledger + local cache', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client, tables } = makeFakeLegiscanClient();
    const events = [];
    const getDatasetListFn = async () => {
      events.push('getDatasetList');
      return [{ session_id: 1608, dataset_hash: mo2018Special2Dataset.dataset_hash, access_key: 'ak-1608' }];
    };
    const getDatasetFn = async (sessionId, accessKey) => {
      events.push('getDataset');
      assert.equal(sessionId, 1608);
      assert.equal(accessKey, 'ak-1608');
      return mo2018Special2Dataset;
    };
    const detail = { queries_used: 0 };
    const result = await resolveDatasetBytes(client, 'run-1', 1608, {
      getDatasetListFn, getDatasetFn, apiKey: 'k', cacheDir: dir, detail,
    });
    assert.equal(result.gate.shouldFetch, true);
    assert.equal(result.gate.reason, 'never_fetched');
    assert.equal(result.datasetEnvelope.session_id, 1608);
    assert.equal(detail.queries_used, 2);
    assert.deepEqual(events, ['getDatasetList', 'getDataset']);
    assert.equal(tables.legiscan_datasets.length, 1);
    assert.equal(tables.legiscan_datasets[0].dataset_hash, mo2018Special2Dataset.dataset_hash);
  });
});

test('resolveDatasetBytes: hash unchanged -> skips getDataset entirely (1 query only), reads the local cache instead', async () => {
  await withScratchDirAsync(async (dir) => {
    const cachePath = join(dir, 'cached-1608.json');
    writeFileSync(cachePath, JSON.stringify(mo2018Special2Dataset));
    const { client } = makeFakeLegiscanClient({
      legiscan_datasets: [{
        legiscan_session_id: 1608, dataset_hash: mo2018Special2Dataset.dataset_hash, local_cache_path: cachePath, fetched_at: 'earlier', run_id: 'run-0',
      }],
    });
    const getDatasetListFn = async () => [{ session_id: 1608, dataset_hash: mo2018Special2Dataset.dataset_hash, access_key: 'ak-1608' }];
    const getDatasetFn = async () => { throw new Error('must not fetch live on a hash-unchanged gate'); };
    const detail = { queries_used: 0 };
    const result = await resolveDatasetBytes(client, 'run-1', 1608, {
      getDatasetListFn, getDatasetFn, apiKey: 'k', cacheDir: dir, detail,
    });
    assert.equal(result.gate.shouldFetch, false);
    assert.equal(result.gate.reason, 'hash_unchanged');
    assert.equal(result.datasetEnvelope.session_id, 1608);
    assert.equal(detail.queries_used, 1, 'only the getDatasetList query was spent');
  });
});

test('resolveDatasetBytes: CONTROLLER RULING 2 — a post-fetch hash mismatch throws DatasetHashMismatchError and never returns the mismatched dataset', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = makeFakeLegiscanClient();
    const getDatasetListFn = async () => [{ session_id: 1608, dataset_hash: 'stale-claimed-hash', access_key: 'ak-1608' }];
    const getDatasetFn = async () => mo2018Special2Dataset; // its OWN in-archive hash.md5 is f07c2e26... not 'stale-claimed-hash'
    const detail = { queries_used: 0 };
    await assert.rejects(
      () => resolveDatasetBytes(client, 'run-1', 1608, {
        getDatasetListFn, getDatasetFn, apiKey: 'k', cacheDir: dir, detail,
      }),
      (err) => {
        assert.ok(err instanceof DatasetHashMismatchError);
        assert.equal(err.expected, 'stale-claimed-hash');
        assert.equal(err.actual, mo2018Special2Dataset.dataset_hash);
        return true;
      },
    );
  });
});

test('resolveDatasetBytes: CONTROLLER RULING 3 — write-ahead query accounting persists BEFORE each live call resolves, never only at the end', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client, tables } = makeFakeLegiscanClient();
    const events = [];
    const getDatasetListFn = async () => {
      // At the moment this fake "network call" fires, the write-ahead update for query #1 must
      // ALREADY be visible in ingestion_runs — proving the persist happens before the call, not after.
      assert.equal(tables.ingestion_runs.find((r) => r.id === 'run-1')?.detail?.queries_used, 1);
      events.push('getDatasetList');
      return [{ session_id: 1608, dataset_hash: mo2018Special2Dataset.dataset_hash, access_key: 'ak-1608' }];
    };
    const getDatasetFn = async () => {
      assert.equal(tables.ingestion_runs.find((r) => r.id === 'run-1')?.detail?.queries_used, 2);
      events.push('getDataset');
      return mo2018Special2Dataset;
    };
    tables.ingestion_runs.push({ id: 'run-1', source: 'legiscan', status: 'running', detail: {} });
    const detail = { queries_used: 0 };
    await resolveDatasetBytes(client, 'run-1', 1608, {
      getDatasetListFn, getDatasetFn, apiKey: 'k', cacheDir: dir, detail,
    });
    assert.deepEqual(events, ['getDatasetList', 'getDataset']);
    assert.equal(tables.ingestion_runs.find((r) => r.id === 'run-1').detail.queries_used, 2);
  });
});

// ---- runLegiscanIngest: end-to-end via --dataset-file, BOTH real fixtures (CONTROLLER RULING 11) ----

test('runLegiscanIngest: session 1579 (ZERO votes) end-to-end — real numbers, zero live queries, zero quarantines', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  tables.ingestion_runs.push({ id: 'run-1579', source: 'legiscan', status: 'running', detail: {} });
  const result = await runLegiscanIngest(client, 'run-1579', { datasetFile: `${FIXDIR}/mo-2018-dataset.json`, session: null, limit: null });

  assert.equal(result.counts.sessions, 1);
  assert.equal(result.counts.bills, 18);
  assert.equal(result.counts.votes, 0);
  assert.equal(result.counts.casts, 0);
  assert.equal(result.counts.reconciliationFailures, 0);
  assert.equal(result.counts.quarantinedVotes, 0);
  assert.equal(result.counts.queriesUsed, 0, '--dataset-file spends zero live LegiScan queries');
  assert.equal(result.counts.parseFailures, 0);
  // 3 real people in the 1579 fixture, DB starts empty -> all 3 created as new legislators rows.
  assert.deepEqual(result.counts.people, {
    matched: 0, created: 3, ambiguous: 0, gated: 0,
  });
  assert.equal(tables.bills.length, 18);
  assert.equal(tables.legislators.length, 3);
  assert.equal(tables.votes.length, 0);
  // Session dedupes onto the existing bare-year '2018' row (special session -> distinct identifier).
  assert.equal(result.counts.session.identifier, '2018-special-1579');
});

test('runLegiscanIngest: session 1608 (8 REAL roll calls) end-to-end — exact real numbers through identity + votes + casts', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  tables.ingestion_runs.push({ id: 'run-1608', source: 'legiscan', status: 'running', detail: {} });
  const result = await runLegiscanIngest(client, 'run-1608', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });

  assert.equal(result.counts.bills, 9);
  assert.deepEqual(result.counts.people, {
    matched: 0, created: 189, ambiguous: 0, gated: 0,
  });
  assert.equal(result.counts.reconciliationFailures, 0, 'all 8 real roll calls reconcile internally (already proven in legiscan-votes.test.js)');
  assert.equal(result.counts.votes, 8, 'no primary-source rows exist in this fake DB, so nothing is quarantined — all 8 store');
  assert.equal(result.counts.quarantinedVotes, 0);
  // 6 house roll calls x 156 + 2 senate roll calls x 33 = 1002 total casts (legiscan-votes.test.js's
  // own corpus count), every one resolved since ensureLegiscanPeople resolved all 189 real people.
  assert.equal(result.counts.casts, 1002);
  assert.equal(result.counts.unresolvedCasts.count, 0);
  assert.deepEqual(result.counts.votesByChamber, { house: 6, senate: 2 });
  assert.equal(result.counts.queriesUsed, 0);
  assert.equal(tables.votes.length, 8);
  assert.equal(tables.vote_casts.length, 1002);
  assert.equal(result.counts.session.identifier, '2018-special-1608');

  // Provenance: every written vote's source_key follows buildLegiscanVoteSourceKey's scheme, and
  // source_url is populated from the parent bill's own votes[] entry (Rulings 5/10) — spot-check
  // roll call 774312 (HB3, house, 2018-09-12).
  const v774312 = tables.votes.find((v) => v.source_key === 'legiscan-1608-rollcall-774312');
  assert.ok(v774312);
  assert.equal(v774312.chamber, 'house');
  assert.equal(v774312.vote_date, '2018-09-12');
  assert.equal(v774312.result, '119-23');
  assert.ok(v774312.source_url, 'source_url must be populated from the parent bill\'s votes[] entry');
  assert.match(v774312.source_url, /^https:\/\//);
});

test('runLegiscanIngest: --limit caps the number of roll calls processed, without affecting bills/people ensure', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  tables.ingestion_runs.push({ id: 'run-limit', source: 'legiscan', status: 'running', detail: {} });
  const result = await runLegiscanIngest(client, 'run-limit', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: 3 });
  assert.equal(result.counts.rollCallsPlanned, 8);
  assert.equal(result.counts.rollCallsProcessed, 3);
  assert.equal(result.counts.votes, 3);
  assert.equal(result.counts.bills, 9, 'bills ensure is unaffected by --limit');
  assert.deepEqual(result.counts.people.created, 189, 'people ensure is unaffected by --limit');
});

// ---- CONTROLLER RULING 1: quarantine ordering, proven at the DRIVER composition level (not just
// inside legiscan-votes.js's own unit tests) — a hard (yea) mismatch against a pre-existing
// primary-source vote must mean the LegiScan vote/casts are NEVER written, while every OTHER real
// roll call in the SAME run still writes normally. ----------------------------------------------

test('runLegiscanIngest: CONTROLLER RULING 1 — a hard tally mismatch against an existing primary-source vote quarantines THAT roll call only; the other 7 real roll calls still store normally', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  tables.ingestion_runs.push({ id: 'run-quarantine', source: 'legiscan', status: 'running', detail: {} });

  // Roll call 774411 (HB3, SENATE, 2018-09-14 — real tallies yea=28/nay=1/absent=4/total=33, per
  // legiscan-votes.test.js's own EXPECTED_TALLIES) is deliberately chosen over the more obvious
  // 774312: HB3 has FIVE house roll calls sharing the exact same (bill, chamber, date) tuple
  // (774312-774316, all house/2018-09-12 — the real same-day-multi-roll-call fixture Task 6's
  // review found) — seeding one primary-source row for THAT tuple would make every one of those 5
  // LegiScan roll calls see the same single candidate and get compared against it, quarantining
  // more than the one under test. 774411 is the ONLY roll call for (HB3, senate, 2018-09-14), so
  // seeding one primary-source row for it isolates the effect to exactly this one roll call.

  // Phase 1: run once against an empty primary source to learn the real (fake) bill row id —
  // insertIfAbsent/additivePatch make a second pass fully idempotent, exactly how a resumed real
  // run would behave anyway.
  await runLegiscanIngest(client, 'run-quarantine', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });
  const hb3BillRow = tables.bills.find((b) => b.identifier === 'HB 3');
  assert.ok(hb3BillRow);

  const primaryVoteId = 'primary-hb3-senate-doctored';
  tables.votes.push({
    id: primaryVoteId, bill_id: hb3BillRow.id, jurisdiction_id: 'mo-legislature', chamber: 'senate', vote_date: '2018-09-14', source_key: 'mo-senate-web-2018-x-vote1',
  });
  for (let i = 0; i < 20; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'yea' }); // real is 28 -> hard mismatch
  for (let i = 0; i < 1; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'nay' }); // matches
  for (let i = 0; i < 4; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'absent' }); // bucket matches too — ONLY yea disagrees

  // Reset whatever LegiScan itself wrote on pass 1, and re-run — proving the SAME pipeline that
  // just stored 8 votes cleanly now quarantines exactly one of them once a contradicting
  // primary-source row exists for it.
  tables.votes.splice(0, tables.votes.length, ...tables.votes.filter((v) => v.id === primaryVoteId));
  tables.vote_casts.splice(0, tables.vote_casts.length, ...tables.vote_casts.filter((c) => c.vote_id === primaryVoteId));

  const result = await runLegiscanIngest(client, 'run-quarantine', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });

  assert.equal(result.counts.quarantinedVotes, 1);
  assert.deepEqual(result.counts.quarantinedRollCalls.map((q) => q.rollCallId), [774411]);
  assert.equal(result.counts.votes, 7, 'the other 7 real roll calls still store normally in the SAME run');
  assert.equal(tables.votes.some((v) => v.source_key === 'legiscan-1608-rollcall-774411'), false, 'the quarantined LegiScan vote is NEVER written');
  assert.equal(tables.votes.some((v) => v.source_key === 'legiscan-1608-rollcall-774312'), true, 'the SAME-DAY house roll calls sharing HB3 are untouched — never collateral-quarantined');
  assert.equal(tables.vote_casts.some((c) => c.vote_id && tables.votes.find((v) => v.id === c.vote_id)?.source_key === 'legiscan-1608-rollcall-774411'), false, 'no casts for the quarantined vote either');
  assert.equal(result.counts.crossCheckFlags.total, 1);
  assert.equal(tables.vote_reconciliation_flags.length, 1);
  assert.equal(tables.vote_reconciliation_flags[0].discrepancy.quarantine, true);
});

// ---- FIX ROUND (review finding, disclosed): the test above deliberately picked roll call 774411
// specifically BECAUSE seeding a single primary-source row for HB3/house/2018-09-12 would have
// made ALL FIVE same-day house roll calls (774312-774316) see that same one candidate and,
// pre-fix, get compared against it independently — collaterally quarantining up to 4 roll calls
// that were never actually contradicted, not just the one under test. That was a real gap in
// crossCheckAgainstPrimarySource (src/adapters/legiscan-votes.js), found while writing that very
// test, and worked around in the test rather than fixed or disclosed. Fixed now (siblingTallies
// parameter, mirroring legiscan-votes.js's own FIX ROUND 2 in the opposite direction) — these two
// tests exercise the ONE-primary/FIVE-legiscan tuple directly, through the full driver, the exact
// scenario the original test avoided. ----------------------------------------------------------

test('runLegiscanIngest: FIX ROUND — one primary row seeded with 774312\'s TRUE tallies, against ALL FIVE real same-day HB3 house roll calls -> 774312 verifies cleanly, the other 4 store uncorresponded, ZERO collateral quarantine (the scenario the earlier 774411 test deliberately routed around)', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  tables.ingestion_runs.push({ id: 'run-sibling-verify', source: 'legiscan', status: 'running', detail: {} });

  await runLegiscanIngest(client, 'run-sibling-verify', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });
  const hb3BillRow = tables.bills.find((b) => b.identifier === 'HB 3');
  assert.ok(hb3BillRow);

  const primaryVoteId = 'primary-hb3-house-true-774312';
  tables.votes.push({
    id: primaryVoteId, bill_id: hb3BillRow.id, jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
  });
  for (let i = 0; i < 119; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'yea' }); // 774312's REAL tallies, exactly
  for (let i = 0; i < 23; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'nay' });
  for (let i = 0; i < 14; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'absent' });

  tables.votes.splice(0, tables.votes.length, ...tables.votes.filter((v) => v.id === primaryVoteId));
  tables.vote_casts.splice(0, tables.vote_casts.length, ...tables.vote_casts.filter((c) => c.vote_id === primaryVoteId));

  const result = await runLegiscanIngest(client, 'run-sibling-verify', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });

  assert.equal(result.counts.quarantinedVotes, 0, 'ZERO collateral quarantine — this is the entire point of the fix');
  assert.equal(result.counts.votes, 8, 'all 8 real roll calls store, including the 4 that merely share the tuple without corresponding to the primary');
  assert.equal(result.counts.crossCheckFlags.total, 0, 'the one genuine correspondence verifies cleanly (no flag); the other 4 are honestly uncorresponded (no flag) — nothing here is actually contradicted');
  assert.equal(result.counts.crossCheckFlags.tally_unique_match, 1);
  assert.equal(tables.vote_reconciliation_flags.length, 0);
  for (const rollCallId of [774312, 774313, 774314, 774315, 774316]) {
    assert.equal(tables.votes.some((v) => v.source_key === `legiscan-1608-rollcall-${rollCallId}`), true, `roll call ${rollCallId} must be stored`);
  }
});

test('runLegiscanIngest: FIX ROUND — one primary row matching NONE of the 5 same-day HB3 house roll calls -> every one that checks it gets flagged no_tally_corresponding_primary, still zero quarantine', async () => {
  const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
  tables.ingestion_runs.push({ id: 'run-sibling-nomatch', source: 'legiscan', status: 'running', detail: {} });

  await runLegiscanIngest(client, 'run-sibling-nomatch', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });
  const hb3BillRow = tables.bills.find((b) => b.identifier === 'HB 3');

  const primaryVoteId = 'primary-hb3-house-no-match';
  tables.votes.push({
    id: primaryVoteId, bill_id: hb3BillRow.id, jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2018-09-12', source_key: 'mo-house-xml-HB3-1',
  });
  for (let i = 0; i < 999; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'yea' }); // matches none of 119/36/33/41/96
  for (let i = 0; i < 999; i += 1) tables.vote_casts.push({ vote_id: primaryVoteId, position: 'nay' });

  tables.votes.splice(0, tables.votes.length, ...tables.votes.filter((v) => v.id === primaryVoteId));
  tables.vote_casts.splice(0, tables.vote_casts.length, ...tables.vote_casts.filter((c) => c.vote_id === primaryVoteId));

  const result = await runLegiscanIngest(client, 'run-sibling-nomatch', { datasetFile: `${FIXDIR}/mo-2018-dataset-1608.json`, session: null, limit: null });

  assert.equal(result.counts.quarantinedVotes, 0, 'no assertable 1:1 correspondence anywhere in the group -> never quarantine');
  assert.equal(result.counts.votes, 8);
  assert.equal(result.counts.crossCheckFlags.no_tally_corresponding_primary, 5, 'all 5 same-day house roll calls independently flag against the one non-matching primary row');
  assert.equal(tables.vote_reconciliation_flags.length, 5);
  assert.ok(tables.vote_reconciliation_flags.every((f) => f.discrepancy.reason === 'no_tally_corresponding_primary'));
});

test('runLegiscanIngest: FIX ROUND — two synthetic same-tuple roll calls sharing IDENTICAL tallies against one matching primary row -> both genuinely ambiguous, both flagged ambiguous_tally_match, still zero quarantine (closes the driver-level gap for this branch, not left as unit-tested-only)', async () => {
  await withScratchDirAsync(async (dir) => {
    const path = join(dir, 'ambiguous.json');
    writeFileSync(path, JSON.stringify({
      status: 'OK',
      dataset: {
        session_id: 99002, year_start: 2019, year_end: 2019, special: 1, session_tag: '1st Special Session', session_title: '2019 1st Special Session', session_name: '2019 1st Extraordinary Session', dataset_hash: 'x', zip: buildAmbiguousSyntheticZipBase64(),
      },
    }));
    const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
    tables.ingestion_runs.push({ id: 'run-ambiguous', source: 'legiscan', status: 'running', detail: {} });

    await runLegiscanIngest(client, 'run-ambiguous', { datasetFile: path, session: null, limit: null });
    const hb1BillRow = tables.bills.find((b) => b.identifier === 'HB 1');
    assert.ok(hb1BillRow);

    const primaryVoteId = 'primary-hb1-matches-both';
    tables.votes.push({
      id: primaryVoteId, bill_id: hb1BillRow.id, jurisdiction_id: 'mo-legislature', chamber: 'house', vote_date: '2019-02-01', source_key: 'mo-house-xml-HB1-1',
    });
    tables.vote_casts.push({ vote_id: primaryVoteId, position: 'yea' }); // 1 yea, 0 nay — matches BOTH 601 and 602 exactly
    tables.vote_casts.push({ vote_id: primaryVoteId, position: 'absent' });

    tables.votes.splice(0, tables.votes.length, ...tables.votes.filter((v) => v.id === primaryVoteId));
    tables.vote_casts.splice(0, tables.vote_casts.length, ...tables.vote_casts.filter((c) => c.vote_id === primaryVoteId));

    const result = await runLegiscanIngest(client, 'run-ambiguous', { datasetFile: path, session: null, limit: null });

    assert.equal(result.counts.quarantinedVotes, 0, 'ambiguity is never grounds to quarantine — both candidates AGREE with the primary, it\'s which one corresponds that\'s unresolved');
    assert.equal(result.counts.votes, 2, 'both roll calls store');
    assert.equal(result.counts.crossCheckFlags.ambiguous_tally_match, 2, 'BOTH roll calls independently discover the ambiguity from their own perspective');
    assert.equal(tables.vote_reconciliation_flags.length, 2);
    assert.ok(tables.vote_reconciliation_flags.every((f) => f.discrepancy.reason === 'ambiguous_tally_match'));
    assert.deepEqual(
      tables.vote_reconciliation_flags[0].discrepancy.matching_legiscan_roll_calls.map((c) => c.roll_call_id).sort(),
      [601, 602],
    );
  });
});

// ---- vote_id 3 spot-verify sample (CONTROLLER RULING 8) — real fixtures have zero vote_id 3
// casts (legiscan-votes.test.js's own corpus proof), so this proves the SAMPLING MECHANISM itself
// on a synthetic roll call rather than claiming a live sighting that doesn't exist in any fixture. --

// buildSyntheticZipBase64 — a minimal hand-built STORED-entries ZIP (same technique as
// legiscan-dataset.test.js's own buildStoredZip, reused here rather than re-implemented, since
// that file does not export it) containing exactly one bill/ and one vote/ entry, with a
// vote_id:3 cast — proves checkVoteId3Sighting's sampling mechanism end-to-end through the real
// decode/extract/reconcile pipeline, not just as an isolated unit.
function buildSyntheticZipBase64() {
  const entries = [
    { name: 'MO/99001/bill/HB1.json', data: Buffer.from(JSON.stringify({ bill: { bill_id: 1, bill_number: 'HB1', title: 't', status: 1, url: 'https://legiscan.com/x', votes: [{ roll_call_id: 501, url: 'https://legiscan.com/rc/501', state_link: 'https://mo.gov/rc/501' }] } })) },
    {
      name: 'MO/99001/vote/501.json',
      data: Buffer.from(JSON.stringify({
        roll_call: {
          roll_call_id: 501, bill_id: 1, date: '2019-01-01', desc: 'test', yea: 1, nay: 0, nv: 1, absent: 0, total: 2, passed: 1, chamber: 'H', chamber_id: 1, votes: [{ people_id: 1, vote_id: 1, vote_text: 'Yea' }, { people_id: 2, vote_id: 3, vote_text: 'Not Voting' }],
        },
      })),
    },
    { name: 'MO/99001/people/1.json', data: Buffer.from(JSON.stringify({ person: { people_id: 1, name: 'A One', first_name: 'A', last_name: 'One', role: 'Rep', district: 'HD-001', party: 'R' } })) },
    { name: 'MO/99001/people/2.json', data: Buffer.from(JSON.stringify({ person: { people_id: 2, name: 'B Two', first_name: 'B', last_name: 'Two', role: 'Rep', district: 'HD-002', party: 'D' } })) },
    { name: 'MO/99001/hash.md5', data: Buffer.from('x') },
  ];
  return buildStoredZip(entries).toString('base64');
}

// buildAmbiguousSyntheticZipBase64 — FIX ROUND (disclosed gap, closed rather than left open): the
// real fixtures have no two roll calls sharing identical tallies (needed to exercise
// ambiguous_tally_match through the driver's own sibling-grouping mechanism, not just as an
// isolated legiscan-votes.test.js unit test) — a hand-built synthetic dataset with two roll calls
// on the SAME bill/chamber/date, DELIBERATELY given the exact same (yea, nay), closes that gap.
function buildAmbiguousSyntheticZipBase64() {
  const entries = [
    {
      name: 'MO/99002/bill/HB1.json',
      data: Buffer.from(JSON.stringify({
        bill: {
          bill_id: 1, bill_number: 'HB1', title: 't', status: 1, url: 'https://legiscan.com/x', votes: [{ roll_call_id: 601, url: 'https://legiscan.com/rc/601', state_link: 'https://mo.gov/rc/601' }, { roll_call_id: 602, url: 'https://legiscan.com/rc/602', state_link: 'https://mo.gov/rc/602' }],
        },
      })),
    },
    {
      name: 'MO/99002/vote/601.json',
      data: Buffer.from(JSON.stringify({
        roll_call: {
          roll_call_id: 601, bill_id: 1, date: '2019-02-01', desc: 'RC A', yea: 1, nay: 0, nv: 0, absent: 1, total: 2, passed: 1, chamber: 'H', chamber_id: 1, votes: [{ people_id: 1, vote_id: 1, vote_text: 'Yea' }, { people_id: 2, vote_id: 4, vote_text: 'Absent' }],
        },
      })),
    },
    {
      name: 'MO/99002/vote/602.json',
      data: Buffer.from(JSON.stringify({
        // Deliberately IDENTICAL (yea, nay) to 601 — different voters, same head count.
        roll_call: {
          roll_call_id: 602, bill_id: 1, date: '2019-02-01', desc: 'RC B', yea: 1, nay: 0, nv: 0, absent: 1, total: 2, passed: 1, chamber: 'H', chamber_id: 1, votes: [{ people_id: 3, vote_id: 1, vote_text: 'Yea' }, { people_id: 4, vote_id: 4, vote_text: 'Absent' }],
        },
      })),
    },
    { name: 'MO/99002/people/1.json', data: Buffer.from(JSON.stringify({ person: { people_id: 1, name: 'A One', first_name: 'A', last_name: 'One', role: 'Rep', district: 'HD-001', party: 'R' } })) },
    { name: 'MO/99002/people/2.json', data: Buffer.from(JSON.stringify({ person: { people_id: 2, name: 'B Two', first_name: 'B', last_name: 'Two', role: 'Rep', district: 'HD-002', party: 'D' } })) },
    { name: 'MO/99002/people/3.json', data: Buffer.from(JSON.stringify({ person: { people_id: 3, name: 'C Three', first_name: 'C', last_name: 'Three', role: 'Rep', district: 'HD-003', party: 'R' } })) },
    { name: 'MO/99002/people/4.json', data: Buffer.from(JSON.stringify({ person: { people_id: 4, name: 'D Four', first_name: 'D', last_name: 'Four', role: 'Rep', district: 'HD-004', party: 'D' } })) },
    { name: 'MO/99002/hash.md5', data: Buffer.from('x') },
  ];
  return buildStoredZip(entries).toString('base64');
}

// Minimal in-memory ZIP builder (STORED/uncompressed entries only), same PKZIP-record-writing
// technique as legiscan-dataset.test.js's buildStoredZip (not imported — that file does not
// export it, and this is a small, self-contained, well-precedented technique to duplicate rather
// than reach across a test file boundary for).
function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, nameBuf, data]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    const centralEntry = Buffer.concat([central, nameBuf]);
    centralParts.push(centralEntry);

    offset += localEntry.length;
  }
  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localSection, centralSection, eocd]);
}

test('runLegiscanIngest: synthetic roll call with a vote_id 3 cast — reconciles cleanly, and voteId3SpotVerify records it for human spot-verification', async () => {
  await withScratchDirAsync(async (dir) => {
    const path = join(dir, 'synthetic.json');
    writeFileSync(path, JSON.stringify({
      status: 'OK',
      dataset: {
        session_id: 99001,
        year_start: 2019,
        year_end: 2019,
        special: 1,
        session_tag: '1st Special Session',
        session_title: '2019 1st Special Session',
        session_name: '2019 1st Extraordinary Session',
        dataset_hash: 'x',
        zip: buildSyntheticZipBase64(),
      },
    }));
    const { client, tables } = makeFakeLegiscanClient({ sessions: seedProdSessions() });
    tables.ingestion_runs.push({ id: 'run-vid3', source: 'legiscan', status: 'running', detail: {} });
    const result = await runLegiscanIngest(client, 'run-vid3', { datasetFile: path, session: null, limit: null });
    assert.equal(result.counts.reconciliationFailures, 0, 'vote_id 3 is a recognized, valid position — it must not fail reconciliation');
    assert.equal(result.counts.votes, 1);
    assert.deepEqual(result.counts.voteId3SpotVerify, [{ rollCallId: 501, peopleId: 2, voteText: 'Not Voting' }]);
  });
});

// ---- dryRunReportFromDb / planFromParsedDataset -------------------------------------------------

test('planFromParsedDataset: real 1579 fixture plan matches the manual smoke-test output', async () => {
  const envelope = mo2018SpecialDataset;
  const parsed = await extractDatasetFiles(decodeDatasetZip(envelope.zip));
  const plan = planFromParsedDataset(parsed, envelope);
  assert.deepEqual(plan, {
    session_id: 1579, session_title: '2018 1st Special Session', bills_planned: 18, people_planned: 3, roll_calls_planned: 0, parse_failures: 0, writes: 0,
  });
});

test('dryRunReportFromDb: no --session and no --dataset-file is reported honestly, zero live queries', async () => {
  const { client } = makeFakeLegiscanClient();
  const report = await dryRunReportFromDb(client, null);
  assert.match(report.note, /--session <legiscan_session_id> is required/);
});

test('dryRunReportFromDb: reports ledger + session + vote-count state from the DB alone', async () => {
  const { client, tables } = makeFakeLegiscanClient({
    sessions: [{
      id: 'sess-1', jurisdiction_id: 'mo-legislature', identifier: '2018-special-1608', name: 'x', legiscan_session_id: 1608,
    }],
    legiscan_datasets: [{
      legiscan_session_id: 1608, dataset_hash: 'abc', fetched_at: 't1',
    }],
    votes: [
      { id: 'v1', source_key: 'legiscan-1608-rollcall-1' },
      { id: 'v2', source_key: 'legiscan-1608-rollcall-2' },
      { id: 'v3', source_key: 'mo-house-xml-HB1-1' },
    ],
  });
  const report = await dryRunReportFromDb(client, 1608);
  assert.deepEqual(report.ledger, { dataset_hash: 'abc', fetched_at: 't1' });
  assert.equal(report.session_row.identifier, '2018-special-1608');
  assert.equal(report.counts.votes_total, 2);
  assert.match(report.note, /zero live queries/);
});
