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

const ALLOWED_ATTRS = new Set(['class', 'href', 'id', 'dataset']);

// attrs allowlist: class/href/id/dataset only. Anything starting with "on" (event handlers) and
// any javascript: href throw a typed UnsafeAttributeError — a DB string can never become an
// attribute that executes. Every other non-allowlisted key throws too (allowlist, not blocklist):
// widening it is a deliberate future change, not an accident of a forgotten case.
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
        `el(): "${key}" is not in the attrs allowlist (class, href, id, dataset) on <${tag}>`,
        { tag, attr: key },
      );
    }
    if (key === 'href' && typeof value === 'string' && value.trim().toLowerCase().startsWith('javascript:')) {
      throw new UnsafeAttributeError(`el(): refusing a javascript: href on <${tag}>`, { tag, attr: key, value });
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
export function sectionState(container, { state, message, onRetry } = {}) {
  clearChildren(container);
  if (state === 'ready') return;
  const text = message || STATE_DEFAULT_MESSAGE[state] || '';
  container.appendChild(el('p', { class: `section-state section-state-${state}` }, text));
  if (state === 'failed') {
    const retryBtn = el('button', { class: 'section-state-retry' }, 'Retry');
    retryBtn.addEventListener('click', () => {
      if (typeof onRetry === 'function') onRetry();
    });
    container.appendChild(retryBtn);
  }
}

// Task 10 fills the real footer (attribution links, trust-page link — design spec §6). This
// scaffold renders honest placeholder text so no page ships with a blank/broken footer meanwhile.
export function mountFooter(node) {
  clearChildren(node);
  node.appendChild(el(
    'p',
    { class: 'footer-placeholder' },
    'VisibleGov — source attribution and the trust page link here (Task 10).',
  ));
}
