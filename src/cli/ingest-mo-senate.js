import {
  existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import {
  getClient, openRun, closeRun, insertIfAbsent, isMissingColumnError, isMissingRelationError,
} from '../lib/db.js';
import { fetchWithLimit } from '../lib/http.js';
import { SourceFetchError } from '../lib/errors.js';
import * as senateWeb from '../adapters/mo-senate-web.js';
import * as journalPdf from '../adapters/mo-senate-journal-pdf.js';

// Journals-first MO Senate driver: roster ensure -> journal-day worklist -> per-day PDF
// extraction/parsing -> votes + gated casts. Separate small CLI (same rationale as
// ingest-mo-house.js's own module comment: a 30-minute mechanically-enforced cadence and a
// fetch-list-then-loop-per-item shape that doesn't fit ingest.js's one-collect-call-per-source
// pattern). Patterns (durable cross-process cooldown, failure-artifact quarantine, migration-gate
// artifact replay) are PORTED from ingest-mo-house.js, not imported — see each block's own comment
// for how this file's version differs (day-level quarantine instead of PDF-level; a "done" marker
// for the day-completeness rule, ruling 4; roster+journal-index local caches to keep this driver's
// "one live document per 30-minute slot" discipline even though MO Senate ingestion needs THREE
// distinct live document types, not one).

// ---- artifact dirs (gitignored, same convention as ingest-mo-house.js's ROLLCALL_ARTIFACT_DIR
// etc.) ----
const JOURNAL_ARTIFACT_DIR = '.superpowers/artifacts/mo-senate-journals';
const ROSTER_ARTIFACT_DIR = '.superpowers/artifacts/mo-senate-roster';
const INDEX_ARTIFACT_DIR = '.superpowers/artifacts/mo-senate-journal-index';

// ---- args ----

export function parseMoSenateArgs(argv) {
  const out = {
    year: null, limit: 1, dryRun: false, journalPdfFile: null,
  };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    const val = argv[i + 1];
    if (key === '--year') out.year = Number(val);
    else if (key === '--limit') out.limit = Number(val);
    // Same fixture-testing convention as ingest-mo-house.js's --rollcall-pdf-file: reads a LOCAL
    // PDF file instead of live-fetching whatever journal day this invocation would otherwise
    // process. Substitutes only the byte source — the day's own metadata (journal_url,
    // journal_date, pdf_basename) still comes from the worklist when a real day is being
    // processed; --dry-run --journal-pdf-file (no worklist at all) is the one exception, see main().
    else if (key === '--journal-pdf-file') out.journalPdfFile = val;
    else throw new Error(`unknown flag: ${key}`);
    i += 2;
  }
  if (!out.year) throw new Error('--year <Y> is required');
  return out;
}

// ---- source_key (CONTROLLER RULING 1) ----
//
// day_label ("Day 37") is NOT unique within a year — 2018's Veto Session reuses "Day 01" (12
// duplicate labels in the real fixture, per progress.md). The journal PDF URL's own basename
// (e.g. RDay370308587-610.pdf -> RDay370308587-610) is reviewer-verified unique per year and is
// the day segment of source_key; journal_url is identity, day_label is display-only. Also used for
// a local --journal-pdf-file path in dry-run mode (no journal_url available there at all).
export function journalPdfBasename(urlOrPath) {
  const clean = String(urlOrPath).split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() ?? clean;
  return base.replace(/\.pdf$/i, '');
}

export function buildVoteSourceKey(year, pdfBasename, ordinal) {
  return `mo-senate-web-${year}-${pdfBasename}-vote${ordinal}`;
}

// vote row shape mirrors ingest-mo-house.js's votes insert exactly (jurisdiction_id/chamber/
// source_key/run_id columns), per CONTROLLER RULING 8. result stays NULL unconditionally — the
// journal block never prints an outcome word, and deriving pass/fail from tallies would bake in
// chamber rules (simple majority vs 2/3 overrides); mechanical-neutrality says store only what's
// printed (task-5-brief.md, step 5). vote_date comes ONLY from the day's own journal_date
// (CONTROLLER RULING 3) — never derived from the PDF filename/pdf_basename.
export function buildVoteRow({
  billId, year, dayRow, vote, runId,
}) {
  return {
    bill_id: billId,
    jurisdiction_id: 'mo-legislature',
    chamber: 'senate',
    vote_date: dayRow.journal_date ?? null,
    question: vote.motion,
    result: null,
    source_url: dayRow.journal_url,
    source_key: buildVoteSourceKey(year, dayRow.pdf_basename, vote.ordinal),
    run_id: runId,
  };
}

// ---- casts (CONTROLLER RULING 6) ----
//
// absentWithLeave -> position 'absent' (mirrors ingest-mo-house.js precedent for the analogous
// House category); yeas -> yea, nays -> nay, absent -> absent. Vacancies is a seat COUNT
// (parseJournalVotes's `vacancies` field), never a name list — it is never iterated here, so a
// vacant seat can never become a cast by construction, not by a filter that could be gotten wrong.
const CAST_POSITION_BY_CATEGORY = {
  yeas: 'yea', nays: 'nay', absent: 'absent', absentWithLeave: 'absent',
};

export function buildCastTokens(vote) {
  const tokens = [];
  for (const category of ['yeas', 'nays', 'absent', 'absentWithLeave']) {
    for (const nameToken of vote[category]) {
      tokens.push({ surname: nameToken.surname, district: nameToken.district, position: CAST_POSITION_BY_CATEGORY[category] });
    }
  }
  return tokens;
}

// ---- roster source selection ----
//
// senate.mo.gov's /Senators/ page (mo-senate-web.js's parseSenateRosterHtml) is the only
// confirmed LIVE roster URL, and it is not year/session-parameterized (task-1-report.md: "not
// year/session-parameterized — it's the live app's current-membership view only, with no observed
// historical mode"). The only historical-year roster with a confirmed fetchable URL is 2018's
// Wayback-archived PDF (task-1-report.md's Wayback follow-up) — used here since it's directly
// exercised by this adapter's own research fixtures. Any OTHER historical year falls back to the
// current live roster, which is only accurate for members still serving today — an honest,
// documented limitation (see task-5-report.md "Concerns"), not a silent wrong answer: the roster
// gate (isMissingColumnError) is orthogonal to this and still applies regardless of which source
// was used.
const SENATE_ROSTER_CURRENT_URL = 'https://www.senate.mo.gov/Senators/';
const SENATE_ROSTER_ARCHIVE_URLS = {
  2018: 'https://web.archive.org/web/20250311182418id_/https://www.senate.mo.gov/18info/2018Roster.pdf',
};

export function pickRosterSource(year) {
  const archived = SENATE_ROSTER_ARCHIVE_URLS[Number(year)];
  if (archived) return { url: archived, format: 'pdf' };
  return { url: SENATE_ROSTER_CURRENT_URL, format: 'html' };
}

// journallist/?SelectedYear=<Y> is a real GET form, confirmed stable for any year 1996-2026
// (task-1-report.md).
export function buildJournalIndexUrl(year) {
  return `https://www.senate.mo.gov/journallist/?SelectedYear=${encodeURIComponent(String(year))}`;
}

// mo-senate-web.js exports no PDF-text-extraction helper of its own (Task 3 report: "PDF text
// extraction is a literal inline copy... not imported, not a new module" — confined to that task's
// OWN test file). Reusing mo-senate-journal-pdf.js's extractJournalText here (same pdfjs-dist
// coordinate-based row reconstruction) rather than re-implementing it a third time.
// stripPageChrome's patterns (journal running headers/page numbers) are provably specific to that
// document type (Task 4's own invariant comment) and cannot spuriously match a roster directory's
// content, so applying it to the roster PDF is a safe no-op, not a functional risk.
async function fetchAndParseRosterLive(source) {
  if (source.format === 'html') {
    const html = await senateWeb.fetchSenateRoster(source.url);
    return senateWeb.parseSenateRosterHtml(html);
  }
  // MINOR (fix round 1): the 2018 archive source.url is web.archive.org, NOT senate.mo.gov, yet
  // this reuses senateWeb.SOURCE/moSenateLimiter (the senate.mo.gov host limiter) rather than a
  // dedicated per-host limiter. Deliberate, not an oversight: this fetch happens at most once per
  // MO_SENATE_ROSTER_MAX_AGE_MS (24h, see ensureRosterForRun's cache) for the one archival year
  // this driver knows about, so a dedicated Wayback-specific limiter+SOURCE would be real added
  // complexity for a fetch this infrequent — simplicity wins over precision here. Known
  // consequence: a failure on this specific fetch reports `source: 'mo-senate-web'` (via
  // fetchWithLimit's error meta), which misattributes the failing host until a dedicated limiter
  // is added — acceptable given how rarely this path runs, but worth knowing when reading a
  // failure log.
  const arrayBuffer = await fetchWithLimit(source.url, { source: senateWeb.SOURCE, limiter: senateWeb.moSenateLimiter, as: 'arrayBuffer' });
  const text = await journalPdf.extractJournalText(Buffer.from(arrayBuffer));
  return senateWeb.parseSenateRosterPdf(text);
}

// ---- local caches (roster + journal index) ----
//
// DESIGN DECISION (documented deviation from the brief's literal step ordering — see
// task-5-report.md): roster, journal-index, and journal-PDF are THREE independent live document
// types, but moSenateLimiter (mo-senate-web.js) is ONE shared 30-minute-interval limiter for the
// whole host — a second live fetch within the same process would simply SLEEP out the remaining
// interval in-process rather than erroring, which would turn a single invocation into a
// 30-plus-minute blocking call. ingest-mo-house.js hit exactly this class of bug once already
// (fix-mo-enrichment's bill-list-cadence fix, its own file, "every invocation spent its ENTIRE
// cooldown slot on this one redundant list re-fetch") — ported the FIX pattern here proactively
// rather than reproducing the same bug and fixing it in a later round. Each of roster/index is
// cached to a local JSON artifact with its own max-age; a stale-or-missing cache is refetched LIVE
// and consumes this invocation's entire slot (the run closes immediately after, see main()) —
// once both caches are warm (the common case), an invocation spends its slot on the real
// deliverable, a journal-day PDF.
export const MO_SENATE_ROSTER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // roster changes rarely
export const MO_SENATE_INDEX_MAX_AGE_MS = 60 * 60 * 1000; // matches mo-house's bill-list cache

function cachePath(dir, key) {
  return `${dir}/${key}.json`;
}

function readCache(dir, key) {
  const p = cachePath(dir, key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null; // a corrupt/partial cache file must never crash the driver — treated as "no cache"
  }
}

function writeCache(dir, key, payload) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath(dir, key), JSON.stringify({ fetched_at: new Date().toISOString(), ...payload }, null, 2));
}

// Pure + testable without touching the filesystem — mirrors ingest-mo-house.js's
// shouldRefetchBillList convention exactly (no prior cache => must fetch).
export function shouldRefetch(lastFetchIso, maxAgeMs, now = Date.now()) {
  if (!lastFetchIso) return true;
  return (now - new Date(lastFetchIso).getTime()) >= maxAgeMs;
}

// ---- day-level quarantine (CONTROLLER RULING 4) ----
//
// A day with persistent parse failures must not re-fetch forever: ported from
// ingest-mo-house.js's <source_key>.failed.json / ROLLCALL_MAX_FAILED_ATTEMPTS pattern, keyed by
// pdf_basename instead of a per-vote source_key (one journal PDF = a whole day's worth of votes,
// not one PDF per vote — quarantine is a DAY-level decision, not a per-vote one). Same threshold
// (3) and same rationale: senate.mo.gov's own cooldown already spaces live retries far apart, so a
// transient hiccup is plausible for 1-2 failures; 3 independent failed attempts on the same
// document is a genuinely bad PDF or a real parser gap, not noise.
export const JOURNAL_DAY_MAX_FAILED_ATTEMPTS = 3;

function failedDayArtifactPath(dir, pdfBasename) {
  return `${dir}/${pdfBasename}.failed.json`;
}

// dir is injectable (defaults to the real JOURNAL_ARTIFACT_DIR) purely so this and
// writeDayFailureArtifact/excludeQuarantinedDays can be unit-tested against a scratch directory —
// same convention as ingest-mo-house.js's readFailureArtifact.
export function readDayFailureArtifact(pdfBasename, dir = JOURNAL_ARTIFACT_DIR) {
  const p = failedDayArtifactPath(dir, pdfBasename);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// failures: the `failures` array parseJournalVotes returns (JournalParseError instances) — only
// the fields needed for human review (ordinal/category/message) are persisted, never the whole
// error object (which may carry large blockPreview text).
export function writeDayFailureArtifact(pdfBasename, journalUrl, failures, dir = JOURNAL_ARTIFACT_DIR) {
  const existing = readDayFailureArtifact(pdfBasename, dir);
  const attempts = (existing ? existing.attempts : 0) + 1;
  mkdirSync(dir, { recursive: true });
  const record = {
    pdf_basename: pdfBasename,
    journal_url: journalUrl,
    failures: failures.map((f) => ({ ordinal: f.ordinal, category: f.category, message: f.message })),
    failed_at: new Date().toISOString(),
    attempts,
  };
  writeFileSync(failedDayArtifactPath(dir, pdfBasename), JSON.stringify(record, null, 2));
  return record;
}

// Pure filter (directly unit-tested, no DB required): drops any day whose .failed.json has
// reached JOURNAL_DAY_MAX_FAILED_ATTEMPTS. Returns skippedKeys (not just a count), same rationale
// as ingest-mo-house.js's excludeQuarantinedPdfs — an operator needs to know WHICH day(s) are
// quarantined without listing the artifacts dir by hand.
export function excludeQuarantinedDays(candidates, dir = JOURNAL_ARTIFACT_DIR) {
  const skippedKeys = [];
  const kept = candidates.filter((c) => {
    const failure = readDayFailureArtifact(c.pdf_basename, dir);
    if (failure && failure.attempts >= JOURNAL_DAY_MAX_FAILED_ATTEMPTS) {
      skippedKeys.push(c.pdf_basename);
      return false;
    }
    return true;
  });
  return { kept, skippedQuarantined: skippedKeys.length, skippedKeys };
}

// ---- day-completeness ("done") marker (CONTROLLER RULING 4, first sentence) ----
//
// "a day is complete when every parsed block became a votes row and parseJournalVotes reported
// zero failures." DB state alone cannot prove this (a votes-row count for a pdf_basename doesn't
// reveal how many blocks the PDF actually had, or whether any of them failed) without re-parsing
// the PDF — so this fact is recorded durably at PROCESS time via a local artifact, the same
// file-presence-driven idiom as ingest-mo-house.js's per-bill enriched marker
// (hasEnrichedMarker/writeEnrichedMarker). A day with >=1 failure NEVER gets this marker (task-5-
// brief.md step 7: "a day with >=1 failure is NOT marked complete"), so it stays in the worklist —
// visibly retried (and its failures re-reported) until either it starts parsing clean or it hits
// the quarantine cap above.
function doneMarkerPath(pdfBasename, dir) {
  return `${dir}/${pdfBasename}.done.json`;
}

export function hasDoneMarker(pdfBasename, dir = JOURNAL_ARTIFACT_DIR) {
  return existsSync(doneMarkerPath(pdfBasename, dir));
}

export function writeDoneMarker(pdfBasename, meta = {}, dir = JOURNAL_ARTIFACT_DIR) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(doneMarkerPath(pdfBasename, dir), JSON.stringify({
    pdf_basename: pdfBasename, done_at: new Date().toISOString(), ...meta,
  }, null, 2));
}

// ---- journal-day worklist (task-5-brief.md step 4, day-completeness rule per RULING 4) ----
//
// Pure: takes already-parsed journal-index rows (parseJournalIndex's output) plus the artifacts
// dir, filters out quarantined and already-complete days, and slices to --limit (default 1 — "one
// 30-min slot = one day PDF = ~a dozen votes", the plan). Order is the index's own document order
// (chronological, per task-1-report.md's structure notes), not re-sorted — a stable, honest
// default with no better signal to prioritize by.
export function selectJournalDayWorklist(indexRows, args, dir = JOURNAL_ARTIFACT_DIR) {
  const limit = args.limit ?? 1;
  const candidates = indexRows.map((row) => ({ ...row, pdf_basename: journalPdfBasename(row.journal_url) }));
  const { kept, skippedQuarantined, skippedKeys } = excludeQuarantinedDays(candidates, dir);
  const pending = kept.filter((row) => !hasDoneMarker(row.pdf_basename, dir));
  return {
    days: pending.slice(0, limit),
    totalPending: pending.length,
    skippedQuarantined,
    skippedQuarantinedKeys: skippedKeys,
  };
}

// ---- durable, cross-process ToU cooldown (ported from ingest-mo-house.js's
// enforceDurableCooldown — see that file's own extensive comment for the double-fetch bug this
// closes and the convergence-race fix; behavior here is intentionally identical, just re-keyed to
// source='mo-senate-web' / MO_SENATE_MIN_INTERVAL_MS) ----

export function remainingCooldownMs(lastStartedAtIso, minIntervalMs, now = Date.now()) {
  if (!lastStartedAtIso) return 0;
  const elapsed = now - new Date(lastStartedAtIso).getTime();
  return Math.max(0, minIntervalMs - elapsed);
}

export function formatCooldownWait(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}m ${secs}s`;
}

export class CooldownConvergenceError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'CooldownConvergenceError';
    Object.assign(this, meta);
  }
}

async function queryLastMoSenateRunStartedAt(client) {
  const { data, error } = await client
    .from('ingestion_runs')
    .select('started_at')
    .eq('source', senateWeb.SOURCE)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`mo-senate cooldown lookup failed: ${error.message}`);
  return data ? data.started_at : null;
}

export async function enforceDurableCooldown(
  client,
  minIntervalMs = senateWeb.MO_SENATE_MIN_INTERVAL_MS,
  { sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), maxIterations = 10 } = {},
) {
  for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
    const lastStartedAt = await queryLastMoSenateRunStartedAt(client);
    const remaining = remainingCooldownMs(lastStartedAt, minIntervalMs);
    if (remaining <= 0) return;
    console.error(`[${new Date().toISOString()}] ToU cooldown: waiting ${formatCooldownWait(remaining)} (last fetch ${lastStartedAt}, re-check ${attempt}/${maxIterations})`);
    await sleep(remaining);
  }
  throw new CooldownConvergenceError(
    `mo-senate cooldown did not converge after ${maxIterations} fresh re-checks — this should be `
      + 'impossible in normal operation; failing loud rather than looping forever',
    { maxIterations, minIntervalMs },
  );
}

// ---- session + roster persistence ----

// task-5-brief.md step 2, exact row shape: identifier deliberately collides with OpenStates' own
// year-keyed session rows so both sources dedupe to one row.
export async function ensureSessionRow(client, runId, year) {
  const identifier = String(year);
  await insertIfAbsent(client, 'sessions', [{
    jurisdiction_id: 'mo-legislature', identifier, name: `${year} Regular Session (MO Senate journals)`,
  }], 'jurisdiction_id,identifier');
  const { data, error } = await client.from('sessions').select('id')
    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', identifier).single();
  if (error) throw new Error(`mo-senate session lookup failed: ${error.message}`);
  return data;
}

// ---- roster identity (FIX ROUND 1, CRITICAL — cross-era mo_senate_id collision) ----
//
// BUG FOUND IN REVIEW (empirically reproduced): the original persistRosterRows keyed
// insertIfAbsent's upsert on the bare 'mo_senate_id' column, which migration 0008 makes a
// TABLE-WIDE UNIQUE index. A district number is per-era metadata, not a stable person identity —
// it gets reused by a new person every time a senator leaves office (a real, expected event, not
// an edge case). The first person ever ingested for a district therefore permanently owned that
// row: a 2026 run for district 2 (now held by someone other than Onder) would silently no-op on
// the upsert conflict while still reporting persisted:1 (masking the failure), and if the new
// occupant happened to share a surname with the frozen row, resolveMoSenator would attribute
// their votes to the WRONG person with zero signal anything was wrong.
//
// FIX (controller ruling): (full_name, mo_senate_id) is the working per-era find-or-create key,
// not mo_senate_id alone — check-then-insert per member, never a bulk upsert. Migration 0009
// (supabase/migrations/0009_mo_senate_id_nonunique.sql, draft — Lance applies; 0008 is already
// live) drops 0008's unique index so a genuinely new (full_name, mo_senate_id) pair can always
// get its own row. Until 0009 lands, a second era's insert for an already-claimed district still
// hits the old unique index — detected via isMoSenateIdUniqueViolation below (Postgres 23505 on
// legislators_mo_senate_id_uidx) and treated as a GATED state (same honest-skip convention as a
// missing column), never a silent misattribution. The astronomically-rare wrong-merge case
// (two DIFFERENT people sharing the exact same full_name AND the same district, in different
// eras) is accepted, not handled — a real cross-source identity merge (TODO 8) is the actual fix
// for that, out of scope here.
function isMoSenateIdUniqueViolation(err) {
  if (!err) return false;
  const code = err.code;
  const msg = String(err.message || '').toLowerCase();
  if (code === '23505') return msg.includes('mo_senate_id') || msg.includes('legislators_mo_senate_id_uidx');
  // PostgREST error shapes vary by driver/version — fall back to message-text matching, same
  // defensive convention as isMissingColumnError/isMissingRelationError (src/lib/db.js).
  return msg.includes('legislators_mo_senate_id_uidx') && (msg.includes('duplicate key') || msg.includes('already exists'));
}

// IMPORTANT FIX (code review): the original persistRosterRows reported persisted:rows.length
// UNCONDITIONALLY, even when the upsert silently no-op'd on a stale-owner conflict — masking the
// Critical bug above rather than surfacing it. found/inserted are now both counted from what
// ACTUALLY happened per member, never assumed. resolutionRoster is built ENTIRELY from this call's
// own per-member lookups/inserts — this is the other half of the fix: ensureRosterForRun (below)
// now uses THIS in-memory mapping directly as the resolution roster, instead of any global
// district-scoped DB query (the deleted loadSenateRosterForResolution) — a query scoped only by
// district number, not by full_name/era, would still mix two different eras' occupants of the
// same district into one resolution roster even post-0009, reintroducing the same misattribution
// risk one level up.
// Wraps a raw Supabase/PostgREST error into a real Error (greppable message, never
// String(err) === '[object Object]') while preserving `.code` — isMissingColumnError and
// isMoSenateIdUniqueViolation both inspect `.code`/`.message`, and any error that isn't one of
// those two known gate shapes must still surface as a proper thrown Error, not a raw plain object.
function wrapDbError(err, context) {
  const wrapped = new Error(`${context}: ${err.message}`);
  wrapped.code = err.code;
  return wrapped;
}

export async function ensureRosterIdentities(client, runId, members) {
  let found = 0;
  let inserted = 0;
  let missingColumn = false;
  const collided = [];
  const resolutionRoster = [];

  for (const m of members) {
    try {
      const { data: existing, error: selErr } = await client.from('legislators')
        .select('id')
        .eq('full_name', m.full_name)
        .eq('mo_senate_id', m.mo_senate_id)
        .maybeSingle();
      if (selErr) throw wrapDbError(selErr, `mo-senate roster lookup failed for ${m.full_name}`);
      if (existing) {
        found += 1;
        resolutionRoster.push({ legislator_id: existing.id, surname: m.surname, mo_senate_id: m.mo_senate_id });
        continue;
      }
      const { data: createdRow, error: insErr } = await client.from('legislators')
        .insert({
          full_name: m.full_name, party: m.party, surname: m.surname, mo_senate_id: m.mo_senate_id, run_id: runId,
        })
        .select('id')
        .single();
      if (insErr) throw wrapDbError(insErr, `mo-senate roster insert failed for ${m.full_name}`);
      inserted += 1;
      resolutionRoster.push({ legislator_id: createdRow.id, surname: m.surname, mo_senate_id: m.mo_senate_id });
    } catch (err) {
      if (isMissingColumnError(err, 'mo_senate_id')) { missingColumn = true; continue; }
      if (isMoSenateIdUniqueViolation(err)) { collided.push({ full_name: m.full_name, mo_senate_id: m.mo_senate_id }); continue; }
      throw err;
    }
  }

  const gated = missingColumn || collided.length > 0;
  let note;
  if (missingColumn) {
    note = 'legislators.mo_senate_id column not found — migration 0008 (supabase/migrations/0008_mo_senate_id.sql) not yet applied; roster persistence skipped this run. bills/votes are unaffected; casts go to the gated-artifact path.';
  } else if (collided.length > 0) {
    const names = collided.map((c) => `${c.full_name} (district ${c.mo_senate_id})`).join(', ');
    note = `legislators_mo_senate_id_uidx still enforces a table-wide unique index on mo_senate_id — migration 0009 (supabase/migrations/0009_mo_senate_id_nonunique.sql) not yet applied. ${collided.length} roster member(s) collided with an existing row already claiming their district under a different name: ${names}. This is the cross-era identity collision migration 0009 fixes — casts go to the gated-artifact path until it lands.`;
  }

  return {
    attempted: members.length, found, inserted, gated, collided, missingColumn, resolutionRoster, note,
  };
}

// fetchLive/dir are injectable purely for testability (a fake fetcher + scratch cache dir), same
// convention as enforceDurableCooldown's injectable sleep — never touches the real network or the
// real gitignored artifacts dir in a test.
export async function ensureRosterForRun(client, runId, year, {
  fetchLive = fetchAndParseRosterLive, dir = ROSTER_ARTIFACT_DIR, maxAgeMs = MO_SENATE_ROSTER_MAX_AGE_MS,
} = {}) {
  const cacheKey = String(year);
  const cache = readCache(dir, cacheKey);
  if (shouldRefetch(cache?.fetched_at ?? null, maxAgeMs)) {
    const source = pickRosterSource(year);
    const { members, vacancies } = await fetchLive(source);
    writeCache(dir, cacheKey, {
      source_url: source.url, format: source.format, members, vacancies,
    });
    const identities = await ensureRosterIdentities(client, runId, members);
    return {
      fetchedLive: true, members, identities,
    };
  }
  const identities = await ensureRosterIdentities(client, runId, cache.members);
  return { fetchedLive: false, members: cache.members, identities };
}

// dir is injectable, same rationale as ensureRosterForRun.
export async function ensureIndexForRun(year, {
  dir = INDEX_ARTIFACT_DIR, maxAgeMs = MO_SENATE_INDEX_MAX_AGE_MS,
} = {}) {
  const cacheKey = String(year);
  const cache = readCache(dir, cacheKey);
  if (shouldRefetch(cache?.fetched_at ?? null, maxAgeMs)) {
    const html = await senateWeb.fetchJournalIndex(buildJournalIndexUrl(year));
    const rows = senateWeb.parseJournalIndex(html);
    writeCache(dir, cacheKey, { rows });
    return { fetchedLive: true, rows };
  }
  return { fetchedLive: false, rows: cache.rows };
}

// ---- per-day processing (task-5-brief.md steps 5-7) ----

// rosterState: { gated: bool, roster: [...] } — the resolution roster loaded once per run (or
// empty/ignored when gated). Casts for an unresolved surname are counted, never guessed
// (CONTROLLER RULING 6); when the roster itself is gated, every vote's casts on this day are
// queued into a single per-day gate artifact instead (task-5-brief.md step 6).
export async function processJournalDay(client, runId, year, sessionRow, dayRow, args, rosterState, dir = JOURNAL_ARTIFACT_DIR) {
  let pdfBuffer;
  let mode;
  try {
    if (args.journalPdfFile) {
      pdfBuffer = readFileSync(args.journalPdfFile);
      mode = 'fixture';
      console.error(`[${new Date().toISOString()}] read journal PDF for ${dayRow.pdf_basename} from local fixture (not a live request): ${args.journalPdfFile}`);
    } else {
      const arrayBuffer = await senateWeb.fetchSenateJournalPdf(dayRow.journal_url);
      pdfBuffer = Buffer.from(arrayBuffer);
      mode = 'live';
      console.error(`[${new Date().toISOString()}] fetched journal PDF for ${dayRow.pdf_basename} (live)`);
    }
  } catch (err) {
    if (!(err instanceof SourceFetchError)) throw err;
    return {
      pdf_basename: dayRow.pdf_basename, mode: 'failed', votes_parsed: 0, votes_written: 0, failures: 0,
      fetchFailure: { step: `journal pdf ${dayRow.pdf_basename}`, message: err.message },
    };
  }

  const text = await journalPdf.extractJournalText(pdfBuffer);
  const { votes, failures } = journalPdf.parseJournalVotes(text);

  const attribution = { motion: 0, preceding_taken_up: 0 };
  let votesWritten = 0;
  let castsResolved = 0;
  let castsUnresolved = 0;
  const unresolvedSample = [];
  let dayGated = false;
  const gatedArtifactVotes = [];

  for (const vote of votes) {
    attribution[vote.attribution] = (attribution[vote.attribution] ?? 0) + 1;

    // Bill stubs: exact column shape as ingest-mo-house.js's persistBillStubs (CONTROLLER RULING
    // 8) — session_id FK + identifier, title/status/canonical_url null (this driver never
    // enriches a bill, only journals do).
    await insertIfAbsent(client, 'bills', vote.bill_refs.map((identifier) => ({
      session_id: sessionRow.id, identifier, title: null, status: null, canonical_url: null, run_id: runId,
    })), 'session_id,identifier');
    const primaryRef = vote.bill_refs[0];
    const { data: billRow, error: billErr } = await client.from('bills').select('id')
      .eq('session_id', sessionRow.id).eq('identifier', primaryRef).single();
    if (billErr) throw new Error(`mo-senate bill lookup failed for ${primaryRef}: ${billErr.message}`);

    const voteRow = buildVoteRow({
      billId: billRow.id, year, dayRow, vote, runId,
    });
    await insertIfAbsent(client, 'votes', [voteRow], 'source_key');
    const { data: voteSel, error: voteSelErr } = await client.from('votes').select('id')
      .eq('source_key', voteRow.source_key).single();
    if (voteSelErr) throw new Error(`mo-senate vote lookup failed for ${voteRow.source_key}: ${voteSelErr.message}`);
    votesWritten += 1;

    const castTokens = buildCastTokens(vote);
    if (rosterState.gated) {
      dayGated = true;
      gatedArtifactVotes.push({ vote_id: voteSel.id, source_key: voteRow.source_key, casts: castTokens });
      continue;
    }
    const resolvedRows = [];
    const unresolved = [];
    for (const cast of castTokens) {
      const legislatorId = journalPdf.resolveMoSenator(cast, rosterState.roster);
      if (legislatorId) resolvedRows.push({ vote_id: voteSel.id, legislator_id: legislatorId, position: cast.position, run_id: runId });
      else unresolved.push(cast);
    }
    await insertIfAbsent(client, 'vote_casts', resolvedRows, 'vote_id,legislator_id');
    castsResolved += resolvedRows.length;
    castsUnresolved += unresolved.length;
    if (unresolvedSample.length < 10) {
      unresolvedSample.push(...unresolved.slice(0, 10 - unresolvedSample.length).map((c) => ({ source_key: voteRow.source_key, ...c })));
    }
  }

  // Gate artifact: keyed distinctively as '<pdf_basename>.journal-day.json' — deliberately NOT a
  // bare '.json' suffix (unlike ingest-mo-house.js's single-suffix-then-exclude-.failed.json
  // filter) because this directory ALSO holds '.done.json' completeness markers alongside
  // '.failed.json' quarantine records; a distinct suffix means replayJournalArtifacts's file
  // filter can never accidentally treat either marker type as a gate artifact, no exclusion logic
  // needed.
  if (dayGated) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${dayRow.pdf_basename}.journal-day.json`, JSON.stringify({
      // FIX ROUND 2 (CRITICAL): `year` is load-bearing for replayJournalArtifacts — an artifact
      // may ONLY ever be resolved against ITS OWN year's roster mapping (see that function's own
      // comment for the concrete cross-era misattribution this closes). Without this field, a
      // later replay has no way to know which era's roster is safe to resolve it against.
      year,
      pdf_basename: dayRow.pdf_basename,
      journal_url: dayRow.journal_url,
      journal_date: dayRow.journal_date,
      votes: gatedArtifactVotes,
      extracted_run_id: runId,
      note: 'legislators.mo_senate_id column not found, OR a still-live migration-0008 unique-index collision on '
        + 'mo_senate_id (see ensureRosterIdentities) — this year\'s roster identities are not fully resolvable yet. '
        + 'Casts were extracted but not resolved/persisted to vote_casts. This driver retries the roster ensure (and '
        + 'replays every queued artifact against its own year\'s mapping) on every subsequent invocation — once the '
        + 'relevant migration is applied, a future run drains this automatically.',
    }, null, 2));
  }

  // CONTROLLER RULING 4 / task-5-brief.md step 7: a day is complete only when every parsed block
  // became a votes row AND parseJournalVotes reported zero failures. Only in that case does the
  // day leave the worklist forever (done marker); a day with >=1 failure stays pending — visibly
  // retried (and quarantined at the attempt cap) rather than silently marked done with a gap.
  if (failures.length === 0) {
    writeDoneMarker(dayRow.pdf_basename, { run_id: runId, votes: votesWritten, gated: dayGated }, dir);
  } else {
    writeDayFailureArtifact(dayRow.pdf_basename, dayRow.journal_url, failures, dir);
  }

  return {
    pdf_basename: dayRow.pdf_basename,
    mode,
    votes_parsed: votes.length,
    votes_written: votesWritten,
    failures: failures.length,
    failureDetails: failures.map((f) => ({ ordinal: f.ordinal, category: f.category, message: f.message })),
    attribution,
    casts: {
      resolved: castsResolved, unresolved: castsUnresolved, unresolvedSample, gated: dayGated,
    },
  };
}

// ---- gated-artifact replay (FIX ROUND 2, CRITICAL — replay must never resolve blind across
// eras) ----
//
// BUG FOUND IN RE-REVIEW (empirically traced, not hypothetical): the original replayJournalArtifacts
// resolved EVERY queued artifact against one global, era-blind roster query
// (`.not('mo_senate_id','is',null)` — the exact same query shape as the deleted
// loadSenateRosterForResolution), ran BEFORE this invocation's own roster ensure, and took no year
// parameter at all. Concrete trace: 2018 Bob Onder is persisted (has a legislators row); 2026 Jane
// Onder was gated pre-0009 (her district collided with Bob's still-unique row, so she has NO row
// of her own — her cast sits queued in a `.journal-day.json` artifact). A later invocation's
// replay queries the broad roster, finds ONLY Bob's row for surname 'Onder' (Jane has none),
// resolveMoSenator finds a single UNAMBIGUOUS match — Bob's legislator_id — and "resolves" Jane's
// vote onto Bob. `unresolved:0`, so the artifact is deleted: the misattribution completes silently
// AND the only durable evidence of it (the queued artifact) is destroyed in the same step.
//
// FIX (controller ruling): an artifact may ONLY be resolved against ITS OWN YEAR's roster mapping.
// Artifacts now carry `year` (processJournalDay writes it — see that function's own comment).
// Replay groups queued artifacts by year and, per year, obtains the SAME in-memory mapping
// ensureRosterIdentities would produce for that year:
//   - if the year matches THIS run's own --year, the caller passes in this run's
//     already-computed identities (currentYear/currentYearIdentities) — no extra DB work, and
//     matches whatever this invocation's own roster-ensure just did (fresh live fetch OR a
//     cache-hit re-ensure, doesn't matter — ensureRosterForRun always re-runs
//     ensureRosterIdentities regardless of fetchedLive). ALWAYS trusted, any year, because it's
//     guaranteed fresh this invocation.
//   - otherwise (a year that is NOT this run's own --year), that year's roster CACHE
//     (readCache(rosterDir, year)) is read and its cached members re-run through
//     ensureRosterIdentities — a pure DB check-then-insert/find, NEVER a live fetch (rule: "never
//     burn extra live-fetch slots silently to force it") — BUT ONLY when that year is strictly
//     BEFORE the current calendar year (`currentCalendarYear`, real wall-clock year by default).
//
// FIX ROUND 3 (re-review, residual Critical-class channel closed): the round-2 fix above still had
// a narrow gap — the cache-based path was permitted for ANY non-matching year, including the
// CURRENT (still-open) legislative year. A historical year's roster is a closed, immutable
// snapshot once its session ends; the CURRENT year's is not (a mid-year appointment/replacement
// can add a member the cache doesn't know about yet). A `--year 2018` backfill invocation that
// happens to encounter a queued CURRENT-year artifact could still read a stale current-year cache
// and reach the exact same wrong-single-match misattribution class round 2 closed for the
// already-closed case. Fix: the cache-based branch is gated on `Number(year) < currentCalendarYear`
// — a current-or-future-labeled year NEVER uses the cache fallback, full stop, regardless of
// whether a cache file happens to exist. Such artifacts stay queued until a matching-year
// invocation (`--year <that year>`) ensures it directly — "the next --year <current> invocation,
// which is the natural cadence" (controller ruling), not a new fetch forced by this function.
//
// ACCEPTED V1 SIMPLIFICATION (documented, not fixed here — inherited from the House pipeline's own
// shape, e.g. ingest-mo-house.js's single per-representative fixture roster): a year's roster is
// treated as ONE snapshot. A member seated mid-year (special election, mid-session appointment) is
// simply absent from that snapshot — their casts fail toward UNRESOLVED (visible in run detail,
// honestly counted, never guessed), not toward a wrong match, UNLESS a same-surname/same-district
// different-person overlap exists WITHIN that one year's own roster — and resolveMoSenator already
// fails that case to null (0-or-1-match only, never picks between ambiguous candidates). No
// mid-session roster delta tracking exists in this driver; a real fix would need one, out of scope
// here.
export async function replayJournalArtifacts(client, runId, {
  dir = JOURNAL_ARTIFACT_DIR,
  rosterDir = ROSTER_ARTIFACT_DIR,
  currentYear = null,
  currentYearIdentities = null,
  currentCalendarYear = new Date().getFullYear(),
} = {}) {
  const empty = {
    attempted: 0, replayed: 0, unresolved: 0, unresolvedSample: [], deferred: [],
  };
  if (!existsSync(dir)) return empty;
  const files = readdirSync(dir).filter((f) => f.endsWith('.journal-day.json'));
  if (files.length === 0) return empty;

  // Group by year up front. An artifact with no `year` at all (none exist in production per the
  // controller ruling — this is a defensive, honestly-reported branch, not an expected path) can
  // never be safely resolved against any era's roster, so it is deferred, never guessed.
  const byYear = new Map();
  const deferred = [];
  for (const file of files) {
    const filePath = `${dir}/${file}`;
    const artifact = JSON.parse(readFileSync(filePath, 'utf8'));
    if (artifact.year == null) {
      deferred.push({
        year: null, file, note: 'replay deferred: artifact has no year field — cannot be safely resolved against any era\'s roster',
      });
      continue;
    }
    if (!byYear.has(artifact.year)) byYear.set(artifact.year, []);
    byYear.get(artifact.year).push({ filePath, artifact });
  }

  let replayed = 0;
  let unresolvedTotal = 0;
  const unresolvedSample = [];

  for (const [year, entries] of byYear) {
    let identities;
    const isMatchingYear = currentYear != null && Number(year) === Number(currentYear) && currentYearIdentities;
    if (isMatchingYear) {
      identities = currentYearIdentities;
    } else if (Number(year) < currentCalendarYear) {
      // FIX ROUND 3: cache fallback is only reachable for a YEAR STRICTLY BEFORE the current
      // calendar year — a closed, immutable roster snapshot. See the module comment above.
      const cache = readCache(rosterDir, String(year));
      if (!cache) {
        deferred.push({ year, note: `replay deferred: year ${year} roster unavailable this invocation` });
        continue;
      }
      identities = await ensureRosterIdentities(client, runId, cache.members);
    } else {
      // year >= currentCalendarYear (the current, still-open legislative year, or later) and this
      // isn't this invocation's own --year: no cache fallback, no live fetch forced — only a
      // matching-year invocation's own fresh ensure is trusted for a not-yet-closed year.
      deferred.push({ year, note: `replay deferred: year ${year} roster unavailable this invocation` });
      continue;
    }
    if (identities.gated) {
      deferred.push({ year, note: `replay deferred: year ${year} roster unavailable this invocation` });
      continue;
    }
    const roster = identities.resolutionRoster;

    for (const { filePath, artifact } of entries) {
      let allResolved = true;
      const stillUnresolvedVotes = [];
      for (const voteEntry of artifact.votes) {
        const resolvedRows = [];
        const unresolved = [];
        for (const cast of voteEntry.casts) {
          const legislatorId = journalPdf.resolveMoSenator(cast, roster);
          if (legislatorId) resolvedRows.push({ vote_id: voteEntry.vote_id, legislator_id: legislatorId, position: cast.position, run_id: runId });
          else unresolved.push(cast);
        }
        // sequential (not Promise.all) is deliberate — small, infrequent artifact backlog, same
        // precedent as ingest-mo-house.js's replayArtifacts.
        await insertIfAbsent(client, 'vote_casts', resolvedRows, 'vote_id,legislator_id');
        if (unresolved.length > 0) {
          allResolved = false;
          stillUnresolvedVotes.push({ ...voteEntry, casts: unresolved });
          unresolvedTotal += unresolved.length;
          if (unresolvedSample.length < 10) unresolvedSample.push(...unresolved.slice(0, 10 - unresolvedSample.length).map((c) => ({ source_key: voteEntry.source_key, ...c })));
        }
      }
      if (allResolved) {
        unlinkSync(filePath);
        replayed += 1;
      } else {
        writeFileSync(filePath, JSON.stringify({
          ...artifact,
          partial: true,
          votes: stillUnresolvedVotes,
          last_replay_run_id: runId,
          last_replay_at: new Date().toISOString(),
        }, null, 2));
        console.error(`[${new Date().toISOString()}] replay: ${artifact.pdf_basename} (year ${year}) — ${stillUnresolvedVotes.length} vote(s) still have unresolved casts (artifact kept on disk, partial: true)`);
      }
    }
  }

  return {
    attempted: files.length, replayed, unresolved: unresolvedTotal, unresolvedSample, deferred,
  };
}

// ---- dry-run reporting (no --journal-pdf-file: DB state only, zero live fetches — mirrors
// ingest-mo-house.js's dryRunReport) ----

export async function dryRunReport(client, year) {
  const identifier = String(year);
  const { data: sessionRow, error: sessErr } = await client.from('sessions')
    .select('id,identifier,name')
    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', identifier).maybeSingle();
  if (sessErr) {
    if (isMissingRelationError(sessErr, 'sessions')) {
      return { counts: null, note: 'sessions table not found (migration not yet applied) — no DB state to report; zero live fetches made' };
    }
    throw new Error(`mo-senate dry-run session lookup failed: ${sessErr.message}`);
  }
  if (!sessionRow) {
    return {
      counts: { votes_total: 0 },
      note: `no sessions row yet for identifier=${identifier} (no live run has happened yet); zero live fetches made`,
    };
  }
  const { count, error: countErr } = await client.from('votes')
    .select('id', { count: 'exact', head: true }).like('source_key', `mo-senate-web-${identifier}-%`);
  if (countErr) throw new Error(`mo-senate dry-run votes count failed: ${countErr.message}`);
  return {
    counts: { votes_total: count ?? 0 },
    note: 'counts computed from DB state only — zero live fetches made this invocation, per --dry-run',
  };
}

// ---- main ----

async function main() {
  const args = parseMoSenateArgs(process.argv.slice(2));
  const client = getClient();

  if (args.dryRun) {
    // --dry-run --journal-pdf-file: prove the full extract -> parse pipeline against a real
    // fixture with ZERO live fetches and ZERO DB writes — no DB client needed at all (this is the
    // required no-network smoke, task-5-brief.md).
    if (args.journalPdfFile) {
      const buffer = readFileSync(args.journalPdfFile);
      const text = await journalPdf.extractJournalText(buffer);
      const parsed = journalPdf.parseJournalVotes(text);
      const attribution = { motion: 0, preceding_taken_up: 0 };
      for (const v of parsed.votes) attribution[v.attribution] = (attribution[v.attribution] ?? 0) + 1;
      console.log(JSON.stringify({
        mode: 'dry-run',
        source: senateWeb.SOURCE,
        year: args.year,
        plan: {
          from: 'journal-pdf-file',
          file: args.journalPdfFile,
          pdf_basename: journalPdfBasename(args.journalPdfFile),
          votes_planned: parsed.votes.length,
          failures: parsed.failures.length,
          attribution,
          writes: 0,
        },
        note: 'local fixture parse only — zero live fetches, zero DB writes',
      }, null, 2));
      return;
    }
    if (!client) {
      console.log(JSON.stringify({
        mode: 'dry-run', source: senateWeb.SOURCE, counts: null,
        note: 'no DB client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset) — cannot report DB state; zero live fetches made',
      }, null, 2));
      return;
    }
    const report = await dryRunReport(client, args.year);
    console.log(JSON.stringify({ mode: 'dry-run', source: senateWeb.SOURCE, year: args.year, ...report }, null, 2));
    return;
  }

  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  await enforceDurableCooldown(client);
  const runId = await openRun(client, senateWeb.SOURCE);
  try {
    const sessionRow = await ensureSessionRow(client, runId, args.year);

    // At most ONE live network fetch per invocation (roster > journal-index > journal-day PDF,
    // priority order) — see the "local caches" comment block above for why. A slot spent on
    // roster or index closes the run immediately; the very next invocation continues.
    const rosterResult = await ensureRosterForRun(client, runId, args.year);

    // FIX ROUND 2 (CRITICAL): replay moved to AFTER this run's own roster ensure (was: before
    // ensureSessionRow, using a global era-blind roster query) so that when a queued artifact's
    // year matches THIS run's --year, replay can use this run's own freshly-ensured
    // identities/resolutionRoster directly — see replayJournalArtifacts's own comment for the
    // concrete misattribution this closes. Still pure DB + filesystem for any OTHER year (reads
    // that year's own roster cache, never a live fetch) — safe and cheap every invocation
    // regardless of which branch below ends up running this slot.
    const artifactReplay = await replayJournalArtifacts(client, runId, {
      currentYear: args.year, currentYearIdentities: rosterResult.identities,
    });

    if (rosterResult.fetchedLive) {
      const counts = {
        days: 0, votes: 0, casts: 0, unresolved: 0, failures: 0, gated: rosterResult.identities.gated,
        artifact_replay: artifactReplay, slot: 'roster',
      };
      await closeRun(client, runId, 'succeeded', { counts, roster: rosterResult.identities });
      console.log(JSON.stringify({
        mode: 'live', run_id: runId, status: 'succeeded', counts, roster: rosterResult.identities,
      }, null, 2));
      return;
    }

    const indexResult = await ensureIndexForRun(args.year);
    if (indexResult.fetchedLive) {
      const counts = {
        days: 0, votes: 0, casts: 0, unresolved: 0, failures: 0, gated: rosterResult.identities.gated,
        artifact_replay: artifactReplay, slot: 'journal-index',
      };
      await closeRun(client, runId, 'succeeded', { counts });
      console.log(JSON.stringify({
        mode: 'live', run_id: runId, status: 'succeeded', counts,
      }, null, 2));
      return;
    }

    // FIX ROUND 1 (Critical): the resolution roster is now the IN-MEMORY mapping
    // ensureRosterIdentities just built for THIS era's own members — never a global
    // district-scoped DB query (loadSenateRosterForResolution, deleted). See
    // ensureRosterIdentities's own comment for why a district-only query would still risk mixing
    // two different eras' occupants of the same seat.
    const resolutionRoster = rosterResult.identities.gated ? [] : rosterResult.identities.resolutionRoster;

    const worklist = selectJournalDayWorklist(indexResult.rows, args);
    const dayResults = [];
    let totalVotes = 0;
    let totalFailures = 0;
    let totalCastsResolved = 0;
    let totalCastsUnresolved = 0;
    let anyGated = rosterResult.identities.gated;
    const unresolvedSample = [];
    const attribution = { motion: 0, preceding_taken_up: 0 };

    for (const dayRow of worklist.days) {
      const result = await processJournalDay(client, runId, args.year, sessionRow, dayRow, args, {
        gated: rosterResult.identities.gated, roster: resolutionRoster,
      });
      dayResults.push(result);
      totalVotes += result.votes_written;
      totalFailures += result.failures;
      attribution.motion += result.attribution.motion ?? 0;
      attribution.preceding_taken_up += result.attribution.preceding_taken_up ?? 0;
      if (result.casts) {
        totalCastsResolved += result.casts.resolved;
        totalCastsUnresolved += result.casts.unresolved;
        if (result.casts.gated) anyGated = true;
        for (const s of result.casts.unresolvedSample) if (unresolvedSample.length < 10) unresolvedSample.push(s);
      }
    }

    const counts = {
      days: dayResults.length,
      votes: totalVotes,
      casts: totalCastsResolved,
      unresolved: totalCastsUnresolved,
      failures: totalFailures,
      gated: anyGated,
      attributed_from_context: attribution.preceding_taken_up,
      attribution,
      quarantined_days: worklist.skippedQuarantinedKeys,
      total_pending_days: worklist.totalPending,
      artifact_replay: artifactReplay,
    };
    const status = totalFailures === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, {
      counts, dayResults, roster: rosterResult.identities, unresolvedSample,
    });
    console.log(JSON.stringify({
      mode: 'live', run_id: runId, status, counts, dayResults,
    }, null, 2));
    if (totalFailures > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
