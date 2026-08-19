// Missouri Revised Statutes (revisor.mo.gov) adapter — spec:
// docs/superpowers/specs/2026-08-19-mo-statute-glossary-source-design.md
// BINDING ACCESS CONSTRAINTS in spec §4: sequential, >=5s spacing, gloss-time fetches only,
// bot page = typed hard stop. Read the spec before changing any fetch behavior.
import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';
import { OversizeExcerptError, MAX_EXCERPT_CHARS, sha256 } from './uscode.js';

export { sha256 };
export const SOURCE = 'mo-statutes';

// Their bot page (captured 2026-08-19) states the enforced threshold: accesses tracked over 30s
// windows, faster than 1s repeatedly -> blocked, cumulative per-IP tracking. 5s = 5x inside it.
export const moStatutesLimiter = createLimiter({ minIntervalMs: 5000 });

// A federal marker anywhere means this can never be an RSMo cite — refuse outright so the MO
// parser can never claim a federal citation (spec §3).
const FEDERAL_MARKER_RE = /U\.?\s*S\.?\s*C\.?|C\.?F\.?R\.?|public law|united states code|\bstat\.|P\.L\./i;
// Ranges and lists have no single official text (spec §3) — belt over the anchored regexes below.
const MULTI_RE = /\b(?:to|through|and)\b/i;
// RSMo's dotted \d{1,3}\.\d{3,4} section shape is its signature; USC sections are never dotted.
// A trailing subdivision (".2", "(1)") parses but normalizes to the parent section (spec §3).
const MO_SECTION_RE = /^(?:RSMo\.?\s+)?(?:§+\s*)?(?:sections?\s+)?(\d{1,3}\.\d{3,4})(?:\.\d+)?(?:\([\w()]+\))?(?:,?\s*RSMo\.?)?$/i;
const MO_CHAPTER_RE = /^(?:RSMo\.?\s+)?chapter\s+(\d{1,3})(?:,?\s*RSMo\.?)?$/i;

export function parseMoCitation(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const t = raw.trim();
  if (FEDERAL_MARKER_RE.test(t) || MULTI_RE.test(t)) return null;
  const sec = t.match(MO_SECTION_RE);
  if (sec) return { kind: 'section', section: sec[1] };
  const ch = t.match(MO_CHAPTER_RE);
  if (ch) return { kind: 'chapter', chapter: ch[1] };
  return null;
}

export function normalizeMoCitation(parsed) {
  return parsed.kind === 'chapter' ? `RSMo chapter ${parsed.chapter}` : `RSMo ${parsed.section}`;
}

export function isMoCitation(citation) {
  return typeof citation === 'string' && citation.startsWith('RSMo ');
}

// ---- extraction (Task 3) ----
//
// Verbatim fixed text from their bot-detection page (captured 2026-08-19, Task 1 fixture,
// tests/fixtures/mo-statutes/bot-page.html). A nonexistent section 302-redirects HERE with HTTP
// 200 — same class as uscode.js's docnotfound finding. This text must be checked BEFORE anything
// else is trusted.
const MO_BOT_PAGE_MARKER = 'Are you double clicking links?';

export class MoBotPageError extends Error {
  constructor(message, meta = {}) { super(message); this.name = 'MoBotPageError'; Object.assign(this, meta); }
}
export class MoPageIdentityError extends Error {
  constructor(message, meta = {}) { super(message); this.name = 'MoPageIdentityError'; Object.assign(this, meta); }
}

function stripMoHtml(raw) {
  return raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&sect;/gi, 'section ')
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '—')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function assertNotBotPage(html, meta) {
  if (html.includes(MO_BOT_PAGE_MARKER)) {
    throw new MoBotPageError(
      'revisor.mo.gov returned its bot-detection page — nonexistent citation OR rate limiting. '
      + 'HARD STOP per spec §4: do not retry; if this recurs on valid citations, slow down further.',
      meta,
    );
  }
}

// Body isolation, derived from the REAL fixtures (Task 1), not guessed. revisor.mo.gov has no
// OLRC-style field-start/field-end comments; its equivalent stable container is this styled div —
// verified byte-identical in BOTH captured section pages (normal 536.010 AND repealed 1.022):
// it opens right after the title/chapter/prev-next-arrows header and closes immediately before
// the "---- end of effective ---- / use this link to bookmark" footer div. Slicing here excludes
// the top search form, the "All versions" historical-versions table, and the facebook/twitter
// share icons — none of which live between these two markers in either fixture.
const MO_SECTION_BODY_START = '<div class="norm" title="" style="background-color:#fffff7;padding-left:.75%;padding-right:.75%;">';
const MO_SECTION_BODY_END = '<hr><div style="padding:.2em 0em 0em 2em;">';

// Same approach for chapter pages: the real fixture (chapter-536.html) shows the chapter's title,
// full section-list table, and "Cross References" table all live inside this two-thirds-width
// column div, which closes immediately before the ad/widget sidebar div. Excludes the top search
// form and the page-wide nav/footer chrome (site links, social icons) that sit outside it.
const MO_CHAPTER_BODY_START = '<div class="lr-fl-s-all lr-fl-m-7-10 lr-fl-l-4-5">';
const MO_CHAPTER_BODY_END = '<div class="lr-fl-s-all lr-fl-m-3-10 lr-fl-l-1-5">';

// Slices html between two literal markers. Falls back to the start/end of the string when a
// marker is missing (never throws here) — the response-identity check upstream is what refuses a
// wrong/absent page; this just keeps slicing defensive rather than producing a garbage negative
// range if the page's own layout ever shifts.
function isolateBetween(html, startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  const startIdx = s === -1 ? 0 : s + startMarker.length;
  const e = html.indexOf(endMarker, startIdx);
  const endIdx = e === -1 ? html.length : e;
  return html.slice(startIdx, endIdx);
}

// extractMoSectionText(html, {section, url}) -> plain text. Order per spec §5: bot check ->
// response-identity check -> isolate -> strip -> size gate. Never truncates; throws
// OversizeExcerptError instead (same discipline as uscode.js's extractSectionText).
export function extractMoSectionText(html, meta = {}) {
  assertNotBotPage(html, meta);
  // Response-identity (spec §5): the page must print the requested section's own number
  // marker before ANY text is trusted — a wrong or generic page must never become a gloss source.
  const escaped = meta.section.replace(/\./g, '\\.');
  if (!new RegExp(`\\b${escaped}\\.?\\s`).test(html.replace(/<[^>]+>/g, ' '))) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response does not carry section ${meta.section}'s own marker — refusing to extract`,
      meta,
    );
  }
  // Body isolation: derived from the REAL fixture (Task 1) — slice from the section-number
  // heading to the page's own end-of-content boundary, then strip. Keeps the effective-date line.
  const text = stripMoHtml(isolateBetween(html, MO_SECTION_BODY_START, MO_SECTION_BODY_END));
  if (text.length > MAX_EXCERPT_CHARS) {
    throw new OversizeExcerptError(
      `excerpt for RSMo ${meta.section} is ${text.length} chars, exceeds MAX_EXCERPT_CHARS=${MAX_EXCERPT_CHARS}; will not truncate silently`,
      { ...meta, length: text.length },
    );
  }
  return text;
}

// extractMoChapterText(html, {chapter, url}) -> plain text. Same order as extractMoSectionText.
export function extractMoChapterText(html, meta = {}) {
  assertNotBotPage(html, meta);
  const stripped = html.replace(/<[^>]+>/g, ' ');
  if (!new RegExp(`\\bChapter\\s+${meta.chapter}\\b`, 'i').test(stripped)
      && !new RegExp(`\\b${meta.chapter}\\.\\d{3}`).test(stripped)) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response does not carry chapter ${meta.chapter}'s own marker — refusing to extract`,
      meta,
    );
  }
  const text = stripMoHtml(isolateBetween(html, MO_CHAPTER_BODY_START, MO_CHAPTER_BODY_END));
  if (text.length > MAX_EXCERPT_CHARS) {
    throw new OversizeExcerptError(
      `excerpt for RSMo chapter ${meta.chapter} is ${text.length} chars, exceeds MAX_EXCERPT_CHARS=${MAX_EXCERPT_CHARS}; will not truncate silently`,
      { ...meta, length: text.length },
    );
  }
  return text;
}
