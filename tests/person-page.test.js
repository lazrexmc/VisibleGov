import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  idFromPath, buildOneLinerMap, joinFlagBadges, relevantFreshnessRows,
} from '../site/js/person-page.js';

// Task 6 (docs/superpowers/plans/2026-07-30-public-site.md, task-6-brief.md) — pure helpers for
// the profile page, TDD'd here BEFORE the DOM-wiring code exists. site/js/person-page.js also
// exports the page's DOM-orchestration functions (not exercised here — this file covers only the
// pure logic per the brief's explicit scope: "TDD the brief's pure helpers (idFromPath, one-liner
// attach map, flag-badge join)").

// ============================================================================
// idFromPath — URL contract: `/person/<uuid>[/<slug-ignored>]`
// ============================================================================

test('idFromPath: prefix + uuid + trailing slug -> the uuid, slug ignored', () => {
  assert.equal(idFromPath('/person/abc-123-def/jane-doe', '/person/'), 'abc-123-def');
  assert.equal(idFromPath('/legislator/xyz-789/john-smith', '/legislator/'), 'xyz-789');
});

test('idFromPath: prefix + uuid, no trailing slug segment at all', () => {
  assert.equal(idFromPath('/person/abc-123-def', '/person/'), 'abc-123-def');
});

test('idFromPath: prefix + uuid + trailing slash, empty slug segment', () => {
  assert.equal(idFromPath('/person/abc-123-def/', '/person/'), 'abc-123-def');
});

test('idFromPath: no id segment after the prefix -> null', () => {
  assert.equal(idFromPath('/person/', '/person/'), null);
  assert.equal(idFromPath('/person', '/person/'), null, 'pathname does not even carry the prefix');
});

test('idFromPath: pathname does not start with the given prefix -> null', () => {
  assert.equal(idFromPath('/bill/1/hb-1', '/person/'), null);
});

test('idFromPath: non-string inputs never throw -> null', () => {
  assert.equal(idFromPath(null, '/person/'), null);
  assert.equal(idFromPath(undefined, '/person/'), null);
  assert.equal(idFromPath('/person/abc', null), null);
});

// ============================================================================
// buildOneLinerMap — step 4: current page's distinct bill_ids -> one summaries query -> keep
// first per bill_id (current published, since the query orders published_at.desc) ->
// extractOneLiner. Null -> title only, no placeholder text (the caller checks map.get()).
// ============================================================================

const PURPOSE_BODY = '**Stated purpose (from the bill):** Requires annual reporting.\n\n- Adds a report requirement (Sec. 2)\n';
const BULLET_ONLY_BODY = '- Adds a report requirement (Sec. 2)\n- Sets a deadline (Sec. 3)\n';
const NO_EXTRACTABLE_BODY = 'Nothing extractable here.\n';

test('buildOneLinerMap: one row per bill_id -> the extracted one-liner (purpose wins over bullet)', () => {
  const map = buildOneLinerMap([
    { bill_id: 'b1', body_md: PURPOSE_BODY, published_at: '2026-01-01T00:00:00Z' },
    { bill_id: 'b2', body_md: BULLET_ONLY_BODY, published_at: '2026-01-01T00:00:00Z' },
  ]);
  assert.equal(map.get('b1'), 'Requires annual reporting.');
  assert.equal(map.get('b2'), 'Adds a report requirement');
});

test('buildOneLinerMap: multiple rows for the same bill_id -> keeps the FIRST (query is ordered published_at.desc, so first = current published)', () => {
  const map = buildOneLinerMap([
    { bill_id: 'b1', body_md: PURPOSE_BODY, published_at: '2026-06-01T00:00:00Z' }, // newer, first in query order
    { bill_id: 'b1', body_md: BULLET_ONLY_BODY, published_at: '2025-01-01T00:00:00Z' }, // older, must be ignored
  ]);
  assert.equal(map.get('b1'), 'Requires annual reporting.', 'the first (newest) row wins, not the last');
});

test('buildOneLinerMap: a row with nothing extractable maps to null (title-only rendering, never a placeholder string)', () => {
  const map = buildOneLinerMap([{ bill_id: 'b1', body_md: NO_EXTRACTABLE_BODY, published_at: '2026-01-01T00:00:00Z' }]);
  assert.equal(map.get('b1'), null);
});

test('buildOneLinerMap: a bill_id absent from summaryRows is simply absent from the map (no published summary at all)', () => {
  const map = buildOneLinerMap([{ bill_id: 'b1', body_md: PURPOSE_BODY, published_at: '2026-01-01T00:00:00Z' }]);
  assert.equal(map.has('b2'), false);
  assert.equal(map.get('b2'), undefined);
});

test('buildOneLinerMap: empty/null/undefined input -> empty map, never throws', () => {
  assert.equal(buildOneLinerMap([]).size, 0);
  assert.equal(buildOneLinerMap(null).size, 0);
  assert.equal(buildOneLinerMap(undefined).size, 0);
});

test('buildOneLinerMap: rows missing bill_id are skipped, not crashed on', () => {
  const map = buildOneLinerMap([{ bill_id: null, body_md: PURPOSE_BODY, published_at: '2026-01-01T00:00:00Z' }]);
  assert.equal(map.size, 0);
});

// ============================================================================
// joinFlagBadges — step 5: public_reconciliation_flags?vote_id=in.(current page's vote_ids) ->
// badge on matching rows. Pure join by vote_id, never a DOM concern.
// ============================================================================

test('joinFlagBadges: marks rows whose vote_id appears in flagRows, leaves others unflagged', () => {
  const voteRows = [{ vote_id: 'v1' }, { vote_id: 'v2' }, { vote_id: 'v3' }];
  const flagRows = [{ vote_id: 'v2', discrepancy: 'tally mismatch' }];
  const joined = joinFlagBadges(voteRows, flagRows);
  assert.deepEqual(joined.map((r) => r.flagged), [false, true, false]);
});

test('joinFlagBadges: empty flagRows -> every row unflagged', () => {
  const voteRows = [{ vote_id: 'v1' }, { vote_id: 'v2' }];
  assert.deepEqual(joinFlagBadges(voteRows, []).map((r) => r.flagged), [false, false]);
  assert.deepEqual(joinFlagBadges(voteRows, null).map((r) => r.flagged), [false, false]);
});

test('joinFlagBadges: empty voteRows -> empty result, never throws', () => {
  assert.deepEqual(joinFlagBadges([], [{ vote_id: 'v1' }]), []);
  assert.deepEqual(joinFlagBadges(null, [{ vote_id: 'v1' }]), []);
});

test('joinFlagBadges: multiple flag rows for the same vote_id still just flags it once (boolean, not a count)', () => {
  const voteRows = [{ vote_id: 'v1' }];
  const flagRows = [{ vote_id: 'v1' }, { vote_id: 'v1' }];
  assert.equal(joinFlagBadges(voteRows, flagRows)[0].flagged, true);
});

test('joinFlagBadges: does not mutate the input vote rows (pure)', () => {
  const original = { vote_id: 'v1' };
  const voteRows = [original];
  joinFlagBadges(voteRows, [{ vote_id: 'v1' }]);
  assert.equal(Object.prototype.hasOwnProperty.call(original, 'flagged'), false);
});

test('joinFlagBadges: preserves every other field on the vote row unchanged', () => {
  const voteRows = [{
    vote_id: 'v1', position: 'yea', bill_identifier: 'HB 1',
  }];
  const [joined] = joinFlagBadges(voteRows, []);
  assert.equal(joined.position, 'yea');
  assert.equal(joined.bill_identifier, 'HB 1');
});

// ============================================================================
// relevantFreshnessRows — step 7: map jurisdiction_id -> relevant public_freshness sources
// (us-congress -> sources starting 'us-'; mo-legislature -> 'mo-' + 'legiscan').
// ============================================================================

const FRESHNESS_ROWS = [
  {
    source: 'us-congress', status: 'succeeded', finished_at: '2026-07-01T00:00:00Z', quarantined_days: 0,
  },
  {
    source: 'us-senate', status: 'succeeded', finished_at: '2026-07-01T00:00:00Z', quarantined_days: 0,
  },
  {
    source: 'mo-senate-web', status: 'succeeded', finished_at: '2026-06-15T00:00:00Z', quarantined_days: 6,
  },
  {
    source: 'mo-house-xml', status: 'succeeded', finished_at: '2026-06-20T00:00:00Z', quarantined_days: 0,
  },
  {
    source: 'legiscan', status: 'succeeded', finished_at: '2026-07-10T00:00:00Z', quarantined_days: 0,
  },
];

test('relevantFreshnessRows: us-congress jurisdiction -> only sources starting "us-"', () => {
  const rows = relevantFreshnessRows(FRESHNESS_ROWS, ['us-congress']);
  assert.deepEqual(rows.map((r) => r.source).sort(), ['us-congress', 'us-senate']);
});

test('relevantFreshnessRows: mo-legislature jurisdiction -> sources starting "mo-" plus exactly "legiscan"', () => {
  const rows = relevantFreshnessRows(FRESHNESS_ROWS, ['mo-legislature']);
  assert.deepEqual(rows.map((r) => r.source).sort(), ['legiscan', 'mo-house-xml', 'mo-senate-web']);
});

test('relevantFreshnessRows: both jurisdictions (a merged federal+MO person) -> the union, everything except unrelated sources', () => {
  const rows = relevantFreshnessRows(FRESHNESS_ROWS, ['us-congress', 'mo-legislature']);
  assert.deepEqual(rows.map((r) => r.source).sort(), ['legiscan', 'mo-house-xml', 'mo-senate-web', 'us-congress', 'us-senate']);
});

test('relevantFreshnessRows: no jurisdictions (zero terms, freshly-ingested unlinked row) -> empty, never guessed', () => {
  assert.deepEqual(relevantFreshnessRows(FRESHNESS_ROWS, []), []);
  assert.deepEqual(relevantFreshnessRows(FRESHNESS_ROWS, null), []);
});

test('relevantFreshnessRows: an unrecognized jurisdiction id contributes no matches (never throws, never matches everything)', () => {
  assert.deepEqual(relevantFreshnessRows(FRESHNESS_ROWS, ['ca-legislature']), []);
});
