import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeDatasetZip, extractDatasetFiles, normalizeBillIdentifier, DatasetParseError,
} from '../src/adapters/legiscan-dataset.js';
import { extractBillRefs } from '../src/adapters/mo-senate-journal-pdf.js';

const FIXDIR = 'tests/fixtures/research/legiscan';

// Both real fixtures per task-4-brief.md / CONTROLLER RULING 4: 1579 (2018 1st Extraordinary
// Session) proves the ZERO-votes path (empty vote/ dir, honest empty rollCalls, no crash, nothing
// fabricated); 1608 (2018 2nd Extraordinary Session) proves real roll calls (8 vote/ files, 189
// people/ files) with a field set matching the standalone getRollCall API fixture.
const envelope1579 = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-dataset.json`, 'utf8'));
const envelope1608 = JSON.parse(readFileSync(`${FIXDIR}/mo-2018-dataset-1608.json`, 'utf8'));

const zip1579 = decodeDatasetZip(envelope1579.dataset.zip);
const zip1608 = decodeDatasetZip(envelope1608.dataset.zip);

const dataset1579 = await extractDatasetFiles(zip1579);
const dataset1608 = await extractDatasetFiles(zip1608);

// ---- minimal in-memory ZIP builder (STORED/uncompressed entries only) — used ONLY to construct
// synthetic malicious/malformed archives for the tests below; the real fixtures are deliberately
// clean (task-4-brief.md CONTROLLER RULING 1: "the real fixtures are clean — the test must not
// depend on them being malicious"). No new dependency: yazl (yauzl's own sibling writer) was never
// approved, so this hand-rolls the well-documented PKZIP local/central/EOCD records directly, using
// node:zlib's built-in crc32 (Node 20+) for correct CRC-32 values on non-empty entries. ----
function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, nameBuf, data]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    const centralEntry = Buffer.concat([central, nameBuf]);
    centralParts.push(centralEntry);

    offset += localEntry.length;
  }
  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localSection, centralSection, eocd]);
}

// ---- decodeDatasetZip ----

test('decodeDatasetZip: Base64 dataset.zip decodes to a Buffer of exactly dataset_size bytes (both real envelopes)', () => {
  assert.ok(Buffer.isBuffer(zip1579));
  assert.equal(zip1579.length, envelope1579.dataset.dataset_size);
  assert.equal(zip1579.length, 25039);

  assert.ok(Buffer.isBuffer(zip1608));
  assert.equal(zip1608.length, envelope1608.dataset.dataset_size);
  assert.equal(zip1608.length, 105793);
});

test('decodeDatasetZip: throws DatasetParseError on empty/non-string input rather than silently returning a 0-length Buffer', () => {
  assert.throws(() => decodeDatasetZip(''), DatasetParseError);
  assert.throws(() => decodeDatasetZip(null), DatasetParseError);
  assert.throws(() => decodeDatasetZip(undefined), DatasetParseError);
});

// ---- extractDatasetFiles: real fixture 1579 (session 1579, ZERO votes) ----

test('extractDatasetFiles (1579): recovers the REAL bill/people/rollCall counts — 18 bills, 3 people, 0 roll calls', () => {
  assert.equal(dataset1579.bills.length, 18);
  assert.equal(dataset1579.people.length, 3);
  assert.equal(dataset1579.rollCalls.length, 0);
  assert.equal(dataset1579.failures.length, 0);
});

test('extractDatasetFiles (1579): empty vote/ dir parses honestly — [] rollCalls, no crash, nothing fabricated', () => {
  assert.deepEqual(dataset1579.rollCalls, []);
});

test('extractDatasetFiles (1579): datasetHash is the in-archive hash.md5 CONTENT (CONTROLLER RULING 2), matching dataset.dataset_hash from the envelope — NOT md5 of the raw zip bytes', () => {
  assert.equal(dataset1579.datasetHash, '196f5cb2b665116489beb1da7df8f982');
  assert.equal(dataset1579.datasetHash, envelope1579.dataset.dataset_hash);
});

test('extractDatasetFiles (1579): sample bill record (HB1) — verbatim getBill shape, bill/ wraps "bill" (matches directory name)', () => {
  const hb1 = dataset1579.bills.find((b) => b.bill_number === 'HB1');
  assert.ok(hb1, 'HB1 must be present');
  assert.equal(hb1.bill_id, 1126419);
  assert.equal(hb1.session_id, 1579);
  assert.equal(hb1.state, 'MO');
  assert.equal(hb1.sponsors.length, 1);
  assert.equal(hb1.sponsors[0].people_id, 14179);
  assert.equal(hb1.sponsors[0].name, 'Scott Fitzpatrick');
  assert.deepEqual(hb1.votes, []);
});

test('extractDatasetFiles (1579): sample person record — people/ wraps SINGULAR "person" (CONTROLLER RULING 3 wrapper trap), not the plural directory name', () => {
  const ids = dataset1579.people.map((p) => p.people_id).sort((a, b) => a - b);
  assert.deepEqual(ids, [12941, 14179, 16895]);
  const fitzpatrick = dataset1579.people.find((p) => p.people_id === 14179);
  assert.equal(fitzpatrick.name, 'Scott Fitzpatrick');
  assert.equal(fitzpatrick.district, 'HD-158');
});

// ---- extractDatasetFiles: real fixture 1608 (session 1608, real roll calls) ----

test('extractDatasetFiles (1608): recovers the REAL bill/people/rollCall counts — 9 bills, 189 people, 8 roll calls', () => {
  assert.equal(dataset1608.bills.length, 9);
  assert.equal(dataset1608.people.length, 189);
  assert.equal(dataset1608.rollCalls.length, 8);
  assert.equal(dataset1608.failures.length, 0);
});

test('extractDatasetFiles (1608): datasetHash matches the envelope\'s dataset_hash, byte-for-byte', () => {
  assert.equal(dataset1608.datasetHash, 'f07c2e26578db9db7daa683cfa054190');
  assert.equal(dataset1608.datasetHash, envelope1608.dataset.dataset_hash);
});

test('extractDatasetFiles (1608): sample roll call record (774412) — vote/ wraps "roll_call" (CONTROLLER RULING 3 wrapper trap: a DIFFERENT noun than the directory name, not a singular/plural variant), field set matches the getRollCall API fixture', () => {
  const rc = dataset1608.rollCalls.find((r) => r.roll_call_id === 774412);
  assert.ok(rc, 'roll call 774412 must be present');
  assert.equal(rc.bill_id, 1126109);
  assert.equal(rc.date, '2018-09-14');
  assert.equal(rc.desc, 'Senate: Third Reading');
  assert.equal(rc.yea, 29);
  assert.equal(rc.nay, 0);
  assert.equal(rc.nv, 0);
  assert.equal(rc.absent, 4);
  assert.equal(rc.total, 33);
  assert.equal(rc.passed, 1);
  assert.equal(rc.chamber, 'S');
  assert.equal(rc.chamber_id, 60);
  assert.equal(rc.votes.length, 33);
  for (const v of rc.votes) {
    assert.equal(typeof v.people_id, 'number');
    assert.equal(typeof v.vote_id, 'number');
    assert.equal(typeof v.vote_text, 'string');
  }
  const yeaCount = rc.votes.filter((v) => v.vote_text === 'Yea').length;
  const absentCount = rc.votes.filter((v) => v.vote_text === 'Absent').length;
  assert.equal(yeaCount, 29);
  assert.equal(absentCount, 4);
});

test('extractDatasetFiles (1608): every roll call has the full field set (passed/nv/chamber/date) present, not just the sample', () => {
  for (const rc of dataset1608.rollCalls) {
    assert.equal(typeof rc.roll_call_id, 'number');
    assert.equal(typeof rc.bill_id, 'number');
    assert.equal(typeof rc.date, 'string');
    assert.equal(typeof rc.chamber, 'string');
    assert.ok(rc.passed === 0 || rc.passed === 1);
    assert.equal(typeof rc.nv, 'number');
    assert.ok(Array.isArray(rc.votes));
  }
});

// ---- skip≠empty: malformed entries are typed, counted failures — never silently dropped ----

test('extractDatasetFiles: a bill/ entry with the WRONG wrapper key (missing_wrapper_key) is counted in failures, not silently dropped or fatal to the rest of the archive', async () => {
  const zip = buildStoredZip([
    { name: 'MO/SESSION/bill/HB999.json', data: Buffer.from(JSON.stringify({ person: { foo: 1 } })) },
    { name: 'MO/SESSION/people/1.json', data: Buffer.from(JSON.stringify({ person: { people_id: 1 } })) },
  ]);
  const result = await extractDatasetFiles(zip);
  assert.equal(result.bills.length, 0);
  assert.equal(result.people.length, 1, 'the OTHER, well-formed entry must still be processed');
  assert.equal(result.failures.length, 1);
  assert.ok(result.failures[0] instanceof DatasetParseError);
  assert.equal(result.failures[0].reason, 'missing_wrapper_key');
  assert.equal(result.failures[0].entryName, 'MO/SESSION/bill/HB999.json');
  assert.equal(result.failures[0].wrapperKey, 'bill');
});

test('extractDatasetFiles: a vote/ entry with malformed JSON (invalid_json) is counted in failures, not silently dropped', async () => {
  const zip = buildStoredZip([
    { name: 'MO/SESSION/vote/12345.json', data: Buffer.from('not valid json{{{') },
  ]);
  const result = await extractDatasetFiles(zip);
  assert.equal(result.rollCalls.length, 0);
  assert.equal(result.failures.length, 1);
  assert.ok(result.failures[0] instanceof DatasetParseError);
  assert.equal(result.failures[0].reason, 'invalid_json');
  assert.equal(result.failures[0].entryName, 'MO/SESSION/vote/12345.json');
});

test('extractDatasetFiles: a people/ entry with the WRONG wrapper key ("people" instead of singular "person") is counted in failures — proves the wrapper-trap check is real, not merely internally consistent', async () => {
  const zip = buildStoredZip([
    { name: 'MO/SESSION/people/2.json', data: Buffer.from(JSON.stringify({ people: { people_id: 2 } })) },
  ]);
  const result = await extractDatasetFiles(zip);
  assert.equal(result.people.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reason, 'missing_wrapper_key');
  assert.equal(result.failures[0].wrapperKey, 'person');
});

test('extractDatasetFiles: non-data files (LICENSE, README.md) are skipped — no failure, no fabricated record', async () => {
  const zip = buildStoredZip([
    { name: 'MO/SESSION/LICENSE', data: Buffer.from('CC BY 4.0') },
    { name: 'MO/SESSION/README.md', data: Buffer.from('# LegiScan Public Datasets') },
  ]);
  const result = await extractDatasetFiles(zip);
  assert.equal(result.bills.length, 0);
  assert.equal(result.people.length, 0);
  assert.equal(result.rollCalls.length, 0);
  assert.equal(result.failures.length, 0);
  assert.equal(result.datasetHash, null);
});

// ---- path-traversal hardening (CONTROLLER RULING 1) — synthetic malicious entries; the real
// fixtures are clean by construction, so this cannot depend on them ----

test('extractDatasetFiles: a ZIP entry named "../../evil.json" throws DatasetParseError and never returns partial data — even when a legitimate entry precedes it in central-directory order', async () => {
  const zip = buildStoredZip([
    { name: 'MO/SESSION/bill/HB1.json', data: Buffer.from(JSON.stringify({ bill: { bill_number: 'HB1' } })) },
    { name: '../../evil.json', data: Buffer.alloc(0) },
  ]);
  await assert.rejects(
    () => extractDatasetFiles(zip),
    (err) => {
      assert.ok(err instanceof DatasetParseError);
      assert.equal(err.reason, 'unsafe_entry_path');
      return true;
    },
  );
});

test('extractDatasetFiles: an absolute-path ZIP entry ("/etc/passwd") throws DatasetParseError', async () => {
  const zip = buildStoredZip([
    { name: '/etc/passwd', data: Buffer.alloc(0) },
  ]);
  await assert.rejects(() => extractDatasetFiles(zip), DatasetParseError);
});

test('extractDatasetFiles: a backslash-drive-letter ZIP entry ("C:\\\\evil.json") throws DatasetParseError', async () => {
  const zip = buildStoredZip([
    { name: 'C:\\evil.json', data: Buffer.alloc(0) },
  ]);
  await assert.rejects(() => extractDatasetFiles(zip), DatasetParseError);
});

// ---- corrupted/truncated ZIP: fatal, never returns partial data ----

test('extractDatasetFiles: a truncated ZIP (real 1579 bytes cut short, no End Of Central Directory record) throws DatasetParseError', async () => {
  const truncated = zip1579.subarray(0, zip1579.length - 200);
  await assert.rejects(
    () => extractDatasetFiles(truncated),
    (err) => {
      assert.ok(err instanceof DatasetParseError);
      assert.equal(err.reason, 'invalid_zip');
      return true;
    },
  );
});

test('extractDatasetFiles: a completely non-ZIP buffer throws DatasetParseError, not a raw yauzl error', async () => {
  await assert.rejects(
    () => extractDatasetFiles(Buffer.from('this is not a zip file at all')),
    (err) => {
      assert.ok(err instanceof DatasetParseError);
      assert.equal(err.name, 'DatasetParseError');
      return true;
    },
  );
});

// ---- normalizeBillIdentifier ----

test('normalizeBillIdentifier: "SB894" -> "SB 894" (LegiScan\'s real no-space, no-zero-padding bill_number form)', () => {
  assert.equal(normalizeBillIdentifier('SB894'), 'SB 894');
});

test('normalizeBillIdentifier: handles every real bill type observed in the fixtures (HB, HR, HCR, SB, SR, SCR)', () => {
  assert.equal(normalizeBillIdentifier('HB1'), 'HB 1');
  assert.equal(normalizeBillIdentifier('HR2'), 'HR 2');
  assert.equal(normalizeBillIdentifier('HCR1'), 'HCR 1');
  assert.equal(normalizeBillIdentifier('SR15'), 'SR 15');
  assert.equal(normalizeBillIdentifier('SCR1'), 'SCR 1');
});

test('normalizeBillIdentifier: idempotent on an already-spaced identifier, and case-insensitive', () => {
  assert.equal(normalizeBillIdentifier('SB 894'), 'SB 894');
  assert.equal(normalizeBillIdentifier('sb894'), 'SB 894');
});

test('normalizeBillIdentifier: cross-checked against mo-senate-journal-pdf.js\'s OWN normalized output (not just internally consistent) — extractBillRefs\' inline `${type} ${n}` format for "SB 894" must equal this function\'s "SB894" output', () => {
  const [fromJournal] = extractBillRefs('SBs 894 was read the third time and passed.');
  assert.equal(fromJournal, 'SB 894');
  assert.equal(normalizeBillIdentifier('SB894'), fromJournal);
});

// ---- every bill/person/roll-call record from both real fixtures round-trips through JSON.parse
// cleanly (sanity: extraction never hands back a stringified/double-encoded record) ----

test('every extracted record (both fixtures) is a plain object, not a string or null', () => {
  for (const dataset of [dataset1579, dataset1608]) {
    for (const rec of [...dataset.bills, ...dataset.people, ...dataset.rollCalls]) {
      assert.equal(typeof rec, 'object');
      assert.ok(rec !== null);
    }
  }
});
