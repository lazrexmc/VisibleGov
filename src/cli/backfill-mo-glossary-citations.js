import { parseMoCitation, normalizeMoCitation } from '../adapters/mo-statutes.js';

const isStub = (t) => t.gloss_md == null && !t.hasVerifications && !t.hasNotes;

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
      || a.row.created_at.localeCompare(b.row.created_at)
      || a.row.id.localeCompare(b.row.id));
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
