// site/js/vote-charts.js — the profile page's vote-aggregate charts (design spec §3, "Vote
// aggregates"; .superpowers/sdd/2026-07-30-public-site/task-6b-brief.md). Browser-native ES
// module. Pure math (formatShare, summarizeTotals, cohesionFromAlignment, partyComparisonModel,
// METRIC_DEFINITIONS) has zero imports and zero DOM — TDD'd in tests/vote-charts.test.js before
// any of it existed. renderChartSection is the one DOM-touching export; it imports render.js's
// el()/clearChildren, the SAME element-construction primitive every other page section uses, so
// the "all DB text via textContent, never innerHTML" guarantee holds here too.
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
// summarizeTotals — pure distribution math over public_position_totals rows (migration 0018:
// one row per legislator_id/jurisdiction_id/chamber/year/position, `casts` = count). The fetch
// pulls ALL of a profile's rows unfiltered (brief: "the profile sums/filters client-side — rows
// per legislator are tiny"); this function does the client-side narrowing by the CURRENT
// chamber/year filters — the SAME filters object the vote list itself uses (profile-model.js's
// voteFilterQuery), so "the chart IS the list summarized" stays literally true.
//
// Only chamber and year narrow the scope here (not missedOnly, not jurisdiction): missedOnly is
// a VIEW of the vote list (show only the missed subset), not a scope change on what the
// distribution itself summarizes — showing a "distribution" of a pre-filtered-to-missed-only set
// would be close to tautological. jurisdiction is deliberately ignored for the same reason
// profile-model.js's own voteFilterQuery already ignores it on the "chamber" filter: the chamber
// select control in the UI has no jurisdiction dimension, so this stays consistent with the vote
// list's existing filtering semantics rather than inventing a stricter rule here.
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
// legislator_id/year, carrying pre-aggregated `matched`/`comparable` counts). Party-majority
// computation AND tie exclusion both happen in that view's own SQL — a tied roll call never
// produces a row/increment at all, so this function never needs tie-detection logic of its own;
// it only sums whatever the view already decided was comparable.
//
// Only `year` narrows scope (the view carries no chamber/jurisdiction column — cohesion is a
// whole-year, whole-career figure per the brief's literal grouping: "per (legislator_id, year)").
//
// comparable === 0 -> null. This is the load-bearing "not computable" signal: never render "0%"
// for "we have no comparable roll calls in this scope," which is a different, more honest fact
// than "computed and it happens to be exactly zero."
// ============================================================================
export function cohesionFromAlignment(rows, filters = {}) {
  const { year } = filters || {};
  const scoped = (rows || []).filter((row) => {
    if (!row) return false;
    if (year != null && Number(row.year) !== Number(year)) return false;
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
// and the party's aggregate distribution over the identically-scoped row set — the caller is
// responsible for fetching/filtering both through the SAME summarizeTotals + filters, which is
// what guarantees identical scoping; see person-page.js's loadChartsSection).
//
// Returns null (not a misleading 0.0%/0.0% comparison) whenever either side has nothing to
// compare: a missing input (party unrecorded, or the party fetch failed) or a genuinely zero
// total on either side (no votes in this scope for the member or for the party).
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
// ============================================================================
export const METRIC_DEFINITIONS = {
  distribution: {
    title: 'Position distribution',
    body: 'How many of the legislator\'s recorded votes, in the current filtered view, were cast '
      + 'as yea, nay, not voting, absent, or other/present. Counts and shares reflect exactly the '
      + 'votes shown in the list below — the chart is that same list, summarized. Shares are '
      + 'rounded to one decimal place, half rounding up. This is a mechanical count of the printed '
      + 'record, not a rating of how the legislator voted.',
  },
  partyComparison: {
    title: 'Party comparison',
    body: 'The legislator\'s yea share on the roll calls in the current filtered view, shown '
      + 'beside the aggregate yea share of every legislator recorded with the same party in our '
      + 'data over that same set of roll calls (their own party\'s aggregate, including the '
      + 'legislator\'s own votes) — this is arithmetic against a group aggregate, never a '
      + 'comparison between two individual legislators. Party is recorded exactly as our sources '
      + 'printed it and is not independently verified or normalized; a discrepancy in how a party '
      + 'is recorded across sources would affect this figure.',
  },
  cohesion: {
    title: 'Party-line cohesion',
    body: 'The share of roll calls, in the current filtered view, on which the legislator\'s cast '
      + 'vote (yea or nay) matched the strict majority position of their own party\'s yea/nay '
      + 'casts on that same roll call. A party majority requires strictly more yea casts than nay, '
      + 'or strictly more nay than yea; a tie means no majority, and that roll call is excluded '
      + 'entirely from both the numerator and the denominator. Not-voting and absent casts are '
      + 'excluded from both the numerator and the denominator. Party is recorded exactly as our '
      + 'sources printed it and is not independently verified or normalized. This is identical '
      + 'math applied to every legislator — a plain percentage, never a grade, rating, or ranking.',
  },
};

// ============================================================================
// renderChartSection — DOM. CSS bar divs built via el() (the shared allowlisted element
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
// ============================================================================

const DISTRIBUTION_LABELS = {
  yea: 'Yea', nay: 'Nay', not_voting: 'Not voting', absent: 'Absent', other: 'Other / present',
};

// Bar-click -> filter-patch mapping. voteFilterQuery (profile-model.js, out of this task's file
// scope) only exposes ONE position-shaped lever on the shared filter state: `missedOnly`, which
// maps to `position=in.(not_voting,absent)` on the vote-feed query. That is the only EXISTING
// plumbing a bar click can honestly dispatch through without inventing a new filter dimension —
// so the not_voting and absent bars map onto missedOnly:true (an exact match: those two bars ARE
// that bucket), and the yea/nay/other bars map onto missedOnly:false (the closest honest action
// available: clear the missed-only view). This is coarser than "filter to exactly this position,"
// a real product tradeoff worth revisiting with Lance if a finer per-position filter is wanted —
// flagged in the task-6b report's concerns.
const BAR_CLICK_PATCH = {
  yea: { missedOnly: false },
  nay: { missedOnly: false },
  not_voting: { missedOnly: true },
  absent: { missedOnly: true },
  other: { missedOnly: false },
};

function buildDistributionBar(position, count, shareString, onBarClick) {
  const row = el('div', { class: 'chart-bar-row', dataset: { bar: position } });
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

function renderDistribution(container, distribution, onBarClick) {
  const section = el('section', { class: 'chart-section chart-distribution' });
  section.appendChild(el('h3', {}, 'Position distribution'));
  for (const position of ['yea', 'nay', 'not_voting', 'absent', 'other']) {
    section.appendChild(buildDistributionBar(position, distribution[position], distribution.shares[position], onBarClick));
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

// models: { distribution, partyComparison, cohesion, partyLabel }. distribution is always a real
// summarizeTotals() result (never null — a zero-total view is the caller's job to render as the
// section's honest 'empty' state instead of calling this function at all, same pattern as every
// other section on the page). partyComparison and cohesion are each either their real shape or
// null (not computable) — this function renders BOTH cases, it never decides which applies.
export function renderChartSection(container, models, onBarClick) {
  clearChildren(container);
  const wrapper = el('div', { class: 'vote-charts' });
  renderDistribution(wrapper, models.distribution, onBarClick);
  renderPartyComparison(wrapper, models.partyComparison, models.partyLabel);
  renderCohesion(wrapper, models.cohesion);
  container.appendChild(wrapper);
}
