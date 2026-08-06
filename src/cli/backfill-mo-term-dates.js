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

export function buildLegiscanPresenceIndex(sessions) {
  const index = new Map();
  const ensure = (peopleId) => {
    let entry = index.get(peopleId);
    if (!entry) {
      entry = { presenceYears: new Set(), chamberVoteYears: { house: new Set(), senate: new Set() } };
      index.set(peopleId, entry);
    }
    return entry;
  };
  for (const session of sessions) {
    const year = session.yearStart;
    for (const person of session.people ?? []) {
      if (person.people_id != null) ensure(person.people_id).presenceYears.add(year);
    }
    for (const rc of session.rollCalls ?? []) {
      let chamber;
      try { chamber = mapLegiscanChamber(rc.chamber); } catch { continue; } // unknown chamber code -> skip
      for (const vote of rc.votes ?? []) {
        if (vote.people_id != null) ensure(vote.people_id).chamberVoteYears[chamber].add(year);
      }
    }
  }
  return index;
}

export function earliestLegiscanYear(index, peopleId, chamber) {
  const entry = index.get(peopleId);
  if (!entry) return null;
  const voteYears = entry.chamberVoteYears[chamber];
  if (voteYears && voteYears.size > 0) return Math.min(...voteYears);
  if (entry.presenceYears.size > 0) return Math.min(...entry.presenceYears);
  return null;
}

export function lastNameOf(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

export function matchRoster(datelessTerms, rosterPeople) {
  // index roster roles by chamber|district -> { person, role } — OPEN roles only:
  // an ended role (Schnelting's old House seat) must never claim the seat's current term
  const bySeat = new Map();
  for (const person of rosterPeople) {
    for (const role of person.roles ?? []) {
      if (!role.chamber || role.district == null) continue;
      if (role.end_date != null) continue;
      bySeat.set(`${role.chamber}|${String(role.district)}`, { person, role });
    }
  }
  const matches = [];
  const unmatchedTerms = [];
  for (const term of datelessTerms) {
    const hit = bySeat.get(`${term.chamber}|${String(term.district)}`);
    if (!hit) { unmatchedTerms.push(term); continue; }
    const personSurname = (hit.person.family_name ?? lastNameOf(hit.person.full_name) ?? '').toLowerCase();
    matches.push({
      term,
      openStatesId: hit.person.openstates_id,
      startDate: hit.role.start_date ?? null,
      surnameOk: !!term.surname && personSurname === String(term.surname).toLowerCase(),
    });
  }
  return { matches, unmatchedTerms };
}

export function reconcile({ startDate, legiscanYear, surnameOk }) {
  if (!startDate) return { verdict: 'flag', reason: 'no-openstates-date' };
  if (!surnameOk) return { verdict: 'flag', reason: 'surname-mismatch' };
  if (legiscanYear == null) return { verdict: 'flag', reason: 'no-legiscan-year' };
  if (Number(String(startDate).slice(0, 4)) !== legiscanYear) return { verdict: 'flag', reason: 'year-mismatch' };
  return { verdict: 'agree', reason: null };
}

export function parseArgs(argv) {
  const out = { apply: false, overridesPath: null };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--apply') { out.apply = true; i += 1; continue; }
    if (key === '--apply-overrides') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--apply-overrides requires a file path');
      out.overridesPath = value;
      i += 2;
      continue;
    }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

export async function loadDatelessMoTerms(client) {
  const { data, error } = await selectAll(client, 'terms', 'id,legislator_id,jurisdiction_id,chamber,district,start_date');
  if (error) throw new Error(`backfill-mo-term-dates: terms load failed: ${error.message}`);
  return data
    .filter((t) => t.jurisdiction_id === MO_JURISDICTION && t.start_date == null)
    .map((t) => ({ termId: t.id, legislatorId: t.legislator_id, chamber: t.chamber, district: t.district }));
}

export async function loadLegislatorLookup(client) {
  const { data, error } = await selectAll(client, 'legislators', 'id,full_name,surname,legiscan_people_id');
  if (error) throw new Error(`backfill-mo-term-dates: legislators load failed: ${error.message}`);
  const map = new Map();
  for (const row of data) {
    map.set(row.id, { surname: row.surname ?? lastNameOf(row.full_name), legiscanPeopleId: row.legiscan_people_id ?? null });
  }
  return map;
}

export function loadRosterManifest({ readFileFn = readFileSync } = {}) {
  try {
    const m = JSON.parse(readFileFn('.superpowers/artifacts/openstates-people/manifest.json', 'utf8'));
    return { commit: m.commit ?? null, retrieved: m.retrieved ?? null };
  } catch {
    return { commit: null, retrieved: null };
  }
}

export async function loadLegiscanPresenceIndex(cacheDir = CACHE_DIR, {
  listFilesFn = listCachedDatasetFiles, readFullFn = readCachedDatasetFull,
} = {}) {
  const sessions = [];
  for (const filePath of listFilesFn(cacheDir)) {
    // eslint-disable-next-line no-await-in-loop -- one-time index build over ~32 cached files
    const decoded = await readFullFn(filePath);
    if (decoded.ok) sessions.push({ yearStart: decoded.yearStart, people: decoded.people, rollCalls: decoded.rollCalls });
  }
  return buildLegiscanPresenceIndex(sessions);
}

export function citationString({ openStatesId, startDate, legiscanYear, chamber, sourceCommit }) {
  return `openstates/people@${sourceCommit ?? 'unknown'} (CC0-1.0) data/mo/legislature `
    + `id=${openStatesId} roles[open].start_date=${startDate}; `
    + `verified-against legiscan-dataset earliest-qualifying-year=${legiscanYear} `
    + `[people[] presence + roll_call.chamber=${chamber === 'senate' ? 'S' : 'H'}]`;
}

export async function updateTermStartDate(client, runId, { termId, startDate }) {
  const { data, error } = await client
    .from('terms')
    .update({ start_date: startDate, run_id: runId }) // end_date intentionally absent — never touched
    .eq('id', termId)
    .is('start_date', null)
    .select('id');
  if (error) throw new Error(`backfill-mo-term-dates: start_date patch failed for terms.id=${termId}: ${error.message}`);
  return { written: !!(data && data.length > 0) };
}

function emptyCounts() {
  return { termsSeen: 0, matched: 0, agreed: 0, written: 0, unmatched: 0, flagged: 0 };
}

export async function runBackfillMoTermDates(client, {
  apply = false, runId = null, cacheDir = CACHE_DIR, rosterCacheDir = ROSTER_CACHE_DIR,
  loadTermsFn = loadDatelessMoTerms,
  loadLegislatorsFn = loadLegislatorLookup,
  loadRosterFn = loadCachedRoster,
  loadManifestFn = loadRosterManifest,
  loadPresenceIndexFn = loadLegiscanPresenceIndex,
  updateTermFn = updateTermStartDate,
} = {}) {
  const counts = emptyCounts();
  const plan = [];
  const flags = [];
  const citations = [];

  const rawTerms = await loadTermsFn(client);
  const legislators = await loadLegislatorsFn(client);
  counts.termsSeen = rawTerms.length;

  const datelessTerms = rawTerms.map((t) => {
    const leg = legislators.get(t.legislatorId) ?? {};
    return { ...t, surname: leg.surname ?? null, legiscanPeopleId: leg.legiscanPeopleId ?? null };
  });

  const rosterPeople = await loadRosterFn(rosterCacheDir);
  const { commit: sourceCommit } = loadManifestFn();
  if (apply && !sourceCommit) {
    throw new Error('backfill-mo-term-dates: openstates-people manifest missing/unreadable — refusing to apply without a source commit SHA for citations');
  }
  const presenceIndex = await loadPresenceIndexFn(cacheDir);

  const { matches, unmatchedTerms } = matchRoster(datelessTerms, rosterPeople);
  counts.matched = matches.length;
  for (const t of unmatchedTerms) {
    counts.unmatched += 1;
    flags.push({ termId: t.termId, surname: t.surname, chamber: t.chamber, district: t.district, reason: 'unmatched' });
  }

  for (const m of matches) {
    const legiscanYear = earliestLegiscanYear(presenceIndex, m.term.legiscanPeopleId, m.term.chamber);
    const { verdict, reason } = reconcile({ startDate: m.startDate, legiscanYear, surnameOk: m.surnameOk });
    if (verdict === 'flag') {
      flags.push({ termId: m.term.termId, surname: m.term.surname, chamber: m.term.chamber,
        district: m.term.district, startDate: m.startDate, legiscanYear, reason });
      continue;
    }
    counts.agreed += 1;
    const citation = citationString({ openStatesId: m.openStatesId, startDate: m.startDate, legiscanYear, chamber: m.term.chamber, sourceCommit });
    if (!apply) {
      plan.push({ termId: m.term.termId, surname: m.term.surname, chamber: m.term.chamber,
        district: m.term.district, startDate: m.startDate, legiscanYear, citation });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- sequential writes, ~185 rows
    const res = await updateTermFn(client, runId, { termId: m.term.termId, startDate: m.startDate });
    if (res.written) {
      counts.written += 1;
      citations.push({ termId: m.term.termId, startDate: m.startDate, citation });
    }
  }
  counts.flagged = flags.length;
  return { mode: apply ? 'live' : 'dry-run', counts, plan, flags, citations };
}

// A human-adjudicated overrides file resolves flagged terms the automatic gate would never write.
// Shape: { ruling, rulingDate, entries: [{ termId, startDate, citation, ... }] } — the ruling text
// and per-entry citations land verbatim in ingestion_runs.detail so the human decision is auditable.
export function loadAdjudicationFile(filePath, { readFileFn = readFileSync } = {}) {
  const parsed = JSON.parse(readFileFn(filePath, 'utf8'));
  if (typeof parsed.ruling !== 'string' || parsed.ruling.trim() === '') {
    throw new Error(`backfill-mo-term-dates: adjudication file ${filePath} is missing its ruling text`);
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error(`backfill-mo-term-dates: adjudication file ${filePath} has no entries`);
  }
  for (const entry of parsed.entries) {
    const dateOk = typeof entry.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.startDate);
    if (!entry.termId || !dateOk || !entry.citation) {
      throw new Error(`backfill-mo-term-dates: invalid adjudication entry ${JSON.stringify(entry)} — termId, ISO startDate, and citation are all required`);
    }
  }
  return parsed;
}

export async function runApplyOverrides(client, {
  overrides, apply = false, runId = null, updateTermFn = updateTermStartDate,
} = {}) {
  const counts = { entries: overrides.entries.length, written: 0, skippedAlreadyDated: 0 };
  const plan = [];
  const citations = [];
  for (const entry of overrides.entries) {
    if (!apply) {
      plan.push({ termId: entry.termId, surname: entry.surname, chamber: entry.chamber,
        district: entry.district, startDate: entry.startDate, citation: entry.citation });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- sequential writes, ~21 adjudicated rows
    const res = await updateTermFn(client, runId, { termId: entry.termId, startDate: entry.startDate });
    if (res.written) {
      counts.written += 1;
      citations.push({ termId: entry.termId, startDate: entry.startDate, citation: entry.citation });
    } else {
      counts.skippedAlreadyDated += 1;
    }
  }
  return { mode: apply ? 'live' : 'dry-run', counts, plan: apply ? undefined : plan, citations };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (args.overridesPath) {
    const overrides = loadAdjudicationFile(args.overridesPath);
    if (!args.apply) {
      const report = await runApplyOverrides(client, { overrides, apply: false });
      console.log(JSON.stringify({ source: `${SOURCE}-overrides`, ruling: overrides.ruling, ...report }, null, 2));
      return;
    }
    const runId = await openRun(client, `${SOURCE}-overrides`);
    try {
      const report = await runApplyOverrides(client, { overrides, apply: true, runId });
      await closeRun(client, runId, 'succeeded', { ruling: overrides.ruling, rulingDate: overrides.rulingDate ?? null, counts: report.counts, citations: report.citations });
      console.log(JSON.stringify({ source: `${SOURCE}-overrides`, run_id: runId, ruling: overrides.ruling, ...report }, null, 2));
    } catch (err) {
      await closeRun(client, runId, 'failed', { error: String(err) });
      throw err;
    }
    return;
  }
  if (!args.apply) {
    const report = await runBackfillMoTermDates(client, { apply: false });
    console.log(JSON.stringify({ source: SOURCE, ...report }, null, 2));
    return;
  }
  const runId = await openRun(client, SOURCE);
  try {
    const report = await runBackfillMoTermDates(client, { apply: true, runId });
    await closeRun(client, runId, 'succeeded', { counts: report.counts, citations: report.citations, flags: report.flags });
    console.log(JSON.stringify({ source: SOURCE, run_id: runId, ...report }, null, 2));
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
