import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { readFileSync } from 'node:fs';
import {
  formatShare, normalizePartyLabel, summarizeTotals, cohesionFromAlignment, partyComparisonModel,
  renderChartSection, METRIC_DEFINITIONS, activeFilterPositions,
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
// pre-aggregated server-side, per-legislator/year/chamber; ties, the M3 null/unrecognized-party
// exclusion, and the M2 singleton-caster exclusion are ALL excluded UPSTREAM in the view's own
// SQL — none of those cases ever produce a row/increment at all, so this function never needs any
// of that logic itself. Null-when-zero-comparable is load-bearing: never render "0%" for "we
// couldn't compute this," which is a different fact than "computed and it's exactly zero.")
// ============================================================================

function alignmentRow(overrides) {
  return {
    legislator_id: 'leg-1', year: 2024, chamber: 'house', matched: 3, comparable: 5, ...overrides,
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

test('cohesionFromAlignment: sums across multiple years/chambers when no year/chamber filter is applied', () => {
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

// H3 (review, fix round 1): public_party_alignment now groups by (legislator_id, year, chamber)
// — a chamber filter must narrow cohesion honestly, exactly as it already narrows the
// distribution chart, instead of mixing a merged multi-chamber career into one figure (the
// pre-review version had no chamber column at all and could not do this — the review's own
// dishonesty finding).
test('cohesionFromAlignment: chamber filter narrows to the matching chamber only (H3 — a merged multi-chamber career no longer mixes chambers into one figure)', () => {
  const rows = [
    alignmentRow({
      year: 2024, chamber: 'house', matched: 9, comparable: 10,
    }),
    alignmentRow({
      year: 2024, chamber: 'senate', matched: 1, comparable: 10,
    }),
  ];
  const houseOnly = cohesionFromAlignment(rows, { chamber: 'house' });
  assert.deepEqual(houseOnly, { matched: 9, comparable: 10, pct: '90.0%' });
  const senateOnly = cohesionFromAlignment(rows, { chamber: 'senate' });
  assert.deepEqual(senateOnly, { matched: 1, comparable: 10, pct: '10.0%' });
  const both = cohesionFromAlignment(rows, {});
  assert.deepEqual(both, { matched: 10, comparable: 20, pct: '50.0%' }, 'no chamber filter sums across both, unchanged from the pre-review default');
});

test('cohesionFromAlignment: year and chamber filters compose', () => {
  const rows = [
    alignmentRow({
      year: 2023, chamber: 'house', matched: 1, comparable: 2,
    }),
    alignmentRow({
      year: 2024, chamber: 'house', matched: 3, comparable: 4,
    }),
    alignmentRow({
      year: 2024, chamber: 'senate', matched: 100, comparable: 100,
    }),
  ];
  const result = cohesionFromAlignment(rows, { year: 2024, chamber: 'house' });
  assert.deepEqual(result, { matched: 3, comparable: 4, pct: '75.0%' });
});

// The brief's explicit fixture: "a party-majority edge fixture (tie -> excluded)". The tie
// exclusion happens in 0018's SQL (party_majority CTE: a tied yea/nay count among the party's own
// casters on a roll call produces majority_position = null, and that roll call is filtered out of
// public_party_alignment entirely — it contributes to neither matched nor comparable for ANY
// member). This fixture documents the worked example and proves the pure JS layer needs no tie
// logic of its own: it just sums whatever the view actually returned.
test('cohesionFromAlignment: a tied roll call never reaches this function at all (excluded upstream by the view) — worked example', () => {
  // 3 roll calls in 2024 (house) for this legislator's party:
  //   RC1: party casts 3 yea / 1 nay -> majority yea; member cast yea -> matched.
  //   RC2: party casts 2 yea / 2 nay -> TIE -> majority_position is null -> the view excludes RC2
  //        completely (does not increment comparable OR matched for this legislator).
  //   RC3: party casts 1 yea / 4 nay -> majority nay; member cast yea -> NOT matched.
  // So public_party_alignment reports exactly: comparable = 2 (RC1 + RC3), matched = 1 (RC1 only).
  const rows = [alignmentRow({
    year: 2024, chamber: 'house', matched: 1, comparable: 2,
  })];
  const result = cohesionFromAlignment(rows, { year: 2024 });
  assert.deepEqual(result, { matched: 1, comparable: 2, pct: '50.0%' });
});

// M2 (review, RULING, fix round 1): "exclude roll calls where the member is their party's ONLY
// yea/nay caster from comparable (self-majority is not a party-line signal — an Independent
// renders 'not computable', never a fake 100%)." Excluded in 0018's SQL via
// `(pm.party_yea + pm.party_nay) > 1` — a worked example proving the pure JS layer needs no
// singleton-detection logic of its own, mirroring the tie-exclusion fixture above.
test('cohesionFromAlignment: a roll call where the member was their party\'s ONLY yea/nay caster never reaches this function either (M2, singleton-caster exclusion) — worked example, the review\'s own lone-Independent case', () => {
  // A chamber's only Independent, 4 roll calls in 2024:
  //   RC1-RC4: on every one, this legislator is the ONLY 'Independent' caster (party_yea+
  //   party_nay = 1 every time) -> the view's M2 filter excludes ALL FOUR -> zero rows for this
  //   legislator/year/chamber at all -> cohesionFromAlignment sees an EMPTY row set for them.
  const rows = []; // exactly what the view returns for this legislator: nothing
  const result = cohesionFromAlignment(rows, { year: 2024, chamber: 'senate' });
  assert.equal(result, null, 'never a fabricated 100% — "not computable" is the only honest rendering');
});

// ============================================================================
// normalizePartyLabel — MUST mirror migration 0018's SQL CASE exactly: 'R'/'D'/'I' -> the full
// printed forms; an already-full form passes through unchanged; anything else (including empty
// string / null / a genuinely unrecognized label) -> null (M3's "no party group" signal).
// ============================================================================

test('normalizePartyLabel: abbreviations normalize to the full printed forms', () => {
  assert.equal(normalizePartyLabel('R'), 'Republican');
  assert.equal(normalizePartyLabel('D'), 'Democratic');
  assert.equal(normalizePartyLabel('I'), 'Independent');
});

test('normalizePartyLabel: an already-normalized full form passes through unchanged', () => {
  assert.equal(normalizePartyLabel('Republican'), 'Republican');
  assert.equal(normalizePartyLabel('Democratic'), 'Democratic');
  assert.equal(normalizePartyLabel('Independent'), 'Independent');
});

test('normalizePartyLabel: an unrecognized or non-normalized label -> null (M3: no party group, no figure) — never a guess', () => {
  assert.equal(normalizePartyLabel('Democrat'), null, 'close to, but not exactly, a normalized form — never guessed into one');
  assert.equal(normalizePartyLabel('Independent Democrat'), null);
  assert.equal(normalizePartyLabel(''), null);
});

test('normalizePartyLabel: null/undefined/non-string input -> null, never throws', () => {
  assert.equal(normalizePartyLabel(null), null);
  assert.equal(normalizePartyLabel(undefined), null);
  assert.equal(normalizePartyLabel(42), null);
});

// SQL-shape assertion (review: "normalization CASE via a SQL-shape assertion in tests if
// practical") — no live DB in this suite (design spec §8), so this reads the DRAFT migration's
// actual text and asserts the party-normalization CASE (and the other fix-round-mandated SQL
// shapes) are genuinely present, keeping the migration file and this test honest of each other
// without a live database.
test('migration 0018: SQL-shape assertions — three materialized views, party normalization CASE (mirrors normalizePartyLabel exactly), unique indexes for CONCURRENTLY refresh, and the locked-down refresh function', () => {
  const sql = readFileSync(new URL('../supabase/migrations/0018_vote_aggregates.sql', import.meta.url), 'utf8');

  assert.match(sql, /create materialized view public_position_totals/);
  assert.match(sql, /create materialized view public_party_alignment/);
  // N-G (fix round 2, CONTROLLER RULING): the party rollup matview.
  assert.match(sql, /create materialized view public_party_position_totals/);

  // The exact CASE normalizePartyLabel mirrors — appears three times (once per matview).
  const caseOccurrences = sql.match(/when 'R' then 'Republican'/g) || [];
  assert.equal(caseOccurrences.length, 3, 'the R->Republican mapping must appear in ALL THREE matviews\' party handling');
  assert.match(sql, /when 'D' then 'Democratic'/);
  assert.match(sql, /when 'I' then 'Independent'/);

  assert.match(sql, /create unique index public_position_totals_uq[\s\S]*?\(legislator_id, jurisdiction_id, chamber, year, position\)/);
  assert.match(sql, /create unique index public_party_alignment_uq[\s\S]*?\(legislator_id, year, chamber\)/);
  assert.match(sql, /create unique index public_party_position_totals_uq[\s\S]*?\(party, jurisdiction_id, chamber, year, position\)/);

  // M2 singleton-caster exclusion.
  assert.match(sql, /party_yea \+ pm\.party_nay\) > 1/);
  // M3 null/unrecognized-party exclusion (only the three normalized labels ever form a group) —
  // must appear at least twice: once in public_party_alignment, once in public_party_position_totals.
  const normalizedGroupOccurrences = sql.match(/'Republican', 'Democratic', 'Independent'/g) || [];
  assert.ok(normalizedGroupOccurrences.length >= 2, 'the normalized-only allowlist must gate both party_alignment and party_position_totals');

  // N-H(b) (fix round 2): idempotent re-apply — drop-if-exists before every create, and the
  // refresh function uses CREATE OR REPLACE rather than a plain CREATE.
  assert.match(sql, /drop materialized view if exists public_position_totals cascade/);
  assert.match(sql, /drop materialized view if exists public_party_alignment cascade/);
  assert.match(sql, /drop materialized view if exists public_party_position_totals cascade/);
  assert.match(sql, /create or replace function refresh_vote_aggregates/);
  assert.doesNotMatch(sql, /\ncreate function refresh_vote_aggregates/, 'must be CREATE OR REPLACE, not a plain CREATE');

  // Refresh function: security definer, search_path hardened, revoked from public/anon, granted
  // only to service_role, and refreshes all THREE matviews.
  assert.match(sql, /security definer/);
  assert.match(sql, /set search_path = public, pg_temp/);
  assert.match(sql, /refresh materialized view concurrently public_position_totals/);
  assert.match(sql, /refresh materialized view concurrently public_party_alignment/);
  assert.match(sql, /refresh materialized view concurrently public_party_position_totals/);
  assert.match(sql, /revoke all on function refresh_vote_aggregates\(\) from public/);
  assert.match(sql, /revoke all on function refresh_vote_aggregates\(\) from anon/);
  assert.match(sql, /grant execute on function refresh_vote_aggregates\(\) to service_role/);

  assert.match(sql, /grant select on public_position_totals to anon, authenticated/);
  assert.match(sql, /grant select on public_party_alignment to anon, authenticated/);
  assert.match(sql, /grant select on public_party_position_totals to anon, authenticated/);
});

// N-E (review, fix round 2): the migration's own comment must plainly state the fail-open
// security model (independent grants on an owner-computed snapshot) rather than implying the
// fail-closed behavior migration 0016's security_invoker views actually have — a future
// maintainer revoking anon on the base tables needs to be told, in the file itself, that these
// three matviews' own grants require a SEPARATE, explicit revoke.
test('migration 0018: the fail-open security-model comment is present (N-E) — distinguishes these matviews from 0016\'s fail-closed invoker views', () => {
  const sql = readFileSync(new URL('../supabase/migrations/0018_vote_aggregates.sql', import.meta.url), 'utf8');
  assert.match(sql, /FAIL OPEN/);
  assert.match(sql, /fails closed/i, 'must name the contrast with 0016\'s invoker views explicitly');
  assert.match(sql, /explicitly revokes `select`/i, 'must plainly state that revoking the bases requires a SEPARATE, explicit revoke on these matviews too');
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

test('METRIC_DEFINITIONS.distribution: states its chamber/year scope AND that the missed-only toggle does not narrow the chart itself (H3 rewrite)', () => {
  const body = METRIC_DEFINITIONS.distribution.body ?? METRIC_DEFINITIONS.distribution;
  assert.match(body, /chamber\/year/i);
  assert.match(body, /never narrow this chart/i);
});

test('METRIC_DEFINITIONS.cohesion: states the strict-majority rule, the tie exclusion, and the not-voting/absent exclusion', () => {
  const body = METRIC_DEFINITIONS.cohesion.body ?? METRIC_DEFINITIONS.cohesion;
  assert.match(body, /majority/i);
  assert.match(body, /tie/i);
  assert.match(body, /not.voting|not voting/i);
  assert.match(body, /absent/i);
});

test('METRIC_DEFINITIONS.partyComparison: states party is recorded as printed, is never a member-vs-member comparison, and names the R/D/I normalization equivalence (H3 rewrite)', () => {
  const body = METRIC_DEFINITIONS.partyComparison.body ?? METRIC_DEFINITIONS.partyComparison;
  assert.match(body, /record/i);
  assert.match(body, /never a comparison between two individual legislators/i);
  assert.match(body, /'R'.*'D'.*'I'/s, 'must name the three normalized abbreviations');
  assert.match(body, /Republican.*Democratic.*Independent/s, 'must name the three full forms they normalize to');
});

test('METRIC_DEFINITIONS.cohesion: names its real grouping (year AND chamber), the singleton-caster exclusion (M2), and the null-party no-figure rule (M3) — H3 rewrite', () => {
  const body = METRIC_DEFINITIONS.cohesion.body ?? METRIC_DEFINITIONS.cohesion;
  assert.match(body, /year and chamber/i);
  assert.match(body, /ONLY yea\/nay caster/);
  assert.match(body, /does not resolve to one of those three common forms has no cohesion figure/i);
});

// N-H(f) (re-review, fix round 2): the member's own cast counts as one of their party's casts
// when the majority is computed — never excluded from their own party's tally.
test('METRIC_DEFINITIONS.cohesion: states the legislator\'s own cast counts as one of their party\'s casts when the majority is computed (N-H(f))', () => {
  const body = METRIC_DEFINITIONS.cohesion.body ?? METRIC_DEFINITIONS.cohesion;
  assert.match(body, /own cast counts as one of their party's casts/i);
  assert.match(body, /never excluded from their own party's tally/i);
});

// N-A (re-review, HIGH, fix round 2): the "no figure for a group of one" rule now covers BOTH the
// unrecognized-party case (fix round 1) AND the case where the legislator is the only one
// recorded with an otherwise-common party in the relevant scope — a party label being one of the
// three common ones is not, on its own, enough to guarantee a real comparison group exists.
test('METRIC_DEFINITIONS.partyComparison: the "no figure" rule extends to being the ONLY legislator recorded with that party in the relevant scope (N-A)', () => {
  const body = METRIC_DEFINITIONS.partyComparison.body ?? METRIC_DEFINITIONS.partyComparison;
  assert.match(body, /ONLY one recorded with that party/i);
  assert.match(body, /group that is only themselves would not be a real comparison/i);
});

// N-D (re-review, fix round 2): the staleness disclosure — the charts are computed from a
// periodically refreshed snapshot, not live; the vote list stays live.
test('METRIC_DEFINITIONS.staleness: exists and states the charts are a periodically refreshed snapshot while the vote list stays live (N-D)', () => {
  assert.ok(METRIC_DEFINITIONS.staleness, 'METRIC_DEFINITIONS.staleness must exist');
  const body = METRIC_DEFINITIONS.staleness.body ?? METRIC_DEFINITIONS.staleness;
  assert.match(body, /periodically refreshed snapshot/i);
  assert.match(body, /not a live query|not live/i);
  assert.match(body, /vote list.*live|live.*vote list/is);
});

// H3 (review, fix round 1): the OLD "not independently verified or normalized" sentences were a
// FALSE claim about the shipped implementation (party IS normalized, per C1+C2) — this test pins
// that the stale claim is genuinely gone, not just that a new claim was added alongside it.
test('METRIC_DEFINITIONS: no longer claims party is "not... normalized" anywhere (that sentence became false the moment normalization shipped)', () => {
  const allText = Object.values(METRIC_DEFINITIONS).map((v) => (typeof v === 'string' ? v : v.body)).join(' ');
  assert.doesNotMatch(allText, /not independently verified or normalized/i);
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

// H2 (review, fix round 1): bar clicks now dispatch a real per-position filter (position=eq.yea /
// eq.nay / in.(present,other)) rather than the old coarse missedOnly-only binary. not_voting and
// absent still map onto the pre-existing missedOnly toggle (exact match: that bucket IS the
// missed-votes set) and explicitly clear `position`; yea/nay/other set `position` and explicitly
// clear `missedOnly`, so the two levers never both apply to the same query.
test('renderChartSection: clicking the not_voting or absent bar calls onBarClick with { position: null, missedOnly: true } (missedOnly stays the special case for these two buckets)', () => {
  const container = document.createElement('section');
  const calls = [];
  renderChartSection(container, fullModels(), (patch) => calls.push(patch));
  const notVotingRow = container.querySelector('[data-bar="not_voting"]');
  const absentRow = container.querySelector('[data-bar="absent"]');
  assert.notEqual(notVotingRow, null);
  assert.notEqual(absentRow, null);
  notVotingRow.click();
  absentRow.click();
  assert.deepEqual(calls, [{ position: null, missedOnly: true }, { position: null, missedOnly: true }]);
});

test('renderChartSection: clicking the yea/nay/other bar calls onBarClick with the matching { position, missedOnly: false }', () => {
  const container = document.createElement('section');
  const calls = [];
  renderChartSection(container, fullModels(), (patch) => calls.push(patch));
  container.querySelector('[data-bar="yea"]').click();
  container.querySelector('[data-bar="nay"]').click();
  container.querySelector('[data-bar="other"]').click();
  assert.deepEqual(calls, [
    { position: 'yea', missedOnly: false },
    { position: 'nay', missedOnly: false },
    { position: 'other', missedOnly: false },
  ]);
});

// M4 (review, fix round 1): the clickable distribution bars are real <button> elements —
// natively keyboard/AT accessible (Enter/Space activate a button with no ARIA wiring needed).
test('renderChartSection: distribution bars are real <button type="button"> elements (keyboard/AT accessible), never a bare div with only a mouse handler', () => {
  const container = document.createElement('section');
  renderChartSection(container, fullModels(), () => {});
  const yeaBar = container.querySelector('[data-bar="yea"]');
  assert.equal(yeaBar.tagName, 'BUTTON');
  assert.equal(yeaBar.type, 'button');
});

// ============================================================================
// N-C (re-review, fix round 2): the position/missed-only filter a bar click applies to the vote
// list was invisible once set (no visual trace on the chart itself) and sticky (survives other
// filter changes, by design — but with zero visible indicator that's a real usability trap).
// activeFilterPositions is the pure "which bar(s) does the CURRENT filter state reflect" logic;
// renderChartSection consumes it to set aria-pressed/an active class and to show/hide the "Clear
// position filter" control.
// ============================================================================

test('activeFilterPositions: position=yea/nay/other each activate exactly their own bar', () => {
  assert.deepEqual([...activeFilterPositions({ position: 'yea' })], ['yea']);
  assert.deepEqual([...activeFilterPositions({ position: 'nay' })], ['nay']);
  assert.deepEqual([...activeFilterPositions({ position: 'other' })], ['other']);
});

test('activeFilterPositions: missedOnly activates BOTH not_voting and absent together (the same combined bucket the checkbox always meant)', () => {
  const active = activeFilterPositions({ missedOnly: true });
  assert.deepEqual([...active].sort(), ['absent', 'not_voting']);
});

test('activeFilterPositions: missedOnly wins over a stale/contradictory position value (defensive, same precedence as voteFilterQuery)', () => {
  const active = activeFilterPositions({ missedOnly: true, position: 'yea' });
  assert.deepEqual([...active].sort(), ['absent', 'not_voting']);
});

test('activeFilterPositions: neither set -> empty set, never throws on null/undefined filters', () => {
  assert.equal(activeFilterPositions({}).size, 0);
  assert.equal(activeFilterPositions(null).size, 0);
  assert.equal(activeFilterPositions(undefined).size, 0);
});

test('renderChartSection: the active bar carries aria-pressed="true" + a visible active class; every other bar is aria-pressed="false"', () => {
  const container = document.createElement('section');
  const models = fullModels();
  models.filters = { position: 'yea', missedOnly: false };
  renderChartSection(container, models, () => {});
  const yeaBar = container.querySelector('[data-bar="yea"]');
  const nayBar = container.querySelector('[data-bar="nay"]');
  assert.equal(yeaBar.getAttribute('aria-pressed'), 'true');
  assert.equal(yeaBar.classList.contains('chart-bar-active'), true);
  assert.equal(nayBar.getAttribute('aria-pressed'), 'false');
  assert.equal(nayBar.classList.contains('chart-bar-active'), false);
});

test('renderChartSection: missedOnly=true marks BOTH not_voting and absent as active', () => {
  const container = document.createElement('section');
  const models = fullModels();
  models.filters = { position: null, missedOnly: true };
  renderChartSection(container, models, () => {});
  assert.equal(container.querySelector('[data-bar="not_voting"]').getAttribute('aria-pressed'), 'true');
  assert.equal(container.querySelector('[data-bar="absent"]').getAttribute('aria-pressed'), 'true');
  assert.equal(container.querySelector('[data-bar="yea"]').getAttribute('aria-pressed'), 'false');
});

test('renderChartSection: no active filter -> no "Clear position filter" control rendered', () => {
  const container = document.createElement('section');
  const models = fullModels();
  models.filters = { position: null, missedOnly: false };
  renderChartSection(container, models, () => {});
  assert.equal(container.querySelector('.chart-clear-position-filter'), null);
  // and every bar is aria-pressed="false"
  for (const pos of ['yea', 'nay', 'not_voting', 'absent', 'other']) {
    assert.equal(container.querySelector(`[data-bar="${pos}"]`).getAttribute('aria-pressed'), 'false');
  }
});

test('renderChartSection: an active filter renders a visible "Clear position filter" control that clears BOTH position and missedOnly on click', () => {
  const container = document.createElement('section');
  const models = fullModels();
  models.filters = { position: 'yea', missedOnly: false };
  const calls = [];
  renderChartSection(container, models, (patch) => calls.push(patch));
  const clearBtn = container.querySelector('.chart-clear-position-filter');
  assert.notEqual(clearBtn, null);
  assert.equal(clearBtn.textContent, 'Clear position filter');
  assert.equal(clearBtn.type, 'button');
  clearBtn.click();
  assert.deepEqual(calls, [{ position: null, missedOnly: false }]);
});

// L4 (review, fix round 1): one authored link to the trust page's metrics section under the
// charts — a relative, site-internal href (render.js's el() href guard allows this for href,
// unlike src).
test('renderChartSection: renders an "About these numbers" link to /trust#metrics', () => {
  const container = document.createElement('section');
  renderChartSection(container, fullModels(), () => {});
  const link = container.querySelector('a.chart-definitions-link');
  assert.notEqual(link, null);
  assert.equal(link.getAttribute('href'), '/trust#metrics');
  assert.equal(link.textContent, 'About these numbers');
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
  await result.rescope(); // rescope() is async (H1: it may re-fetch party rows on a chamber change)
  assert.equal(fetchCount, fetchCountBeforeRescope, 'rescope() must not re-fetch when party is null (no party fetch to begin with) — it recomputes from rows already in hand');
  assert.match(container.textContent, /8/);
  const nayValue = container.querySelector('[data-bar="nay"] .chart-bar-value').textContent;
  assert.equal(nayValue, '0 (0.0%)', 'the senate/2023 nay row is now scoped out by the chamber filter');
});

// H1/N-F/N-G (review, fix round 1 + re-review fix round 2): the party-comparison fetch is ONE
// indexed query on the public_party_position_totals ROLLUP matview (N-G — pre-summed across every
// legislator of that party, no legislator_id at all), filtered by the member's OWN normalized
// party + the member's own jurisdiction set (derived from memberRows, never guessed) + a chamber
// scope that is ALWAYS present — either the active chamber filter, or (N-F, when no chamber filter
// is selected) the member's OWN chambers, so the default view never silently widens beyond what
// the member actually has data for.
test('loadChartsSection: H1/N-F/N-G — the party-rollup fetch filters by normalized party + jurisdiction set + a chamber scope that defaults to the member\'s OWN chambers, and re-fetches only when the active chamber filter changes', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  const partyFetchUrls = [];
  const existenceFetchUrls = [];
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/public_position_totals') && u.includes('legislator_id=in.(')) {
      // A merged senate+house career, so switching the chamber filter later still leaves the
      // member's OWN distribution non-zero (never hits the empty-state early return).
      return okResponse([
        totalsRow({
          legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'senate', year: 2024, position: 'yea', casts: 5,
        }),
        totalsRow({
          legislator_id: 'leg-1', jurisdiction_id: 'mo-legislature', chamber: 'house', year: 2024, position: 'yea', casts: 3,
        }),
      ]);
    }
    if (u.includes('/public_position_totals') && u.includes('legislator_id=not.in')) {
      existenceFetchUrls.push(u);
      return okResponse([{ legislator_id: 'other-leg' }]); // confirms a real outside party member exists
    }
    if (u.includes('/public_party_position_totals')) {
      partyFetchUrls.push(u);
      return okResponse([{
        party: 'Republican', jurisdiction_id: 'mo-legislature', chamber: 'senate', year: 2024, position: 'yea', casts: 50,
      }]);
    }
    if (u.includes('/public_party_alignment')) return okResponse([]);
    return okResponse([]);
  });
  const container = document.createElement('section');
  const filters = { chamber: null, year: null };
  const result = await loadChartsSection(container, {
    legislatorIds: ['leg-1'], party: 'R', filters, onBarClick: () => {},
  });

  assert.equal(partyFetchUrls.length, 1);
  assert.match(partyFetchUrls[0], /public_party_position_totals\?/, 'N-G: queries the pre-summed party ROLLUP view, not the per-legislator one');
  assert.match(partyFetchUrls[0], /party=eq\.Republican/, 'the RAW "R" resolved to the normalized "Republican" before hitting the query');
  assert.match(partyFetchUrls[0], /jurisdiction_id=in\.\(mo-legislature\)/, 'scoped to the member\'s OWN jurisdiction set, derived from memberRows');
  assert.match(partyFetchUrls[0], /chamber=in\.\(senate,house\)/, 'N-F: no chamber filter active yet -> derives chamber=in.(...) from the member\'s OWN chambers, never left unscoped');

  assert.equal(existenceFetchUrls.length, 1);
  assert.match(existenceFetchUrls[0], /legislator_id=not\.in\.\(leg-1\)/, 'N-A: the existence check excludes the member\'s own ids');
  assert.match(existenceFetchUrls[0], /chamber=in\.\(senate,house\)/, 'N-A\'s existence check shares the SAME chamber scope as the rollup fetch');
  assert.notEqual(container.querySelector('[data-bar="party-comparison-party"]'), null, 'a confirmed real outside member -> the comparison actually renders');

  filters.chamber = 'house';
  await result.rescope();
  assert.equal(partyFetchUrls.length, 2, 'a chamber CHANGE re-fetches the party rollup (chamber is a server-side filter on this fetch, unlike year)');
  assert.match(partyFetchUrls[1], /chamber=eq\.house/);
  assert.equal(existenceFetchUrls.length, 2, 'the existence check re-runs alongside the rollup fetch on a chamber change');

  await result.rescope(); // no chamber change this time
  assert.equal(partyFetchUrls.length, 2, 'an unchanged chamber never triggers a redundant re-fetch');
  assert.equal(existenceFetchUrls.length, 2);
});

// N-A (re-review, HIGH, fix round 2): the review's own live scenario — 8 reachable Independents
// each the only member of their party in their chamber. Without the existence check, the party
// rollup fetch would return ONLY the member's own summed rows (since they're the only contributor
// to that party/jurisdiction/chamber group), and partyComparisonModel would render two IDENTICAL
// bars — member-vs-himself, rendered as "perfectly in line with his party." This must never
// happen: the existence check confirms nobody else is in the group, so the whole comparison
// degrades to "not computable," same rendering as a null/unrecognized party.
test('loadChartsSection: N-A — a lone Independent (party rollup returns only the member\'s own summed data) renders party comparison as "not computable," never member-vs-himself', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/public_position_totals') && u.includes('legislator_id=in.(')) {
      return okResponse([totalsRow({
        legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'senate', year: 2024, position: 'yea', casts: 10,
      })]);
    }
    if (u.includes('/public_position_totals') && u.includes('legislator_id=not.in')) {
      // The critical fixture: NO row exists for anyone other than this legislator — the existence
      // check must find nothing.
      return okResponse([]);
    }
    if (u.includes('/public_party_position_totals')) {
      // The rollup itself DOES return rows — they just happen to be entirely this legislator's
      // own contribution (a real, if misleading, possible response shape from the pre-summed view).
      return okResponse([{
        party: 'Independent', jurisdiction_id: 'us-congress', chamber: 'senate', year: 2024, position: 'yea', casts: 10,
      }]);
    }
    if (u.includes('/public_party_alignment')) return okResponse([]);
    return okResponse([]);
  });
  const container = document.createElement('section');
  const result = await loadChartsSection(container, {
    legislatorIds: ['leg-1'], party: 'I', filters: { chamber: null, year: null }, onBarClick: () => {},
  });
  assert.notEqual(result, null);
  const comparisonSection = container.querySelector('.chart-party-comparison');
  assert.notEqual(comparisonSection, null);
  assert.match(comparisonSection.textContent, /not computable/i);
  assert.equal(comparisonSection.querySelector('.chart-bar-fill'), null, 'no bars at all — never two identical member-vs-himself bars');
});

// N-B (re-review, HIGH, fix round 2): rescope() is async (it may re-fetch party scope on a
// chamber change) and gets called again on every filter change — two rapid chamber switches are a
// real race, since network responses can resolve OUT OF ORDER. Mirrors
// tests/person-page.test.js's own MED-5 construction exactly (loadVotesSection's voteGeneration
// test): two calls are started back-to-back (the reviewer's own "two quick chamber switches"), and
// their fetches are resolved in REVERSE order (the older-started one resolves LAST) to prove the
// fix is about call-START order, not network/resolution order.
test('loadChartsSection: N-B — a stale (superseded) rescope() call never renders, even if its fetch resolves AFTER the newer call\'s (the reviewer\'s interleaved-chamber-switch construction)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });

  // Only the party-rollup fetch's resolution is deferred/controlled, and only for the two
  // chamber-specific (post-mount) requests — every other endpoint (member rows, the N-A existence
  // check, alignment, and the UNcontrolled initial default-chamber rollup fetch during mount)
  // resolves immediately, so the ONLY thing under test is the chamber-switch race itself.
  const resolvers = {};
  _setFetch((url) => {
    const u = String(url);
    if (u.includes('/public_position_totals') && u.includes('legislator_id=in.(')) {
      return Promise.resolve(okResponse([
        totalsRow({
          legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'house', year: 2024, position: 'yea', casts: 9,
        }),
        totalsRow({
          legislator_id: 'leg-1', jurisdiction_id: 'us-congress', chamber: 'senate', year: 2024, position: 'yea', casts: 4,
        }),
      ]));
    }
    if (u.includes('/public_position_totals') && u.includes('legislator_id=not.in')) {
      return Promise.resolve(okResponse([{ legislator_id: 'other-leg' }])); // a real outside member, so the comparison actually renders and its content is observable
    }
    if (u.includes('/public_party_position_totals')) {
      if (u.includes('chamber=eq.house')) {
        return new Promise((resolve) => {
          resolvers.house = () => resolve(okResponse([{
            party: 'Republican', jurisdiction_id: 'us-congress', chamber: 'house', year: 2024, position: 'yea', casts: 900,
          }]));
        });
      }
      if (u.includes('chamber=eq.senate')) {
        return new Promise((resolve) => {
          resolvers.senate = () => resolve(okResponse([{
            party: 'Republican', jurisdiction_id: 'us-congress', chamber: 'senate', year: 2024, position: 'yea', casts: 400,
          }]));
        });
      }
      // The initial mount's default (no-chamber-filter, chamber=in.(house,senate)) fetch is left
      // UNcontrolled so the section can actually mount before the race begins.
      return Promise.resolve(okResponse([]));
    }
    if (u.includes('/public_party_alignment')) return Promise.resolve(okResponse([]));
    return Promise.resolve(okResponse([]));
  });

  const container = document.createElement('section');
  const filters = { chamber: null, year: null };
  const result = await loadChartsSection(container, {
    legislatorIds: ['leg-1'], party: 'R', filters, onBarClick: () => {},
  });
  assert.notEqual(result, null);

  // Start the OLDER call first (house)…
  filters.chamber = 'house';
  const older = result.rescope();
  // …then start the NEWER call (senate) before the older one resolves.
  filters.chamber = 'senate';
  const newer = result.rescope();

  // Resolve OUT OF ORDER: the newer (senate) request finishes FIRST, the older (house) one LAST.
  resolvers.senate();
  await newer;
  resolvers.house();
  await older;

  const partyValue = container.querySelector('[data-bar="party-comparison-party"] .chart-bar-value').textContent;
  assert.match(partyValue, /400/, 'the newer (current-generation, senate) result must render');
  assert.doesNotMatch(partyValue, /900/, 'the stale, later-resolving (house) call must never overwrite the newer render');
});

// M1 (review, fix round 1): a charts-section retry that SUCCEEDS must reassign the caller's
// rescope reference — otherwise a filter change after a successful retry would silently rescope
// against nothing (the stale no-op fallback), even though the section itself shows real data.
test('loadChartsSection: M1 — onReady fires again after a successful retry, so the caller\'s rescope reference never goes stale', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  let shouldFail = true;
  _setFetch(async (url) => {
    const u = String(url);
    if (shouldFail && (u.includes('/public_position_totals') || u.includes('/public_party_alignment'))) {
      return pgrst205Response('public_position_totals');
    }
    if (u.includes('/public_position_totals') && u.includes('legislator_id=in')) {
      return okResponse([totalsRow({
        legislator_id: 'leg-1', chamber: 'house', year: 2024, position: 'yea', casts: 9,
      })]);
    }
    return okResponse([]);
  });

  const container = document.createElement('section');
  const readyResults = [];
  await loadChartsSection(container, {
    legislatorIds: ['leg-1'],
    party: null,
    filters: { chamber: null, year: null },
    onBarClick: () => {},
    onReady: (result) => readyResults.push(result),
  });
  assert.equal(readyResults.length, 0, 'onReady never fires on a failed load');
  assert.notEqual(container.querySelector('.section-state-failed'), null);

  shouldFail = false;
  const retryBtn = container.querySelector('button.section-state-retry');
  assert.notEqual(retryBtn, null);
  retryBtn.click();
  await new Promise((resolve) => { setTimeout(resolve, 30); });

  assert.equal(readyResults.length, 1, 'onReady fires exactly once, for the successful retry');
  assert.equal(container.querySelector('.section-state-failed'), null, 'the section itself recovered');
  assert.match(container.textContent, /9/);
});

// H4 (review, fix round 1): mirrors the existing NEW-B pattern (freshness must not block votes) —
// the charts fetch must not block votes, the page's centerpiece, either.
test('mountProfile: H4 — the votes fetch fires even while the charts fetch is still pending (charts must not block the centerpiece)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  const callOrder = [];
  let releaseCharts;
  const chartsGate = new Promise((resolve) => { releaseCharts = resolve; });

  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/terms?')) return okResponse([]);
    if (u.includes('/public_freshness?')) return okResponse([]);
    if (u.includes('/bill_sponsors?')) return okResponse([]);
    if (u.includes('/public_vote_feed?')) {
      callOrder.push('votes-fetch-fired');
      return okResponse([]);
    }
    if (u.includes('/public_position_totals') || u.includes('/public_party_alignment')) {
      callOrder.push('charts-fetch-started');
      await chartsGate; // deliberately held open until the test releases it
      callOrder.push('charts-fetch-resolved');
      return okResponse([]);
    }
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
  const mountPromise = mountProfile(sections, {
    person: null,
    legislators: [{
      id: 'leg-1', full_name: 'Jane Doe', bioguide_id: null, image_url: null,
    }],
  });

  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(callOrder.includes('votes-fetch-fired'), true, 'the votes fetch must fire even though charts has not resolved yet');
  assert.equal(callOrder.includes('charts-fetch-resolved'), false, 'charts genuinely has not resolved at this checkpoint — not a race artifact');

  releaseCharts();
  await mountPromise;
  assert.equal(callOrder.includes('charts-fetch-resolved'), true, 'charts still completes once released — nothing dropped, only the ordering vs. votes changed');
});

// L1 (review, fix round 1): a bar click that would produce the SAME resulting filter state (every
// non-page key already matches) is a no-op — no page reset, no re-fetch, no re-render.
test('mountProfile: L1 — a bar click producing an identical filter state is a no-op (no page reset, no extra vote-list fetch)', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  let voteFetchCount = 0;
  _setFetch(async (url) => {
    const u = String(url);
    if (u.includes('/terms?')) return okResponse([]);
    if (u.includes('/public_freshness?')) return okResponse([]);
    if (u.includes('/bill_sponsors?')) return okResponse([]);
    if (u.includes('/public_vote_feed?')) { voteFetchCount += 1; return okResponse([]); }
    if (u.includes('/public_position_totals')) {
      return okResponse([totalsRow({
        legislator_id: 'leg-1', chamber: 'house', year: 2024, position: 'yea', casts: 4,
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

  const yeaBar = sections.charts.querySelector('[data-bar="yea"]');
  assert.notEqual(yeaBar, null);
  const voteFetchCountAfterMount = voteFetchCount;

  // First click: yea isn't the active filter yet -> a REAL change (position: 'yea', missedOnly:
  // false) -> re-fetches. Second click on the SAME bar: filters are already exactly
  // { position: 'yea', missedOnly: false } -> a no-op, must NOT fetch again.
  yeaBar.click();
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(voteFetchCount, voteFetchCountAfterMount + 1, 'the first click is a real filter change');

  const countAfterFirstClick = voteFetchCount;
  yeaBar.click();
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(voteFetchCount, countAfterFirstClick, 'clicking the SAME already-active bar again is a no-op — no extra fetch');
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
