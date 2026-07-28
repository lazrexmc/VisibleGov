import {
  readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJournalIndex } from '../src/adapters/mo-senate-web.js';
import { extractJournalText, parseJournalVotes, resolveMoSenator } from '../src/adapters/mo-senate-journal-pdf.js';
import {
  parseMoSenateArgs, journalPdfBasename, buildVoteSourceKey, buildVoteRow, buildCastTokens,
  pickRosterSource, buildJournalIndexUrl, shouldRefetch,
  MO_SENATE_ROSTER_MAX_AGE_MS, MO_SENATE_INDEX_MAX_AGE_MS,
  readDayFailureArtifact, writeDayFailureArtifact, excludeQuarantinedDays, JOURNAL_DAY_MAX_FAILED_ATTEMPTS,
  hasDoneMarker, writeDoneMarker,
  selectJournalDayWorklist,
  remainingCooldownMs, formatCooldownWait, enforceDurableCooldown, CooldownConvergenceError,
  ensureSessionRow, persistRosterRows, loadSenateRosterForResolution,
  ensureRosterForRun, ensureIndexForRun,
  processJournalDay, replayJournalArtifacts, dryRunReport,
} from '../src/cli/ingest-mo-senate.js';

const FIXTURES = 'tests/fixtures/research/mo-senate';
const day37Pdf = readFileSync(`${FIXTURES}/2018-day37-journal-onder-era.pdf`);
const journalList2018Html = readFileSync(`${FIXTURES}/journallist-2018.html`, 'utf8');

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-mo-senate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withScratchDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'visiblegov-mo-senate-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- parseMoSenateArgs ----

test('parseMoSenateArgs: parses --year/--limit/--dry-run/--journal-pdf-file', () => {
  const args = parseMoSenateArgs(['--year', '2018', '--limit', '3', '--dry-run', '--journal-pdf-file', 'x.pdf']);
  assert.deepEqual(args, {
    year: 2018, limit: 3, dryRun: true, journalPdfFile: 'x.pdf',
  });
});

test('parseMoSenateArgs: default limit is 1, dryRun false, journalPdfFile null', () => {
  const args = parseMoSenateArgs(['--year', '2026']);
  assert.equal(args.limit, 1);
  assert.equal(args.dryRun, false);
  assert.equal(args.journalPdfFile, null);
});

test('parseMoSenateArgs: throws when --year is missing', () => {
  assert.throws(() => parseMoSenateArgs([]), /--year <Y> is required/);
});

test('parseMoSenateArgs: throws on an unknown flag', () => {
  assert.throws(() => parseMoSenateArgs(['--year', '2018', '--bogus']), /unknown flag: --bogus/);
});

// ---- source_key construction (CONTROLLER RULING 1) ----

test('journalPdfBasename: real journal URL basename, extension stripped', () => {
  assert.equal(
    journalPdfBasename('https://www.senate.mo.gov/18info/Journals/RDay370308587-610.pdf'),
    'RDay370308587-610',
  );
});

test('journalPdfBasename: a local fixture path (dry-run --journal-pdf-file case)', () => {
  assert.equal(
    journalPdfBasename('tests/fixtures/research/mo-senate/2018-day37-journal-onder-era.pdf'),
    '2018-day37-journal-onder-era',
  );
});

test('journalPdfBasename: strips a query string, uppercase extension', () => {
  assert.equal(journalPdfBasename('https://x/DAY39.PDF?v=2'), 'DAY39');
});

test('journalPdfBasename: two different day URLs sharing the same day_label still yield distinct basenames (the actual dedup bug ruling 1 fixes)', () => {
  // 2018's Veto Session reuses "Day 01" (progress.md) — the day_label alone is not unique, but the
  // journal PDF's own filename is.
  const a = journalPdfBasename('https://www.senate.mo.gov/18info/Journals/RDay010101001-002.pdf');
  const b = journalPdfBasename('https://www.senate.mo.gov/18info/Journals/RDay010912345-346.pdf');
  assert.notEqual(a, b);
});

test('buildVoteSourceKey: exact format mo-senate-web-<year>-<pdf-basename>-vote<ordinal>', () => {
  assert.equal(
    buildVoteSourceKey(2018, 'RDay370308587-610', 6),
    'mo-senate-web-2018-RDay370308587-610-vote6',
  );
});

// ---- vote row shape: result-null rule + vote_date sourcing (CONTROLLER RULING 3) ----

test('buildVoteRow: result is always null, regardless of tallies or motion content', () => {
  const dayRow = { journal_url: 'https://x/RDay1.pdf', journal_date: '2018-03-08', pdf_basename: 'RDay1' };
  const vote = {
    ordinal: 1, motion: 'SB 1 was read the 3rd time and passed by the following vote:', bill_refs: ['SB 1'],
  };
  const row = buildVoteRow({
    billId: 'bill-1', year: 2018, dayRow, vote, runId: 'run-1',
  });
  assert.equal(row.result, null);
});

test('buildVoteRow: vote_date comes from the day row\'s journal_date, never guessed from the pdf_basename', () => {
  const dayRow = { journal_url: 'https://x/RDay370308587-610.pdf', journal_date: '2018-03-08', pdf_basename: 'RDay370308587-610' };
  const vote = { ordinal: 6, motion: 'm', bill_refs: ['SB 894'] };
  const row = buildVoteRow({
    billId: 'bill-1', year: 2018, dayRow, vote, runId: 'run-1',
  });
  assert.equal(row.vote_date, '2018-03-08');
});

test('buildVoteRow: a day row with no journal_date yields a null vote_date, never a filename-derived guess', () => {
  const dayRow = { journal_url: 'https://x/RDay1.pdf', journal_date: null, pdf_basename: 'RDay1' };
  const vote = { ordinal: 1, motion: 'm', bill_refs: ['SB 1'] };
  const row = buildVoteRow({
    billId: 'bill-1', year: 2018, dayRow, vote, runId: 'run-1',
  });
  assert.equal(row.vote_date, null);
});

test('buildVoteRow: full row shape matches ingest-mo-house.js\'s votes column set (CONTROLLER RULING 8)', () => {
  const dayRow = { journal_url: 'https://x/RDay1.pdf', journal_date: '2018-03-08', pdf_basename: 'RDay1' };
  const vote = { ordinal: 1, motion: 'the motion', bill_refs: ['SB 1'] };
  const row = buildVoteRow({
    billId: 'bill-1', year: 2018, dayRow, vote, runId: 'run-1',
  });
  assert.deepEqual(row, {
    bill_id: 'bill-1',
    jurisdiction_id: 'mo-legislature',
    chamber: 'senate',
    vote_date: '2018-03-08',
    question: 'the motion',
    result: null,
    source_url: 'https://x/RDay1.pdf',
    source_key: 'mo-senate-web-2018-RDay1-vote1',
    run_id: 'run-1',
  });
});

// ---- casts (CONTROLLER RULING 6) ----

test('buildCastTokens: yeas -> yea, nays -> nay, absent -> absent, absentWithLeave -> absent', () => {
  const vote = {
    yeas: [{ surname: 'Onder', district: null }],
    nays: [{ surname: 'Rizzo', district: null }],
    absent: [{ surname: 'Chappelle-Nadal', district: null }],
    absentWithLeave: [{ surname: 'Kehoe', district: null }, { surname: 'Sater', district: null }],
    vacancies: 1,
  };
  const tokens = buildCastTokens(vote);
  assert.deepEqual(tokens, [
    { surname: 'Onder', district: null, position: 'yea' },
    { surname: 'Rizzo', district: null, position: 'nay' },
    { surname: 'Chappelle-Nadal', district: null, position: 'absent' },
    { surname: 'Kehoe', district: null, position: 'absent' },
    { surname: 'Sater', district: null, position: 'absent' },
  ]);
});

test('buildCastTokens: vacancies (a seat count, not a name list) never becomes a cast', () => {
  const vote = {
    yeas: [], nays: [], absent: [], absentWithLeave: [], vacancies: 3,
  };
  assert.deepEqual(buildCastTokens(vote), []);
});

test('buildCastTokens: district suffix is carried through untouched, for resolveMoSenator\'s collision handling', () => {
  const vote = {
    yeas: [{ surname: 'Brown', district: '16' }, { surname: 'Brown', district: '26' }],
    nays: [],
    absent: [],
    absentWithLeave: [],
    vacancies: 0,
  };
  const tokens = buildCastTokens(vote);
  assert.equal(tokens[0].district, '16');
  assert.equal(tokens[1].district, '26');
});

// ---- roster source selection ----

test('pickRosterSource: 2018 resolves to the archived Wayback PDF', () => {
  const source = pickRosterSource(2018);
  assert.equal(source.format, 'pdf');
  assert.match(source.url, /web\.archive\.org.*2018Roster\.pdf/);
});

test('pickRosterSource: any other year falls back to the current live HTML roster', () => {
  const source = pickRosterSource(2026);
  assert.equal(source.format, 'html');
  assert.equal(source.url, 'https://www.senate.mo.gov/Senators/');
  const other = pickRosterSource(1999);
  assert.deepEqual(other, source);
});

test('buildJournalIndexUrl: SelectedYear query param', () => {
  assert.equal(buildJournalIndexUrl(2018), 'https://www.senate.mo.gov/journallist/?SelectedYear=2018');
});

// ---- cache staleness (roster + journal-index share this helper) ----

test('shouldRefetch: no prior fetch at all -> true', () => {
  assert.equal(shouldRefetch(null, MO_SENATE_ROSTER_MAX_AGE_MS), true);
});

test('shouldRefetch: within the max age -> false', () => {
  const recent = new Date(Date.now() - 60 * 1000).toISOString();
  assert.equal(shouldRefetch(recent, MO_SENATE_INDEX_MAX_AGE_MS), false);
});

test('shouldRefetch: past the max age -> true', () => {
  const stale = new Date(Date.now() - (MO_SENATE_INDEX_MAX_AGE_MS + 1000)).toISOString();
  assert.equal(shouldRefetch(stale, MO_SENATE_INDEX_MAX_AGE_MS), true);
});

// ---- day-level quarantine (CONTROLLER RULING 4) ----

test('writeDayFailureArtifact: first failure writes attempts=1 with per-failure ordinal/category/message', () => {
  withScratchDir((dir) => {
    const failures = [Object.assign(new Error('block 4: bad'), { ordinal: 4, category: 'yeas' })];
    const record = writeDayFailureArtifact('RDay1', 'https://x/RDay1.pdf', failures, dir);
    assert.equal(record.attempts, 1);
    assert.equal(record.pdf_basename, 'RDay1');
    assert.deepEqual(record.failures, [{ ordinal: 4, category: 'yeas', message: 'block 4: bad' }]);
    assert.deepEqual(readDayFailureArtifact('RDay1', dir), record);
  });
});

test('writeDayFailureArtifact: attempts increments (never resets) across repeated failures of the SAME day', () => {
  withScratchDir((dir) => {
    const failures = [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })];
    const first = writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    const second = writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    const third = writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    assert.deepEqual([first.attempts, second.attempts, third.attempts], [1, 2, 3]);
  });
});

test('excludeQuarantinedDays: a day below the retry cap (attempts < 3) stays in the queue', () => {
  withScratchDir((dir) => {
    const failures = [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })];
    writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    const candidates = [{ pdf_basename: 'RDay1' }];
    const { kept, skippedQuarantined } = excludeQuarantinedDays(candidates, dir);
    assert.equal(skippedQuarantined, 0);
    assert.deepEqual(kept, candidates);
  });
});

test('excludeQuarantinedDays: skips a day once attempts reaches JOURNAL_DAY_MAX_FAILED_ATTEMPTS (3), unrelated day stays', () => {
  withScratchDir((dir) => {
    assert.equal(JOURNAL_DAY_MAX_FAILED_ATTEMPTS, 3);
    const failures = [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })];
    writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    const candidates = [{ pdf_basename: 'RDay1' }, { pdf_basename: 'RDay2' }];
    const { kept, skippedQuarantined, skippedKeys } = excludeQuarantinedDays(candidates, dir);
    assert.equal(skippedQuarantined, 1);
    assert.deepEqual(kept, [{ pdf_basename: 'RDay2' }]);
    assert.deepEqual(skippedKeys, ['RDay1']);
  });
});

// ---- day-completeness ("done") marker ----

test('hasDoneMarker: false before any marker is written, true after', () => {
  withScratchDir((dir) => {
    assert.equal(hasDoneMarker('RDay1', dir), false);
    writeDoneMarker('RDay1', { votes: 13 }, dir);
    assert.equal(hasDoneMarker('RDay1', dir), true);
  });
});

// ---- journal-day worklist planning (the day-completeness rule, CONTROLLER RULING 4) ----

test('selectJournalDayWorklist: a done day and a quarantined day are both excluded; a fresh day is selected', () => {
  withScratchDir((dir) => {
    const indexRows = [
      { day_label: 'Day 1', journal_url: 'https://x/RDay1.pdf', journal_date: '2018-01-01' },
      { day_label: 'Day 2', journal_url: 'https://x/RDay2.pdf', journal_date: '2018-01-02' },
      { day_label: 'Day 3', journal_url: 'https://x/RDay3.pdf', journal_date: '2018-01-03' },
    ];
    writeDoneMarker('RDay1', {}, dir); // already fully ingested, 0 failures
    const failures = [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })];
    writeDayFailureArtifact('RDay2', 'https://x/RDay2.pdf', failures, dir);
    writeDayFailureArtifact('RDay2', 'https://x/RDay2.pdf', failures, dir);
    writeDayFailureArtifact('RDay2', 'https://x/RDay2.pdf', failures, dir); // 3rd -> quarantined

    const { days, totalPending, skippedQuarantined, skippedQuarantinedKeys } = selectJournalDayWorklist(indexRows, { limit: 5 }, dir);
    assert.deepEqual(days.map((d) => d.pdf_basename), ['RDay3']);
    assert.equal(totalPending, 1);
    assert.equal(skippedQuarantined, 1);
    assert.deepEqual(skippedQuarantinedKeys, ['RDay2']);
  });
});

test('selectJournalDayWorklist: a day with 1-2 failures (below the quarantine cap) is NOT done — it stays in the worklist and is retried', () => {
  withScratchDir((dir) => {
    const indexRows = [{ day_label: 'Day 1', journal_url: 'https://x/RDay1.pdf', journal_date: '2018-01-01' }];
    const failures = [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })];
    writeDayFailureArtifact('RDay1', 'https://x/RDay1.pdf', failures, dir); // attempts=1, below cap
    const { days } = selectJournalDayWorklist(indexRows, { limit: 5 }, dir);
    assert.deepEqual(days.map((d) => d.pdf_basename), ['RDay1']);
  });
});

test('selectJournalDayWorklist: default limit is 1', () => {
  withScratchDir((dir) => {
    const indexRows = [
      { day_label: 'Day 1', journal_url: 'https://x/RDay1.pdf', journal_date: '2018-01-01' },
      { day_label: 'Day 2', journal_url: 'https://x/RDay2.pdf', journal_date: '2018-01-02' },
    ];
    const { days } = selectJournalDayWorklist(indexRows, {}, dir);
    assert.equal(days.length, 1);
  });
});

test('selectJournalDayWorklist: real 2018 journal index fixture — Day 37 resolves to the reviewer-verified unique basename', () => {
  withScratchDir((dir) => {
    const indexRows = parseJournalIndex(journalList2018Html);
    const day37 = indexRows.find((r) => r.day_label === 'Day 37');
    assert.ok(day37, 'Day 37 must be present in the real 2018 index fixture');
    assert.equal(day37.journal_date, '2018-03-08');
    const { days } = selectJournalDayWorklist([day37], { limit: 1 }, dir);
    assert.equal(days[0].pdf_basename, 'RDay370308587-610');
  });
});

// ---- durable cross-process ToU cooldown (ported from ingest-mo-house.js) ----

function queuedIngestionRunsClient(responses) {
  let call = 0;
  const client = {
    from(table) {
      assert.equal(table, 'ingestion_runs', 'enforceDurableCooldown must only query ingestion_runs');
      return {
        select: () => ({
          eq: (col, val) => {
            assert.equal(col, 'source');
            assert.equal(val, 'mo-senate-web');
            return {
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => {
                    const response = responses[Math.min(call, responses.length - 1)];
                    call += 1;
                    return response;
                  },
                }),
              }),
            };
          },
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

test('enforceDurableCooldown: loops on a fresh re-check after each sleep, converging only once a FRESH read shows remaining <= 0', async () => {
  const minIntervalMs = 30 * 60 * 1000;
  const now = Date.now();
  const responses = [
    { data: { started_at: new Date(now - 5 * 60 * 1000).toISOString() }, error: null },
    { data: { started_at: new Date(now - minIntervalMs).toISOString() }, error: null },
  ];
  const { client, callCount } = queuedIngestionRunsClient(responses);
  const sleeps = [];
  await enforceDurableCooldown(client, minIntervalMs, { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(callCount(), 2);
  assert.equal(sleeps.length, 1);
});

test('enforceDurableCooldown: throws a typed CooldownConvergenceError after maxIterations fresh re-checks that never converge', async () => {
  const { client } = queuedIngestionRunsClient([{ data: { started_at: new Date().toISOString() }, error: null }]);
  await assert.rejects(
    () => enforceDurableCooldown(client, 30 * 60 * 1000, { sleep: async () => {}, maxIterations: 3 }),
    (err) => {
      assert.ok(err instanceof CooldownConvergenceError);
      assert.equal(err.maxIterations, 3);
      return true;
    },
  );
});

test('enforceDurableCooldown: a lookup failure is a hard error, never silently swallowed', async () => {
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'connection refused' } }) }) }) }) }) }),
  };
  await assert.rejects(
    () => enforceDurableCooldown(client, 30 * 60 * 1000, { sleep: async () => {} }),
    /mo-senate cooldown lookup failed: connection refused/,
  );
});

test('remainingCooldownMs / formatCooldownWait: pure helpers', () => {
  assert.equal(remainingCooldownMs(null, 1000), 0);
  assert.equal(formatCooldownWait(65000), '1m 5s');
});

// ---- session ensure ----

function fakeSessionClient(existingRows = []) {
  const upserts = [];
  const rows = [...existingRows];
  return {
    upserts,
    client: {
      from(table) {
        assert.equal(table, 'sessions');
        return {
          upsert: async (r, opts) => { upserts.push({ rows: r, opts }); rows.push(...r.map((x) => ({ id: 'sess-1', ...x }))); return { error: null }; },
          select: () => ({
            eq: (c1, v1) => ({
              eq: (c2, v2) => ({
                single: async () => {
                  const found = rows.find((r) => r[c1] === v1 && r[c2] === v2);
                  return found ? { data: { id: found.id }, error: null } : { data: null, error: { message: 'not found' } };
                },
              }),
            }),
          }),
        };
      },
    },
  };
}

test('ensureSessionRow: inserts the exact row shape (task-5-brief.md step 2) and selects it back', async () => {
  const { client, upserts } = fakeSessionClient();
  const row = await ensureSessionRow(client, 'run-1', 2018);
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].rows, [{
    jurisdiction_id: 'mo-legislature', identifier: '2018', name: '2018 Regular Session (MO Senate journals)',
  }]);
  assert.equal(upserts[0].opts.onConflict, 'jurisdiction_id,identifier');
  assert.equal(row.id, 'sess-1');
});

// ---- roster gating branch (isMissingColumnError) ----

function fakeLegislatorsClient({ gated = false } = {}) {
  const upserts = [];
  return {
    upserts,
    client: {
      from(table) {
        assert.equal(table, 'legislators');
        return {
          upsert: async (rows, opts) => {
            upserts.push({ rows, opts });
            if (gated) return { error: { message: 'Could not find the \'mo_senate_id\' column of \'legislators\' in the schema cache', code: 'PGRST204' } };
            return { error: null };
          },
        };
      },
    },
  };
}

test('persistRosterRows: normal case — inserts every member row with mo_senate_id as the conflict key, gated:false', async () => {
  const { client, upserts } = fakeLegislatorsClient();
  const members = [{
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  }];
  const result = await persistRosterRows(client, 'run-1', members);
  assert.deepEqual(result, { attempted: 1, persisted: 1, gated: false });
  assert.deepEqual(upserts[0].rows, [{
    full_name: 'Bob Onder', party: null, surname: 'Onder', mo_senate_id: '2', run_id: 'run-1',
  }]);
  assert.equal(upserts[0].opts.onConflict, 'mo_senate_id');
});

test('persistRosterRows: roster-gating branch — a missing mo_senate_id column is reported honestly, never thrown as an opaque error', async () => {
  const { client } = fakeLegislatorsClient({ gated: true });
  const members = [{
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  }];
  const result = await persistRosterRows(client, 'run-1', members);
  assert.equal(result.gated, true);
  assert.equal(result.persisted, 0);
  assert.match(result.note, /migration 0008/);
});

test('persistRosterRows: an unrelated DB error still throws (only the mo_senate_id gate is swallowed)', async () => {
  const client = { from: () => ({ upsert: async () => ({ error: { message: 'connection refused' } }) }) };
  await assert.rejects(() => persistRosterRows(client, 'run-1', [{
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  }]), /connection refused/);
});

test('loadSenateRosterForResolution: maps id/surname/mo_senate_id to legislator_id/surname/mo_senate_id, scoped to the given districts', async () => {
  const inCalls = [];
  const client = {
    from: (table) => {
      assert.equal(table, 'legislators');
      return {
        select: () => ({
          in: async (col, vals) => {
            inCalls.push([col, vals]);
            return { data: [{ id: 'leg-1', surname: 'Onder', mo_senate_id: '2' }], error: null };
          },
        }),
      };
    },
  };
  const roster = await loadSenateRosterForResolution(client, ['2', '16']);
  assert.deepEqual(inCalls, [['mo_senate_id', ['2', '16']]]);
  assert.deepEqual(roster, [{ legislator_id: 'leg-1', surname: 'Onder', mo_senate_id: '2' }]);
});

// ---- roster/index cache orchestration (fetchLive/dir injected — no network) ----

test('ensureRosterForRun: cache hit — never calls fetchLive, still persists (idempotent) via persistRosterRows', async () => {
  await withScratchDirAsync(async (dir) => {
    writeFileSync(join(dir, '2018.json'), JSON.stringify({
      fetched_at: new Date().toISOString(),
      members: [{
        mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
      }],
    }));
    const { client, upserts } = fakeLegislatorsClient();
    const fetchLive = async () => { throw new Error('must not fetch live on a cache hit'); };
    const result = await ensureRosterForRun(client, 'run-1', 2018, { fetchLive, dir });
    assert.equal(result.fetchedLive, false);
    assert.equal(result.members[0].surname, 'Onder');
    assert.equal(upserts.length, 1, 'persistRosterRows still runs every invocation (pure DB op, no network)');
  });
});

test('ensureRosterForRun: cache miss — calls the injected fetchLive exactly once and writes the cache', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = fakeLegislatorsClient();
    let fetchCalls = 0;
    const fetchLive = async (source) => {
      fetchCalls += 1;
      assert.equal(source.format, 'pdf');
      return { members: [{
        mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
      }], vacancies: 1 };
    };
    const result = await ensureRosterForRun(client, 'run-1', 2018, { fetchLive, dir });
    assert.equal(result.fetchedLive, true);
    assert.equal(fetchCalls, 1);
    assert.ok(existsSync(join(dir, '2018.json')));
  });
});

test('ensureIndexForRun: cache hit — never fetches live', async () => {
  await withScratchDirAsync(async (dir) => {
    writeFileSync(join(dir, '2018.json'), JSON.stringify({
      fetched_at: new Date().toISOString(),
      rows: [{ day_label: 'Day 37', journal_url: 'https://x/RDay37.pdf', journal_date: '2018-03-08' }],
    }));
    const result = await ensureIndexForRun(2018, { dir });
    assert.equal(result.fetchedLive, false);
    assert.equal(result.rows[0].day_label, 'Day 37');
  });
});

// ---- full write-pipeline integration (real Day 37 fixture through a fake DB client) ----
//
// Minimal in-memory fake covering exactly the tables processJournalDay touches: bills, votes,
// vote_casts. Mirrors the upsert-then-select-back round trip insertIfAbsent + a plain .select()
// actually produce against a real Supabase client.
function makeFakeDb() {
  const tables = { bills: [], votes: [], vote_casts: [] };
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${(counter += 1)}`;
  const client = {
    from(table) {
      if (!(table in tables)) throw new Error(`fake db: unexpected table ${table}`);
      return {
        upsert: async (rows, opts) => {
          const conflictCols = (opts.onConflict || '').split(',').filter(Boolean);
          for (const row of rows) {
            const exists = conflictCols.length > 0
              && tables[table].some((r) => conflictCols.every((c) => r[c] === row[c]));
            if (!exists) tables[table].push({ id: nextId(table), ...row });
          }
          return { error: null };
        },
        select() {
          const filters = [];
          const builder = {
            eq(col, val) { filters.push([col, val]); return builder; },
            single: async () => {
              const found = tables[table].filter((r) => filters.every(([c, v]) => r[c] === v));
              if (found.length !== 1) return { data: null, error: { message: `expected 1 row for ${table}, got ${found.length}` } };
              return { data: found[0], error: null };
            },
          };
          return builder;
        },
      };
    },
  };
  return { client, tables };
}

test('processJournalDay: real Day 37 fixture end-to-end — 13 votes written, casts resolved/unresolved against a small fake roster', async () => {
  const { client, tables } = makeFakeDb();
  const sessionRow = { id: 'sess-2018' };
  const dayRow = {
    journal_url: 'https://www.senate.mo.gov/18info/Journals/RDay370308587-610.pdf',
    journal_date: '2018-03-08',
    pdf_basename: 'RDay370308587-610',
  };
  // Onder is district 2 (Task 3's spot-check ground truth); everyone else in the real fixture's
  // name lists is deliberately absent from this small fake roster so they land in unresolved.
  const roster = [{ legislator_id: 'leg-onder', surname: 'Onder', mo_senate_id: '2' }];

  const args = { journalPdfFile: `${FIXTURES}/2018-day37-journal-onder-era.pdf` };
  const result = await processJournalDay(client, 'run-1', 2018, sessionRow, dayRow, args, { gated: false, roster });

  assert.equal(result.votes_parsed, 13);
  assert.equal(result.votes_written, 13);
  assert.equal(result.failures, 0);
  assert.equal(result.casts.gated, false);
  assert.equal(tables.votes.length, 13);
  // Block 6 (SBs 894 & 921) is the brief's named test case — Onder is in yeas there (task-4-report.md).
  const block6 = tables.votes.find((v) => v.source_key === 'mo-senate-web-2018-RDay370308587-610-vote6');
  assert.ok(block6);
  assert.equal(block6.result, null);
  assert.equal(block6.vote_date, '2018-03-08');
  assert.equal(block6.chamber, 'senate');
  assert.equal(block6.jurisdiction_id, 'mo-legislature');
  const onderCast = tables.vote_casts.find((c) => c.legislator_id === 'leg-onder' && c.vote_id === block6.id);
  assert.ok(onderCast, 'Onder must resolve and be cast on block 6');
  assert.equal(onderCast.position, 'yea');
  // Every other real name in the fixture's lists is unresolved against this tiny fake roster.
  assert.ok(result.casts.unresolved > 0);
  assert.equal(result.casts.resolved, tables.vote_casts.length);
});

test('processJournalDay: roster-gated branch — writes a per-day gate artifact instead of vote_casts rows', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client, tables } = makeFakeDb();
    const sessionRow = { id: 'sess-2018' };
    const dayRow = {
      journal_url: 'https://www.senate.mo.gov/18info/Journals/RDay370308587-610.pdf',
      journal_date: '2018-03-08',
      pdf_basename: 'RDay370308587-610',
    };
    const args = { journalPdfFile: `${FIXTURES}/2018-day37-journal-onder-era.pdf` };
    const result = await processJournalDay(client, 'run-1', 2018, sessionRow, dayRow, args, { gated: true, roster: [] }, dir);

    assert.equal(result.votes_written, 13);
    assert.equal(result.casts.gated, true);
    assert.equal(tables.vote_casts.length, 0, 'no casts are written to vote_casts while gated');
    assert.ok(existsSync(join(dir, 'RDay370308587-610.journal-day.json')));
    const artifact = JSON.parse(readFileSync(join(dir, 'RDay370308587-610.journal-day.json'), 'utf8'));
    assert.equal(artifact.votes.length, 13);
    assert.ok(artifact.votes[0].casts.length > 0);
    assert.ok(hasDoneMarker('RDay370308587-610', dir), 'a gated day with zero parse failures is still marked done');
  });
});

// ---- gated-artifact replay ----

function fakeReplayLegislatorsClient(rows) {
  return {
    from(table) {
      if (table !== 'legislators') throw new Error(`unexpected table ${table}`);
      return { select: () => ({ not: async () => ({ data: rows, error: null }) }) };
    },
  };
}

test('replayJournalArtifacts: an empty/missing directory is a clean no-op', async () => {
  await withScratchDirAsync(async (dir) => {
    const result = await replayJournalArtifacts(fakeReplayLegislatorsClient([]), 'run-1', `${dir}/does-not-exist`);
    assert.deepEqual(result, {
      attempted: 0, replayed: 0, stillGated: false, unresolved: 0, unresolvedSample: [],
    });
  });
});

test('replayJournalArtifacts: ignores .done.json and .failed.json markers sitting in the same directory', async () => {
  await withScratchDirAsync(async (dir) => {
    writeDoneMarker('RDay1', {}, dir);
    writeDayFailureArtifact('RDay2', 'https://x', [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })], dir);
    const result = await replayJournalArtifacts(fakeReplayLegislatorsClient([]), 'run-1', dir);
    assert.deepEqual(result, {
      attempted: 0, replayed: 0, stillGated: false, unresolved: 0, unresolvedSample: [],
    });
    assert.ok(existsSync(join(dir, 'RDay1.done.json')));
    assert.ok(existsSync(join(dir, 'RDay2.failed.json')));
  });
});

test('replayJournalArtifacts: a fully-resolvable gate artifact replays and is deleted', async () => {
  await withScratchDirAsync(async (dir) => {
    const insertedCasts = [];
    const client = {
      from(table) {
        if (table === 'legislators') return { select: () => ({ not: async () => ({ data: [{ id: 'leg-onder', surname: 'Onder', mo_senate_id: '2' }], error: null }) }) };
        if (table === 'vote_casts') return { upsert: async (rows) => { insertedCasts.push(...rows); return { error: null }; } };
        throw new Error(`unexpected table ${table}`);
      },
    };
    writeFileSync(join(dir, 'RDay1.journal-day.json'), JSON.stringify({
      pdf_basename: 'RDay1',
      journal_url: 'https://x/RDay1.pdf',
      journal_date: '2018-03-08',
      votes: [{ vote_id: 'vote-1', source_key: 'mo-senate-web-2018-RDay1-vote1', casts: [{ surname: 'Onder', district: null, position: 'yea' }] }],
      extracted_run_id: 'run-0',
    }));
    const result = await replayJournalArtifacts(client, 'run-2', dir);
    assert.equal(result.attempted, 1);
    assert.equal(result.replayed, 1);
    assert.equal(result.unresolved, 0);
    assert.equal(insertedCasts.length, 1);
    assert.equal(existsSync(join(dir, 'RDay1.journal-day.json')), false);
  });
});

test('replayJournalArtifacts: a partially-resolvable artifact is rewritten with only the unresolved casts, kept on disk', async () => {
  await withScratchDirAsync(async (dir) => {
    const client = {
      from(table) {
        if (table === 'legislators') return { select: () => ({ not: async () => ({ data: [{ id: 'leg-onder', surname: 'Onder', mo_senate_id: '2' }], error: null }) }) };
        if (table === 'vote_casts') return { upsert: async () => ({ error: null }) };
        throw new Error(`unexpected table ${table}`);
      },
    };
    writeFileSync(join(dir, 'RDay1.journal-day.json'), JSON.stringify({
      pdf_basename: 'RDay1',
      journal_url: 'https://x/RDay1.pdf',
      journal_date: '2018-03-08',
      votes: [{
        vote_id: 'vote-1',
        source_key: 'mo-senate-web-2018-RDay1-vote1',
        casts: [{ surname: 'Onder', district: null, position: 'yea' }, { surname: 'Nobody', district: null, position: 'nay' }],
      }],
      extracted_run_id: 'run-0',
    }));
    const result = await replayJournalArtifacts(client, 'run-2', dir);
    assert.equal(result.replayed, 0);
    assert.equal(result.unresolved, 1);
    assert.ok(existsSync(join(dir, 'RDay1.journal-day.json')), 'a partially-resolved artifact is kept, not deleted');
    const rewritten = JSON.parse(readFileSync(join(dir, 'RDay1.journal-day.json'), 'utf8'));
    assert.equal(rewritten.partial, true);
    assert.deepEqual(rewritten.votes[0].casts, [{ surname: 'Nobody', district: null, position: 'nay' }]);
  });
});

test('replayJournalArtifacts: still gated (mo_senate_id column missing) — artifacts are left untouched, reported honestly', async () => {
  await withScratchDirAsync(async (dir) => {
    writeFileSync(join(dir, 'RDay1.journal-day.json'), JSON.stringify({
      pdf_basename: 'RDay1', votes: [{ vote_id: 'v1', source_key: 'k1', casts: [] }],
    }));
    const client = {
      from: () => ({ select: () => ({ not: async () => ({ data: null, error: { message: 'Could not find the \'mo_senate_id\' column of \'legislators\' in the schema cache', code: 'PGRST204' } }) }) }),
    };
    const result = await replayJournalArtifacts(client, 'run-2', dir);
    assert.equal(result.stillGated, true);
    assert.equal(result.attempted, 1);
    assert.ok(existsSync(join(dir, 'RDay1.journal-day.json')));
  });
});

// ---- dry-run DB-state reporting (no --journal-pdf-file) ----

test('dryRunReport: sessions table not found is reported as an honest note, not a thrown error', async () => {
  const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: 'PGRST205', message: 'Could not find the table \'public.sessions\' in the schema cache' } }) }) }) }) }) };
  const report = await dryRunReport(client, 2018);
  assert.equal(report.counts, null);
  assert.match(report.note, /sessions table not found/);
});

test('dryRunReport: no session row yet -> zero counts, zero live fetches', async () => {
  const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) };
  const report = await dryRunReport(client, 2018);
  assert.deepEqual(report.counts, { votes_total: 0 });
});

test('dryRunReport: an existing session reports votes_total from the DB, filtered to this year\'s source_key prefix', async () => {
  let likePattern;
  const client = {
    from(table) {
      if (table === 'sessions') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'sess-1' }, error: null }) }) }) }) };
      if (table === 'votes') {
        return {
          select: () => ({
            like: async (col, pattern) => {
              likePattern = pattern;
              return { count: 13, error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  const report = await dryRunReport(client, 2018);
  assert.equal(report.counts.votes_total, 13);
  assert.equal(likePattern, 'mo-senate-web-2018-%');
});

// ---- real-fixture parser sanity (via the exact adapters this driver drives) ----

test('sanity: extractJournalText + parseJournalVotes on the real Day 37 fixture — 13 votes, 0 failures (matches the required smoke)', async () => {
  const text = await extractJournalText(day37Pdf);
  const { votes, failures } = parseJournalVotes(text);
  assert.equal(votes.length, 13);
  assert.equal(failures.length, 0);
});

test('sanity: resolveMoSenator resolves Onder (district 2) against a roster row shaped {legislator_id,surname,mo_senate_id}', () => {
  const roster = [{ legislator_id: 'leg-onder', surname: 'Onder', mo_senate_id: '2' }];
  assert.equal(resolveMoSenator({ surname: 'Onder', district: null }, roster), 'leg-onder');
});
