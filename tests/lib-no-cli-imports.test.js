import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as libDurableCooldown from '../src/lib/durable-cooldown.js';
import * as libMoStatusCodes from '../src/lib/mo-status-codes.js';
import * as libPdfBasename from '../src/lib/pdf-basename.js';
import * as cliMoHouse from '../src/cli/ingest-mo-house.js';
import * as cliMoSenate from '../src/cli/ingest-mo-senate.js';
import * as cliIngestLegiscan from '../src/cli/ingest-legiscan.js';
import * as cliCorrectData from '../src/cli/correct-data.js';

// Senior engineering audit (2026-08-03, finding 16): src/cli had a genuine 3-node import cycle
// (ingest-legiscan.js -> correct-data.js -> ingest-mo-senate.js -> ingest-legiscan.js) — safe only
// because every cyclic binding happened to be used inside function bodies rather than at module top
// level, but empirically demonstrated (via an exact-shape replica) to produce an entry-point-
// dependent TDZ crash the moment that stops being true. Fixed by promoting the shared bindings
// (mapMoStatusCode + its vocabulary, journalPdfBasename) to src/lib. This test is the structural
// guard: src/lib must never import FROM src/cli — the moment it does, the same cycle class can
// reappear silently, invisible to any test that only imports modules in the safe order.

const LIB_DIR = 'src/lib';

test('no file in src/lib imports from src/cli — the promotion that dissolved the 2026-08-03 import cycle must never regress', () => {
  const violations = [];
  for (const file of readdirSync(LIB_DIR)) {
    if (!file.endsWith('.js')) continue;
    const source = readFileSync(`${LIB_DIR}/${file}`, 'utf8');
    const importLines = source.match(/^import[^\n]*from\s*['"][^'"]*['"];?/gm) ?? [];
    for (const line of importLines) {
      if (/from\s*['"]\.\.\/cli\//.test(line)) violations.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(violations, []);
});

// Finding 17: ingest-mo-house.js and ingest-mo-senate.js used to carry byte-identical, independent
// COPIES of the ToU-cooldown trio and the read/write-JSON-cache mechanism — a fix applied to only
// one chamber's copy would silently not govern the other (and, for the cooldown trio, would not
// govern the production scheduler's own due-ness computation for any of the five registry sources
// at all, since it imports from one specific copy). Reference-identity (not just "produces the same
// output") is the actual guarantee this needs: two functions that happen to behave identically
// today can still drift tomorrow if they are two separate definitions.
test('ingest-mo-house.js and ingest-mo-senate.js re-export the SAME durable-cooldown trio object identities as src/lib — never independent copies', () => {
  assert.equal(cliMoHouse.remainingCooldownMs, libDurableCooldown.remainingCooldownMs);
  assert.equal(cliMoHouse.formatCooldownWait, libDurableCooldown.formatCooldownWait);
  assert.equal(cliMoHouse.CooldownConvergenceError, libDurableCooldown.CooldownConvergenceError);
  assert.equal(cliMoSenate.remainingCooldownMs, libDurableCooldown.remainingCooldownMs);
  assert.equal(cliMoSenate.formatCooldownWait, libDurableCooldown.formatCooldownWait);
  assert.equal(cliMoSenate.CooldownConvergenceError, libDurableCooldown.CooldownConvergenceError);
});

test('mapMoStatusCode/journalPdfBasename: every re-exporting CLI file points at the SAME src/lib function identity, never a second copy', () => {
  // correct-data.js is the only re-exporter of mapMoStatusCode (ingest-legiscan.js and
  // backfill-mo-bill-meta.js import it directly from src/lib now, never re-export it) — importing
  // ingest-legiscan.js here at all is still worthwhile: it proves the module loads cleanly with its
  // new direct src/lib import, the exact edge that used to be part of the 3-node cycle.
  assert.equal(cliCorrectData.mapMoStatusCode, libMoStatusCodes.mapMoStatusCode);
  assert.equal(typeof cliIngestLegiscan, 'object');
  // correct-data.js imports journalPdfBasename privately (internal use only, never re-exported) —
  // only ingest-mo-senate.js re-exports it as part of its own public contract.
  assert.equal(cliMoSenate.journalPdfBasename, libPdfBasename.journalPdfBasename);
});
