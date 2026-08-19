# Missouri Statute Glossary Source (revisor.mo.gov) — Design

**Status: APPROVED in brainstorm (Lance, 2026-08-19) — Option A scope: this build ends at
"mapped and gloss-ready." No gloss runs, no spend. Design was audited against live data and the
live source before this spec was written (see §10); two errors in the pre-audit design were
found and corrected here (§4 access policy, §5 response-identity).**

## 1. Why

The glossary backlog is dominated by Missouri statute citations the pipeline structurally cannot
map: `parseCitation` (src/adapters/uscode.js) only understands U.S. Code shapes, so every RSMo
citation extracted from the 597 published Missouri summaries lands in `needs_mapping`. Live
measurement (2026-08-19): only **87 of 1,041 published summaries** reference any published gloss.
Simulating this design's exact parser + guard against the live backlog: **2,164 terms unlock**
(1,922 sections + 242 chapters → 1,725 distinct citations), and if all were later glossed,
coverage rises to **565 of 1,041 (54%)**. The top-leverage terms in the entire glossary are RSMo
citations ("chapter 536" cited by 120 published summaries, "section 536.010" by 105,
"section 536.028" by 99 — the MO Administrative Procedure Act boilerplate in nearly every MO
bill). These numbers drift with live growth; re-derive at run time, never cite them as current.

## 2. Source facts (verified live 2026-08-19)

- revisor.mo.gov is the **official** Revised Statutes of Missouri site; its About page states
  statutory language is updated on the effective date (§3.090). Official + current — exactly
  what the facts-only rule requires of a gloss source.
- **Per-section**: `https://revisor.mo.gov/main/OneSection.aspx?section=536.010` serves the full
  statute text. Body opens with a stable marker (`536.010. Definitions. — ...`), carries an
  effective-date line and a historical-versions table.
- **Per-chapter**: `https://revisor.mo.gov/main/OneChapter.aspx?chapter=536` serves the chapter
  title ("Administrative Procedure and Review") plus the official section-number/heading list
  with effective dates. NOT full text.
- **No robots.txt** (redirects to homepage), **no ToU page, no bulk download** (Publications =
  print sales). Footer: "©Missouri Legislature, all rights reserved" — same
  edicts-of-government class as other official sources this project quotes with attribution.
- **A nonexistent section does NOT 404.** It redirects (HTTP 200) to a generic bot-detection
  page. See §4 and §5 — this fact drives two hard requirements.

## 3. v1 scope

**In scope (maps):**
- Single sections: `section 536.010`, `sec. 536.010`, `§ 536.010`, bare dotted `302.309`, optional
  leading `RSMo`, optional trailing `, RSMo` (with an optional canonical year: `, RSMo 2016`,
  `, RSMo Supp. 2023`). The dotted `[1-9]\d{0,2}\.\d{3,4}` shape is RSMo's signature — USC sections
  are never dotted. A trailing subdivision (`536.010.2`, `(1)`) parses but normalizes to the parent
  section: the gloss covers the whole section — broader, never wrong.

**Out of scope (stays `needs_mapping`, honestly):**
- **Chapters** (`chapter 303`) — chapters were dropped from v1 by post-audit ruling (2026-08-19):
  a chapter page is a table of contents — revisor-authored catchlines and cross-references naming
  other chapters' subjects — not statutory text; an adversarial audit demonstrated a verifier quote
  drawn from a cross-reference line could mechanically 'support' a wrong-chapter gloss claim.
  Chapters stay needs_mapping until a design grounds them honestly.
- **Bare low-chapter dotted cites** (`section 2.100`, chapter part ≤ 20, with no `RSMo` marker in
  the text) — Missouri appropriations bills (HB 1-19) number their own internal sections `N.MMM`,
  so a bare low-chapter dotted cite inside a MO bill is ambiguous between a real RSMo section and
  the bill's own internal section. The corroborated forms (`RSMo 1.140`, `section 1.140, RSMo`)
  still map, so stored citations round-trip at gloss time.
- Ranges and lists ("sections 302.302 **to** 302.309", "302.309 **and** 302.341") — no single
  official text; synthesizing across sections is fabrication risk.
- Bare "RSMo" (144 published-summary references) and "Constitution of Missouri" (40) — no
  section text to fetch; each deserves its own ruling later.
- Anything carrying a federal marker (`U.S.C.`, `CFR`, `Public Law`, `United States Code`,
  `Stat.`, `P.L.`) — the parser refuses these outright so it can never claim a federal cite.
- Popular names, gloss runs, subagent gloss lanes, scheduled fetching. All non-goals (§9).

## 4. Binding access constraints (the LegiScan-terms pattern — read before touching fetch code)

revisor.mo.gov has **no published ToU but an enforced automated-access policy**, discovered on
its bot-detection page (verbatim, captured 2026-08-19):

> "Recent accesses are tracked over a thirty second interval. If the time between accesses is
> shorter than one second multiple times in that thirty second interval you might see this page."
> "The system tracks cumulative accesses by IP address, as well as recent accesses."
> Contact for false positives: WebMaster@LR.mo.gov.

Binding rules for this adapter:
1. **Sequential requests only, ≥5 seconds apart** (5× inside their 1s threshold), routed through
   the shared rate limiter (src/lib/http.js). No parallelism, ever.
2. **Fetches happen only at gloss time** (human-triggered, gated batches) and during fixture
   capture. No scheduled or recurring crawling of revisor.mo.gov, no pre-fetching.
3. **Receiving the bot-detection page is a typed hard stop** (`MoBotPageError`): abort the run
   honestly, never retry-hammer. (Same class as the LegiScan 429 lesson.)
4. Excerpts are hash-pinned at gloss time (existing `glossary_verifications` mechanics), so a
   page is fetched once per gloss attempt and never re-fetched to re-verify.
5. Total v1 drain footprint: section pages only (chapters left v1 — see §3), one time, at 5s
   spacing. Re-derive the page count from a fresh dry-run rather than citing this line: the
   2026-08-19 post-audit parser hardening moved it. ~2.4 hours was the pre-drop estimate.

## 5. Architecture

New adapter `src/adapters/mo-statutes.js`, mirroring `uscode.js`'s structure exactly: pure
parse/extract functions carrying the test weight, thin fetch wrappers structurally reviewed.

**Parser** — `parseMoCitation(raw) -> {kind:'section', section} | null` per §3's shapes and
refusals. Pure; jurisdiction is NOT its concern (see guard, below).

**Normalization** — stored `glossary_terms.citation` strings are prefix-discriminated:
`RSMo 536.010` (vs the existing `42 U.S.C. 1396b`). This is the whole
dispatch mechanism — **no schema migration anywhere**. The existing `(kind, citation)` unique
key and the `(kind, term) where citation is null` partial index (migration 0007) work unchanged.

**Dispatch, insert time** — `upsertKeyFor` (src/lib/glossary-terms.js) tries USC parse first;
only when the citing bill's jurisdiction is `mo-legislature` does it try the MO parser.
Jurisdiction lives two hops away (`bills.session_id → sessions.jurisdiction_id`); callers pass
it. All three term-persisting call sites have bill context in scope: `summarize.js`,
`extract-terms.js`, and the record path (`summary-queue.js` via
`persistReferencedTermsGracefully`). Absent context → USC-only, exactly today's behavior, so
nothing changes for callers that don't opt in.

**Dispatch, gloss time** — `fetchGlossSource` (src/lib/glosser.js) routes on the `RSMo ` prefix;
everything else takes the existing USC path. Defensive typed errors on unparseable citations,
matching the existing convention.

**Fetch + extraction** —
- Sections only: excerpt = the statute body from its stable markers plus the enactment-history /
  effective-date line. The revisor's judicial-decision annotations that follow that line (each its
  own paragraph opening with a parenthesized year, e.g. "(1977) Held, …  Krentz v. Robertson, 228
  F.3d 897") are CUT — editorial case-law commentary about the statute, not the statute, and
  quotable as law if left in.
- Reuses `OversizeExcerptError` / `MAX_EXCERPT_CHARS` (exported by uscode.js): an oversize
  section is an honest counted skip, never a truncation.
- **Response-identity verification (hard requirement):** before any extracted text is trusted,
  the isolated slice must BEGIN with the requested section's own number marker — anchored, not
  merely present, so a page that only cross-references the requested section is refused. Because a
  nonexistent section returns HTTP 200 with bot-page content, a naive
  extractor would store bot-page text as statute text — the exact fabrication class this
  pipeline exists to prevent. The bot page's distinctive fixed text ("Are you double clicking
  links? Don't if you are.") is recognized explicitly as `MoBotPageError`; an identity mismatch
  on any other page is its own typed error. (Same principle as the LegiScan response-identity
  hole closed 2026-07-31.)
- Fixtures: real captured HTML for a normal section, a long section, a repealed/transferred
  section, the chapter index, and the bot page. Fixture capture counts against §4's politeness
  budget. The chapter-index fixture stays on disk after the chapter drop (§3): it documents what
  the source actually serves, and is the evidence any future chapter design starts from.

**Jurisdiction guard** — the bare dotted `section 536.010` shape maps to RSMo only
in Missouri context. Insert time: the caller's bill jurisdiction. Backfill: a term maps only if
**every** summary referencing it belongs to a `mo-legislature` bill; zero-reference terms stay
unmapped. Live measurement: the guard blocks 0 terms today (every parse-OK term is exclusively
MO-referenced) — it is insurance against future federal extractions, at zero cost.

## 6. Re-mapping backfill

New CLI (dry-run default, `--apply` gated, run recorded in `ingestion_runs` — the
`backfill-mo-term-dates` conventions). Scans `needs_mapping=true` rows, parses term text,
applies the jurisdiction guard, then:

- **Update in place** (the common case; ~1,725 rows at current counts): set `citation`,
  `needs_mapping=false`; status stays `draft`; row identity, links, and `kind` untouched.
- **Intra-batch collisions — the dominant merge class (439 live):** multiple unmapped term
  texts normalize to the same citation ("section 536.010" / "536.010, RSMo"). Deterministic
  survivor: the row with the most `summary_terms` links; tie → earliest `created_at`, then
  lexicographically smallest id (fully deterministic). Losers merge into
  the survivor: repoint links (insert-if-absent, then delete the old link), then delete the
  now-orphaned row.
- **Collisions with existing mapped rows:** same merge, existing row survives. (Empty class
  live today — all mapped citations are USC-format — handled anyway.)
- **Stub assertion before any merge deletion:** the doomed row must be a bare stub (NULL
  `gloss_md`, zero `glossary_verifications`, zero `glossary_notes`); any row failing this is
  skipped and flagged, never merged. Live today: zero violations.
- **Idempotent and re-runnable:** a second run maps nothing new. Required, because the backlog
  grows daily (the 6 AM scheduler mints new summaries and terms).
- Dry-run prints the full merge plan per collision; Lance sees it before `--apply`.

## 7. Attribution and rendering

Bill pages need zero changes — a MO gloss renders through the existing term / gloss /
source-link / quote machinery, `source_url` pointing at the section's own OneSection.aspx page.
One addition: trust.html's `#attribution` list gains a line covering **both** statute-text
sources (uscode.house.gov and revisor.mo.gov) — the audit found neither is currently listed
there (per-gloss receipts were the only attribution), so this adds the federal line too rather
than claiming parity with treatment that never existed.

## 8. Testing

- Parser TDD'd against the live backlog shapes, both directions: every accepted shape, every
  refusal (ranges, lists, bare RSMo, Constitution, every federal marker).
- Extraction pure functions on captured fixtures, including the repealed-section shape, the bot
  page (typed error), and an identity-mismatch construction (bot-page text must never extract).
- Dispatch tests both ways at both dispatch points; jurisdiction-guard tests both ways (a
  federal-referenced term must never map).
- Backfill logic against the fake client: update-in-place, intra-batch dedup survivor rules,
  merge/repoint, stub-assertion refusal, idempotent re-run.
- Live: dry-run report reviewed before `--apply`; post-apply verification (mapped counts,
  spot-check the top terms, zero USC rows touched). Suite gated on the extracted fail count in
  a clean shell.

## 9. Non-goals (stated so they cannot drift)

No gloss runs and no spend in this build (Option A — at completion Lance gets the exact mapped
count and a real cost estimate for a billed gloss run; the standing per-run approval policy
applies, and the scheduler's ledger carve-out is summaries-only). No subagent gloss lane. No
ranges/lists/bare-RSMo/Constitution mapping. No popular-names work. No scheduled fetching of
revisor.mo.gov. No schema migration.

## 10. Audit trail

The pre-spec design was audited 2026-08-19 against live data (read-only simulation of the exact
parser + guard) and the live source. It found and corrected: (1) "no automated-access policy"
was false — the bot-page policy in §4 exists and is now binding; (2) nonexistent sections
return 200 with bot-page content, forcing §5's response-identity requirement; (3) the
attribution claim in §7's first draft assumed uscode.house.gov treatment that doesn't exist;
(4) jurisdiction is on `sessions`, not `bills`. It confirmed: the glosser contract, the
reusable oversize machinery, the shared rate limiter, all three call sites, and the 0007 key
semantics. All counts in this spec are that audit's snapshot and drift daily.

## 11. Design amendments

**2026-08-19 — three-auditor post-build pass on branch `mo-statute-glossary-source`.** The built
code was audited by three independent reviewers against live data and executed proofs; the
controller ruled the following changes, all applied to this spec above rather than left as code-only
drift:

1. **Chapters left v1 entirely** (§3, §5). Reason recorded verbatim in §3. This is a scope
   reduction, not a deferral of work already done: the chapter parser, URL builder, fetch wrapper
   and extractor were REMOVED from `src/adapters/mo-statutes.js`, and `upsertKeyFor` no longer maps
   a chapter term even in Missouri context. `tests/fixtures/mo-statutes/chapter-536.html` is kept.
2. **Bare low-chapter dotted cites refused** (§3). Missouri appropriations bills number their own
   internal sections `N.MMM`; a bare cite with a chapter part ≤ 20 is ambiguous, so the text must
   carry the `RSMo` marker itself. Stored citations always do, so gloss-time round-tripping is
   unaffected.
3. **Parser hardened** (§3): chapter part `[1-9]\d{0,2}` (no zero/leading-zero chapters), balanced
   subdivision groups only, and acceptance of the canonical `sec.` short form and `RSMo <year>` /
   `RSMo Supp. <year>` suffixes.
4. **Case-law annotations cut from the section excerpt** (§5). Revisor-authored judicial-decision
   commentary is not statutory text; the enactment-history / effective-date line IS kept.
5. **Response-identity check anchored** (§5): the isolated slice must BEGIN with the requested
   section number. Executed proof: `536.010`'s own body cross-references `536.100`, which the old
   contains-anywhere check wrongly accepted as a `536.100` page.

**Counts in §1 and §6 are pre-amendment.** Amendments 1 and 2 both REDUCE what maps, on purpose —
re-derive every count from a fresh dry-run, never from this document.
