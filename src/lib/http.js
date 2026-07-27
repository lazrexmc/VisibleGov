import { SourceFetchError, RateLimitedError } from './errors.js';

// Defense-in-depth (PLAYBOOK): secrets must never be able to persist via a caught error even if
// an adapter mistakenly puts a key in a query string. Redacts api_key/apikey/key query values.
export function redactUrl(url) {
  return String(url).replace(/([?&](?:api_?key|key)=)[^&]+/gi, '$1REDACTED');
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
  return as === 'json' ? res.json() : res.text();
}
