# Final fix wave — report

Branch `public-site`, from HEAD `6631bb8` (verified at start). All 6 confirmed findings from
Task 11's final review are closed. Suite: **1726 pass / 0 fail** (baseline 1686 + 40 new), bare
`node --test` from the repo root. Every fix TDD'd red-first; findings 1, 5, 6 and the freshness
rendering additionally verified in a real browser against production data.

## Commits

| Hash | Scope |
|---|---|
| `2b59e2f` | CRITICAL href/src guard bypass (full WHATWG C0 strip) + CSP defense in depth |
| `ba05630` | Migration 0019 draft (view row-scoping + latest-FINISHED freshness) + probe row gates |
| `8d34665` | LegiScan roll-call date guard (code half only) |
| `c4e7320` | fetchAllRows order+backstop, directory party precedence, freshness wording |

## 1 (CRITICAL) — render.js URL guard, `2b59e2f`

The strip set was `\t\r\n`: three of the thirty-three codepoints a URL parser removes. A href of
U+0001 + `javascript:alert(1)` parses to a real javascript: URL (executes on click) while the guard
saw a scheme-position token of U+0001 + `javascript`, matched no scheme, and treated the value as a
relative site path. The earlier ledger claim that the strip "mirrored WHATWG" was false.

Three parts:
- `URL_STRIP_PATTERN` now covers the whole U+0000-U+0020 range, applied leading/trailing/embedded, before both the `//`
  check and the scheme test (the character class is the escaped U+0000–U+0020 range; see the source
  for the exact literal). Deliberately broader than the parser's own asymmetry — over-stripping
  can only ever reject more, and the value written to the DOM is always the caller's original
  string.
- "no allowlisted scheme matched" no longer means "relative": a colon in scheme position (before any
  `/`, `?`, `#`) throws. Catches percent-encoded and digit/underscore-leading scheme tokens. A colon
  after the first delimiter (`/bill/abc:def`, `/search?q=a:b`, `/trust#a:b`) still resolves as a
  relative path.
- the `typeof value !== 'string'` early RETURN — a silent bypass of every rule, since setAttribute
  stringifies whatever it gets — is now a typed throw. `isSafeSrc` keeps its non-throwing `false`
  (predicate form by contract). All DB-sourced href/src call sites were checked: every one is
  truthiness-guarded and try/caught, so the new throw degrades to the existing honest notices.

Tests pin **every** C0 codepoint in both leading and embedded position, for `javascript:`, `data:`,
and the protocol-relative form, on both `href` and `src`.

**CSP (defense in depth, never instead of the guard).** New `site/_headers`:

```
default-src 'self'; connect-src 'self' https://bplxjbhlyyeucuwfqcbp.supabase.co;
img-src 'self' https:; script-src 'self'; style-src 'self'; base-uri 'none';
object-src 'none'; form-action 'self'; frame-ancestors 'none'
```
plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

Two mechanical changes were required to hold `script-src 'self'` with no `'unsafe-inline'` and no
per-file hash: each page shell's inline module bootstrap moved to an external `/js/boot-*.js`, and
the `data:` SVG favicon became a real `/favicon.svg` (so `img-src` needs no `data:` allowance).
`style-src 'self'` is genuinely sufficient — `el()`'s attrs allowlist has no `style` key, and
vote-charts.js sets bar widths through the CSSOM, which CSP does not govern.

`scripts/serve-site.js` **parses `site/_headers`** and serves the same headers on every response
(200/404/400/geocode) — one source of truth, no hand-copied second set. A test pins `connect-src`
against `site/config.js`'s own `SUPABASE_URL`, and another asserts no page shell has an inline
`<script>` and that each boot module is actually served (a 404 there would be a page whose script
never runs).

Live smoke under the CSP: directory (full legislator list), trust page (freshness + live counts),
profile (photo, identity, charts) — all render, zero console errors, zero CSP violations.

## 2 + 4 — migration 0019 draft, `ba05630` (LANCE APPLIES)

`supabase/migrations/0019_view_scoping_and_freshness.sql`. Both views keep 0016's owner-bypass
posture (no `security_invoker`) — the column list and WHERE clause *are* the policy.

**(a) public_verification_notes** handed anon 23 unpublished summaries' verification rows, including
all 9 flagged verdicts awaiting review. `summary_verifications` has no anon policy at all (0004:
service role only) and the view selected the whole table. Recreated with
`where exists (select 1 from summaries s where s.id = summary_id and s.status = 'published')` — the
same scoping `summaries` has anon-side. `prompt_version` also leaves the view.

**(b) public_freshness** served the newest run per source, finished or not, so during every run the
box said "last finished (never)" with zero quarantined days. Split: `finished_at` /
`quarantined_days` / new `last_finished_status` come from the latest run **with** a `finished_at`;
`status` keeps its exact old meaning (newest run's status) so an unchanged renderer is not silently
re-pointed. A genuinely never-finished source keeps `finished_at` NULL.

**Probe extension.** `scripts/probe-public-surface.js` now checks ROW SCOPING, not just column
shapes — checking column lists is precisely why the leak stood. It reads both sets exhaustively in
1000-row chunks and asserts every verification row belongs to an anon-visible published summary;
asserts `finished_at`/`last_finished_status` are always present together and that an
already-finished newest run reports its finish time; and *reports* in-flight runs for human
confirmation rather than asserting something anon genuinely cannot establish (ingestion_runs is
locked, correctly — a vacuously-true assertion is how finding 2 survived).

Run against production **before** 0019, the extended probe reproduces both findings by execution:

```
FAIL  public_freshness columns exact (0019 shape) — finished_at,quarantined_days,source,status
FAIL  public_freshness: finished_at and last_finished_status are present together, always
FAIL  public_verification_notes columns exact (prompt_version gone) — ...,prompt_version,...
FAIL  public_verification_notes is scoped to anon-visible PUBLISHED summaries — 33 note row(s)
      over 33 distinct summaries; 10 published summaries visible to anon; 23 unpublished leak(s)
```

**Lance gate:** apply 0019, then `node --env-file=.env scripts/probe-public-surface.js` (expect all
PASS, exit 0).

## 3 — ingest date guard (code half only), `8d34665`

Live-confirmed the data half first: 10 rows, all `legiscan-1530-rollcall-*`, all
`vote_date 1969-12-31`, all "Senate: Third Reading". **The data correction is not in this wave** —
it joins the MO-status Lance-approval batch.

`legiscan-votes.js` gains typed `LegiscanRollCallDateError` +
`assertRollCallDateWithinSession(rollCallId, date, sessionYears)`, run **first** inside
`reconcileLegiscanTallies` before any counting. Two typed reasons: `outside_session_years` and
`unparseable_date` (verified beforehand that no production row has a null `vote_date`, so refusing
that class breaks nothing). `ingest-legiscan.js` reads `sessionYears` from the same envelope fields
`sessionWindow` already uses and `ingestLegiscanRollCalls` **requires** it — a silently-absent bound
would degrade the gate to a shape check while still looking present. The refusal rides the existing
reconciliation-failure machinery (counted, detailed, excluded from the sibling-grouping pool),
mirroring the tally-refusal pattern exactly.

Driver test uses a two-roll-call synthetic dataset: 501 carries the sentinel, 502 a real in-session
date. 501 refuses and is counted; 502 still stores with its casts — the good sibling still storing
is the load-bearing half, since a guard that refused the whole dataset would be its own bug.

## 5 — fetchAllRows, `c4e7320`

`order` option appended to every chunk request, passed by every call site: legislators / persons /
terms / bill_sponsors / vote_casts by uuid `id`; the three matviews by their own unique-index column
sets from 0018 (matviews have no `id`). Accumulated rows are cross-checked against the content-range
total; a mismatch in either direction throws a typed `RestError`. A server reporting no total is
never turned into a fabricated failure. Chunk-gap simulation (total 1500, 1400 rows) and the excess
case both pinned. Live-verified: the directory's >1000-row two-chunk reads and all three matview
reads work against real PostgREST.

## 6 — directory party fallback, `c4e7320`

`SOURCE_PRECEDENCE_COLUMNS` and a shared `partyBySourcePrecedence()` are now exported from
profile-model.js (and `resolveParty` calls the shared helper, so there is one ranking loop, not two).
directory-page.js imports it. Tested with the exact Curls construction in both input orders, plus a
both-rows-carry-a-party precedence case, term-wins-over-row, and never-invented-null.

Browser-verified after the fix against production: the directory renders
`Shalonn "Kiki" Curls — D`, matching her profile.

## Freshness rendering (finding 4's UI half), `c4e7320`

New `site/js/freshness.js` owns the wording for both surfaces (profile box, trust table) — the
slugs.js precedent, not two format strings that can drift. A running source reads as in-progress
*alongside* its last finished date and standing quarantine count; a never-finished source reads
"(no completed runs)". Both fetches drop their explicit `select=`: naming the four old columns would
drop `last_finished_status` after the migration lands (and that column is exactly what the shape is
detected on), while naming it before would 400.

The pre-apply fallback is feature-detected per row on the **column's presence** (a never-finished
source has a real null there) and is live code today, not dead code. It keeps the old wording
verbatim with one free honesty correction: a running row with no `finished_at` reads "(unknown while
a run is in progress)", never "(never)", because the old shape genuinely cannot tell those apart.
Both shapes are DOM-tested; the fallback retires when 0019 is applied (marked in the module header).

## Concerns / ledger

1. **Lance gate: apply 0019**, then run the probe (exit 0 expected). Until then the site serves the
   old shape through the tested fallback, and the 23-row verification leak stands.
2. **Lance gate: the 1969-12-31 data correction** (10 rows, session 1530) — joins the MO-status
   approval batch. The guard stops new ones; it does not retract stored ones. Onder's live 1969
   chart bucket persists until that runs.
3. **Probe deviation from the brief, deliberate.** The brief asked the probe to assert
   `public_verification_notes` row count *equals* the published-summaries count. That would
   false-fail whenever a published summary has zero or two-plus verification rows — both real
   states. The probe instead asserts the actual leak gate: every note's `summary_id` is in the
   anon-visible published set, and reports both counts. Strictly stronger where it matters, and it
   cannot cry wolf.
4. **Probe deviation on the running-row assertion.** "A running row still carries `finished_at` when
   any finished run exists" is only decidable against `ingestion_runs`, which anon cannot read. The
   probe asserts the strongest mechanical invariants it genuinely can (`finished_at` ⟺
   `last_finished_status`; an already-finished newest run reports its finish time) and *reports*
   in-flight rows for human confirmation rather than passing either way.
5. **CSP `connect-src` hardcodes the Supabase origin.** A static header file cannot read config.js.
   A test pins the two together, so changing `SUPABASE_URL` without the header fails the suite — but
   this is a real coupling to know about at Cloudflare setup time.
6. **T7 gate unchanged and still open:** Cloudflare Pages root directory MUST be `site` — otherwise
   neither `_headers`, `_redirects`, nor the `/geocode` Pages Function is discovered.
7. **New files to deploy:** `site/_headers`, `site/favicon.svg`, `site/js/boot-*.js` (5),
   `site/js/freshness.js`. If a deploy is filtered by an allowlist anywhere, these need adding.
8. **Pre-existing dev servers on 8990/8991** are running stale code from an earlier session
   (`EADDRINUSE` on both); the browser smoke ran on 8997 against the current tree. Worth restarting
   whatever holds 8990 before the next manual smoke.
