// site/js/glossary-inline.js — the bill page's inline glossary (design spec §4, task-9 brief;
// fix round 1, task-9 review). Browser-native ES module. Split out of bill-page.js because this
// is a cohesive, self-contained concern (referenced-term marking + the minimal gloss_md renderer
// + the <dfn>-wrap DOM), reused by bill-page.js exactly the way person-page.js reuses
// profile-model.js/receipts.js — never a lookalike reimplementation.
//
// markTerms is PURE (TDD'd in tests/bill-page.test.js, zero DOM) — the DOM-touching helpers below
// it (renderGlossMarkdown, renderMarkedText) are the "wiring" layer, same split person-page.js
// draws between its own pure helpers and its DOM render functions.

import { el } from './render.js';

// A single flanking-character check for the letter-boundary rule below: /[a-z0-9]/i on ONE
// character. Not a full \w (which also matches underscore) — the review fix names [a-z0-9]
// specifically.
const BOUNDARY_CHAR = /[a-z0-9]/i;

// markTerms(pointText, glossaryTerms) — case-insensitive EXACT string match on glossary_terms.term
// against pointText, longest-first, non-overlapping (task-9 brief, spec-critical). "Longest-first"
// means: every occurrence of the LONGEST candidate term anywhere in pointText is claimed before any
// shorter candidate is even searched for — so a shorter term that is itself a substring of a longer
// one already-matched (e.g. "Social Security" inside "Social Security Act") never re-claims text
// the longer match already owns.
//
// Fix round 1, MED-1 (task-9 review, live: 8 groups in one summary carry duplicate term text with
// DIFFERENT citations/glosses, e.g. "War Powers Resolution" x3 — one arbitrary row used to win by
// fetch order, the others silently never rendered, their citation never shown): candidate rows are
// GROUPED by exact (case-insensitive) term text before matching — one group = one span of text to
// claim — and a matched segment's `terms` is the FULL ARRAY of every row in that group (in the
// order the caller supplied them; the caller's glossary_terms fetch orders
// `citation.nullsfirst,id` for determinism — this module has no opinion on that ordering, it just
// preserves it), so the DOM layer can render every citation as its own disambiguated entry instead
// of picking one arbitrarily.
//
// Fix round 1, LOW-1 (task-9 review): a letter-boundary rule — a candidate match must not be
// flanked by [a-z0-9] on either side, so a short term like "act" never matches mid-word inside
// "exact." A boundary-violating occurrence is treated as NOT a match at all (never consumed),
// so it neither claims the span nor blocks a different, valid candidate from matching there.
//
// Returns `{text, terms}` segments in reading order; `terms` is `[]` for plain, unmatched text.
// Pure: never touches the DOM, never throws on malformed input.
export function markTerms(pointText, glossaryTerms) {
  const text = String(pointText || '');
  const rows = (Array.isArray(glossaryTerms) ? glossaryTerms : [])
    .filter((t) => t && typeof t.term === 'string' && t.term.length > 0);

  if (text.length === 0 || rows.length === 0) {
    return [{ text, terms: [] }];
  }

  // Group by exact (case-insensitive) term text, preserving first-appearance order — a Map keyed
  // by the lower-cased term text does both: insertion order for the tie-break below, and a single
  // group per distinct displayed term regardless of how many underlying rows share it.
  const groups = new Map(); // lowerTerm -> { needle: <first row's term text>, rows: [...] }
  for (const row of rows) {
    const key = row.term.toLowerCase();
    if (!groups.has(key)) groups.set(key, { needle: row.term, rows: [] });
    groups.get(key).rows.push(row);
  }
  const candidates = [...groups.values()];

  // Longest term string first; a stable sort preserves the Map's own first-appearance order as
  // the tie-breaker for same-length candidates, so overlap outcomes are deterministic.
  const sorted = candidates.slice().sort((a, b) => b.needle.length - a.needle.length);
  const lowerText = text.toLowerCase();
  const consumed = new Array(text.length).fill(false);
  const matches = []; // {start, end, rows}

  for (const group of sorted) {
    const needle = group.needle.toLowerCase();
    let searchFrom = 0;
    for (;;) {
      const idx = lowerText.indexOf(needle, searchFrom);
      if (idx === -1) break;
      const end = idx + needle.length;

      // LOW-1: reject a match flanked by a letter/digit on either side (a real word-boundary
      // violation, e.g. "act" inside "exact") — this occurrence is simply not a match; it is
      // never consumed and never blocks a different candidate from matching the same span.
      const beforeOk = idx === 0 || !BOUNDARY_CHAR.test(text[idx - 1]);
      const afterOk = end === text.length || !BOUNDARY_CHAR.test(text[end]);
      if (!beforeOk || !afterOk) {
        searchFrom = idx + 1;
        continue;
      }

      let overlaps = false;
      for (let i = idx; i < end; i += 1) {
        if (consumed[i]) { overlaps = true; break; }
      }
      if (!overlaps) {
        for (let i = idx; i < end; i += 1) consumed[i] = true;
        matches.push({ start: idx, end, rows: group.rows });
      }
      searchFrom = idx + 1; // keep scanning for further occurrences of this SAME group
    }
  }

  matches.sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start), terms: [] });
    segments.push({ text: text.slice(m.start, m.end), terms: m.rows });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), terms: [] });
  if (segments.length === 0) segments.push({ text, terms: [] });

  return segments;
}

// ============================================================================
// DOM rendering (not independently unit-tested — same convention as person-page.js's own DOM
// helpers; smoke-tested live per the controller's Step 4). Small and named so each does one thing.
// ============================================================================

// gloss_md's MINIMAL renderer (task-9 brief, spec-critical): paragraphs (blank-line separated) +
// **bold** only, built ENTIRELY on text nodes — no innerHTML anywhere. This is deliberately NOT a
// general markdown parser: gloss_md is model-authored to a narrow 1-2 sentence shape
// (src/lib/glosser.js's GLOSS_SCHEMA) and never needs headings/links/lists/nesting — every
// character still reaches the DOM through a real text node, matching render.js's own textContent
// discipline (el()'s string/number children become text nodes, never parsed markup).
const BOLD_PATTERN = /\*\*(.+?)\*\*/g;

export function renderGlossMarkdown(mdText) {
  const text = String(mdText || '');
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const source = paragraphs.length > 0 ? paragraphs : [text];

  const frag = document.createDocumentFragment();
  for (const para of source) {
    const p = el('p', { class: 'gloss-paragraph' });
    let cursor = 0;
    BOLD_PATTERN.lastIndex = 0;
    let m = BOLD_PATTERN.exec(para);
    while (m !== null) {
      if (m.index > cursor) p.appendChild(document.createTextNode(para.slice(cursor, m.index)));
      const strong = document.createElement('strong');
      strong.appendChild(document.createTextNode(m[1]));
      p.appendChild(strong);
      cursor = m.index + m[0].length;
      m = BOLD_PATTERN.exec(para);
    }
    if (cursor < para.length) p.appendChild(document.createTextNode(para.slice(cursor)));
    frag.appendChild(p);
  }
  return frag;
}

// One matched term's expandable detail block. MED-1: renders EVERY row in the group, each as its
// own disambiguated entry — the citation (or an honest "no citation on file") is the heading, so a
// reader looking at "War Powers Resolution" backed by 3 different citations sees all 3, never one
// arbitrary winner with the others silently dropped. A hostile/malformed source_url degrades that
// ONE entry to an honest "source unavailable" span rather than throwing (mirrors person-page.js's
// renderVoteRow HIGH-1 fix: one bad url must not take down the whole detail block).
function buildGlossDetail(rows) {
  const detail = el('div', { class: 'gloss-detail' });
  detail.hidden = true;
  for (const term of rows) {
    const entry = el('div', { class: 'gloss-detail-entry' });
    const heading = term.citation ? `${term.term} — ${term.citation}` : `${term.term} (no citation on file)`;
    entry.appendChild(el('p', { class: 'gloss-detail-heading' }, heading));
    if (term.gloss_md) entry.appendChild(renderGlossMarkdown(term.gloss_md));
    if (term.supported_by_quote) entry.appendChild(el('blockquote', { class: 'gloss-quote' }, term.supported_by_quote));
    if (term.source_url) {
      try {
        entry.appendChild(el('a', { class: 'gloss-source-link', href: term.source_url }, 'Source'));
      } catch {
        entry.appendChild(el('span', { class: 'gloss-source-unavailable' }, 'source unavailable'));
      }
    }
    detail.appendChild(entry);
  }
  return detail;
}

// A matched segment's <dfn> wrap + its detail block (task-9 brief: "segments render as text nodes
// with <dfn> wraps; gloss_md shown in an expandable block below"). Returns the two nodes
// SEPARATELY — fix round 1, LOW-4 (task-9 review): a block-level detail <div> must never be
// appended INSIDE the caller's inline <p>/text run; the caller places `dfn` inline and `detail` as
// a later sibling. <dfn> is not natively interactive, so tabIndex/role/keydown are added directly
// on the node AFTER el() builds it — el()'s attrs allowlist (class/href/id/dataset/src/alt) only
// guards what's passed THROUGH el() itself; further DOM properties set afterward are unrestricted,
// same as person-page.js's renderPaginationControls building plain buttons alongside el()-built
// elements.
function buildMarkedTerm(segmentText, rows) {
  const dfn = el('dfn', { class: 'gloss-term' }, segmentText);
  dfn.tabIndex = 0;
  dfn.setAttribute('role', 'button');
  dfn.setAttribute('aria-expanded', 'false');

  const detail = buildGlossDetail(rows);
  const toggle = () => {
    detail.hidden = !detail.hidden;
    dfn.setAttribute('aria-expanded', String(!detail.hidden));
  };
  dfn.addEventListener('click', toggle);
  dfn.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });

  return { dfn, detail };
}

// The page-facing entry point: markTerms(text, glossaryTerms) -> `{inline, details}`. `inline` is
// a DocumentFragment of plain text nodes interleaved with <dfn>-wrapped matched terms, meant to be
// appended INTO the caller's own text container (a stated-purpose <p>, a bullet <li>, ...).
// `details` is the array of that same call's expandable detail <div>s, meant to be appended AFTER
// (as siblings of) that text container — never nested inside it (LOW-4, see buildMarkedTerm).
export function renderMarkedText(text, glossaryTerms) {
  const segments = markTerms(text, glossaryTerms);
  const inline = document.createDocumentFragment();
  const details = [];
  for (const seg of segments) {
    if (!seg.terms || seg.terms.length === 0) {
      if (seg.text) inline.appendChild(document.createTextNode(seg.text));
      continue;
    }
    const { dfn, detail } = buildMarkedTerm(seg.text, seg.terms);
    inline.appendChild(dfn);
    details.push(detail);
  }
  return { inline, details };
}
