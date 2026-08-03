import { SourceFetchError, RateLimitedError } from './errors.js';

// Defense-in-depth (PLAYBOOK): secrets must never be able to persist via a caught error even if
// an adapter mistakenly puts a key in a query string. Redacts api_key/apikey/key query values.
//
// access_key added 2026-07-28 (Task 3 of the LegiScan bulk adapter plan, ruling 2,
// .superpowers/sdd/2026-07-29-legiscan-bulk-adapter/task-3-brief.md): LegiScan's getDataset takes
// a per-session access_key (from getDatasetList) as a query param. The T2 reviewer verified BY
// CONSTRUCTION that the prior `(?:api_?key|key)` alternation does not match `access_key=` — the
// char immediately before "key" in "access_key" is `_` from "access_", not the `[?&]` this regex
// requires directly before "key". That was a real redaction gap for a real credential-shaped
// query param, closed here before any live getDataset call was made.
export function redactUrl(url) {
  return String(url).replace(/([?&](?:access_key|api_?key|key)=)[^&]+/gi, '$1REDACTED');
}

// Skip ≠ empty: every failure path here THROWS. No caller may map a catch to [].
export async function fetchWithLimit(url, { source, limiter, headers = {}, as = 'json' }) {
  await limiter.take();
  const safeUrl = redactUrl(url);
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (cause) {
    throw new SourceFetchError(`network failure fetching ${safeUrl}`, { source, url: safeUrl, cause });
  }
  if (res.status === 429) {
    throw new RateLimitedError(`rate limited by ${source}`, { source, url: safeUrl, status: 429 });
  }
  if (!res.ok) {
    throw new SourceFetchError(`HTTP ${res.status} from ${source}: ${safeUrl}`, { source, url: safeUrl, status: res.status });
  }
  // Senior engineering audit (2026-08-03, finding 11): a 200-status response can still fail while
  // its BODY is being read — res.json() throws a raw SyntaxError on non-JSON content (a genuine
  // 200 with an unexpected body shape), and a connection reset mid-stream surfaces as a raw
  // `TypeError: terminated`, neither of which used to be wrapped. Every caller in this codebase
  // that specifically catches SourceFetchError (the near-universal "if (!(err instanceof
  // SourceFetchError)) throw err;" pattern) would NOT catch either shape — the raw error would
  // escape as an unclassified crash instead of the typed fetch failure every OTHER failure mode
  // above already produces. Every body-read call is caught here (was: only the connection itself,
  // lines 22-26) and rethrown as the SAME typed error, "skip != empty" still holding either way.
  try {
    if (as === 'json') return await res.json();
    if (as === 'arrayBuffer') return await res.arrayBuffer(); // binary (PDFs) - added for mo-rollcall-pdf.js
    return await res.text();
  } catch (cause) {
    throw new SourceFetchError(`failed reading response body (as=${as}) from ${source}: ${safeUrl}`, { source, url: safeUrl, status: res.status, cause });
  }
}
