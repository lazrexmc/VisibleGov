// site/js/directory-page.js — site/index.html's entry point: the directory + address lookup,
// "the front door" (design spec §5, task-8-brief.md). Same split as site/js/person-page.js: pure
// model functions first (TDD'd in tests/directory-model.test.js BEFORE the DOM code existed),
// DOM/network orchestration below. Reuses the existing toolbox by exact name — never a lookalike
// reimplementation: rest.js (fetchAllRows), render.js (el/clearChildren/sectionState/mountFooter),
// profile-model.js (chamberLabel), slugs.js (slugify — moved there in fix round 1, LOW-8, so the
// front door's own import graph doesn't have to pull in the whole person-page.js/vote-charts.js
// module tree just for one string helper), districts.js (parseGeographies/matchReps/
// termDateEvidence, task-8's own new pure module).

import { fetchAllRows } from './rest.js';
import {
  el, clearChildren, sectionState, mountFooter,
} from './render.js';
import { chamberLabel, partyBySourcePrecedence } from './profile-model.js';
import { slugify } from './slugs.js';
import {
  parseGeographies, matchReps, termDateEvidence, isMOState,
} from './districts.js';
import { PRIVACY_CONTRACT_TEXT } from './copy.js';

// ============================================================================
// Pure model (TDD'd in tests/directory-model.test.js BEFORE any of the DOM code below existed)
// ============================================================================

// Mirrors profile-model.js's own "most recent term wins" anchor rule (that file's private
// mostRecentTerm) — not imported (profile-model.js only exports chamberLabel for this task, per
// the brief), so this is a small hand-written equivalent scoped to the directory's own terms
// shape. Only a term carrying a start_date can be ranked; no dated term at all -> null (the
// caller falls back to "the first term in hand," same as profile-model.js does).
function mostRecentDatedTerm(terms) {
  const dated = (terms || []).filter((t) => t && t.start_date);
  if (dated.length === 0) return null;
  return dated.reduce((best, t) => (!best || t.start_date > best.start_date ? t : best), null);
}

// Fix round 1 (task-8 review, LOW-7): mirrors profile-model.js's own isMeaninglessDistrict —
// U.S. Senate terms store the state's USPS abbreviation in `district` (terms.district-as-state
// convention, backfill-term-states.js's own header comment), never a real district number.
// "U.S. Senate, district MO" would read as a real congressional district that doesn't exist.
// Small independent copy (not imported — profile-model.js keeps this private) rather than
// widening that module's exported surface for a one-line predicate; MO/state-legislature
// districts are real numbers and stay unaffected.
function isSenateDistrictMeaningless(jurisdictionId, chamber) {
  return jurisdictionId === 'us-congress' && chamber === 'senate';
}

// legislators.surname (migration 0006) is populated for MO House/Senate rows only — federal rows
// (us-congress.js/us-senate.js adapters) never set it. A missing surname must not silently break
// the sort: this derives a display-only sort key from the LAST whitespace token of the full name
// (a real surname for the overwhelmingly common "First Last" shape). Unlike
// reconstructSurnameHeuristic (src/cli/ingest-mo-house.js, which drops everything after the FIRST
// token and is used for identity-critical roll-call matching), this is purely a cosmetic sort
// fallback — a wrong guess here just orders one row slightly off, never a data-integrity issue.
function fallbackSurname(fullName) {
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens[tokens.length - 1] : null;
}

// fetchAllRows over legislators+persons+terms -> one entry per person/ungrouped-legislator-row,
// grouped by person_id (a null/absent person_id stands alone), chamber/party/district from the
// group's own most-recent term, alphabetical by surname (the one neutral order). Links reuse the
// exact /person/<id>/<slug> and /legislator/<id>/<slug> shapes person-page.js uses — never a
// third slug scheme. Never throws on missing/malformed input.
export function buildDirectoryEntries({ legislators, persons, terms } = {}) {
  const legislatorRows = (Array.isArray(legislators) ? legislators : []).filter(Boolean);
  const personRows = (Array.isArray(persons) ? persons : []).filter(Boolean);
  const termRows = (Array.isArray(terms) ? terms : []).filter(Boolean);

  const personById = new Map(personRows.map((p) => [p.id, p]));
  const termsByLegislatorId = new Map();
  for (const t of termRows) {
    if (!t || !t.legislator_id) continue;
    if (!termsByLegislatorId.has(t.legislator_id)) termsByLegislatorId.set(t.legislator_id, []);
    termsByLegislatorId.get(t.legislator_id).push(t);
  }

  // Group legislator rows by person_id; an ungrouped row (no person_id) is its own group of one.
  const groups = new Map();
  for (const row of legislatorRows) {
    if (!row || !row.id) continue;
    const key = row.person_id ? `person:${row.person_id}` : `legislator:${row.id}`;
    if (!groups.has(key)) groups.set(key, { personId: row.person_id || null, legislatorRows: [] });
    groups.get(key).legislatorRows.push(row);
  }

  const entries = [];
  for (const [key, group] of groups) {
    const groupTerms = group.legislatorRows.flatMap((r) => termsByLegislatorId.get(r.id) || []);
    const datedAnchor = mostRecentDatedTerm(groupTerms);
    const anchorTerm = datedAnchor ?? groupTerms[0] ?? null;
    const anchorLegislator = (anchorTerm
      && group.legislatorRows.find((r) => r.id === anchorTerm.legislator_id))
      || group.legislatorRows[0];

    const person = group.personId ? personById.get(group.personId) : null;
    const displayName = person?.display_name || anchorLegislator?.full_name || '(name unrecorded)';
    const surname = anchorLegislator?.surname
      || group.legislatorRows.find((r) => r && r.surname)?.surname
      || fallbackSurname(displayName);
    // FINAL REVIEW, finding 6: this used to fall back to `anchorLegislator?.party` — whichever
    // legislator row happened to be first in the fetched array, since Postgres promises no order.
    // For a merged person with no dated term (Curls: a null-party mo_senate row and a 'D' legiscan
    // row) that made the displayed party depend on incidental array position, and the front door
    // disagreed with the profile page about the same person. Now it reuses profile-model.js's own
    // source-precedence ranking — the SAME function resolveParty uses, imported rather than
    // re-listed, so the two surfaces cannot drift apart again.
    const party = anchorTerm?.party || partyBySourcePrecedence(group.legislatorRows);
    const chamber = anchorTerm ? chamberLabel(anchorTerm.jurisdiction_id, anchorTerm.chamber) : null;
    const district = (anchorTerm && !isSenateDistrictMeaningless(anchorTerm.jurisdiction_id, anchorTerm.chamber))
      ? (anchorTerm.district ?? null)
      : null;

    // Serving now / Past members split (2026-08-06 spec §2): an open term is the data literally
    // saying "not ended" — that, and only that, is the serving signal. Zero terms can't prove
    // service, so they stay out of "Serving now."
    const servingNow = groupTerms.some((t) => t.end_date == null);
    // The tenure fragment only ever describes the anchor term the entry displays, and only when
    // that anchor is itself open and genuinely dated.
    const sinceRaw = datedAnchor && datedAnchor.end_date == null
      ? Number(String(datedAnchor.start_date).slice(0, 4))
      : null;
    const sinceYear = Number.isFinite(sinceRaw) ? sinceRaw : null;

    const href = group.personId
      ? `/person/${group.personId}/${slugify(displayName)}`
      : `/legislator/${anchorLegislator.id}/${slugify(displayName)}`;

    entries.push({
      key,
      legislatorIds: group.legislatorRows.map((r) => r.id),
      personId: group.personId,
      displayName,
      surname,
      party,
      chamber,
      district,
      servingNow,
      sinceYear,
      href,
    });
  }

  // Fix round 1 (task-8 review, LOW-10): localeCompare with a fixed locale/sensitivity rather
  // than a manual toLowerCase()+</> comparison — the standard, locale-aware way to alphabetize
  // (handles accented surnames etc. correctly; toLowerCase()+</> is a plain codepoint compare that
  // gets those wrong).
  entries.sort((a, b) => {
    const bySurname = (a.surname || '').localeCompare(b.surname || '', 'en', { sensitivity: 'base' });
    if (bySurname !== 0) return bySurname;
    return (a.displayName || '').localeCompare(b.displayName || '', 'en', { sensitivity: 'base' });
  });

  return entries;
}

// Client-side text filter over the COMPLETE fetched list (name + chamber + party) — never a
// partial-page server re-sort/filter (the brief: "a filter over a COMPLETE fetched list"). Empty/
// whitespace-only query returns the list unchanged. Never throws on malformed input.
export function filterDirectory(entries, queryText) {
  const list = Array.isArray(entries) ? entries : [];
  const q = String(queryText || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((e) => {
    if (!e) return false;
    const haystack = [e.displayName, e.chamber, e.party].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

// Splits the already-sorted entry list into the two directory views (2026-08-06 spec §2). Pure,
// order-preserving; an entry that cannot prove service (servingNow falsy/absent) is never
// promoted into "Serving now." Never throws on malformed input.
export function partitionDirectory(entries) {
  const servingNow = [];
  const past = [];
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    if (!entry) continue;
    (entry.servingNow ? servingNow : past).push(entry);
  }
  return { servingNow, past };
}

// legislator id -> its directory entry (displayName/href already resolved through the SAME
// person-vs-legislator link logic buildDirectoryEntries used) — reused by the address-lookup
// results below so a matched rep links exactly like their directory row does, one link-building
// code path instead of two.
function indexEntriesByLegislatorId(entries) {
  const index = new Map();
  for (const entry of entries) {
    for (const legId of entry.legislatorIds) index.set(legId, entry);
  }
  return index;
}

// ============================================================================
// DOM rendering (not independently unit-tested — same convention as person-page.js's own DOM
// helpers; smoke-tested live). Small and named so each does one thing.
// ============================================================================

function renderDirectoryList(container, entries) {
  clearChildren(container);
  const ul = el('ul', { class: 'directory-list' });
  for (const entry of entries) {
    const li = el('li', { class: 'directory-row' });
    li.appendChild(el('a', { href: entry.href }, entry.displayName));
    const meta = [
      entry.chamber,
      entry.district ? `district ${entry.district}` : null,
      entry.party,
      // Tenure fragment (2026-08-06 spec §2): only for a serving entry whose displayed anchor
      // term is open AND dated — absent data renders nothing, never a guess.
      entry.servingNow && entry.sinceYear ? `since ${entry.sinceYear}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (meta) li.appendChild(el('span', { class: 'directory-meta' }, ` — ${meta}`));
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

const SEAT_LABELS = {
  usSenators: 'U.S. Senate',
  usHouse: 'U.S. House',
  moSenate: 'MO Senate',
  moHouse: 'MO House',
};
const SEAT_ORDER = ['usSenators', 'usHouse', 'moSenate', 'moHouse'];

function renderCandidate(candidate, entryIndex) {
  const li = el('li', { class: 'rep-candidate' });
  const linked = entryIndex.get(candidate.legislator.id);
  const displayName = linked ? linked.displayName : (candidate.legislator.full_name || '(name unrecorded)');
  const href = linked ? linked.href : `/legislator/${candidate.legislator.id}/${slugify(displayName)}`;
  li.appendChild(el('a', { href }, displayName));
  const party = candidate.term?.party || candidate.legislator.party || null;
  if (party) li.appendChild(el('span', { class: 'rep-party' }, ` — ${party}`));
  li.appendChild(el('p', { class: 'rep-date-evidence' }, termDateEvidence(candidate.term)));
  return li;
}

// A category is only rendered at all when it is GEOGRAPHICALLY IN SCOPE for the matched address
// (mirrors matchReps' own gating conditions EXACTLY, including case-insensitivity via the SAME
// imported isMOState — micro-round N2: a strict `=== 'MO'` copy here used to disagree with
// matchReps' own case-insensitive check, so a lowercase STUSAB could make matchReps correctly
// find a MO candidate while this gate still called the category out of scope, dropping a real
// matched rep with no message at all — skip != empty) — a non-MO address never mentions MO
// Senate/House at all, since those categories are structurally inapplicable there, not merely
// empty.
const SEAT_IN_SCOPE = {
  usSenators: (geo) => Boolean(geo?.state),
  usHouse: (geo) => Boolean(geo?.state),
  moSenate: (geo) => isMOState(geo?.state),
  moHouse: (geo) => isMOState(geo?.state),
};

// MED-5 (task-8 review): distinct from "in scope but zero legislators matched" — this is "in
// scope, but the Census Geocoder itself didn't return the district layer this category needs" (a
// real, legitimate Census response shape: PO boxes and some edge-case addresses omit a layer).
// U.S. Senate has no district dimension at all, so it can never hit this case.
const SEAT_DISTRICT_MISSING = {
  usSenators: () => false,
  usHouse: (geo) => geo?.cd == null,
  moSenate: (geo) => geo?.sldu == null,
  moHouse: (geo) => geo?.sldl == null,
};

const SEAT_DISTRICT_MISSING_MESSAGE = {
  usHouse: "The geocoder didn't return your U.S. House district.",
  moSenate: "The geocoder didn't return your MO Senate district.",
  moHouse: "The geocoder didn't return your MO House district.",
};

// "skip != empty" (the same discipline sectionState enforces everywhere else on this site): an
// in-scope category with a known district but zero matched legislators says so explicitly (a
// real, evidenced live case — the terms table currently carries near-zero mo-legislature rows)
// rather than silently vanishing, which would look identical to "this address has no such seat."
const SEAT_EMPTY_MESSAGE = {
  usSenators: 'No U.S. Senate representative found in our data for this state.',
  usHouse: 'No U.S. House representative found in our data for this district.',
  moSenate: 'No MO Senate representative found in our data for this district.',
  moHouse: 'No MO House representative found in our data for this district.',
};

// Renders every IN-SCOPE category (fix round 1, LOW-11: unconditionally — even when every single
// category came back empty, this still renders the as-of line plus each category's own honest
// message, never one generic "nothing found" line that erases which categories were even
// checked). Each category gets exactly one of three honest states: a missing-district notice
// (MED-5), an explicit "not found" (skip != empty), or its real candidates with per-candidate date
// evidence (an ambiguous seat's every candidate renders — showing candidates honestly beats
// guessing). Currency-honesty law (spec §5): never the word "current" — matchReps already
// enforces this in the asOf string rendered here.
function renderMatchedReps(container, matched, entryIndex, geo) {
  clearChildren(container);
  container.appendChild(el('p', { class: 'reps-as-of' }, `Results shown ${matched.asOf}.`));
  for (const groupKey of SEAT_ORDER) {
    if (!SEAT_IN_SCOPE[groupKey](geo)) continue;
    const section = el('section', { class: `rep-group rep-group-${groupKey}` });
    section.appendChild(el('h3', {}, SEAT_LABELS[groupKey]));
    if (SEAT_DISTRICT_MISSING[groupKey](geo)) {
      section.appendChild(el('p', { class: 'rep-group-missing-district' }, SEAT_DISTRICT_MISSING_MESSAGE[groupKey]));
    } else {
      const candidates = matched[groupKey] || [];
      if (candidates.length === 0) {
        section.appendChild(el('p', { class: 'rep-group-empty' }, SEAT_EMPTY_MESSAGE[groupKey]));
      } else {
        const ul = el('ul', {});
        for (const candidate of candidates) ul.appendChild(renderCandidate(candidate, entryIndex));
        section.appendChild(ul);
      }
    }
    container.appendChild(section);
  }
}

// ============================================================================
// Orchestration — three-state discipline on every fetch section (plan law, verbatim: "a failed
// fetch never renders as an empty section").
// ============================================================================

// N1 (task-8 re-review, MEDIUM, wrong-rep surface — reproduced by the reviewer: a slow KS
// response can resolve AFTER a faster, later MO submission and overwrite the correct MO result
// with Kansas districts). `isStale` is threaded through from runAddressLookupWithData's own
// generation counter (mirrors person-page.js's loadVotesSection/loadChartsSection voteGeneration
// pattern exactly) — checked before EVERY write to resultsContainer, both sectionState calls and
// renderMatchedReps, so a superseded call's async work (however late it resolves) can never
// render over a newer submission's result.
async function runAddressLookup(address, {
  resultsContainer, legislators, terms, entryIndex, isStale,
}) {
  const retry = () => runAddressLookup(address, {
    resultsContainer, legislators, terms, entryIndex, isStale,
  });

  if (isStale()) return;
  sectionState(resultsContainer, { state: 'loading' });
  let censusJson;
  try {
    // CONTROLLER RULING (task-8 review, fix round 1 — was "design call for Lance," ruled toward
    // the STRONGER privacy reading): POST with the address in a JSON body, never a GET query
    // string. Cloudflare records ClientRequestURI (including query strings) on OUR OWN origin's
    // edge logs regardless of anything the geocode function itself does — a POST body is not part
    // of that request-line surface. The outbound request to the Census Geocoder itself is
    // unchanged (their API requires GET) — that half is exactly what the privacy contract
    // sentence on the page discloses.
    const res = await fetch('/geocode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    censusJson = await res.json();
    if (!res.ok) {
      // The pass-through function itself returned an error body (upstream Census failure, or our
      // own validation) — an honest failure, not a "no districts found" result.
      throw new Error(censusJson?.error || 'geocoder unavailable');
    }
  } catch {
    if (isStale()) return;
    sectionState(resultsContainer, {
      state: 'failed',
      message: "Couldn't reach the address geocoder — retry",
      onRetry: retry,
    });
    return;
  }

  if (isStale()) return;
  const geo = parseGeographies(censusJson);
  if (!geo.state) {
    if (isStale()) return;
    sectionState(resultsContainer, { state: 'empty', message: "The geocoder couldn't match that address." });
    return;
  }

  // LOW-11 (task-8 review): renderMatchedReps ALWAYS runs once an address resolves to a state —
  // it renders its own honest per-category message for every empty/missing-district case, so
  // there is no separate "nothing found at all" branch here that would erase which categories
  // were even checked.
  const matched = matchReps({ terms, legislators }, geo);
  if (isStale()) return;
  sectionState(resultsContainer, { state: 'ready' });
  renderMatchedReps(resultsContainer, matched, entryIndex, geo);
}

// The three fetchAllRows calls the directory (list AND address lookup) both depend on, factored
// out so a retry of either section can re-issue it independently (see dataState below).
// FINAL REVIEW, finding 5: every one of these passes `order: 'id'` — the deterministic order
// chunked .range() paging requires (rest.js's own comment, and db.js's selectAll before it). These
// three are the exact reads the finding named: a legislator silently dropped into a chunk gap here
// is a wrong answer about who represents someone. All three tables carry a uuid primary key `id`,
// same property selectAll relies on server-side.
async function loadDirectoryData() {
  const [legislators, persons, terms] = await Promise.all([
    fetchAllRows('legislators?select=id,full_name,surname,party,person_id,bioguide_id,mo_senate_id,mo_house_id,openstates_id,legiscan_people_id', { order: 'id' }),
    fetchAllRows('persons?select=id,display_name', { order: 'id' }),
    fetchAllRows('terms?select=legislator_id,jurisdiction_id,chamber,district,state,party,start_date,end_date', { order: 'id' }),
  ]);
  return { legislators, persons, terms };
}

// MAJOR-1 (task-8 review, review-blocking privacy fix): preventDefault() fires FIRST and
// UNCONDITIONALLY, synchronously inside the listener — the form can never fall through to a
// native GET navigation (which would put the typed address on the URL, browser history, and this
// origin's own request-line logs) regardless of whether directory data has loaded, is still
// loading, or has already failed. Exported so tests/directory-page.test.js can wire a bare
// form/input/container directly (same convention as person-page.js's other DOM-touching exports)
// and prove `event.defaultPrevented` synchronously, before any await ever runs.
//
// `dataState` is a mutable `{ promise }` holder (not a bare promise): a later retry of the
// directory-list section can refresh `dataState.promise` in place, and every future submit reads
// it fresh — without ever needing to attach a second listener to the same form element.
//
// N1 (task-8 re-review, MEDIUM): `generation` is declared ONCE here, shared by every submit this
// form ever fires — mirrors person-page.js's voteGeneration pattern (one counter object per
// section, incremented at the true start of every re-entry).
export function wireAddressForm({
  form, input, resultsContainer, dataState,
}) {
  if (!form) return;
  const generation = { current: 0 };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = (input?.value || '').trim();
    if (!address) return;
    runAddressLookupWithData(address, { resultsContainer, dataState, generation }).catch(() => {});
  });
}

// Awaits the shared directory-data promise ONLY at submit time (never eagerly at mount) — if it's
// still pending, this waits for it; if it has already rejected (or rejects later), this renders
// the honest "unavailable" message instead of ever silently doing nothing.
//
// N1: increments `generation` synchronously as its own FIRST statement, before any await — this
// is "the one place every re-entry funnels through" (every submit AND the failed-state's own
// retry both call this), so capturing `myGeneration` here, before anything can interleave, is
// what makes every later `isStale()` check meaningful. The reviewer's own repro: submit a
// slow-resolving address, then submit a fast one — without this, the slow submission's LATE
// resolution (however long it takes) can still overwrite the fast, correct, already-rendered
// result from the newer submission.
async function runAddressLookupWithData(address, { resultsContainer, dataState, generation }) {
  generation.current += 1;
  const myGeneration = generation.current;
  const isStale = () => generation.current !== myGeneration;

  // N3 (task-8 re-review, LOW): captured explicitly so a later retry can tell whether
  // dataState.promise has ALREADY been refreshed by someone else (the directory-list section's
  // own independent retry) since THIS attempt started — see the retry closure below.
  const attemptedPromise = dataState.promise;
  let data;
  try {
    data = await attemptedPromise;
  } catch {
    if (isStale()) return;
    sectionState(resultsContainer, {
      state: 'failed',
      message: "Directory data unavailable — districts can't be matched right now",
      onRetry: () => {
        // N3: only fire a NEW fetch if dataState.promise is STILL the one that failed here — if
        // the directory list's own retry already refreshed it (to an in-flight or already-good
        // promise) in the meantime, reuse THAT instead of firing a redundant extra fetch. Reading
        // dataState.promise fresh, right here at retry-click time (not the stale `attemptedPromise`
        // closed over above), is what makes a recovered directory + resubmit/retry actually render
        // real results instead of staying stuck re-announcing "unavailable."
        if (dataState.promise === attemptedPromise) {
          dataState.promise = loadDirectoryData();
        }
        runAddressLookupWithData(address, { resultsContainer, dataState, generation }).catch(() => {});
      },
    });
    return;
  }
  if (isStale()) return;
  const entries = buildDirectoryEntries(data);
  const entryIndex = indexEntriesByLegislatorId(entries);
  await runAddressLookup(address, {
    resultsContainer, legislators: data.legislators, terms: data.terms, entryIndex, isStale,
  });
}

// The two-view controller (2026-08-06 spec §2/§4): tracks the active view + re-renders on toggle
// or search input. The search filters rows WITHIN the active view; the toggle badges always carry
// the FULL partition counts. Per-view empty messages keep "no matches" distinguishable from a
// broken fetch (sectionState discipline). The word "current" appears nowhere.
const VIEW_EMPTY_MESSAGE = {
  serving: 'No legislators match this filter among members serving now.',
  past: 'No legislators match this filter among past members.',
};

function wireDirectoryView({
  servingButton, pastButton, filterInput, container, partitions,
}) {
  if (!container) return;
  const state = { activeView: 'serving' };

  if (servingButton) servingButton.textContent = `Serving now (${partitions.servingNow.length})`;
  if (pastButton) pastButton.textContent = `Past members (${partitions.past.length})`;

  const render = () => {
    if (servingButton) servingButton.setAttribute('aria-pressed', String(state.activeView === 'serving'));
    if (pastButton) pastButton.setAttribute('aria-pressed', String(state.activeView === 'past'));
    const activeEntries = state.activeView === 'serving' ? partitions.servingNow : partitions.past;
    const filtered = filterDirectory(activeEntries, filterInput ? filterInput.value : '');
    if (filtered.length === 0) {
      sectionState(container, { state: 'empty', message: VIEW_EMPTY_MESSAGE[state.activeView] });
    } else {
      sectionState(container, { state: 'ready' });
      renderDirectoryList(container, filtered);
    }
  };

  if (servingButton) servingButton.addEventListener('click', () => { state.activeView = 'serving'; render(); });
  if (pastButton) pastButton.addEventListener('click', () => { state.activeView = 'past'; render(); });
  if (filterInput) filterInput.addEventListener('input', render);
  render();
}

// The directory-list section's own fetch-or-reuse + render + retry — split out from
// bootstrapDirectoryPage so its retry can refresh `dataState.promise` IN PLACE (benefiting the
// address form's next submit too) without ever re-running bootstrapDirectoryPage as a whole
// (which would re-attach a second submit listener to the same, already-wired form element).
async function loadAndRenderDirectory(dataState, {
  directoryListContainer, filterInput, servingButton, pastButton,
}) {
  sectionState(directoryListContainer, { state: 'loading' });
  let entries;
  try {
    entries = buildDirectoryEntries(await dataState.promise);
  } catch {
    sectionState(directoryListContainer, {
      state: 'failed',
      message: "Couldn't load the directory — retry",
      onRetry: () => {
        dataState.promise = loadDirectoryData();
        loadAndRenderDirectory(dataState, {
          directoryListContainer, filterInput, servingButton, pastButton,
        }).catch(() => {});
      },
    });
    return;
  }

  if (entries.length === 0) {
    sectionState(directoryListContainer, { state: 'empty', message: 'No legislators recorded.' });
    return;
  }
  wireDirectoryView({
    servingButton, pastButton, filterInput, container: directoryListContainer, partitions: partitionDirectory(entries),
  });
}

// renderPrivacyContract: fills index.html's #privacy-contract placeholder with the SAME
// PRIVACY_CONTRACT_TEXT constant (site/js/copy.js) trust.html's attribution section renders —
// task-10 review, LOW-1: one wording, never a hand-typed copy that could drift. Pure DOM, kept
// independently testable from bootstrapDirectoryPage (same split as every other render* helper in
// this file).
export function renderPrivacyContract(container) {
  clearChildren(container);
  container.appendChild(el('span', {}, PRIVACY_CONTRACT_TEXT));
}

// Entry point for site/index.html — exported, never auto-run at module load (same convention as
// bootstrapPersonPage/bootstrapLegislatorPage).
export async function bootstrapDirectoryPage() {
  const directoryListContainer = document.getElementById('directory-list');
  const filterInput = document.getElementById('directory-filter');
  const servingButton = document.getElementById('directory-view-serving');
  const pastButton = document.getElementById('directory-view-past');
  const addressForm = document.getElementById('address-form');
  const addressInput = document.getElementById('address-input');
  const addressResults = document.getElementById('address-results');
  mountFooter(document.getElementById('site-footer'));
  renderPrivacyContract(document.getElementById('privacy-contract'));

  // MAJOR-1: the address form is wired SYNCHRONOUSLY here, before the first `await` below —
  // never after the directory fetch settles, and never inside its own failure path (which used
  // to `return` before ever reaching the wiring call at all).
  const dataState = { promise: loadDirectoryData() };
  wireAddressForm({
    form: addressForm, input: addressInput, resultsContainer: addressResults, dataState,
  });

  await loadAndRenderDirectory(dataState, {
    directoryListContainer, filterInput, servingButton, pastButton,
  });
}
