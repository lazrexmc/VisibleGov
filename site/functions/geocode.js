// site/functions/geocode.js — Cloudflare Pages Function: POST /geocode — a no-logging
// pass-through to the Census Geocoder (their API sends no CORS headers, so the browser cannot
// call it directly).
//
// PRIVACY CONTRACT (spec §5, review-blocking): the address is forwarded to the Census request and
// NOWHERE else. No console.log, no analytics, no KV, no cache writes, no error reporting that
// includes the address. Errors return generic JSON. This property is enforced by inspection here:
// nothing in this file writes anywhere except the single outbound `fetch` to Census and the
// `Response.json` handed back to the caller.
//
// Fix round 1 (task-8 review, CONTROLLER RULING — was "design call for Lance," ruled toward the
// STRONGER privacy reading, strengthening the contract sentence rather than relaxing it): this is
// now POST with the address in a JSON body, not GET with it on the query string. Cloudflare
// records ClientRequestURI (including query strings) in its own edge logs regardless of anything
// this function does — a GET with `?address=...` would put a (partial) home address on OUR
// origin's own request-line logging surface even though this function itself never reads or
// writes them. POST's body is not part of that request-line surface. The outbound request to the
// Census Geocoder is UNCHANGED (still GET, still address-on-querystring) — that half is the
// geocoder's own API design, not ours to change, and is exactly what the privacy contract sentence
// on the page discloses ("sent to the U.S. Census Bureau geocoder").
//
// Based on task-8-brief.md's own draft code, with these differences (each noted here and in the
// task-8 report rather than silently): (1) POST/JSON body per the ruling above. (2)
// `buildUpstreamUrl` is factored out as its own exported pure function so scripts/serve-site.js's
// local-dev `/geocode` passthrough can share the EXACT same upstream-URL construction — one copy,
// not a lookalike second one. (3) `vintage` is `Current_Current`, not the brief's `Current` —
// verified live against the real Census Geocoder (tests/districts.test.js's own header comment has
// the full trace): `vintage=Current` gets a 400 "Invalid vintage in request" on every real call
// (confirmed via
// https://geocoding.geo.census.gov/geocoder/vintages?benchmark=Public_AR_Current&format=json,
// which lists `Current_Current` as the one paired with benchmark `Public_AR_Current`) — the
// brief's verbatim value would have shipped a function that always fails.
export function buildUpstreamUrl(address) {
  const u = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
  u.searchParams.set('address', address);
  u.searchParams.set('benchmark', 'Public_AR_Current');
  u.searchParams.set('vintage', 'Current_Current');
  u.searchParams.set('format', 'json');
  return u;
}

export async function onRequestPost({ request }) {
  let address;
  try {
    const body = await request.json();
    address = body?.address;
  } catch {
    return Response.json({ error: 'address required' }, { status: 400 });
  }
  if (typeof address !== 'string' || !address || address.length > 500) {
    return Response.json({ error: 'address required' }, { status: 400 });
  }
  // LOW-12 (task-8 review): the try opens one line earlier than before, so buildUpstreamUrl
  // itself (a defensive-only concern — `new URL(...)`/searchParams never throw on a plain string
  // today) is covered by the SAME honest-502 handling as the network call, rather than being able
  // to throw uncaught out of this handler on some future edge case.
  try {
    const u = buildUpstreamUrl(address);
    const upstream = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return Response.json({ error: 'geocoder unavailable' }, { status: 502 });
    return Response.json(await upstream.json());
  } catch {
    return Response.json({ error: 'geocoder unavailable' }, { status: 502 });
  }
}
