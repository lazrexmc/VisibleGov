import { parseMoCitation, normalizeMoCitation } from '../adapters/mo-statutes.js';
import { getClient, selectAll, openRun, closeRun, insertIfAbsent } from '../lib/db.js';

const isStub = (t) => t.gloss_md == null && !t.hasVerifications && !t.hasNotes;

// Strict codepoint comparison, not String.prototype.localeCompare — locale/implementation-defined
// collation would let survivor selection vary by runtime/locale, breaking the spec §6 promise of
// fully deterministic tie-breaking on created_at then id.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function planMoCitationBackfill({ terms, linksByTermId, jurisdictionBySummaryId }) {
  const skips = { parseFailed: 0, guardBlocked: 0, zeroLinks: 0, stubViolations: [] };
  // Group candidates by (kind, normalized citation); pre-seed groups with existing mapped rows
  // so a collision with a mapped row always keeps the mapped row as survivor.
  const groups = new Map(); // key -> {mapped: row|null, candidates: [{row, links}]}
  const keyOf = (kind, citation) => `${kind}|${citation}`;
  for (const t of terms) {
    if (!t.needs_mapping && t.citation) {
      const key = keyOf(t.kind, t.citation);
      if (!groups.has(key)) groups.set(key, { mapped: t, candidates: [] });
      else groups.get(key).mapped = t;
    }
  }
  for (const t of terms) {
    if (!t.needs_mapping) continue;
    const parsed = parseMoCitation(t.term);
    if (!parsed) { skips.parseFailed += 1; continue; }
    const links = linksByTermId.get(t.id) ?? [];
    if (links.length === 0) { skips.zeroLinks += 1; continue; }
    const juris = new Set(links.map((sid) => jurisdictionBySummaryId.get(sid)));
    if (juris.size !== 1 || !juris.has('mo-legislature')) { skips.guardBlocked += 1; continue; }
    const key = keyOf(t.kind, normalizeMoCitation(parsed));
    if (!groups.has(key)) groups.set(key, { mapped: null, candidates: [] });
    groups.get(key).candidates.push({ row: t, links });
  }

  const updates = [];
  const merges = [];
  for (const [key, group] of groups) {
    if (group.candidates.length === 0) continue;
    const citation = key.slice(key.indexOf('|') + 1);
    // Deterministic survivor (spec §6): existing mapped row wins outright; otherwise most
    // links, tie -> earliest created_at, tie -> lexicographically smallest id.
    const ranked = [...group.candidates].sort((a, b) =>
      (b.links.length - a.links.length)
      || cmp(a.row.created_at, b.row.created_at)
      || cmp(a.row.id, b.row.id));
    let survivor;
    if (group.mapped) survivor = group.mapped;
    else {
      survivor = ranked.shift().row;
      updates.push({ id: survivor.id, term: survivor.term, citation });
    }
    for (const { row, links } of ranked) {
      if (!isStub(row)) {
        skips.stubViolations.push({ id: row.id, term: row.term, reason: 'loser row is not a bare stub (has gloss/verifications/notes) — never merged' });
        continue;
      }
      merges.push({ survivorId: survivor.id, loserId: row.id, citation, linkMoves: links });
    }
  }
  return { updates, merges, skips };
}

// ---- fetch (Task 7): pull every input planMoCitationBackfill needs from the live DB ----

// selectAll returns {data, error} (never a bare array — see src/lib/db.js's own header and every
// other call site in this codebase, e.g. gloss.js's loadAllTerms, backfill-mo-term-dates.js's
// loadDatelessMoTerms); this local helper destructures and fails loud, the same convention those
// call sites use, so every one of the seven reads below stays a one-liner at the call site.
async function loadAll(client, table, columns) {
  const { data, error } = await selectAll(client, table, columns);
  if (error) throw new Error(`backfill-mo-glossary-citations: ${table} load failed: ${error.message}`);
  return data;
}

export async function fetchBackfillInputs(client) {
  // All unbounded reads via selectAll (pagination-enforcement test scans this file).
  const terms = await loadAll(client, 'glossary_terms', 'id,term,kind,citation,needs_mapping,gloss_md,created_at');
  const links = await loadAll(client, 'summary_terms', 'summary_id,term_id');
  const summaries = await loadAll(client, 'summaries', 'id,bill_id');
  const bills = await loadAll(client, 'bills', 'id,session_id');
  const sessions = await loadAll(client, 'sessions', 'id,jurisdiction_id');
  const verifs = await loadAll(client, 'glossary_verifications', 'term_id');
  const notes = await loadAll(client, 'glossary_notes', 'term_id');

  const verifSet = new Set(verifs.map((v) => v.term_id));
  const noteSet = new Set(notes.map((n) => n.term_id));
  const decorated = terms.map((t) => ({ ...t, hasVerifications: verifSet.has(t.id), hasNotes: noteSet.has(t.id) }));

  const juriBySession = new Map(sessions.map((s) => [s.id, s.jurisdiction_id]));
  const juriByBill = new Map(bills.map((b) => [b.id, juriBySession.get(b.session_id)]));
  const jurisdictionBySummaryId = new Map(summaries.map((s) => [s.id, juriByBill.get(s.bill_id)]));

  const linksByTermId = new Map();
  for (const l of links) {
    if (!linksByTermId.has(l.term_id)) linksByTermId.set(l.term_id, []);
    linksByTermId.get(l.term_id).push(l.summary_id);
  }
  return { terms: decorated, linksByTermId, jurisdictionBySummaryId };
}

// ---- execute (Task 7): apply a plan's updates then merges, guarded against concurrent writes ----

export async function executeBackfillPlan(client, runId, plan) {
  const result = { updated: 0, merged: 0, skipped: [] };
  // Order matters: updates before merges. A crash between the two loops re-plans cleanly on the
  // next run — an already-updated survivor drops out of the needs_mapping=true scan, and a
  // stranded loser (linked to a survivor now mapped) simply re-plans as a collision with a mapped
  // row on the next dry-run/apply pass.
  for (const u of plan.updates) {
    // .is('citation', null) is the concurrent-write guard: a row someone else already mapped
    // is silently skipped, not clobbered. Count via returned rows, never `count` (PLAYBOOK
    // lesson 20 — this backend never populates count on .update().select()).
    // eslint-disable-next-line no-await-in-loop -- sequential writes, small per-run batch
    const { data, error } = await client.from('glossary_terms')
      .update({ citation: u.citation, needs_mapping: false })
      .eq('id', u.id).is('citation', null).select('id');
    if (error) throw new Error(`update failed for ${u.id} (${u.citation}): ${error.message}`);
    if ((data ?? []).length === 1) result.updated += 1;
    else result.skipped.push({ id: u.id, reason: 'update matched no citation-null row (already mapped?)' });
  }
  for (const m of plan.merges) {
    // Live stub re-verification before the deletion (spec §6) — planning data may be stale: a
    // concurrent write between planning and execute could have turned a bare stub into a real
    // glossary entry (gloss_md/verifications/notes), or already mapped the loser's citation.
    // eslint-disable-next-line no-await-in-loop -- sequential writes, small per-run batch
    const { data: loser, error: loserErr } = await client.from('glossary_terms')
      .select('id,gloss_md').eq('id', m.loserId).is('citation', null).maybeSingle();
    if (loserErr) throw new Error(`loser lookup failed for ${m.loserId}: ${loserErr.message}`);
    if (!loser) { result.skipped.push({ id: m.loserId, reason: 'loser row gone or already mapped' }); continue; }
    // eslint-disable-next-line no-await-in-loop -- sequential writes, small per-run batch
    const { data: vRows, error: vErr } = await client.from('glossary_verifications').select('id').eq('term_id', m.loserId);
    if (vErr) throw new Error(`verification check failed for ${m.loserId}: ${vErr.message}`);
    // Controller ruling: the live pre-delete re-verification must check glossary_notes too, not
    // just gloss_md/glossary_verifications — this matches the planning core's own isStub
    // definition (gloss/verifications/notes) exactly; without it a loser that only picked up a
    // note between planning and execute would still be deleted.
    // eslint-disable-next-line no-await-in-loop -- sequential writes, small per-run batch
    const { data: nRows, error: nErr } = await client.from('glossary_notes').select('id').eq('term_id', m.loserId);
    if (nErr) throw new Error(`notes check failed for ${m.loserId}: ${nErr.message}`);
    if (loser.gloss_md != null || (vRows ?? []).length > 0 || (nRows ?? []).length > 0) {
      result.skipped.push({ id: m.loserId, reason: 'loser is not a bare stub at execute time — merge aborted' });
      continue;
    }
    for (const summaryId of m.linkMoves) {
      // eslint-disable-next-line no-await-in-loop -- sequential writes, small per-run batch
      await insertIfAbsent(client, 'summary_terms', [{ summary_id: summaryId, term_id: m.survivorId }], 'summary_id,term_id');
    }
    const { error: linkDelErr } = await client.from('summary_terms').delete().eq('term_id', m.loserId);
    if (linkDelErr) throw new Error(`link delete failed for ${m.loserId}: ${linkDelErr.message}`);
    // Same concurrent-write discipline as the update loop above: a delete that matched zero rows
    // (the .is('citation', null) guard blocked it — someone else mapped this loser between the
    // live stub re-check above and this delete, e.g. two overlapping --apply invocations) must
    // never silently count as a completed merge. Count via returned rows, never `count` (lesson
    // 20). The loser's links were already repointed to the survivor above, so this is reported
    // honestly rather than retried or rolled back — the next plan/apply cycle will see the loser
    // still present and either merge it again or, if it's genuinely now mapped, leave it alone.
    const { data: delData, error: delErr } = await client.from('glossary_terms')
      .delete().eq('id', m.loserId).is('citation', null).select('id');
    if (delErr) throw new Error(`loser delete failed for ${m.loserId}: ${delErr.message}`);
    if ((delData ?? []).length === 1) result.merged += 1;
    else {
      result.skipped.push({
        id: m.loserId,
        reason: 'loser delete matched no citation-null row (concurrently mapped?) — links already repointed to survivor',
      });
    }
  }
  return result;
}

// ---- CLI entry point ----

const SOURCE = 'backfill-mo-glossary-citations';

export async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }
  const inputs = await fetchBackfillInputs(client);
  const plan = planMoCitationBackfill(inputs);
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    updates: plan.updates.length,
    merges: plan.merges.length,
    skips: { ...plan.skips, stubViolations: plan.skips.stubViolations.length },
  };
  if (!apply) {
    console.log(JSON.stringify({ ...summary, updateList: plan.updates, mergeList: plan.merges, stubViolations: plan.skips.stubViolations }, null, 2));
    return;
  }
  const runId = await openRun(client, SOURCE);
  try {
    const result = await executeBackfillPlan(client, runId, plan);
    await closeRun(client, runId, 'succeeded', { ...summary, ...result, skipped: result.skipped });
    console.log(JSON.stringify({ ...summary, ...result }, null, 2));
  } catch (err) {
    await closeRun(client, runId, 'failed', { ...summary, error: err.message });
    throw err;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
