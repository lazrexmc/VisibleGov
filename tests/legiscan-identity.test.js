import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePersonName,
  chamberFromRole,
  normalizeLegiscanDistrict,
  normalizeLegiscanParty,
  LEGISCAN_PARTY_WORD_MAP,
  buildLegiscanNameVariants,
  findCandidateLegislatorRows,
  resolveOrCreateLegiscanPerson,
  LegiscanIdentityConflictError,
  UnrecognizedLegiscanRoleError,
} from '../src/adapters/legiscan-identity.js';
import { matchLegislator, eraOverlaps } from '../src/lib/person-identity.js';
import { decodeDatasetZip, extractDatasetFiles } from '../src/adapters/legiscan-dataset.js';

// Task 5 (docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md) — person identity mapping.
// CONTROLLER RULING 4 (task-5-brief.md): "Fixture test bed: session 1608's 189 people/ records."
// Reused directly from Task 4's own proven decode pipeline (not re-read from raw JSON files) so
// this test file exercises the SAME real payload every other adapter test in this plan does.
const FIXDIR = 'tests/fixtures/research/legiscan';
const envelope1608 = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-dataset-1608.json`, 'utf8'));
const dataset1608 = await extractDatasetFiles(decodeDatasetZip(envelope1608.dataset.zip));

// SB894's real sponsors[] (task-5-brief.md's own named test people): Douglas Libla (Sen,
// SD-025), Travis Fitzwater (Rep, HD-049).
const sb894 = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-SB894.json`, 'utf8')).bill;
const libla = sb894.sponsors.find((s) => s.people_id === 14996);
const fitzwater = sb894.sponsors.find((s) => s.people_id === 17512);

// ---- fake Supabase-shaped client (no network, no live DB — hard rule) ----
//
// Same chainable-builder-of-plain-objects convention as tests/ingest-mo-senate-cli.test.js's
// makeFakeLegislatorsDb: enough of the real supabase-js query-builder shape to drive
// src/adapters/legiscan-identity.js's actual call chains, nothing more. `terms` rows carry a
// `legislator_id` FK into `legislators`, joined in-memory exactly the way
// `.select('...,legislators(full_name)')` would resolve server-side.
function makeFakeDb({
  legislatorRows = [], termRows = [], missingColumn = false, termsThrows = false,
} = {}) {
  const legislators = [...legislatorRows];
  const terms = [...termRows];
  let counter = 0;
  const missingColumnError = {
    code: 'PGRST204',
    message: "Could not find the 'legiscan_people_id' column of 'legislators' in the schema cache",
  };
  const client = {
    from(table) {
      if (table === 'terms') {
        if (termsThrows) throw new Error('must not query terms on the exact-key repeat-call path — isolation is the point');
        // Generic thenable chain — accumulates every .eq() filter and resolves on `await`,
        // regardless of how many .eq() calls are chained first (the real query now chains THREE:
        // jurisdiction_id, chamber, district — CRITICAL fix round 2). Mirrors the real supabase-js
        // query builder's own "thenable at any point after .select()" shape.
        const buildQuery = (filters) => ({
          eq: (col, val) => buildQuery([...filters, [col, val]]),
          then: (resolve, reject) => {
            try {
              const matched = terms.filter((t) => filters.every(([c, v]) => t[c] === v));
              const data = matched.map((t) => {
                const leg = legislators.find((l) => l.id === t.legislator_id);
                return {
                  legislator_id: t.legislator_id,
                  chamber: t.chamber,
                  district: t.district,
                  start_date: t.start_date,
                  end_date: t.end_date,
                  legislators: leg ? { full_name: leg.full_name } : null,
                };
              });
              resolve({ data, error: null });
            } catch (err) {
              reject(err);
            }
          },
        });
        return { select: () => buildQuery([]) };
      }
      assert.equal(table, 'legislators');
      return {
        // A single .eq() call is used TWO ways by legiscan-identity.js: chained into
        // .maybeSingle()/.single() (exact-key lookup, row re-read), OR awaited directly for a
        // plain list result (fetchColumnDerivedCandidates' mo_senate_id/mo_house_id fallback
        // query) — the returned object supports both: it carries {data,error} directly (so
        // `await ...eq(...)` destructures correctly) AND the two single-row methods.
        select: () => ({
          eq: (c1, v1) => {
            const matchedRows = legislators.filter((l) => l[c1] === v1);
            const isLegiscanIdLookup = missingColumn && c1 === 'legiscan_people_id';
            return {
              data: isLegiscanIdLookup ? null : matchedRows.map((r) => ({ ...r })),
              error: isLegiscanIdLookup ? missingColumnError : null,
              maybeSingle: async () => {
                if (isLegiscanIdLookup) return { data: null, error: missingColumnError };
                return { data: matchedRows[0] ? { ...matchedRows[0] } : null, error: null };
              },
              single: async () => {
                if (matchedRows.length === 0) return { data: null, error: { message: `no row with ${c1}=${v1}` } };
                return { data: { ...matchedRows[0] }, error: null };
              },
            };
          },
        }),
        insert: (row) => ({
          select: () => ({
            single: async () => {
              if (missingColumn) return { data: null, error: missingColumnError };
              counter += 1;
              const inserted = { id: `leg-${counter}`, legiscan_people_id: null, ...row };
              legislators.push(inserted);
              return { data: { id: inserted.id }, error: null };
            },
          }),
        }),
        update: (patch) => ({
          eq: async (c1, v1) => {
            if (missingColumn && Object.prototype.hasOwnProperty.call(patch, 'legiscan_people_id')) {
              return { error: missingColumnError };
            }
            const found = legislators.find((l) => l[c1] === v1);
            if (found) Object.assign(found, patch);
            return { error: null };
          },
        }),
      };
    },
  };
  return { client, legislators, terms };
}

// ---- normalizePersonName (CONTROLLER RULING 3: conservative ONLY) ----

test('normalizePersonName: case/whitespace/punctuation folding', () => {
  assert.equal(normalizePersonName('  Douglas   Libla  '), 'douglas libla');
  assert.equal(normalizePersonName('O\'Brien, Mary-Jane'), 'mary-jane obrien');
  assert.equal(normalizePersonName('Travis Fitzwater'), 'travis fitzwater');
});

test('normalizePersonName: "Last, First" <-> "First Last" reordering', () => {
  assert.equal(normalizePersonName('Onder, Robert F.'), normalizePersonName('Robert F. Onder'));
  assert.equal(normalizePersonName('Onder, Robert F.'), 'robert f onder');
});

test('normalizePersonName: CONTROLLER RULING 3 — NO nickname table. "Bob Onder" and "Robert Onder" are DIFFERENT normalized names, by design (a miss creates a benign duplicate; a wrong merge corrupts attribution)', () => {
  assert.notEqual(normalizePersonName('Bob Onder'), normalizePersonName('Robert Onder'));
});

// ---- chamberFromRole / normalizeLegiscanDistrict ----

test('chamberFromRole: "Sen" -> senate, "Rep" -> house (verified-exhaustive against the real 189-person fixture)', () => {
  assert.equal(chamberFromRole('Sen'), 'senate');
  assert.equal(chamberFromRole('Rep'), 'house');
});

test('chamberFromRole: an unrecognized role throws UnrecognizedLegiscanRoleError, never silently guessed', () => {
  assert.throws(() => chamberFromRole('Joint'), UnrecognizedLegiscanRoleError);
});

test('normalizeLegiscanDistrict: LegiScan\'s "SD-002"/"HD-049" -> the bare-number convention mo_senate_id/mo_house_id already use ("2"/"49")', () => {
  assert.equal(normalizeLegiscanDistrict('SD-002'), '2');
  assert.equal(normalizeLegiscanDistrict('HD-049'), '49');
  assert.equal(normalizeLegiscanDistrict('SD-025'), '25');
});

test('normalizeLegiscanDistrict: an unrecognized shape passes through unchanged rather than guessing', () => {
  assert.equal(normalizeLegiscanDistrict('AL'), 'AL');
});

// ---- normalizeLegiscanParty (2026-08-02, found live: LegiScan's cached datasets print bare
// 'R'/'D' codes — verified directly against the newest cached dataset's real people[]) ----

test('normalizeLegiscanParty: bare R/D decode to the same full words every other active source already writes', () => {
  assert.equal(normalizeLegiscanParty('R'), 'Republican');
  assert.equal(normalizeLegiscanParty('D'), 'Democratic');
});

test('normalizeLegiscanParty: an unrecognized code (Independent, or a future one) passes through unchanged rather than guessing', () => {
  assert.equal(normalizeLegiscanParty('Independent'), 'Independent');
  assert.equal(normalizeLegiscanParty('X'), 'X');
});

test('normalizeLegiscanParty: null stays null, never coerced to a guessed word', () => {
  assert.equal(normalizeLegiscanParty(null), null);
  assert.equal(normalizeLegiscanParty(undefined), null);
});

test('LEGISCAN_PARTY_WORD_MAP: exactly the two codes LegiScan actually prints, matching migration 0018\'s already-reviewed CASE target', () => {
  assert.deepEqual(LEGISCAN_PARTY_WORD_MAP, { R: 'Republican', D: 'Democratic' });
});

// ---- fixture test bed: real numbers from the 189-person fixture (CONTROLLER RULING 4) ----

test('fixture test bed: dataset 1608 has 189 people, every one carries a district, role is Rep(156)/Sen(33) only', () => {
  assert.equal(dataset1608.people.length, 189);
  const withDistrict = dataset1608.people.filter((p) => p.district && p.district.trim() !== '');
  assert.equal(withDistrict.length, 189, 'every one of the 189 real people records has a district');
  const roleCounts = {};
  for (const p of dataset1608.people) roleCounts[p.role] = (roleCounts[p.role] ?? 0) + 1;
  assert.deepEqual(roleCounts, { Rep: 156, Sen: 33 });
});

test('fixture test bed: Bob/Robert Onder (people_id 16351) IS present in the real 189-person fixture', () => {
  const onder = dataset1608.people.find((p) => p.people_id === 16351);
  assert.ok(onder, 'Onder must be present in dataset-2018-1608');
  assert.deepEqual(
    {
      people_id: onder.people_id, name: onder.name, role: onder.role, district: onder.district, nickname: onder.nickname,
    },
    {
      people_id: 16351, name: 'Robert Onder', role: 'Sen', district: 'SD-002', nickname: 'Bob',
    },
  );
});

// ---- matchLegislator / eraOverlaps (src/lib/person-identity.js, the reusable core) ----

test('eraOverlaps: an open-ended term (end_date null) overlaps any era that has started', () => {
  assert.equal(eraOverlaps({ start_date: '2015-01-07', end_date: null }, { start: '2018-01-01', end: '2018-12-31' }), true);
});

test('eraOverlaps: a term that ended before the era window starts does not overlap', () => {
  assert.equal(eraOverlaps({ start_date: '2010-01-01', end_date: '2014-12-31' }, { start: '2018-01-01', end: '2018-12-31' }), false);
});

test('matchLegislator: dedupes by legislator_id — two overlapping terms rows for the SAME person is one match, not ambiguous', () => {
  const rows = [
    {
      legislator_id: 'leg-1', full_name: 'Jane Smith', chamber: 'senate', district: '7', start_date: '2013-01-01', end_date: '2016-12-31',
    },
    {
      legislator_id: 'leg-1', full_name: 'Jane Smith', chamber: 'senate', district: '7', start_date: '2017-01-01', end_date: null,
    },
  ];
  const result = matchLegislator({
    full_name: 'Jane Smith', chamber: 'senate', district: '7', era: { start: '2018-01-01', end: '2018-12-31' },
  }, rows);
  assert.equal(result.outcome, 'match');
  assert.equal(result.matches.length, 1);
});

// ---- findCandidateLegislatorRows: era-scoped, NEVER a bare district lookup ----

test('findCandidateLegislatorRows: same district, DIFFERENT chamber does not match — this is never a bare district lookup', async () => {
  const { client } = makeFakeDb({
    legislatorRows: [{ id: 'leg-1', full_name: 'Jane Smith', run_id: 'seed' }],
    termRows: [{
      legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '2', start_date: '2015-01-01', end_date: null,
    }],
  });
  const candidates = await findCandidateLegislatorRows(client, {
    fullNameNormalized: normalizePersonName('Jane Smith'),
    chamber: 'senate', // asking for SENATE district 2 — the fake only has a HOUSE district 2 row
    district: '2',
    sessionStartDate: '2018-01-01',
    sessionEndDate: '2018-12-31',
  });
  assert.equal(candidates.length, 0);
});

test('findCandidateLegislatorRows: a term outside the session era window is excluded even with a matching chamber/district/name', async () => {
  const { client } = makeFakeDb({
    legislatorRows: [{ id: 'leg-1', full_name: 'Jane Smith', run_id: 'seed' }],
    termRows: [{
      legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: '2005-01-01', end_date: '2009-12-31',
    }],
  });
  const candidates = await findCandidateLegislatorRows(client, {
    fullNameNormalized: normalizePersonName('Jane Smith'),
    chamber: 'senate',
    district: '2',
    sessionStartDate: '2018-01-01',
    sessionEndDate: '2018-12-31',
  });
  assert.equal(candidates.length, 0);
});

// ---- resolveOrCreateLegiscanPerson: the three-outcome resolver ----

test('resolveOrCreateLegiscanPerson: REAL Libla sponsor (people_id 14996, Sen, SD-025), zero candidates -> new row created, legiscan_people_id set, nickname persisted (finding 8, final wave: "Doug" — Libla\'s real fixture nickname)', async () => {
  const { client, legislators } = makeFakeDb();
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', libla, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.matched, false);
  assert.equal(result.created, true);
  assert.equal(result.reason, 'no_candidate');
  assert.equal(legislators.length, 1);
  assert.deepEqual(legislators[0], {
    // party: 'Republican', not the fixture's raw 'R' — normalizeLegiscanParty now applies at
    // insertion time (2026-08-02 fix), matching every other active source's already-full-word
    // convention rather than writing LegiScan's bare code verbatim.
    id: result.legislator_id, legiscan_people_id: 14996, full_name: 'Douglas Libla', surname: 'Libla', nickname: 'Doug', party: 'Republican', run_id: 'run-1',
  });
});

test('resolveOrCreateLegiscanPerson: REAL Fitzwater sponsor (people_id 17512, Rep, HD-049) against exactly ONE era-overlapping candidate -> additivePatch-style attach, no new row', async () => {
  const { client, legislators } = makeFakeDb({
    legislatorRows: [{
      id: 'leg-fitz', full_name: 'Travis Fitzwater', party: 'R', legiscan_people_id: null, run_id: 'seed',
    }],
    termRows: [{
      legislator_id: 'leg-fitz', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '49', start_date: '2017-01-01', end_date: null,
    }],
  });
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', fitzwater, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.matched, true);
  assert.equal(result.created, false);
  assert.equal(result.reason, 'single_candidate');
  assert.equal(result.legislator_id, 'leg-fitz');
  assert.equal(legislators.length, 1, 'no new row — the existing candidate was patched');
  assert.equal(legislators[0].legiscan_people_id, 17512);
});

test('resolveOrCreateLegiscanPerson: 2 candidates with overlapping windows (same-surname/same-name collision within one era, the mo-senate bug\'s exact shape) -> FAIL LOUD, new row created, NEVER guesses between them', async () => {
  const { client, legislators } = makeFakeDb({
    legislatorRows: [
      {
        id: 'leg-a', full_name: 'Jane Newperson', party: null, legiscan_people_id: null, run_id: 'seed',
      },
      {
        id: 'leg-b', full_name: 'Jane Newperson', party: null, legiscan_people_id: null, run_id: 'seed',
      },
    ],
    termRows: [
      {
        legislator_id: 'leg-a', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2015-01-01', end_date: null,
      },
      {
        legislator_id: 'leg-b', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2016-01-01', end_date: null,
      },
    ],
  });
  const person = {
    people_id: 99001, name: 'Jane Newperson', role: 'Sen', district: 'SD-007', party: null,
  };
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', person, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.matched, false);
  assert.equal(result.created, true);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.candidateCount, 2);
  assert.equal(legislators.length, 3, 'a NEW third row is created — neither ambiguous candidate is guessed at');
  assert.equal(legislators.find((l) => l.id === 'leg-a').legiscan_people_id, null, 'leg-a untouched');
  assert.equal(legislators.find((l) => l.id === 'leg-b').legiscan_people_id, null, 'leg-b untouched');
});

test('resolveOrCreateLegiscanPerson: repeat call for an already-legiscan_people_id-tagged person takes the safe unique-key path — findCandidateLegislatorRows/terms is NEVER queried (isolation is the point)', async () => {
  const { client, legislators } = makeFakeDb({
    legislatorRows: [{
      id: 'leg-libla', full_name: 'Douglas Libla', party: 'R', legiscan_people_id: 14996, run_id: 'seed',
    }],
    termsThrows: true, // proves the fuzzy-match path is never even reached
  });
  const result = await resolveOrCreateLegiscanPerson(client, 'run-2', libla, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.matched, true);
  assert.equal(result.created, false);
  assert.equal(result.reason, 'exact_key');
  assert.equal(result.legislator_id, 'leg-libla');
  assert.equal(legislators.length, 1, 'no duplicate row on a repeat call');
});

test('resolveOrCreateLegiscanPerson: a single candidate that already carries a DIFFERENT legiscan_people_id is a hard error (LegiscanIdentityConflictError), never a silent overwrite', async () => {
  const { client, legislators } = makeFakeDb({
    legislatorRows: [{
      id: 'leg-fitz', full_name: 'Travis Fitzwater', party: 'R', legiscan_people_id: 55555, run_id: 'seed',
    }],
    termRows: [{
      legislator_id: 'leg-fitz', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '49', start_date: '2017-01-01', end_date: null,
    }],
  });
  await assert.rejects(
    () => resolveOrCreateLegiscanPerson(client, 'run-1', fitzwater, { startDate: '2018-01-01', endDate: '2018-12-31' }),
    LegiscanIdentityConflictError,
  );
  assert.equal(legislators[0].legiscan_people_id, 55555, 'the existing (conflicting) value is untouched — no silent overwrite');
});

test('resolveOrCreateLegiscanPerson: missing legiscan_people_id column (migration 0010 not yet applied) is reported honestly, gated:true, never thrown', async () => {
  const { client, legislators } = makeFakeDb({ missingColumn: true });
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', libla, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.gated, true);
  assert.equal(result.matched, false);
  assert.match(result.note, /migration 0010/);
  assert.equal(legislators.length, 0, 'nothing written while gated');
});

// ---- CONTROLLER RULING 3, AMENDED (fix round 1): source-printed nickname variants ----

test('buildLegiscanNameVariants: given-name form only when no nickname is printed (Fitzwater — nickname:"")', () => {
  assert.deepEqual(buildLegiscanNameVariants(fitzwater), ['Travis Fitzwater']);
});

test('buildLegiscanNameVariants: given-name + nickname form when the source itself prints one (real Onder record: nickname:"Bob")', () => {
  const onder = dataset1608.people.find((p) => p.people_id === 16351);
  assert.deepEqual(buildLegiscanNameVariants(onder), ['Robert Onder', 'Bob Onder']);
});

// ---- the real Onder record: THE named worked example (task-5-brief.md CONTROLLER RULING 2) — a
// concrete, real finding, not assumed. Fix round 1 (controller adjudication on task-5-report.md
// concern 2): ruling 3 amended to include source-printed nickname variants; this is now the
// project's first REAL cross-source convergence. ----

test('resolveOrCreateLegiscanPerson: REAL Onder fixture record ("Robert Onder", people_id 16351) against a fake row mirroring his LIVE mo_senate shape ("Bob Onder", COLUMN-derived evidence only — no terms row, matching the real current gap in ensureRosterIdentities) -> the nickname variant now yields a single match, additivePatch attach: the project\'s first real cross-source convergence', async () => {
  const onder = dataset1608.people.find((p) => p.people_id === 16351);
  const { client, legislators } = makeFakeDb({
    // Mirrors the REAL live mo_senate roster shape exactly (tests/mo-senate-web.test.js /
    // tests/ingest-mo-senate-cli.test.js: full_name 'Bob Onder', mo_senate_id '2') AND the REAL
    // current gap (concern 1): src/cli/ingest-mo-senate.js's ensureRosterIdentities writes
    // mo_senate_id directly onto the legislators row but NO terms row at all — deliberately no
    // termRows here, so this test exercises the column-derived evidence fallback, not terms.
    legislatorRows: [{
      id: 'leg-onder-live', full_name: 'Bob Onder', party: null, surname: 'Onder', mo_senate_id: '2', legiscan_people_id: null, run_id: 'seed',
    }],
  });

  // dataset-2018-1608's own real roll-call dates fall in September 2018 (e.g. vote/774312.json:
  // "date":"2018-09-12") — squarely inside Onder's real 2015-2023 term, though era is moot here
  // anyway since column-derived evidence carries no dates (documented, not silently assumed).
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', onder, { startDate: '2018-09-01', endDate: '2018-09-30' });

  assert.equal(result.matched, true);
  assert.equal(result.created, false);
  assert.equal(result.reason, 'single_candidate');
  assert.equal(result.legislator_id, 'leg-onder-live');
  assert.equal(legislators.length, 1, 'no new row — LegiScan\'s "Robert Onder" attaches to the EXISTING "Bob Onder" row via the nickname variant');
  assert.equal(legislators[0].legiscan_people_id, 16351);
});

test('resolveOrCreateLegiscanPerson: a nickname variant that collides with a DIFFERENT existing row\'s name is AMBIGUOUS, never picked', async () => {
  const { client, legislators } = makeFakeDb({
    legislatorRows: [
      {
        id: 'leg-given', full_name: 'Robert Testson', party: null, legiscan_people_id: null, run_id: 'seed',
      },
      {
        id: 'leg-nick', full_name: 'Bob Testson', party: null, legiscan_people_id: null, run_id: 'seed',
      },
    ],
    termRows: [
      {
        legislator_id: 'leg-given', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '9', start_date: '2015-01-01', end_date: null,
      },
      {
        legislator_id: 'leg-nick', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '9', start_date: '2015-01-01', end_date: null,
      },
    ],
  });
  const person = {
    people_id: 99002, name: 'Robert Testson', nickname: 'Bob', last_name: 'Testson', role: 'Sen', district: 'SD-009', party: null,
  };
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', person, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.matched, false);
  assert.equal(result.created, true);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.candidateCount, 2, 'the given-name variant hits leg-given, the nickname variant hits leg-nick — two DIFFERENT rows, never guessed between');
  assert.equal(legislators.find((l) => l.id === 'leg-given').legiscan_people_id, null);
  assert.equal(legislators.find((l) => l.id === 'leg-nick').legiscan_people_id, null);
});

// ---- CONCERN 1, fixed (controller ruling): per-source identity columns as evidence when `terms`
// rows are absent — both evidence paths, plus the neither-case ----

test('findCandidateLegislatorRows: terms-evidence path (terms row present, no chamber column set) still finds the candidate', async () => {
  const { client } = makeFakeDb({
    legislatorRows: [{ id: 'leg-1', full_name: 'Jane Smith', run_id: 'seed' }],
    termRows: [{
      legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '4', start_date: '2015-01-01', end_date: null,
    }],
  });
  const candidates = await findCandidateLegislatorRows(client, {
    fullNameNormalized: normalizePersonName('Jane Smith'),
    chamber: 'senate',
    district: '4',
    sessionStartDate: '2018-01-01',
    sessionEndDate: '2018-12-31',
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].legislator_id, 'leg-1');
});

test('findCandidateLegislatorRows: column-derived fallback (mo_senate_id set, NO terms row at all) finds the candidate — the real ensureRosterIdentities gap', async () => {
  const { client } = makeFakeDb({
    legislatorRows: [{
      id: 'leg-1', full_name: 'Jane Smith', mo_senate_id: '4', run_id: 'seed',
    }],
  });
  const candidates = await findCandidateLegislatorRows(client, {
    fullNameNormalized: normalizePersonName('Jane Smith'),
    chamber: 'senate',
    district: '4',
    sessionStartDate: '2018-01-01',
    sessionEndDate: '2018-12-31',
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].legislator_id, 'leg-1');
  assert.equal(candidates[0].start_date, null, 'column-derived evidence carries no dates — honestly documented, not assumed');
});

test('findCandidateLegislatorRows: terms evidence is preferred, not duplicated — a legislator with BOTH a matching terms row AND the chamber column set is exactly ONE candidate', async () => {
  const { client } = makeFakeDb({
    legislatorRows: [{
      id: 'leg-1', full_name: 'Jane Smith', mo_senate_id: '4', run_id: 'seed',
    }],
    termRows: [{
      legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '4', start_date: '2015-01-01', end_date: null,
    }],
  });
  const candidates = await findCandidateLegislatorRows(client, {
    fullNameNormalized: normalizePersonName('Jane Smith'),
    chamber: 'senate',
    district: '4',
    sessionStartDate: '2018-01-01',
    sessionEndDate: '2018-12-31',
  });
  assert.equal(candidates.length, 1, 'no double-counting between the terms row and the column-derived fallback');
});

test('findCandidateLegislatorRows: the neither-case — no terms row AND no chamber-bearing column set — is never a candidate, an honest exclusion', async () => {
  const { client } = makeFakeDb({
    legislatorRows: [{ id: 'leg-1', full_name: 'Jane Smith', run_id: 'seed' }], // no mo_senate_id, no terms row
  });
  const candidates = await findCandidateLegislatorRows(client, {
    fullNameNormalized: normalizePersonName('Jane Smith'),
    chamber: 'senate',
    district: '4',
    sessionStartDate: '2018-01-01',
    sessionEndDate: '2018-12-31',
  });
  assert.equal(candidates.length, 0);
});

// ---- CRITICAL, fix round 2 (reviewer-reproduced against the real module): `terms` is SHARED
// across jurisdictions — a same-chamber/same-district/same-name row from a DIFFERENT jurisdiction
// (e.g. us-congress, which writes plain `terms` rows via src/cli/ingest.js's persistUsCongress,
// same chamber vocabulary 'house'/'senate') must never be treated as an MO candidate. The fake DB
// now genuinely models a second jurisdiction (termRows carry their own `jurisdiction_id`, and the
// fake's terms query filters on it exactly like the real one) — this is the structural fix the
// review noted the OLD fake could not have caught. ----

test('findCandidateLegislatorRows: a us-congress terms row sharing chamber+district+name is NEVER a candidate — the jurisdiction_id filter is real, not decorative', async () => {
  const { client } = makeFakeDb({
    legislatorRows: [{ id: 'leg-federal', full_name: 'Jane Smith', run_id: 'seed' }],
    termRows: [{
      // Same chamber, same bare-number district, same name as a hypothetical MO senate-district-4
      // candidate — the ONLY difference is jurisdiction_id. Without the CRITICAL fix this collides.
      legislator_id: 'leg-federal', jurisdiction_id: 'us-congress', chamber: 'senate', district: '4', start_date: '2015-01-01', end_date: null,
    }],
  });
  const candidates = await findCandidateLegislatorRows(client, {
    fullNameNormalized: normalizePersonName('Jane Smith'),
    chamber: 'senate',
    district: '4',
    sessionStartDate: '2018-01-01',
    sessionEndDate: '2018-12-31',
  });
  assert.equal(candidates.length, 0, 'a federal (us-congress) terms row must never surface as an MO candidate');
});

test('resolveOrCreateLegiscanPerson: end-to-end — a MO state sponsor whose chamber+district+name coincidentally matches a FEDERAL legislator\'s terms row never attaches to it; a new MO row is created instead', async () => {
  const { client, legislators } = makeFakeDb({
    legislatorRows: [{
      id: 'leg-federal', full_name: 'Jane Smith', legiscan_people_id: null, run_id: 'seed',
    }],
    termRows: [{
      legislator_id: 'leg-federal', jurisdiction_id: 'us-congress', chamber: 'senate', district: '4', start_date: '2015-01-01', end_date: null,
    }],
  });
  const person = {
    people_id: 99004, name: 'Jane Smith', first_name: 'Jane', last_name: 'Smith', nickname: '', role: 'Sen', district: 'SD-004', party: null,
  };
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', person, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.matched, false);
  assert.equal(result.created, true);
  assert.equal(result.reason, 'no_candidate', 'the federal row is invisible to this MO lookup — no false single_candidate match');
  assert.equal(legislators.length, 2, 'a NEW MO row is created; the federal row is untouched');
  assert.equal(legislators.find((l) => l.id === 'leg-federal').legiscan_people_id, null, 'the federal legislator row is never touched by a LegiScan MO resolution');
});

// ---- MINOR 1 (promoted): surname populated from the source's own printed last_name, never
// derived by splitting full_name ----

test('resolveOrCreateLegiscanPerson: a new row (no_candidate path) populates surname from the REAL fixture\'s own last_name field (Libla -> "Libla")', async () => {
  const { client, legislators } = makeFakeDb();
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', libla, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(legislators.find((l) => l.id === result.legislator_id).surname, 'Libla');
});

test('resolveOrCreateLegiscanPerson: a new row (ambiguous path) also populates surname from last_name, never split from full_name', async () => {
  const { client, legislators } = makeFakeDb({
    legislatorRows: [
      {
        id: 'leg-a', full_name: 'Jane Newperson', party: null, legiscan_people_id: null, run_id: 'seed',
      },
      {
        id: 'leg-b', full_name: 'Jane Newperson', party: null, legiscan_people_id: null, run_id: 'seed',
      },
    ],
    termRows: [
      {
        legislator_id: 'leg-a', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2015-01-01', end_date: null,
      },
      {
        legislator_id: 'leg-b', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2016-01-01', end_date: null,
      },
    ],
  });
  const person = {
    people_id: 99005, name: 'Jane Newperson', last_name: 'Newperson', role: 'Sen', district: 'SD-007', party: null,
  };
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', person, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.reason, 'ambiguous');
  assert.equal(legislators.find((l) => l.id === result.legislator_id).surname, 'Newperson');
});

test('resolveOrCreateLegiscanPerson: surname stays null when last_name is absent on the source record — never guessed by splitting full_name', async () => {
  const { client, legislators } = makeFakeDb();
  const person = {
    people_id: 99006, name: 'No Lastname Field', role: 'Sen', district: 'SD-011', party: null,
  }; // deliberately no last_name key at all
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', person, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(legislators.find((l) => l.id === result.legislator_id).surname, null);
});

// ---- finding 8 (final wave): both insert sites persist the source-printed nickname AT INGEST
// time now, dissolving the dependency on src/cli/backfill-nicknames.js running afterward for any
// NEW row from here on (the backfill CLI remains the correction path for rows already ingested
// before this fix). One test per insert site, plus the absent-on-source case. ----

test('resolveOrCreateLegiscanPerson: finding 8 — the no_candidate insert site persists the REAL fixture nickname verbatim (Libla -> "Doug")', async () => {
  const { client, legislators } = makeFakeDb();
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', libla, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.reason, 'no_candidate');
  assert.equal(legislators.find((l) => l.id === result.legislator_id).nickname, 'Doug');
});

test('resolveOrCreateLegiscanPerson: finding 8 — the ambiguous (FAIL LOUD, >1 candidates) insert site ALSO persists a printed nickname verbatim, never dropped on the fail-loud path', async () => {
  const { client, legislators } = makeFakeDb({
    legislatorRows: [
      {
        id: 'leg-a', full_name: 'Jane Newperson', party: null, legiscan_people_id: null, run_id: 'seed',
      },
      {
        id: 'leg-b', full_name: 'Jane Newperson', party: null, legiscan_people_id: null, run_id: 'seed',
      },
    ],
    termRows: [
      {
        legislator_id: 'leg-a', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2015-01-01', end_date: null,
      },
      {
        legislator_id: 'leg-b', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2016-01-01', end_date: null,
      },
    ],
  });
  const person = {
    people_id: 99008, name: 'Jane Newperson', last_name: 'Newperson', nickname: 'Janie', role: 'Sen', district: 'SD-007', party: null,
  };
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', person, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.reason, 'ambiguous');
  assert.equal(legislators.find((l) => l.id === result.legislator_id).nickname, 'Janie');
});

test('resolveOrCreateLegiscanPerson: finding 8 — nickname stays null (never guessed) when absent on the source record, at BOTH insert sites', async () => {
  const { client: client1, legislators: legislators1 } = makeFakeDb();
  const noNicknamePerson = {
    people_id: 99009, name: 'No Nickname Field', last_name: 'Field', role: 'Sen', district: 'SD-012', party: null,
  }; // deliberately no nickname key
  const result1 = await resolveOrCreateLegiscanPerson(client1, 'run-1', noNicknamePerson, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result1.reason, 'no_candidate');
  assert.equal(legislators1.find((l) => l.id === result1.legislator_id).nickname, null);

  const { client: client2, legislators: legislators2 } = makeFakeDb({
    legislatorRows: [
      {
        id: 'leg-c', full_name: 'Pat Multiple', party: null, legiscan_people_id: null, run_id: 'seed',
      },
      {
        id: 'leg-d', full_name: 'Pat Multiple', party: null, legiscan_people_id: null, run_id: 'seed',
      },
    ],
    termRows: [
      {
        legislator_id: 'leg-c', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '9', start_date: '2015-01-01', end_date: null,
      },
      {
        legislator_id: 'leg-d', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '9', start_date: '2016-01-01', end_date: null,
      },
    ],
  });
  const noNicknameAmbiguousPerson = {
    people_id: 99010, name: 'Pat Multiple', last_name: 'Multiple', role: 'Sen', district: 'SD-009', party: null,
  };
  const result2 = await resolveOrCreateLegiscanPerson(client2, 'run-1', noNicknameAmbiguousPerson, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result2.reason, 'ambiguous');
  assert.equal(legislators2.find((l) => l.id === result2.legislator_id).nickname, null);
});

// ---- MINOR 2: nickname identical to first_name — Set-dedup makes this harmless, locked here ----

test('buildLegiscanNameVariants + resolveOrCreateLegiscanPerson: a nickname IDENTICAL to first_name produces a redundant-but-harmless duplicate variant — Set-dedup in matchLegislator collapses it, never a false ambiguous', async () => {
  const person = {
    people_id: 99007, name: 'Travis Fitzwater', first_name: 'Travis', last_name: 'Fitzwater', nickname: 'Travis', role: 'Rep', district: 'HD-049', party: 'R',
  };
  assert.deepEqual(buildLegiscanNameVariants(person), ['Travis Fitzwater', 'Travis Fitzwater']);

  const { client, legislators } = makeFakeDb({
    legislatorRows: [{
      id: 'leg-fitz2', full_name: 'Travis Fitzwater', party: 'R', legiscan_people_id: null, run_id: 'seed',
    }],
    termRows: [{
      legislator_id: 'leg-fitz2', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '49', start_date: '2017-01-01', end_date: null,
    }],
  });
  const result = await resolveOrCreateLegiscanPerson(client, 'run-1', person, { startDate: '2018-01-01', endDate: '2018-12-31' });
  assert.equal(result.matched, true);
  assert.equal(result.reason, 'single_candidate', 'a duplicate variant must never read as two candidates');
  assert.equal(legislators.length, 1);
});
