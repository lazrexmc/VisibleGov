// site/js/trust-page.js — site/trust.html's entry point (Task 10 of the public-site plan,
// .superpowers/sdd/2026-07-30-public-site/task-10-brief.md). Browser-native ES module.
//
// This is the trust page — the product's moat: it explains, in plain prose, how every fact on
// this site gets here. The static narrative sections (#pipeline, #flags, #attribution) are
// authored directly in trust.html as plain HTML — CLAUDE.md's facts-only rule applies to that
// prose exactly as it does everywhere else on the site (mechanics only, never a superlative or a
// claim the ledger can't back), but it isn't DB-sourced, so it doesn't need to route through
// el()'s DB-text guard (design-spec §1's rule is specifically about DB strings never being parsed
// as markup; static, hand-authored copy carries the same trust level as any other markup already
// in the file). This module owns exactly the parts of the page that ARE either DB-sourced or a
// verbatim-render contract of another module's exported data:
//   - #metrics: loops vote-charts.js's own METRIC_DEFINITIONS verbatim — the single-source
//     contract (that module's own header comment): Task 10 renders what it exports, never a
//     paraphrase, and every key (including the `staleness` disclosure, same {title, body} shape)
//     goes through the SAME loop, no special-casing it out.
//   - #freshness: the FULL public_freshness table (source, status, finished date, quarantined-day
//     count) — unlike person-page.js's own freshness box, which narrows to a profile's relevant
//     jurisdictions, this renders every row the view returns.
//   - #counts: five live countOnly() numbers (vote casts, bills, legislators, published
//     summaries, published glossary terms) — "live from the same database the site reads."
//
// Three-state discipline (plan law, same as every other page): #freshness and #counts are each
// independently three-stated via sectionState() — loading / failed ('couldn't load — retry',
// never rendered as an empty section) / empty (freshness only — countOnly always returns a
// number, so #counts has no genuine empty case) / ready.

import { restGet, countOnly } from './rest.js';
import {
  el, clearChildren, sectionState, mountFooter,
} from './render.js';
import { METRIC_DEFINITIONS } from './vote-charts.js';

// ============================================================================
// #metrics — renders METRIC_DEFINITIONS verbatim (Object.values preserves the module's own
// declared key order: distribution, partyComparison, cohesion, staleness — all four, every time).
// ============================================================================
export function renderMetricDefinitions(container) {
  clearChildren(container);
  for (const def of Object.values(METRIC_DEFINITIONS)) {
    const block = el('div', { class: 'metric-definition' });
    block.appendChild(el('h3', {}, def.title));
    block.appendChild(el('p', {}, def.body));
    container.appendChild(block);
  }
}

// ============================================================================
// #counts — pure assembly (COUNT_SPECS) kept independently testable from the fetch/render below,
// same split as vote-charts.js's own pure-math-vs-DOM separation. summaries/glossary_terms carry
// the SAME status=eq.published filter bill-page.js/person-page.js already use (RLS also enforces
// it — anon_read_published, migrations 0001/0007 — this is belt-and-braces, matching convention,
// not a new rule).
// ============================================================================
export const COUNT_SPECS = [
  { key: 'voteCasts', label: 'Vote casts', path: 'vote_casts?select=id' },
  { key: 'bills', label: 'Bills', path: 'bills?select=id' },
  { key: 'legislators', label: 'Legislators', path: 'legislators?select=id' },
  { key: 'summaries', label: 'Published summaries', path: 'summaries?select=id&status=eq.published' },
  {
    key: 'glossaryTerms', label: 'Published glossary terms', path: 'glossary_terms?select=id&status=eq.published',
  },
];

function renderCounts(container, results) {
  clearChildren(container);
  const list = el('ul', { class: 'counts-list' });
  for (const { label, value } of results) {
    const li = el('li', {});
    li.appendChild(el('span', { class: 'counts-label' }, label));
    li.appendChild(el('span', { class: 'counts-value' }, ` — ${value}`));
    list.appendChild(li);
  }
  container.appendChild(list);
}

export async function loadCountsSection(container) {
  sectionState(container, { state: 'loading' });
  try {
    const results = await Promise.all(
      COUNT_SPECS.map(async (spec) => ({ label: spec.label, value: await countOnly(spec.path) })),
    );
    sectionState(container, { state: 'ready' });
    renderCounts(container, results);
    return results;
  } catch (err) {
    sectionState(container, {
      state: 'failed',
      message: "Couldn't load live counts — retry",
      onRetry: () => { loadCountsSection(container).catch(() => {}); },
    });
    throw err;
  }
}

// ============================================================================
// #freshness — the FULL public_freshness table (LOW-7 precedent, person-page.js: a plain restGet,
// not fetchAllRows — one row per ingestion source, a small fixed-cardinality set, never large
// enough to need pagination). Deliberately UNFILTERED: person-page.js's own loadFreshnessSection
// narrows to a profile's relevant jurisdictions (relevantFreshnessRows); this page shows every
// source the view returns, because the trust page's job is exactly to show the whole ledger.
// ============================================================================
function renderFreshnessTable(container, rows) {
  clearChildren(container);
  const table = el('table', { class: 'freshness-table' });
  const thead = el('thead', {});
  const headRow = el('tr', {});
  for (const heading of ['Source', 'Status', 'Last finished', 'Quarantined days pending review']) {
    headRow.appendChild(el('th', {}, heading));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody', {});
  for (const row of rows) {
    const quarantined = Number(row.quarantined_days) || 0;
    const tr = el('tr', { class: quarantined > 0 ? 'freshness-row-quarantine' : 'freshness-row' });
    tr.appendChild(el('td', {}, row.source));
    tr.appendChild(el('td', {}, row.status));
    tr.appendChild(el('td', {}, row.finished_at || '(never)'));
    tr.appendChild(el('td', {}, String(quarantined)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

export async function loadFreshnessSection(container) {
  sectionState(container, { state: 'loading' });
  try {
    const { rows } = await restGet('public_freshness?select=source,status,finished_at,quarantined_days');
    if (rows.length === 0) {
      sectionState(container, { state: 'empty', message: 'No freshness data recorded.' });
      return rows;
    }
    sectionState(container, { state: 'ready' });
    renderFreshnessTable(container, rows);
    return rows;
  } catch (err) {
    sectionState(container, {
      state: 'failed',
      message: "Couldn't load freshness data — retry",
      onRetry: () => { loadFreshnessSection(container).catch(() => {}); },
    });
    throw err;
  }
}

// Entry point for site/trust.html — exported, never auto-run at module load (same convention as
// every other page's bootstrap function).
export async function bootstrapTrustPage() {
  mountFooter(document.getElementById('site-footer'));
  renderMetricDefinitions(document.getElementById('metrics-list'));
  await Promise.all([
    loadFreshnessSection(document.getElementById('freshness-table')).catch(() => {}),
    loadCountsSection(document.getElementById('counts-list')).catch(() => {}),
  ]);
}
