// Retract votes stored against a bill that never held them. Tombstones first, then deletes.
//
// Dry-run by default; --apply writes. Requires migration 0033 (retracted_votes) — refuses loudly if
// it is not applied rather than deleting anything without somewhere to record it.
//
// It REGENERATES the manifest from the live database every run rather than reading a saved file: a
// manifest on disk goes stale the moment the scheduler ticks, and deleting from a stale manifest
// would delete by id something that may no longer be what it was.
//
// SAFETY PROPERTIES, in the order they matter:
//   1. Only entries the detector rates `question_text_corroborated` are ever touched — the ones
//      where every copy's own question text names one bill and that bill is present in the group.
//      `ambiguous` and `not_a_vote_defect` entries are reported and skipped, always.
//   2. The tombstone (with the COMPLETE cast list) is written and verified BEFORE anything is
//      deleted. If the tombstone write fails, nothing is deleted.
//   3. Casts are deleted before the vote row (foreign key order), and the vote row is deleted only
//      after its casts are gone.
//   4. Re-runnable: a vote already tombstoned is skipped.
//   5. --limit N stops after N vote rows, so the first real run can be a single row inspected by
//      hand before the remaining 692.
//
// Usage: node --env-file=.env scripts/retract-misattributed-votes.mjs [--apply] [--limit N]
import { createHash } from 'node:crypto';
import { getClient, selectAll } from '../src/lib/db.js';
// Imported from the LIBRARY, never from find-misattributed-votes.mjs: that file is a top-level
// script, so importing it would run its entire database sweep as an import side effect.
import {
  classifySourceUrl, assessSharedUrl, identifierFromQuestion,
} from '../src/lib/source-url-granularity.js';

const apply = process.argv.includes('--apply');
const limIdx = process.argv.indexOf('--limit');
const limit = limIdx !== -1 ? Number(process.argv[limIdx + 1]) : Infinity;
const client = getClient();
if (!client) { console.log(JSON.stringify({ mode: 'blocked', reason: 'no DB client configured' })); process.exit(1); }

// ---- gate: migration 0033 must be applied ----
// Sets process.exitCode and lets the module end on its own rather than calling process.exit():
// exiting hard while the Supabase client still holds open handles trips a libuv assertion on
// Windows, and a stack trace on the SAFETY path is the last thing an operator should see when the
// script is behaving correctly.
const probe = await client.from('retracted_votes').select('id').limit(1);
const blocked = Boolean(probe.error);
if (blocked) {
  console.log(JSON.stringify({
    mode: 'blocked',
    reason: 'migration 0033 (retracted_votes) is not applied — refusing to delete votes with nowhere to record them',
    detail: probe.error.message,
  }, null, 2));
  process.exitCode = 1;
}

if (!blocked) {
  await run();
}

async function run() {

const { data: votes, error } = await selectAll(client, 'votes',
  'id,bill_id,jurisdiction_id,chamber,vote_date,question,result,source_url,source_key');
if (error) throw new Error(`votes: ${error.message}`);
const { data: dupes } = await selectAll(client, 'vote_duplicates', 'superseded_vote_id');
const superseded = new Set((dupes ?? []).map((r) => r.superseded_vote_id));
const live = votes.filter((v) => !superseded.has(v.id));
const { data: bills } = await selectAll(client, 'bills', 'id,identifier');
const identifierOf = (id) => (bills ?? []).find((b) => b.id === id)?.identifier ?? null;

const byUrl = new Map();
for (const v of live) {
  const u = String(v.source_url ?? '');
  if (!u) continue;
  if (!byUrl.has(u)) byUrl.set(u, []);
  byUrl.get(u).push(v);
}

const planned = [];
const skipped = [];
for (const [url, rows] of byUrl) {
  const verdict = assessSharedUrl(rows, { billIdentifierOf: identifierOf });
  if (!verdict.flagged) continue;
  if (verdict.reason !== 'multiple_bills_on_one_vote_document') {
    skipped.push({ url, reason: verdict.reason, rows: rows.length }); continue;
  }
  const named = [...new Set(rows.map((r) => identifierFromQuestion(r.question)).filter(Boolean))];
  const present = new Set(rows.map((r) => identifierOf(r.bill_id)).filter(Boolean));
  if (named.length !== 1 || !present.has(named[0])) {
    skipped.push({ url, reason: 'ambiguous — question text cannot arbitrate; needs human review', rows: rows.length });
    continue;
  }
  const keep = rows.find((r) => identifierOf(r.bill_id) === named[0]);
  for (const r of rows) {
    if (r.id === keep.id) continue;
    planned.push({
      row: r, url, keptBill: named[0], keptVoteId: keep.id, keptSourceKey: keep.source_key,
      shape: classifySourceUrl(url).id,
    });
  }
}

// already tombstoned?
const { data: existingTombs } = await selectAll(client, 'retracted_votes', 'vote_id');
const tombstoned = new Set((existingTombs ?? []).map((r) => r.vote_id));
const todo = planned.filter((p) => !tombstoned.has(p.row.id)).slice(0, limit);

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  live_votes: live.length,
  planned_retractions: planned.length,
  already_tombstoned: planned.length - planned.filter((p) => !tombstoned.has(p.row.id)).length,
  this_run: todo.length,
  skipped_groups: skipped,
}, null, 2));

if (!apply) {
  console.log('\nDRY RUN — nothing written or deleted. Re-run with --apply (consider --limit 1 first).');
  return;
}

let done = 0;
for (const p of todo) {
  const v = p.row;
  // eslint-disable-next-line no-await-in-loop
  const { data: casts, error: cErr } = await selectAll(client, 'vote_casts', 'id,legislator_id,position', {
    filter: (q) => q.eq('vote_id', v.id), maxPages: 50,
  });
  if (cErr) throw new Error(`casts for ${v.id}: ${cErr.message}`);
  const castPayload = (casts ?? []).map((c) => ({ legislator_id: c.legislator_id, position: c.position }));

  // 1. tombstone FIRST, with the complete cast list, and read it back before deleting anything.
  // eslint-disable-next-line no-await-in-loop
  const { error: tErr } = await client.from('retracted_votes').insert({
    vote_id: v.id,
    bill_id: v.bill_id,
    bill_identifier: identifierOf(v.bill_id),
    jurisdiction_id: v.jurisdiction_id,
    chamber: v.chamber,
    vote_date: v.vote_date,
    question: v.question,
    result: v.result,
    source_url: v.source_url,
    source_key: v.source_key,
    casts: castPayload,
    cast_count: castPayload.length,
    reason: 'misattributed: this source document names one roll call, and its own question text names a different bill',
    evidence: {
      url_shape: p.shape,
      bill_named_by_question: p.keptBill,
      kept_vote_id: p.keptVoteId,
      kept_source_key: p.keptSourceKey,
      cast_signature: createHash('sha1').update(castPayload.map((c) => `${c.legislator_id}:${c.position}`).sort().join('|')).digest('hex').slice(0, 12),
      detector: 'scripts/find-misattributed-votes.mjs',
    },
  });
  if (tErr) throw new Error(`tombstone ${v.id}: ${tErr.message} — NOTHING deleted for this row`);

  // eslint-disable-next-line no-await-in-loop
  const verify = await client.from('retracted_votes').select('vote_id,cast_count').eq('vote_id', v.id).maybeSingle();
  if (verify.error || !verify.data || verify.data.cast_count !== castPayload.length) {
    throw new Error(`tombstone verification failed for ${v.id} — refusing to delete`);
  }

  // 2. casts, then the vote row (FK order).
  // eslint-disable-next-line no-await-in-loop
  const { error: dcErr } = await client.from('vote_casts').delete().eq('vote_id', v.id);
  if (dcErr) throw new Error(`delete casts ${v.id}: ${dcErr.message}`);
  // eslint-disable-next-line no-await-in-loop
  const { error: dvErr } = await client.from('votes').delete().eq('id', v.id);
  if (dvErr) throw new Error(`delete vote ${v.id}: ${dvErr.message}`);

  done += 1;
  if (done % 50 === 0) console.log(`  retracted ${done}/${todo.length}`);
}
console.log(JSON.stringify({ mode: 'apply', retracted: done }));
}
