import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseRollRange } from '../src/cli/ingest.js';

test('parseRollRange expands inclusive ranges and singles', () => {
  assert.deepEqual(parseRollRange('120-124'), [120, 121, 122, 123, 124]);
  assert.deepEqual(parseRollRange('7'), [7]);
});

test('parseArgs reads source-specific options', () => {
  const us = parseArgs(['--source', 'us-congress', '--rolls', '120-121', '--year', '2025']);
  assert.equal(us.source, 'us-congress');
  assert.deepEqual(us.rolls, [120, 121]);
  assert.equal(us.year, 2025);
  const mo = parseArgs(['--source', 'mo-legislature', '--session', '2022', '--pages', '2']);
  assert.equal(mo.source, 'mo-legislature');
  assert.equal(mo.session, '2022');
  assert.equal(mo.pages, 2);
});

test('parseArgs rejects unknown source', () => {
  assert.throws(() => parseArgs(['--source', 'mars']), /unknown source/);
});

test('parseArgs defaults dryRun to false', () => {
  const args = parseArgs(['--source', 'mo-legislature', '--session', '2022']);
  assert.equal(args.dryRun, false);
});

test('parseArgs sets dryRun true when --dry-run flag is present, at any position', () => {
  const before = parseArgs(['--dry-run', '--source', 'us-congress', '--rolls', '120-121']);
  assert.equal(before.dryRun, true);
  assert.equal(before.source, 'us-congress');
  assert.deepEqual(before.rolls, [120, 121]);
  const after = parseArgs(['--source', 'us-congress', '--rolls', '120-121', '--dry-run']);
  assert.equal(after.dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--source', 'us-congress', '--bogus', 'x']), /unknown flag/);
});
