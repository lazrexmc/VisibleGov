import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTextVersions, pickTextUrl, stripHtml, sha256 } from '../src/adapters/us-congress-text.js';

const versionsJson = JSON.parse(readFileSync('tests/fixtures/us-congress/bill-text-versions.json', 'utf8'));
const htm = readFileSync('tests/fixtures/us-congress/bill-text.htm', 'utf8');

test('parseTextVersions yields versions with formats', () => {
  const versions = parseTextVersions(versionsJson);
  assert.ok(versions.length > 0);
  for (const v of versions) { assert.ok(v.version_type); assert.ok(Array.isArray(v.formats)); }
});

test('pickTextUrl finds a fetchable format', () => {
  const picked = pickTextUrl(parseTextVersions(versionsJson));
  assert.ok(picked.url.startsWith('https://www.congress.gov/'));
});

test('stripHtml produces substantial plain text without tags', () => {
  const text = stripHtml(htm);
  assert.ok(text.length > 500);
  assert.ok(!/<[a-z]+[\s>]/i.test(text), 'no residual tags');
  assert.match(text, /SECTION|Sec\./); // bills reference their own sections
});

test('sha256 is stable and hex', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.match(sha256('a'), /^[0-9a-f]{64}$/);
});
