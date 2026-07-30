import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIdentity, careerSpan, chamberLabel, voteFilterQuery, groupSponsorships,
  UnknownSponsorTypeError,
} from '../site/js/profile-model.js';

// Task 5 (docs/superpowers/plans/2026-07-30-public-site.md) — pure profile model.
//
// The four-Onder fixture below mirrors the REAL, live shapes recorded in
// tests/link-persons-cli.test.js (2026-07-29 read-only orientation query, never written to):
//   bioguide:   full_name 'Onder, Robert F.', bioguide_id 'O000177'
//   openstates: full_name 'Bob Onder', openstates_id 'ocd-person/e29b57a2-...'
//   mo_senate:  full_name 'Bob Onder', mo_senate_id '2', ONE real terms row
//               (jurisdiction_id 'mo-legislature', chamber 'senate', district '2', start/end NULL)
//   legiscan:   full_name 'Robert Onder', legiscan_people_id 16351, nickname 'Bob'
// person.display_name 'Robert F. Onder' (bioguide wins, per link-persons-cli.test.js
// pickDisplayName). This task adds a federal house term (2023-, open end) to model the
// MO-senate-then-US-House career shape described in the task-5 brief.

function onderLegislators() {
  return [
    {
      id: 'leg-onder-bioguide', full_name: 'Onder, Robert F.', bioguide_id: 'O000177', openstates_id: null, mo_senate_id: null, legiscan_people_id: null, party: 'Republican', image_url: null,
    },
    {
      id: 'leg-onder-openstates', full_name: 'Bob Onder', bioguide_id: null, openstates_id: 'ocd-person/e29b57a2-c2e7-4b5a-b299-bb734104f0d7', mo_senate_id: null, legiscan_people_id: null, party: null, image_url: null,
    },
    {
      id: 'leg-onder-mosenate', full_name: 'Bob Onder', bioguide_id: null, openstates_id: null, mo_senate_id: '2', legiscan_people_id: null, party: 'Republican', image_url: null,
    },
    {
      id: 'leg-onder-legiscan', full_name: 'Robert Onder', bioguide_id: null, openstates_id: null, mo_senate_id: null, legiscan_people_id: 16351, party: null, image_url: null, nickname: 'Bob',
    },
  ];
}

function onderTerms() {
  return [
    {
      id: 'term-mosenate', legislator_id: 'leg-onder-mosenate', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', party: 'Republican', start_date: '2013-01-09', end_date: '2023-01-04',
    },
    {
      id: 'term-ushouse', legislator_id: 'leg-onder-bioguide', jurisdiction_id: 'us-congress', chamber: 'house', district: '3', party: 'Republican', start_date: '2023-01-03', end_date: null,
    },
  ];
}

const onderPerson = { id: 'person-onder', display_name: 'Robert F. Onder', display_name_source: 'bioguide' };

// The real live single-row MO-senate shape (link-persons-cli.test.js comment): one terms row,
// start_date AND end_date both null. Used below for the null-date-only-terms test.
function moSenateOnlyLegislator() {
  return [{
    id: 'leg-onder-mosenate', full_name: 'Bob Onder', bioguide_id: null, openstates_id: null, mo_senate_id: '2', legiscan_people_id: null, party: 'Republican', image_url: null,
  }];
}

function moSenateOnlyTerms() {
  return [{
    id: 'term-mosenate', legislator_id: 'leg-onder-mosenate', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', party: null, start_date: null, end_date: null,
  }];
}

// ============================================================================
// buildIdentity
// ============================================================================

test('buildIdentity: Onder-shaped fixture (4 linked rows, MO senate 2013-2023 + federal house 2023-) -> identity fields exact', () => {
  const identity = buildIdentity({ person: onderPerson, legislators: onderLegislators(), terms: onderTerms() });
  assert.deepEqual(identity, {
    displayName: 'Robert F. Onder',
    party: 'Republican',
    chamberLabel: 'U.S. House',
    districtLabel: '3',
    careerSpan: '2013 – (end date unrecorded)',
    photoCandidate: onderLegislators()[0], // the bioguide row: no image_url anywhere, but it carries bioguide_id
    rowCount: 4,
  });
});

test('buildIdentity: displayName is person.display_name when a person is present, never re-derived', () => {
  const identity = buildIdentity({ person: onderPerson, legislators: onderLegislators(), terms: onderTerms() });
  assert.equal(identity.displayName, onderPerson.display_name);
});

test('buildIdentity: no person -> displayName is the single row\'s full_name as stored, never edited', () => {
  const identity = buildIdentity({ person: null, legislators: moSenateOnlyLegislator(), terms: moSenateOnlyTerms() });
  assert.equal(identity.displayName, 'Bob Onder');
});

test('buildIdentity: null-date-only terms (real MO-senate-only shape) -> careerSpan "service dates unrecorded", chamber/district still labeled plainly from the term row', () => {
  const identity = buildIdentity({ person: null, legislators: moSenateOnlyLegislator(), terms: moSenateOnlyTerms() });
  assert.equal(identity.careerSpan, 'service dates unrecorded');
  assert.equal(identity.chamberLabel, 'MO Senate');
  assert.equal(identity.districtLabel, '2');
});

test('buildIdentity: party falls back to legislator.party when no term carries a party', () => {
  const identity = buildIdentity({ person: null, legislators: moSenateOnlyLegislator(), terms: moSenateOnlyTerms() });
  assert.equal(identity.party, 'Republican');
});

test('buildIdentity: zero terms rows (unlinked, freshly-ingested row) -> chamberLabel/districtLabel null, careerSpan "service dates unrecorded", never padded or guessed', () => {
  const identity = buildIdentity({
    person: null,
    legislators: [{
      id: 'leg-onder-bioguide', full_name: 'Onder, Robert F.', bioguide_id: 'O000177', party: null, image_url: null,
    }],
    terms: [],
  });
  assert.equal(identity.chamberLabel, null);
  assert.equal(identity.districtLabel, null);
  assert.equal(identity.careerSpan, 'service dates unrecorded');
  assert.equal(identity.party, null, 'no term party, no legislator party -> null, never invented');
  assert.equal(identity.rowCount, 1);
});

test('buildIdentity: photoCandidate falls back to a bioguide-carrying row when no row has image_url', () => {
  const identity = buildIdentity({ person: onderPerson, legislators: onderLegislators(), terms: onderTerms() });
  assert.equal(identity.photoCandidate.bioguide_id, 'O000177');
});

test('buildIdentity: photoCandidate prefers a row with image_url set over a bioguide-only row', () => {
  const legislators = [
    {
      id: 'leg-a', full_name: 'A', bioguide_id: 'X000001', image_url: null,
    },
    {
      id: 'leg-b', full_name: 'A', bioguide_id: null, image_url: 'https://img.example/a.jpg',
    },
  ];
  const identity = buildIdentity({ person: null, legislators, terms: [] });
  assert.equal(identity.photoCandidate.id, 'leg-b');
});

test('buildIdentity: rowCount reflects the number of linked legislator rows', () => {
  const identity = buildIdentity({ person: onderPerson, legislators: onderLegislators(), terms: onderTerms() });
  assert.equal(identity.rowCount, 4);
});

// ============================================================================
// careerSpan
// ============================================================================

test('careerSpan: both bounds known -> "YYYY – YYYY"', () => {
  const terms = [{ start_date: '2013-01-09', end_date: '2023-01-04' }];
  assert.equal(careerSpan(terms), '2013 – 2023');
});

test('careerSpan: open end (currently held, or simply not recorded) -> "YYYY – (end date unrecorded)", never "present"', () => {
  const terms = [{ start_date: '2019-01-01', end_date: null }];
  assert.equal(careerSpan(terms), '2019 – (end date unrecorded)');
});

test('careerSpan: multiple terms -> earliest start year, open end wins if ANY dated term is open', () => {
  assert.equal(careerSpan(onderTerms()), '2013 – (end date unrecorded)');
});

test('careerSpan: multiple fully-closed terms -> earliest start year, latest end year', () => {
  const terms = [
    { start_date: '2001-01-01', end_date: '2009-01-01' },
    { start_date: '2013-01-01', end_date: '2023-01-01' },
  ];
  assert.equal(careerSpan(terms), '2001 – 2023');
});

test('careerSpan: all start_dates null -> "service dates unrecorded"', () => {
  assert.equal(careerSpan(moSenateOnlyTerms()), 'service dates unrecorded');
});

test('careerSpan: empty terms array -> "service dates unrecorded"', () => {
  assert.equal(careerSpan([]), 'service dates unrecorded');
});

test('careerSpan: null/undefined terms input -> "service dates unrecorded", never throws', () => {
  assert.equal(careerSpan(null), 'service dates unrecorded');
  assert.equal(careerSpan(undefined), 'service dates unrecorded');
});

test('careerSpan: "present" never appears in any careerSpan output (assert across every fixture in this file)', () => {
  const fixtures = [
    onderTerms(),
    moSenateOnlyTerms(),
    [],
    [{ start_date: '2019-01-01', end_date: null }],
    [{ start_date: '2001-01-01', end_date: '2009-01-01' }, { start_date: '2013-01-01', end_date: '2023-01-01' }],
  ];
  for (const terms of fixtures) {
    const span = careerSpan(terms);
    assert.equal(/present/i.test(span), false, `careerSpan(${JSON.stringify(terms)}) = "${span}" must never say "present"`);
  }
});

// ============================================================================
// chamberLabel
// ============================================================================

test('chamberLabel: exact map for the four known (jurisdiction, chamber) combos', () => {
  assert.equal(chamberLabel('us-congress', 'senate'), 'U.S. Senate');
  assert.equal(chamberLabel('us-congress', 'house'), 'U.S. House');
  assert.equal(chamberLabel('mo-legislature', 'senate'), 'MO Senate');
  assert.equal(chamberLabel('mo-legislature', 'house'), 'MO House');
});

test('chamberLabel: unknown combo -> the raw values joined with a space, never dropped, never guessed', () => {
  assert.equal(chamberLabel('ca-legislature', 'senate'), 'ca-legislature senate');
  assert.equal(chamberLabel('us-congress', 'assembly'), 'us-congress assembly');
});

// ============================================================================
// voteFilterQuery
// ============================================================================

test('voteFilterQuery: legislatorIds + chamber + year -> exact public_vote_feed path', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1', 'leg-2'], chamber: 'senate', year: 2023 });
  assert.equal(
    path,
    'public_vote_feed?legislator_id=in.(leg-1,leg-2)&chamber=eq.senate&vote_date=gte.2023-01-01&vote_date=lt.2024-01-01&order=vote_date.desc.nullslast,cast_id.desc',
  );
});

test('voteFilterQuery: legislatorIds only -> no chamber/year filters, order clause always present', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'] });
  assert.equal(path, 'public_vote_feed?legislator_id=in.(leg-1)&order=vote_date.desc.nullslast,cast_id.desc');
});

test('voteFilterQuery: chamber only, no year', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'], chamber: 'house' });
  assert.equal(path, 'public_vote_feed?legislator_id=in.(leg-1)&chamber=eq.house&order=vote_date.desc.nullslast,cast_id.desc');
});

test('voteFilterQuery: year only, no chamber', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'], year: 2019 });
  assert.equal(path, 'public_vote_feed?legislator_id=in.(leg-1)&vote_date=gte.2019-01-01&vote_date=lt.2020-01-01&order=vote_date.desc.nullslast,cast_id.desc');
});

test('voteFilterQuery: page is accepted per the interface signature but never alters the path (pagination is Range-header driven, not a URL filter)', () => {
  const withPage = voteFilterQuery({ legislatorIds: ['leg-1'], chamber: 'senate', year: 2023, page: 3 });
  const withoutPage = voteFilterQuery({ legislatorIds: ['leg-1'], chamber: 'senate', year: 2023 });
  assert.equal(withPage, withoutPage);
});

// ============================================================================
// groupSponsorships
// ============================================================================

test('groupSponsorships: partitions rows into the exact 0015 vocabulary buckets', () => {
  const rows = [
    { bill_id: 'b1', legislator_id: 'l1', sponsor_type: 'primary' },
    { bill_id: 'b2', legislator_id: 'l1', sponsor_type: 'cosponsor' },
    { bill_id: 'b3', legislator_id: 'l1', sponsor_type: 'joint' },
    { bill_id: 'b4', legislator_id: 'l1', sponsor_type: 'unspecified' },
    { bill_id: 'b5', legislator_id: 'l1', sponsor_type: 'cosponsor' },
  ];
  const grouped = groupSponsorships(rows);
  assert.deepEqual(grouped.primary, [rows[0]]);
  assert.deepEqual(grouped.cosponsor, [rows[1], rows[4]]);
  assert.deepEqual(grouped.joint, [rows[2]]);
  assert.deepEqual(grouped.unspecified, [rows[3]]);
});

test('groupSponsorships: empty input -> all four buckets present and empty', () => {
  assert.deepEqual(groupSponsorships([]), {
    primary: [], cosponsor: [], joint: [], unspecified: [],
  });
});

test('groupSponsorships: an unknown sponsor_type throws (fail loud) — a new type means the schema changed', () => {
  const rows = [{ bill_id: 'b1', legislator_id: 'l1', sponsor_type: 'withdrawn' }];
  assert.throws(() => groupSponsorships(rows), UnknownSponsorTypeError);
});

test('groupSponsorships: a null/missing sponsor_type also throws, never silently bucketed', () => {
  assert.throws(() => groupSponsorships([{ bill_id: 'b1', legislator_id: 'l1', sponsor_type: null }]), UnknownSponsorTypeError);
  assert.throws(() => groupSponsorships([{ bill_id: 'b1', legislator_id: 'l1' }]), UnknownSponsorTypeError);
});
