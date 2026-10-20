import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// EVERY shipped script must at least PARSE.
//
// WHY THIS EXISTS (2026-10-20). A one-character mistake - an unescaped apostrophe in
// `'... Lance's real queue'` - was committed into scripts/data-status.js, breaking
// `npm run status` completely. The full suite was run immediately before the commit and reported
// 2,847 pass / 0 fail, because NO TEST IMPORTS data-status.js. The suite was green and honest and
// said nothing whatsoever about the file that was broken.
//
// That is the real lesson, and it is not about apostrophes: a green suite is evidence only about
// the code the suite actually loads. `npm run status` is the instrument this project reaches for
// first when it wants a true number - CLAUDE.md tells every fresh session to run it - and it was
// the single least-tested file in the repo precisely because it only prints.
//
// Parsing is a deliberately low bar, chosen because it is the one check that can cover EVERY
// script without executing any of them. These files open database connections, read .env, submit
// billed batches and write to live tables; importing them to test them would be worse than not
// testing them. `node --check` compiles without running, so it is safe for all of them.
//
// Gated on the EXIT CODE of a direct spawn, not on piped output - the first attempt to verify
// this checker reported exit 0 for a file it had just rejected, because the exit code belonged to
// `head` at the end of a pipe. That is CLAUDE.md's standing rule about gating on a pipeline's
// status, caught live while building the guard against a different mistake.

const ROOTS = ['scripts', 'src', 'tests'];
const EXTS = new Set(['.js', '.mjs']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));

test('every .js/.mjs under scripts/, src/ and tests/ compiles', () => {
  assert.ok(files.length > 50, `expected to find many files, found ${files.length} — the walk is broken, and a walk that finds nothing would pass this test vacuously`);
  const broken = [];
  for (const f of files) {
    // --check COMPILES without EXECUTING. Importing these would open DB connections, read .env
    // and in some cases submit billed API batches.
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) broken.push(`${f}: ${String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown'}`);
  }
  assert.deepEqual(broken, [], `files that do not compile:\n  ${broken.join('\n  ')}`);
});

test('the parse check is load-bearing: it actually rejects a file with a syntax error', () => {
  // Without this, a --check that silently stopped working (a flag rename, a spawn failure
  // swallowed as status 0) would make the test above pass over a repo full of broken files.
  // An absence reported as health is the failure class this repo keeps hitting, so the detector
  // is tested against a known-bad input rather than trusted.
  const r = spawnSync(process.execPath, ['--check', '-'], { input: "console.log('it's broken');\n", encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'node --check accepted a syntax error — this guard is not working');
});

test('npm run status is covered by the walk, since that is the file this test was written for', () => {
  assert.ok(
    files.some((f) => f.endsWith(path.join('scripts', 'data-status.js'))),
    'data-status.js must be in the checked set',
  );
});
