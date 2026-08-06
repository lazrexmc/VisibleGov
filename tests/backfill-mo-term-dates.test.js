import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePersonYaml, loadCachedRoster, readCachedDatasetFull } from '../src/cli/backfill-mo-term-dates.js';

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

// The committed LegiScan fixture stores its envelope under `.dataset` (see legiscan-dataset.test.js).
// readCachedDatasetFull expects a top-level `.zip` field (the cache-file envelope shape), so build one.
// Uses 1608 fixture (8 roll calls) rather than 1579 (0 roll calls) to test the full bill/people/rollCalls path.
function writeCacheEnvelope() {
  const src = JSON.parse(readFileSync('tests/fixtures/research/legiscan/mo-2018-dataset-1608.json', 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'vg-ds-'));
  const path = join(dir, 'sess.json');
  writeFileSync(path, JSON.stringify({ session_id: 1608, year_start: 2018, zip: src.dataset.zip }));
  return path;
}

test('readCachedDatasetFull returns people AND rollCalls plus the envelope year', async () => {
  const path = writeCacheEnvelope();
  const out = await readCachedDatasetFull(path);
  assert.equal(out.ok, true);
  assert.equal(out.yearStart, 2018);
  assert.ok(Array.isArray(out.people) && out.people.length > 0);
  assert.ok(Array.isArray(out.rollCalls) && out.rollCalls.length > 0);
  assert.ok(out.rollCalls[0].chamber === 'H' || out.rollCalls[0].chamber === 'S');
});

test('readCachedDatasetFull returns ok:false on unreadable file (no throw)', async () => {
  const out = await readCachedDatasetFull('does/not/exist.json');
  assert.equal(out.ok, false);
});
