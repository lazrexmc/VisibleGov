import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';
import { sha256 } from './us-congress-text.js';

export { sha256 };

export const SOURCE = 'uscode';
// OLRC's uscode.house.gov is a public, no-auth site with no documented rate limit - 2s spacing
// is our own politeness choice (glossary plan Task 2 spec), same shape as us-congress.js's
// per-source limiters. Dedicated (not shared) because this adapter hits a different host.
export const uscodeLimiter = createLimiter({ minIntervalMs: 2000 });

// Larger than us-congress-text's MAX_TEXT_CHARS-for-bills is a different budget: this bounds a
// single US Code SECTION excerpt sent to the glosser (Task 5), not a whole bill. Real-world
// finding (captured 2026-07-28, see tests/fixtures/research/SOURCES.md #uscode): 42 U.S.C. 1396b
// itself - the very section this task's golden (HR 498) cites - is 169,882 chars of operative
// statute text alone, ALREADY over this cap before any historical notes are even considered.
// That is not a parsing bug; it is what the real, heavily-amended Medicaid section IS. Per house
// convention (OversizeTextError in summarizer.js) this throws loud rather than truncating -
// never silently hand the glosser a clipped excerpt that looks complete but isn't.
export const MAX_EXCERPT_CHARS = 100000;

export class OversizeExcerptError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'OversizeExcerptError';
    Object.assign(this, meta);
  }
}

// REAL FINDING (not a guess): an unparseable/nonexistent citation does NOT 404 - uscode.house.gov
// 302-redirects to /docnotfound.xhtml, which fetch()'s default redirect:'follow' resolves to a
// normal 200 "Document not Found" page (see tests/fixtures/uscode/section-not-found.xhtml,
// captured live 2026-07-28). fetchWithLimit's `!res.ok` check never fires for this case - the
// only reliable signal is the ABSENCE of the statute markers below. Never treat "200 with no
// statute field" as an empty-but-valid excerpt.
export class UscSectionNotFoundError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'UscSectionNotFoundError';
    Object.assign(this, meta);
  }
}

// ---- citation parsing ----
//
// Handles the 3 forms in the brief PLUS the real form found in this task's own golden fixture
// (tests/fixtures/us-congress/bill-text.htm, HR 498): "Section 1903(i) of the Social Security Act
// (42 U.S.C. 1396b(i))" - a popular-name reference wrapping a parenthetical USC cite with a
// trailing subsection letter. Matched anywhere in the raw string (not anchored), so an embedded
// USC cite is found even when it rides along with popular-name text; a trailing subsection
// (e.g. "(i)", "(a)(1)") is deliberately dropped - fetchUscSection operates at SECTION
// granularity, never subsection, so title/section is all parseCitation promises.
const USC_CITE_RE = /\b(\d{1,3})\s*U\.?\s*S\.?\s*C\.?\s*(?:§+\s*)?(\d{1,5}[a-z]{0,3}(?:-\d{1,4})?)/i;
const SECTION_OF_TITLE_RE = /\bsection\s+(\d{1,5}[a-z]{0,3}(?:-\d{1,4})?)\s+of\s+title\s+(\d{1,3})\b/i;

// parseCitation(raw) -> {title, section} | null. NEVER guesses: a popular-name-only reference
// (e.g. "the Social Security Act", "Section 1903 of the Social Security Act" with no USC cite
// printed) returns null - those become needs_mapping downstream (glossary plan's self-review
// notes), not a fabricated USC guess. This is first-class behavior, not a fallback.
export function parseCitation(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const uscMatch = raw.match(USC_CITE_RE);
  if (uscMatch) return { title: Number(uscMatch[1]), section: uscMatch[2] };
  const sectionOfTitleMatch = raw.match(SECTION_OF_TITLE_RE);
  if (sectionOfTitleMatch) return { title: Number(sectionOfTitleMatch[2]), section: sectionOfTitleMatch[1] };
  return null;
}

// ---- fetch ----
//
// REAL URL SHAPE (captured live 2026-07-28, uscode.house.gov's actual JSF app - see SOURCES.md
// #uscode for the full investigation): the brief guessed OLRC offers a clean per-section
// RSS/XHTML "download" resource - it does not. There is no plain-GET per-section export; the only
// working per-section surface is this interactive view.xhtml page (content-type text/html, NOT a
// distinct download/export endpoint), which embeds the real official section text amid a large
// JSF-rendered navigation tree + session ViewState. `num=0&edition=prelim` were present on every
// working request during investigation and are kept as observed, not independently varied
// (politeness budget). govinfo's USCODE API was NOT used as a fallback - this house.gov path
// worked cleanly, so the fallback was never exercised (documented, not assumed).
export function buildUscUrl(title, section) {
  return `https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title${title}-section${section}&num=0&edition=prelim`;
}

const STATUTE_START = '<!-- field-start:statute -->';
const STATUTE_END = '<!-- field-end:statute -->';

// Decodes the entities OLRC's page actually uses (verified against the real captures - &sect;
// and &ndash; appear throughout, distinct from us-congress-text.js's stripHtml which never sees
// them). &sect; -> "section " (readable plain text, not the raw glyph) for a downstream LLM
// (Task 5 glosser) that reads this as prose, not typeset legal citation.
function stripStatuteHtml(raw) {
  return raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&sect;/gi, 'section ')
    .replace(/&ndash;/gi, '-')
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

// extractSectionText(html) -> the official statute text between OLRC's own field-start/field-end
// markers (the operative law only - excludes Editorial/Amendment/Effective-Date notes, which sit
// outside these markers), gated by MAX_EXCERPT_CHARS. Pure and fixture-testable (like
// summarizer.js's own size-gated functions) - this is where ALL of fetchUscSection's substantive
// logic lives; fetchUscSection itself is a thin fetch-then-call wrapper, same shape as this
// codebase's other untested fetch* wrappers (fetchBillDetail, fetchTextBody, etc. - see
// us-congress.js / us-congress-text.js). Throws UscSectionNotFoundError, never returns '' for a
// not-found page; throws OversizeExcerptError, never truncates a too-large section.
export function extractSectionText(html, meta = {}) {
  const start = html.indexOf(STATUTE_START);
  const end = start === -1 ? -1 : html.indexOf(STATUTE_END, start);
  if (start === -1 || end === -1) {
    throw new UscSectionNotFoundError(
      'no statute field in uscode.house.gov response - section does not exist at this citation (site redirects unknown title/section to /docnotfound.xhtml, which fetch() follows to a normal 200 "Document not Found" page)',
      meta,
    );
  }
  const text = stripStatuteHtml(html.slice(start + STATUTE_START.length, end));
  if (text.length > MAX_EXCERPT_CHARS) {
    throw new OversizeExcerptError(
      `excerpt for ${meta.title} U.S.C. ${meta.section} is ${text.length} chars, exceeds MAX_EXCERPT_CHARS=${MAX_EXCERPT_CHARS}; will not truncate silently`,
      { ...meta, length: text.length },
    );
  }
  return text;
}

// fetchUscSection(title, section) -> {url, excerptText}. Caller computes the hash itself via
// sha256(excerptText) (re-exported above).
export async function fetchUscSection(title, section, limiter = uscodeLimiter) {
  const url = buildUscUrl(title, section);
  const html = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
  return { url, excerptText: extractSectionText(html, { title, section, url }) };
}
