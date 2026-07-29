import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterLegislators, surnameKey, reorderCommaName, pickDisplayName, NoDisplayNameSourceError, fullNameVariantMatch, auditClusterCoherence, nameSetEdgeBasis,
} from '../src/lib/person-identity.js';
import {
  parseArgs,
  partitionByLinkStatus,
  buildEvidenceRows,
  writeAutoCluster,
  writeIdentityFlag,
  runLink,
  PersonLinkConflictError,
  ClusterNameVariantViolationError,
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

// IMPORTANT fix round 1: the original two-way comma split corrupted a real bioguide suffix name
// shape ('Family, Given, Suffix' — three comma-separated segments), dragging the suffix into the
// middle of the printed name ('John J., Jr. Duncan'). Fixed to split on every comma: segment 0 =
// family, segment 1 = given, any remaining segments = suffixes re-appended after the family name.

test('reorderCommaName: IMPORTANT fix round 1 — a three-segment bioguide suffix name ("Duncan, John J., Jr.") reorders to "John J. Duncan, Jr.", never dragging the suffix into the middle', () => {
  assert.equal(reorderCommaName('Duncan, John J., Jr.'), 'John J. Duncan, Jr.');
});

test('reorderCommaName: the plain two-segment case is unaffected by the fix (regression)', () => {
  assert.equal(reorderCommaName('Onder, Robert F.'), 'Robert F. Onder');
  assert.equal(reorderCommaName('Smith, Jane'), 'Jane Smith');
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

// FIX ROUND 2: the real four-Onder rows no longer form ONE cluster. Round 1's design let the
// bioguide/openstates/legiscan rows join mo_senate's real evidence purely vacuously (zero
// comparable evidence on 3 of the 4 sides), with no name check at all — exactly the gap the live
// run's Symington/Adams/Walker wrong-merges exposed. Under the corrected, unconditional
// full-name-variant gate: 'Bob Onder' (openstates) === 'Bob Onder' (mo_senate) literally, so THAT
// pair still clusters; 'Onder, Robert F.' (bioguide) matches 'Robert Onder' (legiscan) on
// given+family ('robert'+'onder', the middle initial 'F.' is deliberately not part of the match
// key), so THAT pair also clusters — but 'Bob' never equals 'Robert' (CONTROLLER RULING 3: no
// nickname table, verified repeatedly in tests/legiscan-identity.test.js), so nothing connects the
// two pairs to each other. Result: two clean, SAFE 2-member clusters, never one wrongly-bridged
// 4-member cluster, and never a false flag either — this is the honest, correct outcome for what
// the persisted data actually supports without inventing a nickname lookup. (A future ingestion
// change that persists a source-printed nickname, the way legiscan-identity.js's own per-record
// resolution already does, could reunite these two — out of scope for the cluster pass itself.)
test('clusterLegislators FIX ROUND 2: the real four-Onder rows form TWO clean 2-member clusters (Bob/Bob via literal match, Robert/Robert via given+family), never one falsely-bridged cluster and never a flag', () => {
  const result = clusterLegislators(onderRows());
  assert.equal(result.clusters.length, 2);
  assert.equal(result.flagged.length, 0);
  assert.equal(result.singletons.length, 0);
  const memberSets = result.clusters.map((c) => c.memberIds.slice().sort());
  assert.deepEqual(memberSets.sort(), [
    ['leg-onder-bioguide', 'leg-onder-legiscan'].sort(),
    ['leg-onder-mosenate', 'leg-onder-openstates'].sort(),
  ].sort());
  const bobCluster = result.clusters.find((c) => c.memberIds.includes('leg-onder-mosenate'));
  const bioguideEvidence = bobCluster == null
    ? null
    : result.clusters.find((c) => c.memberIds.includes('leg-onder-bioguide')).evidence.find((e) => e.legislatorId === 'leg-onder-bioguide');
  assert.equal(bioguideEvidence.fullName, 'Onder, Robert F.');
  assert.equal(bioguideEvidence.sourceKeys.bioguide_id, 'O000177');
  assert.equal(bioguideEvidence.surnameKeyUsed, 'onder');
});

// ---- nickname amendment (.superpowers/sdd/2026-07-29-identity-merge/progress.md, last entry;
// FIX ROUND 1, controller-reviewed CRITICAL finding, execution-proven): migration 0013 persists
// LegiScan's own source-printed person.nickname onto legislators.nickname; clusterLegislators now
// consumes it as an additional exact-match given-name variant via PAIRWISE PRINTED-NAME-SET
// INTERSECTION (nameSetEdgeBasis in src/lib/person-identity.js) — NEVER a union-find/transitive
// token equivalence (fix round 0's implementation fabricated equivalences no source printed —
// robert~bob + robert~rob would have wrongly implied bob~rob; caught by review before any live
// run). ----

test('clusterLegislators NICKNAME AMENDMENT: the real four-Onder rows, WITH nickname "Bob" persisted on the legiscan row, form ONE FLAGGED group (never silently auto-clustered) — legiscan bridges bioguide directly (residual identical name) AND openstates/mosenate directly (direct nickname edge), but bioguide never shares a printed token with openstates/mosenate THEMSELVES, so the pre-existing exhaustive-pairwise-recheck safety net (same mechanism as the "John Duncan" suffix-omission bridge) correctly surfaces this for Lance\'s review rather than trusting an unproven gap', () => {
  const rows = onderRows();
  const legiscanRow = rows.find((r) => r.id === 'leg-onder-legiscan');
  legiscanRow.nickname = 'Bob'; // source-printed, verified real: LegiScan people_id 16351
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0, 'never a clean auto-cluster — bioguide has no direct printed-name overlap with openstates/mosenate');
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'internal_no_name_variant');
  assert.deepEqual(result.flagged[0].candidateIds.slice().sort(), [
    'leg-onder-bioguide', 'leg-onder-legiscan', 'leg-onder-mosenate', 'leg-onder-openstates',
  ]);
  assert.equal(result.singletons.length, 0);
  // The nickname still rides into the flagged group's own evidence snapshot (buildMemberEvidence)
  // — visible to a future review-tab rendering as the concrete bridging evidence, never dropped.
  const legiscanEvidence = result.flagged[0].evidence.find((e) => e.legislatorId === 'leg-onder-legiscan');
  assert.equal(legiscanEvidence.nickname, 'Bob');
  const bioguideEvidence = result.flagged[0].evidence.find((e) => e.legislatorId === 'leg-onder-bioguide');
  assert.equal(bioguideEvidence.nickname, null, 'a member with no persisted nickname carries null, never guessed');
});

test('clusterLegislators NICKNAME AMENDMENT: withOUT a persisted nickname anywhere, the real four-Onder rows still split into the current two 2-member clusters (regression — unchanged from fix round 2)', () => {
  const result = clusterLegislators(onderRows());
  assert.equal(result.clusters.length, 2);
  assert.equal(result.flagged.length, 0);
  const memberSets = result.clusters.map((c) => c.memberIds.slice().sort());
  assert.deepEqual(memberSets.sort(), [
    ['leg-onder-bioguide', 'leg-onder-legiscan'].sort(),
    ['leg-onder-mosenate', 'leg-onder-openstates'].sort(),
  ].sort());
});

// The POSITIVE case: a nickname DOES produce a clean, immediate auto-cluster when it directly
// bridges every pair in a 2-member group (the simplest fully-pairwise-satisfied shape) — proving
// the mechanism actually works, not just that it correctly declines to over-reach.
test('clusterLegislators NICKNAME AMENDMENT: a nickname directly bridging a 2-row group (every pair pairwise-matches) forms ONE clean cluster — a real "direct_name" edge, auditClusterCoherence confirms it is NOT a residual-only cluster', () => {
  const rows = [
    {
      id: 'leg-onder-legiscan2', full_name: 'Robert Onder', nickname: 'Bob', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 16351, evidence: [],
    },
    {
      id: 'leg-onder-bareBob', full_name: 'Bob Onder', nickname: null, surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: '2', legiscan_people_id: null, evidence: [],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.flagged.length, 0);
  assert.deepEqual(result.clusters[0].memberIds.slice().sort(), ['leg-onder-bareBob', 'leg-onder-legiscan2']);
  const audit = auditClusterCoherence(result.clusters);
  assert.deepEqual(audit, {
    ok: true,
    violations: [],
    clusterEdgeBasis: [{ clusterKey: result.clusters[0].key, direct_name_edges: 1, residual_identical_name_edges: 0 }],
    residualOnlyClusters: [],
  });
});

test('clusterLegislators NICKNAME AMENDMENT: a nickname is scoped to its OWN surname group, never a global cross-surname nickname table — an unrelated "Bob Smith"/"Robert Smith" pair is unaffected by Onder\'s own nickname evidence appearing in the SAME clusterLegislators call', () => {
  const rows = [
    {
      id: 'leg-onder-legiscan2', full_name: 'Robert Onder', nickname: 'Bob', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 16351, evidence: [],
    },
    {
      id: 'leg-onder-bareBob', full_name: 'Bob Onder', nickname: null, surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: '2', legiscan_people_id: null, evidence: [],
    },
    {
      id: 'leg-smith-robert', full_name: 'Robert Smith', surname: 'Smith', bioguide_id: 'bg-smith-r', openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, nickname: null, evidence: [],
    },
    {
      id: 'leg-smith-bob', full_name: 'Bob Smith', surname: 'Smith', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 9001, nickname: null, evidence: [],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 1, 'only the directly nickname-bridged Onder pair forms');
  assert.deepEqual(result.clusters[0].memberIds.slice().sort(), ['leg-onder-bareBob', 'leg-onder-legiscan2']);
  assert.deepEqual(result.singletons.slice().sort(), ['leg-smith-bob', 'leg-smith-robert'], 'Robert Smith/Bob Smith stay two singletons — no cross-surname nickname bridging');
});

// ---- FIX ROUND 1 CRITICAL repro, reviewer's exact scenarios encoded verbatim (semantics a/b/c) ----

function mkJonesHub(id, fullName, nickname) {
  return {
    id, full_name: fullName, nickname, surname: 'Jones', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: null, evidence: [],
  };
}

test('clusterLegislators NICKNAME AMENDMENT FIX ROUND 1 (a): two identical-full-name hubs ("Robert Jones") each printing a DIFFERENT nickname (Bob / Rob) — bare-Bob connects to hub1 (sourced direct_name edge), the two hubs connect via the pre-existing identical-name residual, bare-Rob connects to hub2 (sourced direct_name edge) — the component still forms (all 4 land in one group via real, chained edges), but bob<->rob have NO direct edge, so the exhaustive-pairwise-recheck correctly FLAGS the whole group rather than auto-clustering it (this is exactly the shape the CRITICAL union-find bug would have wrongly auto-linked, by fabricating a direct bob==rob equivalence no source ever printed)', () => {
  const rows = [
    mkJonesHub('leg-hub1', 'Robert Jones', 'Bob'),
    mkJonesHub('leg-hub2', 'Robert Jones', 'Rob'),
    mkJonesHub('leg-barebob', 'Bob Jones', null),
    mkJonesHub('leg-barerob', 'Rob Jones', null),
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0, 'the old union-find bug would have produced ONE clean cluster here — the fix must not');
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'internal_no_name_variant');
  assert.deepEqual(result.flagged[0].candidateIds.slice().sort(), ['leg-barebob', 'leg-barerob', 'leg-hub1', 'leg-hub2']);
  assert.equal(result.singletons.length, 0);
});

test('clusterLegislators NICKNAME AMENDMENT FIX ROUND 1 (b): the discriminating case — hubs with DIFFERENT given names ("Robert Jones"/nickname Bob vs "Roberto Jones"/nickname Rob) — no identical-name edge between the hubs, and their printed name-sets {robert,bob}/{roberto,rob} do not intersect, so the component SPLITS into two independent, clean 2-member clusters instead of one flagged group', () => {
  const rows = [
    mkJonesHub('leg-hub1', 'Robert Jones', 'Bob'),
    mkJonesHub('leg-hub2', 'Roberto Jones', 'Rob'),
    mkJonesHub('leg-barebob', 'Bob Jones', null),
    mkJonesHub('leg-barerob', 'Rob Jones', null),
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.flagged.length, 0);
  assert.equal(result.clusters.length, 2);
  const memberSets = result.clusters.map((c) => c.memberIds.slice().sort());
  assert.deepEqual(memberSets.sort(), [
    ['leg-barebob', 'leg-hub1'].sort(),
    ['leg-barerob', 'leg-hub2'].sort(),
  ].sort());
});

test('clusterLegislators NICKNAME AMENDMENT FIX ROUND 1 (c): a plain "Bob"-given row and a plain "Rob"-given row, NO hubs at all — no shared printed token anywhere, so they never connect (two singletons, not even flagged)', () => {
  const rows = [
    mkJonesHub('leg-barebob', 'Bob Jones', null),
    mkJonesHub('leg-barerob', 'Rob Jones', null),
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 0);
  assert.deepEqual(result.singletons.slice().sort(), ['leg-barebob', 'leg-barerob']);
});

test('clusterLegislators: pickDisplayName on the bioguide+legiscan Onder cluster yields "Robert F. Onder" / bioguide — end-to-end of the worked example', () => {
  const rows = onderRows();
  const result = clusterLegislators(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bioguideCluster = result.clusters.find((c) => c.memberIds.includes('leg-onder-bioguide'));
  const memberRows = bioguideCluster.memberIds.map((id) => byId.get(id));
  assert.deepEqual(pickDisplayName(memberRows), { display_name: 'Robert F. Onder', display_name_source: 'bioguide' });
});

test('clusterLegislators: pickDisplayName on the mo_senate+openstates Onder cluster yields "Bob Onder" / mo_senate (no bioguide member in THIS cluster)', () => {
  const rows = onderRows();
  const result = clusterLegislators(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bobCluster = result.clusters.find((c) => c.memberIds.includes('leg-onder-mosenate'));
  const memberRows = bobCluster.memberIds.map((id) => byId.get(id));
  assert.deepEqual(pickDisplayName(memberRows), { display_name: 'Bob Onder', display_name_source: 'mo_senate' });
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

// ---- FIX ROUND 2 (CRITICAL, execution-proven): the three REAL wrong merges the live run
// produced, caught by the plan's own post-run spot-check, full rollback executed. Round 1's gate
// only covered same-seat evidence pairs; a pair with NO comparable seat evidence at all (different
// chamber, different jurisdiction, or evidence-free) skipped straight to a vacuous 'compatible'
// verdict without ever checking names. All three shapes below are now regression tests: never
// clustered, never silently linked. ----

test('clusterLegislators FIX ROUND 2 (live wrong-merge #1): "Symington, Stuart" (Senate) and "Symington, James W." (House) — father/son, real DATED terms evidence on BOTH sides, but different chamber so never comparable — stay two singletons, never auto-linked', () => {
  const rows = [
    {
      id: 'leg-symington-stuart',
      full_name: 'Symington, Stuart',
      surname: null,
      bioguide_id: 'bg-symington-stuart',
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: null,
      legiscan_people_id: null,
      evidence: [{
        source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district: 'MO', start_date: '1953-01-01', end_date: '1976-12-31',
      }],
    },
    {
      id: 'leg-symington-james',
      full_name: 'Symington, James W.',
      surname: null,
      bioguide_id: 'bg-symington-james',
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: null,
      legiscan_people_id: null,
      evidence: [{
        source: 'terms', jurisdiction_id: 'us-congress', chamber: 'house', district: '2', start_date: '1969-01-01', end_date: '1977-01-01',
      }],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 0, 'different chamber = no comparable evidence at all, and the given names (Stuart/James) do not match -> no-pair, not even a flag');
  assert.deepEqual(result.singletons.slice().sort(), ['leg-symington-james', 'leg-symington-stuart']);
});

test('clusterLegislators FIX ROUND 2 (live wrong-merge #2): "Brock Adams" and "Joe Adams" — different jurisdiction, so their evidence is never comparable — stay two singletons', () => {
  const rows = [
    {
      id: 'leg-adams-brock',
      full_name: 'Brock Adams',
      surname: 'Adams',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: null,
      legiscan_people_id: null,
      evidence: [{
        source: 'terms', jurisdiction_id: 'us-congress', chamber: 'house', district: '7', start_date: '1965-01-01', end_date: '1977-01-01',
      }],
    },
    {
      id: 'leg-adams-joe',
      full_name: 'Joe Adams',
      surname: 'Adams',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: '7',
      legiscan_people_id: null,
      evidence: [{
        source: 'mo_house_id', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '7', start_date: null, end_date: null,
      }],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 0);
  assert.deepEqual(result.singletons.slice().sort(), ['leg-adams-brock', 'leg-adams-joe']);
});

test('clusterLegislators FIX ROUND 2 (live wrong-merge #3): "Cora Walker" and "Nathan Walker" — both entirely evidence-free, surname only — stay two singletons, never linked on a bare surname collision', () => {
  const rows = [
    {
      id: 'leg-walker-cora', full_name: 'Cora Walker', surname: 'Walker', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 501, evidence: [],
    },
    {
      id: 'leg-walker-nathan', full_name: 'Nathan Walker', surname: 'Walker', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 502, evidence: [],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 0);
  assert.deepEqual(result.singletons.slice().sort(), ['leg-walker-cora', 'leg-walker-nathan']);
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

// FIX ROUND 2: with DIFFERENT given names (Pat/Sam/Alex), the old "evidence-free row bridges
// vacuously regardless of name" gap is exactly what's closed — leg-bridge-nodata ('Alex Bridge')
// no longer connects to EITHER of the other two (no comparable evidence + no full-name-variant
// match = 'no-pair', never an edge), so leg-bridge-30 and leg-bridge-40 (which directly
// 'contradiction' each other on district) never even get a chance to be bridged. All three land as
// separate singletons — this is itself the regression proof that the live Symington/Adams/Walker
// shape (same surname, different given names, at least one evidence-free) can no longer produce
// ANY pairing at all, let alone a false cluster or an unhelpful flag.
test('clusterLegislators FIX ROUND 2: different given names sharing a surname never bridge, even via an evidence-free third row — three singletons, not a flag (the Symington/Adams/Walker shape)', () => {
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
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 0, 'FIX ROUND 2: no edges at all form between different given names, so there is nothing left to bridge or flag');
  assert.deepEqual(result.singletons.slice().sort(), ['leg-bridge-30', 'leg-bridge-40', 'leg-bridge-nodata']);
});

// The transitive-bridge safety net is STILL necessary post-fix — it's just harder to trigger now,
// requiring the bridging row to genuinely share a full-name variant with BOTH contradicting ends.
// Same full name on all three ('Pat Bridge' x3): leg-pbridge-30/leg-pbridge-40 directly
// 'contradiction' (real, differing districts) and never union with each other, but
// leg-pbridge-nodata (zero evidence, SAME name) unions with EACH of them individually
// ('no-evidence' + namesMatch=true -> 'compatible'), transitively bridging all three into one
// connected component. The full pairwise re-scan must still catch the internal contradiction and
// flag the whole group, never trust the union-find edges alone.
test('clusterLegislators: the transitive-bridge safety net still fires post-fix when the bridging row genuinely shares the SAME full name as both contradicting ends', () => {
  const rows = [
    {
      id: 'leg-pbridge-30',
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
      id: 'leg-pbridge-40',
      full_name: 'Pat Bridge',
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
      id: 'leg-pbridge-nodata', full_name: 'Pat Bridge', surname: 'Bridge', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, evidence: [],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0, 'never a clean auto-cluster when a real district contradiction exists anywhere inside the group');
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'internal_contradiction');
  assert.deepEqual(result.flagged[0].candidateIds.slice().sort(), ['leg-pbridge-30', 'leg-pbridge-40', 'leg-pbridge-nodata']);
});

// A DIFFERENT residual bridging risk fix round 1's suffix-omission tolerance creates: 'no-pair' is
// not (and cannot safely be made) transitive the way exact equality is. 'John Duncan' (no suffix)
// matches BOTH 'John Duncan Jr.' and 'John Duncan Sr.' individually (an omitted suffix never
// blocks a match), even though Jr. and Sr. do NOT match each other directly (their suffixes
// disagree) — so a no-suffix same-base row can still bridge two suffix-disqualified rows into one
// component. The safety net's full pairwise re-scan catches this too: internal_no_name_variant
// (fix round 2's new reason), never a silent auto-cluster.
test('clusterLegislators: the safety net also catches a suffix-omission bridge — "John Duncan" (no suffix, evidence-free) connects to BOTH "...Jr." and "...Sr." individually (omission tolerated), but Jr. and Sr. never match each other directly (no-pair, both evidence-free)', () => {
  const mkDuncan = (id, fullName) => ({
    id,
    full_name: fullName,
    surname: 'Duncan',
    bioguide_id: null,
    openstates_id: null,
    mo_house_id: null,
    mo_senate_id: null,
    legiscan_people_id: null,
    evidence: [], // evidence-free on all three: the "surname collision, nothing else" shape —
    // this is what makes Jr<->Sr directly 'no-pair' (no evidence AND suffixes disagree), rather
    // than 'ambiguous' via shared real seat evidence.
  });
  const rows = [
    mkDuncan('leg-duncan-jr2', 'John Duncan Jr.'),
    mkDuncan('leg-duncan-sr2', 'John Duncan Sr.'),
    mkDuncan('leg-duncan-plain', 'John Duncan'),
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'internal_no_name_variant');
  assert.deepEqual(result.flagged[0].candidateIds.slice().sort(), ['leg-duncan-jr2', 'leg-duncan-plain', 'leg-duncan-sr2']);
});

// ---- fullNameVariantMatch (CRITICAL fix round 1's own gate) ----

test('fullNameVariantMatch: exact same printed name matches', () => {
  assert.equal(fullNameVariantMatch('Robert Jones', 'Robert Jones'), true);
});

test('fullNameVariantMatch: different given names on the same surname do NOT match', () => {
  assert.equal(fullNameVariantMatch('Robert Jones', 'David Jones'), false);
});

test('fullNameVariantMatch: a suffix printed on only ONE side does not block a match — omission is not a disqualifying signal', () => {
  assert.equal(fullNameVariantMatch('John Duncan', 'John Duncan Jr.'), true);
});

test('fullNameVariantMatch: BOTH sides printing the SAME suffix still matches', () => {
  assert.equal(fullNameVariantMatch('John Duncan Jr.', 'John Duncan Jr.'), true);
});

test('fullNameVariantMatch: BOTH sides printing a DIFFERENT suffix is a disqualifying signal — the live worked example', () => {
  assert.equal(fullNameVariantMatch('John Duncan Jr.', 'John Duncan Sr.'), false);
});

// FIX ROUND 2: the match key is "given+family" (the ruling's own words) — a middle name/initial is
// deliberately NOT part of it, a structural extraction of the row's own printed parts (first token
// = given, last non-suffix token = family), never an invented equivalence. This is what still lets
// the real bioguide Onder row ('Onder, Robert F.' -> reordered 'Robert F. Onder') match the real
// legiscan Onder row ('Robert Onder') post-fix, while still NEVER bridging 'Bob' to 'Robert' (no
// nickname table, CONTROLLER RULING 3 stands).

test('fullNameVariantMatch: FIX ROUND 2 — a middle name/initial is ignored (given+family only): "Onder, Robert F." (reordered "Robert F. Onder") matches "Robert Onder"', () => {
  assert.equal(fullNameVariantMatch('Onder, Robert F.', 'Robert Onder'), true);
});

test('fullNameVariantMatch: a middle name difference alone does not block a match either (still given+family only)', () => {
  assert.equal(fullNameVariantMatch('John Quincy Adams', 'John Adams'), true);
});

test('fullNameVariantMatch: still never bridges an actual nickname — "Bob Onder" and "Robert Onder" remain DIFFERENT given names, no nickname table', () => {
  assert.equal(fullNameVariantMatch('Bob Onder', 'Robert Onder'), false);
});

// ---- nameSetEdgeBasis (nickname amendment FIX ROUND 1's own gate — pairwise printed-name-set
// intersection, NO union-find over tokens, NO cross-row token equivalence, ever) ----

test('nameSetEdgeBasis: identical plain given names (no nicknames involved at all) -> residual_identical_name, the pre-existing accepted residual', () => {
  assert.equal(nameSetEdgeBasis({ full_name: 'Robert Jones' }, { full_name: 'Robert Jones' }), 'residual_identical_name');
});

test('nameSetEdgeBasis: a row\'s own printed nickname bridging the OTHER row\'s plain given name -> direct_name', () => {
  assert.equal(nameSetEdgeBasis({ full_name: 'Robert Onder', nickname: 'Bob' }, { full_name: 'Bob Onder' }), 'direct_name');
  assert.equal(nameSetEdgeBasis({ full_name: 'Bob Onder' }, { full_name: 'Robert Onder', nickname: 'Bob' }), 'direct_name', 'symmetric regardless of argument order');
});

test('nameSetEdgeBasis: two DIFFERENT nicknames sharing only a coincidental identical-given hub on EACH side individually -> null when compared to EACH OTHER directly (the exact CRITICAL bug: no fabricated bob<->rob equivalence)', () => {
  assert.equal(nameSetEdgeBasis({ full_name: 'Bob Jones' }, { full_name: 'Rob Jones' }), null);
});

test('nameSetEdgeBasis: no shared printed token at all -> null', () => {
  assert.equal(nameSetEdgeBasis({ full_name: 'Robert Jones' }, { full_name: 'Roberto Jones', nickname: 'Rob' }), null);
});

test('nameSetEdgeBasis: a row\'s nickname equal to its OWN given name contributes nothing new (set collapses), still residual_identical_name against a matching plain row', () => {
  assert.equal(nameSetEdgeBasis({ full_name: 'Robert Jones', nickname: 'Robert' }, { full_name: 'Robert Jones' }), 'residual_identical_name');
});

// ---- CRITICAL fix round 1: a same-seat evidence pair that can only claim "cannot rule out
// overlap" because a date is simply MISSING (not because it's genuinely known to overlap) must not
// default to 'compatible' unless the two rows' own printed full names actually agree. Execution-
// proven finding: MO `terms` dates are null almost everywhere live and every column-derived
// evidence entry is null-dated by construction, so the OLD rule silently auto-linked a same-seat,
// different-person (district-successor-shaped) pair on nothing but a missing date. ----

test('clusterLegislators CRITICAL fix: same surname, same seat, BOTH dateless, DIFFERENT given names -> flagged, never silently auto-linked (smith-sr/smith-jr repro)', () => {
  const mkSmith = (id, fullName) => ({
    id,
    full_name: fullName,
    surname: 'Smith',
    bioguide_id: null,
    openstates_id: null,
    mo_house_id: null,
    mo_senate_id: '11',
    legiscan_people_id: null,
    evidence: [{
      source: 'mo_senate_id', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '11', start_date: null, end_date: null,
    }],
  });
  const rows = [mkSmith('leg-smith-sr', 'Robert Smith'), mkSmith('leg-smith-jr', 'David Smith')];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0, 'the OLD rule would have auto-linked this — surname-only + dateless is no longer enough');
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'ambiguous_era');
  assert.deepEqual(result.flagged[0].candidateIds.slice().sort(), ['leg-smith-jr', 'leg-smith-sr']);
});

test('clusterLegislators CRITICAL fix: one side dated, other dateless, same seat, DIFFERENT given names -> flagged (jones-sr/jones-jr repro)', () => {
  const rows = [
    {
      id: 'leg-jones-sr',
      full_name: 'Robert Jones',
      surname: 'Jones',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: null,
      legiscan_people_id: null,
      evidence: [{
        source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '14', start_date: '2001-01-01', end_date: '2009-12-31',
      }],
    },
    {
      id: 'leg-jones-jr',
      full_name: 'David Jones',
      surname: 'Jones',
      bioguide_id: null,
      openstates_id: null,
      mo_house_id: null,
      mo_senate_id: null,
      legiscan_people_id: null,
      evidence: [{
        source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '14', start_date: null, end_date: null,
      }],
    },
  ];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'ambiguous_era');
});

test('clusterLegislators CRITICAL fix: the ACCEPTED RESIDUAL — same seat, BOTH dateless, IDENTICAL full name -> still compatible (auto-links); documented in the module comment above evidencePairStatus as mechanically indistinguishable from a re-elected same person until term dates are backfilled', () => {
  const mkJones = (id) => ({
    id,
    full_name: 'Robert Jones',
    surname: 'Jones',
    bioguide_id: null,
    openstates_id: null,
    mo_house_id: null,
    mo_senate_id: null,
    legiscan_people_id: null,
    evidence: [{
      source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '14', start_date: null, end_date: null,
    }],
  });
  const result = clusterLegislators([mkJones('leg-jones-a'), mkJones('leg-jones-b')]);
  assert.equal(result.flagged.length, 0);
  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0].memberIds.slice().sort(), ['leg-jones-a', 'leg-jones-b']);
});

test('clusterLegislators CRITICAL fix: printed suffix mismatch ("John Duncan Jr." vs "John Duncan Sr."), same seat, both dateless -> ambiguous, never treated as the same person', () => {
  const mkDuncan = (id, fullName) => ({
    id,
    full_name: fullName,
    surname: 'Duncan',
    bioguide_id: null,
    openstates_id: null,
    mo_house_id: null,
    mo_senate_id: null,
    legiscan_people_id: null,
    evidence: [{
      source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '20', start_date: null, end_date: null,
    }],
  });
  const rows = [mkDuncan('leg-duncan-jr', 'John Duncan Jr.'), mkDuncan('leg-duncan-sr', 'John Duncan Sr.')];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'ambiguous_era');
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

// ---- auditClusterCoherence (fix round 2's third, permanent, non-destructive layer) ----

test('auditClusterCoherence: clusterLegislators\' own output always passes (structural guarantee) — the real Onder clusters, Brown singletons, and dynasty flags all together; without any persisted nickname, both auto-clusters are (correctly) residual-only, since the pre-existing identical-full-name residual is the only reason either pair matched', () => {
  const onder = clusterLegislators(onderRows());
  const audit = auditClusterCoherence(onder.clusters);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.violations, []);
  assert.equal(audit.clusterEdgeBasis.length, 2);
  assert.ok(audit.clusterEdgeBasis.every((c) => c.direct_name_edges === 0 && c.residual_identical_name_edges === 1));
  assert.equal(audit.residualOnlyClusters.length, 2, 'FIX ROUND 1 (AUDIT INDEPENDENCE): both clusters are visibly marked residual-only — visibility, not a new gate, since ok stays true');
});

test('auditClusterCoherence: an empty cluster list passes trivially, with empty edge-basis reporting', () => {
  const empty = {
    ok: true, violations: [], clusterEdgeBasis: [], residualOnlyClusters: [],
  };
  assert.deepEqual(auditClusterCoherence([]), empty);
  assert.deepEqual(auditClusterCoherence(undefined), empty);
});

test('auditClusterCoherence: catches a HAND-BUILT cluster (bypassing clusterLegislators entirely) whose members do not share a full-name variant — this is the exact shape that must never reach a live run; zero edge-basis counted for a violating pair', () => {
  const badCluster = {
    key: 'bad:1,2',
    memberIds: ['1', '2'],
    evidence: [
      { legislatorId: '1', fullName: 'Stuart Symington' },
      { legislatorId: '2', fullName: 'James W. Symington' },
    ],
  };
  const result = auditClusterCoherence([badCluster]);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].clusterKey, 'bad:1,2');
  assert.deepEqual([result.violations[0].legislatorIdA, result.violations[0].legislatorIdB].sort(), ['1', '2']);
  assert.deepEqual(result.clusterEdgeBasis, [{ clusterKey: 'bad:1,2', direct_name_edges: 0, residual_identical_name_edges: 0 }]);
  assert.deepEqual(result.residualOnlyClusters, [], 'a purely violating (non-matching) pair is not "residual-only" — it is not held together at all');
});

test('auditClusterCoherence: FIX ROUND 1 AUDIT INDEPENDENCE — a hand-built cluster whose ONLY connection is a source-printed nickname (never trusting clusterLegislators\' own verdict) is classified direct_name, not residual, and correctly NOT residual-only', () => {
  const goodCluster = {
    key: 'onder-nick:1,2',
    memberIds: ['1', '2'],
    evidence: [
      { legislatorId: '1', fullName: 'Robert Onder', nickname: 'Bob' },
      { legislatorId: '2', fullName: 'Bob Onder', nickname: null },
    ],
  };
  const result = auditClusterCoherence([goodCluster]);
  assert.deepEqual(result, {
    ok: true,
    violations: [],
    clusterEdgeBasis: [{ clusterKey: 'onder-nick:1,2', direct_name_edges: 1, residual_identical_name_edges: 0 }],
    residualOnlyClusters: [],
  });
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
  // FIX ROUND 2: bioguide+legiscan, not bioguide+mo_senate — 'Onder, Robert F.' and 'Robert Onder'
  // share a full-name variant (given='robert', family='onder'); 'Bob Onder' (mo_senate) does not
  // (see the dedicated ClusterNameVariantViolationError test below for that case).
  const rowsById = new Map([
    ['leg-onder-bioguide', {
      id: 'leg-onder-bioguide', full_name: 'Onder, Robert F.', bioguide_id: 'O000177', mo_senate_id: null, mo_house_id: null, legiscan_people_id: null, openstates_id: null, person_id: null,
    }],
    ['leg-onder-legiscan', {
      id: 'leg-onder-legiscan', full_name: 'Robert Onder', bioguide_id: null, mo_senate_id: null, mo_house_id: null, legiscan_people_id: 16351, openstates_id: null, person_id: null,
    }],
  ]);
  const cluster = {
    key: 'onder:leg-onder-bioguide,leg-onder-legiscan',
    memberIds: ['leg-onder-bioguide', 'leg-onder-legiscan'],
    evidence: [{ legislatorId: 'leg-onder-bioguide', fullName: 'Onder, Robert F.' }, { legislatorId: 'leg-onder-legiscan', fullName: 'Robert Onder' }],
  };
  const client = makeFakeClient({ legislatorRows: [...rowsById.values()] });
  const result = await writeAutoCluster(client, 'run-1', cluster, rowsById);
  assert.equal(client.state.persons.length, 1);
  assert.deepEqual(client.state.persons[0], { id: result.personId, display_name: 'Robert F. Onder', display_name_source: 'bioguide' });
  assert.equal(client.state.person_links.length, 2);
  const linkForLegiscan = client.state.person_links.find((l) => l.legislator_id === 'leg-onder-legiscan');
  assert.equal(linkForLegiscan.person_id, result.personId);
  assert.equal(linkForLegiscan.decided_by, 'auto');
  assert.equal(linkForLegiscan.run_id, 'run-1');
  assert.deepEqual(linkForLegiscan.evidence, { legislatorId: 'leg-onder-legiscan', fullName: 'Robert Onder' });
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-bioguide').person_id, result.personId);
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-legiscan').person_id, result.personId);
});

// ---- writeAutoCluster BELT (fix round 2): the structural invariant, enforced a SECOND time,
// independent of clusterLegislators' own guarantee ----

test('writeAutoCluster FIX ROUND 2 BELT: a cluster pairing members that do NOT share a full-name variant throws ClusterNameVariantViolationError, writes NOTHING (no person, no links, no patch)', async () => {
  const rowsById = new Map([
    ['leg-onder-bioguide', {
      id: 'leg-onder-bioguide', full_name: 'Onder, Robert F.', bioguide_id: 'O000177', mo_senate_id: null, mo_house_id: null, legiscan_people_id: null, openstates_id: null, person_id: null,
    }],
    ['leg-onder-mosenate', {
      id: 'leg-onder-mosenate', full_name: 'Bob Onder', bioguide_id: null, mo_senate_id: '2', mo_house_id: null, legiscan_people_id: null, openstates_id: null, person_id: null,
    }],
  ]);
  // A cluster shaped like this should never come out of clusterLegislators (that's the whole
  // point of the fix) — this test proves the BELT holds even if it somehow did: a hand-built
  // cluster object bypassing the matcher entirely, exactly the "future bug in the matcher"
  // scenario the BELT's own doc comment names.
  const cluster = {
    key: 'onder:leg-onder-bioguide,leg-onder-mosenate',
    memberIds: ['leg-onder-bioguide', 'leg-onder-mosenate'],
    evidence: [{ legislatorId: 'leg-onder-bioguide', fullName: 'Onder, Robert F.' }, { legislatorId: 'leg-onder-mosenate', fullName: 'Bob Onder' }],
  };
  const client = makeFakeClient({ legislatorRows: [...rowsById.values()] });
  await assert.rejects(() => writeAutoCluster(client, 'run-1', cluster, rowsById), ClusterNameVariantViolationError);
  assert.equal(client.state.persons.length, 0, 'no person row created');
  assert.equal(client.state.person_links.length, 0, 'no link rows created');
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-bioguide').person_id, null, 'no patch applied');
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-mosenate').person_id, null, 'no patch applied');
});

// ---- NICKNAME AMENDMENT FIX ROUND 2 (controller-extended scope): the BELT now calls
// rowNameVariantMatch (nickname-aware, row-shaped) instead of the narrower full_name-only
// fullNameVariantMatch — aligned with clusterLegislators' own pairwise printed-name-set matcher
// (nameSetEdgeBasis, fix round 1) so the structural invariant validates exactly the property the
// matcher guarantees, never more, never less. ----

test('writeAutoCluster NICKNAME AMENDMENT FIX ROUND 2: a nickname-bridged 2-row cluster ("Robert Onder" nickname "Bob" + "Bob Onder") passes the BELT and writes successfully — this is the exact live-relevant case fix round 1 identified as a false-positive risk under the OLD full_name-only BELT', async () => {
  const rowsById = new Map([
    ['leg-onder-legiscan', {
      id: 'leg-onder-legiscan', full_name: 'Robert Onder', nickname: 'Bob', bioguide_id: null, mo_senate_id: null, mo_house_id: null, legiscan_people_id: 16351, openstates_id: null, person_id: null,
    }],
    ['leg-onder-barebob', {
      id: 'leg-onder-barebob', full_name: 'Bob Onder', nickname: null, bioguide_id: null, mo_senate_id: '2', mo_house_id: null, legiscan_people_id: null, openstates_id: null, person_id: null,
    }],
  ]);
  const cluster = {
    key: 'onder:leg-onder-barebob,leg-onder-legiscan',
    memberIds: ['leg-onder-legiscan', 'leg-onder-barebob'],
    evidence: [
      { legislatorId: 'leg-onder-legiscan', fullName: 'Robert Onder', nickname: 'Bob' },
      { legislatorId: 'leg-onder-barebob', fullName: 'Bob Onder', nickname: null },
    ],
  };
  const client = makeFakeClient({ legislatorRows: [...rowsById.values()] });
  const result = await writeAutoCluster(client, 'run-1', cluster, rowsById);
  assert.equal(client.state.persons.length, 1);
  assert.equal(client.state.person_links.length, 2);
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-legiscan').person_id, result.personId);
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-barebob').person_id, result.personId);
});

test('writeAutoCluster NICKNAME AMENDMENT FIX ROUND 2: a genuinely name-incoherent cluster still throws ClusterNameVariantViolationError even when ONE side carries a nickname — nickname-awareness must not become vacuously permissive (the nickname "Bob" on the legiscan row does not somehow license a match against an unrelated "David Onder")', async () => {
  const rowsById = new Map([
    ['leg-onder-legiscan', {
      id: 'leg-onder-legiscan', full_name: 'Robert Onder', nickname: 'Bob', bioguide_id: null, mo_senate_id: null, mo_house_id: null, legiscan_people_id: 16351, openstates_id: null, person_id: null,
    }],
    ['leg-onder-david', {
      id: 'leg-onder-david', full_name: 'David Onder', nickname: null, bioguide_id: null, mo_senate_id: '9', mo_house_id: null, legiscan_people_id: null, openstates_id: null, person_id: null,
    }],
  ]);
  const cluster = {
    key: 'onder:leg-onder-david,leg-onder-legiscan',
    memberIds: ['leg-onder-legiscan', 'leg-onder-david'],
    evidence: [
      { legislatorId: 'leg-onder-legiscan', fullName: 'Robert Onder', nickname: 'Bob' },
      { legislatorId: 'leg-onder-david', fullName: 'David Onder', nickname: null },
    ],
  };
  const client = makeFakeClient({ legislatorRows: [...rowsById.values()] });
  await assert.rejects(() => writeAutoCluster(client, 'run-1', cluster, rowsById), ClusterNameVariantViolationError);
  assert.equal(client.state.persons.length, 0, 'no person row created');
  assert.equal(client.state.person_links.length, 0, 'no link rows created');
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-legiscan').person_id, null, 'no patch applied');
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-david').person_id, null, 'no patch applied');
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

test('runLink: --dry-run performs ZERO write calls (no insert/update anywhere in the call log), returns the full proposed clustering + honest counts + a passing coherence audit', async () => {
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
  // FIX ROUND 2: the four-Onder rows now form TWO 2-member clusters (see the dedicated
  // clusterLegislators test above for why) — not one 4-member cluster.
  assert.deepEqual(report.counts, {
    clusters: 2, personsCreated: 0, linked: 0, flagged: 0, alreadyLinked: 1, singletons: 0,
  });
  assert.equal(report.clusters.length, 2);
  assert.deepEqual(report.clusters.map((c) => c.memberIds.length).sort(), [2, 2]);
  assert.equal(report.coherenceAudit.ok, true, 'permanent dry-run audit line: every proposed cluster is name-coherent');
  assert.deepEqual(report.coherenceAudit.violations, []);

  const writeOps = client.calls.filter((c) => c.op === 'insert' || c.op === 'update');
  assert.deepEqual(writeOps, [], 'zero writes reachable from dry-run — writeAutoCluster/writeIdentityFlag are never called');
  assert.equal(client.state.persons.length, 0);
  assert.equal(client.state.person_links.length, 0);
  assert.equal(client.state.identity_flags.length, 0);
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-bioguide').person_id, null, 'unwritten');
});

test('runLink: live mode writes the TWO auto clusters (persons/person_links/legislators.person_id) and the flagged group (identity_flags), with honest counts including alreadyLinked, and a passing coherence audit', async () => {
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
    clusters: 2, personsCreated: 2, linked: 4, flagged: 1, alreadyLinked: 1, singletons: 0,
  });
  assert.equal(report.flaggedWritten, 1);
  assert.equal(report.flaggedDeduped, 0);
  assert.equal(report.coherenceAudit.ok, true);
  assert.deepEqual(report.coherenceAudit.violations, []);

  assert.equal(client.state.persons.length, 2);
  assert.equal(client.state.person_links.length, 4);
  assert.equal(client.state.identity_flags.length, 1);
  assert.deepEqual(client.state.identity_flags[0].candidate_legislator_ids.slice().sort(), ['leg-smith-early', 'leg-smith-later']);
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-already').person_id, 'person-prior', 'already-linked row untouched');
  // bioguide+legiscan share one person; mo_senate+openstates share a DIFFERENT person
  const bioguidePersonId = client.state.legislators.find((l) => l.id === 'leg-onder-bioguide').person_id;
  const legiscanPersonId = client.state.legislators.find((l) => l.id === 'leg-onder-legiscan').person_id;
  const mosenatePersonId = client.state.legislators.find((l) => l.id === 'leg-onder-mosenate').person_id;
  const openstatesPersonId = client.state.legislators.find((l) => l.id === 'leg-onder-openstates').person_id;
  assert.ok(bioguidePersonId, 'bioguide row was linked');
  assert.equal(bioguidePersonId, legiscanPersonId, 'bioguide and legiscan share a person');
  assert.equal(mosenatePersonId, openstatesPersonId, 'mo_senate and openstates share a person');
  assert.notEqual(bioguidePersonId, mosenatePersonId, 'the two Onder clusters are DIFFERENT persons — never wrongly bridged');
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-smith-early').person_id, null, 'flagged rows are never linked');
});

test('runLink: a re-run after a live run is idempotent — already-linked rows are skipped and the identical flag is deduped, zero new persons/links/flag rows', async () => {
  const legislatorRows = onderRows().map(({ evidence: _e, ...r }) => ({ ...r, person_id: null }));
  const termRows = [{
    legislator_id: 'leg-onder-mosenate', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
  }];
  const client = makeFakeClient({ legislatorRows, termRows });
  await runLink(client, { dryRun: false, runId: 'run-1' });
  assert.equal(client.state.persons.length, 2, 'two clusters (bioguide+legiscan, mo_senate+openstates) -> two persons');

  const second = await runLink(client, { dryRun: false, runId: 'run-2' });
  assert.deepEqual(second.counts, {
    clusters: 0, personsCreated: 0, linked: 0, flagged: 0, alreadyLinked: 4, singletons: 0,
  });
  assert.equal(client.state.persons.length, 2, 'no duplicate person created on re-run');
});
