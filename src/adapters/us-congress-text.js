import { createHash } from 'node:crypto';
import { fetchWithLimit } from '../lib/http.js';
import { congressLimiter, SOURCE } from './us-congress.js';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function parseTextVersions(json) {
  return (json.textVersions ?? []).map((v) => ({
    version_type: v.type ?? 'unknown',
    date: v.date ?? null,
    formats: (v.formats ?? []).map((f) => ({ type: f.type, url: f.url })),
  }));
}

export function pickTextUrl(versions) {
  for (const v of versions) {
    const fmt = v.formats.find((f) => /formatted text/i.test(f.type)) ?? v.formats.find((f) => /formatted xml/i.test(f.type));
    if (fmt) return { version_type: v.version_type, url: fmt.url };
  }
  throw new Error('no fetchable text format in text versions');
}

export function stripHtml(htm) {
  return htm
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
    // GPO's bulk-text render embeds its own <DOC>/</DOC> document-boundary marker as literal
    // text, HTML-escaped (&lt;DOC&gt;) in the source so it survives the tag strip above. Decoding
    // entities exposes it as a bracketed token again, so run one more defensive tag-shaped strip
    // after decoding. Deviation from the task brief's reference stripHtml, found via the real
    // captured fixture (not present in synthetic test HTML).
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// Congress.gov's text-index endpoint requires the API key (sent via header, never in the URL —
// see src/adapters/us-congress.js). The actual bill-text document (.htm/.xml) lives on
// www.congress.gov and needs NO key — do not send one there.
export function fetchBillTextVersions(congress, typeSlug, number) {
  const url = `https://api.congress.gov/v3/bill/${congress}/${typeSlug}/${number}/text`;
  return fetchWithLimit(url, { source: SOURCE, limiter: congressLimiter, headers: { 'X-Api-Key': process.env.CONGRESS_API_KEY }, as: 'json' });
}

export function fetchTextBody(url) {
  return fetchWithLimit(url, { source: SOURCE, limiter: congressLimiter, as: 'text' });
}
