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
    careerSpan: '2013 – present',
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

// Fix round 1, finding 2 (task-6 controller live smoke, IMPORTANT — execution-proven on real
// data): with ALL term dates null, mostRecentTerm() returns null (nothing can be ranked), and the
// old fallback (`termRows[0]`) silently picked whichever row happened to be first in the
// caller-supplied array — the live smoke caught this rendering "MO Senate, district 2" for a man
// CURRENTLY in the U.S. House, because his MO Senate row happened to sort first in an unordered
// query. Asymmetric-cost doctrine: when the data cannot order the terms, showing ALL of them is
// honest; picking one is a guess. Fixed: when the term set is date-unproven (no term carries a
// start_date) AND there is more than one DISTINCT (jurisdiction_id, chamber, district)
// affiliation, chamberLabel becomes all of them joined (each segment already carries its own
// "district N" suffix), and districtLabel is null so the caller's existing
// `chamberLabel + ", district " + districtLabel` rendering never double-appends. A single
// affiliation (even with multiple term rows, e.g. duplicates) keeps the original single-field
// shape unchanged.
const dualUnprovenTerms = [
  {
    id: 't1', legislator_id: 'leg-a', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', party: 'Republican', start_date: null, end_date: null,
  },
  {
    id: 't2', legislator_id: 'leg-b', jurisdiction_id: 'us-congress', chamber: 'house', district: '3', party: 'Republican', start_date: null, end_date: null,
  },
];

test('buildIdentity: fix round 1 finding 2 — all term dates null AND multiple distinct affiliations -> chamberLabel shows ALL of them joined, never one arbitrary pick', () => {
  const identity = buildIdentity({ person: null, legislators: [], terms: dualUnprovenTerms });
  assert.equal(identity.chamberLabel, 'MO Senate, district 2 · U.S. House, district 3');
  assert.equal(identity.districtLabel, null, 'district is already folded into the joined chamberLabel string, not a separate redundant field');
  assert.equal(identity.careerSpan, 'service dates unrecorded');
});

test('buildIdentity: fix round 1 finding 2 — the joined-affiliations order is deterministic regardless of caller-supplied term array order', () => {
  const forward = buildIdentity({ person: null, legislators: [], terms: dualUnprovenTerms });
  const swapped = buildIdentity({ person: null, legislators: [], terms: [...dualUnprovenTerms].reverse() });
  assert.equal(forward.chamberLabel, swapped.chamberLabel, 'array order must never change which text renders — same class of bug as the party-precedence fix');
});

test('buildIdentity: fix round 1 finding 2 — duplicate (jurisdiction, chamber, district) rows collapse to ONE affiliation, single-field shape unchanged', () => {
  const duplicateRows = [dualUnprovenTerms[0], { ...dualUnprovenTerms[0], id: 't1b', legislator_id: 'leg-a2' }];
  const identity = buildIdentity({ person: null, legislators: [], terms: duplicateRows });
  assert.equal(identity.chamberLabel, 'MO Senate');
  assert.equal(identity.districtLabel, '2', 'exactly one distinct affiliation keeps the original single-field shape, not a one-item joined string');
});

test('buildIdentity: fix round 1 finding 2 — a distinct affiliation with no district omits the ", district" suffix in its own segment', () => {
  const terms = [
    {
      jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
    },
    {
      jurisdiction_id: 'us-congress', chamber: 'senate', district: null, start_date: null, end_date: null,
    },
  ];
  const identity = buildIdentity({ person: null, legislators: [], terms });
  assert.equal(identity.chamberLabel, 'MO Senate, district 2 · U.S. Senate');
});

// Fix round 1 (task-8 review, LOW-7): U.S. Senate terms store the state's USPS abbreviation in
// `district` (terms.district-as-state convention), not a real district number — "U.S. Senate,
// district MO" reads as a real congressional district that doesn't exist. Covers all three
// buildIdentity paths that could print a district suffix.
test('buildIdentity: a dated U.S. Senate anchor term never prints a "district" suffix (the stored value is the state, not a district)', () => {
  const terms = [
    {
      jurisdiction_id: 'us-congress', chamber: 'senate', district: 'MO', party: 'Republican', start_date: '2019-01-03', end_date: null,
    },
  ];
  const identity = buildIdentity({ person: null, legislators: [], terms });
  assert.equal(identity.chamberLabel, 'U.S. Senate');
  assert.equal(identity.districtLabel, null);
});

test('buildIdentity: a single date-unproven U.S. Senate affiliation never prints a "district" suffix', () => {
  const terms = [
    {
      jurisdiction_id: 'us-congress', chamber: 'senate', district: 'MO', start_date: null, end_date: null,
    },
  ];
  const identity = buildIdentity({ person: null, legislators: [], terms });
  assert.equal(identity.chamberLabel, 'U.S. Senate');
  assert.equal(identity.districtLabel, null);
});

test('buildIdentity: a joined multi-affiliation string never prints "district" for the U.S. Senate segment, even when that term carries a state-as-district value', () => {
  const terms = [
    {
      jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null,
    },
    {
      jurisdiction_id: 'us-congress', chamber: 'senate', district: 'MO', start_date: null, end_date: null,
    },
  ];
  const identity = buildIdentity({ person: null, legislators: [], terms });
  assert.equal(identity.chamberLabel, 'MO Senate, district 2 · U.S. Senate');
});

test('buildIdentity: fix round 1 finding 2 — when dates DO order the terms, single-line anchor-term behavior stands unchanged (no regression)', () => {
  const identity = buildIdentity({ person: onderPerson, legislators: onderLegislators(), terms: onderTerms() });
  assert.equal(identity.chamberLabel, 'U.S. House');
  assert.equal(identity.districtLabel, '3');
});

test('buildIdentity: party falls back to legislator.party when no term carries a party', () => {
  const identity = buildIdentity({ person: null, legislators: moSenateOnlyLegislator(), terms: moSenateOnlyTerms() });
  assert.equal(identity.party, 'Republican');
});

// Fix round 1, finding 1 (task review, execution-proven): the original legislator.party fallback
// picked the FIRST row in caller-supplied array order — swapping two rows flipped the displayed
// party. Party is the most neutrality-sensitive fact on the page (CLAUDE.md's "mechanically
// neutral" non-negotiable); it must be mechanical, never dependent on an unordered query's
// incidental row order (Task 6's query carries no order= clause — Postgres guarantees nothing).
test('buildIdentity: party fallback across legislator rows is mechanical (bioguide > mo_senate > mo_house > legiscan > openstates), never caller-order-dependent', () => {
  const bioguideRow = {
    id: 'a', full_name: 'X', bioguide_id: 'B1', party: 'Republican',
  };
  const openstatesRow = {
    id: 'b', full_name: 'X', openstates_id: 'os-1', party: 'Democrat',
  };
  const forward = buildIdentity({ person: null, legislators: [bioguideRow, openstatesRow], terms: [] });
  const swapped = buildIdentity({ person: null, legislators: [openstatesRow, bioguideRow], terms: [] });
  assert.equal(forward.party, 'Republican');
  assert.equal(swapped.party, 'Republican', 'row order swapped -> party must NOT flip');
});

test('buildIdentity: party fallback skips a higher-precedence row with no recorded party and falls to the next tier', () => {
  const bioguideRowNoParty = {
    id: 'a', full_name: 'X', bioguide_id: 'B1', party: null,
  };
  const legiscanRow = {
    id: 'b', full_name: 'X', legiscan_people_id: 99, party: 'Democrat',
  };
  const identity = buildIdentity({ person: null, legislators: [bioguideRowNoParty, legiscanRow], terms: [] });
  assert.equal(identity.party, 'Democrat');
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

// Changed 2026-08-30. This test asserted the OPPOSITE until today — that "present" must never
// appear — on the reasoning that a currently-held term and a data gap are indistinguishable from
// the terms table alone. They are not: 729 of 731 open-ended terms belong to a legislator who cast
// a vote in 2026, and directory-page.js already grouped exactly these people under a "Serving now"
// heading from the identical signal. The old string also described US ("we did not record an end")
// where a reader wanted a fact about the politician.
test('careerSpan: an open end renders "YYYY – present" (measured: 729/731 open terms are current)', () => {
  const terms = [{ start_date: '2019-01-01', end_date: null }];
  assert.equal(careerSpan(terms), '2019 – present');
});

test('careerSpan: multiple terms -> earliest start year, open end wins if ANY dated term is open', () => {
  assert.equal(careerSpan(onderTerms()), '2013 – present');
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

// Fix round 1, finding 2 (task review, execution-proven): the original `dated` filter dropped a
// null-start term ENTIRELY, silently discarding its recorded end_date. careerSpan([2013-2018,
// {start:null, end:2020}]) used to say '2013 – 2018', losing the real 2020 evidence.
const MIXED_EVIDENCE_TERMS = [
  { start_date: '2013-01-01', end_date: '2018-01-01' },
  { start_date: null, end_date: '2020-01-01' },
];

test('careerSpan: fix round 1 finding 2 — a term missing start_date is NOT dropped; its end_date still counts, honesty suffix marks the gap', () => {
  assert.equal(careerSpan(MIXED_EVIDENCE_TERMS), '2013 – 2020 (some service dates unrecorded)');
});

test('careerSpan: fix round 1 finding 2 — the all-null case is unaffected (still the plain "service dates unrecorded", no suffix stacking)', () => {
  assert.equal(careerSpan(moSenateOnlyTerms()), 'service dates unrecorded');
});

// This was a BLANKET ban on the word "present" across every fixture. It is now the narrower rule
// that survived the 2026-08-30 measurement, deliberately kept as a test rather than deleted: the
// reason for the original ban was sound, and only its scope was wrong.
//
// "present" is a claim that service is ONGOING. It is earned by an open end_date and by nothing
// else. A career with every end recorded is finished, and a term whose START is missing is
// genuinely unknown — neither may ever say "present", because in those cases we really would be
// inventing currency rather than reporting an open record.
test('careerSpan: "present" is earned ONLY by an open end_date — never by a closed career, never by a missing start', () => {
  const mustNotSayPresent = [
    ['no terms at all', []],
    ['every term closed', [
      { start_date: '2001-01-01', end_date: '2009-01-01' },
      { start_date: '2013-01-01', end_date: '2023-01-01' },
    ]],
  ];
  for (const [label, terms] of mustNotSayPresent) {
    const span = careerSpan(terms);
    assert.equal(/present/i.test(span), false, `${label}: careerSpan = "${span}" must not claim ongoing service`);
  }

  // And the positive half, so the rule is pinned from both sides rather than only forbidden.
  assert.match(careerSpan([{ start_date: '2019-01-01', end_date: null }]), /present$/);
  assert.match(careerSpan(onderTerms()), /present$/);
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

// Task 6 extension: the missed-votes toggle (design spec §3, "a filter over the same cast list —
// not voting / absent, presented as the printed positions they are, no percentage, no
// comparison") re-queries the server, never client-filters a partial page — this is that server
// filter, appended to the SAME path builder rather than a lookalike client-side re-implementation.
test('voteFilterQuery: missedOnly true appends position=in.(not_voting,absent) before the order clause', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'], missedOnly: true });
  assert.equal(
    path,
    'public_vote_feed?legislator_id=in.(leg-1)&position=in.(not_voting,absent)&order=vote_date.desc.nullslast,cast_id.desc',
  );
});

test('voteFilterQuery: missedOnly false/absent -> no position filter, output unchanged from before this option existed', () => {
  const withFalse = voteFilterQuery({ legislatorIds: ['leg-1'], chamber: 'senate', missedOnly: false });
  const withoutOption = voteFilterQuery({ legislatorIds: ['leg-1'], chamber: 'senate' });
  assert.equal(withFalse, withoutOption);
  assert.equal(withFalse, 'public_vote_feed?legislator_id=in.(leg-1)&chamber=eq.senate&order=vote_date.desc.nullslast,cast_id.desc');
});

test('voteFilterQuery: missedOnly combines with chamber + year, all filters present in order', () => {
  const path = voteFilterQuery({
    legislatorIds: ['leg-1'], chamber: 'house', year: 2021, missedOnly: true,
  });
  assert.equal(
    path,
    'public_vote_feed?legislator_id=in.(leg-1)&chamber=eq.house&vote_date=gte.2021-01-01&vote_date=lt.2022-01-01&position=in.(not_voting,absent)&order=vote_date.desc.nullslast,cast_id.desc',
  );
});

test('voteFilterQuery: page is accepted per the interface signature but never alters the path (pagination is Range-header driven, not a URL filter)', () => {
  const withPage = voteFilterQuery({ legislatorIds: ['leg-1'], chamber: 'senate', year: 2023, page: 3 });
  const withoutPage = voteFilterQuery({ legislatorIds: ['leg-1'], chamber: 'senate', year: 2023 });
  assert.equal(withPage, withoutPage);
});

// ============================================================================
// H2 (task 6b review, fix round 1): the chart bar-click position filter — 'yea'/'nay' map to an
// exact single-value match, 'other' maps to the SAME (present,other) grouping summarizeTotals'
// own 'other' bucket uses (site/js/vote-charts.js), and missedOnly stays a special case that wins
// outright whenever both happen to be set (defensive only — vote-charts.js's BAR_CLICK_PATCH
// always clears the other lever on every click).
// ============================================================================

test('voteFilterQuery: position=yea appends an exact position=eq.yea clause', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'], position: 'yea' });
  assert.equal(
    path,
    'public_vote_feed?legislator_id=in.(leg-1)&position=eq.yea&order=vote_date.desc.nullslast,cast_id.desc',
  );
});

test('voteFilterQuery: position=nay appends an exact position=eq.nay clause', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'], position: 'nay' });
  assert.match(path, /position=eq\.nay/);
});

test('voteFilterQuery: position=other appends position=in.(present,other) — the SAME grouping summarizeTotals\' own "other" bucket uses', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'], position: 'other' });
  assert.match(path, /position=in\.\(present,other\)/);
});

test('voteFilterQuery: an unrecognized position value is ignored (no clause appended, never a malformed filter)', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'], position: 'not_voting' });
  assert.doesNotMatch(path, /position=/);
});

test('voteFilterQuery: position combines with chamber + year, all filters present in order', () => {
  const path = voteFilterQuery({
    legislatorIds: ['leg-1'], chamber: 'house', year: 2021, position: 'yea',
  });
  assert.equal(
    path,
    'public_vote_feed?legislator_id=in.(leg-1)&chamber=eq.house&vote_date=gte.2021-01-01&vote_date=lt.2022-01-01&position=eq.yea&order=vote_date.desc.nullslast,cast_id.desc',
  );
});

test('voteFilterQuery: missedOnly wins outright when BOTH missedOnly and position are set (defensive — the real callers never set both at once)', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'], missedOnly: true, position: 'yea' });
  assert.match(path, /position=in\.\(not_voting,absent\)/);
  assert.doesNotMatch(path, /position=eq\.yea/);
});

test('voteFilterQuery: no position, no missedOnly -> no position clause at all, unchanged from before H2', () => {
  const path = voteFilterQuery({ legislatorIds: ['leg-1'] });
  assert.doesNotMatch(path, /position=/);
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
