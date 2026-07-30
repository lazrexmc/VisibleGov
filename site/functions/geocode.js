// site/functions/geocode.js — Cloudflare Pages Function: /geocode?address=... — a no-logging
// pass-through to the Census Geocoder (their API sends no CORS headers, so the browser cannot
// call it directly).
//
// PRIVACY CONTRACT (spec §5, review-blocking): the address is forwarded to the Census request and
// NOWHERE else. No console.log, no analytics, no KV, no cache writes, no error reporting that
// includes the address. Errors return generic JSON. This property is enforced by inspection here:
// nothing in this file writes anywhere except the single outbound `fetch` to Census and the
// `Response.json` handed back to the caller.
//
// Based verbatim on task-8-brief.md's own code, with two changes, both noted here (and in the
// task-8 report) rather than silently: (1) `buildUpstreamUrl` is factored out as its own exported
// pure function so scripts/serve-site.js's local-dev `/geocode` passthrough can share the EXACT
// same upstream-URL construction — one copy, not a lookalike second one. (2) `vintage` is
// `Current_Current`, not the brief's `Current` — verified live against the real Census Geocoder
// (tests/districts.test.js's own header comment has the full trace): `vintage=Current` gets a 400
// "Invalid vintage in request" on every real call (confirmed via
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

export async function onRequestGet({ request }) {
  const address = new URL(request.url).searchParams.get('address');
  if (!address || address.length > 500) {
    return Response.json({ error: 'address required' }, { status: 400 });
  }
  const u = buildUpstreamUrl(address);
  try {
    const upstream = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return Response.json({ error: 'geocoder unavailable' }, { status: 502 });
    return Response.json(await upstream.json());
  } catch {
    return Response.json({ error: 'geocoder unavailable' }, { status: 502 });
  }
}
