import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterLegislators, surnameKey, reorderCommaName, pickDisplayName, NoDisplayNameSourceError, fullNameVariantMatch, auditClusterCoherence, nameSetEdgeBasis, normalizePersonName, finalPairStatus,
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
  buildKeepSeparatePairs,
  findKeepSeparateConflict,
  applyKeepSeparateRulings,
  loadPersons,
  groupAlreadyLinkedByPerson,
  buildAttachCandidates,
  buildAttachFlags,
  applyAttachCrossCheck,
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

// ---- CRITICAL fix (final wave, execution-proven by review): the comma-form suffix defeat.
// normalizePersonName used to reorder on the FIRST comma only, so 'Duncan, John J., Jr.' carried
// its suffix mid-string ('John J., Jr. Duncan') and splitGivenFamilySuffix (last-token-only) parsed
// suffix=null on BOTH comma-form sides — the printed Jr./Sr. disqualifier NEVER fired for a
// comma-form name, and a comma-form dynasty pair could auto-merge through the matcher, the
// writeAutoCluster BELT, and auditClusterCoherence alike (all three share this one parse). These
// mirror the space-form suffix tests above, exactly, but printed in the comma form real bioguide
// rows actually use. ----

test('fullNameVariantMatch: CRITICAL fix (final wave) — comma-form suffix mismatch ("Duncan, John J., Jr." vs "Duncan, John J., Sr.") is a disqualifying signal, same as the space form', () => {
  assert.equal(fullNameVariantMatch('Duncan, John J., Jr.', 'Duncan, John J., Sr.'), false);
});

test('fullNameVariantMatch: CRITICAL fix (final wave) — comma-form suffix omitted on one side still matches (suffix-omission semantics apply identically in comma form)', () => {
  assert.equal(fullNameVariantMatch('Duncan, John J., Jr.', 'John J. Duncan'), true);
});

test('fullNameVariantMatch: CRITICAL fix (final wave) — comma-form BOTH sides printing the SAME suffix still matches', () => {
  assert.equal(fullNameVariantMatch('Duncan, John J., Jr.', 'Duncan, John J., Jr.'), true);
});

test('normalizePersonName: CRITICAL fix (final wave) — a comma-form suffix segment relocates to the true END of the string, not stranded mid-string', () => {
  assert.equal(normalizePersonName('Duncan, John J., Jr.'), 'john j duncan jr');
});

test('surnameKey: CRITICAL fix (final wave) — a comma-form suffix name still derives the FAMILY name, never the suffix, as its fallback key', () => {
  assert.equal(surnameKey({ surname: null, full_name: 'Duncan, John J., Jr.' }), 'duncan');
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

test('clusterLegislators CRITICAL fix (final wave): the SAME suffix mismatch printed in COMMA form ("Duncan, John J., Jr." vs "Duncan, John J., Sr.") — the real bioguide printed shape — is caught identically: flagged, NEVER clustered', () => {
  // Explicit surname:null (not the literal 'Duncan' column value) so this ALSO exercises the fixed
  // surnameKey fallback derivation (splitGivenFamilySuffix('duncan john j jr') -> family 'duncan')
  // — a bare last-token read would have derived 'jr'/'sr' instead, and the two rows would never
  // even have been grouped together at all (a missed-pairing regression, not a wrong-merge one, but
  // still wrong).
  const mkDuncan = (id, fullName) => ({
    id,
    full_name: fullName,
    surname: null,
    bioguide_id: `bg-${id}`,
    openstates_id: null,
    mo_house_id: null,
    mo_senate_id: null,
    legiscan_people_id: null,
    evidence: [{
      source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '20', start_date: null, end_date: null,
    }],
  });
  const rows = [mkDuncan('leg-duncan-jr-comma', 'Duncan, John J., Jr.'), mkDuncan('leg-duncan-sr-comma', 'Duncan, John J., Sr.')];
  const result = clusterLegislators(rows);
  assert.equal(result.clusters.length, 0, 'CRITICAL: the old bug would have silently auto-clustered this comma-form dynasty pair');
  assert.equal(result.flagged.length, 1);
  assert.equal(result.flagged[0].reason, 'ambiguous_era');
  assert.deepEqual(result.flagged[0].candidateIds.slice().sort(), ['leg-duncan-jr-comma', 'leg-duncan-sr-comma']);
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
  legislatorRows = [], termRows = [], identityFlagsRows = [], personsRows = [], forceFlagRace = false,
} = {}) {
  const state = {
    legislators: legislatorRows.map((r) => ({ ...r })),
    terms: termRows.map((r) => ({ ...r })),
    // personsRows (Task 4, attach-to-existing): seeds ALREADY-EXISTING persons rows so runLink's
    // own loadPersons (the attach pass's display_name source) has something real to read — every
    // prior test left this empty (dry-run/live runs that never pre-seed an existing person).
    persons: personsRows.map((r) => ({ ...r })),
    person_links: [],
    identity_flags: identityFlagsRows.map((r) => ({ ...r })),
  };
  const calls = [];
  let personSeq = 0;
  let flagSeq = 0;
  let raceFired = false;

  // selectAllBuilder now PROJECTS to the caller's actual requested columns (finding 9, final
  // wave — test-honesty lock) rather than always returning the full fixture row regardless of
  // what was asked for. Before this fix, the fake silently made loadLegislators'/loadTerms' own
  // SELECT strings decorative in every test: a real regression (e.g. dropping `nickname` from
  // loadLegislators' select string) would have been INVISIBLE here, since the fake returned the
  // whole row anyway. Now a column not named in the select string genuinely comes back missing
  // (`undefined`), so any test whose behavior actually depends on a specific selected column will
  // fail loud if that column is ever silently dropped from the real query.
  // selectAllBuilder now supports BOTH query shapes this file's code actually chains off
  // .select(cols): the selectAll pagination shape (.order().range(), used by loadLegislators/
  // loadTerms/loadIdentityFlags) AND the single-row lookup shape (.eq().maybeSingle(), used by
  // writeIdentityFlag's own check-then-insert) — unified into one builder (final wave, item 2)
  // now that identity_flags needs BOTH shapes in the same test run (runLink's own keep-separate
  // load uses selectAll; writeIdentityFlag's dedup check uses eq/maybeSingle).
  function selectAllBuilder(table, cols) {
    const columns = typeof cols === 'string'
      ? cols.split(',').map((c) => c.trim()).filter(Boolean)
      : null;
    const project = (row) => {
      if (!columns) return { ...row };
      const projected = {};
      for (const col of columns) projected[col] = row[col];
      return projected;
    };
    const builder = {
      order: () => builder,
      range: (from, to) => ({
        then: (resolve) => {
          calls.push({ op: 'select', table });
          const rows = state[table] ?? [];
          resolve({ data: rows.slice(from, to + 1).map(project), error: null });
        },
      }),
      eq: (col, val) => ({
        maybeSingle: async () => {
          calls.push({
            op: 'select', table, col, val,
          });
          const row = (state[table] ?? []).find((r) => r[col] === val);
          return { data: row ? project(row) : null, error: null };
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
        select(cols) {
          // 'persons' added (Task 4): runLink's own loadPersons goes through the SAME selectAll
          // pagination shape as legislators/terms/identity_flags — no new builder needed.
          if (table === 'legislators' || table === 'terms' || table === 'identity_flags' || table === 'persons') return selectAllBuilder(table, cols);
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

// ---- FINDING 9 (test-honesty lock, final wave): a runLink-level test that goes through the REAL
// loadLegislators SELECT string (not a hand-built rows array passed straight to
// clusterLegislators) — this is the thing the reviewer proved was invisible: the fake client used
// to ignore its own select(cols) argument entirely and always return full fixture rows regardless
// of what was actually asked for, so a real regression dropping `nickname` from loadLegislators'
// own select string would have passed every existing test silently. The fake now PROJECTS to the
// caller's actual requested columns (see makeFakeClient's own updated comment) — this test is the
// one that would catch it: WITHOUT nickname data reaching clusterLegislators, 'Robert Jones'
// (hub1) and 'Robert Jones' (hub2) would still auto-cluster on the pre-existing identical-name
// residual alone (unrelated to nicknames), while 'Bob Jones'/'Rob Jones' would have nothing to
// connect to and land as two singletons — a COMPLETELY different, wrong shape from the one
// asserted below.
test('runLink FINDING 9: a persisted nickname flowing through the REAL loadLegislators SELECT produces internal_no_name_variant end-to-end — proves nickname wiring is actually exercised, not merely assumed', async () => {
  const legislatorRows = [
    {
      id: 'leg-hub1', full_name: 'Robert Jones', nickname: 'Bob', surname: 'Jones', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 1, person_id: null,
    },
    {
      id: 'leg-hub2', full_name: 'Robert Jones', nickname: 'Rob', surname: 'Jones', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 2, person_id: null,
    },
    {
      id: 'leg-barebob', full_name: 'Bob Jones', nickname: null, surname: 'Jones', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 3, person_id: null,
    },
    {
      id: 'leg-barerob', full_name: 'Rob Jones', nickname: null, surname: 'Jones', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 4, person_id: null,
    },
  ];
  const client = makeFakeClient({ legislatorRows });
  const report = await runLink(client, { dryRun: true });
  assert.equal(report.counts.clusters, 0, 'if nickname were NOT wired through, hub1/hub2 would still auto-cluster on the plain identical-name residual alone');
  assert.equal(report.counts.flagged, 1);
  assert.equal(report.flagged[0].reason, 'internal_no_name_variant');
  assert.deepEqual(report.flagged[0].candidateIds.slice().sort(), ['leg-barebob', 'leg-barerob', 'leg-hub1', 'leg-hub2']);
  assert.equal(report.counts.singletons, 0, 'if nickname were NOT wired through, barebob/barerob would be stranded as two singletons instead of joining this flag');
});

// ---- ITEM 2 (final wave): keep-separate rulings bind the auto path ----

test('buildKeepSeparatePairs: extracts a pair from a keep-separate resolution, ignores link resolutions on the same/other flags', () => {
  const flags = [
    {
      id: 'flag-1',
      cluster_key: 'jones:leg-x,leg-y',
      evidence: {
        resolutions: [
          { action: 'link', legislatorIds: ['leg-p', 'leg-q'], personId: 'person-1', decidedAt: '2026-01-01T00:00:00Z' },
          {
            action: 'keep-separate', legislatorIds: ['leg-x', 'leg-y'], note: 'confirmed different people', decidedAt: '2026-01-02T00:00:00Z',
          },
        ],
      },
    },
    { id: 'flag-2', cluster_key: 'smith:leg-m,leg-n', evidence: { resolutions: [{ action: 'link', legislatorIds: ['leg-m', 'leg-n'], personId: 'person-2', decidedAt: '2026-01-01T00:00:00Z' }] } },
  ];
  const pairs = buildKeepSeparatePairs(flags);
  assert.equal(pairs.size, 1);
  const ruling = pairs.get('leg-x|leg-y');
  assert.equal(ruling.flagId, 'flag-1');
  assert.equal(ruling.note, 'confirmed different people');
  assert.equal(ruling.decidedAt, '2026-01-02T00:00:00Z');
});

test('buildKeepSeparatePairs: a keep-separate on 3+ candidates produces EVERY pair among them', () => {
  const flags = [{
    id: 'flag-1', cluster_key: 'brown:a,b,c', evidence: { resolutions: [{ action: 'keep-separate', legislatorIds: ['leg-a', 'leg-b', 'leg-c'], note: 'all different', decidedAt: '2026-01-01T00:00:00Z' }] },
  }];
  const pairs = buildKeepSeparatePairs(flags);
  assert.equal(pairs.size, 3);
  assert.ok(pairs.has('leg-a|leg-b'));
  assert.ok(pairs.has('leg-a|leg-c'));
  assert.ok(pairs.has('leg-b|leg-c'));
});

test('buildKeepSeparatePairs: tolerant of malformed/absent evidence.resolutions, never throws', () => {
  assert.deepEqual([...buildKeepSeparatePairs([{ id: 'f1', evidence: null }, { id: 'f2', evidence: {} }, { id: 'f3' }]).keys()], []);
  assert.deepEqual([...buildKeepSeparatePairs(undefined).keys()], []);
});

test('findKeepSeparateConflict: finds a conflict among a cluster\'s member ids regardless of order/position', () => {
  const pairs = buildKeepSeparatePairs([{
    id: 'flag-1', cluster_key: 'x', evidence: { resolutions: [{ action: 'keep-separate', legislatorIds: ['leg-y', 'leg-z'], note: 'n', decidedAt: 't' }] },
  }]);
  const conflict = findKeepSeparateConflict(['leg-a', 'leg-y', 'leg-z'], pairs);
  assert.ok(conflict);
  assert.equal(conflict.flagId, 'flag-1');
});

test('findKeepSeparateConflict: no conflict -> null', () => {
  const pairs = buildKeepSeparatePairs([]);
  assert.equal(findKeepSeparateConflict(['leg-a', 'leg-b'], pairs), null);
});

test('applyKeepSeparateRulings: downgrades ONLY the conflicting cluster, leaves an unrelated clean cluster untouched', () => {
  const clusters = [
    { key: 'jones:leg-x,leg-y', memberIds: ['leg-x', 'leg-y'], evidence: [{ legislatorId: 'leg-x', fullName: 'Robert Jones' }, { legislatorId: 'leg-y', fullName: 'Robert Jones' }] },
    { key: 'smith:leg-m,leg-n', memberIds: ['leg-m', 'leg-n'], evidence: [{ legislatorId: 'leg-m', fullName: 'Jane Smith' }, { legislatorId: 'leg-n', fullName: 'Jane Smith' }] },
  ];
  const pairs = buildKeepSeparatePairs([{
    id: 'flag-1', cluster_key: 'jones:leg-x,leg-y', evidence: { resolutions: [{ action: 'keep-separate', legislatorIds: ['leg-x', 'leg-y'], note: 'confirmed different people', decidedAt: '2026-01-02T00:00:00Z' }] },
  }]);
  const { cleanClusters, downgradedFlags } = applyKeepSeparateRulings(clusters, pairs);
  assert.equal(cleanClusters.length, 1);
  assert.equal(cleanClusters[0].key, 'smith:leg-m,leg-n');
  assert.equal(downgradedFlags.length, 1);
  assert.equal(downgradedFlags[0].reason, 'conflicts_with_keep_separate_ruling');
  assert.deepEqual(downgradedFlags[0].candidateIds.slice().sort(), ['leg-x', 'leg-y']);
  assert.equal(downgradedFlags[0].keepSeparateRuling.note, 'confirmed different people');
  assert.equal(downgradedFlags[0].keepSeparateRuling.flagId, 'flag-1');
});

// The headline scenario: a pair Lance PREVIOUSLY ruled keep-separate later becomes matcher-
// compatible (a same-full-name, dateless pair — the exact accepted-residual shape that WOULD
// auto-cluster on its own) — this must flag, never auto-write, with Lance's own ruling cited.
test('runLink ITEM 2: a keep-separated pair that later becomes name+evidence compatible -> flagged (never auto-written), Lance\'s ruling cited verbatim in the flag evidence', async () => {
  const legislatorRows = [
    {
      id: 'leg-jones-x', full_name: 'Robert Jones', surname: 'Jones', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 501, person_id: null,
    },
    {
      id: 'leg-jones-y', full_name: 'Robert Jones', surname: 'Jones', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 502, person_id: null,
    },
  ];
  const identityFlagsRows = [{
    id: 'flag-jones-1',
    cluster_key: 'jones:leg-jones-x,leg-jones-y',
    evidence: {
      reason: 'ambiguous_era',
      candidates: [],
      resolutions: [{
        action: 'keep-separate', legislatorIds: ['leg-jones-x', 'leg-jones-y'], note: 'Lance: confirmed these are two different Robert Joneses, not a re-election', decidedBy: 'lance', decidedAt: '2026-07-29T12:00:00Z',
      }],
    },
  }];
  const client = makeFakeClient({ legislatorRows, identityFlagsRows });

  // Sanity check the premise: WITHOUT the ruling, this exact pair auto-clusters (the accepted
  // residual — same full name, dateless, no seat evidence).
  const withoutRuling = await runLink(makeFakeClient({ legislatorRows }), { dryRun: true });
  assert.equal(withoutRuling.counts.clusters, 1, 'premise check: this pair WOULD auto-cluster without the keep-separate ruling');

  const report = await runLink(client, { dryRun: true });
  assert.equal(report.counts.clusters, 0, 'the keep-separate ruling downgrades this cluster — never auto-written');
  assert.equal(report.counts.flagged, 1);
  assert.equal(report.flagged[0].reason, 'conflicts_with_keep_separate_ruling');
  assert.deepEqual(report.flagged[0].candidateIds.slice().sort(), ['leg-jones-x', 'leg-jones-y']);
  assert.equal(report.flagged[0].keepSeparateRuling.note, 'Lance: confirmed these are two different Robert Joneses, not a re-election');
  assert.equal(report.flagged[0].keepSeparateRuling.flagId, 'flag-jones-1');

  // Live mode: writeAutoCluster is never called for this pair (no person/links written for it —
  // the whole point). The downgraded flag's cluster_key is deterministically the SAME as the
  // pre-existing flag-jones-1's (same surname group, same member id set — buildClusterKey), so
  // writeIdentityFlag's own check-then-insert correctly DEDUPES against it rather than writing a
  // redundant second row — flag-jones-1 already durably records Lance's ruling; nothing new needs
  // writing. The important thing this proves is the NEGATIVE: person/person_links/legislators.
  // person_id all stay completely untouched for this pair, live, not just in the dry-run report.
  const liveClient = makeFakeClient({ legislatorRows, identityFlagsRows });
  const liveReport = await runLink(liveClient, { dryRun: false, runId: 'run-1' });
  assert.equal(liveReport.counts.clusters, 0);
  assert.equal(liveReport.counts.personsCreated, 0);
  assert.equal(liveReport.flaggedDeduped, 1, 'deduped against the pre-existing flag-jones-1, same cluster_key');
  assert.equal(liveReport.flaggedWritten, 0);
  assert.equal(liveClient.state.persons.length, 0, 'no person ever created for this pair');
  assert.equal(liveClient.state.person_links.length, 0);
  assert.equal(liveClient.state.identity_flags.length, 1, 'no duplicate flag row written — deduped against the existing one');
  assert.equal(liveClient.state.legislators.find((l) => l.id === 'leg-jones-x').person_id, null);
  assert.equal(liveClient.state.legislators.find((l) => l.id === 'leg-jones-y').person_id, null);
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

// ============================================================================================
// Task 4 (.superpowers/sdd/2026-07-29-profile-completeness/task-4-brief.md): attach-to-existing.
// The identity system's missing path — a returning legislator's fresh, unlinked session/source row
// (arriving ALONE, with nothing else new to cluster with) must be comparable against the rows
// ALREADY linked into an existing person, using the SAME matcher primitives (finalPairStatus),
// never a parallel matching path. NEVER auto-attaches — only proposes, via an attach_candidate
// identity_flag; keep-separate rulings gate this path exactly as they already gate auto-clustering.
// ============================================================================================

// alreadyLinkedOnderMembers — the real four-Onder rows (onderRows(), already used throughout this
// file), each stamped with the SAME person_id — exactly what buildEvidenceRows(alreadyLinked,
// termRows) would hand the attach pass after a prior run already linked them.
function alreadyLinkedOnderMembers(personId = 'person-onder-1') {
  return onderRows().map((r) => ({ ...r, person_id: personId }));
}

// ---- groupAlreadyLinkedByPerson ----

test('groupAlreadyLinkedByPerson: buckets already-linked rows by person_id', () => {
  const rows = [
    { id: 'a', person_id: 'p1' }, { id: 'b', person_id: 'p1' }, { id: 'c', person_id: 'p2' },
  ];
  const groups = groupAlreadyLinkedByPerson(rows);
  assert.equal(groups.size, 2);
  assert.deepEqual(groups.get('p1').map((r) => r.id), ['a', 'b']);
  assert.deepEqual(groups.get('p2').map((r) => r.id), ['c']);
});

test('groupAlreadyLinkedByPerson: tolerant of empty/undefined input, defensively skips a null person_id', () => {
  assert.deepEqual([...groupAlreadyLinkedByPerson([]).keys()], []);
  assert.deepEqual([...groupAlreadyLinkedByPerson(undefined).keys()], []);
  assert.deepEqual([...groupAlreadyLinkedByPerson([{ id: 'x', person_id: null }]).keys()], []);
});

// ---- buildAttachCandidates: the pure matcher core ----

test('buildAttachCandidates: THE WORKED EXAMPLE — an Onder-shaped fifth row (unlinked, evidence-free "Robert Onder") qualifies to attach into the already-linked four-Onder person, matched via the bioguide+legiscan members (given+family "robert"+"onder"); the mo_senate/openstates "Bob Onder" members neither block nor contribute (different given name -> "no-pair", not "contradiction")', () => {
  const members = alreadyLinkedOnderMembers('person-onder-1');
  const fifthRow = {
    id: 'leg-onder-fifth', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null, evidence: [],
  };
  const candidates = buildAttachCandidates([fifthRow], members, new Map());
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.legislatorId, 'leg-onder-fifth');
  assert.equal(candidate.personId, 'person-onder-1');
  assert.deepEqual(
    candidate.matchedMembers.map((m) => m.legislatorId).sort(),
    ['leg-onder-bioguide', 'leg-onder-legiscan'],
    'only the given-name-matching members (robert/robert) contribute a matched edge — "Bob Onder" members are no-pair, not counted, but also do not block the person',
  );
  assert.ok(candidate.matchedMembers.every((m) => m.status === 'compatible'));
});

test('buildAttachCandidates: a real seat CONTRADICTION against even ONE member vetoes the WHOLE person, regardless of a name match elsewhere — never a partial attach suggestion', () => {
  const members = [
    {
      id: 'leg-smith-a', full_name: 'Jane Smith', surname: 'Smith', person_id: 'person-smith-1', evidence: [{
        source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: null, end_date: null,
      }],
    },
    {
      id: 'leg-smith-b', full_name: 'Jane Smith', surname: 'Smith', person_id: 'person-smith-1', evidence: [],
    },
  ];
  const singleton = {
    id: 'leg-smith-new', full_name: 'Jane Smith', surname: 'Smith', person_id: null, evidence: [{
      source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '9', start_date: null, end_date: null,
    }],
  };
  const candidates = buildAttachCandidates([singleton], members, new Map());
  assert.deepEqual(candidates, [], 'district 7 vs district 9, same jurisdiction+chamber, is a hard contradiction against leg-smith-a — the whole person is vetoed even though leg-smith-b would otherwise match');
});

test('buildAttachCandidates: no surname-key overlap at all -> no candidates (the pre-filter, same doctrine as clusterLegislators\' own grouping)', () => {
  const members = alreadyLinkedOnderMembers();
  const unrelated = {
    id: 'leg-unrelated', full_name: 'Zaphod Beeblebrox', surname: null, person_id: null, evidence: [],
  };
  assert.deepEqual(buildAttachCandidates([unrelated], members, new Map()), []);
});

test('buildAttachCandidates: a keep-separate ruling against ANY member of the person vetoes attaching to that person entirely — final-wave item 2\'s own binding, extended to gate this new path', () => {
  const members = alreadyLinkedOnderMembers('person-onder-1');
  const fifthRow = {
    id: 'leg-onder-fifth', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null, evidence: [],
  };
  // Sanity check the premise: WITHOUT the ruling, this pair qualifies (proven above already, but
  // re-asserted here so the ruling's effect is visibly a DELTA, not just an empty-by-coincidence result).
  assert.equal(buildAttachCandidates([fifthRow], members, new Map()).length, 1);

  const keepSeparatePairs = buildKeepSeparatePairs([{
    id: 'flag-prior',
    cluster_key: 'onder:prior',
    evidence: {
      resolutions: [{
        action: 'keep-separate', legislatorIds: ['leg-onder-fifth', 'leg-onder-bioguide'], note: 'Lance: confirmed this is a DIFFERENT Robert Onder', decidedAt: '2026-01-01T00:00:00Z',
      }],
    },
  }]);
  const candidates = buildAttachCandidates([fifthRow], members, keepSeparatePairs);
  assert.deepEqual(candidates, [], 'a ruling against just ONE member (bioguide) vetoes the whole person — every member of an already-linked person is transitively the same person Lance already ruled leg-onder-fifth is NOT');
});

test('buildAttachCandidates: a singleton with no derivable name at all is never a candidate', () => {
  const members = alreadyLinkedOnderMembers();
  const nameless = {
    id: 'leg-nameless', full_name: '', surname: null, person_id: null, evidence: [],
  };
  assert.deepEqual(buildAttachCandidates([nameless], members, new Map()), []);
});

test('buildAttachCandidates: a singleton can qualify against MULTIPLE different already-linked persons independently (each grouped separately) — real cross-person ambiguity is surfaced, never picked', () => {
  const onderMembers = alreadyLinkedOnderMembers('person-onder-1');
  const otherOnder = [{
    id: 'leg-onder-other', full_name: 'Robert Onder', surname: 'Onder', person_id: 'person-onder-2', evidence: [],
  }];
  const fifthRow = {
    id: 'leg-onder-fifth', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null, evidence: [],
  };
  const candidates = buildAttachCandidates([fifthRow], [...onderMembers, ...otherOnder], new Map());
  assert.deepEqual(candidates.map((c) => c.personId).sort(), ['person-onder-1', 'person-onder-2']);
});

// ---- buildAttachFlags: grouping + evidence shaping ----

test('buildAttachFlags: groups candidates by person, one flag per person, evidence reuses buildMemberEvidence shape + matchedMembers, existingPerson carries the real display_name', () => {
  const fifthRow = {
    id: 'leg-onder-fifth', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null, evidence: [],
  };
  const rowsById = new Map([['leg-onder-fifth', fifthRow]]);
  const attachCandidates = [{
    legislatorId: 'leg-onder-fifth',
    personId: 'person-onder-1',
    matchedMembers: [{ legislatorId: 'leg-onder-bioguide', fullName: 'Onder, Robert F.', status: 'compatible' }],
  }];
  const personDisplayNameById = new Map([['person-onder-1', 'Robert F. Onder']]);
  const flags = buildAttachFlags(attachCandidates, rowsById, personDisplayNameById);
  assert.equal(flags.length, 1);
  const [flag] = flags;
  assert.equal(flag.clusterKey, 'attach:person-onder-1:leg-onder-fifth');
  assert.deepEqual(flag.candidateIds, ['leg-onder-fifth']);
  assert.equal(flag.reason, 'attach_candidate');
  assert.deepEqual(flag.existingPerson, { personId: 'person-onder-1', displayName: 'Robert F. Onder' });
  assert.equal(flag.evidence.length, 1);
  const [candidateEvidence] = flag.evidence;
  assert.equal(candidateEvidence.legislatorId, 'leg-onder-fifth');
  assert.equal(candidateEvidence.fullName, 'Robert Onder');
  assert.equal(candidateEvidence.surnameKeyUsed, 'onder');
  assert.deepEqual(candidateEvidence.matchedMembers, attachCandidates[0].matchedMembers);
});

test('buildAttachFlags: a person with an unrecorded display_name (defensive — should never happen live, persons.display_name is NOT NULL) renders null, never invented', () => {
  const row = {
    id: 'leg-x', full_name: 'X Y', surname: 'Y', person_id: null, evidence: [],
  };
  const flags = buildAttachFlags(
    [{ legislatorId: 'leg-x', personId: 'person-ghost', matchedMembers: [] }],
    new Map([['leg-x', row]]),
    new Map(),
  );
  assert.equal(flags[0].existingPerson.displayName, null);
});

test('buildAttachFlags: no candidates -> no flags', () => {
  assert.deepEqual(buildAttachFlags([], new Map(), new Map()), []);
});

// ---- runLink end-to-end: the attach pass wired into the full orchestration ----

test('runLink Task 4: an Onder-shaped fifth row arrives unlinked alongside the already-linked four-Onder person — dry-run emits ONE attach_candidate flag citing the real existing person_id + display_name, ZERO writes', async () => {
  const legislatorRows = [
    ...alreadyLinkedOnderMembers('person-onder-1'),
    {
      id: 'leg-onder-fifth', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null,
    },
  ].map(({ evidence: _e, ...r }) => r);
  const termRows = [{
    legislator_id: 'leg-onder-mosenate', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
  }];
  const personsRows = [{ id: 'person-onder-1', display_name: 'Robert F. Onder', display_name_source: 'bioguide' }];
  const client = makeFakeClient({ legislatorRows, termRows, personsRows });

  const report = await runLink(client, { dryRun: true });
  assert.equal(report.counts.alreadyLinked, 4);
  assert.equal(report.counts.singletons, 1, 'leg-onder-fifth has no OTHER unlinked row to cluster with in this batch');
  const attachFlag = report.flagged.find((f) => f.reason === 'attach_candidate');
  assert.ok(attachFlag, 'an attach_candidate flag was emitted for the fifth row');
  assert.deepEqual(attachFlag.candidateIds, ['leg-onder-fifth']);
  assert.deepEqual(attachFlag.existingPerson, { personId: 'person-onder-1', displayName: 'Robert F. Onder' });

  const writeOps = client.calls.filter((c) => c.op === 'insert' || c.op === 'update');
  assert.deepEqual(writeOps, [], 'dry-run: zero writes, same as every other proposed change');
});

test('runLink Task 4: LIVE mode writes the attach_candidate flag to identity_flags but NEVER touches legislators.person_id for the candidate — attach only ever proposes, Lance decides', async () => {
  const legislatorRows = [
    ...alreadyLinkedOnderMembers('person-onder-1'),
    {
      id: 'leg-onder-fifth', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null,
    },
  ].map(({ evidence: _e, ...r }) => r);
  const termRows = [{
    legislator_id: 'leg-onder-mosenate', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
  }];
  const personsRows = [{ id: 'person-onder-1', display_name: 'Robert F. Onder', display_name_source: 'bioguide' }];
  const client = makeFakeClient({ legislatorRows, termRows, personsRows });

  const report = await runLink(client, { dryRun: false, runId: 'run-attach-1' });
  assert.equal(report.flaggedWritten, 1);
  assert.equal(client.state.identity_flags.length, 1);
  const [flagRow] = client.state.identity_flags;
  assert.equal(flagRow.evidence.reason, 'attach_candidate');
  assert.deepEqual(flagRow.evidence.existingPerson, { personId: 'person-onder-1', displayName: 'Robert F. Onder' });
  assert.deepEqual(flagRow.candidate_legislator_ids, ['leg-onder-fifth']);
  assert.equal(flagRow.run_id, 'run-attach-1');
  assert.equal(client.state.persons.length, 1, 'the pre-existing person is untouched — no new persons row for an attach proposal');
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-fifth').person_id, null, 'never auto-attached');
});

test('runLink Task 4: a PRIOR keep-separate ruling between the fifth row and an Onder member suppresses the attach_candidate flag entirely', async () => {
  const legislatorRows = [
    ...alreadyLinkedOnderMembers('person-onder-1'),
    {
      id: 'leg-onder-fifth', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null,
    },
  ].map(({ evidence: _e, ...r }) => r);
  const identityFlagsRows = [{
    id: 'flag-prior',
    cluster_key: 'onder:prior',
    evidence: {
      resolutions: [{
        action: 'keep-separate', legislatorIds: ['leg-onder-fifth', 'leg-onder-bioguide'], note: 'Lance: confirmed a different Robert Onder', decidedAt: '2026-01-01T00:00:00Z',
      }],
    },
  }];
  const personsRows = [{ id: 'person-onder-1', display_name: 'Robert F. Onder', display_name_source: 'bioguide' }];
  const client = makeFakeClient({
    legislatorRows, termRows: [], identityFlagsRows, personsRows,
  });

  const report = await runLink(client, { dryRun: true });
  assert.equal(report.counts.singletons, 1);
  assert.equal(
    report.flagged.some((f) => f.reason === 'attach_candidate'),
    false,
    'the keep-separate ruling vetoes this specific attach suggestion — never re-flagged',
  );
});

test('loadPersons: returns id->display_name for every persons row', async () => {
  const client = makeFakeClient({
    personsRows: [
      { id: 'p1', display_name: 'Robert F. Onder', display_name_source: 'bioguide' },
      { id: 'p2', display_name: 'Jane Smith', display_name_source: 'mo_senate' },
    ],
  });
  const map = await loadPersons(client);
  assert.equal(map.size, 2);
  assert.equal(map.get('p1'), 'Robert F. Onder');
  assert.equal(map.get('p2'), 'Jane Smith');
});

// ============================================================================================
// FIX ROUND 1 (review findings, all execution-proven against the code above): 3 CRITICALs.
// ============================================================================================

// ---- CRITICAL 3: the DYNASTY ATTACH TRAP — 'ambiguous' must NEVER qualify as an attach edge ----

test('finalPairStatus sanity check: the real Bayh shape (same dateless Indiana Senate seat, DIFFERENT given names) is "ambiguous", never "compatible" — the premise buildAttachCandidates\' fix depends on', () => {
  const birch = {
    full_name: 'Birch Bayh', evidence: [{ source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district: 'IN', start_date: null, end_date: null }],
  };
  const evan = {
    full_name: 'Evan Bayh', evidence: [{ source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district: 'IN', start_date: null, end_date: null }],
  };
  assert.equal(finalPairStatus(evan, birch), 'ambiguous');
});

test('buildAttachCandidates: FIX ROUND 1 CRITICAL 3 — the DYNASTY ATTACH TRAP (real Bayh shape, execution-proven live once already) — a fresh "Evan Bayh" singleton at the SAME dateless Indiana Senate seat as the already-linked "Birch Bayh" person is NEVER suggested, with ZERO keep-separate ruling on file — proving the block is structural (compatible-only), not dependent on Lance having already ruled on THIS brand-new row id', () => {
  const members = [{
    id: 'leg-bayh-birch', full_name: 'Birch Bayh', surname: 'Bayh', person_id: 'person-bayh-1', evidence: [{
      source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district: 'IN', start_date: null, end_date: null,
    }],
  }];
  const singleton = {
    id: 'leg-bayh-evan', full_name: 'Evan Bayh', surname: 'Bayh', person_id: null, evidence: [{
      source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district: 'IN', start_date: null, end_date: null,
    }],
  };
  assert.deepEqual(
    buildAttachCandidates([singleton], members, new Map()),
    [],
    'no keep-separate ruling exists for leg-bayh-evan at all — the empty result must come from the compatible-only gate, not the ruling gate',
  );
});

test('buildAttachCandidates: FIX ROUND 1 CRITICAL 3 — a same-name-but-non-overlapping-era pair (the OTHER "ambiguous" shape finalPairStatus produces: names DO match, but eras provably do not overlap) is also excluded — compatible-only means compatible-only, regardless of which of the two "ambiguous" paths produced it', () => {
  const members = [{
    id: 'leg-smith-early', full_name: 'Jane Smith', surname: 'Smith', person_id: 'person-smith-1', evidence: [{
      source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2001-01-01', end_date: '2005-12-31',
    }],
  }];
  const singleton = {
    id: 'leg-smith-later', full_name: 'Jane Smith', surname: 'Smith', person_id: null, evidence: [{
      source: 'terms', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '7', start_date: '2018-01-01', end_date: '2022-12-31',
    }],
  };
  assert.equal(finalPairStatus(singleton, members[0]), 'ambiguous', 'sanity check: same name, provably non-overlapping eras -> ambiguous, not compatible');
  assert.deepEqual(buildAttachCandidates([singleton], members, new Map()), []);
});

// ---- CRITICAL 2: the cross-check — clean clusters must never silently mint a duplicate person ----

test('applyAttachCrossCheck: a clean cluster whose members are ALL "compatible" with a real already-linked person\'s member is DEMOTED wholesale to one attach_candidate flag citing that person — the reviewer\'s exact two-fresh-Onder-rows exploit shape', () => {
  const existingMember = {
    id: 'leg-onder-existing', full_name: 'Robert Onder', surname: 'Onder', person_id: 'person-onder-1', evidence: [],
  };
  const freshA = {
    id: 'leg-onder-freshA', full_name: 'Robert Onder', surname: 'Onder', evidence: [],
  };
  const freshB = {
    id: 'leg-onder-freshB', full_name: 'Robert Onder', surname: 'Onder', evidence: [],
  };
  const cluster = {
    key: 'onder:leg-onder-freshA,leg-onder-freshB',
    memberIds: ['leg-onder-freshA', 'leg-onder-freshB'],
    evidence: [{ legislatorId: 'leg-onder-freshA', fullName: 'Robert Onder' }, { legislatorId: 'leg-onder-freshB', fullName: 'Robert Onder' }],
  };
  const memberRowsById = new Map([['leg-onder-freshA', freshA], ['leg-onder-freshB', freshB]]);
  const personDisplayNameById = new Map([['person-onder-1', 'Robert F. Onder']]);
  const { safeClusters, demotedFlags } = applyAttachCrossCheck([cluster], memberRowsById, [existingMember], personDisplayNameById);
  assert.deepEqual(safeClusters, [], 'the cluster is NEVER safe to auto-write once it cross-matches an existing person');
  assert.equal(demotedFlags.length, 1);
  const [flag] = demotedFlags;
  assert.equal(flag.clusterKey, 'attach:person-onder-1:leg-onder-freshA,leg-onder-freshB');
  assert.deepEqual(flag.candidateIds.slice().sort(), ['leg-onder-freshA', 'leg-onder-freshB']);
  assert.equal(flag.reason, 'attach_candidate');
  assert.deepEqual(flag.existingPerson, { personId: 'person-onder-1', displayName: 'Robert F. Onder' });
});

test('applyAttachCrossCheck: a clean cluster with NO compatible edge to any already-linked person is left completely untouched (safe to write)', () => {
  const cluster = {
    key: 'smith:leg-a,leg-b', memberIds: ['leg-a', 'leg-b'], evidence: [{ legislatorId: 'leg-a', fullName: 'Jane Smith' }, { legislatorId: 'leg-b', fullName: 'Jane Smith' }],
  };
  const memberRowsById = new Map([
    ['leg-a', { id: 'leg-a', full_name: 'Jane Smith', evidence: [] }],
    ['leg-b', { id: 'leg-b', full_name: 'Jane Smith', evidence: [] }],
  ]);
  const { safeClusters, demotedFlags } = applyAttachCrossCheck([cluster], memberRowsById, [], new Map());
  assert.deepEqual(safeClusters, [cluster]);
  assert.deepEqual(demotedFlags, []);
});

test('applyAttachCrossCheck: an "ambiguous" cross-match (the dynasty shape) does NOT demote — same compatible-only doctrine as buildAttachCandidates, applied identically here', () => {
  const cluster = {
    key: 'bayh:leg-bayh-evan,leg-bayh-donnelly',
    memberIds: ['leg-bayh-evan'],
    evidence: [{ legislatorId: 'leg-bayh-evan', fullName: 'Evan Bayh' }],
  };
  const memberRowsById = new Map([
    ['leg-bayh-evan', {
      id: 'leg-bayh-evan', full_name: 'Evan Bayh', evidence: [{ source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district: 'IN', start_date: null, end_date: null }],
    }],
  ]);
  const existingMember = {
    id: 'leg-bayh-birch', full_name: 'Birch Bayh', person_id: 'person-bayh-1', evidence: [{ source: 'terms', jurisdiction_id: 'us-congress', chamber: 'senate', district: 'IN', start_date: null, end_date: null }],
  };
  const { safeClusters, demotedFlags } = applyAttachCrossCheck([cluster], memberRowsById, [existingMember], new Map());
  assert.deepEqual(safeClusters, [cluster], 'ambiguous never demotes — the cluster stays safe to write (a real, if imperfect, decision the pre-existing matcher already makes)');
  assert.deepEqual(demotedFlags, []);
});

test('runLink FIX ROUND 1 CRITICAL 2: the reviewer\'s exact two-fresh-Onder-rows scenario — TWO brand-new unlinked rows that would otherwise auto-cluster together are cross-checked against the already-linked Onder person and DEMOTED — zero persons written, one attach_candidate flag covering both rows citing the existing person', async () => {
  const legislatorRows = [
    {
      id: 'leg-onder-existing', full_name: 'Robert Onder', surname: 'Onder', legiscan_people_id: 16351, person_id: 'person-onder-1',
    },
    {
      id: 'leg-onder-freshA', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: 'O000177', person_id: null,
    },
    {
      id: 'leg-onder-freshB', full_name: 'Robert Onder', surname: 'Onder', mo_senate_id: '2', person_id: null,
    },
  ];
  const personsRows = [{ id: 'person-onder-1', display_name: 'Robert F. Onder', display_name_source: 'bioguide' }];
  const client = makeFakeClient({ legislatorRows, termRows: [], personsRows });

  // Sanity check the premise: WITHOUT the cross-check, freshA+freshB form a clean, would-be-written
  // cluster (proving this is genuinely the "2-cluster never a singleton" shape the cross-check
  // exists for, not something the pre-existing singleton-only attach pass would have caught).
  const rawCluster = clusterLegislators(buildEvidenceRows(
    legislatorRows.filter((r) => r.person_id == null),
    [],
  ));
  assert.equal(rawCluster.clusters.length, 1, 'premise check: freshA/freshB DO form a clean cluster on their own, with zero singletons');
  assert.equal(rawCluster.singletons.length, 0);

  const dryReport = await runLink(client, { dryRun: true });
  assert.equal(dryReport.counts.clusters, 0, 'the would-be cluster is demoted before it is ever counted as safe to write');
  const attachFlag = dryReport.flagged.find((f) => f.reason === 'attach_candidate');
  assert.ok(attachFlag, 'demoted to an attach_candidate flag');
  assert.deepEqual(attachFlag.candidateIds.slice().sort(), ['leg-onder-freshA', 'leg-onder-freshB']);
  assert.deepEqual(attachFlag.existingPerson, { personId: 'person-onder-1', displayName: 'Robert F. Onder' });

  const liveReport = await runLink(client, { dryRun: false, runId: 'run-crosscheck-1' });
  assert.equal(liveReport.counts.personsCreated, 0, 'ZERO new persons written — this is the exact silent-duplicate-person write the finding closes');
  assert.equal(client.state.persons.length, 1, 'only the pre-existing person — no second Onder person ever created');
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-freshA').person_id, null, 'never auto-attached either — Lance decides');
  assert.equal(client.state.legislators.find((l) => l.id === 'leg-onder-freshB').person_id, null);
  assert.equal(client.state.identity_flags.length, 1);
  assert.equal(client.state.identity_flags[0].evidence.reason, 'attach_candidate');
  assert.deepEqual(client.state.identity_flags[0].candidate_legislator_ids.slice().sort(), ['leg-onder-freshA', 'leg-onder-freshB']);
});

// ============================================================================================
// MICRO-ROUND (re-review, information-gap finding — non-blocking): findCompatibleExistingPerson
// used to stop at the FIRST matching person; the sibling singleton attach pass already surfaces
// every match (as separate per-person flags). This closes the same gap for the cross-check path:
// collect ALL compatible existing persons into ONE flag's evidence.existingPersons array
// (existingPerson stays as existingPersons[0], for back-compat).
// ============================================================================================

test('applyAttachCrossCheck: MICRO-ROUND — a clean cluster that genuinely cross-matches TWO different existing persons cites BOTH in existingPersons (not just the first), existingPerson stays the first entry for back-compat, and the cluster_key is deterministic over the FULL matched-person set', () => {
  const cluster = {
    key: 'onder:leg-onder-freshA,leg-onder-freshB',
    memberIds: ['leg-onder-freshA', 'leg-onder-freshB'],
    evidence: [{ legislatorId: 'leg-onder-freshA', fullName: 'Robert Onder' }, { legislatorId: 'leg-onder-freshB', fullName: 'Robert Onder' }],
  };
  const memberRowsById = new Map([
    ['leg-onder-freshA', { id: 'leg-onder-freshA', full_name: 'Robert Onder', evidence: [] }],
    ['leg-onder-freshB', { id: 'leg-onder-freshB', full_name: 'Robert Onder', evidence: [] }],
  ]);
  // Two REAL, DISTINCT already-linked persons, each with their own evidence-free 'Robert Onder'
  // member — the accepted residual (identical full name, no comparable evidence) means the fresh
  // cluster genuinely reads 'compatible' against BOTH, honestly: this is real ambiguity the
  // operator must see and weigh, never silently collapsed to one guess.
  const existingA = {
    id: 'leg-onder-existingA', full_name: 'Robert Onder', person_id: 'person-onder-1', evidence: [],
  };
  const existingB = {
    id: 'leg-onder-existingB', full_name: 'Robert Onder', person_id: 'person-onder-2', evidence: [],
  };
  const personDisplayNameById = new Map([
    ['person-onder-1', 'Robert F. Onder'],
    ['person-onder-2', 'Robert Onder Jr.'],
  ]);
  const { safeClusters, demotedFlags } = applyAttachCrossCheck([cluster], memberRowsById, [existingA, existingB], personDisplayNameById);
  assert.deepEqual(safeClusters, [], 'demoted, not safe to write — same as the single-person case');
  assert.equal(demotedFlags.length, 1, 'still ONE flag, not one per matched person');
  const [flag] = demotedFlags;
  assert.deepEqual(flag.existingPersons, [
    { personId: 'person-onder-1', displayName: 'Robert F. Onder' },
    { personId: 'person-onder-2', displayName: 'Robert Onder Jr.' },
  ], 'BOTH matched persons cited — the operator can\'t weigh what he can\'t see');
  assert.deepEqual(flag.existingPerson, { personId: 'person-onder-1', displayName: 'Robert F. Onder' }, 'back-compat: the first entry');
  assert.equal(flag.clusterKey, 'attach:person-onder-1+person-onder-2:leg-onder-freshA,leg-onder-freshB');
  assert.deepEqual(flag.candidateIds.slice().sort(), ['leg-onder-freshA', 'leg-onder-freshB']);
});

test('applyAttachCrossCheck: MICRO-ROUND regression — a single-person match still produces the SAME clusterKey format as before (a 1-element array sorts/joins to the identical string a bare personId would)', () => {
  const cluster = {
    key: 'onder:leg-a,leg-b', memberIds: ['leg-a', 'leg-b'], evidence: [{ legislatorId: 'leg-a', fullName: 'Robert Onder' }, { legislatorId: 'leg-b', fullName: 'Robert Onder' }],
  };
  const memberRowsById = new Map([
    ['leg-a', { id: 'leg-a', full_name: 'Robert Onder', evidence: [] }],
    ['leg-b', { id: 'leg-b', full_name: 'Robert Onder', evidence: [] }],
  ]);
  const existingMember = {
    id: 'leg-existing', full_name: 'Robert Onder', person_id: 'person-onder-1', evidence: [],
  };
  const { demotedFlags } = applyAttachCrossCheck([cluster], memberRowsById, [existingMember], new Map([['person-onder-1', 'Robert F. Onder']]));
  assert.equal(demotedFlags[0].clusterKey, 'attach:person-onder-1:leg-a,leg-b');
  assert.deepEqual(demotedFlags[0].existingPersons, [{ personId: 'person-onder-1', displayName: 'Robert F. Onder' }]);
});

test('buildAttachFlags: MICRO-ROUND — every flag also carries existingPersons as a 1-element array matching existingPerson (schema uniformity with applyAttachCrossCheck, for the server\'s own validation to check membership the same way regardless of origin)', () => {
  const fifthRow = {
    id: 'leg-onder-fifth', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: null, openstates_id: null, mo_house_id: null, mo_senate_id: null, legiscan_people_id: 99999, person_id: null, evidence: [],
  };
  const rowsById = new Map([['leg-onder-fifth', fifthRow]]);
  const attachCandidates = [{
    legislatorId: 'leg-onder-fifth', personId: 'person-onder-1', matchedMembers: [],
  }];
  const flags = buildAttachFlags(attachCandidates, rowsById, new Map([['person-onder-1', 'Robert F. Onder']]));
  assert.deepEqual(flags[0].existingPersons, [{ personId: 'person-onder-1', displayName: 'Robert F. Onder' }]);
  assert.deepEqual(flags[0].existingPerson, flags[0].existingPersons[0]);
});

test('runLink MICRO-ROUND: the reviewer\'s two-fresh-Onder-rows scenario extended — TWO different already-linked Onder persons both genuinely match the fresh cluster; the resulting attach_candidate flag cites BOTH, end-to-end through the real DB-shaped load', async () => {
  const legislatorRows = [
    {
      id: 'leg-onder-existingA', full_name: 'Robert Onder', surname: 'Onder', legiscan_people_id: 16351, person_id: 'person-onder-1',
    },
    {
      id: 'leg-onder-existingB', full_name: 'Robert Onder', surname: 'Onder', openstates_id: 'ocd-person/other', person_id: 'person-onder-2',
    },
    {
      id: 'leg-onder-freshA', full_name: 'Robert Onder', surname: 'Onder', bioguide_id: 'O000177', person_id: null,
    },
    {
      id: 'leg-onder-freshB', full_name: 'Robert Onder', surname: 'Onder', mo_senate_id: '2', person_id: null,
    },
  ];
  const personsRows = [
    { id: 'person-onder-1', display_name: 'Robert F. Onder', display_name_source: 'bioguide' },
    { id: 'person-onder-2', display_name: 'Robert Onder Jr.', display_name_source: 'openstates' },
  ];
  const client = makeFakeClient({ legislatorRows, termRows: [], personsRows });

  const dryReport = await runLink(client, { dryRun: true });
  const attachFlag = dryReport.flagged.find((f) => f.reason === 'attach_candidate');
  assert.ok(attachFlag);
  assert.deepEqual(
    attachFlag.existingPersons.map((p) => p.personId).sort(),
    ['person-onder-1', 'person-onder-2'],
    'BOTH already-linked persons are cited, never just the first',
  );

  const liveReport = await runLink(client, { dryRun: false, runId: 'run-crosscheck-multi' });
  assert.equal(liveReport.counts.personsCreated, 0);
  assert.equal(client.state.persons.length, 2, 'only the two PRE-EXISTING persons — no third person ever created');
  assert.deepEqual(client.state.identity_flags[0].evidence.existingPersons.map((p) => p.personId).sort(), ['person-onder-1', 'person-onder-2']);
});
