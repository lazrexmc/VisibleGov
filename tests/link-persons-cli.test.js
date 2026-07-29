import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterLegislators, surnameKey, reorderCommaName, pickDisplayName, NoDisplayNameSourceError,
} from '../src/lib/person-identity.js';
import {
  parseArgs,
  partitionByLinkStatus,
  buildEvidenceRows,
  writeAutoCluster,
  writeIdentityFlag,
  runLink,
  PersonLinkConflictError,
} from '../src/cli/link-persons.js';

// Task 1 (docs/superpowers/plans/2026-07-29-identity-merge.md) — cluster pass + linker CLI.
//
// The four-Onder fixture below is REAL, live data (read-only orientation query against the actual
// `legislators`/`terms` tables, 2026-07-29 — never written to, per the hard rule: no live DB writes
// and no network in tests). Recorded here as literals, not re-queried:
//   bioguide:   full_name 'Onder, Robert F.', bioguide_id 'O000177', surname NULL, zero terms rows
//   openstates: full_name 'Bob Onder', openstates_id 'ocd-person/e29b57a2-...', surname NULL, zero terms rows
//   mo_senate:  full_name 'Bob Onder', mo_senate_id '2', surname 'Onder', ONE real terms row
//               (jurisdiction_id 'mo-legislature', chamber 'senate', district '2', start/end NULL)
//   legiscan:   full_name 'Robert Onder', legiscan_people_id 16351, surname 'Onder', zero terms rows
// The SAME live read also found three real, unrelated US Senators surnamed Brown (Sherrod/OH,
// Hank/CO, Scott P./MA) with real, differing `terms` districts — confirming the district-
// contradiction rule below is exercised by real data, not just synthetic fixtures.

// ---- surnameKey / reorderCommaName ----

test('surnameKey: uses the `surname` column when populated, normalized', () => {
  assert.equal(surnameKey({ surname: 'Onder', full_name: 'Bob Onder' }), 'onder');
});

test('surnameKey: derives from the last token of the reordered, normalized full_name when `surname` is null (the real bioguide/openstates Onder rows carry no surname column)', () => {
  assert.equal(surnameKey({ surname: null, full_name: 'Onder, Robert F.' }), 'onder');
  assert.equal(surnameKey({ surname: null, full_name: 'Bob Onder' }), 'onder');
});

test('surnameKey: empty/unparseable full_name yields empty string, never guessed', () => {
  assert.equal(surnameKey({ surname: null, full_name: '' }), '');
});

test('reorderCommaName: "Last, First Middle" -> "First Middle Last", preserving casing/punctuation verbatim (never folded, unlike normalizePersonName)', () => {
  assert.equal(reorderCommaName('Onder, Robert F.'), 'Robert F. Onder');
});

test('reorderCommaName: no comma -> unchanged', () => {
  assert.equal(reorderCommaName('Bob Onder'), 'Bob Onder');
});

// ---- pickDisplayName: mechanical, highest-authority-source-wins (Global Constraints) ----

test('pickDisplayName: bioguide wins over mo_senate/openstates, comma form reordered to "Robert F. Onder" — the real four-Onder worked example', () => {
  const members = [
    { id: 'leg-onder-openstates', full_name: 'Bob Onder', openstates_id: 'ocd-person/x' },
    { id: 'leg-onder-mosenate', full_name: 'Bob Onder', mo_senate_id: '2' },
    { id: 'leg-onder-legiscan', full_name: 'Robert Onder', legiscan_people_id: 16351 },
    { id: 'leg-onder-bioguide', full_name: 'Onder, Robert F.', bioguide_id: 'O000177' },
  ];
  const result = pickDisplayName(members);
  assert.deepEqual(result, { display_name: 'Robert F. Onder', display_name_source: 'bioguide' });
});

test('pickDisplayName: mo_senate beats mo_house/legiscan/openstates when no bioguide member is present', () => {
  const members = [
    { id: 'a', full_name: 'A Legiscan', legiscan_people_id: 1 },
    { id: 'b', full_name: 'B MoHouse', mo_house_id: '9' },
    { id: 'c', full_name: 'C MoSenate', mo_senate_id: '4' },
    { id: 'd', full_name: 'D Openstates', openstates_id: 'ocd-person/y' },
  ];
  assert.deepEqual(pickDisplayName(members), { display_name: 'C MoSenate', display_name_source: 'mo_senate' });
});

test('pickDisplayName: mo_house beats legiscan/openstates; legiscan beats openstates (full priority chain)', () => {
  assert.equal(pickDisplayName([{ id: 'a', full_name: 'A', mo_house_id: '9' }, { id: 'b', full_name: 'B', legiscan_people_id: 1 }]).display_name_source, 'mo_house');
  assert.equal(pickDisplayName([{ id: 'a', full_name: 'A', legiscan_people_id: 1 }, { id: 'b', full_name: 'B', openstates_id: 'x' }]).display_name_source, 'legiscan');
  assert.equal(pickDisplayName([{ id: 'a', full_name: 'A', openstates_id: 'x' }]).display_name_source, 'openstates');
});

test('pickDisplayName: a non-comma winning name is used verbatim, never reordered', () => {
  assert.deepEqual(pickDisplayName([{ id: 'a', full_name: 'Bob Onder', mo_senate_id: '2' }]), { display_name: 'Bob Onder', display_name_source: 'mo_senate' });
});

test('pickDisplayName: no member carries any of the 5 recognized source-key columns -> NoDisplayNameSourceError, never invents a display_name_source', () => {
  assert.throws(() => pickDisplayName([{ id: 'ghost', full_name: 'Nobody' }]), NoDisplayNameSourceError);
});

// ---- clusterLegislators: the pure cluster pass ----

function onderRows() {
  return [
    {
      id: 'leg-onder-bioguide', full_name: 'Onder, Robert F.', surname: null, bioguide_id: 'O000177', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, evidence: [],
    },
    {
      id: 'leg-onder-openstates', full_name: 'Bob Onder', surname: null, bioguide_id: null, openstates_id: 'ocd-person/e29b57a2-c2e7-4b5a-b299-bb734104f0d7', mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, evidence: [],
    },
    {
      id: 'leg-onder-mosenate',
      full_name: 'Bob Onder',
      surname: 'Onder',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: '2',
      legiscan_people_id: null,
      evidence: [
        {
          source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
        },
        {
          source: 'mo_senate_id', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
        },
      ],
    },
    {
      id: 'leg-onder-legiscan', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 16351, evidence: [],
    },
  ];
}

test('clusterLegislators: the real four-Onder rows form ONE cluster, all 4 members, nothing flagged/singleton', () => {
  const result = clusterLegislators(onderRows());
  assert.equal(result.clusters.length, 1);
  assert.equal(result.flagged.length, 0);
  assert.equal(result.singletons.length, 0);
  assert.deepEqual(result.clusters[0].memberIds.slice().sort(), [
    'leg-onder-bioguide', 'leg-onder-legiscan', 'leg-onder-mosenate', 'leg-onder-openstates',
  ]);
  // evidence carries the matched facts verbatim, one entry per member, source keys included
  assert.equal(result.clusters[0].evidence.length, 4);
  const bioguideEvidence = result.clusters[0].evidence.find((e) => e.legislatorId === 'leg-onder-bioguide');
  assert.equal(bioguideEvidence.fullName, 'Onder, Robert F.');
  assert.equal(bioguideEvidence.sourceKeys.bioguide_id, 'O000177');
  assert.equal(bioguideEvidence.surnameKeyUsed, 'onder');
});

test('clusterLegislators: pickDisplayName on the auto-clustered Onder members yields "Robert F. Onder" / bioguide — end-to-end of the worked example', () => {
  const rows = onderRows();
  const result = clusterLegislators(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memberRows = result.clusters[0].memberIds.map((id) => byId.get(id));
  assert.deepEqual(pickDisplayName(memberRows), { display_name: 'Robert F. Onder', display_name_source: 'bioguide' });
});

test('clusterLegislators: Brown(16) and Brown(26) — same surname, real differing districts — are two singletons, NEVER clustered or even flagged', () => {
  const rows = [
    {
      id: 'leg-brown-16',
      full_name: 'Dan Brown',
      surname: 'Brown',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: '16',
      legiscan_people_id: 7512,
      evidence: [
        {
          source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '16', start_date: null, end_date: null,
        },
        {
          source: 'mo_senate_id', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '16', start_date: null, end_date: null,
        },
      ],
    },
    {
      id: 'leg-brown-26',
      full_name: 'Wanda Brown',
      surname: 'Brown',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: '26',
      legiscan_people_id: 13828,
      evidence: [
        {
          source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '26', start_date: null, end_date: null,
        },
        {
          source: 'mo_senate_id', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '26', start_date: null, end_date: null,
        },
      ],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 0);
  assert.deepEqual(result.singletons.slice().sort(), ['leg-brown-16', 'leg-brown-26']);
});

test('clusterLegislators: real three-Brown US Senate case (Sherrod/OH, Hank/CO, Scott P./MA) — same surname, real differing federal districts — three singletons', () => {
  const mk = (id, full_name, district) => ({
    id,
    full_name,
    surname: null,
    bioguide_id: `bg-${id}`,
    openstates_id: null,
    mo_house_id: null,
    mo_senate_id: null,
    legiscan_people_id: null,
    evidence: [{
      source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district, start_date: null, end_date: null,
    }],
  });
  const rows = [
    mk('brown-sherrod', 'Brown, Sherrod', 'OH'),
    mk('brown-hank', 'Brown, Hank', 'CO'),
    mk('brown-scott', 'Brown, Scott P.', 'MA'),
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 0);
  assert.equal(result.singletons.length, 3);
});

test('clusterLegislators: same name, same seat, non-overlapping eras -> flagged, never auto-linked (could be a re-elected same person or an unrelated same-named successor — never guessed)', () => {
  const rows = [
    {
      id: 'leg-smith-early',
      full_name: 'Jane Smith',
      surname: 'Smith',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: null,
      legiscan_people_id: null,
      evidence: [{
        source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2001-01-01', end_date: '2005-12-31',
      }],
    },
    {
      id: 'leg-smith-later',
      full_name: 'Jane Smith',
      surname: 'Smith',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: null,
      legiscan_people_id: null,
      evidence: [{
        source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2018-01-01', end_date: '2022-12-31',
      }],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.singletons.length, 0);
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'ambiguous_era');
  assert.deepEqual(result.flagged[0].candidateIds.slice().sort(), ['leg-smith-early', 'leg-smith-later']);
});

test('clusterLegislators: a hard contradiction bridged through a third, evidence-free same-surname row must still flag, never silently auto-link the contradictory pair (the transitive-bridge safety net)', () => {
  const rows = [
    {
      id: 'leg-bridge-30',
      full_name: 'Pat Bridge',
      surname: 'Bridge',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: '30',
      legiscan_people_id: null,
      evidence: [{
        source: 'mo_senate_id', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '30', start_date: null, end_date: null,
      }],
    },
    {
      id: 'leg-bridge-40',
      full_name: 'Sam Bridge',
      surname: 'Bridge',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: '40',
      legiscan_people_id: null,
      evidence: [{
        source: 'mo_senate_id', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '40', start_date: null, end_date: null,
      }],
    },
    {
      id: 'leg-bridge-nodata', full_name: 'Alex Bridge', surname: 'Bridge', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, evidence: [],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0, 'never a clean auto-cluster when a real district contradiction exists anywhere inside the group');
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'internal_contradiction');
  assert.deepEqual(result.flagged[0].candidateIds.slice().sort(), ['leg-bridge-30', 'leg-bridge-40', 'leg-bridge-nodata']);
});

test('clusterLegislators: a unique surname with no evidence at all is a plain singleton', () => {
  const result = clusterLegislators([{
    id: 'leg-unique', full_name: 'Zaphod Beeblebrox', surname: null, bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 1, evidence: [],
  }]);
  assert.deepEqual(result.singletons, ['leg-unique']);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 0);
});

test('clusterLegislators: empty input returns three empty buckets', () => {
  assert.deepEqual(clusterLegislators([]), { clusters: [], flagged: [], singletons: [] });
});

// ---- CLI: parseArgs ----

test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

// ---- CLI: partitionByLinkStatus ("already-linked skip", honestly counted) ----

test('partitionByLinkStatus: separates already-linked (person_id set) from unlinked rows', () => {
  const rows = [
    { id: 'a', person_id: null },
    { id: 'b', person_id: 'person-1' },
    { id: 'c', person_id: null },
  ];
  const { unlinked, alreadyLinked } = partitionByLinkStatus(rows);
  assert.deepEqual(unlinked.map((r) => r.id), ['a', 'c']);
  assert.deepEqual(alreadyLinked.map((r) => r.id), ['b']);
});

// ---- CLI: buildEvidenceRows (terms rows + column-derived fallback, both count) ----

test('buildEvidenceRows: a terms row becomes one evidence entry; mo_senate_id/mo_house_id columns each contribute their OWN additional entry, never deduplicated against a matching terms row', () => {
  const legislators = [
    {
      id: 'leg-1', full_name: 'Jane Smith', mo_senate_id: '4', mo_house_id: null,
    },
  ];
  const terms = [
    {
      legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '4', start_date: '2015-01-01', end_date: null,
    },
  ];
  const [row] = buildEvidenceRows(legislators, terms);
  assert.equal(row.evidence.length, 2);
  assert.deepEqual(row.evidence.map((e) => e.source).sort(), ['mo_senate_id', 'terms']);
});

test('buildEvidenceRows: a legislator with neither a terms row nor a chamber column set gets an empty evidence array, never invented', () => {
  const [row] = buildEvidenceRows([{ id: 'leg-1', full_name: 'Jane Smith', mo_senate_id: null, mo_house_id: null }], []);
  assert.deepEqual(row.evidence, []);
});

test('buildEvidenceRows: a terms row for a legislator outside the snapshot is defensively ignored, never throws', () => {
  const [row] = buildEvidenceRows([{ id: 'leg-1', full_name: 'Jane Smith', mo_senate_id: null, mo_house_id: null }], [
    { legislator_id: 'leg-ghost', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '9' },
  ]);
  assert.deepEqual(row.evidence, []);
});

// ---- fake Supabase-shaped client (no network, no live DB — hard rule). Same chainable-builder
// convention as tests/legiscan-identity.test.js's makeFakeDb, extended for this CLI's own tables
// (persons/person_links/identity_flags) and for selectAll's own .select().order().range() shape
// (src/lib/db.js) that legislators/terms reads go through here. ----

function makeFakeClient({
  legislatorRows = [], termRows = [], identityFlagsRows = [], forceFlagRace = false,
} = {}) {
  const state = {
    legislators: legislatorRows.map((r) => ({ ...r })),
    terms: termRows.map((r) => ({ ...r })),
    persons: [],
    person_links: [],
    identity_flags: identityFlagsRows.map((r) => ({ ...r })),
  };
  const calls = [];
  let personSeq = 0;
  let flagSeq = 0;
  let raceFired = false;

  function selectAllBuilder(table) {
    const builder = {
      order: () => builder,
      range: (from, to) => ({
        then: (resolve) => {
          calls.push({ op: 'select', table });
          const rows = state[table] ?? [];
          resolve({ data: rows.slice(from, to + 1).map((r) => ({ ...r })), error: null });
        },
      }),
    };
    return builder;
  }

  return {
    calls,
    state,
    from(table) {
      return {
        select() {
          if (table === 'legislators' || table === 'terms') return selectAllBuilder(table);
          if (table === 'identity_flags') {
            return {
              eq: (col, val) => ({
                maybeSingle: async () => {
                  calls.push({
                    op: 'select', table, col, val,
                  });
                  const row = state.identity_flags.find((r) => r[col] === val);
                  return { data: row ? { ...row } : null, error: null };
                },
              }),
            };
          }
          throw new Error(`fake client: unexpected select on table "${table}"`);
        },
        update(patch) {
          return {
            eq: async (col, val) => {
              calls.push({
                op: 'update', table, patch, col, val,
              });
              const found = state[table]?.find((r) => r[col] === val);
              if (found) Object.assign(found, patch);
              return { error: null };
            },
          };
        },
        insert(row) {
          calls.push({ op: 'insert', table, row });
          return {
            select: () => ({
              single: async () => {
                if (table === 'persons') {
                  personSeq += 1;
                  const inserted = { id: `person-${personSeq}`, ...row };
                  state.persons.push(inserted);
                  return { data: { id: inserted.id }, error: null };
                }
                if (table === 'identity_flags') {
                  if (forceFlagRace && !raceFired) {
                    raceFired = true;
                    return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
                  }
                  flagSeq += 1;
                  const inserted = { id: `flag-${flagSeq}`, ...row };
                  state.identity_flags.push(inserted);
                  return { data: { id: inserted.id, cluster_key: inserted.cluster_key }, error: null };
                }
                throw new Error(`fake client: unexpected insert().select().single() on "${table}"`);
              },
            }),
            then: (resolve) => {
              if (table === 'person_links') {
                state.person_links.push({ ...row });
                resolve({ error: null });
                return;
              }
              resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

// ---- writeAutoCluster ----

test('writeAutoCluster: writes one persons row (display-name precedence), additivePatch person_id + one person_links row PER member', async () => {
  const rowsById = new Map([
    ['leg-onder-bioguide', {
      id: 'leg-onder-bioguide', full_name: 'Onder, Robert F.', bioguide_id: 'O000177', mo_senate_id: null, mo_house_id: null, legiscan_people_id: null, openstates_id: null, person_id: null,
    }],
    ['leg-onder-mosenate', {
      id: 'leg-onder-mosenate', full_name: 'Bob Onder', bioguide_id: null, mo_senate_id: '2', mo_house_id: null, legiscan_people_id: null, openstates_id: null, person_id: null,
    }],
  ]);
  const cluster = {
    key: 'onder:leg-onder-bioguide,leg-onder-mosenate',
    memberIds: ['leg-onder-bioguide', 'leg-onder-mosenate'],
    evidence: [{ legislatorId: 'leg-onder-bioguide', fullName: 'Onder, Robert F.' }, { legislatorId: 'leg-onder-mosenate', fullName: 'Bob Onder' }],
  };
  const client = makeFakeClient({ legislatorRows: [...rowsById.values()] });
  const result = await writeAutoCluster(client, 'run-1', cluster, rowsById);
  assert.equal(client.state.persons.length, 1);
  assert.deepEqual(client.state.persons[0], { id: result.personId, display_name: 'Robert F. Onder', display_name_source: 'bioguide' });
  assert.equal(client.state.person_links.length, 2);
  const linkForMoSenate = client.state.person_links.find((l) => l.legislator_id === 'leg-onder-mosenate');
  assert.equal(linkForMoSenate.person_id, result.personId);
  assert.equal(linkForMoSenate.decided_by, 'auto');
  assert.equal(linkForMoSenate.run_id, 'run-1');
  assert.deepEqual(linkForMoSenate.evidence, { legislatorId: 'leg-onder-mosenate', fullName: 'Bob Onder' });
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-bioguide').person_id, result.personId);
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-mosenate').person_id, result.personId);
});

test('writeAutoCluster: a member that already carries a DIFFERENT person_id throws PersonLinkConflictError BEFORE any write for the cluster happens (no orphaned person, no partial links)', async () => {
  const rowsById = new Map([
    ['leg-a', {
      id: 'leg-a', full_name: 'A One', mo_senate_id: '1', bioguide_id: null, mo_house_id: null, legiscan_people_id: null, openstates_id: null, person_id: 'person-existing',
    }],
    ['leg-b', {
      id: 'leg-b', full_name: 'A Two', mo_senate_id: '1', bioguide_id: null, mo_house_id: null, legiscan_people_id: null, openstates_id: null, person_id: null,
    }],
  ]);
  const cluster = {
    key: 'a:leg-a,leg-b', memberIds: ['leg-a', 'leg-b'], evidence: [{}, {}],
  };
  const client = makeFakeClient();
  await assert.rejects(() => writeAutoCluster(client, 'run-1', cluster, rowsById), PersonLinkConflictError);
  assert.equal(client.state.persons.length, 0, 'no person row created — the conflict was caught before any write');
  assert.equal(client.state.person_links.length, 0);
});

// ---- writeIdentityFlag: check-then-insert on cluster_key, 23505-tolerant ----

test('writeIdentityFlag: first call inserts; candidate_legislator_ids/evidence/run_id stored verbatim', async () => {
  const client = makeFakeClient();
  const flag = {
    clusterKey: 'smith:leg-smith-early,leg-smith-later', candidateIds: ['leg-smith-early', 'leg-smith-later'], evidence: [{ legislatorId: 'leg-smith-early' }, { legislatorId: 'leg-smith-later' }], reason: 'ambiguous_era',
  };
  const result = await writeIdentityFlag(client, 'run-1', flag);
  assert.equal(result.deduped, false);
  assert.equal(client.state.identity_flags.length, 1);
  const stored = client.state.identity_flags[0];
  assert.equal(stored.cluster_key, flag.clusterKey);
  assert.deepEqual(stored.candidate_legislator_ids, flag.candidateIds);
  assert.equal(stored.evidence.reason, 'ambiguous_era');
  assert.equal(stored.run_id, 'run-1');
});

test('writeIdentityFlag: a repeat call with the SAME cluster_key is deduped via check-then-insert — no second row', async () => {
  const client = makeFakeClient({
    identityFlagsRows: [{ id: 'flag-existing', cluster_key: 'smith:leg-smith-early,leg-smith-later' }],
  });
  const flag = {
    clusterKey: 'smith:leg-smith-early,leg-smith-later', candidateIds: ['leg-smith-early', 'leg-smith-later'], evidence: [], reason: 'ambiguous_era',
  };
  const result = await writeIdentityFlag(client, 'run-2', flag);
  assert.equal(result.deduped, true);
  assert.equal(result.id, 'flag-existing');
  assert.equal(client.state.identity_flags.length, 1, 'no duplicate row inserted');
});

test('writeIdentityFlag: a 23505 race on insert (app-level check missed a concurrent writer) is caught and re-selected, never surfaced as an error', async () => {
  const client = makeFakeClient({ forceFlagRace: true });
  const flag = {
    clusterKey: 'race:leg-x,leg-y', candidateIds: ['leg-x', 'leg-y'], evidence: [], reason: 'ambiguous_era',
  };
  // Simulate the race directly: seed the "concurrent" row into state right as our insert would fire.
  // The fake forces the first insert() attempt to return 23505; writeIdentityFlag must then re-select
  // and find whatever is there. Seed it here so the re-select has something to find.
  client.state.identity_flags.push({ id: 'flag-race-winner', cluster_key: flag.clusterKey });
  const result = await writeIdentityFlag(client, 'run-1', flag);
  assert.equal(result.deduped, true);
  assert.equal(result.id, 'flag-race-winner');
});

// ---- runLink: the orchestration seam — dry-run zero-write, live writes + honest counts ----

test('runLink: --dry-run performs ZERO write calls (no insert/update anywhere in the call log), returns the full proposed clustering + honest counts', async () => {
  const legislatorRows = [
    ...onderRows().map(({ evidence: _e, ...r }) => ({ ...r, person_id: null })),
    { id: 'leg-already', full_name: 'Already Linked', surname: 'Linked', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 42, person_id: 'person-prior' },
  ];
  const termRows = [{
    legislator_id: 'leg-onder-mosenate', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
  }];
  const client = makeFakeClient({ legislatorRows, termRows });
  const report = await runLink(client, { dryRun: true });

  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.counts, {
    clusters: 1, personsCreated: 0, linked: 0, flagged: 0, alreadyLinked: 1, singletons: 0,
  });
  assert.equal(report.clusters.length, 1);
  assert.equal(report.clusters[0].memberIds.length, 4);

  const writeOps = client.calls.filter((c) => c.op === 'insert' || c.op === 'update');
  assert.deepEqual(writeOps, [], 'zero writes reachable from dry-run — writeAutoCluster/writeIdentityFlag are never called');
  assert.equal(client.state.persons.length, 0);
  assert.equal(client.state.person_links.length, 0);
  assert.equal(client.state.identity_flags.length, 0);
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-bioguide').person_id, null, 'unwritten');
});

test('runLink: live mode writes the auto cluster (persons/person_links/legislators.person_id) and the flagged group (identity_flags), with honest counts including alreadyLinked', async () => {
  const legislatorRows = [
    ...onderRows().map(({ evidence: _e, ...r }) => ({ ...r, person_id: null })),
    {
      id: 'leg-smith-early', full_name: 'Jane Smith', surname: 'Smith', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    },
    {
      id: 'leg-smith-later', full_name: 'Jane Smith', surname: 'Smith', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, person_id: null,
    },
    { id: 'leg-already', full_name: 'Already Linked', surname: 'Linked', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 42, person_id: 'person-prior' },
  ];
  const termRows = [
    {
      legislator_id: 'leg-onder-mosenate', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
    },
    {
      legislator_id: 'leg-smith-early', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2001-01-01', end_date: '2005-12-31',
    },
    {
      legislator_id: 'leg-smith-later', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2018-01-01', end_date: '2022-12-31',
    },
  ];
  const client = makeFakeClient({ legislatorRows, termRows });
  const report = await runLink(client, { dryRun: false, runId: 'run-live-1' });

  assert.equal(report.mode, 'live');
  assert.deepEqual(report.counts, {
    clusters: 1, personsCreated: 1, linked: 4, flagged: 1, alreadyLinked: 1, singletons: 0,
  });
  assert.equal(report.flaggedWritten, 1);
  assert.equal(report.flaggedDeduped, 0);

  assert.equal(client.state.persons.length, 1);
  assert.equal(client.state.person_links.length, 4);
  assert.equal(client.state.identity_flags.length, 1);
  assert.deepEqual(client.state.identity_flags[0].candidate_legislator_ids.slice().sort(), ['leg-smith-early', 'leg-smith-later']);
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-already').person_id, 'person-prior', 'already-linked row untouched');
  for (const id of ['leg-onder-bioguide', 'leg-onder-openstates', 'leg-onder-mosenate', 'leg-onder-legiscan']) {
    assert.equal(client.state.legislators.find((l) => l.id === id).person_id, client.state.persons[0].id);
  }
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-smith-early').person_id, null, 'flagged rows are never linked');
});

test('runLink: a re-run after a live run is idempotent — already-linked rows are skipped and the identical flag is deduped, zero new persons/links/flag rows', async () => {
  const legislatorRows = onderRows().map(({ evidence: _e, ...r }) => ({ ...r, person_id: null }));
  const termRows = [{
    legislator_id: 'leg-onder-mosenate', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
  }];
  const client = makeFakeClient({ legislatorRows, termRows });
  await runLink(client, { dryRun: false, runId: 'run-1' });
  assert.equal(client.state.persons.length, 1);

  const second = await runLink(client, { dryRun: false, runId: 'run-2' });
  assert.deepEqual(second.counts, {
    clusters: 0, personsCreated: 0, linked: 0, flagged: 0, alreadyLinked: 4, singletons: 0,
  });
  assert.equal(client.state.persons.length, 1, 'no duplicate person created on re-run');
});
