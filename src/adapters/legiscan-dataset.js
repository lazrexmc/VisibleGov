import yauzl from 'yauzl';
import path from 'node:path';

// LegiScan bulk adapter — dataset ZIP parser (Task 4 of docs/superpowers/plans/2026-07-29-legiscan-
// bulk-adapter.md). legiscan.js's getDataset() returns the raw envelope with `dataset.zip` still
// Base64-encoded (by design — see that file's own header comment); THIS module owns the production
// decode from that point on: Base64 -> Buffer (decodeDatasetZip), then ZIP entries -> typed
// bill/person/roll-call records (extractDatasetFiles). Two CONTROLLER RULINGS from Task 3's review
// (task-4-brief.md) are binding on this file:
//   1. extraction MUST harden against path traversal (an entry named e.g. '../../evil' must never
//      escape the logical dataset root) — enforced below in assertSafeEntryPath, which THIS module
//      calls itself on every entry (see that function's own comment for why it doesn't just lean on
//      yauzl's own default check).
//   2. dataset_hash equals the IN-ARCHIVE hash.md5 file's CONTENT, not md5(raw zip bytes) —
//      extractDatasetFiles exposes that content verbatim as `datasetHash` so Task 9's post-fetch
//      re-compare can use it without re-deriving anything.
// Skip≠empty (Global Constraints #3): a malformed bill/people/vote entry (bad JSON, or JSON missing
// its documented wrapper key) is a typed, counted failure in the returned `failures[]` array, never
// a silent drop — but an archive-level problem (won't open at all, or a read fails mid-stream) is
// NOT recoverable per-entry and throws DatasetParseError instead, discarding everything gathered so
// far (never returns partial data silently) — see the two try/catch layers below for exactly where
// that line is drawn.

export class DatasetParseError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DatasetParseError';
    Object.assign(this, meta);
  }
}

// decodeDatasetZip — the one place getDataset's still-Base64 `dataset.zip` field becomes real
// bytes. Deliberately does NOT attempt to validate ZIP structure here (that requires actually
// opening it, which is extractDatasetFiles's job) — only guards against an obviously-unusable input
// (missing/empty), since Buffer.from(..., 'base64') never throws on its own (it silently drops
// invalid characters), which would otherwise let a garbage input become a garbage 0-length Buffer.
export function decodeDatasetZip(base64Zip) {
  if (typeof base64Zip !== 'string' || base64Zip.length === 0) {
    throw new DatasetParseError('decodeDatasetZip: base64Zip must be a non-empty string', {
      reason: 'empty_input',
    });
  }
  return Buffer.from(base64Zip, 'base64');
}

// assertSafeEntryPath — CONTROLLER RULING 1 (task-4-brief.md, from Task 3's review): "an entry
// named ../../evil never escapes the target dir". This module never writes extracted bytes to
// disk (extractDatasetFiles returns in-memory arrays only, no filesystem writes at all) — the
// containment check still belongs here because THIS is the module that "OWNS the production
// decode", so the guarantee must live here, not depend on some future caller remembering to
// sandbox path.join calls downstream.
//
// DELIBERATELY NOT relying on yauzl's own default (decodeStrings:true) automatic validateFileName
// check: that check runs INSIDE yauzl's own central-directory parsing, before our code ever sees
// the entry, which means on a hit it surfaces as yauzl's own generic Error (not a DatasetParseError,
// and not distinguishable from "the archive is merely corrupted") — this task's typed-error
// contract requires OUR code to be the one making (and owning) the safety decision, not a
// dependency default we merely benefit from. extractDatasetFiles below opens with
// `{ decodeStrings: false }` for exactly this reason (see its own comment) and decodes each entry's
// fileName itself via yauzl.getFileNameLowLevel — the README's own words: "This method of getting
// the file name bypasses the security checks in validateFileName(). You should call that function
// yourself to be sure to guard against malicious file paths." — which is exactly what this function
// does, plus an independent containment check as belt-and-suspenders.
const DATASET_ROOT = path.resolve('/__legiscan_dataset_root__');

function assertSafeEntryPath(fileName) {
  const yauzlMessage = yauzl.validateFileName(fileName);
  if (yauzlMessage != null) {
    throw new DatasetParseError(
      `unsafe zip entry path: ${fileName} (${yauzlMessage})`,
      { reason: 'unsafe_entry_path', entryName: fileName },
    );
  }
  const resolved = path.resolve(DATASET_ROOT, fileName);
  if (resolved !== DATASET_ROOT && !resolved.startsWith(DATASET_ROOT + path.sep)) {
    throw new DatasetParseError(
      `zip entry escapes the dataset root: ${fileName}`,
      { reason: 'unsafe_entry_path', entryName: fileName },
    );
  }
}

async function readEntryBuffer(zipfile, entry) {
  const stream = await zipfile.openReadStreamPromise(entry);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// DATA_DIRS — the real internal layout (Task 3's fixture + the archive's own bundled README.md,
// both fixture-verified): STATE/SESSION/{bill,people,vote}/*.json. CONTROLLER RULING 3 (wrapper
// traps, fixture-verified on both 1579 and 1608): the directory name and the top-level JSON wrapper
// key are NOT always the same word — bill/ wraps 'bill' (matches), but people/ wraps the SINGULAR
// 'person' (not 'people'), and vote/ wraps 'roll_call' (a different noun entirely, matching the
// archive's own README: "The JSON payload from the getRollcall API hook"). Keyed by directory name
// (the on-disk grouping) with each entry naming its own array key and its own wrapper key
// separately, specifically so this asymmetry can never be papered over by a single shared name.
const DATA_DIRS = {
  bill: { arrayKey: 'bills', wrapperKey: 'bill' },
  people: { arrayKey: 'people', wrapperKey: 'person' },
  vote: { arrayKey: 'rollCalls', wrapperKey: 'roll_call' },
};

// extractDatasetFiles(zipBuffer) -> { bills, people, rollCalls, datasetHash, failures }
//   - bills/people/rollCalls: unwrapped record objects, verbatim field names (no house-style
//     renaming at this layer — same "fixture is the source of truth" convention legiscan.js's own
//     checkStatus comment documents for the live API shapes).
//   - datasetHash: the in-archive hash.md5 file's content, trimmed (CONTROLLER RULING 2) — null if
//     the archive had no hash.md5 entry at all (never observed in either real fixture, but a
//     malformed/hand-built archive could omit it; that is NOT treated as fatal on its own since the
//     bill/people/vote data is still usable without it).
//   - failures: DatasetParseError instances for individual malformed bill/people/vote entries (bad
//     JSON, or JSON missing its documented wrapper key) — skip≠empty, these are counted, never
//     silently dropped, and never abort the rest of the archive.
// Archive-level problems (won't open at all — corrupted/truncated; or a read fails mid-stream; or
// ANY entry's path is unsafe, see assertSafeEntryPath) throw DatasetParseError directly and return
// nothing — never a partial bills/people/rollCalls result.
export async function extractDatasetFiles(zipBuffer) {
  let zipfile;
  try {
    // decodeStrings:false — see assertSafeEntryPath's comment: this module decodes and validates
    // each entry's fileName itself (via yauzl.getFileNameLowLevel + assertSafeEntryPath below)
    // rather than relying on yauzl's own automatic-but-implicit default check, so a rejection is
    // always OUR typed DatasetParseError (reason: 'unsafe_entry_path'), never a bare dependency
    // error indistinguishable from ordinary corruption.
    zipfile = await yauzl.fromBufferPromise(zipBuffer, { decodeStrings: false });
  } catch (cause) {
    throw new DatasetParseError(
      `extractDatasetFiles: could not open ZIP (corrupted or truncated): ${cause.message}`,
      { reason: 'invalid_zip', cause },
    );
  }

  const bills = [];
  const people = [];
  const rollCalls = [];
  const failures = [];
  const arrays = { bills, people, rollCalls };
  let datasetHash = null;

  try {
    for await (const entry of zipfile.eachEntry()) {
      const fileName = yauzl.getFileNameLowLevel(
        entry.generalPurposeBitFlag,
        entry.fileNameRaw,
        entry.extraFields,
        /* strictFileNames */ false,
      );
      assertSafeEntryPath(fileName); // fatal on failure — an unsafe entry taints the whole archive

      if (fileName.endsWith('/')) continue; // directory entry (optional in the spec), no content

      const segments = fileName.split('/');
      const baseName = segments[segments.length - 1];
      const dirName = segments.length >= 2 ? segments[segments.length - 2] : null;

      if (baseName === 'hash.md5') {
        const buf = await readEntryBuffer(zipfile, entry);
        datasetHash = buf.toString('utf8').trim();
        continue;
      }

      const dataDir = DATA_DIRS[dirName];
      if (!dataDir) continue; // LICENSE, README.md, anything else non-data — skip, not a failure

      const buf = await readEntryBuffer(zipfile, entry);
      let parsed;
      try {
        parsed = JSON.parse(buf.toString('utf8'));
      } catch (cause) {
        failures.push(new DatasetParseError(
          `malformed JSON in ${fileName}: ${cause.message}`,
          { reason: 'invalid_json', entryName: fileName, cause },
        ));
        continue;
      }

      const record = parsed?.[dataDir.wrapperKey];
      if (record === undefined) {
        failures.push(new DatasetParseError(
          `${fileName}: missing expected "${dataDir.wrapperKey}" wrapper key`,
          { reason: 'missing_wrapper_key', entryName: fileName, wrapperKey: dataDir.wrapperKey },
        ));
        continue;
      }

      arrays[dataDir.arrayKey].push(record);
    }
  } catch (err) {
    if (err instanceof DatasetParseError) throw err;
    throw new DatasetParseError(
      `extractDatasetFiles: ZIP read failed (corrupted archive or unsafe entry): ${err.message}`,
      { reason: 'zip_read_failed', cause: err },
    );
  }

  return {
    bills, people, rollCalls, datasetHash, failures,
  };
}

// normalizeBillIdentifier — LegiScan's own bill_number field has no space and no zero-padding
// ('SB894', 'HB1', 'HCR1' — verified against every bill/*.json in both real fixtures). Must match
// mo-senate-journal-pdf.js's own normalized bill-identifier format EXACTLY: that adapter builds
// identifiers inline as `${type} ${n}` in its extractBillRefs (src/adapters/mo-senate-journal-
// pdf.js) — tests/legiscan-dataset.test.js cross-checks against that file's real output, not just
// internal self-consistency, per task-4-brief.md's explicit ask. Same `TYPE NNN` shape
// src/adapters/us-congress.js's own normalizeBillIdentifier produces for US Congress bills, but
// that function requires whitespace between the letters and digits in its input (`\s+` in its
// regex) and so does not itself handle LegiScan's no-space 'SB894' form — this is a sibling
// function, not a duplicate, tuned for this source's real input shape.
export function normalizeBillIdentifier(billNumber) {
  const s = String(billNumber).trim().toUpperCase();
  const m = s.match(/^([A-Z]+)\s*(\d+)$/);
  if (!m) return s;
  return `${m[1]} ${m[2]}`;
}
