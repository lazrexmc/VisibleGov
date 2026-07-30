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

// PRIVACY CONTRACT (spec §5, review-blocking — identical to site/functions/geocode.js's own):
// the address is forwarded to the Census request and NOWHERE else. No console.log, no analytics,
// no file writes, no error reporting that includes the address. Errors return generic JSON.
async function handleGeocodeRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${HOST}`);
  const address = parsedUrl.searchParams.get('address');
  const respond = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (!address || address.length > 500) {
    respond(400, { error: 'address required' });
    return;
  }
  const u = buildUpstreamUrl(address);
  try {
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
    const urlPath = String(req.url || '').split('?')[0];
    if (urlPath === '/geocode') {
      await handleGeocodeRequest(req, res);
      return;
    }
    let filePath;
    try {
      filePath = resolveSitePath(siteRoot, req.url);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad request');
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': contentTypeFor(filePath) });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
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
