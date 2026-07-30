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
  el, clearChildren, sectionState, mountFooter, isSafeSrc,
} from './render.js';
import { voteReceiptUrl, photoUrl } from './receipts.js';
import { extractOneLiner } from './summary-parse.js';
import {
  buildIdentity, voteFilterQuery, groupSponsorships, chamberLabel,
} from './profile-model.js';
import {
  summarizeTotals, cohesionFromAlignment, partyComparisonModel, renderChartSection, normalizePartyLabel,
} from './vote-charts.js';

// ============================================================================
// Pure helpers (TDD'd in tests/person-page.test.js BEFORE any of the DOM code below existed)
// ============================================================================

// URL contract: `/person/<uuid>[/<slug-ignored>]`. The uuid is authoritative; a trailing name
// segment is cosmetic and ignored by lookup (design spec §2). Returns null on anything that
// doesn't carry a real id after the given prefix — never throws on a malformed/foreign path.
//
// LOW-8 (task review, fix round 3): the id segment must actually BE uuid-shaped. Without this, a
// non-uuid path segment (a REST filter-injection attempt, or just garbage) flowed straight into
// PostgREST query strings built elsewhere (`persons?id=eq.<id>`, `legislators?person_id=eq.<id>`)
// AND, on a not-found result, into an infinite self-retry loop (renderNotFound's retry re-runs
// the exact same doomed lookup forever). Rejecting non-uuid shapes here, before either of those,
// closes both at once.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idFromPath(pathname, prefix) {
  if (typeof pathname !== 'string' || typeof prefix !== 'string') return null;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const [id] = rest.split('/');
  if (!id || !UUID_PATTERN.test(id)) return null;
  return id;
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
export function paginationSummary({
  page, pageSize, total, rowsLength,
}) {
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
  let end;
  if (t !== null) {
    end = Math.min(p * size, t);
  } else {
    // LOW-12 (task review, fix round 3): total unknown (defensive — not an expected live path,
    // see above) — `end` must reflect the rows ACTUALLY returned, not an assumed full page. A
    // short final page must never be padded out to claim more rows exist than really came back.
    // No rowsLength given (a caller that predates this param) falls back to the old full-page
    // assumption — backward compatible.
    const n = Number.isFinite(rowsLength) ? Math.max(0, rowsLength) : size;
    end = start + n - 1;
  }
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

// Exported (fix round 3, LOW-11) for direct testing. render.js's src guard is https-only/no-
// relative (see render.js's own comment) — if a stored image_url (or, in principle, a malformed
// bioguide derivation) ever failed that guard, el() would THROW mid-render. Checked here, BEFORE
// el() is ever called, rather than caught after the fact, so a bad photo URL degrades to the
// honest no-photo state instead of taking the whole identity render down with it.
//
// Fix round 3 micro-round (task review, NEW-C(b)): this used to carry a private
// `/^https:\/\//i` regex duplicating render.js's own src security rule. Now consumes render.js's
// exported isSafeSrc — the SAME control-char-stripping/protocol-relative-rejection/scheme-check
// logic el() itself enforces, not a second copy that could quietly drift out of sync with it.
export function renderPhoto(container, legislatorLike, displayName) {
  const url = photoUrl(legislatorLike);
  if (url && isSafeSrc(url)) {
    container.appendChild(el('img', { class: 'profile-photo', src: url, alt: displayName || 'photo' }));
    return;
  }
  container.appendChild(el('p', { class: 'profile-no-photo' }, 'No photo on record.'));
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
    // HIGH-1 "while there" (task review, fix round 3): a recorded-but-malformed/hostile
    // source_url would trip render.js's href allowlist and throw — wrapped locally so ONE bad
    // url degrades this ONE row to an honest notice instead of taking the other 49 rows on the
    // page down with it (the outer containment below is the last-resort backstop, not the
    // primary mechanism, for exactly this class of fault).
    try {
      li.appendChild(el('a', { class: 'vote-receipt-link', href: receiptUrl }, 'source'));
    } catch {
      li.appendChild(el('span', { class: 'vote-receipt-unavailable' }, 'source unavailable'));
    }
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
  const summary = paginationSummary({
    page: pageResult.page, pageSize: pageResult.pageSize, total: pageResult.total, rowsLength: pageResult.rows.length,
  });
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

// `reload` (fix round 3 micro-round, NEW-A): the caller supplies what "retry" means here, rather
// than this function self-recursing on its own narrow inputs. mountProfile passes
// loadIdentityThenFreshness — NOT a bare re-call of loadIdentitySection — so that clicking
// IDENTITY's OWN retry button ALSO re-attempts freshness. Before this, identity's retry only
// re-ran identity itself: proven stranded case (task review) — terms fetch 500s, both identity
// and freshness fail; user clicks IDENTITY's retry; identity recovers but freshness stays stuck
// on "Couldn't determine this profile's jurisdictions" forever, even though terms are now in
// hand. Both retry buttons must lead back to the same place.
async function loadIdentitySection(container, { person, legislators, legislatorIds, reload }) {
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
      onRetry: reload,
    });
    throw err;
  }
}

// filters: { chamber, year, missedOnly, page }. Re-queries the SERVER on every filter/page
// change (voteFilterQuery + pagedFetch) — never a client-side sort/filter of a partial page.
// Exported (fix round 1, finding 1) so tests/person-page.test.js can assert directly that a
// rejecting fetch (rest.js's RestError on a non-2xx, e.g. the live statement-timeout 500) routes
// to the FAILED state, never the empty one — the exact violation the live smoke caught.
//
// voteGeneration (MED-5, task review, fix round 3): a filter/page change while a PRIOR call is
// still in flight is a real race — network responses can resolve OUT OF ORDER, so without this,
// whichever call resolves LAST wins the render even if it's the stale one, leaving the vote list
// mismatched against the currently-selected filter controls. Every re-entry path (filter changes
// via mountProfile's runVotes, retries and pagination via `reload` below) shares the SAME
// voteGeneration object by reference, so incrementing it here — the one place every re-entry
// funnels through — covers all of them uniformly. Incrementing happens synchronously as the
// very first statement, before any await, so no other call can interleave before this call's own
// "am I still current" checks are meaningful. A caller that omits voteGeneration (a direct/
// isolated invocation, e.g. most tests) gets its own private counter and is never stale relative
// to itself — fully backward compatible.
export async function loadVotesSection(container, { legislatorIds, filters, voteGeneration }) {
  const generation = voteGeneration || { current: 0 };
  generation.current += 1;
  const myGeneration = generation.current;
  const isStale = () => generation.current !== myGeneration;

  // Reused by the failed-state retry button and the pagination Prev/Next buttons below — one
  // re-entry path, always error-swallowed the same way mountProfile's runVotes() is (a network
  // failure while paginating/retrying must never surface as an unhandled rejection).
  const reload = () => loadVotesSection(container, { legislatorIds, filters, voteGeneration: generation }).catch(() => {});

  // LOW-10 (task review, fix round 3): no legislator ids at all -> nothing to honestly query. An
  // empty in.() is either a PostgREST error or an accidental match-everything depending on exact
  // syntax — never fire it; this is an honest empty result, not a fetch that needs to happen.
  // NEW-C(a) (task review, fix round 3 micro-round): the message must name the ACTUAL reason —
  // this isn't a filtered-away result ("this filter" implies a normal query just found nothing),
  // it's that no legislator row is even linked to query in the first place.
  if (!legislatorIds || legislatorIds.length === 0) {
    sectionState(container, { state: 'empty', message: 'No legislator records are linked to this profile.' });
    return {
      rows: [], total: 0, page: filters.page || 1, pageSize: 50,
    };
  }

  sectionState(container, { state: 'loading' });
  let page;
  try {
    page = await pagedFetch(voteFilterQuery({ legislatorIds, ...filters }), {
      page: filters.page || 1,
      pageSize: 50,
    });
  } catch (err) {
    if (isStale()) return null; // a newer call has already superseded this one — stand down silently
    sectionState(container, {
      state: 'failed',
      message: "Couldn't load votes — retry",
      onRetry: reload,
    });
    throw err;
  }

  if (isStale()) return page;

  if (page.rows.length === 0) {
    sectionState(container, { state: 'empty', message: 'No recorded votes for this filter.' });
    return page;
  }

  // Step 4: current page's distinct bill_ids -> one summaries query -> one-liner map. LOW-7
  // (task review, fix round 3, accepted deviation, documented): a plain restGet, not
  // fetchAllRows/pagedFetch — this in.() list is bounded by <=50 distinct bill_ids (one per row
  // on a 50-row page) and can never legitimately need pagination of its own.
  const billIds = [...new Set(page.rows.map((r) => r.bill_id).filter(Boolean))];
  let oneLinerMap = new Map();
  try {
    const summaryRows = billIds.length > 0
      // LOW-9 (task review, fix round 3): published_at.desc.nullslast,created_at.desc — a tie (or
      // a null published_at, which shouldn't occur on a status=eq.published row but costs
      // nothing to guard) breaks on created_at, so buildOneLinerMap's "first per bill_id" always
      // means the CURRENT published version, never an arbitrary/unordered row.
      ? (await restGet(`summaries?bill_id=in.(${billIds.join(',')})&status=eq.published&select=bill_id,body_md,published_at&order=published_at.desc.nullslast,created_at.desc`)).rows
      : [];
    oneLinerMap = buildOneLinerMap(summaryRows);
  } catch {
    // One-liners are an enhancement over the vote list, not a hard dependency: if the summaries
    // fetch fails, the votes themselves still rendered from a SUCCESSFUL fetch above — rows just
    // fall back to title-only (the same as "no published summary yet"), not a failed section.
    oneLinerMap = new Map();
  }

  if (isStale()) return page;

  // Step 5: current page's vote_ids -> reconciliation flags -> badge join. LOW-7: bounded by
  // <=50 vote_ids (one per row on a 50-row page), same accepted-deviation reasoning as above.
  const voteIds = [...new Set(page.rows.map((r) => r.vote_id).filter(Boolean))];
  let flaggedRows = page.rows;
  let flagsUnavailable = false;
  try {
    // MED-4 (CONTROLLER RULING, plan-level, task review fix round 3): resolved=is.false — an
    // ADJUDICATED discrepancy is not an open dispute; only unresolved flags are worth surfacing
    // as a live badge on a public profile page.
    const flagRows = voteIds.length > 0
      ? (await restGet(`public_reconciliation_flags?vote_id=in.(${voteIds.join(',')})&resolved=is.false`)).rows
      : [];
    flaggedRows = joinFlagBadges(page.rows, flagRows);
  } catch {
    // MED-3 (skip != empty, task review, fix round 3): unlike one-liners, silently defaulting
    // every row to unflagged here would be an AFFIRMATIVE claim ("no known discrepancy") on data
    // this fetch actually failed to load — absence of a flag badge IS a claim. flagsUnavailable
    // renders a visible notice alongside the (still-successful) vote rows instead of pretending
    // the flags fetch simply found nothing.
    flaggedRows = joinFlagBadges(page.rows, []);
    flagsUnavailable = true;
  }

  if (isStale()) return page;

  // HIGH-1 (task review, fix round 3): the render phase itself can throw (a hostile/malformed
  // value tripping render.js's attribute guard, or any other unforeseen fault) — if that escaped
  // uncaught here, the section would be left in the CLEARED 'ready' state with a half-built or
  // empty DOM and no failed/retry affordance at all: a blank section, worse than either honest
  // state. Wrapped so any throw during rendering routes to the SAME failed-with-retry path as a
  // fetch failure. (A single row's bad source_url is handled locally inside renderVoteRow — see
  // its own try/catch — so it degrades that ONE row instead of ever reaching this backstop.)
  try {
    sectionState(container, { state: 'ready' });
    if (flagsUnavailable) {
      container.appendChild(el('p', { class: 'flags-unavailable-notice' }, 'Reconciliation-flag status unavailable for this page.'));
    }
    const list = el('ul', { class: 'vote-list' });
    for (const row of flaggedRows) list.appendChild(renderVoteRow(row, oneLinerMap));
    container.appendChild(list);
    container.appendChild(renderPaginationControls(page, (newPage) => {
      Object.assign(filters, nextVoteFilters(filters, { page: newPage }));
      reload();
    }));
  } catch (err) {
    sectionState(container, {
      state: 'failed',
      message: "Couldn't load votes — retry",
      onRetry: reload,
    });
    throw err;
  }

  return page;
}

// Task 6b (design spec §3, "Vote aggregates"; task-6b-brief.md) — the profile's mechanical vote-
// aggregate charts, mounted ABOVE the vote list and driven by the SAME filter state (a bar click
// dispatches through the same nextVoteFilters reducer the vote-list filter controls already use —
// see wireVoteFilters/mountProfile below). Its own independent three-state section (design spec
// §8: a failed fetch never blocks another section): an aggregates fetch failing — including the
// PRE-APPLY state, migration 0018 not yet applied, both views 404 PGRST205, verified live via a
// read-only probe against the real anon surface during this task — renders THIS section's honest
// failed state while votes/sponsorships/freshness keep rendering normally below it.
//
// Fetches the member's own public_position_totals / public_party_alignment rows ONCE, unfiltered
// by chamber/year (brief: "the profile sums/filters client-side — rows per legislator are tiny"),
// then returns a `rescope()` closure that recomputes summarizeTotals/cohesionFromAlignment/
// partyComparisonModel against a NEW filters object on every call.
//
// H1 (review, fix round 1): the PARTY side is filtered by normalized party + the member's own
// jurisdiction set (derived from memberRows — every jurisdiction this legislator has actually cast
// votes in, never a guess) + the active chamber filter.
//
// N-G (re-review, CONTROLLER RULING, fix round 2): the party aggregate is now ONE query against
// migration 0018's new public_party_position_totals matview (pre-summed across every legislator of
// that party — no legislator_id at all) instead of filtering the per-legislator
// public_position_totals by party, which could need many chunked fetchAllRows round trips for a
// large party.
//
// N-A (re-review, HIGH, fix round 2): that pre-summed data alone cannot answer "is this legislator
// the only one in the group?" — without that answer, a chamber's only Independent would get their
// OWN rows back AS "the party aggregate" and the page would render member-vs-himself as two
// identical bars, exactly the member-vs-member violation design spec §3 forbids ("never a fake
// group of one"). fetchPartyScope below runs a SEPARATE, cheap `limit=1` existence check against
// public_position_totals (still per-legislator) for this alone: does at least one row exist, in
// the SAME party/jurisdiction/chamber scope, for a legislator OTHER than this profile's own ids?
// A failed/uncertain check is treated conservatively as "no confirmed outside members" (never
// computable) — the safe failure direction for a neutrality requirement.
//
// N-F (re-review, fix round 2): even with NO chamber filter selected, the party fetch (and the
// N-A existence check) are bounded to the chambers this member has ACTUALLY served in (derived
// from memberRows) — never silently widened to every chamber under a shared jurisdiction id — so
// the default (unfiltered) view stays "same scope both sides" too, not just the filtered one.
//
// Because chamber is a SERVER-side filter on the party-scope fetch (unlike year, which stays
// client-side on both sides via summarizeTotals — chamber has far lower cardinality and this is
// what the review's scoping language calls for), `rescope()` is async and re-fetches party scope
// only when `filters.chamber` has actually changed since the last fetch.
//
// N-B (re-review, HIGH, fix round 2): rescope() being async and re-fetched on every filter change
// is a real race — two rapid chamber switches can resolve OUT OF ORDER (network responses do not
// preserve request order), which without a guard would leave a STALE chamber's numbers rendered
// under a page whose filter controls already show the NEWER chamber. Mirrors loadVotesSection's
// own voteGeneration pattern exactly (see its own comment above): `generation` increments
// synchronously as rescope()'s very first statement (before any await, so nothing can interleave
// before this call's own generation number is captured), `isStale()` is checked after the async
// work, and a superseded call stands down silently rather than render over a newer result.
export async function loadChartsSection(container, {
  legislatorIds, party, filters, onBarClick, onReady,
}) {
  sectionState(container, { state: 'loading' });

  if (!legislatorIds || legislatorIds.length === 0) {
    sectionState(container, { state: 'empty', message: 'No legislator records are linked to this profile.' });
    return null;
  }

  // M1 (review, fix round 1): `onReady` is threaded through every recursive `reload` call too, so
  // a SUCCESSFUL retry (after an initial failure) fires it again with a fresh `{rescope}` —
  // without this, mountProfile's own `rescopeCharts` reference would permanently stay pointed at
  // the no-op fallback after a retry, since the retry's result would never reach it.
  const reload = () => loadChartsSection(container, {
    legislatorIds, party, filters, onBarClick, onReady,
  }).catch(() => {});

  let memberRows;
  let alignmentRows;
  try {
    [memberRows, alignmentRows] = await Promise.all([
      fetchAllRows(`public_position_totals?legislator_id=in.(${legislatorIds.join(',')})`),
      fetchAllRows(`public_party_alignment?legislator_id=in.(${legislatorIds.join(',')})`),
    ]);
  } catch {
    // Covers BOTH the pre-apply state (migration 0018 not yet applied — PGRST205, "Could not
    // find the table") and any live fetch failure (statement timeout, network) with the SAME
    // honest message: the aggregates genuinely are not available right now, whatever the cause.
    sectionState(container, {
      state: 'failed',
      message: 'Aggregates unavailable until the next data update.',
      onRetry: reload,
    });
    return null;
  }

  // M3 (review, RULING): a null/unrecognized party never gets a comparison group — no fetch, no
  // figure. normalizePartyLabel mirrors migration 0018's SQL CASE exactly (vote-charts.js).
  const normalizedParty = normalizePartyLabel(party);
  const jurisdictionIds = [...new Set(memberRows.map((row) => row.jurisdiction_id).filter(Boolean))];
  // N-F: the member's OWN chambers, used whenever no chamber filter is active — see chamberParams.
  const memberChambers = [...new Set(memberRows.map((row) => row.chamber).filter(Boolean))];

  function chamberParams(chamber) {
    if (chamber) return [`chamber=eq.${chamber}`];
    if (memberChambers.length > 0) return [`chamber=in.(${memberChambers.join(',')})`];
    return [];
  }

  async function fetchPartyScope(chamber) {
    if (!normalizedParty || jurisdictionIds.length === 0) {
      return { rows: [], hasOutsideMembers: false };
    }
    const baseParams = [
      `party=eq.${encodeURIComponent(normalizedParty)}`,
      `jurisdiction_id=in.(${jurisdictionIds.join(',')})`,
      ...chamberParams(chamber),
    ];
    let rows = [];
    try {
      // N-G: ONE query against the pre-summed party rollup — no legislator-level pagination loop.
      rows = await fetchAllRows(`public_party_position_totals?${baseParams.join('&')}`);
    } catch {
      // Best-effort: distribution/cohesion remain independently good data even if this one
      // fetch fails — degrades to "party comparison not computable," never fails the section.
      rows = [];
    }
    let hasOutsideMembers = false;
    try {
      // N-A: a single limit=1 existence check, per-legislator view — answers "is anyone besides
      // this profile's own legislator ids in this exact party/jurisdiction/chamber scope?"
      const existence = await restGet(
        `public_position_totals?${baseParams.join('&')}&legislator_id=not.in.(${legislatorIds.join(',')})&select=legislator_id&limit=1`,
      );
      hasOutsideMembers = existence.rows.length > 0;
    } catch {
      hasOutsideMembers = false; // uncertain -> conservative "not computable," never a risky guess
    }
    return { rows, hasOutsideMembers };
  }

  let partyScope = await fetchPartyScope(filters.chamber);
  let partyScopeChamber = filters.chamber;

  const generation = { current: 0 };

  const rescope = async () => {
    generation.current += 1;
    const myGeneration = generation.current;
    const isStale = () => generation.current !== myGeneration;

    const distribution = summarizeTotals(memberRows, filters);
    if (distribution.total === 0) {
      if (isStale()) return;
      sectionState(container, { state: 'empty', message: 'No recorded votes for this filter.' });
      return;
    }

    if (filters.chamber !== partyScopeChamber) {
      const freshScope = await fetchPartyScope(filters.chamber);
      // Check staleness BEFORE writing to the shared partyScope/partyScopeChamber cache — a
      // stale call must never clobber what a newer, already-rendered call left behind. Without
      // this ordering, a slow-to-resolve stale fetch could overwrite partyScopeChamber back to
      // ITS OWN (stale) chamber even after skipping its own render below, which would then make
      // the NEXT real call wrongly think a re-fetch is needed for a chamber that's already cached.
      if (isStale()) return;
      partyScope = freshScope;
      partyScopeChamber = filters.chamber;
    }
    if (isStale()) return; // a newer rescope call has already superseded this one — stand down

    // N-A: never render a party comparison built from nobody but the member's own rows.
    const partyTotals = (normalizedParty && partyScope.hasOutsideMembers)
      ? summarizeTotals(partyScope.rows, filters)
      : null;
    const comparison = partyTotals ? partyComparisonModel(distribution, partyTotals) : null;
    const cohesion = cohesionFromAlignment(alignmentRows, filters);
    sectionState(container, { state: 'ready' });
    renderChartSection(container, {
      distribution, partyComparison: comparison, cohesion, partyLabel: normalizedParty, filters,
    }, onBarClick);
  };

  await rescope();
  const result = { rescope };
  if (typeof onReady === 'function') onReady(result);
  return result;
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
      // LOW-6 (task review, fix round 3): catch-wrapped like votes' `reload`.
      onRetry: () => { loadSponsorshipsSection(container, { legislatorIds }).catch(() => {}); },
    });
    throw err;
  }
}

// MED-2 (skip != empty, task review, fix round 3): `terms` is null when identity's OWN fetch
// failed (mountProfile's loadIdentityThenFreshness below), vs a real [] when the profile is
// genuinely unlinked with zero recorded terms. Those are NOT the same fact: rendering "No
// freshness data recorded" for the null case would be an AFFIRMATIVE claim about jurisdictions
// this section never actually learned. `onTermsUnknownRetry` is the only way this specific
// failure can ever recover (freshness owns no fetch of its own that could discover terms) — it
// re-triggers identity's own fetch; an ordinary in-section fetch failure (terms known, but
// public_freshness itself failed) retries just this section, unchanged from before. Exported so
// tests/person-page.test.js can assert the tri-state directly.
export async function loadFreshnessSection(container, { terms, onTermsUnknownRetry }) {
  sectionState(container, { state: 'loading' });
  if (terms === null) {
    sectionState(container, {
      state: 'failed',
      message: "Couldn't determine this profile's jurisdictions — retry",
      onRetry: onTermsUnknownRetry,
    });
    return null;
  }
  try {
    const jurisdictionIds = [...new Set((terms || []).map((t) => t.jurisdiction_id).filter(Boolean))];
    // LOW-7 (task review, fix round 3, accepted deviation, documented): a plain restGet, not
    // fetchAllRows — one row per source (a small, fixed-cardinality set of ingestion sources),
    // never large enough to need pagination.
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
      onRetry: () => { loadFreshnessSection(container, { terms, onTermsUnknownRetry }).catch(() => {}); },
    });
    throw err;
  }
}

// The shared entry point. `sections` is an object of DOM containers:
// { identity, votes, sponsorships, freshness, voteFilters, charts }. `charts` is optional (task
// 6b, additive — omitting it, as every pre-existing test in tests/person-page.test.js does, skips
// chart mounting entirely; nothing else about the page changes). `person` is null for the
// legislator.html single-row path (design spec §3).
export async function mountProfile(sections, { person, legislators }) {
  const legislatorIds = (legislators || []).map((l) => l.id);

  // loadIdentity/loadFreshness are split out (rather than one inline block) so the INITIAL mount
  // below can interleave votes between them (NEW-B), while BOTH retry buttons still funnel
  // through the single loadIdentityThenFreshness composition (NEW-A) — `function` declarations
  // so the three can reference each other regardless of textual definition order (hoisted).
  async function loadIdentity() {
    return loadIdentitySection(sections.identity, {
      person, legislators, legislatorIds, reload: () => { loadIdentityThenFreshness().catch(() => {}); },
    }).catch(() => ({ terms: null, identity: null }));
  }
  async function loadFreshness(terms) {
    return loadFreshnessSection(sections.freshness, {
      terms,
      onTermsUnknownRetry: () => { loadIdentityThenFreshness().catch(() => {}); },
    }).catch(() => {});
  }
  // MED-2 + NEW-A: the RETRY-time composition — both identity's own retry AND freshness's own
  // retry point HERE, so either button recovers both sections. (Freshness has no fetch of its
  // own that could ever discover terms without identity re-running first; before this fix,
  // identity's retry bypassed freshness entirely, leaving it stranded on "Couldn't determine
  // this profile's jurisdictions" even after identity itself recovered.)
  async function loadIdentityThenFreshness() {
    const { terms } = await loadIdentity();
    await loadFreshness(terms);
    return terms;
  }

  // NEW-B: the INITIAL mount must not let votes (the page's centerpiece) wait on freshness's
  // round-trip. Identity is awaited first (both votes' legislatorIds and freshness's terms
  // conceptually follow it), but freshness is only STARTED here, not awaited — it proceeds
  // concurrently with votes/sponsorships below (still gets exactly terms-or-null, same tri-state
  // semantics as always; only the ordering relative to votes changed) and is awaited once, at
  // the very end, so mountProfile's own returned promise still reflects every section settling.
  const { terms, identity } = await loadIdentity();
  const freshnessLoad = loadFreshness(terms);

  const filters = { chamber: null, year: null, missedOnly: false, page: 1 };
  const voteGeneration = { current: 0 };
  const runVotes = () => loadVotesSection(sections.votes, { legislatorIds, filters, voteGeneration }).catch(() => {});

  // Task 6b: the charts section mounts ABOVE the vote list, driven by the SAME filters object —
  // the filter controls below AND a chart bar click both end up here, so a filter change always
  // resets votes to page 1 AND re-scopes the charts together (design spec §3, "Context beyond the
  // brief"). `rescopeCharts` starts as a no-op so `refresh` is safe to wire into the filter
  // controls even before the charts fetch itself resolves (or when sections.charts is absent).
  // The no-op fallback returns a resolved promise (not undefined) specifically so `.catch()` below
  // is always safe to call, whether or not the real rescope has been wired in yet.
  //
  // N-B (review, fix round 2): rescope() is async and can throw (its own internal fetch failures
  // are already caught, but a render-phase throw is not) — `.catch(() => {})` at THIS call site
  // (the one place every rescope invocation funnels through) is what stops that from ever
  // surfacing as an unhandled promise rejection, mirroring `runVotes`' own `.catch(() => {})`.
  let rescopeCharts = () => Promise.resolve();
  const refresh = () => {
    runVotes();
    rescopeCharts().catch(() => {});
  };
  // L1 (review, fix round 1): a bar click that would produce the SAME resulting filter state (no
  // non-page key actually changes — e.g. clicking the already-active bar a second time) is a
  // no-op: filters stay untouched, including `page` — no reset, no re-fetch, no re-render.
  // Compares nextVoteFilters' own candidate result against the current filters, ignoring `page`
  // itself (which nextVoteFilters always forces to 1 on any non-page patch — suppressing exactly
  // that forced reset when nothing else actually changed is the whole point of this check).
  //
  // Bar clicks carry a filter PATCH (they don't mutate `filters` themselves, unlike
  // wireVoteFilters' own controls below) — apply it through the SAME nextVoteFilters reducer,
  // then refresh both sections exactly like any other real filter change.
  const onBarClick = (patch) => {
    const candidate = nextVoteFilters(filters, patch);
    const unchanged = Object.keys(candidate)
      .filter((key) => key !== 'page')
      .every((key) => candidate[key] === filters[key]);
    if (unchanged) return;
    Object.assign(filters, candidate);
    refresh();
  };

  // H4 (review, fix round 1): the charts fetch must not block votes (the page's centerpiece) —
  // STARTED here, not awaited, same NEW-B pattern freshness already uses below; awaited once, at
  // the very end, alongside freshness. `onReady` (M1) keeps `rescopeCharts` pointed at whichever
  // load's rescope function most recently succeeded, including a post-failure retry.
  let chartsLoad = Promise.resolve();
  if (sections.charts) {
    chartsLoad = loadChartsSection(sections.charts, {
      legislatorIds,
      party: identity ? identity.party : null,
      filters,
      onBarClick,
      onReady: (result) => { rescopeCharts = result.rescope; },
    }).catch(() => {});
  }

  if (sections.voteFilters) {
    wireVoteFilters(sections.voteFilters, filters, refresh);
  }
  await runVotes();

  await loadSponsorshipsSection(sections.sponsorships, { legislatorIds }).catch(() => {});
  await freshnessLoad;
  await chartsLoad;
}

// Wires the filter controls (chamber select, year select/input, missed-votes checkbox) to
// re-query the server via the SAME path builder (voteFilterQuery) on every change — never a
// client-side re-sort/filter of the page already in hand (brief: "filter controls re-query the
// SERVER, never client-sort partial pages"). Every change goes through nextVoteFilters (fix
// round 2, finding 1) — the same pure "reset to page 1 on a real filter change" reducer the
// Prev/Next buttons use, so a stale page number never survives a filter change. `onChange` (task
// 6b rename from `runVotes`) now also re-scopes the charts section above, via the SAME reducer —
// existing behavior (nextVoteFilters/the reset-to-page-1 rule) hooked, not new plumbing.
function wireVoteFilters(container, filters, onChange) {
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
    onChange();
  });

  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.placeholder = 'Year (e.g. 2023)';
  yearInput.addEventListener('change', () => {
    const v = yearInput.value.trim();
    Object.assign(filters, nextVoteFilters(filters, { year: v ? Number(v) : null }));
    onChange();
  });

  const missedLabel = document.createElement('label');
  const missedCheckbox = document.createElement('input');
  missedCheckbox.type = 'checkbox';
  missedCheckbox.addEventListener('change', () => {
    Object.assign(filters, nextVoteFilters(filters, { missedOnly: missedCheckbox.checked }));
    onChange();
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
    charts: document.getElementById('charts'),
    votes: document.getElementById('votes'),
    sponsorships: document.getElementById('sponsorships'),
    freshness: document.getElementById('freshness'),
  }, existence);
}
