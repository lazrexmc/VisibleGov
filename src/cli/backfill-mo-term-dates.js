import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getClient, openRun, closeRun, selectAll } from '../lib/db.js';
import { decodeDatasetZip, extractDatasetFiles } from '../adapters/legiscan-dataset.js';
import { mapLegiscanChamber } from '../adapters/legiscan-votes.js';
import { listCachedDatasetFiles } from './backfill-nicknames.js';

const CACHE_DIR = '.superpowers/artifacts/legiscan-datasets';
const ROSTER_CACHE_DIR = '.superpowers/artifacts/openstates-people/mo-legislature';
const SOURCE = 'backfill-mo-term-dates';
const MO_JURISDICTION = 'mo-legislature';

const TYPE_CHAMBER = { lower: 'house', upper: 'senate' };

export function parsePersonYaml(text) {
  const p = parseYaml(text);
  const roles = [];
  for (const r of p.roles ?? []) {
    const chamber = TYPE_CHAMBER[r.type];
    if (!chamber) continue;
    roles.push({
      chamber,
      district: r.district != null ? String(r.district) : null,
      start_date: r.start_date != null ? String(r.start_date) : null,
      end_date: r.end_date != null ? String(r.end_date) : null,
    });
  }
  return {
    openstates_id: p.id,
    full_name: p.name,
    family_name: p.family_name ?? null,
    party: p.party?.[0]?.name ?? null,
    roles,
  };
}

export function loadCachedRoster(cacheDir = ROSTER_CACHE_DIR, {
  readdirFn = readdirSync, readFileFn = readFileSync,
} = {}) {
  let files;
  try { files = readdirFn(cacheDir); } catch {
    throw new Error(`backfill-mo-term-dates: openstates-people cache missing at ${cacheDir} — run the Task 1 cache step first`);
  }
  const ymls = files.filter((f) => f.endsWith('.yml')).sort();
  if (ymls.length === 0) {
    throw new Error(`backfill-mo-term-dates: openstates-people cache empty at ${cacheDir}`);
  }
  return ymls.map((f) => parsePersonYaml(readFileFn(join(cacheDir, f), 'utf8')));
}

export async function readCachedDatasetFull(filePath, { readFileFn = readFileSync } = {}) {
  let raw;
  try { raw = readFileFn(filePath, 'utf8'); } catch { return { ok: false, filePath }; }
  let envelope;
  try { envelope = JSON.parse(raw); } catch { return { ok: false, filePath }; }
  try {
    const zipBuffer = decodeDatasetZip(envelope.zip);
    const parsed = await extractDatasetFiles(zipBuffer);
    return {
      ok: true,
      filePath,
      sessionId: envelope.session_id,
      yearStart: envelope.year_start,
      people: parsed.people ?? [],
      rollCalls: parsed.rollCalls ?? [],
    };
  } catch { return { ok: false, filePath }; }
}
