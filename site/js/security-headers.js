// site/js/security-headers.js — the security headers a Cloudflare Pages FUNCTION must set on its
// own responses, because Pages Functions do NOT inherit site/_headers.
//
// WHY THIS FILE EXISTS. `site/_headers` governs static assets only. Cloudflare's own docs are
// explicit that a Pages Function's Response is returned as-is — `_headers` never touches it. So
// production `/geocode` responses carried ZERO security headers (no CSP, no nosniff, no
// Referrer-Policy) while every static page carried the full set, and local dev hid the gap
// entirely: `scripts/serve-site.js` parses `_headers` at runtime and applies it to EVERY response
// including `/geocode`, so the dev server looked correct and only production was bare. Found in
// the 2026-08-03 Cloudflare deploy-spec review, fixed here as a pre-deploy item.
//
// WHY A THIRD COPY IS NOT BEING CREATED. There are already two consumers of these values, and
// they share one source: `site/_headers` (production static assets) and `serve-site.js`, which
// PARSES that same file rather than hand-copying it. A Function cannot do that — it has no
// filesystem at runtime, so it needs the values as a static import bundled at deploy time. That
// makes this file a genuine second source, and the only honest way to keep a second source safe
// is to make drift FAIL LOUDLY: `tests/site-modules.test.js` asserts this object and the `/*`
// block of `site/_headers` are exactly equal, key for key and value for value. Change one without
// the other and the suite goes red. Follow the `site/js/copy.js` precedent (PRIVACY_CONTRACT_TEXT,
// one string rendered in two places, pinned by a test) — same problem, same shape of answer.
//
// WHY THE FULL SET, INCLUDING CSP, ON A JSON RESPONSE. `X-Content-Type-Options: nosniff` and
// `Referrer-Policy: no-referrer` are directly load-bearing here (stop a browser MIME-sniffing the
// JSON body into something executable; keep the referrer off the outbound hop). The CSP is largely
// inert on a JSON payload — but sending the identical set costs nothing, removes a "which headers
// does this response get?" judgment call from every future edit, and keeps production byte-identical
// to what `serve-site.js` already serves locally. Divergence between dev and production is exactly
// what let this bug hide for as long as it did.
//
// KEEP IN SYNC WITH `site/_headers`'s `/*` block. The test will not let you forget.
export const FUNCTION_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' https://bplxjbhlyyeucuwfqcbp.supabase.co; img-src 'self' https:; script-src 'self'; style-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
