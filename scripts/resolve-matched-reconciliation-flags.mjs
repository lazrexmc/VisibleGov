// Resolve `no_tally_corresponding_primary` reconciliation flags whose LegiScan roll call has SINCE
// been matched to a primary-source vote (a vote_duplicates pairing written by ingest-legiscan's
// cross-check on a later run). Nothing in the ingest path resolves an already-minted flag when its
// missing primary later arrives — migration 0011 deliberately keeps a resolved flag from re-minting,
// and flags are written additively, never updated — so after the MO Senate journal replay
// (2026-08-23) the "LegiScan vs mo-senate-web" flags stay open even once every one of them has a
// canonical journal twin. This resolves exactly that mechanical case and nothing else:
//
//   flag.discrepancy->>reason = 'no_tally_corresponding_primary' AND flag.resolved = false
//   AND the LegiScan vote for flag.discrepancy->>roll_call_id (source_key
//       'legiscan-<session>-rollcall-<id>') is the superseded side of a vote_duplicates row
//
// Row shape (migration 0010): vote_id (the PRIMARY vote the LegiScan tallies were compared
// against), source_a 'legiscan', source_b, discrepancy jsonb (carries roll_call_id + reason —
// writeReconciliationFlag), resolved boolean. There is no note column, so the resolution is
// recorded ADDITIVELY inside discrepancy under `resolution` (original keys untouched) and the
// pairing itself stays in vote_duplicates forever. Dry-run by default; --apply writes. Never deletes.
//
// Usage: node --env-file=.env scripts/resolve-matched-reconciliation-flags.mjs [--apply]
import { getClient, selectAll } from '../src/lib/db.js';

const apply = process.argv.includes('--apply');
const client = getClient();
if (!client) { console.log(JSON.stringify({ mode: 'blocked', reason: 'no DB client configured' })); process.exit(1); }

const { data: flags, error: flagErr } = await selectAll(client, 'vote_reconciliation_flags', 'id,vote_id,source_b,discrepancy,resolved,created_at', {
  filter: (q) => q.eq('resolved', false).eq('discrepancy->>reason', 'no_tally_corresponding_primary'),
});
if (flagErr) throw new Error(`flags: ${flagErr.message}`);

const { data: legiscanVotes, error: lvErr } = await selectAll(client, 'votes', 'id,source_key', {
  filter: (q) => q.like('source_key', 'legiscan-%-rollcall-%'),
});
if (lvErr) throw new Error(`legiscan votes: ${lvErr.message}`);
const legiscanVoteByRollCall = new Map();
for (const v of legiscanVotes) {
  const m = /-rollcall-(\d+)$/.exec(v.source_key);
  if (m) legiscanVoteByRollCall.set(m[1], v.id);
}

const { data: pairs, error: pairErr } = await selectAll(client, 'vote_duplicates', 'canonical_vote_id,superseded_vote_id,reason', { orderBy: 'superseded_vote_id' });
if (pairErr) throw new Error(`vote_duplicates: ${pairErr.message}`);
const pairBySuperseded = new Map(pairs.map((p) => [p.superseded_vote_id, p]));

const resolvable = [];
let noLegiscanVote = 0;
for (const f of flags) {
  const rollCallId = String(f.discrepancy?.roll_call_id ?? '');
  const legiscanVoteId = legiscanVoteByRollCall.get(rollCallId);
  if (!legiscanVoteId) { noLegiscanVote += 1; continue; }
  const pair = pairBySuperseded.get(legiscanVoteId);
  if (pair) resolvable.push({ flag: f, legiscanVoteId, pair });
}
const bySource = {};
for (const r of resolvable) bySource[r.flag.source_b] = (bySource[r.flag.source_b] ?? 0) + 1;
console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  open_no_tally_flags: flags.length,
  legiscan_votes_stored: legiscanVotes.length,
  flags_without_a_stored_legiscan_vote: noLegiscanVote,
  vote_duplicates_rows: pairs.length,
  resolvable: resolvable.length,
  resolvable_by_source_b: bySource,
  sample: resolvable.slice(0, 5).map((r) => ({ flag: r.flag.id, roll_call_id: r.flag.discrepancy.roll_call_id, legiscan_vote: r.legiscanVoteId, canonical: r.pair.canonical_vote_id })),
}, null, 2));

if (!apply) process.exit(0);
let written = 0;
for (const r of resolvable) {
  const discrepancy = {
    ...r.flag.discrepancy,
    resolution: {
      method: 'auto: a primary-source vote now corresponds (vote_duplicates pairing)',
      at: new Date().toISOString(),
      legiscan_vote_id: r.legiscanVoteId,
      canonical_vote_id: r.pair.canonical_vote_id,
      pairing_reason: r.pair.reason,
    },
  };
  const { error } = await client.from('vote_reconciliation_flags').update({ resolved: true, discrepancy }).eq('id', r.flag.id).eq('resolved', false);
  if (error) throw new Error(`update ${r.flag.id}: ${error.message}`);
  written += 1;
}
console.log(JSON.stringify({ mode: 'apply', resolved: written }));
