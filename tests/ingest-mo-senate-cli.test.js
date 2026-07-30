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
  pickRosterSource, RosterSourceUnavailableError, buildJournalIndexUrl, shouldRefetch, effectiveMaxAge,
  MO_SENATE_ROSTER_MAX_AGE_MS, MO_SENATE_INDEX_MAX_AGE_MS,
  readDayFailureArtifact, writeDayFailureArtifact, excludeQuarantinedDays, listQuarantinedDays, JOURNAL_DAY_MAX_FAILED_ATTEMPTS,
  hasDoneMarker, writeDoneMarker,
  selectJournalDayWorklist,
  remainingCooldownMs, formatCooldownWait, enforceDurableCooldown, CooldownConvergenceError,
  ensureSessionRow, ensureRosterIdentities,
  ensureRosterForRun, ensureIndexForRun,
  processJournalDay, replayJournalArtifacts, dryRunReport,
} from '../src/cli/ingest-mo-senate.js';
import { SourceFetchError } from '../src/lib/errors.js';

const FIXTURES = 'tests/fixtures/research/mo-senate';
const day37Pdf = readFileSync(`${FIXTURES}/2018-day37-journal-onder-era.pdf`);
const day39Pdf = readFileSync(`${FIXTURES}/2026-day39-journal.pdf`);
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

test('pickRosterSource: 2018 resolves to the archive regardless of currentCalendarYear (archived takes priority)', () => {
  const source = pickRosterSource(2018, 2018);
  assert.equal(source.format, 'pdf');
});

// ---- finding 2 (CRITICAL, latent): the ORIGINAL pickRosterSource fell back to the current live
// roster for ANY year not in SENATE_ROSTER_ARCHIVE_URLS — a --year 2020 run would silently resolve
// 2020 vote casts against TODAY's membership (a cross-era misattribution channel), and because
// effectiveMaxAge() makes a closed year's cache never expire, that wrong cache would be poisoned
// permanently. FIX: hard refusal for any year that is neither archived nor the current calendar
// year — only 2018 (archived) and the current year (live, by definition correct) still resolve. ----

test('pickRosterSource: the CURRENT calendar year resolves to the live HTML roster', () => {
  const source = pickRosterSource(2026, 2026);
  assert.equal(source.format, 'html');
  assert.equal(source.url, 'https://www.senate.mo.gov/Senators/');
});

test('pickRosterSource: a historical year absent from the archive map is a HARD REFUSAL, never a silent live-roster fallback', () => {
  assert.throws(
    () => pickRosterSource(2020, 2026),
    (err) => {
      assert.ok(err instanceof RosterSourceUnavailableError);
      assert.equal(err.year, 2020);
      assert.equal(err.currentCalendarYear, 2026);
      // Ground rule: the message must name the missing roster source AND the extension point.
      assert.match(err.message, /2020/);
      assert.match(err.message, /SENATE_ROSTER_ARCHIVE_URLS/);
      return true;
    },
  );
});

test('pickRosterSource: a FUTURE year (also absent from the archive map) is refused the same way — "current year" means exactly one year, not >=', () => {
  assert.throws(() => pickRosterSource(2027, 2026), RosterSourceUnavailableError);
});

test('pickRosterSource: string year input still resolves/refuses correctly (Number() coercion)', () => {
  assert.equal(pickRosterSource('2018').format, 'pdf');
  assert.equal(pickRosterSource('2026', 2026).format, 'html');
  assert.throws(() => pickRosterSource('2020', 2026), RosterSourceUnavailableError);
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

// ---- standing quarantined-day set (freshness-honesty fix, 2026-07-30) ----

test('listQuarantinedDays: no artifacts dir at all -> [] (never throws)', () => {
  withScratchDir((dir) => {
    assert.deepEqual(listQuarantinedDays(`${dir}/does-not-exist`), []);
  });
});

test('listQuarantinedDays: a day below the retry cap (attempts < 3) is not reported', () => {
  withScratchDir((dir) => {
    const failures = [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })];
    writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    writeDayFailureArtifact('RDay1', 'https://x', failures, dir);
    assert.deepEqual(listQuarantinedDays(dir), []);
  });
});

test('listQuarantinedDays: reports every day quarantined ANYWHERE in the artifacts dir — the STANDING set, not scoped to any one year\'s index candidates (the bug this fixes)', () => {
  withScratchDir((dir) => {
    const failures = [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })];
    // Two different days' worth of quarantine history, as if left over from backfilling two
    // different --year runs — listQuarantinedDays takes no indexRows/candidates at all, so it
    // cannot be scoped to either one specifically.
    writeDayFailureArtifact('RDay160131222-234', 'https://x/RDay160131222-234.pdf', failures, dir);
    writeDayFailureArtifact('RDay160131222-234', 'https://x/RDay160131222-234.pdf', failures, dir);
    writeDayFailureArtifact('RDay160131222-234', 'https://x/RDay160131222-234.pdf', failures, dir);
    writeDayFailureArtifact('RDay200315001-010', 'https://x/RDay200315001-010.pdf', failures, dir);
    writeDayFailureArtifact('RDay200315001-010', 'https://x/RDay200315001-010.pdf', failures, dir);
    writeDayFailureArtifact('RDay200315001-010', 'https://x/RDay200315001-010.pdf', failures, dir);

    // Prove the point directly: a --year run whose OWN index candidates don't include either
    // quarantined day reports skippedQuarantinedKeys: [] (the old, scope-limited signal) even
    // though both days actually stand quarantined — listQuarantinedDays reports both regardless.
    const otherYearsCandidates = [{ pdf_basename: 'RDay260101001-010' }];
    const { skippedKeys } = excludeQuarantinedDays(otherYearsCandidates, dir);
    assert.deepEqual(skippedKeys, []);

    assert.deepEqual(
      listQuarantinedDays(dir).slice().sort(),
      ['RDay160131222-234', 'RDay200315001-010'],
    );
  });
});

test('listQuarantinedDays: a corrupt/partial .failed.json is skipped, never crashes', () => {
  withScratchDir((dir) => {
    const failures = [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })];
    writeDayFailureArtifact('RDayGood', 'https://x', failures, dir);
    writeDayFailureArtifact('RDayGood', 'https://x', failures, dir);
    writeDayFailureArtifact('RDayGood', 'https://x', failures, dir);
    writeFileSync(`${dir}/RDayCorrupt.failed.json`, '{not valid json');
    assert.deepEqual(listQuarantinedDays(dir), ['RDayGood']);
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

// ---- roster identity (FIX ROUND 1, CRITICAL — cross-era mo_senate_id collision) ----
//
// In-memory fake modeling the real legislators table across the fix. `uniqueMoSenateId: true`
// simulates the world BEFORE migration 0009 is applied (0008's still-live unique index on
// mo_senate_id rejects a second row for an already-claimed district with Postgres 23505, the
// reviewer's exact repro); `uniqueMoSenateId: false` simulates the world AFTER 0009 (a plain
// non-unique index — multiple eras' occupants of the same district can each get their own row).
// `missingColumn: true` simulates 0008 itself not being applied at all (PGRST204) — orthogonal to
// the unique-index question, same as before this fix round.
// seedRows: pre-populate legislators (e.g. an already-persisted prior-era row) before the fake is
// ever queried — used by the FIX ROUND 2 replay tests below to set up "Bob Onder (2018) already
// persisted" without going through ensureRosterIdentities first. vote_casts is a second in-memory
// table (upsert-only, no dedup needed for these tests) so the same fake can serve
// replayJournalArtifacts's insertIfAbsent(..., 'vote_casts', ...) calls too.
function makeFakeLegislatorsDb({
  uniqueMoSenateId = false, missingColumn = false, seedRows = [],
} = {}) {
  const rows = [...seedRows];
  const voteCasts = [];
  let counter = 0;
  const client = {
    from(table) {
      if (table === 'vote_casts') {
        return { upsert: async (castRows) => { voteCasts.push(...castRows); return { error: null }; } };
      }
      assert.equal(table, 'legislators');
      return {
        select: () => ({
          eq: (c1, v1) => ({
            eq: (c2, v2) => ({
              maybeSingle: async () => {
                if (missingColumn) {
                  return { data: null, error: { code: 'PGRST204', message: "Could not find the 'mo_senate_id' column of 'legislators' in the schema cache" } };
                }
                const found = rows.find((r) => r[c1] === v1 && r[c2] === v2);
                return { data: found ? { id: found.id } : null, error: null };
              },
            }),
          }),
        }),
        insert: (row) => ({
          select: () => ({
            single: async () => {
              if (missingColumn) {
                return { data: null, error: { code: 'PGRST204', message: "Could not find the 'mo_senate_id' column of 'legislators' in the schema cache" } };
              }
              if (uniqueMoSenateId && row.mo_senate_id != null && rows.some((r) => r.mo_senate_id === row.mo_senate_id)) {
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "legislators_mo_senate_id_uidx"' } };
              }
              counter += 1;
              const inserted = { id: `leg-${counter}`, ...row };
              rows.push(inserted);
              return { data: { id: inserted.id }, error: null };
            },
          }),
        }),
      };
    },
  };
  return {
    client, rows, voteCasts,
  };
}

test('ensureRosterIdentities: normal case — inserts a new (full_name, mo_senate_id) row, found:0 inserted:1, gated:false', async () => {
  const { client, rows } = makeFakeLegislatorsDb();
  const members = [{
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  }];
  const result = await ensureRosterIdentities(client, 'run-1', members);
  assert.deepEqual(
    {
      attempted: result.attempted, found: result.found, inserted: result.inserted, gated: result.gated,
    },
    {
      attempted: 1, found: 0, inserted: 1, gated: false,
    },
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 'leg-1', full_name: 'Bob Onder', party: null, surname: 'Onder', mo_senate_id: '2', run_id: 'run-1',
  });
  assert.deepEqual(result.resolutionRoster, [{ legislator_id: 'leg-1', surname: 'Onder', mo_senate_id: '2' }]);
});

test('ensureRosterIdentities: an already-ensured (full_name, mo_senate_id) pair is found, never re-inserted — found:1 inserted:0 (IMPORTANT fix: honest counts, not persisted:rows.length)', async () => {
  const { client, rows } = makeFakeLegislatorsDb();
  const members = [{
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  }];
  await ensureRosterIdentities(client, 'run-1', members);
  const result = await ensureRosterIdentities(client, 'run-2', members); // same member, a second run
  assert.equal(result.found, 1);
  assert.equal(result.inserted, 0);
  assert.equal(result.gated, false);
  assert.equal(rows.length, 1, 'no duplicate row was created for the same (full_name, mo_senate_id) pair');
});

test('ensureRosterIdentities: missing mo_senate_id column (0008 not applied) is reported honestly, gated:true, never thrown', async () => {
  const { client } = makeFakeLegislatorsDb({ missingColumn: true });
  const members = [{
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  }];
  const result = await ensureRosterIdentities(client, 'run-1', members);
  assert.equal(result.gated, true);
  assert.equal(result.missingColumn, true);
  assert.equal(result.found, 0);
  assert.equal(result.inserted, 0);
  assert.match(result.note, /migration 0008/);
});

test('ensureRosterIdentities: an unrelated DB error still throws (only the two known gate errors are swallowed)', async () => {
  const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'connection refused' } }) }) }) }) }) };
  await assert.rejects(() => ensureRosterIdentities(client, 'run-1', [{
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  }]), /connection refused/);
});

// ---- CRITICAL — the reviewer's exact repro: 2018 Onder, then a 2026 run for the SAME district
// (2), now held by a different person (Vogel) ----

test('ensureRosterIdentities: CRITICAL repro, PRE-0009 — a later era colliding on district identity is GATED with an honest note naming migration 0009, never a silent skip', async () => {
  const { client, rows } = makeFakeLegislatorsDb({ uniqueMoSenateId: true }); // 0008 live, 0009 NOT yet applied
  const era2018 = await ensureRosterIdentities(client, 'run-2018', [{
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  }]);
  assert.deepEqual(
    { found: era2018.found, inserted: era2018.inserted, gated: era2018.gated },
    { found: 0, inserted: 1, gated: false },
  );

  const era2026 = await ensureRosterIdentities(client, 'run-2026', [{
    mo_senate_id: '2', surname: 'Vogel', full_name: 'Jason Vogel', party: null,
  }]);
  assert.equal(era2026.gated, true, 'the 2026 run must be gated — Vogel can never get his own row while the unique index is still live');
  assert.equal(era2026.inserted, 0);
  assert.deepEqual(era2026.collided, [{ full_name: 'Jason Vogel', mo_senate_id: '2' }]);
  assert.match(era2026.note, /migration 0009/);
  assert.match(era2026.note, /Jason Vogel/);
  // Onder's original row is untouched — this is a detected+reported gate, never a silent
  // overwrite or a silent no-op reported as success (the original Critical bug).
  assert.equal(rows.length, 1);
  assert.equal(rows[0].full_name, 'Bob Onder');
});

test('ensureRosterIdentities: CRITICAL repro, POST-0009 — both eras get their own row; each era resolves ONLY to its own occupant', async () => {
  const { client, rows } = makeFakeLegislatorsDb({ uniqueMoSenateId: false }); // 0009 applied
  const era2018 = await ensureRosterIdentities(client, 'run-2018', [{
    mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
  }]);
  const era2026 = await ensureRosterIdentities(client, 'run-2026', [{
    mo_senate_id: '2', surname: 'Vogel', full_name: 'Jason Vogel', party: null,
  }]);
  assert.equal(era2018.gated, false);
  assert.equal(era2026.gated, false);
  assert.equal(rows.length, 2, 'both Onder and Vogel now have their own legislators row for district 2');
  assert.notEqual(era2018.resolutionRoster[0].legislator_id, era2026.resolutionRoster[0].legislator_id);

  // The load-bearing fix, proven against the REAL resolveMoSenator: each era's own
  // resolutionRoster (the in-memory mapping built during THAT ensure call) resolves a bare
  // surname to THAT era's own legislator_id — 2026 votes resolve to Vogel, 2018 votes resolve to
  // Onder, never crossed, because resolution is scoped to one era's roster at a time, never a
  // global district-only query.
  assert.equal(resolveMoSenator({ surname: 'Vogel', district: null }, era2026.resolutionRoster), era2026.resolutionRoster[0].legislator_id);
  assert.equal(resolveMoSenator({ surname: 'Onder', district: null }, era2018.resolutionRoster), era2018.resolutionRoster[0].legislator_id);
});

test('ensureRosterIdentities: POST-0009 same-surname cross-era case — two different people, same surname, same district, different eras — each era resolves to its own row', async () => {
  const { client, rows } = makeFakeLegislatorsDb({ uniqueMoSenateId: false });
  const eraA = await ensureRosterIdentities(client, 'run-a', [{
    mo_senate_id: '5', surname: 'Smith', full_name: 'Alice Smith', party: null,
  }]);
  const eraB = await ensureRosterIdentities(client, 'run-b', [{
    mo_senate_id: '5', surname: 'Smith', full_name: 'Bob Smith', party: null,
  }]);
  assert.equal(eraA.gated, false);
  assert.equal(eraB.gated, false);
  assert.equal(rows.length, 2);
  assert.notEqual(eraA.resolutionRoster[0].legislator_id, eraB.resolutionRoster[0].legislator_id);
  // Each era's own resolution roster contains ONLY its own occupant — a same-surname cast in era
  // A resolves against eraA's roster alone, never ambiguous against era B's same-surname row.
  assert.equal(eraA.resolutionRoster.length, 1);
  assert.equal(eraB.resolutionRoster.length, 1);
  assert.equal(resolveMoSenator({ surname: 'Smith', district: null }, eraA.resolutionRoster), eraA.resolutionRoster[0].legislator_id);
  assert.equal(resolveMoSenator({ surname: 'Smith', district: null }, eraB.resolutionRoster), eraB.resolutionRoster[0].legislator_id);
});

// ---- roster/index cache orchestration (fetchLive/dir injected — no network) ----

test('ensureRosterForRun: cache hit — never calls fetchLive, still ensures identities every invocation (idempotent, pure DB op)', async () => {
  await withScratchDirAsync(async (dir) => {
    writeFileSync(join(dir, '2018.json'), JSON.stringify({
      fetched_at: new Date().toISOString(),
      members: [{
        mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
      }],
    }));
    const { client, rows } = makeFakeLegislatorsDb();
    const fetchLive = async () => { throw new Error('must not fetch live on a cache hit'); };
    const result = await ensureRosterForRun(client, 'run-1', 2018, { fetchLive, dir });
    assert.equal(result.fetchedLive, false);
    assert.equal(result.members[0].surname, 'Onder');
    assert.equal(result.identities.inserted, 1);
    assert.equal(rows.length, 1, 'ensureRosterIdentities still runs every invocation (pure DB op, no network)');
  });
});

test('ensureRosterForRun: cache miss — calls the injected fetchLive exactly once and writes the cache', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = makeFakeLegislatorsDb();
    let fetchCalls = 0;
    const fetchLive = async (source) => {
      fetchCalls += 1;
      assert.equal(source.format, 'pdf');
      return {
        members: [{
          mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
        }],
        vacancies: 1,
      };
    };
    const result = await ensureRosterForRun(client, 'run-1', 2018, { fetchLive, dir });
    assert.equal(result.fetchedLive, true);
    assert.equal(fetchCalls, 1);
    assert.equal(result.identities.inserted, 1);
    assert.ok(existsSync(join(dir, '2018.json')));
  });
});

// ---- finding 2: the refusal must fire INSIDE ensureRosterForRun, before any live fetch or cache
// write — this is what actually stops a wrong roster from poisoning the closed-year cache
// (effectiveMaxAge makes a closed year's cache never expire once written). ----

test('ensureRosterForRun: a historical year with no cache and no archive entry refuses loudly — fetchLive is NEVER called, no cache file is ever written', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = makeFakeLegislatorsDb();
    const fetchLive = async () => { throw new Error('must never fetch live for a refused year'); };
    await assert.rejects(
      () => ensureRosterForRun(client, 'run-1', 2020, { fetchLive, dir, currentCalendarYear: 2026 }),
      RosterSourceUnavailableError,
    );
    assert.equal(existsSync(join(dir, '2020.json')), false, 'no cache was written — a wrong roster can never poison this year\'s (never-expiring) cache');
  });
});

test('ensureRosterForRun: the CURRENT calendar year still fetches live normally (the refusal does not regress the one case it must keep working)', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = makeFakeLegislatorsDb();
    let fetchCalls = 0;
    const fetchLive = async (source) => {
      fetchCalls += 1;
      assert.equal(source.format, 'html');
      return { members: [{ mo_senate_id: '9', surname: 'Smith', full_name: 'Sam Smith', party: null }], vacancies: 0 };
    };
    const result = await ensureRosterForRun(client, 'run-1', 2026, { fetchLive, dir, currentCalendarYear: 2026 });
    assert.equal(result.fetchedLive, true);
    assert.equal(fetchCalls, 1);
    assert.ok(existsSync(join(dir, '2026.json')));
  });
});

test('ensureRosterForRun: a warm cache for a refused year is trusted as-is (the refusal only gates a FRESH fetch, never a year that already has a valid cache from before this fix)', async () => {
  await withScratchDirAsync(async (dir) => {
    writeFileSync(join(dir, '2020.json'), JSON.stringify({
      fetched_at: new Date().toISOString(),
      members: [{ mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null }],
    }));
    const { client } = makeFakeLegislatorsDb();
    const fetchLive = async () => { throw new Error('must not fetch live on a cache hit, refused year or not'); };
    const result = await ensureRosterForRun(client, 'run-1', 2020, { fetchLive, dir, currentCalendarYear: 2026 });
    assert.equal(result.fetchedLive, false);
    assert.equal(result.members[0].surname, 'Onder');
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

test('processJournalDay: real Day 39 fixture (2026) end-to-end — the attribution:"preceding_taken_up" vote (ordinal 9, SB 1421 emergency clause) writes to votes+vote_casts identically to every other block (MINOR fix round 1 b)', async () => {
  const { client, tables } = makeFakeDb();
  const sessionRow = { id: 'sess-2026' };
  const dayRow = {
    journal_url: 'https://www.senate.mo.gov/26info/pdf-jrnl/DAY39.pdf',
    journal_date: '2026-03-25',
    pdf_basename: '2026-day39',
  };
  // Roberts is Absent-with-leave in EVERY block of the real Day 39 fixture, including block 9
  // (verified directly against the real fixture, not assumed) — a reliable real name to prove the
  // emergency-clause block's casts flow through the exact same resolve/insert path as every other
  // block, never dropped by a branch specific to preceding_taken_up attribution.
  const roster = [{ legislator_id: 'leg-roberts', surname: 'Roberts', mo_senate_id: '9' }];

  const args = { journalPdfFile: `${FIXTURES}/2026-day39-journal.pdf` };
  const result = await processJournalDay(client, 'run-1', 2026, sessionRow, dayRow, args, { gated: false, roster });

  assert.equal(result.votes_parsed, 11);
  assert.equal(result.votes_written, 11);
  assert.equal(result.failures, 0);
  assert.deepEqual(result.attribution, { motion: 10, preceding_taken_up: 1 });
  assert.equal(tables.votes.length, 11);

  const ecVote = tables.votes.find((v) => v.source_key === 'mo-senate-web-2026-2026-day39-vote9');
  assert.ok(ecVote, 'the emergency-clause vote (ordinal 9) must be written just like any other block');
  assert.equal(ecVote.result, null);
  assert.equal(ecVote.vote_date, '2026-03-25');
  assert.equal(ecVote.chamber, 'senate');
  assert.equal(ecVote.jurisdiction_id, 'mo-legislature');

  // bill_id resolves to SB 1421 (the preceding-taken-up-attributed primary ref) — proves the
  // attribution's bill_refs flowed all the way through to the bill-stub ensure + primary-ref
  // lookup, not just the parser's own return value.
  const sb1421 = tables.bills.find((b) => b.identifier === 'SB 1421');
  assert.ok(sb1421);
  assert.equal(ecVote.bill_id, sb1421.id);

  const robertsCastOnEc = tables.vote_casts.find((c) => c.legislator_id === 'leg-roberts' && c.vote_id === ecVote.id);
  assert.ok(robertsCastOnEc, 'Roberts (absent-with-leave on every block, incl. the EC block) must resolve and be cast — proves casts are not dropped on the preceding_taken_up path');
  assert.equal(robertsCastOnEc.position, 'absent');
});

// ---- findings 4/5 (IMPORTANT): a whole-day fetch/extraction failure must be counted honestly
// (never invisible in main()'s aggregation) and must route through the SAME day-level attempts/
// quarantine artifact mechanism a parse failure already uses (never wedge the FIFO worklist at one
// day forever). ----

test('processJournalDay: a fetch failure (SourceFetchError) is folded into the day-level failure/quarantine artifact, not left uncounted (finding 4) or unquarantined (finding 5)', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = makeFakeDb();
    const sessionRow = { id: 'sess-2018' };
    const dayRow = { journal_url: 'https://www.senate.mo.gov/18info/Journals/RDayDead.pdf', journal_date: '2018-01-01', pdf_basename: 'RDayDead' };
    const fetchPdf = async () => {
      throw new SourceFetchError('404 dead link', { source: 'mo-senate-web', url: dayRow.journal_url, status: 404 });
    };

    const result = await processJournalDay(client, 'run-1', 2018, sessionRow, dayRow, {}, { gated: false, roster: [] }, dir, { fetchPdf });

    assert.equal(result.mode, 'failed');
    // Finding 4: a fetch failure used to report failures:0, invisible to main()'s totalFailures —
    // now it counts as 1 (this whole day did not succeed), so a run that hit this never reports
    // status:'succeeded' by accident.
    assert.equal(result.failures, 1);
    assert.deepEqual(result.attribution, { motion: 0, preceding_taken_up: 0 }, 'attribution is always present — this is exactly the shape main() unconditionally reads result.attribution.motion from (finding 4\'s TypeError)');
    assert.ok(result.fetchFailure);
    assert.match(result.fetchFailure.message, /404 dead link/);
    assert.equal(result.extractionFailure, undefined);

    assert.equal(hasDoneMarker('RDayDead', dir), false, 'a failed day is never marked done — it must stay in the worklist to be retried');
    const artifact = readDayFailureArtifact('RDayDead', dir);
    assert.ok(artifact, 'finding 5: a fetch failure routes through the SAME quarantine artifact mechanism a parse failure already uses');
    assert.equal(artifact.attempts, 1);
    assert.equal(artifact.failures[0].category, 'fetch');
  });
});

test('processJournalDay: extractJournalText throwing on a corrupt/unparseable PDF is folded into the day-level failure/quarantine artifact instead of crashing the run (finding 5)', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = makeFakeDb();
    const corruptPdfPath = join(dir, 'corrupt.pdf');
    writeFileSync(corruptPdfPath, 'this is not a real PDF file — no %PDF- header at all');
    const sessionRow = { id: 'sess-2018' };
    const dayRow = { journal_url: 'https://www.senate.mo.gov/18info/Journals/RDayCorrupt.pdf', journal_date: '2018-01-01', pdf_basename: 'RDayCorrupt' };
    const args = { journalPdfFile: corruptPdfPath };

    const result = await processJournalDay(client, 'run-1', 2018, sessionRow, dayRow, args, { gated: false, roster: [] }, dir);

    assert.equal(result.mode, 'failed');
    assert.equal(result.failures, 1);
    assert.deepEqual(result.attribution, { motion: 0, preceding_taken_up: 0 });
    assert.ok(result.extractionFailure, 'the PDF read (readFileSync) succeeded — this must be reported as an EXTRACTION failure, not a fetch failure');
    assert.equal(result.fetchFailure, undefined);

    assert.equal(hasDoneMarker('RDayCorrupt', dir), false);
    const artifact = readDayFailureArtifact('RDayCorrupt', dir);
    assert.ok(artifact);
    assert.equal(artifact.failures[0].category, 'extraction');
  });
});

test('processJournalDay: repeated extraction failures on the SAME day reach the quarantine cap and stop being re-selected — the FIFO-wedge finding 5 named is actually closed end-to-end', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = makeFakeDb();
    const corruptPdfPath = join(dir, 'corrupt.pdf');
    writeFileSync(corruptPdfPath, 'still not a PDF');
    const sessionRow = { id: 'sess-2018' };
    const dayRow = { journal_url: 'https://www.senate.mo.gov/18info/Journals/RDayCorrupt.pdf', journal_date: '2018-01-01', pdf_basename: 'RDayCorrupt' };
    const args = { journalPdfFile: corruptPdfPath };

    for (let i = 0; i < JOURNAL_DAY_MAX_FAILED_ATTEMPTS; i += 1) {
      // Deliberately sequential (not Promise.all): each retry's attempts count depends on the
      // artifact the PRIOR retry just wrote.
      const result = await processJournalDay(client, 'run-1', 2018, sessionRow, dayRow, args, { gated: false, roster: [] }, dir);
      assert.equal(result.mode, 'failed');
    }

    const indexRows = [{ day_label: 'Day 1', journal_url: dayRow.journal_url, journal_date: dayRow.journal_date }];
    const { days, skippedQuarantined, skippedQuarantinedKeys } = selectJournalDayWorklist(indexRows, { limit: 5 }, dir);
    assert.equal(days.length, 0, 'the day must no longer be selected — this is the exact "wedges the FIFO worklist forever" gap finding 5 closes');
    assert.equal(skippedQuarantined, 1);
    assert.deepEqual(skippedQuarantinedKeys, ['RDayCorrupt']);
  });
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

// ---- gated-artifact replay (FIX ROUND 2, CRITICAL — replay must never resolve blind across
// eras) ----

function writeGateArtifact(dir, pdfBasename, year, votes) {
  writeFileSync(join(dir, `${pdfBasename}.journal-day.json`), JSON.stringify({
    year,
    pdf_basename: pdfBasename,
    journal_url: `https://x/${pdfBasename}.pdf`,
    journal_date: '2018-03-08',
    votes,
    extracted_run_id: 'run-0',
  }, null, 2));
}

test('replayJournalArtifacts: an empty/missing directory is a clean no-op', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = makeFakeLegislatorsDb();
    const result = await replayJournalArtifacts(client, 'run-1', { dir: `${dir}/does-not-exist` });
    assert.deepEqual(result, {
      attempted: 0, replayed: 0, unresolved: 0, unresolvedSample: [], deferred: [],
    });
  });
});

test('replayJournalArtifacts: ignores .done.json and .failed.json markers sitting in the same directory', async () => {
  await withScratchDirAsync(async (dir) => {
    writeDoneMarker('RDay1', {}, dir);
    writeDayFailureArtifact('RDay2', 'https://x', [Object.assign(new Error('boom'), { ordinal: 1, category: 'yeas' })], dir);
    const { client } = makeFakeLegislatorsDb();
    const result = await replayJournalArtifacts(client, 'run-1', { dir });
    assert.deepEqual(result, {
      attempted: 0, replayed: 0, unresolved: 0, unresolvedSample: [], deferred: [],
    });
    assert.ok(existsSync(join(dir, 'RDay1.done.json')));
    assert.ok(existsSync(join(dir, 'RDay2.failed.json')));
  });
});

test('replayJournalArtifacts: an artifact with no year field is deferred with an honest note, never guessed at', async () => {
  await withScratchDirAsync(async (dir) => {
    writeFileSync(join(dir, 'RDay1.journal-day.json'), JSON.stringify({
      pdf_basename: 'RDay1', votes: [{ vote_id: 'v1', source_key: 'k1', casts: [{ surname: 'Onder', district: null, position: 'yea' }] }],
    })); // deliberately no `year`
    const { client, voteCasts } = makeFakeLegislatorsDb();
    const result = await replayJournalArtifacts(client, 'run-1', { dir });
    assert.equal(result.attempted, 1);
    assert.equal(result.replayed, 0);
    assert.equal(voteCasts.length, 0);
    assert.equal(result.deferred.length, 1);
    assert.match(result.deferred[0].note, /no year field/);
    assert.ok(existsSync(join(dir, 'RDay1.journal-day.json')), 'left completely untouched');
  });
});

// ---- CRITICAL — the reviewer's exact trace: 2018 Bob Onder already persisted, a 2026 Jane Onder
// artifact queued (gated pre-0009). The bug: the OLD replay resolved this against a global,
// era-blind roster, found only Bob (Jane had no row), and silently attributed Jane's vote to Bob
// while deleting the evidence. The fix: an artifact only ever resolves against its OWN year.

test('replayJournalArtifacts: CRITICAL repro — 2026 artifact stays QUEUED (deferred, honest note) when no 2026 mapping is obtainable; Bob\'s 2018 row is never touched, zero casts written', async () => {
  await withScratchDirAsync(async (dir) => {
    await withScratchDirAsync(async (rosterDir) => {
      const { client, rows, voteCasts } = makeFakeLegislatorsDb({
        seedRows: [{
          id: 'leg-bob', full_name: 'Bob Onder', party: null, surname: 'Onder', mo_senate_id: '2', run_id: 'seed',
        }],
      });
      // Jane's vote, queued under year 2026 — no roster cache exists for 2026 (no live fetch, no
      // prior ensure this invocation for that year) and currentYear is NOT 2026, so no mapping is
      // obtainable without a live fetch — must defer, never resolve blind.
      writeGateArtifact(dir, '2026-day1', 2026, [{
        vote_id: 'vote-jane-1', source_key: 'mo-senate-web-2026-2026-day1-vote1', casts: [{ surname: 'Onder', district: null, position: 'yea' }],
      }]);

      const result = await replayJournalArtifacts(client, 'run-1', {
        dir, rosterDir, currentYear: 2018, currentYearIdentities: null,
      });

      assert.equal(result.attempted, 1);
      assert.equal(result.replayed, 0, 'must not silently resolve Jane\'s vote against Bob\'s row');
      assert.equal(voteCasts.length, 0, 'zero casts written — never guessed');
      assert.equal(result.deferred.length, 1);
      assert.equal(result.deferred[0].year, 2026);
      assert.equal(result.deferred[0].note, 'replay deferred: year 2026 roster unavailable this invocation');
      assert.ok(existsSync(join(dir, '2026-day1.journal-day.json')), 'the artifact — the only evidence of Jane\'s pending vote — is NOT deleted');
      assert.equal(rows.length, 1, 'no new row created; Bob\'s original row is the only one');
      assert.equal(rows[0].full_name, 'Bob Onder');
    });
  });
});

test('replayJournalArtifacts: CRITICAL repro — once the 2026 roster mapping IS obtainable (warm cache, post-0009), Jane\'s vote resolves to JANE, never Bob; artifact deleted', async () => {
  await withScratchDirAsync(async (dir) => {
    await withScratchDirAsync(async (rosterDir) => {
      const { client, rows, voteCasts } = makeFakeLegislatorsDb({
        seedRows: [{
          id: 'leg-bob', full_name: 'Bob Onder', party: null, surname: 'Onder', mo_senate_id: '2', run_id: 'seed',
        }],
      });
      writeGateArtifact(dir, '2026-day1', 2026, [{
        vote_id: 'vote-jane-1', source_key: 'mo-senate-web-2026-2026-day1-vote1', casts: [{ surname: 'Onder', district: null, position: 'yea' }],
      }]);
      // A warm 2026 roster cache (as ensureRosterForRun would have written on a prior invocation
      // for year 2026, post-0009) — replay rebuilds that year's mapping from it via
      // ensureRosterIdentities, a pure DB op, no live fetch.
      writeFileSync(join(rosterDir, '2026.json'), JSON.stringify({
        fetched_at: new Date().toISOString(),
        members: [{
          mo_senate_id: '2', surname: 'Onder', full_name: 'Jane Onder', party: null,
        }],
      }));

      // currentYear is 2018 (a DIFFERENT run's own year) — proves the "other year, cache-driven"
      // path, not the matching-year shortcut. currentCalendarYear is pinned to 2030 (FIX ROUND 3:
      // the cache-based path is only permitted for a year strictly before "now" — 2026 must be a
      // CLOSED, historical year for this scenario to legitimately use its cache, so the test fixes
      // "now" well past it rather than depending on wall-clock reality).
      const result = await replayJournalArtifacts(client, 'run-2', {
        dir, rosterDir, currentYear: 2018, currentYearIdentities: null, currentCalendarYear: 2030,
      });

      assert.equal(result.replayed, 1);
      assert.equal(result.deferred.length, 0);
      assert.equal(rows.length, 2, 'Jane now has her own row, separate from Bob\'s');
      const jane = rows.find((r) => r.full_name === 'Jane Onder');
      assert.ok(jane);
      assert.equal(voteCasts.length, 1);
      assert.equal(voteCasts[0].legislator_id, jane.id, 'Jane\'s vote resolves to JANE, never Bob');
      assert.notEqual(voteCasts[0].legislator_id, 'leg-bob');
      assert.equal(existsSync(join(dir, '2026-day1.journal-day.json')), false, 'fully resolved — deleted');
    });
  });
});

test('replayJournalArtifacts: matching-year same-run replay path — currentYear/currentYearIdentities are used directly, no roster-cache read at all', async () => {
  await withScratchDirAsync(async (dir) => {
    await withScratchDirAsync(async (rosterDir) => {
      // rosterDir has NO 2026.json at all — proves the matching-year path never reads the cache.
      const { client, voteCasts } = makeFakeLegislatorsDb();
      const currentYearIdentities = await ensureRosterIdentities(client, 'run-3', [{
        mo_senate_id: '2', surname: 'Onder', full_name: 'Jane Onder', party: null,
      }]);
      assert.equal(currentYearIdentities.gated, false);

      writeGateArtifact(dir, '2026-day1', 2026, [{
        vote_id: 'vote-jane-1', source_key: 'mo-senate-web-2026-2026-day1-vote1', casts: [{ surname: 'Onder', district: null, position: 'yea' }],
      }]);

      const result = await replayJournalArtifacts(client, 'run-3', {
        dir, rosterDir, currentYear: 2026, currentYearIdentities,
      });

      assert.equal(result.replayed, 1);
      assert.equal(voteCasts.length, 1);
      assert.equal(voteCasts[0].legislator_id, currentYearIdentities.resolutionRoster[0].legislator_id);
      assert.equal(existsSync(join(rosterDir, '2026.json')), false, 'no cache file was ever written/read for the matching-year path');
    });
  });
});

test('replayJournalArtifacts: a partially-resolvable artifact (matching-year path) is rewritten with only the unresolved casts, kept on disk', async () => {
  await withScratchDirAsync(async (dir) => {
    const { client } = makeFakeLegislatorsDb();
    const currentYearIdentities = await ensureRosterIdentities(client, 'run-1', [{
      mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null,
    }]);
    writeGateArtifact(dir, 'RDay1', 2018, [{
      vote_id: 'vote-1',
      source_key: 'mo-senate-web-2018-RDay1-vote1',
      casts: [{ surname: 'Onder', district: null, position: 'yea' }, { surname: 'Nobody', district: null, position: 'nay' }],
    }]);
    const result = await replayJournalArtifacts(client, 'run-2', { dir, currentYear: 2018, currentYearIdentities });
    assert.equal(result.replayed, 0);
    assert.equal(result.unresolved, 1);
    assert.ok(existsSync(join(dir, 'RDay1.journal-day.json')), 'a partially-resolved artifact is kept, not deleted');
    const rewritten = JSON.parse(readFileSync(join(dir, 'RDay1.journal-day.json'), 'utf8'));
    assert.equal(rewritten.partial, true);
    assert.deepEqual(rewritten.votes[0].casts, [{ surname: 'Nobody', district: null, position: 'nay' }]);
  });
});

test('replayJournalArtifacts: rule 3 — a year whose ensure reports gated (missing column) stays deferred, never resolved with a partial mapping', async () => {
  await withScratchDirAsync(async (dir) => {
    await withScratchDirAsync(async (rosterDir) => {
      const { client, voteCasts } = makeFakeLegislatorsDb({ missingColumn: true });
      writeGateArtifact(dir, 'RDay1', 2018, [{ vote_id: 'v1', source_key: 'k1', casts: [{ surname: 'Onder', district: null, position: 'yea' }] }]);
      writeFileSync(join(rosterDir, '2018.json'), JSON.stringify({
        fetched_at: new Date().toISOString(), members: [{ mo_senate_id: '2', surname: 'Onder', full_name: 'Bob Onder', party: null }],
      }));
      const result = await replayJournalArtifacts(client, 'run-1', { dir, rosterDir, currentYear: 2099 });
      assert.equal(result.replayed, 0);
      assert.equal(voteCasts.length, 0);
      assert.equal(result.deferred.length, 1);
      assert.equal(result.deferred[0].year, 2018);
      assert.match(result.deferred[0].note, /roster unavailable this invocation/);
      assert.ok(existsSync(join(dir, 'RDay1.journal-day.json')));
    });
  });
});

// ---- FIX ROUND 3 (re-review, residual Critical-class channel) — cache-based replay is only safe
// for a CLOSED (historical) year; the current, still-open legislative year's roster can change
// mid-year, so a stale cached snapshot must never be used to resolve it — only a matching-year
// invocation's own fresh ensure is trusted. ----

test('replayJournalArtifacts: FIX ROUND 3 — a CURRENT-year artifact with a warm-but-stale current-year cache, replayed by a non-matching --year run, stays deferred with zero casts written (the cache must never be used for a still-open year)', async () => {
  await withScratchDirAsync(async (dir) => {
    await withScratchDirAsync(async (rosterDir) => {
      const { client, rows, voteCasts } = makeFakeLegislatorsDb({
        seedRows: [{
          id: 'leg-bob', full_name: 'Bob Onder', party: null, surname: 'Onder', mo_senate_id: '2', run_id: 'seed',
        }],
      });
      // 2026 is the CURRENT calendar year (pinned, not left to wall-clock reality) — a queued
      // 2026 artifact, e.g. Jane's vote.
      writeGateArtifact(dir, '2026-day1', 2026, [{
        vote_id: 'vote-jane-1', source_key: 'mo-senate-web-2026-2026-day1-vote1', casts: [{ surname: 'Onder', district: null, position: 'yea' }],
      }]);
      // A cache file for 2026 DOES exist (e.g. from an earlier invocation this same day) — warm,
      // but the current session could have changed since it was written. It must be ignored.
      writeFileSync(join(rosterDir, '2026.json'), JSON.stringify({
        fetched_at: new Date().toISOString(),
        members: [{
          mo_senate_id: '2', surname: 'Onder', full_name: 'Jane Onder', party: null,
        }],
      }));

      // This invocation's own --year is 2018 (a --year 2018 backfill run) — does NOT match the
      // artifact's year (2026), so only the (forbidden-for-current-year) cache path could
      // otherwise have been reached.
      const result = await replayJournalArtifacts(client, 'run-1', {
        dir, rosterDir, currentYear: 2018, currentYearIdentities: null, currentCalendarYear: 2026,
      });

      assert.equal(result.replayed, 0);
      assert.equal(voteCasts.length, 0, 'zero casts written — the current-year cache was never consulted for resolution');
      assert.equal(result.deferred.length, 1);
      assert.equal(result.deferred[0].year, 2026);
      assert.equal(result.deferred[0].note, 'replay deferred: year 2026 roster unavailable this invocation');
      assert.equal(rows.length, 1, 'no new row (e.g. Jane) was created from the current-year cache');
      assert.ok(existsSync(join(dir, '2026-day1.journal-day.json')), 'the artifact is untouched — never deleted, never rewritten');
    });
  });
});

test('replayJournalArtifacts: FIX ROUND 3 — year-boundary sanity: artifact year == current calendar year defers (matching-path only); artifact year == currentCalendarYear-1 (closed) still resolves via cache, same invocation', async () => {
  await withScratchDirAsync(async (dir) => {
    await withScratchDirAsync(async (rosterDir) => {
      const { client, voteCasts } = makeFakeLegislatorsDb();
      // Two artifacts, one on each side of the boundary, both replayed by the SAME non-matching
      // run (--year 1999, matching neither).
      writeGateArtifact(dir, 'current-day1', 2026, [{
        vote_id: 'vote-current-1', source_key: 'k-current', casts: [{ surname: 'Smith', district: null, position: 'yea' }],
      }]);
      writeGateArtifact(dir, 'closed-day1', 2025, [{
        vote_id: 'vote-closed-1', source_key: 'k-closed', casts: [{ surname: 'Jones', district: null, position: 'yea' }],
      }]);
      writeFileSync(join(rosterDir, '2026.json'), JSON.stringify({
        fetched_at: new Date().toISOString(), members: [{ mo_senate_id: '9', surname: 'Smith', full_name: 'Sam Smith', party: null }],
      }));
      writeFileSync(join(rosterDir, '2025.json'), JSON.stringify({
        fetched_at: new Date().toISOString(), members: [{ mo_senate_id: '9', surname: 'Jones', full_name: 'Jo Jones', party: null }],
      }));

      const result = await replayJournalArtifacts(client, 'run-1', {
        dir, rosterDir, currentYear: 1999, currentYearIdentities: null, currentCalendarYear: 2026,
      });

      assert.equal(result.replayed, 1, 'only the closed (2025) artifact replays');
      assert.equal(voteCasts.length, 1);
      assert.equal(voteCasts[0].vote_id, 'vote-closed-1');
      assert.deepEqual(
        result.deferred.map((d) => d.year).sort(),
        [2026],
      );
      assert.ok(existsSync(join(dir, 'current-day1.journal-day.json')), 'the current-year (2026) artifact stays queued, untouched');
      assert.equal(existsSync(join(dir, 'closed-day1.journal-day.json')), false, 'the closed-year (2025) artifact resolved and was deleted');
    });
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

test('effectiveMaxAge: closed years never expire, current year keeps its TTL', () => {
  assert.equal(effectiveMaxAge(2018, 60_000, 2026), Infinity);
  assert.equal(effectiveMaxAge(2025, 60_000, 2026), Infinity);
  assert.equal(effectiveMaxAge(2026, 60_000, 2026), 60_000);
  assert.equal(effectiveMaxAge('2018', 60_000, 2026), Infinity);
  // Infinity max-age with an existing cache timestamp must mean "never refetch"
  assert.equal(shouldRefetch(new Date(0).toISOString(), Infinity), false);
  // but NO cache at all must still fetch, even for a closed year
  assert.equal(shouldRefetch(null, Infinity), true);
});
