// tests/directory-model.test.js — TDD for the pure directory-grouping/sort/filter logic that
// lives in site/js/directory-page.js (task-8-brief.md, Step 1/2). Written BEFORE the pure model
// functions exist (fails first). site/js/directory-page.js also carries the DOM-orchestration
// side (address UI wiring, fetches) — not exercised here, same split as
// tests/person-page.test.js vs site/js/person-page.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDirectoryEntries, filterDirectory } from '../site/js/directory-page.js';

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
