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

// The one shared primitive every exported function below builds on. Always requests
// count=exact — restGet's contract ("total from content-range when count=exact requested") is
// describing this: every read through this module asks for the count, since pagedFetch/
// countOnly always need it and the cost is one response header.
async function doFetch(path, { range } = {}) {
  const { anonKey } = getConfig();
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    Prefer: 'count=exact',
  };
  if (range) {
    headers['Range-Unit'] = 'items';
    headers.Range = `${range[0]}-${range[1]}`;
  }
  const doRequest = getFetch();
  const res = await doRequest(buildUrl(path), { headers });
  const rows = await res.json().catch(() => []);
  return {
    status: res.status,
    rows: Array.isArray(rows) ? rows : [],
    total: parseContentRangeTotal(res.headers),
  };
}

export async function restGet(path) {
  return doFetch(path);
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

export async function fetchAllRows(pathWithFilters) {
  const all = [];
  let start = 0;
  for (;;) {
    // Exhaustive pagination is inherently sequential — each chunk's short-read decides whether
    // there is a next chunk at all.
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await doFetch(pathWithFilters, { range: [start, start + CHUNK_SIZE - 1] });
    all.push(...rows);
    if (rows.length < CHUNK_SIZE) break;
    start += CHUNK_SIZE;
  }
  return all;
}

export async function countOnly(pathWithFilters) {
  const { total } = await doFetch(pathWithFilters, { range: [0, 0] });
  return total ?? 0;
}
