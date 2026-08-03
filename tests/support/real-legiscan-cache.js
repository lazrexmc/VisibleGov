import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { listCachedDatasetFiles } from '../../src/cli/backfill-nicknames.js';

// Senior engineering audit (2026-08-03, finding 15): four backfill test files
// (backfill-mo-bill-meta-cli, backfill-mo-bill-texts, backfill-mo-terms, backfill-nicknames-cli)
// read real cached LegiScan dataset ZIPs directly off disk from this directory — gitignored,
// weekly-mutating (a prior live ingest-legiscan.js sweep populates it), and therefore ABSENT on a
// genuinely fresh clone. A fresh-clone simulation found 12 failures across these files: not honest
// skips, but confusing downstream assertion failures (e.g. readCachedDatasetBills(undefined)) once
// listCachedDatasetFiles(...).filter(...)[0] came back undefined with no guard.
export const REAL_LEGISCAN_CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';

// Returns the exact cached file path matching `fragment` (e.g. '1608-' for session 1608), or null
// if the real cache doesn't have it — including the whole-directory-missing fresh-clone case,
// which listCachedDatasetFiles already reports as [] (see backfill-nicknames-cli.test.js's own
// "does-not-exist" coverage of that). Throws on genuine ambiguity (more than one match) — that is
// a real bug in the fragment or the cache, never something to silently pick a winner from.
export function findRealCachedDatasetFile(fragment, dir = REAL_LEGISCAN_CACHE_DIR) {
  const files = listCachedDatasetFiles(dir).filter((f) => f.includes(fragment));
  if (files.length === 0) return null;
  if (files.length > 1) {
    throw new Error(`ambiguous: ${files.length} cached files match "${fragment}" in ${dir}: ${files.join(', ')}`);
  }
  return files[0];
}

// The "gate" half of the fix (manifest/floor): a whole-directory-missing cache (fresh clone) is
// the expected, silent-skip case every findRealCachedDatasetFile call already handles per-test.
// This is the OTHER case — the directory exists (this is a real dev machine with SOME cache) but
// is missing one of the SPECIFIC files a file's own tests need. That is not a fresh clone; it is a
// pruned/corrupted/renamed cache, and letting every dependent test quietly skip would let this
// whole file's real-fixture coverage silently erode to zero with nothing ever failing loudly.
// Call once per test file, passing that file's own list of required fragments.
export function assertCacheManifestConsistent(fragments, dir = REAL_LEGISCAN_CACHE_DIR) {
  if (!existsSync(dir)) return; // fresh clone — every findRealCachedDatasetFile call below will skip on its own
  const missing = fragments.filter((fragment) => listCachedDatasetFiles(dir).filter((f) => f.includes(fragment)).length === 0);
  assert.equal(
    missing.length,
    0,
    `${dir} exists but is missing expected dataset file(s) for: ${missing.join(', ')} — a `
      + 'partially-populated or pruned local cache is a real signal, not a fresh-clone skip; never '
      + 'let this drift to silent per-test skips',
  );
}
