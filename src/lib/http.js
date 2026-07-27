import { SourceFetchError, RateLimitedError } from './errors.js';

// Skip ≠ empty: every failure path here THROWS. No caller may map a catch to [].
export async function fetchWithLimit(url, { source, limiter, headers = {}, as = 'json' }) {
  await limiter.take();
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (cause) {
    throw new SourceFetchError(`network failure fetching ${url}`, { source, url, cause });
  }
  if (res.status === 429) {
    throw new RateLimitedError(`rate limited by ${source}`, { source, url, status: 429 });
  }
  if (!res.ok) {
    throw new SourceFetchError(`HTTP ${res.status} from ${source}: ${url}`, { source, url, status: res.status });
  }
  return as === 'json' ? res.json() : res.text();
}
