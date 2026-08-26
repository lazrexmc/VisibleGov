// Mark SAME-SOURCE duplicate votes — two rows written by ONE adapter for one real floor vote.
//
// Migration 0022's dedup pairs LegiScan against a PRIMARY source and is structurally blind to this
// case (both rows are the same source, so no second source corroborates). Found by the 2026-08-26
// system audit as defect D1; the rule and every reason it refuses a group live in
// src/lib/same-source-dedup.js, which is where the four conditions are argued.
//
// Non-destructive, exactly like 0022: both rows stay in `votes` forever, fully traceable. This only
// writes a vote_duplicates row naming which one displays. The public views already exclude the
// superseded side, so the site self-corrects and nothing is deleted or rewritten.
//
// Dry-run by default; --apply writes. insertIfAbsent on superseded_vote_id (its own unique
// constraint) makes a re-run a harmless no-op on already-marked pairs, never a duplicate-key error.
//
// --prune is the self-healing path, and it exists because the FIRST version of this rule was
// applied live and 17 of its 38 pairs were false — they hid real votes (an anchor of "#0" pins
// nothing, and one journal page anchor covers both "Adopt Substitute" and "Third Reading", two real
// votes with one cast fingerprint). --prune re-derives the rule over the whole database and DELETES
// any vote_duplicates row THIS rule wrote that the rule no longer confirms, restoring those votes to
// public view. It never touches migration 0022's cross-source rows: it matches only on the reason
// prefix this script writes. Deleting a marking row is non-destructive — the votes themselves were
// never modified.
//
// Usage: node --env-file=.env scripts/dedup-same-source-votes.mjs [--apply] [--prune] [--json]
import { getClient, selectAll, insertIfAbsent } from '../src/lib/db.js';
import {
  candidateKey, castFingerprint, confirmDuplicateGroup, chooseCanonical, sourceFamily,
  DEFAULT_CAST_FLOOR,
} from '../src/lib/same-source-dedup.js';

const apply = process.argv.includes('--apply');
const prune = process.argv.includes('--prune');
const SAME_SOURCE_REASON_PREFIX = 'same-source duplicate';
const asJson = process.argv.includes('--json');
const client = getClient();
if (!client) { console.log(JSON.stringify({ mode: 'blocked', reason: 'no DB client configured' })); process.exit(1); }

const log = (...a) => { if (!asJson) console.log(...a); };

// ---- 1. every vote, paginated (a bare .select() would silently cap at 1,000 — project law) ----
const { data: votes, error: vErr } = await selectAll(client, 'votes',
  'id,bill_id,jurisdiction_id,chamber,vote_date,question,result,source_url,source_key');
if (vErr) throw new Error(`votes: ${vErr.message}`);
log(`votes read: ${votes.length}`);

// ---- 2. cheap pre-filter: rows that could conceivably be the same vote ----
const byCandidate = new Map();
for (const v of votes) {
  const k = candidateKey(v);
  if (!byCandidate.has(k)) byCandidate.set(k, []);
  byCandidate.get(k).push(v);
}
const candidates = [...byCandidate.entries()].filter(([, rows]) => rows.length > 1);
const candidateIds = candidates.flatMap(([, rows]) => rows.map((r) => r.id));
log(`candidate groups (same source+bill+chamber+date, >1 row): ${candidates.length} / ${candidateIds.length} rows`);

// ---- 3. fingerprint ONLY the candidates (the full cast table is ~1.5M rows) ----
const fingerprint = new Map();
const castCount = new Map();
const CHUNK = 40;                       // a larger `in` list overruns PostgREST's URL limit
for (let i = 0; i < candidateIds.length; i += CHUNK) {
  const ids = candidateIds.slice(i, i + CHUNK);
  // eslint-disable-next-line no-await-in-loop
  const { data, error } = await selectAll(client, 'vote_casts', 'vote_id,legislator_id,position', {
    filter: (q) => q.in('vote_id', ids), maxPages: 400,
  });
  if (error) throw new Error(`vote_casts: ${error.message}`);
  const grouped = new Map();
  for (const c of data) {
    if (!grouped.has(c.vote_id)) grouped.set(c.vote_id, []);
    grouped.get(c.vote_id).push(c);
  }
  for (const id of ids) {
    const casts = grouped.get(id) ?? [];
    castCount.set(id, casts.length);
    fingerprint.set(id, castFingerprint(casts));
  }
  if (!asJson && (i / CHUNK) % 25 === 0) log(`  fingerprinted ${Math.min(i + CHUNK, candidateIds.length)}/${candidateIds.length}`);
}

// ---- 4. within each candidate group, split by fingerprint, then apply the rule ----
const confirmed = [];
const refused = new Map();              // reason -> count of groups
for (const [key, rows] of candidates) {
  const byFp = new Map();
  for (const r of rows) {
    const fp = fingerprint.get(r.id);
    if (fp === '') continue;            // a zero-cast row is a different problem, never a dedup input
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(r);
  }
  for (const [, sameCasts] of byFp) {
    if (sameCasts.length < 2) continue;
    const verdict = confirmDuplicateGroup(sameCasts, { castCount: castCount.get(sameCasts[0].id) });
    if (!verdict.duplicate) { refused.set(verdict.reason, (refused.get(verdict.reason) ?? 0) + 1); continue; }
    const { canonical, superseded } = chooseCanonical(sameCasts);
    confirmed.push({
      key, url: verdict.url, result: verdict.result, casts: castCount.get(canonical.id),
      family: sourceFamily(canonical.source_key),
      canonical: { id: canonical.id, source_key: canonical.source_key },
      superseded: superseded.map((s) => ({ id: s.id, source_key: s.source_key })),
    });
  }
}

// ---- 5. never re-mark what is already marked ----
const { data: existing, error: eErr } = await selectAll(client, 'vote_duplicates', 'id,canonical_vote_id,superseded_vote_id,reason');
if (eErr) throw new Error(`vote_duplicates: ${eErr.message}`);
const alreadySuperseded = new Set(existing.map((r) => r.superseded_vote_id));
// Rows THIS rule wrote that it would no longer write. Scoped by the reason prefix so migration
// 0022's cross-source pairings can never be caught by it.
const confirmedSupersededIds = new Set(confirmed.flatMap((g) => g.superseded.map((s) => s.id)));
const stale = existing.filter((r) => String(r.reason ?? '').startsWith(SAME_SOURCE_REASON_PREFIX)
  && !confirmedSupersededIds.has(r.superseded_vote_id));
const pending = confirmed.flatMap((g) => g.superseded
  .filter((s) => !alreadySuperseded.has(s.id))
  .map((s) => ({ canonical_vote_id: g.canonical.id, superseded_vote_id: s.id, group: g })));

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  votes: votes.length,
  candidate_groups: candidates.length,
  confirmed_groups: confirmed.length,
  rows_to_supersede: pending.length,
  stale_rows_to_prune: stale.length,
  already_marked: confirmed.reduce((n, g) => n + g.superseded.length, 0) - pending.length,
  cast_floor: DEFAULT_CAST_FLOOR,
  refused_groups_by_reason: Object.fromEntries([...refused.entries()].sort((a, b) => b[1] - a[1])),
  by_family: confirmed.reduce((a, g) => { a[g.family] = (a[g.family] ?? 0) + g.superseded.length; return a; }, {}),
  by_year: Object.fromEntries(Object.entries(confirmed.reduce((a, g) => {
    const y = g.key.split('|')[3].slice(0, 4); a[y] = (a[y] ?? 0) + g.superseded.length; return a;
  }, {})).sort()),
};

if (asJson) {
  console.log(JSON.stringify({ ...summary, pairs: confirmed }, null, 2));
} else {
  console.log('');
  console.log(`mode                : ${summary.mode}`);
  console.log(`confirmed groups    : ${summary.confirmed_groups}`);
  console.log(`rows to supersede   : ${summary.rows_to_supersede}  (already marked: ${summary.already_marked})`);
  console.log(`STALE rows to prune : ${summary.stale_rows_to_prune}  (written by an earlier version of this rule, no longer confirmed — pruning RESTORES these votes to public view)`);
  console.log(`by family           : ${JSON.stringify(summary.by_family)}`);
  console.log(`by year             : ${JSON.stringify(summary.by_year)}`);
  console.log('refused groups (left untouched, by reason):');
  for (const [reason, n] of Object.entries(summary.refused_groups_by_reason)) console.log(`   ${String(n).padStart(4)}  ${reason}`);
  console.log('');
  console.log('pairs (canonical KEPT, superseded HIDDEN from public views):');
  for (const g of confirmed) {
    console.log(`   ${String(g.result).padEnd(8)} ${String(g.casts).padStart(3)} casts  ${g.url.slice(-46)}`);
    console.log(`      keep      ${g.canonical.source_key}`);
    for (const s of g.superseded) console.log(`      supersede ${s.source_key}${alreadySuperseded.has(s.id) ? '   (already marked)' : ''}`);
  }
}

if (!apply) {
  log('');
  log('DRY RUN — nothing written. --apply writes the confirmed pairs; add --prune to also delete');
  log('the stale rows an earlier version of this rule wrote (that restores hidden votes).');
  process.exit(0);
}

let pruned = 0;
if (prune) {
  for (const r of stale) {
    // eslint-disable-next-line no-await-in-loop
    const { error } = await client.from('vote_duplicates').delete().eq('id', r.id);
    if (error) throw new Error(`prune ${r.id}: ${error.message}`);
    pruned += 1;
  }
}

let written = 0;
for (const p of pending) {
  // eslint-disable-next-line no-await-in-loop
  await insertIfAbsent(client, 'vote_duplicates', [{
    canonical_vote_id: p.canonical_vote_id,
    superseded_vote_id: p.superseded_vote_id,
    reason: 'same-source duplicate: identical cast list, result, question and anchored source_url',
  }], 'superseded_vote_id');
  written += 1;
}
console.log(JSON.stringify({ mode: 'apply', superseded_rows_written: written, stale_rows_pruned: pruned }));
