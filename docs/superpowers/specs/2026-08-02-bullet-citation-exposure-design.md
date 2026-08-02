# Bullet citation exposure — design

**Status:** spec approved via adversarial review; implementation NOT yet started (draft-then-apply —
Lance applies the migration himself, per standing convention). 2026-08-02.

## Why

`trust.html` already claims: *"Every published fact carries its own receipt: a link to the official
source, and, where the fact is drawn from a larger document, the exact quoted excerpt it came
from."* That claim is currently false for `what_it_does` bullets — the bill page shows only a
section citation (e.g. "(Sec. 4)"), never the quote. The quote already exists: `src/lib/verifier.js`'s
adversarial support check produces an `evidence_quote` per bullet (an exact verbatim excerpt from the
bill text) as part of every verification pass. It has never been surfaced publicly — not even on the
internal staff review page. This closes that gap: readers get the bill's own words, one click away,
without the plain-language summary losing its role as the primary reading surface (Lance,
2026-08-02: *"It is more important for people to be able to understand the bill"* — quote-on-demand,
never quote-instead-of-paraphrase).

Scope is deliberately narrow: `what_it_does` bullets only. `stated_purpose` doesn't need this
treatment — `checkStatedPurposeGrounding` already requires it to appear verbatim in the bill text to
publish at all, so the purpose text itself already *is* its own grounded quote.

## Design

### 1. Data layer (migration, Lance applies)

Recreate `public_verification_notes` (same deliberate pattern already used in migrations 0019 and
0020 — no `security_invoker`; `summary_verifications` stays service-role-only; the view's own
`WHERE` clause is the entire access wall) adding one computed column:

```sql
citations = case
  when sv.kind = 'support' and sv.overall = 'clean' then (
    select jsonb_agg(jsonb_build_object(
      'bullet_index', (v->>'bullet_index')::int,
      'section', v->>'section',
      'evidence_quote', v->>'evidence_quote'
    ))
    from jsonb_array_elements(sv.verdicts) as v
  )
  else null
end
```

`reason` and `supported` are deliberately never selected into `citations` — `reason` is the
verifier's own free-text commentary, not a fact from the bill; `supported` is redundant once gated
(see below) and its presence/absence is itself the leak vector if handled carelessly.

**Gate on `overall = 'clean'`, not just `kind = 'support'` — this is load-bearing, not decoration.**
Adversarial review (Fable 5, 2026-08-02) found the original draft of this design gated only on
`kind='support'` and relied on "a summary can only be `published` if `assessVerdicts` derived
`overall='clean'`" — which is true of the `classifyRecordItem` → `autoPublishSummary` auto-publish
path (`src/cli/summary-queue.js:527-595,614-632`) but **not enforced by the manual review-server
publish path** (`src/review/server.js:461-481`), which transitions draft → approved → published with
no look at `summary_verifications` at all, and no DB constraint ties the two together. Lance's own
review queue (98 items, all currently `flagged`) has that manual publish button as its only lever —
the day one of those gets manually published, its support row would carry `supported:false` verdicts
whose `evidence_quote` can be a quote that *contradicts* the bullet (`VERIFY_SCHEMA` allows this by
design — the whole point of the field is showing what the verifier checked, pass or fail). Stripping
`supported`/`reason` from a *flagged* row would present a contradicting quote as if it supports the
claim. Gating the computed column on `overall='clean'` closes this mechanically, independent of
which publish path was used, and independent of whether every future publish path remembers to
re-check verification. (Audited live: today's 115 published summaries are all `overall='clean'` with
every verdict `supported=true` — nothing currently at risk. The gate is about invariant safety going
forward, not fixing a live incident.)

`kind='completeness'` rows always get `citations = null` — their `verdicts` column holds a different
shape entirely (`{key_provisions, coverage}`, no `bullet_index`/`evidence_quote`).

Note for the migration's own comment: this is a deliberate reversal of migration 0019's documented
posture ("verification detail is a staff review tool, not a public-facing claim in its own right") —
name that reversal explicitly in the migration file, don't let it read as an oversight.

### 2. Fetch layer

`site/js/bill-page.js` already fetches `public_verification_notes?summary_id=eq...` (line 677) for
the existing "Verified" note. Extend that fetch to also read `citations`, then index by
`bullet_index` for the bullet-rendering loop to look up.

**Key strictly on `bullet_index` — never cross-check against parsed section text.** Adversarial
review found 2 live published summaries (16 verdicts total) where `parseBullets`'s section extraction
and the verifier's own recorded `section` string differ slightly (a `parseBullets` quirk when a
section string itself contains `" ("`, e.g. verified `'Section 143.121, subsection 10(1)(b) and (c)'`
parses to `'c)'`). `bullet_index` still aligns correctly in both cases — position, not the section
string, is the reliable key. A lookup that additionally sanity-checks "does the parsed section match
the verdict's section" would false-fail real, currently-published rows. Don't add that check.

A bullet whose `bullet_index` has no matching citation entry (fetch failure, `citations` null, index
out of range) falls back to today's plain, non-interactive `<span class="bill-summary-bullet-section">`
— never a broken or empty toggle.

### 3. UI layer

New `buildCitationToggle` function in `site/js/bill-page.js`, shaped like (not sharing code with —
different data, different call site) `site/js/glossary-inline.js`'s `buildMarkedTerm`/
`buildGlossDetail`: an accessible toggle (`tabIndex=0`, `role="button"`, `aria-expanded`, click +
Enter/Space) that reveals a hidden sibling `<blockquote>` holding the exact `evidence_quote`. Replaces
today's plain `<span class="bill-summary-bullet-section">` at `site/js/bill-page.js:473`. The detail
block is appended as a sibling within the bullet's `<li>`, never nested inside inline content — same
constraint this file's own comments already document at lines 456-462/468-470 for the glossary
details, and confirmed by reading the code directly that a block-level sibling inside `<li>` is valid
here (bullets, unlike the purpose `<p>`, can hold block children directly).

Citations only ever render on the `formattingVerified` branch (`bill-page.js:453`) — the plain-text
fallback branch never attempts them, matching how it already skips glossary marking for the same
reason (the parsed structure can't be trusted there).

### 4. `trust.html`

No copy change. The existing sentence becomes true for the cases this feature covers. It is *not* a
full invariant — a summary with no support row, a fallback-rendered summary, or (pre-gate) a
flagged-but-manually-published summary would still show no excerpt — but the manual-publish gate in
§1 keeps that gap from ever becoming a false "we quoted it" claim; it just means "no receipt shown"
in those cases, which is what the existing fallback-to-plain-span already does honestly elsewhere on
this page.

### 5. Known residual (not closed by this feature; logged, not fixed here)

`src/review/server.js`'s `edit` action can rewrite a summary's `body_md` without invalidating or
re-running its existing verification row (`verify.js`'s `loadAlreadyVerifiedIds` skips any summary
that already has a row — `verify.js:101-112`). In principle this could let a summary reach
`published` with bullets that no longer match the order/count the verdicts were checked against,
producing a `bullet_index` lookup that returns a real but *stale* quote for the wrong point. Zero live
occurrences (audited). This is a pre-existing gap in the review server's edit flow — it affects the
"Verified" badge's accuracy in general, not something this feature introduces — and is out of scope
here. Two ways to close it later, for whoever picks this up: invalidate verification rows on `edit`,
or refuse manual publish when an `edited` note postdates the latest verification row.

## Testing

- `tests/probe-public-surface.test.js`: extend `checkRequiredColumnsPresent` beyond its current
  superset-tolerant check (adding `citations` currently passes with *no* assertion about its content
  — that's a real gap this change must close, not inherit). Add content-level assertions: `citations`
  never contains `reason`/`supported` keys; `null` for `kind='completeness'` rows; `null` for any
  `kind='support'` row where `overall != 'clean'`.
- `tests/bill-page.test.js` (existing DOM regression tests around line 812+): add a case rendering a
  bullet with a citation available (toggle present, quote hidden by default, click/Enter reveals it)
  and one with no citation available (falls back to the plain span, no broken/empty toggle).

## Non-goals

- No LLM calls anywhere in this feature — it displays data already computed and stored during
  verification. Zero marginal cost.
- Not closing the edit-then-publish drift gap (§5) as part of this work.
- Not changing `stated_purpose` rendering.
