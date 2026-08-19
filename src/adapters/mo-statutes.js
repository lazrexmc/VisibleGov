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
// RSMo's dotted section shape is its signature; USC sections are never dotted. Post-audit fix wave
// (2026-08-19) hardened three parts of this pattern:
//  - CHAPTER PART `[1-9]\d{0,2}` (was `\d{1,3}`): RSMo has no chapter 0 and never prints a
//    leading-zero chapter, so '0.500', '000.000' and '053.010' are now refused rather than
//    silently accepted as sections 0.500 / 0.000 / 53.010. The SECTION suffix after the dot keeps
//    its leading zeros untouched — RSMo genuinely prints '536.010'.
//  - `sec.` / `Sec.` accepted alongside `section`/`sections` (a canonical Missouri short form).
//  - Optional canonical year suffix after RSMo: ', RSMo 2016' and ', RSMo Supp. 2023'.
// A trailing subdivision (".2", "(1)") parses but normalizes to the parent section (spec §3); the
// subdivision tail is `(?:\(\w+\))*` — a sequence of BALANCED simple groups, so '536.010(1)(a)'
// parses and the unbalanced '536.010(a)b)' is refused (the old `(?:\([\w()]+\))?` accepted it).
const MO_SECTION_RE = /^(?:RSMo\.?\s+)?(?:§+\s*)?(?:sec(?:tion)?s?\.?\s+)?([1-9]\d{0,2}\.\d{3,4})(?:\.\d+)?(?:\(\w+\))*(?:,?\s*RSMo\.?(?:\s+Supp\.?)?(?:\s+\d{4})?)?$/i;

// Low-chapter corroboration guard (controller ruling, post-audit fix wave 2026-08-19). Missouri
// APPROPRIATIONS bills (HB 1 through HB 19) number their OWN internal sections `N.MMM`, where N is
// the bill number — so a bare dotted cite with a low chapter part inside a MO bill is genuinely
// ambiguous between a real RSMo section and the bill's own internal section, and mapping it to
// revisor.mo.gov would hand a reader statute text the bill never meant. Refuse unless the raw text
// itself carries the RSMo marker. Stored normalized citations always carry it ('RSMo 1.140'), so
// the gloss-time round trip is preserved — only the bare, uncorroborated form is refused.
const LOW_CHAPTER_MAX = 20;

export function parseMoCitation(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const t = raw.trim();
  if (FEDERAL_MARKER_RE.test(t) || MULTI_RE.test(t)) return null;
  const sec = t.match(MO_SECTION_RE);
  if (!sec) return null;
  const section = sec[1];
  const chapterPart = Number.parseInt(section.slice(0, section.indexOf('.')), 10);
  if (chapterPart <= LOW_CHAPTER_MAX && !/RSMo/i.test(t)) return null;
  return { kind: 'section', section };
}

// Sections only in v1 — chapters were dropped by post-audit ruling (2026-08-19); see the spec's
// §3 out-of-scope entry. The throw is defensive: nothing in this codebase can produce a non-section
// parse result any more, and a future kind must be handled deliberately, never normalized by
// accident into a citation string the glosser would then try to fetch.
export function normalizeMoCitation(parsed) {
  if (parsed?.kind !== 'section') {
    throw new Error(`normalizeMoCitation: only section citations exist in v1, got ${JSON.stringify(parsed?.kind ?? null)}`);
  }
  return `RSMo ${parsed.section}`;
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

// Slices html between two literal markers. THROWS MoPageIdentityError when either marker is
// absent (controller ruling on Task 3's review) — silently falling back to slicing from index 0
// or end-of-document would hand navigation boilerplate to the glosser if revisor.mo.gov's
// template ever drifts. The response-identity check upstream (section number present) catches a
// wrong or generic page; this catches the narrower case where the RIGHT page's layout no longer
// matches the markers we derived from the captured fixtures.
function isolateBetween(html, startMarker, endMarker, meta = {}) {
  const s = html.indexOf(startMarker);
  if (s === -1) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response is missing its expected body-start marker for section ${meta.section} — refusing to extract`,
      meta,
    );
  }
  const startIdx = s + startMarker.length;
  const e = html.indexOf(endMarker, startIdx);
  if (e === -1) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response is missing its expected body-end marker for section ${meta.section} — refusing to extract`,
      meta,
    );
  }
  return html.slice(startIdx, e);
}

// ---- annotation stripping (F3, post-audit fix wave 2026-08-19) ----
//
// A section page's isolated body ends with a `<div class="foot">` block. Verified against BOTH
// captured section fixtures, that block holds, in source order:
//   1. a red "Footnotes follow" rule paragraph (`<p class="" title="Footnotes follow" ...>`),
//   2. the ENACTMENT-HISTORY / effective-date paragraph — the official source note, e.g.
//      "(L. 1945 p. 1504 § 1, A.L. 1957 p. 748, ... A.L. 2006 S.B. 1146)" — which IS part of the
//      statute's own official presentation and is KEPT,
//   3. zero or more REVISOR-AUTHORED judicial-decision annotations, each its own `<p class="norm">`
//      opening with a parenthesized 4-digit year: "(1977) Held, director of revenue must hold
//      hearing...  Randle et al. v. Spradling (Mo.), 556 S.W.2d 10."
//
// (3) is editorial case-law commentary about the statute, not the statute — the same class of
// revisor-authored, cross-referencing text that got chapters dropped from v1 entirely. Left in the
// excerpt it is quotable by a gloss author or a verifier as if it were law, so it is cut here.
//
// Every paragraph in the foot block carries the SAME `class="norm"` — the markup offers no class,
// id, or container that separates (2) from (3) — so the real available boundary is the annotation
// paragraphs' own opening token: a parenthesized year. A source note never opens that way (it
// opens with "L.", "A.L.", "RSMo", "Prior revision", …), which is what makes this discriminating
// rather than a guess. Scoped to inside the foot block so statute body text can never trip it.
//
// Documented residual (not guessed at): some RSMo sections also carry a revisor-authored
// "CROSS REFERENCES:" block in this same footer. Neither captured section fixture has one, so
// there is no real markup to derive a boundary from — cutting it would be invention. Recorded
// here so the next capture of a section that HAS one can close it against real evidence.
const MO_FOOT_BLOCK_START = '<div class="foot"';
const MO_ANNOTATION_P_RE = /<p\b[^>]*>\s*\((?:1[5-9]\d{2}|20\d{2})\)/;

function dropCaseLawAnnotations(bodyHtml) {
  const footIdx = bodyHtml.indexOf(MO_FOOT_BLOCK_START);
  if (footIdx === -1) return bodyHtml;
  const m = bodyHtml.slice(footIdx).match(MO_ANNOTATION_P_RE);
  if (!m) return bodyHtml;
  return bodyHtml.slice(0, footIdx + m.index);
}

// Throws MoPageIdentityError when the isolated+stripped excerpt is the empty string (Important
// finding 1a). Empirically: revisor.mo.gov's layout div markers are site-wide template chrome
// present on other page types too, so isolateBetween can succeed — both markers found — while the
// slice between them carries nothing. An empty-but-200 response must never flow silently into a
// gloss author as source text (same posture as uscode.js's extractSubsectionText empty-slice
// guard, ~:221-226).
// Deliberately its own check ahead of the marker-presence regex below: an empty string trivially
// fails that regex too, but this gives the honest, specific diagnosis ("empty slice" vs "slice
// present but wrong page") instead of collapsing both into one generic message.
function assertNotEmptyExcerpt(text, meta) {
  if (text.length === 0) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response isolated an EMPTY excerpt for section ${meta.section} — the page is not what was asked for, or the template drifted`,
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
  // heading to the page's own end-of-content boundary, drop the revisor's case-law annotations
  // (F3), then strip. Keeps the statute body and its enactment-history/effective-date line.
  const text = stripMoHtml(
    dropCaseLawAnnotations(isolateBetween(html, MO_SECTION_BODY_START, MO_SECTION_BODY_END, meta)),
  );
  assertNotEmptyExcerpt(text, meta);
  // Response-identity (spec §5, hardened by F4 of the post-audit fix wave): the ISOLATED SLICE must
  // BEGIN with the requested section's own number — the isolated slice genuinely opens with it
  // ("536.010. Definitions. — ..."; the repealed shape opens "1.022. (Repealed L. 1975 ...)").
  // The old check merely required the number to appear ANYWHERE in the slice, which a page that
  // only CROSS-REFERENCES the requested section satisfies: 536.010's own body links to 536.100, so
  // extracting "536.100" off 536.010's page wrongly passed (executed proof). Anchoring makes the
  // check prove the page IS the section, not merely that it mentions it.
  const escaped = meta.section.replace(/\./g, '\\.');
  if (!new RegExp(`^\\s*${escaped}\\b`).test(text)) {
    throw new MoPageIdentityError(
      `revisor.mo.gov response does not begin with section ${meta.section}'s own marker — refusing to extract`,
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

// ---- fetch wrappers (Task 4) ----
//
// Thin — structurally reviewed, not integration-tested (the codebase convention for fetch*
// wrappers, per uscode.js's own comment; the URL builder IS unit-tested above, and the pure
// extraction function underneath it carries the real test weight).
//
// Sections only. buildMoChapterUrl/fetchMoChapter/extractMoChapterText were REMOVED by the
// post-audit ruling (2026-08-19) that dropped chapters from v1 — a chapter page is a table of
// contents (revisor-authored catchlines plus cross-references naming OTHER chapters' subjects),
// not statutory text, and an adversarial audit showed a verifier quote drawn from one of those
// cross-reference lines could mechanically "support" a wrong-chapter gloss claim. Chapters stay
// needs_mapping until a design grounds them honestly. tests/fixtures/mo-statutes/chapter-536.html
// is deliberately KEPT on disk: it documents what the source actually serves, and is the evidence
// any future chapter design would have to start from.
export function buildMoSectionUrl(section) {
  return `https://revisor.mo.gov/main/OneSection.aspx?section=${section}`;
}
export async function fetchMoSection(section, limiter = moStatutesLimiter) {
  const url = buildMoSectionUrl(section);
  const html = await fetchWithLimit(url, { source: SOURCE, limiter, as: 'text' });
  return { url, excerptText: extractMoSectionText(html, { section, url }) };
}
