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
    // GPO's bulk-text render embeds its own <DOC>/</DOC> document-boundary marker as literal
    // text, HTML-escaped (&lt;DOC&gt;) in the source, so it survives the tag-strip pass above.
    // Strip that literal token narrowly, BEFORE general entity decoding. Do NOT run an
    // unrestricted `.replace(/<[^>]+>/g, ' ')` pass after decoding: real bill text can contain
    // decoded '<'/'>' comparison operators (e.g. "the amount is < 100"), and an unrestricted
    // bracket-strip there would treat everything between two such operators as a tag and
    // silently swallow it — confirmed regression: 'the amount is &lt; 100 and separately the
    // other value is &gt; 50' collapsed to 'the amount is 50'.
    .replace(/&lt;\/?DOC&gt;/gi, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
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
