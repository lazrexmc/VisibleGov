// site/js/vote-charts.js — the profile page's vote-aggregate charts (design spec §3, "Vote
// aggregates"; .superpowers/sdd/2026-07-30-public-site/task-6b-brief.md). Browser-native ES
// module. Pure math (formatShare, normalizePartyLabel, summarizeTotals, cohesionFromAlignment,
// partyComparisonModel, METRIC_DEFINITIONS) has zero imports and zero DOM — TDD'd in
// tests/vote-charts.test.js before any of it existed. renderChartSection is the one DOM-touching
// export; it imports render.js's el()/clearChildren, the SAME element-construction primitive
// every other page section uses, so the "all DB text via textContent, never innerHTML" guarantee
// holds here too.
//
// Lance's direction, verbatim intent (task context, 2026-07-30): "users evaluate politicians —
// the charts answer 'how do they vote' at a glance, mechanically. Numbers only; no grades, no
// adjectives, no ranked lists of politicians." Every function in this file is checked against
// that before it ships. In particular:
// - No color-codes "good" vs "bad" positions (e.g. green=yea/red=nay) — that would read as a
//   value judgment on which vote is "correct." Every bar uses the SAME neutral fill class.
// - partyComparisonModel is member-vs-own-party-AGGREGATE arithmetic only. It is never handed
//   two individual legislators — there is no code path in this file that could produce a
//   member-vs-member number.
// - Cohesion and party-comparison both return null (never a misleading "0.0%") when their
//   denominator is genuinely zero — "not computable" and "computed as exactly zero" are
//   different facts, same discipline as the rest of the site's skip≠empty rule.
//
// FIX ROUND 1 (review verdict, spec FAIL): party is now NORMALIZED (normalizePartyLabel, mirrored
// exactly by migration 0018's SQL CASE — R/D/I -> Republican/Democratic/Independent, everything
// else passes through raw) rather than compared as a raw, inconsistently-recorded string; bar
// clicks map onto real per-position filters (H2) instead of a coarse missedOnly-only toggle;
// cohesion is scoped by chamber as well as year (H3); METRIC_DEFINITIONS was rewritten so every
// clause matches the implementation exactly (no more "not normalized" — it now is).
//
// FIX ROUND 2 (re-review, spec NOT CLOSED — 2 new HIGH blockers + ride-alongs): N-A extended the
// "no group of one" rule to party comparison too (a lone Independent used to get their OWN rows
// back as "the party aggregate" — member-vs-himself, the exact violation design spec §3 forbids;
// person-page.js's loadChartsSection now checks for this before ever calling
// partyComparisonModel). N-C: the position/missed-only filter a bar click applies to the vote list
// below was invisible and sticky — active bars now carry `aria-pressed` + a visible active class,
// and a "Clear position filter" control appears whenever one is active. N-D: METRIC_DEFINITIONS
// gained a staleness disclosure (the charts are computed from a periodically refreshed snapshot,
// not live — the vote list stays live). N-H(f): cohesion's definition now states the member's own
// cast counts as one of their party's casts when the majority is computed (never excluded from
// their own party's tally).

import { el, clearChildren } from './render.js';

// ============================================================================
// formatShare — the documented rounding rule: one decimal place, HALF ROUND UP (never
// round-half-to-even/banker's rounding). Implemented with exact integer arithmetic (never
// float multiplication/division on the boundary) so a percentage that lands exactly on a
// rounding boundary (e.g. 1/16 = 6.25%) always resolves the same, predictable direction.
//
// Derivation: share_tenths_of_a_percent = round_half_up(count / total * 1000). Using integer
// math: floor((count*2000 + total) / (2*total)) is exactly that half-up round of
// (count*1000/total), because adding `total` (i.e. half of `2*total`) before an integer floor
// division is the standard half-up-rounding trick, and multiplying every term by 2 first keeps
// everything an exact integer (no float rounding can creep in before the intentional one floor).
// ============================================================================
export function formatShare(count, total) {
  const c = Number(count) || 0;
  const t = Number(total) || 0;
  if (t <= 0) return '0.0%';
  const tenths = Math.floor((c * 2000 + t) / (2 * t));
  return `${(tenths / 10).toFixed(1)}%`;
}

// ============================================================================
// normalizePartyLabel — MUST mirror migration 0018's SQL CASE exactly (C1+C2, the review's
// corrected ruling): 'R' -> 'Republican', 'D' -> 'Democratic', 'I' -> 'Independent'; a value
// that is ALREADY one of those three full forms passes through unchanged; every other value
// (an unrecognized label, an empty string, or no party at all) resolves to null — a documented,
// known-equivalence normalization (never a guess at what an unfamiliar label "probably" means).
//
// null is also the M3 signal: "null/unrecognized-party members simply never match a party group
// — no figure." The party-comparison fetch and its rendering both key off this null to skip the
// metric entirely rather than compare against a group of one (or zero).
// ============================================================================
const PARTY_ABBREVIATIONS = { R: 'Republican', D: 'Democratic', I: 'Independent' };
const NORMALIZED_PARTIES = new Set(['Republican', 'Democratic', 'Independent']);

export function normalizePartyLabel(party) {
  if (typeof party !== 'string' || party.length === 0) return null;
  if (PARTY_ABBREVIATIONS[party]) return PARTY_ABBREVIATIONS[party];
  if (NORMALIZED_PARTIES.has(party)) return party;
  return null;
}

// ============================================================================
// summarizeTotals — pure distribution math over public_position_totals rows (migration 0018:
// one row per legislator_id/jurisdiction_id/chamber/year/position(/party), `casts` = count). The
// fetch pulls ALL of a profile's OWN rows unfiltered (brief: "the profile sums/filters
// client-side — rows per legislator are tiny"); this function does the client-side narrowing by
// the CURRENT chamber/year filters — the SAME filters object the vote list itself uses
// (profile-model.js's voteFilterQuery), so "the chart IS the list summarized" stays true.
//
// Only chamber and year narrow the scope here — NOT missedOnly, and NOT the position filter H2
// added to the vote list's OWN query. Both of those are views/narrowings of the VOTE LIST, not a
// scope change on what the distribution itself summarizes: the whole point of the distribution
// chart is to show every position's share, so applying the vote list's own position/missed-only
// narrowing here would make the chart tautological (a chart of "only yea votes" always reads
// 100% yea). METRIC_DEFINITIONS.distribution states this explicitly. jurisdiction is deliberately
// ignored for the same reason profile-model.js's own voteFilterQuery already ignores it on the
// "chamber" filter: the chamber select control in the UI has no jurisdiction dimension.
//
// The five output buckets are yea/nay/not_voting/absent/other. The schema's position vocabulary
// (migration 0001) is actually six values (yea/nay/present/not_voting/absent/other) — 'present'
// has no bar of its own in this view, so it folds into 'other' along with any position value this
// module doesn't recognize. `total` is always the sum of every input row's `casts`, so a cast is
// NEVER silently dropped just because its position isn't individually visualized.
// ============================================================================
const VISUALIZED_POSITIONS = ['yea', 'nay', 'not_voting', 'absent'];

export function summarizeTotals(rows, filters = {}) {
  const { chamber, year } = filters || {};
  const scoped = (rows || []).filter((row) => {
    if (!row) return false;
    if (chamber && row.chamber !== chamber) return false;
    if (year != null && Number(row.year) !== Number(year)) return false;
    return true;
  });

  const totals = {
    yea: 0, nay: 0, not_voting: 0, absent: 0, other: 0,
  };
  for (const row of scoped) {
    const casts = Number(row.casts) || 0;
    if (VISUALIZED_POSITIONS.includes(row.position)) {
      totals[row.position] += casts;
    } else {
      totals.other += casts; // 'present' + any unforeseen position value
    }
  }
  const total = totals.yea + totals.nay + totals.not_voting + totals.absent + totals.other;
  const shares = {
    yea: formatShare(totals.yea, total),
    nay: formatShare(totals.nay, total),
    not_voting: formatShare(totals.not_voting, total),
    absent: formatShare(totals.absent, total),
    other: formatShare(totals.other, total),
  };
  return { ...totals, total, shares };
}

// ============================================================================
// cohesionFromAlignment — pure sum over public_party_alignment rows (migration 0018: one row per
// legislator_id/year/chamber, carrying pre-aggregated `matched`/`comparable` counts). Party-
// majority computation, the tie exclusion, the party-normalization equivalence, the M3
// null/unrecognized-party exclusion, AND the M2 singleton-caster exclusion all happen in that
// view's own SQL — a tied roll call, an unrecognized party, or a roll call where the member was
// their party's only voting member never produces a row/increment at all, so this function never
// needs any of that logic itself; it only sums whatever the view already decided was comparable.
//
// H3 (review, fix round 1): now scoped by BOTH `year` and `chamber` — the view carries chamber
// specifically so a chamber filter on the profile page narrows cohesion honestly instead of
// mixing a merged multi-chamber career into one figure (the pre-review version only scoped by
// year, which the review correctly flagged as dishonest for exactly that career shape).
//
// comparable === 0 -> null. This is the load-bearing "not computable" signal: never render "0%"
// for "we have no comparable roll calls in this scope" (which now also legitimately covers "this
// legislator's party is null/unrecognized" and "every one of this legislator's roll calls was a
// singleton-caster case" — both correctly produce zero rows from the view, hence null here, per
// the review's own worked example: "an Independent renders 'not computable', never a fake 100%").
// ============================================================================
export function cohesionFromAlignment(rows, filters = {}) {
  const { year, chamber } = filters || {};
  const scoped = (rows || []).filter((row) => {
    if (!row) return false;
    if (year != null && Number(row.year) !== Number(year)) return false;
    if (chamber && row.chamber !== chamber) return false;
    return true;
  });
  const matched = scoped.reduce((sum, row) => sum + (Number(row.matched) || 0), 0);
  const comparable = scoped.reduce((sum, row) => sum + (Number(row.comparable) || 0), 0);
  if (comparable === 0) return null;
  return { matched, comparable, pct: formatShare(matched, comparable) };
}

// ============================================================================
// partyComparisonModel — member-vs-own-party-AGGREGATE arithmetic, never member-vs-member (design
// spec §3, non-negotiable). Takes two summarizeTotals()-shaped objects (member's own distribution,
// and the party's aggregate distribution over the SAME-scope row set — H1, fix round 1: the
// caller fetches the party side pre-filtered to the member's own recorded party (normalized) AND
// the member's own jurisdiction set AND the active chamber filter, then narrows both sides
// through the identical summarizeTotals+filters, which is what guarantees identical scoping; see
// person-page.js's loadChartsSection).
//
// Returns null (not a misleading 0.0%/0.0% comparison) whenever either side has nothing to
// compare: a missing input (no normalized party — M3 — or the party fetch failed) or a genuinely
// zero total on either side (no votes in this scope for the member or for the party).
// ============================================================================
export function partyComparisonModel(memberTotals, partyTotals) {
  if (!memberTotals || !partyTotals) return null;
  if (!memberTotals.total || !partyTotals.total) return null;
  return {
    member: { yea: memberTotals.yea, total: memberTotals.total, yeaShare: memberTotals.shares.yea },
    party: { yea: partyTotals.yea, total: partyTotals.total, yeaShare: partyTotals.shares.yea },
  };
}

// ============================================================================
// METRIC_DEFINITIONS — the single source of the exact trust-page sentences (Task 10 renders this
// verbatim on /trust#metrics; nothing here is duplicated by hand anywhere else). Facts-only rule
// per CLAUDE.md: every sentence below states mechanics, never a judgment.
//
// H3 (review, fix round 1): rewritten so every clause matches the implementation exactly —
// distribution now states its own scope precisely (chamber/year only; the missed-only vote-list
// toggle does NOT narrow it); partyComparison states its true multi-part scope (normalized party,
// jurisdiction set, active chamber); cohesion names its real grouping (year AND chamber), its
// exact exclusion set, the singleton-caster exclusion, the null-party no-figure rule, and the
// party-normalization equivalence — replacing the earlier, now-FALSE "not normalized" sentences.
// ============================================================================
export const METRIC_DEFINITIONS = {
  distribution: {
    title: 'Position distribution',
    body: 'How many of the legislator\'s recorded votes, in the current chamber/year filter, were '
      + 'cast as yea, nay, not voting, absent, or other/present. Counts and shares reflect every '
      + 'recorded position in that chamber/year scope — the missed-votes-only toggle and clicking '
      + 'a bar below narrow the VOTE LIST underneath this chart, but never narrow this chart '
      + 'itself (a chart of only the votes it just filtered to would always read close to 100%, '
      + 'which would not be a meaningful distribution). Shares are rounded to one decimal place, '
      + 'half rounding up. This is a mechanical count of the printed record, not a rating of how '
      + 'the legislator voted.',
  },
  partyComparison: {
    title: 'Party comparison',
    body: 'The legislator\'s yea share on the roll calls in the current chamber/year filter, shown '
      + 'beside the aggregate yea share of every legislator recorded with the same party (see the '
      + 'normalization note below) within the jurisdictions this legislator has served in and, '
      + 'when a chamber filter is active, that same chamber — the same scope on both sides, '
      + 'including the legislator\'s own votes in the party aggregate. This is arithmetic against '
      + 'a group aggregate, never a comparison between two individual legislators. Party is '
      + 'recorded as our sources printed it, with one documented normalization applied equally to '
      + 'everyone: the abbreviations \'R\', \'D\', and \'I\' are treated as identical to '
      + '\'Republican\', \'Democratic\', and \'Independent\' respectively (a known formatting '
      + 'difference between our sources, not a guess); every other party label is left exactly as '
      + 'recorded. A legislator whose recorded party does not resolve to one of those three common '
      + 'forms has no party-comparison figure at all, rather than being compared against a group '
      + 'of one. The same "no figure" rule applies when this legislator is the ONLY one recorded '
      + 'with that party within the relevant jurisdictions/chamber — comparing a legislator against '
      + 'a group that is only themselves would not be a real comparison, so no figure renders in '
      + 'that case either, even when the party label itself is one of the three common ones.',
  },
  cohesion: {
    title: 'Party-line cohesion',
    body: 'The share of roll calls, grouped by year and chamber, on which the legislator\'s cast '
      + 'vote (yea or nay) matched the strict majority position of their own party\'s (see the '
      + 'normalization note below) yea/nay casts on that same roll call — the legislator\'s own '
      + 'cast counts as one of their party\'s casts when that majority is computed; it is never '
      + 'excluded from their own party\'s tally. A party majority requires strictly more yea casts '
      + 'than nay, or strictly more nay than yea; a tie means no majority, and that roll call is '
      + 'excluded entirely from both the numerator and the denominator. Any cast that is not yea or '
      + 'nay (not voting, absent, present, or another recorded value) is excluded from both the '
      + 'numerator and the denominator. A roll call where the legislator was their party\'s ONLY '
      + 'yea/nay caster is also excluded — a "majority" made of one person voting once is not a '
      + 'party-line signal, so this never manufactures a false 100% figure for, for example, a '
      + 'chamber\'s only Independent. Party is recorded as our sources printed it, with one '
      + 'documented normalization applied equally to everyone: the abbreviations \'R\', \'D\', and '
      + '\'I\' are treated as identical to \'Republican\', \'Democratic\', and \'Independent\' '
      + 'respectively; a legislator whose recorded party does not resolve to one of those three '
      + 'common forms has no cohesion figure at all. This is identical math applied to every '
      + 'legislator — a plain percentage, never a grade, rating, or ranking.',
  },
  staleness: {
    title: 'How current are these numbers?',
    body: 'These three charts are computed from a periodically refreshed snapshot of the vote '
      + 'record, not a live query — they update when that snapshot is next refreshed, not '
      + 'necessarily the instant a new vote is recorded. The vote list below the charts, and every '
      + 'individual vote shown elsewhere on this page, is queried live and always reflects the '
      + 'current data.',
  },
};

// ============================================================================
// renderChartSection — DOM. CSS bar elements built via el() (the shared allowlisted element
// constructor every other section uses — DB/authored text always lands via textContent, never
// innerHTML). el()'s attrs allowlist has no `style` entry (render.js, by design), so bar widths
// are set via `element.style.width` AFTER el() returns the node — deliberately not through el()'s
// attrs. This is safe here specifically because the width value is a 'NN.N%' string WE authored
// ourselves from our own arithmetic (formatShare's output, computed above from integer counts),
// never a string that passed through from raw DB/user text — the exact distinction render.js's
// own href/src guards exist to enforce for attributes that DO carry untrusted text.
//
// Raw numbers ALWAYS render as text nodes beside every bar — the bar is decoration, the number is
// the fact (task context, verbatim). No color-codes "good" vs "bad": every bar uses the same
// neutral `.chart-bar-fill` class regardless of which position it represents.
//
// M4 (review, fix round 1): the CLICKABLE distribution bars are real <button> elements (not a div
// with a click listener) — natively keyboard- and AT-accessible (Enter/Space activate a button
// with no extra ARIA wiring needed), matching the convention every other interactive control on
// this page already uses (person-page.js's Prev/Next buttons). The party-comparison and cohesion
// bars are decorative (never wired to onBarClick) and stay plain divs, unchanged.
// ============================================================================

const DISTRIBUTION_LABELS = {
  yea: 'Yea', nay: 'Nay', not_voting: 'Not voting', absent: 'Absent', other: 'Other / present',
};

// Bar-click -> filter-patch mapping (H2, review fix round 1): profile-model.js's voteFilterQuery
// now understands a `position` filter (`eq.yea` / `eq.nay` / `in.(present,other)`) alongside the
// pre-existing `missedOnly` toggle — so each bar dispatches to the filter that actually matches
// what it represents, not a coarse binary proxy. `missedOnly` stays a special case (its own
// checkbox keeps working exactly as before): the not_voting/absent bars set it directly (that
// bucket IS the missed-votes set) and clear `position`; the yea/nay/other bars set `position` and
// clear `missedOnly`, so the two levers never fight each other in the resulting filter state.
const BAR_CLICK_PATCH = {
  yea: { position: 'yea', missedOnly: false },
  nay: { position: 'nay', missedOnly: false },
  not_voting: { position: null, missedOnly: true },
  absent: { position: null, missedOnly: true },
  other: { position: 'other', missedOnly: false },
};

// N-C (review, fix round 2): pure — which distribution bar(s), if any, the CURRENT filters object
// already reflects. missedOnly represents BOTH not_voting and absent together (that's the same
// combined bucket the checkbox always meant); `position` represents exactly one bar. Exported so
// the "is this bar active" question is independently testable from rendering.
export function activeFilterPositions(filters) {
  const f = filters || {};
  if (f.missedOnly) return new Set(['not_voting', 'absent']);
  if (f.position === 'yea') return new Set(['yea']);
  if (f.position === 'nay') return new Set(['nay']);
  if (f.position === 'other') return new Set(['other']);
  return new Set();
}

function buildDistributionBar(position, count, shareString, onBarClick, isActive) {
  // M4: a real button, not a div — natively keyboard/AT accessible.
  const row = el('button', {
    class: isActive ? 'chart-bar-row chart-bar-active' : 'chart-bar-row',
    dataset: { bar: position },
  });
  row.type = 'button'; // `type` isn't in el()'s attrs allowlist; set directly on the returned node.
  // N-C: aria-pressed reflects the REAL current filter state (not just "was this literally
  // clicked") — isn't in el()'s attrs allowlist either, set directly for the same reason `type` is.
  row.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  row.appendChild(el('span', { class: 'chart-bar-label' }, DISTRIBUTION_LABELS[position] || position));
  const track = el('div', { class: 'chart-bar-track' });
  const fill = el('div', { class: 'chart-bar-fill' });
  // Authored-not-DB-text width value — see the module-header comment above.
  fill.style.width = shareString;
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el('span', { class: 'chart-bar-value' }, `${count} (${shareString})`));
  row.addEventListener('click', () => onBarClick(BAR_CLICK_PATCH[position] || {}));
  return row;
}

// N-C (review, fix round 2): the position/missed-only filter a bar click applies to the vote list
// was previously invisible once set (no visual trace on the chart itself) AND sticky (survives
// other filter changes, by design — but a sticky filter with zero visible indicator is a real
// usability trap). Active bar(s) now render with aria-pressed + a visible class (see CSS), and a
// "Clear position filter" control appears whenever activeFilterPositions is non-empty, clearing
// BOTH levers (`position` and `missedOnly`) through the same onBarClick patch path every other bar
// uses — no new plumbing.
function renderDistribution(container, distribution, onBarClick, filters) {
  const section = el('section', { class: 'chart-section chart-distribution' });
  section.appendChild(el('h3', {}, 'Position distribution'));
  const active = activeFilterPositions(filters);
  for (const position of ['yea', 'nay', 'not_voting', 'absent', 'other']) {
    section.appendChild(buildDistributionBar(
      position,
      distribution[position],
      distribution.shares[position],
      onBarClick,
      active.has(position),
    ));
  }
  if (active.size > 0) {
    const clearBtn = el('button', { class: 'chart-clear-position-filter' }, 'Clear position filter');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => onBarClick({ position: null, missedOnly: false }));
    section.appendChild(clearBtn);
  }
  container.appendChild(section);
}

function renderPartyComparison(container, partyComparison, partyLabel) {
  const section = el('section', { class: 'chart-section chart-party-comparison' });
  section.appendChild(el('h3', {}, 'Yea share vs. party'));
  if (!partyComparison) {
    section.appendChild(el('p', { class: 'chart-not-computable' }, 'Party comparison not computable for this view.'));
    container.appendChild(section);
    return;
  }
  const memberRow = el('div', { class: 'chart-bar-row', dataset: { bar: 'party-comparison-member' } });
  memberRow.appendChild(el('span', { class: 'chart-bar-label' }, 'This legislator'));
  const memberTrack = el('div', { class: 'chart-bar-track' });
  const memberFill = el('div', { class: 'chart-bar-fill' });
  memberFill.style.width = partyComparison.member.yeaShare;
  memberTrack.appendChild(memberFill);
  memberRow.appendChild(memberTrack);
  memberRow.appendChild(el('span', { class: 'chart-bar-value' }, `${partyComparison.member.yea} of ${partyComparison.member.total} (${partyComparison.member.yeaShare})`));
  section.appendChild(memberRow);

  // L2 (review, fix round 1): `partyLabel` is the NORMALIZED party name (person-page.js passes
  // normalizePartyLabel(party)'s result) — never the raw, possibly-abbreviated source string.
  const partyRow = el('div', { class: 'chart-bar-row', dataset: { bar: 'party-comparison-party' } });
  partyRow.appendChild(el('span', { class: 'chart-bar-label' }, partyLabel ? `${partyLabel} (party aggregate)` : 'Party aggregate'));
  const partyTrack = el('div', { class: 'chart-bar-track' });
  const partyFill = el('div', { class: 'chart-bar-fill' });
  partyFill.style.width = partyComparison.party.yeaShare;
  partyTrack.appendChild(partyFill);
  partyRow.appendChild(partyTrack);
  partyRow.appendChild(el('span', { class: 'chart-bar-value' }, `${partyComparison.party.yea} of ${partyComparison.party.total} (${partyComparison.party.yeaShare})`));
  section.appendChild(partyRow);

  container.appendChild(section);
}

function renderCohesion(container, cohesion) {
  const section = el('section', { class: 'chart-section chart-cohesion' });
  section.appendChild(el('h3', {}, 'Party-line cohesion'));
  if (!cohesion) {
    section.appendChild(el('p', { class: 'chart-not-computable' }, 'Party-line comparison not computable for this view.'));
    container.appendChild(section);
    return;
  }
  const row = el('div', { class: 'chart-bar-row', dataset: { bar: 'cohesion' } });
  const track = el('div', { class: 'chart-bar-track' });
  const fill = el('div', { class: 'chart-bar-fill' });
  fill.style.width = cohesion.pct;
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el('span', { class: 'chart-bar-value' }, `${cohesion.matched} of ${cohesion.comparable} comparable roll calls (${cohesion.pct})`));
  section.appendChild(row);
  container.appendChild(section);
}

// models: { distribution, partyComparison, cohesion, partyLabel, filters }. distribution is always
// a real summarizeTotals() result (never null — a zero-total view is the caller's job to render as
// the section's honest 'empty' state instead of calling this function at all, same pattern as
// every other section on the page). partyComparison and cohesion are each either their real shape
// or null (not computable) — this function renders BOTH cases, it never decides which applies.
// `filters` (fix round 2, N-C) is the page's CURRENT shared filter state — read-only here, used
// only to compute which distribution bar(s) should render as visibly active.
//
// L4 (review, fix round 1): one authored (not DB-sourced) link to the trust page's metrics
// section, under the charts — el()'s href guard allows a relative, site-internal path.
export function renderChartSection(container, models, onBarClick) {
  clearChildren(container);
  const wrapper = el('div', { class: 'vote-charts' });
  renderDistribution(wrapper, models.distribution, onBarClick, models.filters);
  renderPartyComparison(wrapper, models.partyComparison, models.partyLabel);
  renderCohesion(wrapper, models.cohesion);
  wrapper.appendChild(el('a', { class: 'chart-definitions-link', href: '/trust#metrics' }, 'About these numbers'));
  container.appendChild(wrapper);
}
