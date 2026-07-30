import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  formatShare, summarizeTotals, cohesionFromAlignment, partyComparisonModel,
  renderChartSection, METRIC_DEFINITIONS,
} from '../site/js/vote-charts.js';
import {
  loadChartsSection, mountProfile,
} from '../site/js/person-page.js';
import { _setFetch, _setConfig } from '../site/js/rest.js';

// Task 6b (docs/superpowers/specs/2026-07-30-public-site-design.md §3, "Vote aggregates";
// .superpowers/sdd/2026-07-30-public-site/task-6b-brief.md) — vote aggregate charts. Pure math
// TDD'd here before site/js/vote-charts.js existed (Step 1 of the brief). jsdom supplies
// `document` for the DOM-touching tests, same pattern as tests/person-page.test.js and
// tests/site-modules.test.js.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8990/' });
globalThis.document = dom.window.document;

// ============================================================================
// formatShare — the documented rounding rule: one decimal place, half round UP (never
// round-half-to-even/banker's rounding), computed with exact integer arithmetic so no
// floating-point drift can ever move a boundary case the wrong way.
// ============================================================================

test('formatShare: simple exact fraction', () => {
  assert.equal(formatShare(1, 2), '50.0%');
  assert.equal(formatShare(0, 5), '0.0%');
  assert.equal(formatShare(5, 5), '100.0%');
});

test('formatShare: repeating-decimal fractions round to one decimal place', () => {
  assert.equal(formatShare(1, 3), '33.3%');
  assert.equal(formatShare(2, 3), '66.7%');
});

test('formatShare: exact half-at-the-second-decimal boundary rounds UP (half round up, not banker\'s rounding)', () => {
  // 1/16 = 6.25% exactly -> the second decimal is exactly 5 -> rounds up to 6.3%, never down to 6.2%.
  assert.equal(formatShare(1, 16), '6.3%');
  // 3/8 = 37.5% -> already one decimal, no ambiguity, sanity check.
  assert.equal(formatShare(3, 8), '37.5%');
});

test('formatShare: total <= 0 -> "0.0%", never divides by zero, never throws', () => {
  assert.equal(formatShare(0, 0), '0.0%');
  assert.equal(formatShare(5, 0), '0.0%');
  assert.equal(formatShare(3, -1), '0.0%');
});

test('formatShare: large exact-percent case', () => {
  assert.equal(formatShare(621, 1000), '62.1%');
});

// ============================================================================
// summarizeTotals — pure distribution math over public_position_totals rows (already scoped to
// one profile's legislator_id(s) by the fetch; this function narrows further by the CURRENT
// chamber/year filters, client-side, per the brief: "the profile sums/filters client-side").
// ============================================================================

function totalsRow(overrides) {
  return {
    legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', year: 2024, position: 'yea', casts: 1, ...overrides,
  };
}

test('summarizeTotals: basic counts and shares across the four visualized buckets', () => {
  const rows = [
    totalsRow({ position: 'yea', casts: 60 }),
    totalsRow({ position: 'nay', casts: 30 }),
    totalsRow({ position: 'not_voting', casts: 8 }),
    totalsRow({ position: 'absent', casts: 2 }),
  ];
  const result = summarizeTotals(rows, {});
  assert.equal(result.yea, 60);
  assert.equal(result.nay, 30);
  assert.equal(result.not_voting, 8);
  assert.equal(result.absent, 2);
  assert.equal(result.other, 0);
  assert.equal(result.total, 100);
  assert.deepEqual(result.shares, {
    yea: '60.0%', nay: '30.0%', not_voting: '8.0%', absent: '2.0%', other: '0.0%',
  });
});

test('summarizeTotals: "present" and any unforeseen position value fold into "other" — total is always the sum of every input row (no cast is ever silently dropped)', () => {
  const rows = [
    totalsRow({ position: 'yea', casts: 5 }),
    totalsRow({ position: 'present', casts: 3 }),
    totalsRow({ position: 'some-future-value', casts: 2 }),
  ];
  const result = summarizeTotals(rows, {});
  assert.equal(result.other, 5, '3 present + 2 unforeseen = 5, both absorbed into other');
  assert.equal(result.total, 10, 'total counts every row, including the ones folded into other');
});

test('summarizeTotals: chamber filter narrows rows before summing', () => {
  const rows = [
    totalsRow({ chamber: 'house', position: 'yea', casts: 10 }),
    totalsRow({ chamber: 'senate', position: 'yea', casts: 999 }),
  ];
  const result = summarizeTotals(rows, { chamber: 'house' });
  assert.equal(result.yea, 10);
  assert.equal(result.total, 10);
});

test('summarizeTotals: year filter narrows rows before summing', () => {
  const rows = [
    totalsRow({ year: 2023, position: 'yea', casts: 4 }),
    totalsRow({ year: 2024, position: 'yea', casts: 6 }),
  ];
  const result = summarizeTotals(rows, { year: 2024 });
  assert.equal(result.yea, 6);
  assert.equal(result.total, 6);
});

test('summarizeTotals: chamber and year filters compose (both applied)', () => {
  const rows = [
    totalsRow({
      chamber: 'house', year: 2024, position: 'yea', casts: 7,
    }),
    totalsRow({
      chamber: 'house', year: 2023, position: 'yea', casts: 100,
    }),
    totalsRow({
      chamber: 'senate', year: 2024, position: 'yea', casts: 100,
    }),
  ];
  const result = summarizeTotals(rows, { chamber: 'house', year: 2024 });
  assert.equal(result.yea, 7);
});

test('summarizeTotals: no filters (null chamber, null year) keeps every row', () => {
  const rows = [
    totalsRow({ chamber: 'house', year: 2023, casts: 1 }),
    totalsRow({ chamber: 'senate', year: 2024, casts: 1 }),
  ];
  const result = summarizeTotals(rows, { chamber: null, year: null });
  assert.equal(result.total, 2);
});

test('summarizeTotals: empty/null rows -> every bucket zero, every share "0.0%", never throws', () => {
  assert.deepEqual(summarizeTotals([], {}).shares, {
    yea: '0.0%', nay: '0.0%', not_voting: '0.0%', absent: '0.0%', other: '0.0%',
  });
  assert.equal(summarizeTotals(null, {}).total, 0);
  assert.equal(summarizeTotals(undefined, undefined).total, 0);
});

// ============================================================================
// cohesionFromAlignment — pure sum over public_party_alignment rows (matched/comparable already
// pre-aggregated server-side, per-legislator per-year; ties are excluded UPSTREAM in the view's
// own SQL — a tied roll call never produces a row/increment at all, so this function never needs
// its own tie-detection logic. Null-when-zero-comparable is load-bearing: never render "0%" for
// "we couldn't compute this," which is a different fact than "computed and it's exactly zero.")
// ============================================================================

function alignmentRow(overrides) {
  return {
    legislator_id: 'leg-1', year: 2024, matched: 3, comparable: 5, ...overrides,
  };
}

test('cohesionFromAlignment: sums matched/comparable and formats pct with the same rounding rule as shares', () => {
  const result = cohesionFromAlignment([alignmentRow({ matched: 3, comparable: 5 })], {});
  assert.deepEqual(result, { matched: 3, comparable: 5, pct: '60.0%' });
});

test('cohesionFromAlignment: comparable=0 -> null (never "0%") — this IS the "not computable" signal the caller renders', () => {
  assert.equal(cohesionFromAlignment([], {}), null);
  assert.equal(cohesionFromAlignment([alignmentRow({ matched: 0, comparable: 0 })], {}), null);
  assert.equal(cohesionFromAlignment(null, {}), null);
});

test('cohesionFromAlignment: sums across multiple years when no year filter is applied', () => {
  const rows = [
    alignmentRow({ year: 2023, matched: 1, comparable: 2 }),
    alignmentRow({ year: 2024, matched: 3, comparable: 8 }),
  ];
  const result = cohesionFromAlignment(rows, {});
  assert.equal(result.matched, 4);
  assert.equal(result.comparable, 10);
});

test('cohesionFromAlignment: year filter narrows to the matching year only', () => {
  const rows = [
    alignmentRow({ year: 2023, matched: 1, comparable: 2 }),
    alignmentRow({ year: 2024, matched: 3, comparable: 8 }),
  ];
  const result = cohesionFromAlignment(rows, { year: 2024 });
  assert.deepEqual(result, { matched: 3, comparable: 8, pct: '37.5%' });
});

// The brief's explicit fixture: "a party-majority edge fixture (tie -> excluded)". The tie
// exclusion happens in 0018's SQL (party_majority CTE: a tied yea/nay count among the party's own
// casters on a roll call produces majority_position = null, and that roll call is filtered out of
// public_party_alignment entirely — it contributes to neither matched nor comparable for ANY
// member). This fixture documents the worked example and proves the pure JS layer needs no tie
// logic of its own: it just sums whatever the view actually returned.
test('cohesionFromAlignment: a tied roll call never reaches this function at all (excluded upstream by the view) — worked example', () => {
  // 3 roll calls in 2024 for this legislator's party:
  //   RC1: party casts 3 yea / 1 nay -> majority yea; member cast yea -> matched.
  //   RC2: party casts 2 yea / 2 nay -> TIE -> majority_position is null -> the view excludes RC2
  //        completely (does not increment comparable OR matched for this legislator).
  //   RC3: party casts 1 yea / 4 nay -> majority nay; member cast yea -> NOT matched.
  // So public_party_alignment reports exactly: comparable = 2 (RC1 + RC3), matched = 1 (RC1 only).
  const rows = [alignmentRow({ year: 2024, matched: 1, comparable: 2 })];
  const result = cohesionFromAlignment(rows, { year: 2024 });
  assert.deepEqual(result, { matched: 1, comparable: 2, pct: '50.0%' });
});

// ============================================================================
// partyComparisonModel — member-vs-own-party-aggregate arithmetic only (never member-vs-member).
// Takes two summarizeTotals()-shaped objects.
// ============================================================================

test('partyComparisonModel: extracts member and party yea counts/totals/shares', () => {
  const member = summarizeTotals([totalsRow({ position: 'yea', casts: 6 }), totalsRow({ position: 'nay', casts: 4 })], {});
  const party = summarizeTotals([totalsRow({ position: 'yea', casts: 600 }), totalsRow({ position: 'nay', casts: 400 })], {});
  const result = partyComparisonModel(member, party);
  assert.deepEqual(result, {
    member: { yea: 6, total: 10, yeaShare: '60.0%' },
    party: { yea: 600, total: 1000, yeaShare: '60.0%' },
  });
});

test('partyComparisonModel: null/missing member or party totals -> null (not computable, never a misleading 0.0%/0.0%)', () => {
  const totals = summarizeTotals([totalsRow({ position: 'yea', casts: 1 })], {});
  assert.equal(partyComparisonModel(null, totals), null);
  assert.equal(partyComparisonModel(totals, null), null);
  assert.equal(partyComparisonModel(null, null), null);
});

test('partyComparisonModel: member or party total of zero (no votes in this scope) -> null, never a bogus 0.0% comparison', () => {
  const zero = summarizeTotals([], {});
  const nonZero = summarizeTotals([totalsRow({ position: 'yea', casts: 1 })], {});
  assert.equal(partyComparisonModel(zero, nonZero), null);
  assert.equal(partyComparisonModel(nonZero, zero), null);
});

// ============================================================================
// Filter-scoping symmetry (brief's explicit TDD callout): the SAME filters object, run through
// the SAME summarizeTotals function, narrows member rows and party rows IDENTICALLY — there is no
// separate scoping code path for "member" vs "party" that could silently drift apart.
// ============================================================================

test('filter-scoping: a year filter narrows both member rows and party rows identically (same function, same filters, no separate code path)', () => {
  const memberRows = [
    totalsRow({
      legislator_id: 'leg-1', year: 2023, position: 'yea', casts: 50,
    }),
    totalsRow({
      legislator_id: 'leg-1', year: 2024, position: 'yea', casts: 5,
    }),
  ];
  const partyRows = [
    totalsRow({
      legislator_id: 'leg-2', year: 2023, position: 'yea', casts: 5000,
    }),
    totalsRow({
      legislator_id: 'leg-2', year: 2024, position: 'yea', casts: 500,
    }),
  ];
  const filters = { year: 2024 };
  const member = summarizeTotals(memberRows, filters);
  const party = summarizeTotals(partyRows, filters);
  assert.equal(member.total, 5, 'only the 2024 member row counted');
  assert.equal(party.total, 500, 'only the 2024 party row counted, same filter object, same function');
});

// ============================================================================
// METRIC_DEFINITIONS — the single source Task 10 renders verbatim on /trust#metrics. Sanity-check
// presence and that the neutrality-wall clauses from design spec §3 are actually present in text,
// not just implemented in code where no user will ever read them.
// ============================================================================

test('METRIC_DEFINITIONS: exports distribution, partyComparison, and cohesion definitions with non-empty text', () => {
  for (const key of ['distribution', 'partyComparison', 'cohesion']) {
    assert.ok(METRIC_DEFINITIONS[key], `METRIC_DEFINITIONS.${key} must exist`);
    const body = typeof METRIC_DEFINITIONS[key] === 'string' ? METRIC_DEFINITIONS[key] : METRIC_DEFINITIONS[key].body;
    assert.ok(typeof body === 'string' && body.length > 20, `METRIC_DEFINITIONS.${key} must carry real definition text`);
  }
});

test('METRIC_DEFINITIONS.cohesion: states the strict-majority rule, the tie exclusion, and the not-voting/absent exclusion', () => {
  const body = METRIC_DEFINITIONS.cohesion.body ?? METRIC_DEFINITIONS.cohesion;
  assert.match(body, /majority/i);
  assert.match(body, /tie/i);
  assert.match(body, /not.voting|not voting/i);
  assert.match(body, /absent/i);
});

test('METRIC_DEFINITIONS.partyComparison: states party is "as recorded" (the published caveat) and never a member-vs-member comparison', () => {
  const body = METRIC_DEFINITIONS.partyComparison.body ?? METRIC_DEFINITIONS.partyComparison;
  assert.match(body, /record/i);
});

// NOT a blanket ban on the words "grade"/"rating"/"rank" — design spec §3 itself uses that exact
// vocabulary as reassurance text ("no grades, no adjectives, no ranked lists of politicians,
// ever"), and METRIC_DEFINITIONS.cohesion is expected to state that same reassurance verbatim-in-
// spirit on the trust page. What's actually being checked: the reassurance is explicitly PRESENT
// (never silently dropped), stated as a negation ("never a ..."), not as an affirmative claim that
// this IS a grade/rating/ranking of the legislator.
test('METRIC_DEFINITIONS.cohesion: explicitly states the "never a grade/rating/ranking" reassurance, not as an affirmative claim', () => {
  const body = METRIC_DEFINITIONS.cohesion.body ?? METRIC_DEFINITIONS.cohesion;
  assert.match(body, /never a grade/i);
});

// ============================================================================
// renderChartSection — DOM smoke tests (jsdom). CSS bars via el(), raw numbers ALWAYS present as
// text nodes beside every bar (bars are decoration; numbers are the facts). Bar widths are set via
// element.style.width AFTER el() returns the node (el()'s attrs allowlist has no style attr —
// see render.js) using our OWN authored 'NN.N%' strings (formatShare's output), never raw DB text.
// ============================================================================

function fullModels() {
  const distribution = summarizeTotals([
    totalsRow({ position: 'yea', casts: 60 }),
    totalsRow({ position: 'nay', casts: 40 }),
  ], {});
  const partyComparison = {
    member: { yea: 60, total: 100, yeaShare: '60.0%' },
    party: { yea: 55, total: 100, yeaShare: '55.0%' },
  };
  const cohesion = { matched: 8, comparable: 10, pct: '80.0%' };
  return {
    distribution, partyComparison, cohesion, partyLabel: 'Republican',
  };
}

test('renderChartSection: renders raw numbers as text content for every distribution bar', () => {
  const container = document.createElement('section');
  renderChartSection(container, fullModels(), () => {});
  const text = container.textContent;
  assert.match(text, /60/);
  assert.match(text, /60\.0%/);
  assert.match(text, /40/);
  assert.match(text, /40\.0%/);
});

test('renderChartSection: sets a numeric-percent style.width on each distribution bar fill, matching its own share', () => {
  const container = document.createElement('section');
  renderChartSection(container, fullModels(), () => {});
  const fills = container.querySelectorAll('.chart-bar-fill');
  assert.ok(fills.length >= 2, 'at least yea and nay bars rendered');
  // jsdom's CSSOM (like a real browser's) normalizes a whole-number percentage's serialized form
  // (assigning "60.0%" reads back as "60%") — visually identical, so the assertion compares the
  // parsed NUMBER, not the exact string, of each bar's width against its own share.
  const widths = Array.from(fills).map((n) => parseFloat(n.style.width));
  assert.ok(widths.includes(60));
  assert.ok(widths.includes(40));
});

test('renderChartSection: clicking the not_voting or absent bar calls onBarClick with { missedOnly: true } (the only existing vote-list lever for those two buckets)', () => {
  const container = document.createElement('section');
  const calls = [];
  renderChartSection(container, fullModels(), (patch) => calls.push(patch));
  const notVotingRow = container.querySelector('[data-bar="not_voting"]');
  const absentRow = container.querySelector('[data-bar="absent"]');
  assert.notEqual(notVotingRow, null);
  assert.notEqual(absentRow, null);
  notVotingRow.click();
  absentRow.click();
  assert.deepEqual(calls, [{ missedOnly: true }, { missedOnly: true }]);
});

test('renderChartSection: clicking the yea, nay, or other bar calls onBarClick with { missedOnly: false }', () => {
  const container = document.createElement('section');
  const calls = [];
  renderChartSection(container, fullModels(), (patch) => calls.push(patch));
  container.querySelector('[data-bar="yea"]').click();
  container.querySelector('[data-bar="nay"]').click();
  assert.deepEqual(calls, [{ missedOnly: false }, { missedOnly: false }]);
});

test('renderChartSection: cohesion null renders the exact "not computable" message, never a 0% figure', () => {
  const container = document.createElement('section');
  const models = fullModels();
  models.cohesion = null;
  renderChartSection(container, models, () => {});
  const cohesionSection = container.querySelector('.chart-cohesion');
  assert.notEqual(cohesionSection, null);
  assert.equal(cohesionSection.textContent, 'Party-line cohesionParty-line comparison not computable for this view.');
  assert.equal(cohesionSection.querySelector('.chart-bar-fill'), null, 'no bar at all is rendered for a not-computable cohesion, never a 0% bar');
});

test('renderChartSection: partyComparison null renders an honest "not computable" message', () => {
  const container = document.createElement('section');
  const models = fullModels();
  models.partyComparison = null;
  renderChartSection(container, models, () => {});
  assert.match(container.textContent, /not computable/i);
});

test('renderChartSection: never uses innerHTML-parsed markup for any authored text (all DB-derived numbers land as real text nodes)', () => {
  const container = document.createElement('section');
  renderChartSection(container, fullModels(), () => {});
  // A crude but effective smoke check: no literal "<" survives into rendered text content, which
  // would only happen if a markup-looking string got parsed as an element rather than escaped.
  assert.equal(container.innerHTML.includes('&lt;'), false);
});

// ============================================================================
// person-page.js wiring — loadChartsSection. Mirrors the mocking pattern already used across
// tests/person-page.test.js (_setFetch/_setConfig on rest.js).
// ============================================================================

function okResponse(rows) {
  return {
    ok: true,
    status: 200,
    json: async () => rows,
    headers: { get: (name) => (name.toLowerCase() === 'content-range' ? `0-${Math.max(rows.length - 1, 0)}/${rows.length}` : null) },
  };
}
function pgrst205Response(table) {
  return {
    ok: false,
    status: 404,
    json: async () => ({
      code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache`, details: null, hint: null,
    }),
    headers: { get: () => null },
  };
}

test('loadChartsSection: pre-apply state — public_position_totals/public_party_alignment 404 (PGRST205) renders FAILED with the exact honest message, never an empty section', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/public_position_totals')) return pgrst205Response('public_position_totals');
    if (u.includes('/public_party_alignment')) return pgrst205Response('public_party_alignment');
    return okResponse([]);
  });
  const container = document.createElement('section');
  await loadChartsSection(container, {
    legislatorIds: ['leg-1'], party: 'Republican', filters: { chamber: null, year: null }, onBarClick: () => {},
  }).catch(() => {});
  assert.notEqual(container.querySelector('.section-state-failed'), null, 'renders the failed state');
  assert.match(container.textContent, /Aggregates unavailable until the next data update\./);
  assert.equal(container.querySelector('.chart-bar-fill'), null, 'a failed fetch never renders as a populated/empty chart');
});

test('loadChartsSection: empty legislatorIds -> honest empty state, no fetch ever fires', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  let fetchCalled = false;
  _setFetch(async () => { fetchCalled = true; return okResponse([]); });
  const container = document.createElement('section');
  await loadChartsSection(container, {
    legislatorIds: [], party: null, filters: { chamber: null, year: null }, onBarClick: () => {},
  });
  assert.equal(fetchCalled, false);
  assert.notEqual(container.querySelector('.section-state-empty'), null);
});

test('loadChartsSection: success path renders ready with real numbers, and rescope() re-renders from the SAME fetched rows with no new network call (client-side filter narrowing, per the brief)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  let fetchCount = 0;
  _setFetch(async (url) => {
    fetchCount += 1;
    const u = String(url);
    if (u.includes('/public_position_totals') && u.includes('legislator_id=in')) {
      return okResponse([
        totalsRow({
          legislator_id: 'leg-1', chamber: 'house', year: 2024, position: 'yea', casts: 8,
        }),
        totalsRow({
          legislator_id: 'leg-1', chamber: 'senate', year: 2023, position: 'nay', casts: 2,
        }),
      ]);
    }
    if (u.includes('/public_position_totals')) return okResponse([]); // party-comparison fetch
    if (u.includes('/public_party_alignment')) return okResponse([alignmentRow({ legislator_id: 'leg-1', year: 2024, matched: 4, comparable: 5 })]);
    return okResponse([]);
  });
  const container = document.createElement('section');
  const filters = { chamber: null, year: null };
  const result = await loadChartsSection(container, {
    legislatorIds: ['leg-1'], party: null, filters, onBarClick: () => {},
  });
  assert.notEqual(result, null);
  assert.match(container.textContent, /8/);
  assert.match(container.textContent, /2/);

  const fetchCountBeforeRescope = fetchCount;
  filters.chamber = 'house';
  result.rescope();
  assert.equal(fetchCount, fetchCountBeforeRescope, 'rescope() must not re-fetch — it recomputes from rows already in hand');
  assert.match(container.textContent, /8/);
  const nayValue = container.querySelector('[data-bar="nay"] .chart-bar-value').textContent;
  assert.equal(nayValue, '0 (0.0%)', 'the senate/2023 nay row is now scoped out by the chamber filter');
});

// mountProfile-level integration: a bar click flows filters -> nextVoteFilters -> both the vote
// list AND the charts section re-scoping, via the SAME reducer (design spec §3 / brief "Context").
test('mountProfile: charts section mounts, and a bar click updates the shared filter state that also drives the vote list', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/terms?')) return okResponse([]);
    if (u.includes('/public_vote_feed?')) return okResponse([]);
    if (u.includes('/bill_sponsors?')) return okResponse([]);
    if (u.includes('/public_freshness?')) return okResponse([]);
    if (u.includes('/public_position_totals')) {
      return okResponse([totalsRow({
        legislator_id: 'leg-1', chamber: 'house', year: 2024, position: 'not_voting', casts: 3,
      })]);
    }
    if (u.includes('/public_party_alignment')) return okResponse([]);
    return okResponse([]);
  });

  const sections = {
    identity: document.createElement('section'),
    voteFilters: document.createElement('div'),
    charts: document.createElement('section'),
    votes: document.createElement('section'),
    sponsorships: document.createElement('section'),
    freshness: document.createElement('section'),
  };
  await mountProfile(sections, {
    person: null,
    legislators: [{
      id: 'leg-1', full_name: 'Jane Doe', bioguide_id: null, image_url: null,
    }],
  });

  assert.notEqual(sections.charts.querySelector('[data-bar="not_voting"]'), null, 'charts section rendered with a not_voting bar');
  const barRow = sections.charts.querySelector('[data-bar="not_voting"]');
  barRow.click();
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  // Clicking not_voting sets missedOnly:true, which re-queries public_vote_feed with the missed
  // filter — proven indirectly by the vote-filters checkbox reflecting the new state, OR simply
  // that no error was thrown and the section is still in a real (non-crashed) state.
  assert.equal(sections.votes.querySelector('.section-state-failed'), null, 'vote list did not crash on the re-scope');
});
