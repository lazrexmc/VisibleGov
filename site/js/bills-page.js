// site/js/bills-page.js — site/bills.html's entry point: the Browse-bills catalog. Same split as
// site/js/directory-page.js: pure model functions first (TDD'd in tests/bills-page.test.js BEFORE
// the DOM code existed), DOM/network orchestration below. Reuses the existing toolbox by exact
// name — never a lookalike reimplementation: rest.js (fetchAllRows), render.js
// (el/clearChildren/sectionState/mountFooter).
//
// What this page lists, and why (2026-08-18 bounded design, Lance-approved): every bill with a
// PUBLISHED plain-language summary — a completeness criterion, never an editorial one — newest
// summary first, split Federal / Missouri. Chronology keys on summaries.published_at because the
// bills table carries no action-date column (verified against the live schema before design):
// the honest label for this ordering is "summary published," and the UI says exactly that.

import { fetchAllRows } from './rest.js';
import {
  el, clearChildren, sectionState, mountFooter,
} from './render.js';

// ============================================================================
// Pure model (TDD'd in tests/bills-page.test.js BEFORE any of the DOM code below existed)
// ============================================================================

// One entry per bill from the summaries->bills->sessions->jurisdictions embed rows. A bill with
// more than one published row (never expected — status transitions retire the old row — but
// defended anyway) keeps only its newest summary. A row with no bills embed cannot render a row
// a reader could use, so it is dropped whole — never a half-empty entry. Never throws on
// malformed input.
export function buildBillEntries(summaryRows) {
  const byBill = new Map();
  for (const row of (Array.isArray(summaryRows) ? summaryRows : [])) {
    if (!row || !row.bills || !row.bills.id) continue;
    const publishedAt = typeof row.published_at === 'string' ? row.published_at : '';
    const existing = byBill.get(row.bills.id);
    if (existing && existing.publishedAt >= publishedAt) continue;
    const session = row.bills.sessions || null;
    byBill.set(row.bills.id, {
      billId: row.bills.id,
      identifier: row.bills.identifier || '',
      title: row.bills.title || '',
      publishedAt,
      publishedDate: publishedAt ? publishedAt.slice(0, 10) : '',
      jurisdictionId: session ? (session.jurisdiction_id ?? null) : null,
      jurisdictionName: session && session.jurisdictions ? (session.jurisdictions.name ?? null) : null,
      sessionLabel: session ? (session.name || session.identifier || '') : '',
      href: `/bill/${row.bills.id}`,
    });
  }
  const entries = [...byBill.values()];
  entries.sort((a, b) => {
    // ISO-8601 strings compare correctly as strings; an empty publishedAt sorts last.
    if (a.publishedAt !== b.publishedAt) return a.publishedAt > b.publishedAt ? -1 : 1;
    return (a.identifier || '').localeCompare(b.identifier || '', 'en', { numeric: true, sensitivity: 'base' });
  });
  return entries;
}

// Splits the already-sorted entry list into the two page views plus an `other` bucket. A bill
// whose jurisdiction cannot be determined (or is neither known jurisdiction) is never silently
// filed under a tab it may not belong to — it lands in `other`, which the page renders labeled
// by whatever jurisdiction name it carries. Pure, order-preserving, never throws.
export function partitionBills(entries) {
  const federal = [];
  const missouri = [];
  const other = [];
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    if (!entry) continue;
    if (entry.jurisdictionId === 'us-congress') federal.push(entry);
    else if (entry.jurisdictionId === 'mo-legislature') missouri.push(entry);
    else other.push(entry);
  }
  return { federal, missouri, other };
}

// Client-side text filter over the COMPLETE fetched list (identifier + title) — never a
// partial-page server re-sort/filter (same contract as directory-page.js's filterDirectory).
// Empty/whitespace-only query returns the list unchanged. Never throws on malformed input.
export function filterBills(entries, queryText) {
  const list = Array.isArray(entries) ? entries : [];
  const q = String(queryText || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((e) => {
    if (!e) return false;
    const haystack = [e.identifier, e.title].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

// ============================================================================
// DOM rendering (not independently unit-tested — same convention as directory-page.js's own DOM
// helpers; smoke-tested live). Small and named so each does one thing.
// ============================================================================

function renderBillsList(container, entries, { showJurisdiction = false } = {}) {
  clearChildren(container);
  if (entries.length === 0) {
    sectionState(container, { state: 'empty', message: 'No bills match.' });
    return;
  }
  const ul = el('ul', { class: 'directory-list' });
  for (const entry of entries) {
    const li = el('li', { class: 'directory-row' });
    const identity = el('span', { class: 'directory-identity' });
    identity.appendChild(el('a', { href: entry.href }, `${entry.identifier} — ${entry.title}`));
    const metaText = [
      showJurisdiction ? entry.jurisdictionName : null,
      entry.sessionLabel || null,
    ].filter(Boolean).join(' · ');
    if (metaText) identity.appendChild(el('span', { class: 'directory-meta' }, ` — ${metaText}`));
    li.appendChild(identity);
    if (entry.publishedDate) {
      li.appendChild(el('span', { class: 'directory-since mono' }, entry.publishedDate));
    }
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

// ============================================================================
// Bootstrap
// ============================================================================

const BILLS_SELECT = 'bill_id,published_at,'
  + 'bills(id,identifier,title,sessions(id,identifier,name,jurisdiction_id,jurisdictions(id,name)))';

export async function bootstrapBillsPage() {
  const listContainer = document.getElementById('bills-list');
  const otherContainer = document.getElementById('bills-other');
  const filterInput = document.getElementById('bills-filter');
  const federalButton = document.getElementById('bills-view-federal');
  const missouriButton = document.getElementById('bills-view-missouri');
  const countLine = document.getElementById('bills-count');
  mountFooter(document.getElementById('site-footer'));

  sectionState(listContainer, { state: 'loading', message: 'Loading bills…' });
  let entries;
  try {
    // fetchAllRows requires a caller-passed deterministic order with a unique tiebreaker
    // (rest.js's own contract) — summaries.id is the unique column on this query's base table.
    const rows = await fetchAllRows(
      `summaries?status=eq.published&select=${BILLS_SELECT}`,
      { order: 'published_at.desc,id.desc' },
    );
    entries = buildBillEntries(rows);
  } catch {
    sectionState(listContainer, {
      state: 'failed',
      message: 'Could not load the bill list. Refresh to try again.',
    });
    return;
  }

  const { federal, missouri, other } = partitionBills(entries);
  let activeView = 'federal';

  function activeEntries() {
    return activeView === 'federal' ? federal : missouri;
  }

  function rerender() {
    const filtered = filterBills(activeEntries(), filterInput ? filterInput.value : '');
    renderBillsList(listContainer, filtered);
    if (countLine) {
      const total = activeEntries().length;
      countLine.textContent = filtered.length === total
        ? `${total} bills with published plain-language summaries`
        : `${filtered.length} of ${total} bills match`;
    }
    if (federalButton) federalButton.setAttribute('aria-pressed', String(activeView === 'federal'));
    if (missouriButton) missouriButton.setAttribute('aria-pressed', String(activeView === 'missouri'));
  }

  if (federalButton) federalButton.addEventListener('click', () => { activeView = 'federal'; rerender(); });
  if (missouriButton) missouriButton.addEventListener('click', () => { activeView = 'missouri'; rerender(); });
  if (filterInput) filterInput.addEventListener('input', () => rerender());

  // Bills whose jurisdiction is neither known jurisdiction (expected: none) render below both
  // tabs, labeled with whatever jurisdiction name each carries — never silently filed under a
  // tab, never silently dropped.
  if (otherContainer && other.length > 0) {
    otherContainer.appendChild(el('h3', {}, 'Other jurisdictions'));
    renderBillsList(otherContainer, other, { showJurisdiction: true });
  }

  rerender();
}
