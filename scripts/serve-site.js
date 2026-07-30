// scripts/serve-site.js — zero-dep local static server for site/ (dev-only mirror of Cloudflare
// Pages: same site/_redirects rewrites, no build step, no npm packages). Never used in
// production — Cloudflare Pages serves site/ directly from the repo (Task 7).
//
// Task 8 addition: a `/geocode` passthrough mimicking site/functions/geocode.js's Pages Function
// so address lookup works under local dev too. Shares buildUpstreamUrl — the ONE piece of that
// function's logic that both runtimes need identically — imported straight from
// site/functions/geocode.js, never a second copy. The surrounding request/response glue differs
// on purpose: this runtime is Node's http req/res, the Pages Function's is the Fetch API
// Request/Response the Cloudflare edge runtime provides; the SAME privacy contract applies
// either way (no logging of the address, ever — see this passthrough's own body below).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUpstreamUrl } from '../site/functions/geocode.js';

export const PORT = 8990;
export const HOST = '127.0.0.1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SITE_ROOT = path.resolve(__dirname, '../site');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ---- site/_headers (the production CSP), parsed and mirrored here ----
//
// Final-review fix wave, finding 1 (defense in depth). Cloudflare Pages serves site/_headers in
// production; this dev server PARSES THAT SAME FILE rather than carrying a hand-copied second
// set of header values, so the two can never drift (the failure mode a lookalike copy invites:
// tightening the real CSP, finding the page broken only after deploy, because dev was still
// serving the old permissive one — or the reverse, dev refusing what production allows).
//
// Deliberately a MINIMAL parser for the one shape this file actually uses: an unindented rule
// path line, then indented `Name: value` lines, `#` comments and blank lines ignored. Cloudflare's
// own format has more (placeholders, `! Name` removals) that this file does not use; a future
// _headers that needs them must extend this parser rather than let dev silently serve less.
export function parseHeadersFile(text) {
  const rules = {};
  let current = null;
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = line.trim();
      rules[current] = rules[current] || {};
      continue;
    }
    if (!current) continue; // an indented header line before any rule path — nothing to attach to
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    rules[current][line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return rules;
}

// The headers that apply to every path (`/*`). Read fresh per call — this is a dev server, and a
// stale cached copy after editing _headers would be its own small drift.
export function loadSiteHeaders(siteRoot = SITE_ROOT) {
  try {
    return parseHeadersFile(readFileSync(path.join(siteRoot, '_headers'), 'utf8'))['/*'] || {};
  } catch {
    // A missing _headers is a dev-only convenience gap, not a reason to refuse to serve the site;
    // production reads the file from the deployed output, where its absence would be visible as a
    // missing CSP on the real site (and is pinned by tests/site-modules.test.js either way).
    return {};
  }
}

export class PathTraversalError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PathTraversalError';
    Object.assign(this, meta);
  }
}

// Mirrors site/_redirects exactly (four lines, kept in sync by hand — low drift risk at this
// size). /trust is an EXACT match (no trailing /*); the other three rewrite anything under them.
export function applyRewrites(urlPath) {
  if (urlPath === '/trust') return '/trust.html';
  if (urlPath.startsWith('/person/')) return '/person.html';
  if (urlPath.startsWith('/legislator/')) return '/legislator.html';
  if (urlPath.startsWith('/bill/')) return '/bill.html';
  return urlPath;
}

// Pure path resolver, exported specifically so path-traversal rejection is testable without a
// live server (percent-encoded '..%2f' style inputs included — see tests/site-modules.test.js).
// The traversal check is delimiter-agnostic by construction: whatever the requested path
// decodes/normalizes to, the final resolved absolute path must sit inside siteRoot or this
// throws — a raw '..', a percent-encoded '%2e%2e', or (on Windows) a literal backslash all fail
// the same prefix check, since none of them change where the path ACTUALLY resolves to on disk.
export function resolveSitePath(siteRoot, requestUrl) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(requestUrl).split('?')[0]);
  } catch (cause) {
    throw new PathTraversalError(`unparseable request path: ${requestUrl}`, { requestUrl, cause });
  }
  const rewritten = applyRewrites(decoded);
  const relative = rewritten === '/' ? '/index.html' : rewritten;
  const resolved = path.resolve(siteRoot, `.${relative}`);
  const rootWithSep = siteRoot.endsWith(path.sep) ? siteRoot : siteRoot + path.sep;
  if (resolved !== siteRoot && !resolved.startsWith(rootWithSep)) {
    throw new PathTraversalError(`request path escapes the site root: ${requestUrl}`, { requestUrl, resolved });
  }
  return resolved;
}

// ---- test-only hook (see tests/site-modules.test.js) ----
// Never used by a real `node scripts/serve-site.js` run — the passthrough falls through to the
// global `fetch` unless a test overrides it. Same convention as site/js/rest.js's own _setFetch.
let geocodeFetchOverride = null;
export function _setGeocodeFetch(fn) { geocodeFetchOverride = fn; }
function getGeocodeFetch() {
  return geocodeFetchOverride || fetch;
}

// Reads and JSON-parses a request body. Never used for anything but the /geocode POST body below
// — the rest of this server only ever serves static files.
async function readJsonBody(req) {
  const chunks = [];
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// PRIVACY CONTRACT (spec §5, review-blocking — identical to site/functions/geocode.js's own):
// the address is forwarded to the Census request and NOWHERE else. No console.log, no analytics,
// no file writes, no error reporting that includes the address. Errors return generic JSON.
//
// Fix round 1 (task-8 review, CONTROLLER RULING): POST with a JSON body, mirroring
// site/functions/geocode.js's own onRequestPost exactly — the address never rides a GET request
// line (query string) to our own origin, where it would land in Cloudflare's own edge logging
// (ClientRequestURI) regardless of anything either passthrough does itself.
async function handleGeocodeRequest(req, res, securityHeaders = {}) {
  const respond = (status, body) => {
    res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  let address;
  try {
    const parsed = await readJsonBody(req);
    address = parsed?.address;
  } catch {
    respond(400, { error: 'address required' });
    return;
  }
  if (typeof address !== 'string' || !address || address.length > 500) {
    respond(400, { error: 'address required' });
    return;
  }
  // LOW-12 (task-8 review): the try opens one line earlier, covering buildUpstreamUrl itself
  // (defensive-only today) under the same honest-502 handling as the network call.
  try {
    const u = buildUpstreamUrl(address);
    const doFetch = getGeocodeFetch();
    const upstream = await doFetch(u, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) {
      respond(502, { error: 'geocoder unavailable' });
      return;
    }
    respond(200, await upstream.json());
  } catch {
    respond(502, { error: 'geocoder unavailable' });
  }
}

export function createSiteServer(siteRoot = SITE_ROOT) {
  return createServer(async (req, res) => {
    // Every response — 200, 404, 400, and the /geocode JSON below — carries the same security
    // headers Cloudflare Pages applies in production. An error page is still a page a browser
    // renders, so leaving them off the non-200 paths would mean the CSP is absent on exactly the
    // responses an attacker is most likely to be able to provoke.
    const securityHeaders = loadSiteHeaders(siteRoot);
    const urlPath = String(req.url || '').split('?')[0];
    if (urlPath === '/geocode' && req.method === 'POST') {
      await handleGeocodeRequest(req, res, securityHeaders);
      return;
    }
    let filePath;
    try {
      filePath = resolveSitePath(siteRoot, req.url);
    } catch {
      res.writeHead(400, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { ...securityHeaders, 'content-type': contentTypeFor(filePath) });
      res.end(body);
    } catch {
      res.writeHead(404, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  });
}

// Only start listening when run directly (`node scripts/serve-site.js`), never when imported by
// tests — same Windows-safe invokedDirectly pattern used by every src/cli/*.js entry point.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  const server = createSiteServer();
  server.listen(PORT, HOST, () => {
    console.log(`serving ${SITE_ROOT} at http://${HOST}:${PORT}`);
  });
}
