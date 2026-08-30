import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_REGISTRY, SOURCE_STATES, sourceState, silenceIsMeaningful, stateLabel,
} from '../src/lib/source-registry.js';

// public_freshness is ledger-derived with no allowlist — the right shape, because a source cannot
// vanish from it by being forgotten. The cost is that a ledger-derived list never EXPIRES a label:
// retired and silently-dead look identical forever. This registry is the declaration layer that
// separates them, and these tests pin the two rules that make it safe rather than merely tidy.

test('an UNDECLARED source is visible, never filtered out', () => {
  // The rule I would have got wrong: my instinct was to hide unknowns. Hiding them is exactly how a
  // source added without a declaration disappears from the operator's view — the failure the
  // declaration exists to prevent.
  const r = sourceState('some-source-nobody-declared');
  assert.equal(r.state, 'undeclared');
  assert.match(stateLabel('some-source-nobody-declared'), /UNDECLARED/);
  assert.match(r.note, /add it/, 'the label must tell the reader what to do about it');
});

test('an undeclared source counts as meaningful silence — never assumed fine', () => {
  // Treating an unknown as healthy assumes the answer. An unknown going quiet is precisely the case
  // nobody can reason about, so it stays in the set worth looking at.
  assert.equal(silenceIsMeaningful('some-source-nobody-declared'), true);
});

test('silence is meaningful ONLY for scheduled sources', () => {
  assert.equal(silenceIsMeaningful('us-congress'), true, 'scheduled: something should be running it');
  assert.equal(silenceIsMeaningful('verify'), false, 'on-demand: a month of silence is normal');
  assert.equal(silenceIsMeaningful('backfill-nicknames'), false, 'retired: it will never run again');
});

test('the two sources that prompted this no longer read as dead feeds', () => {
  // `verify` last ran 2026-07-28 and `gloss` 2026-07-29. Both are live CLIs on disk.
  for (const s of ['verify', 'gloss']) {
    assert.equal(sourceState(s).state, 'on-demand');
    assert.match(stateLabel(s), /silence is normal/);
    assert.equal(silenceIsMeaningful(s), false);
  }
});

test('a RETIRED source states its reason — the answer lives beside the evidence', () => {
  const label = stateLabel('mo-legislature');
  assert.match(label, /^RETIRED/);
  assert.match(label, /no entry point invokes it/, 'a retired row without a reason is just a date again');
});

test('every declared state is one of the three, and every entry carries a note', () => {
  for (const [source, row] of Object.entries(SOURCE_REGISTRY)) {
    assert.ok(SOURCE_STATES.includes(row.state), `${source}: unknown state ${row.state}`);
    assert.ok(row.note && row.note.trim().length > 0, `${source}: a declaration without a reason is not a declaration`);
  }
});

test('every scheduled-ingest SOURCE_KEY is declared scheduled — the registry cannot silently drop a live feed', async () => {
  // Guards the failure mode league named: a declared set that quietly loses an entry. If someone
  // adds a source to the scheduler and forgets this file, its silence would stop being meaningful.
  const src = await import('node:fs').then((fs) => fs.readFileSync('scripts/scheduled-ingest.js', 'utf8'));
  const keys = JSON.parse(src.match(/const SOURCE_KEYS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.ok(keys.length > 0, 'SOURCE_KEYS could not be parsed — this guard must not silently pass');
  for (const k of keys) {
    assert.equal(sourceState(k).state, 'scheduled', `${k} is in SOURCE_KEYS but not declared scheduled`);
  }
});
