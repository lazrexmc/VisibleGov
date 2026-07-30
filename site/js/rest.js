// site/js/rest.js — anon Supabase REST client (browser-native ES module, no bundler).
//
// PostgREST's 1000-row cap is handled here, on day one, for every consumer (design spec §1,
// docs/superpowers/specs/2026-07-30-public-site-design.md):
// - pagedFetch() drives an explicit page/pageSize UI via Range header math.
// - fetchAllRows() loops 1000-row chunks until a short chunk — the browser's own selectAll.
// - countOnly() asks for the content-range total without needing a full page of rows.
//
// Config comes from ../config.js (Lance pastes the real URL/anon key — task 3 step 5, the LANCE
// GATE). Empty config is a fail-loud typed error, never a silent 401: an empty apikey header
// still reaches Supabase and comes back 401, which looks identical to "the anon policy denies
// this" — ConfigError removes that ambiguity before any request is even sent.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Fix round 1 (task-6 controller live smoke, LOAD-BEARING): a non-2xx response used to fall
// through doFetch's array-or-empty fallback silently, turning a real server failure (the live
// case: a Postgres statement timeout, PostgREST 500) into what every caller saw as a genuine
// zero-row result — a page-level loader checking `rows.length === 0` then rendered the
// honestly-empty state for what was actually a FAILED fetch, exactly the violation the plan
// forbids. Every read in this module goes through doFetch (the one shared primitive), so the fix
// lives there: any non-2xx throws this typed error before any caller ever sees a rows array.
export class RestError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'RestError';
    Object.assign(this, meta); // status, body
  }
}

// ---- test-only hooks (see tests/site-modules.test.js) ----
// Never called by the shipped site: in a real browser getFetch() falls through to the global
// fetch and getConfig() falls through to the config.js import. Plain module-level mutable state
// (not a class) is fine here — this module has exactly one live instance per browser tab, no
// concurrency to protect against.
let fetchOverride = null;
export function _setFetch(fn) { fetchOverride = fn; }
let configOverride = null;
export function _setConfig(cfg) { configOverride = cfg; }

function getFetch() {
  return fetchOverride || (typeof fetch === 'function' ? fetch : undefined);
}

function getConfig() {
  const url = configOverride ? configOverride.url : SUPABASE_URL;
  const anonKey = configOverride ? configOverride.anonKey : SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new ConfigError(
      'SUPABASE_URL/SUPABASE_ANON_KEY are empty — paste the real values into site/config.js '
        + '(the LANCE GATE, task 3 step 5) before any page can read the database.',
    );
  }
  return { url, anonKey };
}

function parseContentRangeTotal(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('content-range') : null;
  if (!raw) return null;
  const total = raw.split('/')[1];
  if (total === undefined || total === '*') return null;
  return Number(total);
}

function buildUrl(path) {
  const { url } = getConfig();
  const base = url.endsWith('/') ? url.slice(0, -1) : url;
  const rel = path.startsWith('/') ? path.slice(1) : path;
  return `${base}/rest/v1/${rel}`;
}

function appendQueryParam(path, key, value) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${key}=${value}`;
}

// The one shared primitive every exported function below builds on. Requests count=exact BY
// DEFAULT — restGet's contract ("total from content-range when count=exact requested") is
// describing this: every read through this module asks for the count, since pagedFetch/
// countOnly always need it and the cost is normally just one response header.
//
// N2-LOW(a) (task 6b review, fix round 3): `noCount` opts OUT of that default — a real cost, not
// just a header, on a `limit=1` existence-style probe (Postgres must otherwise compute an exact
// total match count even though the caller only ever checks `rows.length > 0`). Default
// unchanged (`noCount` falsy/omitted behaves exactly as before) — this is additive, not a
// behavior change for any existing caller.
async function doFetch(path, { range, noCount } = {}) {
  const { anonKey } = getConfig();
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };
  if (!noCount) headers.Prefer = 'count=exact';
  if (range) {
    headers['Range-Unit'] = 'items';
    headers.Range = `${range[0]}-${range[1]}`;
  }
  const doRequest = getFetch();
  const res = await doRequest(buildUrl(path), { headers });
  if (!res.ok) {
    // PostgREST error bodies are an object ({code, message, details, hint}), not an array — when
    // present, its message rides along on the thrown error; a non-JSON/unparseable body (e.g. a
    // proxy's plain-text 502 page) still throws with the status alone, never silently.
    const body = await res.json().catch(() => null);
    const detail = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : null;
    throw new RestError(
      detail ? `Supabase REST ${res.status}: ${detail}` : `Supabase REST request failed with status ${res.status}`,
      { status: res.status, body },
    );
  }
  const rows = await res.json().catch(() => []);
  return {
    status: res.status,
    rows: Array.isArray(rows) ? rows : [],
    total: parseContentRangeTotal(res.headers),
  };
}

export async function restGet(path, { noCount } = {}) {
  return doFetch(path, { noCount });
}

export async function pagedFetch(pathWithFilters, { page = 1, pageSize = 50, order } = {}) {
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;
  const path = order ? appendQueryParam(pathWithFilters, 'order', order) : pathWithFilters;
  const { rows, total } = await doFetch(path, { range: [start, end] });
  return {
    rows, total, page, pageSize,
  };
}

const CHUNK_SIZE = 1000;

// FINAL REVIEW, finding 5: this is the browser's selectAll (src/lib/db.js), and it had dropped
// both of that function's load-bearing safety properties. Restored here, for the same reasons its
// own comment gives:
//
//   ORDER. "Pagination via .range() is only correct with a DETERMINISTIC order — without one,
//   Postgres makes no promise that two separate .range() calls see the same row ordering, which
//   could silently drop a row into the gap between two pages or return it twice." selectAll
//   appends an `id` tiebreaker unconditionally because every table it touches has a uuid `id`;
//   this function is also used against MATERIALIZED VIEWS, which have no `id`, so the caller
//   passes the order instead — their own unique-index column set (migration 0018 defines one per
//   matview, exactly so CONCURRENTLY refresh works; the same columns are what makes a row
//   uniquely orderable here). Every call site now passes one.
//
//   BACKSTOP. selectAll "throws rather than returning a result that LOOKS complete but might not
//   be." The equivalent here is the content-range total the server already sends back on every
//   chunk (doFetch requests count=exact by default): if what we accumulated is not what the server
//   says exists, a row was dropped into — or duplicated across — a page gap, and the ONLY safe
//   thing is to fail. Silently returning 1,400 of 1,500 legislators to matchReps means telling
//   somebody the wrong answer about who represents them. A server that reports no total at all
//   (`*` or an absent header) leaves nothing to cross-check against, and is never turned into a
//   fabricated failure.
export async function fetchAllRows(pathWithFilters, { order } = {}) {
  const path = order ? appendQueryParam(pathWithFilters, 'order', order) : pathWithFilters;
  const all = [];
  let start = 0;
  let statedTotal = null;
  for (;;) {
    // Exhaustive pagination is inherently sequential — each chunk's short-read decides whether
    // there is a next chunk at all.
    // eslint-disable-next-line no-await-in-loop
    const { rows, total } = await doFetch(path, { range: [start, start + CHUNK_SIZE - 1] });
    if (typeof total === 'number' && Number.isFinite(total)) statedTotal = total;
    all.push(...rows);
    if (rows.length < CHUNK_SIZE) break;
    start += CHUNK_SIZE;
  }
  if (statedTotal !== null && all.length !== statedTotal) {
    throw new RestError(
      `fetchAllRows: read ${all.length} of ${statedTotal} rows the server reports for this query — `
        + 'a row was dropped into or duplicated across a chunk boundary. Refusing to return a '
        + 'result that would render as complete.',
      { expected: statedTotal, received: all.length, path },
    );
  }
  return all;
}

export async function countOnly(pathWithFilters) {
  const { total } = await doFetch(pathWithFilters, { range: [0, 0] });
  return total ?? 0;
}
