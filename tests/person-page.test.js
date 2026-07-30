import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  idFromPath, buildOneLinerMap, joinFlagBadges, relevantFreshnessRows,
  loadVotesSection, renderIdentity,
} from '../site/js/person-page.js';
import { _setFetch, _setConfig } from '../site/js/rest.js';

// Task 6 (docs/superpowers/plans/2026-07-30-public-site.md, task-6-brief.md) — pure helpers for
// the profile page, TDD'd here BEFORE the DOM-wiring code exists. site/js/person-page.js also
// exports the page's DOM-orchestration functions — mostly not exercised here (the brief's
// explicit scope was the pure helpers: idFromPath, one-liner attach map, flag-badge join), EXCEPT
// for two fix-round-1 wiring-layer assertions below (the controller's live smoke caught both at
// the DOM level, so the regression tests live at the DOM level too).
//
// jsdom supplies `document` for the two render-touching tests below (same pattern as
// tests/site-modules.test.js) — set once here, after the static imports, before any test() body
// runs; person-page.js never touches `document` at its own module-load time.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8990/' });
globalThis.document = dom.window.document;

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

// ============================================================================
// Fix round 1 (task-6 controller live smoke) — two wiring-layer regressions caught only by
// actually rendering, so their regression tests live at the DOM level rather than as pure-helper
// unit tests.
// ============================================================================

// Finding 1, LOAD-BEARING: the live vote-feed query hit a Postgres statement timeout (PostgREST
// 500). Before the fix, rest.js's doFetch silently treated ANY non-array JSON body (a PostgREST
// error object is {code, message, ...}, not an array) as zero rows, so loadVotesSection's
// `page.rows.length === 0` check rendered the HONESTLY-EMPTY state for what was actually a FAILED
// fetch — exactly the violation the plan forbids ("a failed fetch NEVER renders as an empty
// section"). rest.js now throws a typed RestError on any non-2xx (see tests/site-modules.test.js);
// this test proves that throw actually reaches loadVotesSection's own catch and renders 'failed'.
test('loadVotesSection: a rejecting fetch (RestError, mirroring the live statement-timeout 500) renders the FAILED state, never the empty one', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ code: '57014', message: 'canceling statement due to statement timeout' }),
    headers: { get: () => null },
  }));
  const container = document.createElement('section');
  await loadVotesSection(container, { legislatorIds: ['leg-1'], filters: {} }).catch(() => {});
  assert.notEqual(container.querySelector('.section-state-failed'), null, 'must render the failed state');
  assert.equal(container.querySelector('.section-state-empty'), null, 'must NOT render the empty state');
  assert.equal(container.textContent.includes('No recorded votes'), false, 'the honestly-empty message must never appear for a failed fetch');
  assert.notEqual(container.querySelector('button'), null, 'a working retry button must be present (three-state law: a working retry, not a dead end)');
});

test('loadVotesSection: a genuinely empty (but successful) result still renders the empty state — the fix must not flip the other direction', async () => {
  _setConfig({ url: 'https://example.supabase.co', anonKey: 'test-anon-key' });
  _setFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => [],
    headers: { get: (name) => (name.toLowerCase() === 'content-range' ? '*/0' : null) },
  }));
  const container = document.createElement('section');
  await loadVotesSection(container, { legislatorIds: ['leg-1'], filters: {} });
  assert.notEqual(container.querySelector('.section-state-empty'), null, 'a real zero-row success must still render empty, not failed');
  assert.equal(container.querySelector('.section-state-failed'), null);
});

// Finding 2, IMPORTANT: buildIdentity's date-unproven fix (tests/profile-model.test.js) produces
// a joined multi-affiliation chamberLabel with districtLabel null — this proves renderIdentity
// (the DOM layer that actually painted the wrong single arbitrary chamber on the live page)
// renders the full joined string with no duplicated/redundant district suffix.
test('renderIdentity: a date-unproven multi-affiliation identity (joined chamberLabel, districtLabel null) renders the full joined string, no duplicated district suffix', () => {
  const container = document.createElement('section');
  renderIdentity(container, {
    displayName: 'Robert F. Onder',
    party: 'Republican',
    chamberLabel: 'MO Senate, district 2 · U.S. House, district 3',
    districtLabel: null,
    careerSpan: 'service dates unrecorded',
    photoCandidate: null,
    rowCount: 2,
  });
  const chamberText = container.querySelector('.profile-chamber').textContent;
  assert.equal(chamberText, 'MO Senate, district 2 · U.S. House, district 3');
  assert.equal(/district \d+, district/.test(chamberText), false, 'must not double-append a redundant district suffix onto the already-joined string');
});

test('renderIdentity: a single-affiliation (dated or date-unproven-but-unambiguous) identity still renders the original single-line chamber+district format unchanged', () => {
  const container = document.createElement('section');
  renderIdentity(container, {
    displayName: 'Bob Onder',
    party: 'Republican',
    chamberLabel: 'MO Senate',
    districtLabel: '2',
    careerSpan: 'service dates unrecorded',
    photoCandidate: null,
    rowCount: 1,
  });
  assert.equal(container.querySelector('.profile-chamber').textContent, 'MO Senate, district 2');
});
