export const WEEKLY_CAP_USD = 5.00;
export const PER_TICK_CAP_USD = 1.00;
export const MONSTER_THRESHOLD_CHARS = 100000;

// Downward-only env override (spec: "env-overridable DOWNWARD only ... a typo can shrink spend,
// never grow it") — mirror of envIntervalMs's floor-only discipline, inverted.
export function envCapUsd(envVar, defaultUsd) {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, defaultUsd) : defaultUsd;
}

// UTC ISO-8601 week key ('2026-W33') — Thursday-anchored per ISO 8601.
export function currentWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Weekly spend from ingestion_runs rows (caller pre-filters to source='scheduled-summaries',
// last 10 days). A row stranded at status='running' (crashed tick that never closed) is counted
// AS IF it spent the full per-tick allowance — unknown spend is treated as spent (spec).
export function summarizeWeekSpend(rows, weekKey, perTickCapUsd) {
  let spentUsd = 0;
  let crashedTicks = 0;
  for (const row of rows ?? []) {
    if (row.status === 'running') {
      spentUsd += perTickCapUsd;
      crashedTicks += 1;
      continue;
    }
    if (row.detail?.week_key === weekKey) spentUsd += Number(row.detail?.spent_usd) || 0;
  }
  return { spentUsd, crashedTicks };
}

export function tickAllowance({ weeklyCapUsd, weeklySpentUsd, perTickCapUsd }) {
  const remaining = weeklyCapUsd - weeklySpentUsd;
  return Math.max(0, Math.min(Number(remaining.toFixed(10)), perTickCapUsd));
}

// Recency-first ordering, ported from scripts/export-summary-wave.mjs (session start DESC →
// passage priority → text_length ASC; stable for ties).
export function sortQueueRecencyFirst(queue, sessionStartByBill) {
  return [...queue].sort((a, b) => {
    const sa = sessionStartByBill.get(a.bill_id) ?? '';
    const sb = sessionStartByBill.get(b.bill_id) ?? '';
    if (sa !== sb) return sb.localeCompare(sa);
    if (a.priority !== b.priority) return a.priority === 'passage' ? -1 : 1;
    return (a.text_length ?? Infinity) - (b.text_length ?? Infinity);
  });
}

// Draft-only reduction (same convention scripts/build-drain-wave.mjs applies: any
// published/approved row disqualifies the bill; last draft row wins) plus a rejected-attempt
// count for the spec's "skip ≥2 prior superseded/rejected attempts" rule.
export function computeDraftOnly(summaryRows) {
  const byBill = new Map();
  for (const s of summaryRows ?? []) {
    const list = byBill.get(s.bill_id) ?? [];
    list.push(s);
    byBill.set(s.bill_id, list);
  }
  const out = new Map();
  for (const [billId, rows] of byBill) {
    if (rows.some((r) => r.status === 'published' || r.status === 'approved')) continue;
    const drafts = rows.filter((r) => r.status === 'draft');
    if (drafts.length === 0) continue;
    out.set(billId, {
      draftRow: drafts[drafts.length - 1],
      rejectedCount: rows.filter((r) => r.status === 'rejected').length,
    });
  }
  return out;
}

// Lane assembly (spec order): fresh first, then conversions, then AT MOST ONE monster.
// Parked bills and conversions with >=2 prior rejected attempts never enter the tick.
export function assembleTick({ freshQueue, conversions, monsters, parkedIds }) {
  const out = [];
  for (const item of freshQueue ?? []) {
    if (!parkedIds.has(item.bill_id)) out.push({ lane: 'fresh', item });
  }
  for (const item of conversions ?? []) {
    if (parkedIds.has(item.bill_id)) continue;
    if (item.rejectedCount >= 2) continue;
    out.push({ lane: 'conversion', item });
  }
  for (const item of monsters ?? []) {
    if (parkedIds.has(item.bill_id)) continue;
    out.push({ lane: 'monster', item });
    break; // at most one per tick
  }
  return out;
}
