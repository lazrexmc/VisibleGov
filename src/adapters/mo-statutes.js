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

// Minor finding 2: &amp; MUST decode last. Decoding it first turns a literal "&amp;lt;" in the
// source (i.e. the two visible characters "&lt;") into "&lt;" after the &amp; pass, which the
// &lt; pass below would then ALSO decode, double-decoding it into a bare "<" — text that was
// never actually a real HTML tag delimiter in the original page. Every other named/numeric
// entity is safe to decode before &amp; since none of their OUTPUTS collide with another
// entity's pattern; only &amp; -> "&" produces new text that a later replace in this same chain
// would re-interpret. (uscode.js's stripStatuteHtml has this same ordering issue — out of scope
// per this fix's brief; left untouched there.)
function stripMoHtml(raw) {
  return raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&sect;/gi, 'section ')
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '—')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/&amp;/gi, '&')
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

// Slices html between two literal markers. THROWS MoPageIdentityError when either marker is
// absent (controller ruling on Task 3's review) — silently falling back to slicing from index 0
// or end-of-document would hand navigation boilerplate to the glosser if revisor.mo.gov's
// template ever drifts. The response-identity check upstream (section/chapter number present)
// catches a wrong or generic page; this catches the narrower case where the RIGHT page's layout
// no longer matches the markers we derived from the captured fixtures.
function isolateBetween(html, startMarker, endMarker, meta = {}) {
  const s = html.indexOf(startMarker);
  if (s === -1) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response is missing its expected body-start marker for ${meta.section ? `section ${meta.section}` : `chapter ${meta.chapter}`} — refusing to extract`,
      meta,
    );
  }
  const startIdx = s + startMarker.length;
  const e = html.indexOf(endMarker, startIdx);
  if (e === -1) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response is missing its expected body-end marker for ${meta.section ? `section ${meta.section}` : `chapter ${meta.chapter}`} — refusing to extract`,
      meta,
    );
  }
  return html.slice(startIdx, e);
}

// Throws MoPageIdentityError when the isolated+stripped excerpt is the empty string (Important
// finding 1a). Empirically: revisor.mo.gov's chapter-page layout div markers are site-wide
// template chrome present on OTHER page types too (verified: they bracket zero content on a
// section page), so isolateBetween can succeed — both markers found — while the slice between
// them carries nothing. An empty-but-200 response must never flow silently into a gloss author
// as source text (same posture as uscode.js's extractSubsectionText empty-slice guard, ~:221-226).
// Deliberately its own check ahead of the marker-presence regex below: an empty string trivially
// fails that regex too, but this gives the honest, specific diagnosis ("empty slice" vs "slice
// present but wrong page") instead of collapsing both into one generic message.
function assertNotEmptyExcerpt(text, meta) {
  if (text.length === 0) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response isolated an EMPTY excerpt for ${meta.section ? `section ${meta.section}` : `chapter ${meta.chapter}`} — the page is not what was asked for, or the template drifted`,
      meta,
    );
  }
}

// extractMoSectionText(html, {section, url}) -> plain text. Order per spec §5 (Important finding
// 1b/1c restructuring): bot check -> isolate -> strip -> empty-excerpt guard -> response-identity
// check (now run on the ISOLATED, stripped slice, not the whole raw page) -> size gate. Never
// truncates; throws OversizeExcerptError instead (same discipline as uscode.js's
// extractSectionText).
export function extractMoSectionText(html, meta = {}) {
  assertNotBotPage(html, meta);
  // Body isolation: derived from the REAL fixture (Task 1) — slice from the section-number
  // heading to the page's own end-of-content boundary, then strip. Keeps the effective-date line.
  const text = stripMoHtml(isolateBetween(html, MO_SECTION_BODY_START, MO_SECTION_BODY_END, meta));
  assertNotEmptyExcerpt(text, meta);
  // Response-identity (spec §5): the ISOLATED SLICE must print the requested section's own number
  // marker before ANY text is trusted — a wrong or generic page must never become a gloss source.
  // Checking the slice (not the whole page, per finding 1c) matters because the whole page also
  // carries nav/history-table/cross-reference chrome that can mention other section numbers.
  const escaped = meta.section.replace(/\./g, '\\.');
  if (!new RegExp(`\\b${escaped}\\.?\\s`).test(text)) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response does not carry section ${meta.section}'s own marker — refusing to extract`,
      meta,
    );
  }
  if (text.length > MAX_EXCERPT_CHARS) {
    throw new OversizeExcerptError(
      `excerpt for RSMo ${meta.section} is ${text.length} chars, exceeds MAX_EXCERPT_CHARS=${MAX_EXCERPT_CHARS}; will not truncate silently`,
      { ...meta, length: text.length },
    );
  }
  return text;
}

// extractMoChapterText(html, {chapter, url}) -> plain text. Same order as extractMoSectionText.
// Important finding 1b: the identity check now requires `\bChapter\s+<N>\b` in the ISOLATED
// slice's stripped text — verified present in the real chapter-536 fixture's slice, which opens
// with the literal heading "Chapter 536 Administrative Procedure and Review". The old whole-page
// dotted-number alternative (`\b<chapter>\.\d{3}`) is DROPPED: it was satisfied by any same-
// chapter SECTION page (536.010's own page contains "536.010" — a false identity pass) and even
// by bot-page boilerplate for single-digit chapters ("3.090" on the bot page satisfies chapter
// '3'). The bot page carries no "Chapter <digit>" text at all, so the surviving check alone still
// refuses it — though assertNotBotPage below already short-circuits that case unconditionally
// first regardless.
export function extractMoChapterText(html, meta = {}) {
  assertNotBotPage(html, meta);
  const text = stripMoHtml(isolateBetween(html, MO_CHAPTER_BODY_START, MO_CHAPTER_BODY_END, meta));
  assertNotEmptyExcerpt(text, meta);
  if (!new RegExp(`\\bChapter\\s+${meta.chapter}\\b`, 'i').test(text)) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response does not carry chapter ${meta.chapter}'s own marker — refusing to extract`,
      meta,
    );
  }
  if (text.length > MAX_EXCERPT_CHARS) {
    throw new OversizeExcerptError(
      `excerpt for RSMo chapter ${meta.chapter} is ${text.length} chars, exceeds MAX_EXCERPT_CHARS=${MAX_EXCERPT_CHARS}; will not truncate silently`,
      { ...meta, length: text.length },
    );
  }
  return text;
}

// ---- fetch wrappers (Task 4) ----
//
// Thin — structurally reviewed, not integration-tested (the codebase convention for fetch*
// wrappers, per uscode.js's own comment; the URL builders ARE unit-tested above, and the pure
// extraction functions underneath these carry the real test weight).
export function buildMoSectionUrl(section) {
  return `https://revisor.mo.gov/main/OneSection.aspx?section=${section}`;
}
export function buildMoChapterUrl(chapter) {
  return `https://revisor.mo.gov/main/OneChapter.aspx?chapter=${chapter}`;
}
export async function fetchMoSection(section, limiter = moStatutesLimiter) {
  const url = buildMoSectionUrl(section);
  const html = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
  return { url, excerptText: extractMoSectionText(html, { section, url }) };
}
export async function fetchMoChapter(chapter, limiter = moStatutesLimiter) {
  const url = buildMoChapterUrl(chapter);
  const html = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
  return { url, excerptText: extractMoChapterText(html, { chapter, url }) };
}
