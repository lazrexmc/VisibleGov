# Public Site Design — Plan 3 (profile-first)

**Status: APPROVED by Lance 2026-07-30** ("I agree, proceed"), after two explicit decisions:
architecture = **live fetch on a static shell** (Cloudflare Pages serves HTML/JS; the browser
queries Supabase anon REST at view time), and launch mode = **deploy early, grow live** (wire
Cloudflare Pages at the first vertical slice; nothing links to it until Lance says so).

**Product statement (Lance):** the politician profile is the product. A user looks up any
politician and sees who they are, how they voted, what they sponsored — every fact traceable to
the actual record, in plain language where a verified summary exists, with zero editorializing.

## Non-negotiables inherited by every section

- Mechanically neutral: same treatment regardless of party. No scorecards, ratings, or any
  "grading" of legislators — that is editorializing and is permanently out, not deferred.
- Every legislator gets a page. Curating who is "worth" a page is an editorial act. Thin data
  renders as honestly thin, never padded, never hidden.
- Nothing renders that is not in the DB with provenance. The client never invents display facts.
- Public rendering carries receipts: source link + (for summaries) the supporting citation, per
  trust model v3.
- Anon Supabase key + RLS is the entire security wall. The anon key in `config.js` is public by
  design.
- $0/month: Cloudflare Pages free tier + the existing Supabase project. No new paid services.
- Skip≠empty extends to the UI: "no data recorded" and "failed to load" are always distinct
  states.

## 1. Architecture

- `site/` directory in this repo. Cloudflare Pages auto-deploys it on push to main. No build
  step, no framework, no bundler: plain HTML/CSS/JS served as-is.
- `site/config.js`: Supabase URL + anon key.
- Shared modules (ES modules, browser-native):
  - `site/js/rest.js` — anon REST client. Carries the browser version of `selectAll` (range
    pagination until exhausted) and a paged fetch helper (range headers + count). The 1000-row
    PostgREST cap is handled here, on day one, for every consumer.
  - `site/js/render.js` — DOM helpers. ALL database text enters the DOM via `textContent`
    (the review server's escaping discipline). No innerHTML for DB-sourced strings, ever.
  - `site/js/receipts.js` — maps provenance fields (source URLs, journal artifacts, roll-call
    identifiers, summary citations) to "see the source" links and quote renderings.
- No server code in v1, with one narrow allowed exception (§5, geocoder CORS proxy).

## 2. URLs and identity

- Clean paths via Cloudflare Pages `_redirects` rewrites (`/person/* /person.html 200`, etc.).
- `/person/<person_id>/<name-slug>` — profile of a linked person. The UUID is authoritative;
  the trailing name segment is cosmetic and ignored by lookup.
- `/legislator/<legislator_id>/<name-slug>` — profile of a not-yet-linked legislator row,
  rendered with the same profile template as a single-row career. On load, the page checks the
  row's `person_id`; if it has since been linked, the page forwards to `/person/<person_id>/…`.
  Merges never break URLs.
- `/bill/<bill_id>/<identifier-slug>` — bill page. `/` — directory + address lookup.
  `/trust` — the trust page.

## 3. The profile page (the product)

Data flow (parallel anon fetches):
- Identity: person + person_links + legislator rows (or the single row); display_name as stored
  (mechanical precedence — never edited client-side); party/chamber/district from the most
  recent term; career span from all terms across MO + federal; photo URL derived from
  bioguide_id at render time (the ruled no-column decision) with a clean no-photo fallback for
  state-only careers.
- Votes: `vote_casts` for all linked legislator ids, paginated newest-first (50/page), each row
  embedding vote → bill (identifier, title). Position rendered **as printed**: yea / nay /
  not voting / absent — never collapsed or reinterpreted. Where the bill has a **published**
  summary, its one-line plain-language description renders under the bill title; absent that,
  the title alone — no gap-filling.
- Sponsored bills: `bill_sponsors` for the linked ids, embedding bill + status; sponsor_type
  labeled honestly (primary / cosponsor / joint / unspecified — the 0015 vocabulary, as the
  source printed it).
- Receipts: every vote row links to its source record (roll-call URL / journal artifact via the
  vote's provenance); every sponsorship links to the bill page which links to the official bill.
- Freshness box: what is ingested and through when, per source, from the freshness view (§7);
  quarantined journal days appear as an honest count ("N days pending human review"), not
  silence. Rollover-aware: session boundaries labeled so a January-2027 visitor sees "103rd
  General Assembly (2025–2026)" data labeled as such, not implied-current.
- Reconciliation flags: any displayed vote carrying a reconciliation flag shows a badge linking
  to the trust page's explanation. Primary-source display wins, per the quarantine doctrine.
- Missed-votes view: a filter over the same cast list (not voting / absent), presented as the
  printed positions they are — no percentage, no comparison to peers (that is a scorecard).

## 4. The bill page

- Facts always: identifier, title, status (the source's printed status string), session,
  sponsors (typed), per-chamber roll calls with printed tallies, link to the official bill text
  at the canonical source. MO bills carry the not-official-copies disclaimer.
- Summary when published: the current published summary rendered with stated purpose, each
  what-it-does bullet with its section citation, referenced-terms glossary popovers (published
  glossary entries only), and the verification note (author model, verifier model, verified
  date) — the receipt that this text passed adversarial verification.
- No published summary → an explicit "no plain-language summary yet" line. Never a generated
  placeholder.
- Raw bill text is never dumped on the page: receipts quote what they need; the official source
  link carries the rest. (`bill_texts` stays unexposed to anon — §7.)

## 5. Directory + address lookup (the front door)

- Directory: one paginated fetch of legislators/persons (name, chamber, party, state, district,
  linked-person grouping), client-side filter/search. At ~1,576 rows this needs no search
  backend.
- Address lookup: Census Geocoder (free, keyless) — address in → congressional district + MO
  SLDU/SLDL out → match against current terms → "your people," federal + state.
- Privacy contract (Lance's ruling, stated verbatim on the page): the address is sent to the
  Census Geocoder, districts come back, and **nothing is stored or logged — not by us, not
  ever**. If browser CORS requires it, a minimal Cloudflare Pages Function proxies the geocoder
  call as a no-logging pass-through (the one allowed piece of server code); the privacy contract
  is identical either way and the function's no-logging property is a review-blocking
  requirement, not a comment.

## 6. The trust page

- The pipeline, told plainly: official sources in → mechanical reconciliation (casts must equal
  printed tallies or nothing stores) → summaries authored from official text only → adversarial
  verification → mechanical completeness gates → publish with receipts; flagged items wait for
  human review and say so.
- What a reconciliation flag means; what a quarantined journal day means; why disputes render
  primary-source-first.
- Live counts fetched anon (vote casts, bills, legislators, published summaries) — the same
  numbers the DB actually holds.
- Attribution: LegiScan CC-BY 4.0 (required by their terms), Congress.gov, senate.gov,
  house.mo.gov, Missouri Revisor not-official-copies disclaimer, Census Geocoder.
- This page is linked from every footer.

## 7. Migration 0016 — the public read surface (draft-then-apply; Lance runs it)

Audit at plan time of exactly which tables the site reads; the migration adds only what is
missing:
- Anon SELECT where absent among: legislators, terms, votes, vote_casts, bills, sessions,
  jurisdictions, persons (has it), bill_sponsors (has it), summaries (published-only policy
  exists), glossary (published-only).
- A `public_person_links` view exposing only (person_id, legislator_id) — the site needs the
  mapping, not the evidence payloads or decided_by; the full audit trail stays internal and the
  trust page describes it in prose instead.
- A `public_freshness` view over ingestion_runs exposing source, status, finished_at only —
  run internals stay internal (the slice-1 final-review item 10d, finally built).
- A reconciliation-flags read surface (view) exposing the flag's factual content (vote, nature
  of discrepancy, sources) minus any internal notes.
- A `public_verification_notes` view over summary_verifications exposing (summary_id,
  verifier model, verified date, overall verdict) — exactly what the §4 verification note
  renders, nothing more.
- Explicitly NOT exposed: bill_texts (site never needs raw text), identity_flags,
  editor_notes/audit internals, ingestion_runs beyond the freshness view, summary_verifications
  beyond the note view.

## 8. Errors and testing

- Every fetch has three UI states: loaded, honestly-empty ("no recorded votes in our data for
  this period"), and failed ("couldn't load — retry" with a retry action). A failed fetch never
  renders as an empty section.
- Pure logic (formatting, receipt-URL building, term-selection, pagination math, district
  matching) lives in the shared modules and gets node:test coverage; DOM rendering is smoke-
  tested with jsdom (existing dev dep). REST payload fixtures are captured real responses.
  No live-DB tests in the suite.
- Manual smoke checklist per page ships in the plan (real phone + desktop, throttled network).

## 9. Not in v1 (deliberate)

Accounts, comments, analytics/tracking of any kind, scorecards/ratings (permanently out, §Non-
negotiables), SEO pre-rendering (additive later step — the architecture choice explicitly
preserved it), on-demand ingestion (TODO 11), admin surfaces (the review server stays local),
full-text search beyond the client-side directory filter, historical-boundary address lookup
(current districts only, labeled as such).

## Build order

1. Vertical slice: Onder's profile end-to-end (identity + votes + sponsors + receipts +
   freshness) against live anon REST — proves §1–3 and §7.
2. Cloudflare Pages deploy (the early-deploy decision) — real URL, unlinked.
3. Directory + address lookup (§5).
4. Bill pages + glossary popovers (§4).
5. Trust page + footers everywhere (§6), final polish pass.

## Success criteria

Lance's own definition of finished: "users can look up any politician and see their info."
Concretely for v1: any of the 1,576 legislator rows (or their merged persons) resolves to a
profile URL that renders identity, votes with receipts, and sponsorships from the live DB; an
address in Missouri returns its three representatives; every rendered fact can be clicked
through to the official record; the whole thing costs $0/month.
