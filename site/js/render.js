// site/js/render.js — DOM helpers (browser-native ES module, no bundler).
//
// Design non-negotiable (docs/superpowers/specs/2026-07-30-public-site-design.md §1): ALL
// database text enters the DOM via textContent — no innerHTML for DB-sourced strings, ever. el()
// is the one place every later page task builds elements through, so the guarantee lives here
// once: string/number children become text nodes (never parsed as markup), and the attrs
// allowlist rejects anything that could turn a DB string into code that executes.

export class UnsafeAttributeError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'UnsafeAttributeError';
    Object.assign(this, meta);
  }
}

const ALLOWED_ATTRS = new Set(['class', 'href', 'id', 'dataset', 'src', 'alt']);

// Fix round 1 (task review, findings 1+2): a bare `value.trim().startsWith('javascript:')`
// blocklist has two holes. (1) `.trim()` only strips leading/trailing whitespace — a TAB/CR/LF
// EMBEDDED mid-scheme ('jav\tascript:alert(1)') survives it untouched, and browsers' URL parsers
// strip embedded TAB/CR/LF anywhere before scheme resolution, so that string resolves to a real
// javascript: URL despite not literally starting with it. (2) blocklisting one dangerous scheme
// misses the rest of the class — data: can run script from a clicked link exactly like
// javascript: can. Fixed by switching to an ALLOWLIST: strip control chars everywhere first (not
// just the ends), then require either no scheme at all (a relative/site-internal href) or one of
// http:, https:, mailto: — everything else throws the same typed error.
const ALLOWED_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
// Task 6 extension (pre-flagged by the task-3 report): the photo section needs <img src alt>.
// src reuses the SAME guard structure as href (control-char strip, protocol-relative rejection,
// scheme allowlist) below, just configured stricter — https-only, no relative-path allowance.
// Both real photoUrl() results (receipts.js: legislators.image_url or the bioguide-derived URL)
// are always absolute https — there is no legitimate case for allowing more than that on <img
// src>, so the allowlist stays as narrow as the real data ever needs.
const ALLOWED_SRC_SCHEMES = new Set(['https:']);
const SCHEME_PATTERN = /^([a-z][a-z0-9+\-.]*:)/i;

// FINAL REVIEW, finding 1 (CRITICAL, proven by execution in Chromium). The strip set used to be
// /[\t\r\n]/ — three of the THIRTY-THREE codepoints a URL parser removes, and an earlier ledger
// line claiming it "mirrored WHATWG" was simply wrong. WHATWG's URL parser (§"basic URL parser",
// step 1) removes any leading AND trailing C0 control or space (U+0000 through U+0020 inclusive)
// from the input before it does anything else, and removes ASCII tab/LF/CR from ANYWHERE inside
// it. So `\u0001javascript:alert(1)` is a real javascript: URL to a browser (it executes on
// click) while this guard saw a scheme-position token of '\u0001javascript' — no SCHEME_PATTERN
// match, therefore "no scheme", therefore treated as a relative site path and ALLOWED.
//
// This strips the WHOLE range from EVERYWHERE (leading, trailing, embedded) before any check
// runs. That is deliberately BROADER than the parser's own asymmetry (interior non-tab/CR/LF C0
// chars are percent-encoded by a real parser, not removed) — over-stripping can only ever make
// this guard reject MORE, never less, which is the only safe direction for a security check:
// the value written to the DOM is always the caller's ORIGINAL string, so a construction that
// browsers would treat as an inert relative path stays inert either way.
const URL_STRIP_PATTERN = /[\u0000-\u0020]/g;

// Which characters end the scheme-position region: once one of these appears, any later ':' is
// part of a path/query/fragment, not a scheme (WHATWG's own scheme-start state ends at the first
// of these). Used by the no-match branch below.
const SCHEME_TERMINATORS = ['/', '?', '#'];

function hasColonInSchemePosition(stripped) {
  const colonIndex = stripped.indexOf(':');
  if (colonIndex === -1) return false;
  const delimiterIndexes = SCHEME_TERMINATORS
    .map((c) => stripped.indexOf(c))
    .filter((i) => i !== -1);
  if (delimiterIndexes.length === 0) return true;
  return colonIndex < Math.min(...delimiterIndexes);
}

// Shared by both href and src (task 6): strip control chars everywhere first (not just the ends
// — see the fix-round-1 note below), reject protocol-relative outright, then check the scheme
// against a caller-supplied allowlist. `allowRelative` is href's own "no scheme at all ->
// relative, site-internal path" allowance; src has no relative use case (every real photoUrl()
// result is an absolute https URL) so it requires a matched, allowlisted scheme with nothing
// missing.
//
// Fix round 1 (task review, findings 1+2, applied when this only guarded href): a bare
// `value.trim().startsWith('javascript:')` blocklist has two holes. (1) `.trim()` only strips
// leading/trailing whitespace — a TAB/CR/LF EMBEDDED mid-scheme ('jav\tascript:alert(1)')
// survives it untouched, and browsers' URL parsers strip embedded TAB/CR/LF anywhere before
// scheme resolution, so that string resolves to a real javascript: URL despite not literally
// starting with it. (2) blocklisting one dangerous scheme misses the rest of the class — data:
// can run script from a clicked link exactly like javascript: can. Fixed by switching to an
// ALLOWLIST: strip control chars everywhere first, then require either no scheme at all (when
// `allowRelative`) or one of the caller's allowlisted schemes — everything else throws the same
// typed error.
function assertSafeUrlAttr(tag, attr, value, allowedSchemes, { allowRelative }) {
  // FINAL REVIEW, finding 1 (third part): this used to be `if (typeof value !== 'string') return;`
  // — a silent BYPASS of every rule below for any non-string, which el() would then hand straight
  // to setAttribute (which stringifies it). Nothing in this codebase legitimately passes a
  // non-string href/src (every call site guards on truthiness first and passes a real string), so
  // a non-string here means a caller bug or a hostile object with a toString — either way it is
  // refused loudly rather than set unchecked. isSafeSrc keeps its own non-throwing `false` for the
  // non-string case: that function is the PREDICATE form by contract, and never sets anything.
  if (typeof value !== 'string') {
    throw new UnsafeAttributeError(
      `el(): ${attr} must be a string on <${tag}> (got ${value === null ? 'null' : typeof value}) — a `
        + 'non-string URL cannot be checked against the scheme allowlist, so it is refused, never set unchecked',
      { tag, attr, value },
    );
  }
  const stripped = value.replace(URL_STRIP_PATTERN, '');
  // Micro-round (re-review, pre-existing LOW-MEDIUM): a protocol-relative URL ('//host/path') has
  // no scheme token either, so it would fall through to the "no scheme -> relative" branch below
  // — but browsers resolve it against the CURRENT page's scheme, i.e. it still goes cross-origin.
  // A genuine same-site path never starts with '//' (real DB receipt/photo URLs are absolute
  // http(s)), so this is rejected outright before the scheme check even runs.
  if (stripped.startsWith('//')) {
    throw new UnsafeAttributeError(
      `el(): refusing a protocol-relative ${attr} ("//...") on <${tag}> — resolves cross-origin; DB-sourced URLs are absolute http(s), a same-site path never starts with //`,
      { tag, attr, value },
    );
  }
  const match = stripped.match(SCHEME_PATTERN);
  if (!match) {
    // FINAL REVIEW, finding 1 (second part): "SCHEME_PATTERN didn't match" is NOT the same fact as
    // "there is no scheme here." A colon still sitting in scheme position — before any '/', '?' or
    // '#' — is a scheme the browser will try to resolve, even when the token in front of it isn't
    // well-formed by our own pattern (percent-encoded scheme chars, a digit- or underscore-leading
    // token, anything a future browser quirk normalizes). Treating that as "relative" is exactly
    // the failure mode this whole finding is about, so it is REFUSED here rather than falling
    // through to the allowRelative branch. A real relative path keeps its colon AFTER the first
    // delimiter ('/bill/abc:def', '/search?q=a:b') and is unaffected.
    if (hasColonInSchemePosition(stripped)) {
      throw new UnsafeAttributeError(
        `el(): ${attr} carries a colon in scheme position on <${tag}> but matches no allowlisted `
          + 'scheme — refused rather than treated as a relative path',
        { tag, attr, value },
      );
    }
    if (allowRelative) return; // no scheme -> relative, site-internal path; allowed for href only
    throw new UnsafeAttributeError(
      `el(): ${attr} must be an absolute URL with an allowlisted scheme on <${tag}> (no scheme found, and relative ${attr} is not allowed)`,
      { tag, attr, value },
    );
  }
  const scheme = match[1].toLowerCase();
  if (!allowedSchemes.has(scheme)) {
    throw new UnsafeAttributeError(
      `el(): ${attr} scheme "${scheme}" is not allowlisted on <${tag}>`,
      { tag, attr, value },
    );
  }
}

// Fix round 3 micro-round (task review, NEW-C(b)): a non-throwing predicate version of the src
// guard, for callers that want to CHECK a src BEFORE ever attempting to render it (e.g.
// person-page.js's renderPhoto, which needs to fall back to a no-photo state rather than throw).
// Reuses assertSafeUrlAttr's EXACT logic (control-char stripping, protocol-relative rejection,
// scheme allowlist) instead of a lookalike copy — one copy of every security rule, not two that
// could quietly drift apart.
export function isSafeSrc(value) {
  if (typeof value !== 'string') return false;
  try {
    assertSafeUrlAttr('img', 'src', value, ALLOWED_SRC_SCHEMES, { allowRelative: false });
    return true;
  } catch {
    return false;
  }
}

// attrs allowlist: class/href/id/dataset/src/alt only. Anything starting with "on" (event
// handlers), any non-allowlisted key, and any href/src outside its own scheme allowlist above all
// throw a typed UnsafeAttributeError — a DB string can never become an attribute that executes.
// Every other non-allowlisted key throws too (allowlist, not blocklist): widening it is a
// deliberate future change, not an accident of a forgotten case. (alt needs no scheme guard — it
// is plain text, and setAttribute never parses a string as markup.)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key.toLowerCase().startsWith('on')) {
      throw new UnsafeAttributeError(
        `el(): refusing event-handler attribute "${key}" on <${tag}> — a DB string can never become an attribute that executes`,
        { tag, attr: key },
      );
    }
    if (!ALLOWED_ATTRS.has(key)) {
      throw new UnsafeAttributeError(
        `el(): "${key}" is not in the attrs allowlist (class, href, id, dataset, src, alt) on <${tag}>`,
        { tag, attr: key },
      );
    }
    if (key === 'href') {
      assertSafeUrlAttr(tag, 'href', value, ALLOWED_HREF_SCHEMES, { allowRelative: true });
    }
    if (key === 'src') {
      assertSafeUrlAttr(tag, 'src', value, ALLOWED_SRC_SCHEMES, { allowRelative: false });
    }
    if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value || {})) {
        node.dataset[dataKey] = dataValue;
      }
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      // The load-bearing line: DB-sourced text always becomes a text node, never parsed as
      // markup — this is what makes `<img src=x onerror=alert(1)>` inert everywhere el() is used.
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

export function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export class InvalidSectionStateError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'InvalidSectionStateError';
    Object.assign(this, meta);
  }
}

const VALID_STATES = new Set(['loading', 'failed', 'empty', 'ready']);

const STATE_DEFAULT_MESSAGE = {
  loading: 'Loading…',
  empty: 'No data recorded.',
  failed: 'Could not load this section.',
};

// state ∈ 'loading' | 'failed' | 'empty' | 'ready'. Skip≠empty extends to the UI (design spec
// §Non-negotiables): 'empty' ("no recorded votes for this period") and 'failed' ("couldn't load
// — retry") are always visually and semantically distinct, never collapsed into one blank state.
// 'ready' just clears the container — the caller fills in the real content immediately after;
// there is nothing generic to render for it.
//
// Fix round 1 (task review, finding 3): an unrecognized state (a simple caller typo, e.g. 'error'
// instead of 'failed') used to fall through the two `if`s below and render an empty <p> with no
// text — exactly the plan's forbidden "a failed fetch renders as an empty section" (design spec
// §8), just reached a different way. Fail loud instead: validate the enum before touching the DOM.
//
// task-9 review round 2, NEW-2 (MEDIUM): a 'failed' state used to ALWAYS render the retry button,
// even when no `onRetry` was given — a determinate not-found (a well-formed id that plainly does
// not exist in our data; a malformed URL that could never resolve differently on retry) has no
// meaningful retry action, so the button just silently no-op'd on click. A dead control is worse
// than either honest alternative (no button at all, or a real one) — it invites a click that does
// nothing and gives no sign why. The retry button now renders ONLY when the caller passes a real
// `onRetry` function; every existing 'failed' call site across the site already does this (see the
// per-page not-found/retry call sites — grepped at review time, no behavior change for any of
// them), so this is purely additive for the one call shape (`onRetry` omitted) that never had a
// working retry to begin with.
export function sectionState(container, { state, message, onRetry } = {}) {
  if (!VALID_STATES.has(state)) {
    throw new InvalidSectionStateError(
      `sectionState(): "${state}" is not a valid state (loading, failed, empty, ready)`,
      { state },
    );
  }
  clearChildren(container);
  if (state === 'ready') return;
  const text = message || STATE_DEFAULT_MESSAGE[state] || '';
  container.appendChild(el('p', { class: `section-state section-state-${state}` }, text));
  if (state === 'failed' && typeof onRetry === 'function') {
    const retryBtn = el('button', { class: 'section-state-retry' }, 'Retry');
    retryBtn.addEventListener('click', onRetry);
    container.appendChild(retryBtn);
  }
}

// Task 10: the real footer (design spec §6, "This page is linked from every footer"; task-10
// brief, verbatim contract: 'Every fact links to its source. · [How this works](/trust) ·
// [Data freshness](/trust#freshness) · [Attribution](/trust#attribution)'). Every page (index,
// person, legislator, bill, and the trust page itself) calls this SAME function via the SAME
// `<footer id="site-footer">` mount point — one wording, never a lookalike copy per page.
export function mountFooter(node) {
  clearChildren(node);
  node.appendChild(el('p', { class: 'footer-tagline' }, 'Every fact links to its source.'));
  const nav = el('nav', { class: 'footer-links' });
  nav.setAttribute('aria-label', 'About this site'); // not in el()'s attrs allowlist; set directly.
  nav.appendChild(el('a', { href: '/trust' }, 'How this works'));
  nav.appendChild(el('a', { href: '/trust#freshness' }, 'Data freshness'));
  nav.appendChild(el('a', { href: '/trust#attribution' }, 'Attribution'));
  node.appendChild(nav);
}
