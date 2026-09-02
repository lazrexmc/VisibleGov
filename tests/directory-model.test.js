// tests/directory-model.test.js — TDD for the pure directory-grouping/sort/filter logic that
// lives in site/js/directory-page.js (task-8-brief.md, Step 1/2). Written BEFORE the pure model
// functions exist (fails first). site/js/directory-page.js also carries the DOM-orchestration
// side (address UI wiring, fetches) — not exercised here, same split as
// tests/person-page.test.js vs site/js/person-page.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDirectoryEntries,
  filterDirectory,
  filterDirectoryByChamber,
  pageDirectory,
  partitionDirectory,
  summarizeDirectory,
} from '../site/js/directory-page.js';

// ============================================================================
// buildDirectoryEntries — fetchAllRows over legislators+persons+terms, grouped by person_id
// (ungrouped rows stand alone), one entry per person/row, alphabetical by surname.
// ============================================================================

test('buildDirectoryEntries: a person with one linked legislator row -> one entry, display name from the person row', () => {
  const legislators = [
    {
      id: 'leg-1', full_name: 'Jane Doe', surname: 'Doe', party: 'Democratic', person_id: 'person-1',
    },
  ];
  const persons = [{ id: 'person-1', display_name: 'Jane Doe' }];
  const terms = [
    {
      legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', district: '3', party: 'Democratic', start_date: '2023-01-03', end_date: null,
    },
  ];
  const entries = buildDirectoryEntries({ legislators, persons, terms });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].displayName, 'Jane Doe');
  assert.equal(entries[0].href, '/person/person-1/jane-doe');
  assert.equal(entries[0].party, 'Democratic');
  assert.equal(entries[0].chamber, 'U.S. House');
  assert.equal(entries[0].district, '3');
});

test('buildDirectoryEntries: an ungrouped legislator row (no person_id) stands alone, links to /legislator/', () => {
  const legislators = [{
    id: 'leg-2', full_name: 'Solo Legislator', surname: 'Legislator', party: 'Republican', person_id: null,
  }];
  const entries = buildDirectoryEntries({ legislators, persons: [], terms: [] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].displayName, 'Solo Legislator');
  assert.equal(entries[0].href, '/legislator/leg-2/solo-legislator');
});

test('buildDirectoryEntries: two legislator rows sharing one person_id (a merged career) collapse into ONE entry', () => {
  const legislators = [
    {
      id: 'leg-a', full_name: 'Merged Old', surname: 'Merged', party: 'Republican', person_id: 'person-9',
    },
    {
      id: 'leg-b', full_name: 'Merged New', surname: 'Merged', party: 'Republican', person_id: 'person-9',
    },
  ];
  const persons = [{ id: 'person-9', display_name: 'Merged Person' }];
  const terms = [
    {
      legislator_id: 'leg-a', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', party: 'Republican', start_date: '2015-01-01', end_date: '2019-01-01',
    },
    {
      legislator_id: 'leg-b', jurisdiction_id: 'us-congress', chamber: 'house', district: '2', party: 'Republican', start_date: '2019-01-03', end_date: null,
    },
  ];
  const entries = buildDirectoryEntries({ legislators, persons, terms });
  assert.equal(entries.length, 1, 'one entry per PERSON, not per legislator row');
  // Most-recent term (2019 US House) wins for chamber/district — mirrors profile-model's own
  // "most recent term" anchor rule.
  assert.equal(entries[0].chamber, 'U.S. House');
  assert.equal(entries[0].district, '2');
});

test('buildDirectoryEntries: chamber/party/district come from the MOST RECENT term across the group', () => {
  const legislators = [{
    id: 'leg-3', full_name: 'Career Person', surname: 'Person', party: 'Independent', person_id: 'person-3',
  }];
  const persons = [{ id: 'person-3', display_name: 'Career Person' }];
  const terms = [
    {
      legislator_id: 'leg-3', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '10', party: 'Democratic', start_date: '2011-01-01', end_date: '2015-01-01',
    },
    {
      legislator_id: 'leg-3', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '5', party: 'Democratic', start_date: '2015-01-01', end_date: null,
    },
  ];
  const entries = buildDirectoryEntries({ legislators, persons, terms });
  assert.equal(entries[0].chamber, 'MO Senate');
  assert.equal(entries[0].district, '5');
});

test('buildDirectoryEntries: a legislator/person with zero terms still renders an entry (chamber/district null, never dropped)', () => {
  const legislators = [{
    id: 'leg-4', full_name: 'No Terms', surname: 'Terms', party: null, person_id: null,
  }];
  const entries = buildDirectoryEntries({ legislators, persons: [], terms: [] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].chamber, null);
  assert.equal(entries[0].district, null);
});

// ---------------------------------------------------------------------------
// FINAL REVIEW, finding 6: the party fallback for a merged person with no usable anchor term was
// `anchorLegislator?.party` — i.e. whichever legislator row happened to come first in the fetched
// array. Party is the single most neutrality-sensitive fact this page renders, and Postgres makes
// no ordering promise, so the SAME bug already fixed once in profile-model.js's resolveParty was
// still live on the front door. Live proof from the review: Yvonne Curls rendered no party on the
// directory and 'D' on her own profile — same person, two pages, two answers.
//
// Fixed by reusing profile-model.js's OWN source-precedence ranking (imported, never a second
// hand-copied list), so the directory and the profile can only ever agree.
// ---------------------------------------------------------------------------

test('buildDirectoryEntries: FINDING 6 — the Curls construction (null-party mo_senate row + D legiscan row, ZERO terms) resolves to D in EITHER input order', () => {
  const persons = [{ id: 'person-curls', display_name: 'Yvonne Curls' }];
  const moSenateRow = {
    id: 'leg-curls-mo', full_name: 'Yvonne Curls', surname: 'Curls', party: null, person_id: 'person-curls', mo_senate_id: 'S-1',
  };
  const legiscanRow = {
    id: 'leg-curls-ls', full_name: 'Yvonne Curls', surname: 'Curls', party: 'D', person_id: 'person-curls', legiscan_people_id: 4242,
  };
  for (const legislators of [[moSenateRow, legiscanRow], [legiscanRow, moSenateRow]]) {
    const entries = buildDirectoryEntries({ legislators, persons, terms: [] });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].party, 'D', 'the highest-precedence row that actually CARRIES a party wins, never array position');
  }
});

test('buildDirectoryEntries: FINDING 6 — source precedence, not array position, decides between two rows that BOTH carry a party', () => {
  const persons = [{ id: 'p1', display_name: 'Two Sourced' }];
  // bioguide outranks legiscan (profile-model.js's SOURCE_PRECEDENCE_COLUMNS, mirroring
  // person-identity.js's DISPLAY_NAME_PRIORITY) — so 'Republican' wins in either order.
  const bioguideRow = {
    id: 'leg-fed', full_name: 'Two Sourced', surname: 'Sourced', party: 'Republican', person_id: 'p1', bioguide_id: 'X000001',
  };
  const legiscanRow = {
    id: 'leg-ls', full_name: 'Two Sourced', surname: 'Sourced', party: 'D', person_id: 'p1', legiscan_people_id: 7,
  };
  for (const legislators of [[bioguideRow, legiscanRow], [legiscanRow, bioguideRow]]) {
    assert.equal(buildDirectoryEntries({ legislators, persons, terms: [] })[0].party, 'Republican');
  }
});

test('buildDirectoryEntries: FINDING 6 — a term that carries a party still wins over any legislator row (unchanged precedence)', () => {
  const persons = [{ id: 'p2', display_name: 'Termed' }];
  const legislators = [{
    id: 'leg-t', full_name: 'Termed Person', surname: 'Person', party: 'R', person_id: 'p2', bioguide_id: 'Y000002',
  }];
  const terms = [{
    legislator_id: 'leg-t', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '4', party: 'Democratic', start_date: '2021-01-06', end_date: null,
  }];
  assert.equal(buildDirectoryEntries({ legislators, persons, terms })[0].party, 'Democratic');
});

test('buildDirectoryEntries: FINDING 6 — no party recorded anywhere stays null (never invented)', () => {
  const legislators = [{
    id: 'leg-none', full_name: 'No Party', surname: 'Party', party: null, person_id: null, mo_house_id: 'H-9',
  }];
  assert.equal(buildDirectoryEntries({ legislators, persons: [], terms: [] })[0].party, null);
});

test('buildDirectoryEntries: sorted alphabetically by surname (the DB column), not by input order', () => {
  const legislators = [
    {
      id: 'leg-z', full_name: 'Zed Adams', surname: 'Adams', person_id: null,
    },
    {
      id: 'leg-a', full_name: 'Amy Young', surname: 'Young', person_id: null,
    },
    {
      id: 'leg-m', full_name: 'Mid Brown', surname: 'Brown', person_id: null,
    },
  ];
  const entries = buildDirectoryEntries({ legislators, persons: [], terms: [] });
  assert.deepEqual(entries.map((e) => e.displayName), ['Zed Adams', 'Mid Brown', 'Amy Young']);
});

test('buildDirectoryEntries: a legislator row with no surname column (federal rows never carry it) still sorts sanely via a display-only fallback', () => {
  const legislators = [
    { id: 'leg-x', full_name: 'Josh Hawley', surname: null, person_id: null },
    { id: 'leg-y', full_name: 'Roy Blunt', surname: null, person_id: null },
  ];
  const entries = buildDirectoryEntries({ legislators, persons: [], terms: [] });
  // Blunt before Hawley — the fallback derives a sortable surname from the last name token.
  assert.deepEqual(entries.map((e) => e.displayName), ['Roy Blunt', 'Josh Hawley']);
});

test('buildDirectoryEntries: never throws on missing/malformed inputs', () => {
  assert.doesNotThrow(() => buildDirectoryEntries({}));
  assert.deepEqual(buildDirectoryEntries({ legislators: null, persons: null, terms: null }), []);
});

// Fix round 1 (task-8 review, LOW-7): a U.S. Senate term's `district` column stores the state's
// USPS abbreviation (terms.district-as-state convention), not a real district number — the
// directory's meta line must never show "district MO" for a senator (mirrors the same fix in
// profile-model.js's buildIdentity).
test('buildDirectoryEntries: a U.S. Senate anchor term never carries a "district" value (the stored value is the state, not a district)', () => {
  const legislators = [{
    id: 'leg-sen', full_name: 'Josh Hawley', surname: 'Hawley', party: 'Republican', person_id: null,
  }];
  const terms = [
    {
      legislator_id: 'leg-sen', jurisdiction_id: 'us-congress', chamber: 'senate', district: 'MO', party: 'Republican', start_date: '2019-01-03', end_date: null,
    },
  ];
  const entries = buildDirectoryEntries({ legislators, persons: [], terms });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].chamber, 'U.S. Senate');
  assert.equal(entries[0].district, null, 'the state-as-district value is suppressed, never rendered as a district');
});

test('buildDirectoryEntries: a real MO Senate district number is NOT suppressed (only U.S. Senate is meaningless)', () => {
  const legislators = [{
    id: 'leg-mo-sen', full_name: 'Mo Senator', surname: 'Senator', party: 'Republican', person_id: null,
  }];
  const terms = [
    {
      legislator_id: 'leg-mo-sen', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '6', party: 'Republican', start_date: '2021-01-06', end_date: null,
    },
  ];
  const entries = buildDirectoryEntries({ legislators, persons: [], terms });
  assert.equal(entries[0].district, '6');
});

// ============================================================================
// filterDirectory — client-side text filter over the COMPLETE fetched list (name + chamber +
// party), never a partial-page server re-sort.
// ============================================================================

const ENTRIES = [
  {
    key: '1', displayName: 'Jane Doe', party: 'Democratic', chamber: 'U.S. House', district: '3',
  },
  {
    key: '2', displayName: 'John Roe', party: 'Republican', chamber: 'U.S. Senate', district: null,
  },
  {
    key: '3', displayName: 'Sam Poe', party: 'Independent', chamber: 'MO Senate', district: '6',
  },
];

test('filterDirectory: empty query returns the complete list unchanged', () => {
  assert.deepEqual(filterDirectory(ENTRIES, ''), ENTRIES);
  assert.deepEqual(filterDirectory(ENTRIES, '   '), ENTRIES);
  assert.deepEqual(filterDirectory(ENTRIES, null), ENTRIES);
});

test('filterDirectory: matches by name, case-insensitive', () => {
  const result = filterDirectory(ENTRIES, 'jane');
  assert.equal(result.length, 1);
  assert.equal(result[0].displayName, 'Jane Doe');
});

test('filterDirectory: matches by chamber', () => {
  const result = filterDirectory(ENTRIES, 'senate');
  assert.equal(result.length, 2, 'both U.S. Senate and MO Senate match "senate"');
});

test('filterDirectory: matches by party', () => {
  const result = filterDirectory(ENTRIES, 'independent');
  assert.equal(result.length, 1);
  assert.equal(result[0].displayName, 'Sam Poe');
});

test('filterDirectory: no matches -> empty array, never throws', () => {
  assert.deepEqual(filterDirectory(ENTRIES, 'zzz-nothing-matches'), []);
});

test('filterDirectory: never throws on malformed entries/queryText', () => {
  assert.doesNotThrow(() => filterDirectory(null, 'x'));
  assert.doesNotThrow(() => filterDirectory([{ }], 'x'));
});

test('summarizeDirectory: totals the directory and chamber buckets without dropping unknown rows', () => {
  const summary = summarizeDirectory([
    { chamber: 'U.S. Senate', servingNow: true },
    { chamber: 'U.S. House', servingNow: true },
    { chamber: 'MO House', servingNow: false },
    { chamber: null, servingNow: false },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.servingNow, 2);
  assert.equal(summary.past, 2);
  assert.equal(summary.chambers['U.S. Senate'], 1);
  assert.equal(summary.chambers['U.S. House'], 1);
  assert.equal(summary.chambers['MO Senate'], 0);
  assert.equal(summary.chambers['MO House'], 1);
});

test('filterDirectoryByChamber: narrows to the chosen chamber, while all/empty returns every row', () => {
  const entries = [
    { key: 'sen', chamber: 'U.S. Senate' },
    { key: 'house', chamber: 'MO House' },
    { key: 'none', chamber: null },
  ];
  assert.deepEqual(filterDirectoryByChamber(entries, 'MO House').map((e) => e.key), ['house']);
  assert.deepEqual(filterDirectoryByChamber(entries, 'all').map((e) => e.key), ['sen', 'house', 'none']);
  assert.deepEqual(filterDirectoryByChamber(entries, null).map((e) => e.key), ['sen', 'house', 'none']);
});

test('pageDirectory: returns a bounded slice plus an honest hasMore flag', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ key: String(i) }));
  const firstPage = pageDirectory(entries, 24);
  assert.equal(firstPage.visible.length, 24);
  assert.equal(firstPage.showing, 24);
  assert.equal(firstPage.total, 30);
  assert.equal(firstPage.hasMore, true);

  const fullPage = pageDirectory(entries, 48);
  assert.equal(fullPage.visible.length, 30);
  assert.equal(fullPage.showing, 30);
  assert.equal(fullPage.hasMore, false);
});

// ---- servingNow / sinceYear (Serving now / Past members split, 2026-08-06 spec) ----

test('buildDirectoryEntries: an open term (end_date null) -> servingNow true, sinceYear from its dated start', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'Jane Adams', surname: 'Adams', person_id: null }],
    persons: [],
    terms: [{ legislator_id: 'L1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '29', start_date: '2023-01-04', end_date: null }],
  });
  assert.equal(entries[0].servingNow, true);
  assert.equal(entries[0].sinceYear, 2023);
});

test('buildDirectoryEntries: every term ended -> servingNow false, sinceYear null (ended anchor never yields a fragment)', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'Old Timer', surname: 'Timer', person_id: null }],
    persons: [],
    terms: [{ legislator_id: 'L1', jurisdiction_id: 'us-congress', chamber: 'house', district: '3', start_date: '2017-01-03', end_date: '2021-01-03' }],
  });
  assert.equal(entries[0].servingNow, false);
  assert.equal(entries[0].sinceYear, null);
});

test('buildDirectoryEntries: zero terms -> servingNow false (service unprovable is never promoted), sinceYear null', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'No Terms', surname: 'Terms', person_id: null }],
    persons: [],
    terms: [],
  });
  assert.equal(entries[0].servingNow, false);
  assert.equal(entries[0].sinceYear, null);
});

test('buildDirectoryEntries: the Brown case — open but completely undated term -> servingNow true, sinceYear null', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'Galen Brown', surname: 'Brown', person_id: null }],
    persons: [],
    terms: [{ legislator_id: 'L1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '149', start_date: null, end_date: null }],
  });
  assert.equal(entries[0].servingNow, true);
  assert.equal(entries[0].sinceYear, null);
});

test('buildDirectoryEntries: the Onder construction (live-verified 2026-08-06) — merged person, open dated federal term + open undated MO row -> ONE serving entry anchored on the federal seat', () => {
  const entries = buildDirectoryEntries({
    legislators: [
      { id: 'L-fed', full_name: 'Onder, Robert F.', surname: null, person_id: 'P1' },
      { id: 'L-mo', full_name: 'Bob Onder', surname: 'Onder', person_id: 'P1' },
    ],
    persons: [{ id: 'P1', display_name: 'Bob Onder' }],
    terms: [
      { legislator_id: 'L-fed', jurisdiction_id: 'us-congress', chamber: 'house', district: '3', start_date: '2025-01-03', end_date: null },
      { legislator_id: 'L-mo', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: '2', start_date: null, end_date: null },
    ],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].servingNow, true);
  assert.equal(entries[0].sinceYear, 2025);
  assert.equal(entries[0].chamber, 'U.S. House'); // anchor is the dated federal term, never the undated MO row
});

test('buildDirectoryEntries: merged person with one ended dated term + a DIFFERENT open undated term -> servingNow true but sinceYear null (fragment only describes the anchor)', () => {
  const entries = buildDirectoryEntries({
    legislators: [{ id: 'L1', full_name: 'Mixed Case', surname: 'Case', person_id: null }],
    persons: [],
    terms: [
      { legislator_id: 'L1', jurisdiction_id: 'us-congress', chamber: 'house', district: '5', start_date: '2015-01-03', end_date: '2019-01-03' },
      { legislator_id: 'L1', jurisdiction_id: 'mo-legislature', chamber: 'house', district: '12', start_date: null, end_date: null },
    ],
  });
  assert.equal(entries[0].servingNow, true);
  assert.equal(entries[0].sinceYear, null); // dated anchor (the federal term) is ENDED
});

// ============================================================================
// partitionDirectory — splits entries by servingNow, preserving order
// ============================================================================

test('partitionDirectory: splits by servingNow, preserving the surname-sorted order within each view', () => {
  const entries = [
    { key: 'a', surname: 'Adams', servingNow: true },
    { key: 'b', surname: 'Baker', servingNow: false },
    { key: 'c', surname: 'Cook', servingNow: true },
  ];
  const { servingNow, past } = partitionDirectory(entries);
  assert.deepEqual(servingNow.map((e) => e.key), ['a', 'c']);
  assert.deepEqual(past.map((e) => e.key), ['b']);
});

test('partitionDirectory: an entry with no servingNow field lands in past (never promoted), and malformed input never throws', () => {
  const { servingNow, past } = partitionDirectory([{ key: 'x' }, null]);
  assert.equal(servingNow.length, 0);
  assert.deepEqual(past.map((e) => e.key), ['x']);
  assert.deepEqual(partitionDirectory(undefined), { servingNow: [], past: [] });
});

// ============================================================================
// Composition: filterDirectory over partitionDirectory output (spec §6)
// ============================================================================

test('composition: filterDirectory narrows WITHIN a partition without disturbing the other view', () => {
  const entries = [
    { key: 'a', displayName: 'Jane Adams', surname: 'Adams', chamber: 'MO House', party: 'D', servingNow: true },
    { key: 'b', displayName: 'Bob Adams', surname: 'Adams', chamber: 'MO Senate', party: 'R', servingNow: false },
    { key: 'c', displayName: 'Carol Cook', surname: 'Cook', chamber: 'MO House', party: 'R', servingNow: true },
  ];
  const partitions = partitionDirectory(entries);
  const servingAdams = filterDirectory(partitions.servingNow, 'adams');
  assert.deepEqual(servingAdams.map((e) => e.key), ['a']); // Bob Adams is in past, never leaks into the serving view
  const pastAdams = filterDirectory(partitions.past, 'adams');
  assert.deepEqual(pastAdams.map((e) => e.key), ['b']);
  assert.equal(partitions.servingNow.length, 2, 'filtering never mutates the partition itself');
});
