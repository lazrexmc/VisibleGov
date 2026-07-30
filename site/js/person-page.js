// site/js/person-page.js — the profile page (design spec §3, task-6 brief). Browser-native ES
// module. This is the "wiring" layer: it imports the pure toolbox built by Tasks 3-5 and drives
// real fetches + DOM mounting. Unlike profile-model.js (zero-import, pure) this file DOES import
// and DOES touch the DOM/network — that split is deliberate (task-5 brief's own boundary).
//
// site/legislator.html's script (site/js/legislator-page.js) reuses `mountProfile` from here
// unchanged (design spec §3: "the same profile template as a single-row career") — the only
// difference between /person/<id> and /legislator/<id> is how identity rows are obtained before
// mountProfile is called.
//
// Three-state discipline (plan law, verbatim from the task brief): "every fetch renders one of
// three distinct states — loading, failed ('couldn't load — retry' with a working retry), or
// honestly-empty. A failed fetch NEVER renders as an empty section." Each section below
// (identity, votes, sponsorships, freshness) is independently three-stated via sectionState().

import {
  pagedFetch, fetchAllRows, restGet,
} from './rest.js';
import {
  el, clearChildren, sectionState, mountFooter,
} from './render.js';
import { voteReceiptUrl, photoUrl } from './receipts.js';
import { extractOneLiner } from './summary-parse.js';
import {
  buildIdentity, voteFilterQuery, groupSponsorships, chamberLabel,
} from './profile-model.js';

// ============================================================================
// Pure helpers (TDD'd in tests/person-page.test.js BEFORE any of the DOM code below existed)
// ============================================================================

// URL contract: `/person/<uuid>[/<slug-ignored>]`. The uuid is authoritative; a trailing name
// segment is cosmetic and ignored by lookup (design spec §2). Returns null on anything that
// doesn't carry a real id after the given prefix — never throws on a malformed/foreign path.
export function idFromPath(pathname, prefix) {
  if (typeof pathname !== 'string' || typeof prefix !== 'string') return null;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const [id] = rest.split('/');
  return id ? id : null;
}

// Step 4 of the brief's data flow: for the CURRENT page's distinct bill_ids, one summaries query
// (`summaries?bill_id=in.(...)&status=eq.published&select=bill_id,body_md,published_at&
// order=published_at.desc`) -> keep FIRST per bill_id (the query's own ordering makes "first" mean
// "current published") -> extractOneLiner (the shared mechanical parser, never a lookalike
// client-side markdown parse). A bill_id with nothing extractable maps to null — the caller
// renders title-only, no placeholder text. A bill_id with no row at all is simply absent from the
// map (same title-only rendering, caller doesn't need to distinguish the two cases).
export function buildOneLinerMap(summaryRows) {
  const map = new Map();
  for (const row of (summaryRows || [])) {
    if (!row || !row.bill_id) continue;
    if (map.has(row.bill_id)) continue; // first-seen wins; query is pre-ordered published_at.desc
    map.set(row.bill_id, extractOneLiner(row.body_md));
  }
  return map;
}

// Step 5 of the brief's data flow: any displayed vote carrying a reconciliation flag shows a
// badge. Pure join by vote_id between the current page's vote rows and
// `public_reconciliation_flags?vote_id=in.(...)` — a new array, input rows never mutated.
export function joinFlagBadges(voteRows, flagRows) {
  const flaggedIds = new Set((flagRows || []).filter(Boolean).map((f) => f.vote_id));
  return (voteRows || []).map((row) => ({ ...row, flagged: flaggedIds.has(row.vote_id) }));
}

// Step 7 of the brief's data flow: "public_freshness rows for the sources relevant to this
// profile's jurisdictions (map: us-congress -> sources starting `us-`; mo-legislature -> `mo-` +
// `legiscan`)". jurisdictionIds come from the profile's own terms rows — an unlinked/undated row
// with zero terms yields zero jurisdictions, which honestly yields an empty freshness box rather
// than guessing.
const FRESHNESS_SOURCE_RULES = {
  'us-congress': (source) => typeof source === 'string' && source.startsWith('us-'),
  'mo-legislature': (source) => typeof source === 'string' && (source.startsWith('mo-') || source === 'legiscan'),
};

export function relevantFreshnessRows(freshnessRows, jurisdictionIds) {
  const ids = Array.isArray(jurisdictionIds) ? jurisdictionIds : [];
  const rules = ids.map((id) => FRESHNESS_SOURCE_RULES[id]).filter(Boolean);
  if (rules.length === 0) return [];
  return (freshnessRows || []).filter((row) => row && rules.some((rule) => rule(row.source)));
}

// Fix round 2, finding 1 (controller re-smoke, IMPORTANT): exactly page 1 (50 rows) rendered with
// no way to reach the rest of a ~1,650-cast career. pagedFetch() already returns
// {rows, total, page, pageSize} (rest.js, count=exact on every request) — this is the pure
// display math built from it, so "Showing X-Y of Z" and the Prev/Next buttons' disabled state are
// never re-derived ad hoc at render time. total === null is a defensive fallback for a
// malformed/missing content-range header, not an expected live path (rest.js's doFetch always
// requests count=exact) — treated conservatively as "don't offer a next page into the unknown."
export function paginationSummary({ page, pageSize, total }) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 50);
  const hasTotal = typeof total === 'number' && Number.isFinite(total);
  const t = hasTotal ? Math.max(0, total) : null;

  if (t === 0) {
    return {
      start: 0, end: 0, total: 0, page: p, pageCount: 0, hasPrev: false, hasNext: false,
    };
  }

  const start = (p - 1) * size + 1;
  const end = t === null ? p * size : Math.min(p * size, t);
  const pageCount = t === null ? null : Math.max(1, Math.ceil(t / size));
  const hasPrev = p > 1;
  const hasNext = t === null ? false : end < t;

  return {
    start, end, total: t, page: p, pageCount, hasPrev, hasNext,
  };
}

// Fix round 2, finding 1: the pure "which page are we on" reducer both the filter controls
// (chamber/year/missed-votes) and the Prev/Next buttons go through. A real filter change always
// resets to page 1 (brief: "any filter change resets to page 1") — a stale page number surviving
// a filter change could silently land past the new, smaller result set. A PURE page change
// (patch is only `{ page }`, from a Prev/Next click) applies directly, clamped to a minimum of 1.
// Pure: returns a new object, never mutates the caller's filters.
export function nextVoteFilters(filters, patch) {
  const current = filters || {};
  const patchObj = patch || {};
  const patchKeys = Object.keys(patchObj);
  const isPurePageChange = patchKeys.length > 0 && patchKeys.every((k) => k === 'page');
  if (isPurePageChange) {
    return { ...current, page: Math.max(1, Number(patchObj.page) || 1) };
  }
  return { ...current, ...patchObj, page: 1 };
}

// Fix round 2, finding 2 (controller re-smoke, IMPORTANT): MO bill_sponsors.bills.status
// currently stores LegiScan's NUMERIC status code for MO bills (a merged-backfill deviation from
// the ingestion's own plan — a data correction is queued separately with Lance; federal statuses
// are proper printed strings like 'Introduced'). Facts-only rule (CLAUDE.md): the fix belongs in
// the DATA, never a client-side code->label map — that would be the client inventing a fact this
// module has no authority to invent. Until the correction lands, a bare numeric code is
// unintelligible, not informative, so it is simply omitted rather than shown or guessed at. This
// predicate is TEMPORARY DISPLAY HONESTY, not a policy statement about what MO statuses mean.
export function isNumericStatusCode(status) {
  return typeof status === 'string' && /^\d+$/.test(status);
}

// ============================================================================
// Small rendering helpers (DOM, not independently unit-tested — smoke-tested live per the
// controller's Step 4; kept small and named so each does exactly one thing)
// ============================================================================

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}

function billHref(billId, identifierOrTitle) {
  return `/bill/${billId}/${slugify(identifierOrTitle)}`;
}

function renderPhoto(container, legislatorLike, displayName) {
  const url = photoUrl(legislatorLike);
  if (url) {
    container.appendChild(el('img', { class: 'profile-photo', src: url, alt: displayName || 'photo' }));
  } else {
    container.appendChild(el('p', { class: 'profile-no-photo' }, 'No photo on record.'));
  }
}

// Exported (fix round 1, finding 2) so tests/person-page.test.js can assert directly that a
// date-unproven multi-affiliation identity (buildIdentity's joined chamberLabel, districtLabel
// null) renders the full joined string with no redundant/duplicated district suffix.
export function renderIdentity(container, identity) {
  clearChildren(container);
  const photoBox = el('div', { class: 'profile-photo-box' });
  renderPhoto(photoBox, identity.photoCandidate, identity.displayName);
  container.appendChild(photoBox);

  const info = el('div', { class: 'profile-identity-info' });
  info.appendChild(el('h1', {}, identity.displayName || 'Name unrecorded'));
  info.appendChild(el('p', { class: 'profile-party' }, identity.party ? identity.party : 'party unrecorded'));
  info.appendChild(el(
    'p',
    { class: 'profile-chamber' },
    identity.chamberLabel
      ? `${identity.chamberLabel}${identity.districtLabel ? `, district ${identity.districtLabel}` : ''}`
      : 'chamber/district unrecorded',
  ));
  info.appendChild(el('p', { class: 'profile-career-span' }, identity.careerSpan));
  container.appendChild(info);
}

function renderVoteRow(voteRow, oneLinerMap) {
  const li = el('li', { class: 'vote-row' });

  // A merged person (e.g. Onder's real MO-Senate-then-US-House shape) casts votes in more than
  // one chamber — label each row's own source chamber so the two careers stay distinguishable in
  // one combined vote list, rather than presenting them as an undifferentiated stream.
  if (voteRow.jurisdiction_id && voteRow.chamber) {
    li.appendChild(el('p', { class: 'vote-chamber' }, chamberLabel(voteRow.jurisdiction_id, voteRow.chamber)));
  }

  // votes.bill_id is nullable (schema comment: "some votes are procedural") — a procedural vote
  // has nothing to link to, so it renders the question text plainly rather than a dead
  // /bill/null/... link.
  if (voteRow.bill_id) {
    li.appendChild(el(
      'a',
      { class: 'vote-bill-link', href: billHref(voteRow.bill_id, voteRow.bill_identifier || voteRow.bill_title || voteRow.bill_id) },
      `${voteRow.bill_identifier || '(no bill identifier)'} — ${voteRow.bill_title || '(no title)'}`,
    ));
  } else {
    li.appendChild(el('p', { class: 'vote-procedural' }, voteRow.question || '(procedural vote, no associated bill)'));
  }

  const oneLiner = voteRow.bill_id ? oneLinerMap.get(voteRow.bill_id) : undefined;
  if (oneLiner) {
    li.appendChild(el('p', { class: 'vote-one-liner' }, oneLiner));
  }

  // Position rendered EXACTLY as the source recorded it (yea/nay/not_voting/absent/present/
  // other) — the stored token is the mechanical form; it is never reworded or reformatted.
  li.appendChild(el('p', { class: 'vote-position' }, `Position: ${voteRow.position}`));

  const receiptUrl = voteReceiptUrl(voteRow);
  if (receiptUrl) {
    li.appendChild(el('a', { class: 'vote-receipt-link', href: receiptUrl }, 'source'));
  }

  if (voteRow.flagged) {
    li.appendChild(el('a', { class: 'flag-badge', href: '/trust#flags' }, '⚑ reconciliation flag'));
  }

  return li;
}

// Fix round 2, finding 1: honest navigation over a partial page — "Showing X-Y of Z" (authored
// UI text; X/Y/Z come from paginationSummary's pure math over the real pagedFetch() result) +
// Prev/Next buttons, disabled at bounds. onPageChange is loadVotesSection's own reload, already
// wrapped in the same error handling as everything else on this page.
function renderPaginationControls(pageResult, onPageChange) {
  const summary = paginationSummary({ page: pageResult.page, pageSize: pageResult.pageSize, total: pageResult.total });
  const nav = el('div', { class: 'vote-pagination' });
  const summaryText = summary.total !== null
    ? `Showing ${summary.start}–${summary.end} of ${summary.total}`
    : `Showing ${summary.start}–${summary.end}`;
  nav.appendChild(el('span', { class: 'vote-pagination-summary' }, summaryText));

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'vote-pagination-prev';
  prevBtn.textContent = 'Prev';
  prevBtn.disabled = !summary.hasPrev;
  prevBtn.addEventListener('click', () => onPageChange(summary.page - 1));

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'vote-pagination-next';
  nextBtn.textContent = 'Next';
  nextBtn.disabled = !summary.hasNext;
  nextBtn.addEventListener('click', () => onPageChange(summary.page + 1));

  nav.appendChild(prevBtn);
  nav.appendChild(nextBtn);
  return nav;
}

const SPONSOR_GROUP_LABELS = {
  primary: 'Primary sponsor',
  cosponsor: 'Cosponsor',
  joint: 'Joint sponsor',
  unspecified: 'Sponsor (type unspecified by source)',
};

// Exported (fix round 2, finding 2) so tests/person-page.test.js can assert directly that a
// numeric MO status code renders no status span, while a real printed status string still does.
export function renderSponsorships(container, sponsorRows) {
  clearChildren(container);
  const grouped = groupSponsorships(sponsorRows);
  let renderedAny = false;
  for (const type of ['primary', 'cosponsor', 'joint', 'unspecified']) {
    const rows = grouped[type];
    if (rows.length === 0) continue; // absence of a section is honest — the labels are exhaustive
    renderedAny = true;
    const section = el('section', { class: `sponsor-group sponsor-group-${type}` });
    section.appendChild(el('h3', {}, `${SPONSOR_GROUP_LABELS[type]} (${rows.length})`));
    const list = el('ul', {});
    for (const row of rows) {
      const bill = row.bills || {};
      const li = el('li', {});
      li.appendChild(el(
        'a',
        { href: billHref(bill.id, bill.identifier || bill.title || bill.id) },
        `${bill.identifier || '(no identifier)'} — ${bill.title || '(no title)'}`,
      ));
      // Numeric MO status codes omitted (see isNumericStatusCode's doc comment) — unintelligible
      // is not informative, and the fix belongs in the data, never a client-side code->label map.
      if (bill.status && !isNumericStatusCode(bill.status)) {
        li.appendChild(el('span', { class: 'bill-status' }, ` [${bill.status}]`));
      }
      list.appendChild(li);
    }
    section.appendChild(list);
    container.appendChild(section);
  }
  if (!renderedAny) {
    sectionState(container, { state: 'empty', message: 'No sponsorships recorded.' });
  }
}

function renderFreshness(container, rows) {
  clearChildren(container);
  const list = el('ul', { class: 'freshness-list' });
  for (const row of rows) {
    const li = el('li', {});
    li.appendChild(el('span', { class: 'freshness-source' }, row.source));
    li.appendChild(el('span', { class: 'freshness-status' }, ` — ${row.status}, last finished ${row.finished_at || '(never)'}`));
    if (row.quarantined_days > 0) {
      li.appendChild(el('p', { class: 'freshness-quarantine' }, `${row.quarantined_days} journal days pending human review`));
    }
    list.appendChild(li);
  }
  container.appendChild(list);
}

// ============================================================================
// Section orchestration — each independently three-stated (loading/failed/empty/ready), per the
// plan-law quoted at the top of this file. mountProfile is the shared entry point used by both
// person.html and legislator.html (design spec §3, "same profile template as a single-row
// career").
// ============================================================================

async function loadIdentitySection(container, { person, legislators, legislatorIds }) {
  sectionState(container, { state: 'loading' });
  try {
    const terms = legislatorIds.length > 0
      ? await fetchAllRows(`terms?legislator_id=in.(${legislatorIds.join(',')})`)
      : [];
    const identity = buildIdentity({ person, legislators, terms });
    sectionState(container, { state: 'ready' });
    renderIdentity(container, identity);
    return { identity, terms };
  } catch (err) {
    sectionState(container, {
      state: 'failed',
      message: "Couldn't load this legislator's identity — retry",
      onRetry: () => { loadIdentitySection(container, { person, legislators, legislatorIds }); },
    });
    throw err;
  }
}

// filters: { chamber, year, missedOnly, page }. Re-queries the SERVER on every filter/page
// change (voteFilterQuery + pagedFetch) — never a client-side sort/filter of a partial page.
// Exported (fix round 1, finding 1) so tests/person-page.test.js can assert directly that a
// rejecting fetch (rest.js's RestError on a non-2xx, e.g. the live statement-timeout 500) routes
// to the FAILED state, never the empty one — the exact violation the live smoke caught.
export async function loadVotesSection(container, { legislatorIds, filters }) {
  // Reused by both the failed-state retry button and the pagination Prev/Next buttons below —
  // one re-entry path, always error-swallowed the same way runVotes() is in mountProfile (a
  // network failure while paginating must never surface as an unhandled rejection).
  const reload = () => loadVotesSection(container, { legislatorIds, filters }).catch(() => {});

  sectionState(container, { state: 'loading' });
  let page;
  try {
    page = await pagedFetch(voteFilterQuery({ legislatorIds, ...filters }), {
      page: filters.page || 1,
      pageSize: 50,
    });
  } catch (err) {
    sectionState(container, {
      state: 'failed',
      message: "Couldn't load votes — retry",
      onRetry: reload,
    });
    throw err;
  }

  if (page.rows.length === 0) {
    sectionState(container, { state: 'empty', message: 'No recorded votes for this filter.' });
    return page;
  }

  // Step 4: current page's distinct bill_ids -> one summaries query -> one-liner map.
  const billIds = [...new Set(page.rows.map((r) => r.bill_id).filter(Boolean))];
  let oneLinerMap = new Map();
  try {
    const summaryRows = billIds.length > 0
      ? (await restGet(`summaries?bill_id=in.(${billIds.join(',')})&status=eq.published&select=bill_id,body_md,published_at&order=published_at.desc`)).rows
      : [];
    oneLinerMap = buildOneLinerMap(summaryRows);
  } catch {
    // One-liners are an enhancement over the vote list, not a hard dependency: if the summaries
    // fetch fails, the votes themselves still rendered from a SUCCESSFUL fetch above — rows just
    // fall back to title-only (the same as "no published summary yet"), not a failed section.
    oneLinerMap = new Map();
  }

  // Step 5: current page's vote_ids -> reconciliation flags -> badge join.
  const voteIds = [...new Set(page.rows.map((r) => r.vote_id).filter(Boolean))];
  let flaggedRows = page.rows;
  try {
    const flagRows = voteIds.length > 0
      ? (await restGet(`public_reconciliation_flags?vote_id=in.(${voteIds.join(',')})`)).rows
      : [];
    flaggedRows = joinFlagBadges(page.rows, flagRows);
  } catch {
    // Same reasoning as one-liners: flags are additive to an already-successful votes fetch.
    flaggedRows = joinFlagBadges(page.rows, []);
  }

  sectionState(container, { state: 'ready' });
  const list = el('ul', { class: 'vote-list' });
  for (const row of flaggedRows) list.appendChild(renderVoteRow(row, oneLinerMap));
  container.appendChild(list);
  container.appendChild(renderPaginationControls(page, (newPage) => {
    Object.assign(filters, nextVoteFilters(filters, { page: newPage }));
    reload();
  }));
  return page;
}

async function loadSponsorshipsSection(container, { legislatorIds }) {
  sectionState(container, { state: 'loading' });
  try {
    const rows = legislatorIds.length > 0
      ? await fetchAllRows(`bill_sponsors?legislator_id=in.(${legislatorIds.join(',')})&select=sponsor_type,bills(id,identifier,title,status)`)
      : [];
    if (rows.length === 0) {
      sectionState(container, { state: 'empty', message: 'No sponsorships recorded.' });
      return rows;
    }
    sectionState(container, { state: 'ready' });
    renderSponsorships(container, rows);
    return rows;
  } catch (err) {
    sectionState(container, {
      state: 'failed',
      message: "Couldn't load sponsorships — retry",
      onRetry: () => { loadSponsorshipsSection(container, { legislatorIds }); },
    });
    throw err;
  }
}

async function loadFreshnessSection(container, { terms }) {
  sectionState(container, { state: 'loading' });
  try {
    const jurisdictionIds = [...new Set((terms || []).map((t) => t.jurisdiction_id).filter(Boolean))];
    const allRows = (await restGet('public_freshness?select=source,status,finished_at,quarantined_days')).rows;
    const rows = relevantFreshnessRows(allRows, jurisdictionIds);
    if (rows.length === 0) {
      sectionState(container, { state: 'empty', message: 'No freshness data recorded for this profile\'s jurisdictions.' });
      return rows;
    }
    sectionState(container, { state: 'ready' });
    renderFreshness(container, rows);
    return rows;
  } catch (err) {
    sectionState(container, {
      state: 'failed',
      message: "Couldn't load freshness data — retry",
      onRetry: () => { loadFreshnessSection(container, { terms }); },
    });
    throw err;
  }
}

// The shared entry point. `sections` is an object of DOM containers:
// { identity, votes, sponsorships, freshness, voteFilters }. `person` is null for the
// legislator.html single-row path (design spec §3).
export async function mountProfile(sections, { person, legislators }) {
  const legislatorIds = (legislators || []).map((l) => l.id);
  const { terms } = await loadIdentitySection(sections.identity, { person, legislators, legislatorIds }).catch(() => ({ terms: [] }));

  const filters = { chamber: null, year: null, missedOnly: false, page: 1 };
  const runVotes = () => loadVotesSection(sections.votes, { legislatorIds, filters }).catch(() => {});
  if (sections.voteFilters) {
    wireVoteFilters(sections.voteFilters, filters, runVotes);
  }
  await runVotes();

  await loadSponsorshipsSection(sections.sponsorships, { legislatorIds }).catch(() => {});
  await loadFreshnessSection(sections.freshness, { terms }).catch(() => {});
}

// Wires the filter controls (chamber select, year select/input, missed-votes checkbox) to
// re-query the server via the SAME path builder (voteFilterQuery) on every change — never a
// client-side re-sort/filter of the page already in hand (brief: "filter controls re-query the
// SERVER, never client-sort partial pages"). Every change goes through nextVoteFilters (fix
// round 2, finding 1) — the same pure "reset to page 1 on a real filter change" reducer the
// Prev/Next buttons use, so a stale page number never survives a filter change.
function wireVoteFilters(container, filters, runVotes) {
  clearChildren(container);

  const chamberSelect = document.createElement('select');
  for (const [value, label] of [['', 'All chambers'], ['house', 'House'], ['senate', 'Senate']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    chamberSelect.appendChild(opt);
  }
  chamberSelect.addEventListener('change', () => {
    Object.assign(filters, nextVoteFilters(filters, { chamber: chamberSelect.value || null }));
    runVotes();
  });

  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.placeholder = 'Year (e.g. 2023)';
  yearInput.addEventListener('change', () => {
    const v = yearInput.value.trim();
    Object.assign(filters, nextVoteFilters(filters, { year: v ? Number(v) : null }));
    runVotes();
  });

  const missedLabel = document.createElement('label');
  const missedCheckbox = document.createElement('input');
  missedCheckbox.type = 'checkbox';
  missedCheckbox.addEventListener('change', () => {
    Object.assign(filters, nextVoteFilters(filters, { missedOnly: missedCheckbox.checked }));
    runVotes();
  });
  missedLabel.appendChild(missedCheckbox);
  missedLabel.appendChild(document.createTextNode('Missed votes only (not voting / absent)'));

  container.appendChild(chamberSelect);
  container.appendChild(yearInput);
  container.appendChild(missedLabel);
}

// Not-found state shared by both entry scripts: neither a person row nor any legislator row
// resolved for the requested id. 'failed'-style per the brief (reuses the failed section's
// visual/semantic weight — something is genuinely wrong with this URL) rather than 'empty' (which
// would wrongly imply a real, existing profile with nothing recorded). onRetry is optional and,
// per the three-state law's "working retry," re-runs the same lookup rather than rendering an
// inert button — retrying a bad id predictably fails the same way, same as a still-down server.
export function renderNotFound(container, onRetry) {
  sectionState(container, { state: 'failed', message: 'No such profile in our data.', onRetry });
}

export { billHref };

// ============================================================================
// Entry point for site/person.html — exported, never auto-run at module load. person-page.js is
// also imported BY legislator-page.js (for idFromPath/mountProfile/renderNotFound reuse); if this
// ran automatically on import, loading legislator.html would double-bootstrap (this function
// would fire too, on a /legislator/... URL its own idFromPath('/person/') correctly returns null,
// clobbering legislator-page.js's own render with a premature not-found). Each HTML page's own
// tiny inline `<script type="module">` calls exactly one bootstrap function explicitly.
export async function bootstrapPersonPage() {
  const identityContainer = document.getElementById('identity');
  mountFooter(document.getElementById('site-footer'));

  const personId = idFromPath(window.location.pathname, '/person/');
  if (!personId) {
    renderNotFound(identityContainer);
    return;
  }

  sectionState(identityContainer, { state: 'loading' });
  let existence;
  try {
    const [personRes, legislatorsRes] = await Promise.all([
      restGet(`persons?id=eq.${personId}&select=id,display_name,display_name_source`),
      fetchAllRows(`legislators?person_id=eq.${personId}`),
    ]);
    existence = { person: personRes.rows[0] || null, legislators: legislatorsRes };
  } catch {
    sectionState(identityContainer, {
      state: 'failed',
      message: "Couldn't load this profile — retry",
      onRetry: () => bootstrapPersonPage(),
    });
    return;
  }

  // Step 1 of the brief's data flow, verbatim: "empty legislators AND no person -> 'failed'-style
  // not-found state."
  if (!existence.person && existence.legislators.length === 0) {
    renderNotFound(identityContainer, () => bootstrapPersonPage());
    return;
  }

  await mountProfile({
    identity: identityContainer,
    voteFilters: document.getElementById('vote-filters'),
    votes: document.getElementById('votes'),
    sponsorships: document.getElementById('sponsorships'),
    freshness: document.getElementById('freshness'),
  }, existence);
}
