// site/js/copy.js — small shared, hand-authored copy strings that must render VERBATIM in more
// than one place on the site (never DB-sourced — nothing here is subject to render.js's own
// DB-text-via-textContent rule, since none of it comes from the database). Extracted so two pages
// stating the same fact in the same words can never quietly drift apart from each other
// (task-10 review, LOW finding 1).

// Privacy contract (design spec §5, docs/superpowers/specs/2026-07-30-public-site-design.md,
// Lance's ruling, verbatim): "the address is sent to the Census Geocoder, districts come back,
// and nothing is stored or logged — not by us, not ever." Rendered on index.html next to the
// address-lookup input (site/js/directory-page.js) AND on the trust page's attribution section
// (site/js/trust-page.js) — both consumers read this ONE string, so a wording change only ever
// happens in one place, and both renderings are guaranteed to stay identical.
export const PRIVACY_CONTRACT_TEXT = 'Your address is sent to the U.S. Census Bureau geocoder to '
  + 'find your districts, and is not stored or logged — not by us, not ever.';
