// Find roll calls attached to bills that never held them, and emit a full retraction MANIFEST.
//
// READ ONLY. This script never writes. Retracting requires a tombstone table (a migration, which is
// Lance's apply) so that a future audit can always answer "what happened to those LegiScan roll
// calls?" — the same non-destructive posture as persons/person_links (0012) and vote_duplicates
// (0022). Nothing here deletes anything.
//
// The defect it finds: LegiScan's 2023 MO dataset mints a SEPARATE roll_call_id per bill for one
// physical House floor vote. Three HB 10 roll calls are each stored 232 times against 232 different
// bills, with full cast lists. 196 bills display ONLY votes that were never cast on them.
//
// Why the detection is scoped by URL GRANULARITY (src/lib/source-url-granularity.js) rather than
// applied globally: a naive "same source_url + different bill_id" rule flags 1,101 live votes of
// which only 693 are real — 408 false positives, because a MO Senate journal PDF is one day's
// sitting and legitimately prints every roll call taken that day across every bill considered.
//
// Usage: node --env-file=.env scripts/find-misattributed-votes.mjs [--json] [--out <path>]
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getClient, selectAll } from '../src/lib/db.js';
import {
  classifySourceUrl, urlIdentifiesOneVote, assessSharedUrl, identifierFromQuestion,
} from '../src/lib/source-url-granularity.js';

const asJson = process.argv.includes('--json');
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : null;
const client = getClient();
if (!client) { console.log(JSON.stringify({ mode: 'blocked', reason: 'no DB client configured' })); process.exit(1); }
const log = (...a) => { if (!asJson) console.log(...a); };

const { data: votes, error } = await selectAll(client, 'votes',
  'id,bill_id,jurisdiction_id,chamber,vote_date,question,result,source_url,source_key');
if (error) throw new Error(`votes: ${error.message}`);
const { data: dupes } = await selectAll(client, 'vote_duplicates', 'superseded_vote_id');
const superseded = new Set((dupes ?? []).map((r) => r.superseded_vote_id));
const live = votes.filter((v) => !superseded.has(v.id));
const { data: bills } = await selectAll(client, 'bills', 'id,identifier,title,session_id');
const billById = new Map((bills ?? []).map((b) => [b.id, b]));
const identifierOf = (id) => billById.get(id)?.identifier ?? null;
log(`votes ${votes.length} | superseded ${superseded.size} | live ${live.length} | bills ${bills.length}`);

// ---- group live votes by exact source_url ----
const byUrl = new Map();
for (const v of live) {
  const u = String(v.source_url ?? '');
  if (!u) continue;
  if (!byUrl.has(u)) byUrl.set(u, []);
  byUrl.get(u).push(v);
}

// ---- PER_VOTE families: a shared URL across bills is the defect ----
const findings = [];
for (const [url, rows] of byUrl) {
  const verdict = assessSharedUrl(rows, { billIdentifierOf: identifierOf });
  if (!verdict.flagged) continue;
  findings.push({ url, rows, verdict, shape: classifySourceUrl(url).id });
}
findings.sort((a, b) => b.rows.length - a.rows.length);

// ---- cast fingerprints for the flagged rows, so the manifest states what is actually removed ----
const flaggedIds = findings.flatMap((f) => f.rows.map((r) => r.id));
const castCount = new Map();
const castFp = new Map();
for (let i = 0; i < flaggedIds.length; i += 40) {
  const ids = flaggedIds.slice(i, i + 40);
  // eslint-disable-next-line no-await-in-loop
  const { data, error: cErr } = await selectAll(client, 'vote_casts', 'vote_id,legislator_id,position', {
    filter: (q) => q.in('vote_id', ids), maxPages: 400,
  });
  if (cErr) throw new Error(`vote_casts: ${cErr.message}`);
  const g = new Map();
  for (const c of data ?? []) {
    if (!g.has(c.vote_id)) g.set(c.vote_id, []);
    g.get(c.vote_id).push(`${c.legislator_id}:${c.position}`);
  }
  for (const id of ids) {
    const list = (g.get(id) ?? []).sort();
    castCount.set(id, list.length);
    castFp.set(id, createHash('sha1').update(list.join('|')).digest('hex').slice(0, 12));
  }
}

// ---- build the manifest ----
const manifest = [];
for (const f of findings) {
  const named = [...new Set(f.rows.map((r) => identifierFromQuestion(r.question)).filter(Boolean))];
  const presentIdentifiers = new Set(f.rows.map((r) => identifierOf(r.bill_id)).filter(Boolean));
  const signatures = [...new Set(f.rows.map((r) => castFp.get(r.id)))];

  let keep = null;
  let confidence = 'ambiguous';
  let rationale;
  if (f.verdict.reason === 'duplicate_bill_rows') {
    confidence = 'not_a_vote_defect';
    rationale = 'Both rows name the SAME bill identifier — the `bills` table holds duplicate rows for '
      + 'one bill (TODO 25, the known duplicate-MO-session defect). Retracting a vote is the WRONG repair here; '
      + 'the bill rows are what must be merged. Listed so it is not silently swept in with the vote defect.';
  } else if (named.length === 1 && presentIdentifiers.has(named[0])) {
    keep = f.rows.find((r) => identifierOf(r.bill_id) === named[0]) ?? null;
    confidence = 'question_text_corroborated';
    rationale = `Every copy's question names ${named[0]}, and a row for ${named[0]} is present in the group. `
      + 'The document is one physical roll call; the other rows attach it to bills it was never cast on.';
  } else if (named.length > 1) {
    rationale = `Copies name DIFFERENT bills (${named.join(', ')}) — each row claims its own bill, so the `
      + 'question text cannot arbitrate. NEEDS HUMAN REVIEW against the source document before any retraction.';
  } else {
    rationale = 'No bill identifier could be parsed from any question. NEEDS HUMAN REVIEW.';
  }

  const removed = keep ? f.rows.filter((r) => r.id !== keep.id) : [];
  manifest.push({
    source_url: f.url,
    url_shape: f.shape,
    finding: f.verdict.reason,
    confidence,
    rationale,
    vote_date: String(f.rows[0].vote_date ?? '').slice(0, 10),
    result: f.rows[0].result,
    questions: [...new Set(f.rows.map((r) => String(r.question ?? '')))],
    bill_named_by_question: named,
    distinct_cast_signatures: signatures.length,
    cast_signature: signatures[0] ?? null,
    total_rows: f.rows.length,
    kept_vote_id: keep?.id ?? null,
    kept_bill_id: keep?.bill_id ?? null,
    kept_bill_identifier: keep ? identifierOf(keep.bill_id) : null,
    kept_source_key: keep?.source_key ?? null,
    retract_count: removed.length,
    cast_count_removed: removed.reduce((n, r) => n + (castCount.get(r.id) ?? 0), 0),
    retract: removed.map((r) => ({
      vote_id: r.id,
      bill_id: r.bill_id,
      bill_identifier: identifierOf(r.bill_id),
      source_key: r.source_key,
      legiscan_roll_call_id: (/-rollcall-(\d+)$/.exec(String(r.source_key ?? '')) || [])[1] ?? null,
      casts: castCount.get(r.id) ?? 0,
    })),
  });
}

// ---- Codex item 3: the same sweep across CONTAINER families, where a fan-out could still hide ----
// A container legitimately holds many bills. What would NOT be legitimate is many DIFFERENT bills
// sharing one identical cast signature inside it — that is the HB 10 shape wearing a container URL.
const containerSuspects = [];
const containerUrls = [...byUrl.entries()].filter(([u, rows]) => !urlIdentifiesOneVote(u) && rows.length > 1);
const containerIds = containerUrls.flatMap(([, rows]) => rows.map((r) => r.id));
const cFp = new Map();
for (let i = 0; i < containerIds.length; i += 40) {
  const ids = containerIds.slice(i, i + 40);
  // eslint-disable-next-line no-await-in-loop
  const { data } = await selectAll(client, 'vote_casts', 'vote_id,legislator_id,position', {
    filter: (q) => q.in('vote_id', ids), maxPages: 400,
  });
  const g = new Map();
  for (const c of data ?? []) {
    if (!g.has(c.vote_id)) g.set(c.vote_id, []);
    g.get(c.vote_id).push(`${c.legislator_id}:${c.position}`);
  }
  for (const id of ids) {
    const list = (g.get(id) ?? []).sort();
    cFp.set(id, list.length === 0 ? 'EMPTY' : createHash('sha1').update(list.join('|')).digest('hex').slice(0, 12));
  }
}
for (const [url, rows] of containerUrls) {
  const bySig = new Map();
  for (const r of rows) {
    const s = cFp.get(r.id);
    if (s === 'EMPTY') continue;
    if (!bySig.has(s)) bySig.set(s, []);
    bySig.get(s).push(r);
  }
  for (const [sig, group] of bySig) {
    const distinctBills = new Set(group.map((r) => r.bill_id));
    // >2 different bills sharing ONE cast signature inside a container is the fan-out shape.
    if (distinctBills.size > 2) {
      containerSuspects.push({
        source_url: url, cast_signature: sig, rows: group.length, distinct_bills: distinctBills.size,
        identifiers: [...new Set(group.map((r) => identifierOf(r.bill_id)))].slice(0, 8),
        date: String(group[0].vote_date ?? '').slice(0, 10), result: group[0].result,
      });
    }
  }
}

const summary = {
  generated_against: { votes: votes.length, live: live.length, bills: bills.length },
  per_vote_findings: manifest.length,
  rows_proposed_for_retraction: manifest.reduce((n, m) => n + m.retract_count, 0),
  casts_proposed_for_retraction: manifest.reduce((n, m) => n + m.cast_count_removed, 0),
  by_confidence: manifest.reduce((a, m) => { a[m.confidence] = (a[m.confidence] ?? 0) + 1; return a; }, {}),
  container_family_suspects: containerSuspects.length,
};

if (asJson || outPath) {
  const payload = JSON.stringify({ summary, manifest, container_suspects: containerSuspects }, null, 2);
  if (outPath) { writeFileSync(outPath, payload); log(`\nmanifest written: ${outPath}`); }
  if (asJson) console.log(payload);
}

if (!asJson) {
  console.log('');
  console.log('=== PER-VOTE DOCUMENT FINDINGS (a URL that names ONE roll call, attached to several bills) ===');
  for (const m of manifest) {
    console.log('');
    console.log(`  ${m.source_url.slice(-46)}   [${m.url_shape}]`);
    console.log(`    ${m.vote_date}  ${String(m.result).padEnd(8)}  rows ${m.total_rows}  cast signatures ${m.distinct_cast_signatures}`);
    console.log(`    finding    : ${m.finding}`);
    console.log(`    confidence : ${m.confidence}`);
    console.log(`    keep       : ${m.kept_bill_identifier ?? '(undetermined — nothing proposed)'}${m.kept_source_key ? `  ${m.kept_source_key}` : ''}`);
    console.log(`    retract    : ${m.retract_count} vote rows, ${m.cast_count_removed} casts`);
    console.log(`    rationale  : ${m.rationale}`);
    if (m.retract_count && m.retract_count <= 3) {
      for (const r of m.retract) console.log(`        - ${String(r.bill_identifier).padEnd(9)} ${r.source_key} (${r.casts} casts)`);
    }
  }
  console.log('');
  console.log('=== CONTAINER-FAMILY SWEEP (could a fan-out hide inside a multi-vote document?) ===');
  if (containerSuspects.length === 0) {
    console.log('  none — no container URL has >2 distinct bills sharing one identical cast signature.');
  } else {
    for (const s of containerSuspects) {
      console.log(`  ${s.source_url.slice(-46)} | ${s.rows} rows / ${s.distinct_bills} bills | ${s.date} ${s.result} | ${s.identifiers.join(', ')}`);
    }
  }
  console.log('');
  console.log(JSON.stringify(summary, null, 2));
  console.log('');
  console.log('READ ONLY — nothing was written. Retraction needs a tombstone table (migration, Lance applies).');
}
