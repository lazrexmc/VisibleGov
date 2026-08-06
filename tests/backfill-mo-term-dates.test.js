import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonYaml, loadCachedRoster } from '../src/cli/backfill-mo-term-dates.js';

const crossleyYaml = readFileSync('tests/fixtures/openstates-people/Aaron-Crossley-ba6eb394-0402-49ba-9917-c5618d8a1589.yml', 'utf8');
const schneltingYaml = readFileSync('tests/fixtures/openstates-people/Adam-Schnelting-f436aa10-c006-4128-9748-050bf50c4e21.yml', 'utf8');

test('parsePersonYaml maps a current House member with a day-precision start_date', () => {
  const p = parsePersonYaml(crossleyYaml);
  assert.equal(p.full_name, 'Aaron Crossley');
  assert.equal(p.family_name, 'Crossley');
  assert.match(p.openstates_id, /^ocd-person\//);
  const role = p.roles.find((r) => r.chamber === 'house');
  assert.equal(role.district, '29');
  assert.equal(role.start_date, '2023-01-04');
  assert.equal(role.end_date, null);
});

test('parsePersonYaml keeps full role history for a House→Senate transition member', () => {
  const p = parsePersonYaml(schneltingYaml);
  const senate = p.roles.find((r) => r.chamber === 'senate');
  assert.equal(senate.district, '23');
  assert.equal(senate.start_date, '2025-01-08');
  assert.equal(senate.end_date, null);
  const endedHouse = p.roles.filter((r) => r.chamber === 'house' && r.end_date);
  assert.ok(endedHouse.length >= 1, 'prior house roles carry end dates');
});

test('loadCachedRoster parses every yml in a dir and throws on a missing/empty dir', () => {
  const people = loadCachedRoster('tests/fixtures/openstates-people');
  assert.equal(people.length, 2);
  assert.ok(people.every((p) => p.openstates_id && Array.isArray(p.roles)));
  assert.throws(() => loadCachedRoster('tests/fixtures/does-not-exist'), /openstates-people cache/);
});
