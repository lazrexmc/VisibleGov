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

// Task 5 controller ruling 2 (glossary plan): thrown when a citation names a subsection that
// isn't present as its own OLRC substructure-location_<X> anchor in the fetched section HTML
// (typo'd citation, or a subsection that doesn't exist at this granularity) - a distinct failure
// mode from UscSectionNotFoundError (whole SECTION missing) and from OversizeExcerptError
// (subsection found but still too large). Typed, never a silent skip.
export class SubsectionNotFoundError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SubsectionNotFoundError';
    Object.assign(this, meta);
  }
}

// ---- citation parsing ----
//
// Handles the 3 forms in the brief PLUS the real form found in this task's own golden fixture
// (tests/fixtures/us-congress/bill-text.htm, HR 498): "Section 1903(i) of the Social Security Act
// (42 U.S.C. 1396b(i))" - a popular-name reference wrapping a parenthetical USC cite with a
// trailing subsection letter. Matched anywhere in the raw string (not anchored), so an embedded
// USC cite is found even when it rides along with popular-name text.
//
// Task 5 controller ruling 2 (glossary plan): a trailing top-level subsection - "(i)", "(aa)" -
// is now CAPTURED (group 3 below), not dropped, so a citation like "42 U.S.C. 1396b(i)" can drive
// subsection-level excerpting when the full section oversizes (see extractSubsectionText). Only a
// single parenthesized group directly after the section number is recognized (fetchUscSection's
// OLRC anchors only go one level deep at the top - "(i)(2)(A)"-style deep subdivisions are matched
// only through their first group, "(i)", same as the golden's own citation shape needs).
const USC_CITE_RE = /\b(\d{1,3})\s*U\.?\s*S\.?\s*C\.?\s*(?:§+\s*)?(\d{1,5}[a-z]{0,3}(?:-\d{1,4})?)(?:\s*\(([a-zA-Z]{1,2})\))?/i;
const SECTION_OF_TITLE_RE = /\bsection\s+(\d{1,5}[a-z]{0,3}(?:-\d{1,4})?)\s+of\s+title\s+(\d{1,3})\b/i;

// parseCitation(raw) -> {title, section, subsection?} | null. NEVER guesses: a popular-name-only
// reference (e.g. "the Social Security Act", "Section 1903 of the Social Security Act" with no
// USC cite printed) returns null - those become needs_mapping downstream (glossary plan's
// self-review notes), not a fabricated USC guess. This is first-class behavior, not a fallback.
// `subsection` is present ONLY when the raw cite carries a recognizable trailing top-level
// subsection (see USC_CITE_RE comment) - existing callers that only read title/section are
// unaffected (extra own property, never checked by them).
export function parseCitation(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const uscMatch = raw.match(USC_CITE_RE);
  if (uscMatch) {
    const result = { title: Number(uscMatch[1]), section: uscMatch[2] };
    if (uscMatch[3]) result.subsection = uscMatch[3];
    return result;
  }
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

// ---- subsection-level slicing (Task 5 controller ruling 2, glossary plan) ----
//
// Only reached when a whole SECTION oversizes (extractSectionText's OversizeExcerptError) AND the
// citation that led here named a subsection (parseCitation's new `subsection` field) - never used
// as a general-purpose "give me just this subsection" fetch path. Ledgered from Task 2's review as
// "reviewer-confirmed feasible": OLRC's own pages carry `<a name="substructure-location_X">`
// anchors at full hierarchical granularity, verified present in the real 1396b fixture (a,b,c...z,
// aa,bb - matching every top-level subsection letter the section actually has, through "(bb)").
//
// A TOP-LEVEL anchor's name value ends exactly at the closing `"` - e.g. `substructure-location_i`
// - which a NESTED anchor's never does (`substructure-location_i_1` has `_1` right where the top-
// level tag would have `">`). Matching the full literal tag `<a name="substructure-location_X">
// </a>` therefore self-filters to top-level anchors with no separate underscore-counting logic:
// the regex simply never matches inside a nested anchor's longer name.
const TOP_LEVEL_ANCHOR_RE = /<a name="substructure-location_([a-zA-Z0-9]+)"><\/a>/g;

// extractSubsectionText(html, subsection, meta) -> plain text, sliced from the cited subsection's
// own anchor to the next top-level anchor (or the end of the statute field, if it's the section's
// last subsection) - "slice to the next same-or-higher-level anchor" per the controller ruling;
// there is nothing HIGHER than top-level within a single section's statute field, so "next
// top-level anchor" is the whole rule. Pure, fixture-testable (like extractSectionText). Throws
// UscSectionNotFoundError if the section itself doesn't exist (no statute field at all - same
// signal extractSectionText uses), SubsectionNotFoundError if the section exists but the named
// subsection has no anchor, OversizeExcerptError if even the subsection alone still exceeds
// MAX_EXCERPT_CHARS (rare, but never silently truncated either).
export function extractSubsectionText(html, subsection, meta = {}) {
  const start = html.indexOf(STATUTE_START);
  const end = start === -1 ? -1 : html.indexOf(STATUTE_END, start);
  if (start === -1 || end === -1) {
    throw new UscSectionNotFoundError(
      'no statute field in uscode.house.gov response - section does not exist at this citation (site redirects unknown title/section to /docnotfound.xhtml, which fetch() follows to a normal 200 "Document not Found" page)',
      meta,
    );
  }
  const field = html.slice(start, end);
  const anchors = [];
  TOP_LEVEL_ANCHOR_RE.lastIndex = 0;
  let m = TOP_LEVEL_ANCHOR_RE.exec(field);
  while (m) {
    anchors.push({ name: m[1], index: m.index });
    m = TOP_LEVEL_ANCHOR_RE.exec(field);
  }
  const targetIdx = anchors.findIndex((a) => a.name.toLowerCase() === String(subsection).toLowerCase());
  if (targetIdx === -1) {
    throw new SubsectionNotFoundError(
      `no substructure-location_${subsection} anchor found in fetched section ${meta.title} U.S.C. ${meta.section} - subsection may not exist, or the citation is wrong`,
      { ...meta, subsection },
    );
  }
  const sliceStart = anchors[targetIdx].index;
  const sliceEnd = targetIdx + 1 < anchors.length ? anchors[targetIdx + 1].index : field.length;
  const text = stripStatuteHtml(field.slice(sliceStart, sliceEnd));
  if (text.length === 0) {
    throw new SubsectionNotFoundError(
      `substructure-location_${subsection} anchor found for ${meta.title} U.S.C. ${meta.section} but the sliced excerpt is empty`,
      { ...meta, subsection },
    );
  }
  if (text.length > MAX_EXCERPT_CHARS) {
    throw new OversizeExcerptError(
      `subsection excerpt for ${meta.title} U.S.C. ${meta.section}(${subsection}) is ${text.length} chars, exceeds MAX_EXCERPT_CHARS=${MAX_EXCERPT_CHARS}; will not truncate silently`,
      { ...meta, subsection, length: text.length },
    );
  }
  return text;
}

// buildUscUrl's granule URL plus an anchor fragment identifying exactly which slice of the section
// a subsection-level excerpt came from (glossary plan controller ruling 3: "source_url... + the
// subsection fragment if sliced" - the published-completeness gate's provenance must point at the
// EXACT text that was actually read, not just the section it lives in).
export function buildSubsectionFragment(subsection) {
  return `#substructure-location_${subsection}`;
}

// fetchUscSubsection(title, section, subsection) -> {url, excerptText}. A SEPARATE network fetch
// from fetchUscSection (not a shared/cached HTML reuse) - deliberately simple: this path only
// fires on the rare oversize-with-cited-subsection case, and a second politely-rate-limited fetch
// is a small, easy-to-reason-about cost next to inventing a raw-HTML-return variant of
// fetchUscSection just to avoid it.
export async function fetchUscSubsection(title, section, subsection, limiter = uscodeLimiter) {
  const url = buildUscUrl(title, section);
  const html = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
  const excerptText = extractSubsectionText(html, subsection, { title, section, url });
  return { url: `${url}${buildSubsectionFragment(subsection)}`, excerptText };
}
