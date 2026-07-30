// site/js/glossary-inline.js — the bill page's inline glossary (design spec §4, task-9 brief).
// Browser-native ES module. Split out of bill-page.js because this is a cohesive, self-contained
// concern (referenced-term marking + the minimal gloss_md renderer + the <dfn>-wrap DOM), reused
// by bill-page.js exactly the way person-page.js reuses profile-model.js/receipts.js — never a
// lookalike reimplementation folded into the page's own orchestration file.
//
// markTerms is PURE (TDD'd in tests/bill-page.test.js, zero DOM) — the DOM-touching helpers below
// it (renderGlossMarkdown, renderMarkedText) are the "wiring" layer, same split person-page.js
// draws between its own pure helpers and its DOM render functions.

import { el } from './render.js';

// markTerms(pointText, glossaryTerms) — case-insensitive EXACT string match on glossary_terms.term
// against pointText, longest-first, non-overlapping (task-9 brief, spec-critical). "Longest-first"
// means: every occurrence of the LONGEST candidate term anywhere in pointText is claimed before any
// shorter candidate is even searched for — so a shorter term that is itself a substring of a longer
// one already-matched (e.g. "Social Security" inside "Social Security Act") never re-claims text
// the longer match already owns. Returns `{text, term}` segments in reading order; `term` is the
// FULL matched glossary_terms row (not just its name) so the caller can build the expandable detail
// block (gloss_md/supported_by_quote/source_url) without a second lookup — `null` for plain,
// unmatched text. Pure: never touches the DOM, never throws on malformed input.
export function markTerms(pointText, glossaryTerms) {
  const text = String(pointText || '');
  const candidates = (Array.isArray(glossaryTerms) ? glossaryTerms : [])
    .filter((t) => t && typeof t.term === 'string' && t.term.length > 0);

  if (text.length === 0 || candidates.length === 0) {
    return [{ text, term: null }];
  }

  // Longest term string first; a stable sort preserves the caller's own array order as the
  // tie-breaker for same-length candidates, so overlap outcomes are deterministic.
  const sorted = candidates.slice().sort((a, b) => b.term.length - a.term.length);
  const lowerText = text.toLowerCase();
  const consumed = new Array(text.length).fill(false);
  const matches = []; // {start, end, term}

  for (const term of sorted) {
    const needle = term.term.toLowerCase();
    let searchFrom = 0;
    for (;;) {
      const idx = lowerText.indexOf(needle, searchFrom);
      if (idx === -1) break;
      const end = idx + needle.length;
      let overlaps = false;
      for (let i = idx; i < end; i += 1) {
        if (consumed[i]) { overlaps = true; break; }
      }
      if (!overlaps) {
        for (let i = idx; i < end; i += 1) consumed[i] = true;
        matches.push({ start: idx, end, term });
      }
      searchFrom = idx + 1; // keep scanning for further occurrences of this SAME term
    }
  }

  matches.sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start), term: null });
    segments.push({ text: text.slice(m.start, m.end), term: m.term });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), term: null });
  if (segments.length === 0) segments.push({ text, term: null });

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

// One matched term's expandable detail block: heading, gloss_md (via the minimal renderer above),
// the supported_by_quote receipt, and the source_url receipt link — every one of the "receipts"
// trust model v3 requires for a public-facing gloss. A hostile/malformed source_url degrades this
// ONE block to an honest "source unavailable" span rather than throwing (mirrors person-page.js's
// renderVoteRow HIGH-1 fix: one bad url must not take down the whole summary render).
function buildGlossDetail(term) {
  const detail = el('div', { class: 'gloss-detail' });
  detail.hidden = true;
  detail.appendChild(el('p', { class: 'gloss-detail-heading' }, term.term));
  if (term.gloss_md) {
    detail.appendChild(renderGlossMarkdown(term.gloss_md));
  }
  if (term.supported_by_quote) {
    detail.appendChild(el('blockquote', { class: 'gloss-quote' }, term.supported_by_quote));
  }
  if (term.source_url) {
    try {
      detail.appendChild(el('a', { class: 'gloss-source-link', href: term.source_url }, 'Source'));
    } catch {
      detail.appendChild(el('span', { class: 'gloss-source-unavailable' }, 'source unavailable'));
    }
  }
  return detail;
}

// A matched segment's <dfn> wrap + its sibling expandable detail block (task-9 brief: "segments
// render as text nodes with <dfn> wraps; gloss_md shown in an expandable block below"). <dfn> is
// not natively interactive, so tabIndex/role/keydown are added directly on the node AFTER el()
// builds it — el()'s attrs allowlist (class/href/id/dataset/src/alt) only guards what's passed
// THROUGH el() itself; further DOM properties set by the calling code afterward are unrestricted,
// same as person-page.js's renderPaginationControls building plain buttons alongside el()-built
// elements.
function buildMarkedTerm(segmentText, term) {
  const wrapper = document.createDocumentFragment();
  const dfn = el('dfn', { class: 'gloss-term' }, segmentText);
  dfn.tabIndex = 0;
  dfn.setAttribute('role', 'button');
  dfn.setAttribute('aria-expanded', 'false');

  const detail = buildGlossDetail(term);
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

  wrapper.appendChild(dfn);
  wrapper.appendChild(detail);
  return wrapper;
}

// The page-facing entry point: markTerms(text, glossaryTerms) -> a DocumentFragment of plain text
// nodes interleaved with <dfn>-wrapped + expandable-detail matched terms, ready to append into any
// container (a stated-purpose paragraph, a bullet's point text, ...).
export function renderMarkedText(text, glossaryTerms) {
  const segments = markTerms(text, glossaryTerms);
  const frag = document.createDocumentFragment();
  for (const seg of segments) {
    if (!seg.term) {
      if (seg.text) frag.appendChild(document.createTextNode(seg.text));
      continue;
    }
    frag.appendChild(buildMarkedTerm(seg.text, seg.term));
  }
  return frag;
}
