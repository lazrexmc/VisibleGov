# VisibleGov — Controller Catch-Up Briefing

> **⚠️ Migration-applied-state claims in this document are NOT authoritative — added 2026-08-03,
> senior engineering audit, finding 19.** This is a dated, sequentially-refreshed narrative (see the
> "Refresh pass" paragraphs below) — every claim of the form "migration NNNN drafted, NOT applied"
> or "confirmed live" was true only as of the pass that wrote it, and the file already contains
> several such claims that are now stale (0023/0025 were both applied and verified live 2026-08-03,
> after the last refresh pass below was written; migration 0026 doesn't appear anywhere in this file
> at all). **Never trust this document for current migration-applied state.** The authoritative
> sources are `TODO.md`'s NOW section (kept current as work happens) and a live check — run
> `node --env-file=.env scripts/probe-public-surface.js` or query the database directly. Everything
> else in this document (historical narrative, design rationale, the "why" behind past decisions)
> remains a reliable record of what happened and when — only forward-looking "is X applied right
> now" claims rot.
>
> **Banner refreshed 2026-08-04 — the gap above has widened, not just persisted.** Migrations 0026
> through 0029 all landed 2026-08-03/2026-08-04 and none of them are mentioned anywhere in this
> document's body. The 2026-08-04 session in particular was consumed by a full multi-layer
> `refresh_vote_aggregates()` timeout saga — a Supabase edge-gateway timeout, a Postgres
> `statement_timeout` arm-timing trap, and a query-planner anti-join misestimation, each root-caused
> and fixed in turn (migrations 0027, 0028, 0029) — that this document has zero awareness of below.
> All three layers are now confirmed fixed and live (manual refresh completes in ~19s; real scheduled
> `pg_cron` ticks are succeeding). The core instruction is unchanged: **never trust this document for
> current migration-applied state** — check `TODO.md`'s NOW section or query live instead.

*Compiled 2026-07-31 from 105 SDD ledgers, 5 specs, 9 plans, 4 research docs, 21 migrations, the 925-line CHATLOG, PLAYBOOK_DELTA (17 lessons), TODO.md, DATA_INVENTORY.md, and live code verification.*

*Refresh pass 2026-08-02: sections 3 and 5 rewritten below to reflect what actually happened to*
*TODO 25-29 (and 33, 35) since compile — all closed or corrected, verified against CHATLOG.md's*
*2026-08-01/02 entries and TODO.md's own struck-through items, not assumed. Live-reverified counts*
*this pass: test suite 2,192/2,192 green (`node --test` from repo root); migrations still 21 files*
*(0001-0020 + 0018a, unchanged); PLAYBOOK_DELTA now has 22 lessons (`grep '^## Lesson'`), up from*
*17 at compile — lessons 18-22 landed 2026-08-01/02; CHATLOG.md is now 1,293 lines (was 925).*
*Sections 2 and 4 below are an unaltered historical record and were NOT touched by this pass.*

*Refresh pass 2026-08-03: sections 1, 3 and 5 rewritten below to reflect what shipped since the*
*2026-08-02 pass, all independently re-verified live rather than trusted from CHATLOG/TODO prose.*
*Bullet-citation exposure (migration 0021) is CONFIRMED FULLY LIVE — `node --env-file=.env*
*scripts/probe-public-surface.js` shows the `citations` column present, correctly gated on*
*`overall='clean'`, and shape-checked against all 220 real `public_verification_notes` rows with*
*0 violations; `trust.html`'s receipt claim is now literally true for bill summaries, not just*
*glossary terms. The severity-sorted review queue shipped 2026-08-03 (no migration, live the*
*moment the code landed). **The one genuinely new, still-open, and important item: cross-adapter*
*vote-duplicate dedup (migration 0022) is CODE COMPLETE but NOT YET APPLIED** — independently*
*confirmed live (the same probe script's `public_votes` check reports "migration 0022 not applied*
*yet"). This is a real, currently-open accuracy defect, not a cosmetic one: until the migration and*
*its backfill run, the three public vote-aggregate matviews (`public_position_totals`,*
*`public_party_alignment`, `public_party_position_totals`) double-count every cross-adapter*
*duplicate vote in their percentages — see §3 for detail and the exact apply sequence. **Also found*
*this pass and directly relevant to §1: Lance TEMPORARILY SUSPENDED the per-run API-approval policy*
*on 2026-08-03** ("temporarily remove the usage and credit usage restrictions... until I reinstate*
*them" — `CLAUDE.md`, commit 1886e88); no reinstatement commit exists as of this pass, so treat the*
*suspension as currently in effect, not as having lapsed. Live-reverified counts this pass: test*
*suite **2,235/2,235 green** (`node --test` from repo root, up from 2,192); migrations now **23*
*files** (0001-0020 + 0018a + 0021 + 0022 — 0021 applied and confirmed live, 0022 drafted and*
*awaiting Lance, confirmed NOT applied); PLAYBOOK_DELTA now has **24 lessons** (`grep*
*'^## Lesson'`) — Lessons 23-24 landed the same day as this pass (commit `ebb07a3`, from the*
*vote-dedup work), not "unchanged since 08-02" as an earlier draft of this note incorrectly claimed*
*(caught by an independent verification pass, corrected before commit); CHATLOG.md is now **1,430*
*lines** (was 1,293). Every bill/summary-funnel number in DATA_INVENTORY.md was independently*
*re-verified this pass and came back byte-for-byte identical to 08-02 — the only things that moved*
*are vote-volume tables (`votes`, `vote_casts`, `bill_actions`, `ingestion_runs`) and the two items*
*above. Sections 2 and 4 below remain an unaltered historical record and were NOT touched by this*
*pass, same convention as the 08-02 pass.*

*Addendum, same day (2026-08-03), post-refresh: the `legiscan` ingestion failure referenced in*
*`docs/SCHEDULED_INGESTION.md` (`vote_reconciliation_flags_dedup_key` duplicate-key violation, run*
*`d56bf115`, 2026-08-02T07:30:03Z) was root-caused via an independent multi-agent investigation*
*(three blind angles: live-data forensics, code-path audit, git-history audit) and adversarially*
*reviewed before being trusted. Verdict: **already fixed**, commit `b1adbfa` (same-day, ~3h after*
*the failure) — a type-blind `roll_call_id` comparison (JS string vs number) in*
*`findExistingReconciliationFlag` (`src/adapters/legiscan-votes.js`) let a pre-existing string-typed*
*flag row slip past the in-memory idempotency check, so the code re-inserted and hit the DB's own*
*type-tolerant unique index. This is a recurrence of PLAYBOOK_DELTA Lesson 21, not a new bug class —*
*the `Number()` coercion fix already covers both the pre-insert check and the 23505-recovery recheck*
*(same shared function). Independent adversarial review confirmed red→green via revert-and-restore,*
*checked the fix against all 29 live string-typed rows currently in `vote_reconciliation_flags`,*
*confirmed no other insert path into that table exists, and returned a SHIP verdict with high*
*confidence for the next scheduled retry (~2026-08-03T07:30Z). One earlier claim by this session (in*
*conversation, not in any committed doc) that legiscan was "just waiting out its interval, no action*
*needed" was incomplete — that reassurance is now actually true, but only because this investigation*
*confirmed it rather than assumed it. Two non-blocking follow-ups surfaced, deliberately left*
*untouched pending a separate decision: (1) an `ORDER BY`-less candidate query at*
*`legiscan-votes.js:628-634` is a latent nondeterminism risk, unrelated to this bug; (2) the specific*
*row that supplied the colliding string-typed partner in the actual crash was never conclusively*
*identified (candidate attribution to the TODO-25 correction run was proposed then contradicted by a*
*second independent report) — doesn't affect the fix's correctness since it's structural/symmetric,*
*but flagged here as an open intellectual loose thread rather than asserted as solved.*

*Refresh pass 2026-08-03 (continued) — a SECOND pass, later the same day, after Lance went AFK on a*
*broad documentation-refresh instruction. Sections 1, 3 and 5 rewritten again below. Every number in*
*this note was independently re-derived this pass via direct Supabase REST queries with the*
*service-role key (`HEAD` + `Prefer: count=exact`, or a live command), not copied from CHATLOG/TODO*
*prose, though cross-checked against both — this project's own "never trust a self-report" discipline*
*applied to the session summary that prompted this pass, not just to code.*

**The comprehensive 8-domain accuracy audit (`docs/audits/2026-08-03-comprehensive-accuracy-audit.md`)
ran; its own summary line and re-grepped `###` headers agree: 4 critical + 12 important = 16
findings. All 4 criticals are fixed and independently confirmed live this pass, not assumed from the
audit doc's own text:**
1. SB 914 (`vote_reconciliation_flags` id `214a2be0-7e14-4941-a024-31d1e9223b05`) — root-caused
(LegiScan's own roll-call data omits Sens. Moon and Roberts entirely — its own `total` field says 32
of 34 real members), correctly left for Lance to adjudicate rather than auto-resolved. Queried this
exact row live: still `resolved: false`.
2. FECA/BBEDCA glossary corrections (`correct-data.js glossary-refuted-claims`) — live.
3. All 7 corrupted glossary terms repaired (`correct-data.js glossary-corrupted-text`); a
`hasTextCorruption` gate now blocks this class in `auto-publish-glossary.js` going forward.
4. Tommie Pierson Sr./Jr. split back into two unlinked rows (`correct-data.js pierson-split`) —
confirmed live by direct query: both `Tommie Pierson` legislator rows exist (`1e6a3144…` /
`f3cc4102…`) with zero `person_links` rows referencing either. This is the change that moves
`persons` **37 → 36** and `person_links` **76 → 74** (both re-verified live this pass — see counts
below). `docs/DATA_INVENTORY.md` was independently re-verified and corrected to 36/74 in a parallel
pass the same day (confirmed by file mtime and by direct query — do not assume it's still stale on
this point without checking fresh). A `finalPairStatus` same-source-key
contradiction guard (`person-identity.js`) now prevents this exact class of wrong merge permanently.
Also fixed, both live: `buildMoVoteRows`'s chamber-hardcoding bug (`mo-house-xml.js`) + 3 live
mislabeled Senate votes corrected (`correct-data.js mo-house-chamber`).

**Migrations: 26 files now** (`ls supabase/migrations/`: 0001-0025 numbered + 0018a), up from 23 at
the earlier 08-03 pass. Applied-vs-drafted, each re-confirmed live this pass individually:
- **0022 (vote duplicates) — now CONFIRMED APPLIED AND LIVE**, upgraded from the earlier-today
pass's "drafted, confirmed NOT applied." `node --env-file=.env scripts/probe-public-surface.js` now
PASSES its `public_votes` check (was failing "migration 0022 not applied yet" at the last pass);
`votes` and `public_votes` report the identical live count (10,043) for both the anon key and the
service-role key. **`vote_duplicates` itself currently holds exactly 0 rows** (confirmed via both
keys) — matches TODO.md's own report that the backfill found zero clean matches, a documented,
reasoned zero (MO's own `vote_casts` lacks enough per-legislator rows on the one traced candidate
pair to pass `isPrimaryCastDataComparable`), not a bug. Worth stating plainly: **the dedup mechanism
is live and wired correctly end-to-end, but is currently excluding nothing from any public surface,
because nothing has been marked yet.**
- **0023 (vote_duplicates RLS + view-drift fix) — confirmed still drafted, NOT applied.** Its claim
— that live production already runs `public_vote_feed`/`public_votes` as owner-bypass rather than the
committed file's `security_invoker = true`, per the audit's own "planner-cost discrimination"
technique — **I attempted to independently reproduce this same class of check this pass and could
NOT get a signal that actually discriminates the two hypotheses.** `Prefer: count=planned`
(PostgREST's EXPLAIN-based estimate) against `public_votes`/`public_vote_feed` returned
byte-identical numbers for the anon key and the service-role key (52 and 7,334) — but both are
almost exactly 0.5% of the relevant base table's own planned count (`votes` 10,355, `vote_casts`
1,466,707), which is Postgres's documented default selectivity constant for an anti-join/`IS NULL`
pattern absent real correlation statistics — a value the planner would produce identically regardless
of role or RLS visibility. So this replication is inconclusive, not confirmatory, and I'm recording
that as a real gap in my own re-verification rather than rubber-stamping the earlier claim. What IS
certain, independent of the invoker/bypass question entirely: since `vote_duplicates` holds 0 rows
right now, there is nothing for the exclusion to hide from anon either way — the practical stakes of
resolving which posture is actually live are zero until a real duplicate gets marked. A genuine
functional test (mark one row as service-role, query as anon, unmark) would settle it conclusively;
this pass's read-only mandate excludes it.
- **0024 (lock down `legiscan_datasets` from anon) — confirmed applied and live**, matches the
earlier pass: anon key gets `200 []` (0 of 31 rows) this pass too, service-role gets all 31 intact.
- **0025 (column-scope anon on `summaries`/`glossary_terms`) — confirmed drafted, NOT applied.**
Direct anon query this pass: `summaries?select=*` still returns `model`, `prompt_version`,
`bill_text_hash`, `run_id`; `glossary_terms?select=*` still returns `source_hash`, `needs_mapping`,
`prompt_version`, `run_id` alongside the public-facing columns — exactly the leak 0025 is drafted to
close.

**The MO House per-legislator vote-coverage gap — independently confirmed at the row level this
pass, not just directionally.** Direct query: `legislators?mo_house_id=not.is.null` returns exactly
**one** row (Mark Matthiesen, `mo_house_id='107'`). Direct query joining `vote_casts` to `votes`
where `source_key ilike 'mo-house-xml%'`: **18 casts total in the entire database, all 18 belonging
to that same one legislator id** — zero belong to anyone else. `terms` rows for
`chamber='house', jurisdiction_id='mo-legislature'` number 159 (in line with the ~163 MO House seats
TODO.md cites). This is starker than "162 of ~163 show zero" — closer to "every single MO House vote
cast on record belongs to one fixture row." Explicitly out of scope for the Cloudflare deploy spec
(Lance's own scoping call, 2026-08-03); still open, still a site-content decision for Lance (ship
visibly as-is, or add an explicit completeness caveat to `person-page.js`'s MO House section first).

**Live-reverified counts this pass (direct Supabase REST, service-role key, unless noted):**
- Test suite: **2,259/2,259 green**, 0 fail (`node --test` from repo root, up from 2,235).
- Migrations: **26 files** (was 23) — status of each new one above.
- PLAYBOOK_DELTA: **25 lessons** (was 24). `grep '^## Lesson'` alone finds only 12 (Lessons 14-25,
the only ones with an individual `## Lesson N` heading) — Lessons 1-13 are numbered list items
inside §7 with no heading of their own, so quoting that grep count as "the lesson count" without this
context (as an earlier pass's phrasing risked) undercounts by 13. Total is 13 + 12 = **25**. Lesson
25 ("The Bash tool strips a layer of backslash-escaping before Node ever sees a `-e` command") is
new since the earlier 08-03 pass, landed live during today's glossary-corruption diagnosis.
- CHATLOG.md: **1,750 lines** (was 1,430).
- `persons`: **36** (was 37 — the Pierson split). `person_links`: **74** (was 76). `legislators`:
1,607 (unchanged). `identity_flags`: 16 total, **4 open** (`resolved=false`, unchanged).
- `vote_reconciliation_flags`: **61 open** (was 49), 0 resolved — all still genuinely open. The
12-row increase since 08-02 is not independently attributed in this pass (plausible source: the
mo-house-chamber census or ongoing legiscan/mo-senate-web ingestion; worth a dedicated look if this
exact number matters for a future claim, not chased further here).
- `glossary_terms`: 2,219 total — **116 published**, 2,072 `needs_mapping`, 31 draft-mappable. Exact
match to the earlier 08-03 pass and to `npm run status` — unchanged.
- `summaries`: 213 total — **115 published**, 98 draft. Exact match to the earlier 08-03 pass —
unchanged.
- `bills` 38,254 / `votes` 10,043 / `vote_casts` 1,466,733 — all match `npm run status` exactly.

**Priority framing correction — the single most important status change in this document this pass:**
the Cloudflare Pages deploy spec is now the **active top-level thread**, not "deferred." Lance said
"it sure feels like we've locked the backend down," the comprehensive audit ran, all 4 criticals came
back fixed, and the same day moved straight into `superpowers:brainstorming` for the deploy spec.
**Status: IN PROGRESS, not complete** — confirmed against TODO.md's own NOW-section prose and
directly against the filesystem: scope agreed (deploy mechanics only; explicitly excludes migration
0025 and the MO House caveat), Section 1 (scope/sequencing) approved, two small pre-deploy fixes
decided (fix `geocode.js` security headers, build `site/404.html`) but **confirmed NOT yet built**
(`site/404.html` does not exist on disk; `site/functions/geocode.js` still returns bare
`Response.json(...)` calls with no headers option anywhere in the file), Section 3 (connecting
Cloudflare Pages) presented in depth with two open sub-questions (3a: fresh vs. existing Cloudflare
account; 3d: whether to restrict preview-deployment builds, since `site/config.js` hardcodes the real
production anon key so every preview branch is a live copy of the real site), Sections 2 and 4 not
yet presented. **Separately notable, and not part of the spec's own scope:** the core product claim
(browse → legislator → real votes → real bill → real roll-call tally) was verified end-to-end in a
real Playwright browser against live production data for the first time ever, zero console errors —
the strongest evidence yet that "backend locked in" is a reasonable read of the current state, and
the reason the priority reordering below is warranted rather than premature.

**Refresh pass 2026-08-04 — brief, narrow-scope correction only (not a full re-verification of this
document; see `TODO.md`'s NOW section for the full narrative).** Two things independently
re-verified live this pass: **test suite is now 2,294/2,294 green** (`node --test` from repo root,
up from 2,259), and **migrations are now 30 files** (`ls supabase/migrations/`: 0001-0029 numbered +
0018a, up from 26). The four new ones (0026, 0027, 0028, 0029) are the full arc of a multi-layer
`refresh_vote_aggregates()` timeout saga that consumed most of the 2026-08-04 session: a Supabase
edge-gateway ~120s timeout on the synchronous RPC call (fixed by 0027, moving the refresh to a native
`pg_cron` job so no HTTP gateway is involved for the routine case), a Postgres `statement_timeout`
arm-timing trap where the ambient 2-minute database default was fixed before the function's own `set
statement_timeout` could take effect (fixed by 0028, raising the database-level default), and a
query-planner anti-join misestimation where the `LEFT JOIN ... WHERE ... IS NULL` idiom (added by
0022 to exclude superseded duplicate votes) was catastrophically under-estimated, driving Nested Loop
joins over ~1.34M rows (fixed by 0029, rewriting the exclusion as `NOT EXISTS`). All three layers are
independently confirmed fixed and live: three consecutive clean `succeeded` `ingestion_runs` rows
(two real `pg_cron` ticks on the `*/30` boundary plus a manual `npm run refresh:aggregates` run,
~19.4s, matching the pre-outage baseline). Full detail: `TODO.md`'s NOW section. **This pass did NOT
re-verify every other number in this document** (persons/person_links/glossary/summary/
reconciliation-flag counts, the Cloudflare deploy spec's own progress, etc.) — those may have moved
too and should not be assumed current just because this paragraph exists. The **"What actually
matters next, in order" list in §5 is flagged below, not re-derived**: the 2026-08-04 timeout saga
was an urgent operational bug that intervened and consumed a full session, separate from the
Cloudflare-deploy-spec thread §5 ranks #1 — that ranking predates 2026-08-04 entirely and should not
be read as a live snapshot of what actually happened that day without checking `TODO.md` directly.

---

## 1. Standing rules I must not violate

### Lance's directives (his words)

**API spend is gated, and the hold is still on — EXCEPT: Lance TEMPORARILY SUSPENDED this gate on 2026-08-03. Re-verify before assuming either state.**
> "API calls using Claude should be approved by me so they do not get excess in this build" (CHATLOG.md:315)
> "no more spending credits. Figure out how to do it otherwise for a bit or just hold the items that need spending approval back for a bit." (memory/no-api-spend-hold.md, 2026-07-28)

All volume work runs the $0 subagent path (`summary-queue.js record`). ~$6 credits are earmarked for exactly two named cases: the parked golden drift check (~$0.35, pre-approved) and the 11 over-400k bills.
**RESOLVED 2026-07-31** (commit 41936f0): `npm run summarize`, `npm run verify`, `npm run gloss`, `npm run extract-terms`, `npm run golden` all still exist in package.json, but every one now carries a mechanical env gate (`SUMMARIZE_RUN_APPROVED`, `VERIFY_RUN_APPROVED`, `GLOSS_RUN_APPROVED`, `GOLDEN_CHECK_APPROVED`) firing before any Anthropic client is constructed; `--dry-run` stays freely runnable on all of them. This section originally flagged `summarize.js`/`verify.js` as the two ungated holdouts — that gap is closed; leaving this paragraph in place (rather than deleting it) so the historical trap is still legible to a reader who encounters the old framing elsewhere.

**Found this pass (2026-08-03), and materially changes the operating picture above:** `CLAUDE.md` itself was edited (commit 1886e88, "docs: suspend the per-run API-approval policy per Lance's instruction (2026-08-03), until reinstated") to add: *"TEMPORARILY SUSPENDED (Lance, 2026-08-03): 'temporarily remove the usage and credit usage restrictions from the rules and settings until I reinstate them.' Per-run approval + cost statement is NOT required for live API calls while this is in effect. This is a suspension, not a repeal... Treat this as still in effect until Lance says otherwise; do not assume it has lapsed just because time has passed or the session has changed."* Checked live: no reinstatement commit exists in git history after 1886e88, so as of this refresh pass the suspension is **still in effect**. This does NOT retroactively make the mechanical `*_RUN_APPROVED` env gates optional to respect — those still physically block the client construction unless the env var is set — it means Lance is not requiring a per-run cost conversation before you set that env var. `memory/no-api-spend-hold.md` (referenced above) was NOT updated by this doc's own refresh scope (it lives outside `docs/`) and may now read as stale to a fresh session relying on memory alone — verify against `CLAUDE.md` directly, not against that memory file, until it's reconciled.

**Re-checked 2026-08-03 (continued pass): still no reinstatement commit** (`git log --oneline --all` after `1886e88` shows none) — the suspension remains in effect. Nothing changed here since the earlier 08-03 pass; re-verified, not assumed.

**Cloudflare deploy is a MILESTONE, not a task — and Lance himself has now judged the backend ready to start it.**
> "I'm only interested in starting the cloudflare portion once the entire backend is locked in and accurate, otherwise I'm troubleshooting two systems back and forth and each change takes 3 steps instead of 1." (CHATLOG.md:794)

Do not propose deploying until he says the backend feels solid. **TRAP:** the site is built, merged to main, and `site/config.js` already holds the real URL + anon key — it *looks* ready, which is exactly when an agent proposes it. **Found this pass (2026-08-03, continued):** that gate has now actually been cleared by Lance's own words, not an agent's judgment call — "It sure feels like we've locked the backend down and could potentially move to the cloudflare," followed by the comprehensive audit (all 4 criticals fixed, verified above) and the same-day start of `superpowers:brainstorming` for the deploy spec. The TRAP framing above is preserved as-is (an agent should still never *propose* it unprompted), but the milestone itself is no longer hypothetical — it is the active thread. See the updated §5 for the current spec status (in progress, not complete).

**Facts-only is the product's soul.**
> "There should be no editorial summaries here, people put their emotions into their summaries, we are only looking for facts. Bills proposed, votes made, votes missed, etc." (CHATLOG.md:267)

Scorecards, ratings, grades are **"permanently out, not deferred"** (public-site design spec, Non-negotiables). The vote-aggregate carve-out Lance granted 2026-07-30 is arithmetic-only: **member-vs-own-party-aggregate is allowed; member-vs-member never is.** Thin data renders as honestly thin — never hidden, never padded.

**Backend correctness outranks UI.**
> "I'm not entirely overly concerned about the front end web page and UI yet, I am laser focused on the back end information being correct, available, and up to date" (CHATLOG.md:410)

**The legislator profile page IS the product.** Bills/summaries are its feedstock (CHATLOG.md:345). Profile-completeness work outranks standalone bill-page work.

**Draft-then-apply, always.** Every migration 0001-0020 was written by an agent and applied by Lance in the Supabase SQL editor. The service key is in `.env` and every CLI writes production — it is *mechanically possible* for an agent to apply schema/bulk corrections itself. It has never been done. Don't start.

**New runtime dependencies require Lance's explicit per-dependency approval.** Exactly three exist: `pdfjs-dist` (pinned 6.1.200), `yauzl` 3.4.0, `jsdom` (dev). The plans say it flatly: *"the controller's recommendation is NOT the approval."*

### External terms — suspension-level

`docs/research/2026-07-28-legiscan-terms.md` marks three rules ⛔ (they enforce with suspension):
- **dataset_hash comparison is MANDATORY before any getDataset download** — "failure to do so will result in suspended access." The stored hash lives in the `legiscan_datasets` table (0010), *not* in cached files.
- **Never scrape legiscan.com's front end. API only.** TRAP: when a field is missing from the API, fetching their HTML page is the obvious fallback and it risks the key the whole MO backfill depends on.
- **One key. Never create additional Public API keys.** "The cap hit, I'll register another" is an account-suspension move.

Plus: 30,000 queries/month (repo self-imposes a HARD refusal at 5,000), doc blobs downloaded at most once per doc_id, CC-BY attribution on every public surface.

**MO 30-minute cadence.** house.mo.gov ToU, verbatim: *"Do not automate scripts to pull down information more often than once every half hour."* The Senate has **no ToU at all**, and the research doc rules on it explicitly: *"UNKNOWN, not 'no restrictions exist'... treat the Senate exactly as strictly as the House's documented half-hour cadence."* `docs/ARTIFACTS.md`: **"Do not raise that interval."** TRAP: a crawling backfill makes the limiter look like a perf bug.

### Project law

| Law | Where |
|---|---|
| **Zero fuzzy matching, anywhere, ever.** Full-name(+source-printed-variant) match is a NECESSARY condition for any automated identity link, forever. Ambiguity NEVER resolves toward a merge. | PLAYBOOK lesson 13 (Symington father/son live mis-merge); CHATLOG:729 |
| **Reconcile-or-throw.** A vote block whose parsed surnames ≠ the printed `—<count>` is NEVER stored. Typed `JournalParseError`. | mo-senate-adapter plan, Global Constraints |
| **skip ≠ empty.** A rate-limit/failure is a distinct typed error state, never an empty result — in ingestion *and* in the UI (loading / failed-with-retry / honestly-empty are three states; a failed fetch must never render as "no recorded votes"). | PLAYBOOK §3.1; public-site plan |
| **Fail-loud identity.** `resolveMoSenator` returns an id on exactly 1 match else `null`; unresolved casts recorded and skipped, never guessed. | mo-senate plan |
| **Additive writes only.** `insertIfAbsent`/`additivePatch`; a non-null value is never overwritten; `run_id` on every row. | PLAYBOOK §3.5 |
| **Never trust a model's self-report.** `verify.js:~109` DERIVES `overall` mechanically. Under trust-model v3, clean items **auto-publish unattended** — this gate is the entire wall between "looks fine to me" and the public site. A refactor reading the model's own `overall` removes the wall with every test still green. | PLAYBOOK lesson 2 + 15; trust-model-v3 spec |
| **Glossary/summary content comes from fetched official text only — never model knowledge.** Enforced by `glossary_terms_published_complete` CHECK. | 0007 header; glossary design |
| **Identity merge is VIRTUAL and permanent.** Source rows never rewritten; votes stay keyed by `legislator_id` forever; `person_id` is a read-time grouping. Wrong-merge = unacceptable; missed-merge = benign. | identity-merge design; 0012 |
| **DESIGN FREEZE: no new per-state identity columns, ever.** `mo_senate_id`/`mo_house_id` "are the LAST of their kind"; new states ride `legiscan_people_id` + terms. | 0014 header |
| **The MO Senate journals pipeline is COMPLETENESS-CRITICAL, permanently — NOT demotable to audit cadence.** LegiScan's `ls_bill_vote.bill_id` is a scalar FK, so combined-vehicle floor votes (how most major MO bills pass) structurally cannot exist there. Proven: SBs 894 & 921, a real 31-0 vote LegiScan has zero record of. | legiscan plan Task 8 revision |
| **Never synthesize a second votes/vote_casts row for a sibling bill.** It double-weights one real floor action in every aggregate. Sibling display is solved by matching `votes.question` text, never by writing a row. | legiscan-substitute-vehicles research |
| **Geocoder: nothing stored or logged, ever — "a review-blocking requirement, not a comment."** And it must stay **POST, not GET**: Cloudflare logs `ClientRequestURI` at the edge regardless of what the function does, so `?address=` would put home addresses in our own edge logs. | public-site spec §5; `site/functions/geocode.js` |
| **Implementers are STRICTLY SERIALIZED. No exceptions, regardless of file disjointness.** Two incidents (a mid-edit red test file swept into another agent's whole-tree run; `git commit -a` sweeping another task's uncommitted files). | profile-completeness ledger |
| **Gate commits on the extracted fail count, never a filter's exit status.** `... \| grep "^ℹ (tests\|pass\|fail)" && git commit` succeeds because grep *finds* `fail 15`. Shipped a red suite twice. | PLAYBOOK lesson 14; CLAUDE.md |
| **`node --test` from repo root, NEVER with a directory argument** (Node 24 / Windows). | public-site plan |
| **`scripts/refresh-aggregates.js` at the end of every controller loop batch**, and **only one ingestion loop at a time.** | public-site ledger |
| **MO bill PDFs are "not official copies and should not be quoted or cited."** Provenance rule, shipped as `MO_DISCLAIMER_TEXT`. | mo-senate-sources research |

---

## 2. Recurring defect classes (each has bitten ≥2×)

**A. Cross-era / identity conflation — 7 counted appearances, 9 distinct channels, re-fired 2026-07-31.**
Channels so far: district-as-permanent-key unique index; roster fallback to *today's* roster for historical years; era-blind replay; stale current-year cache; dateless same-seat pairs defaulting to "compatible"; surname-only auto-linking (rolled-back live run: Symington, Adams, Walker); comma-suffix defeat through all three layers; terms-evidence query unscoped by jurisdiction; "ambiguous" qualifying for attach suggestions (the Bayh trap). Latest: Menendez Sr./Jr., concurrent service, identical names, different chambers.
**Guard:** every new roster ingest / matching predicate / evidence source / replay path must be explicitly attacked against this class before going live. And: **do not trust `auditClusterCoherence`'s `ok:true`** — read `residualOnlyClusters` and hand-inspect full row+term detail for each before any write. On 2026-07-31 all 31 ready-to-write clusters were residual-only.

**B. Run-ledger counts wiped or omitted on close/abort paths — 5 instances, one shipped to production.**
`closeRun` replacing `detail` wholesale erased the write-ahead `queries_used` (cap enforcement silently neutralized, undercount direction). Early-return and catch paths in `ingest-mo-senate.js` omitted `quarantined_days` → `public_freshness`'s `coalesce(...,0)` rendered the affirmative **"zero days pending human review" while 7 were quarantined**, live, ~30 min of every hour. 20 of 94 finished runs omitted the key.
**Guard:** *every* close path — success, early-return, catch, abort — carries the FULL standing counts, not just what that invocation computed. Absence must never coalesce to an affirmative zero.

**C. Empty-set vacuous truth — 4th appearance counted.**
Zero bullets + zero verdicts auto-published with a "verified clean" receipt. A hollow `[{bullet_index:0, supported:true}]` was stored as a permanent trust-model-v3 receipt. The completeness axis declared `minItems:3` in schema *and* prompt and enforced neither — "a checker naming one trivial provision would have earned the same receipt."
**Guard:** every gate needs an explicit non-vacuity check. Anything declared in a schema or asked for in a prompt must be **re-verified mechanically at the gate** if a downstream public claim depends on it.

**D. Order-dependent "pick one of N" resolvers — 5 instances.**
`resolveParty` caller-order-dependent (party is the neutrality-critical fact); the same class reappeared on the public directory (Curls renders no-party on the directory, D on her profile); identity header showed one arbitrary term (MO Senate d2 for a sitting US House member); `pickLatestTextEntry` on malformed dates; duplicate term glosses (War Powers Resolution ×3).
**Guard:** mirror an explicit documented precedence constant (`DISPLAY_NAME_PRIORITY`), or **refuse to pick and show all candidates.** Invisible in tests because fixtures return in fixed order.

**E. Wiring/seam bugs that pure-function tests structurally cannot see.**
Flag badges could *never* render: `joinFlagBadges` keys `vote_id`, raw votes rows carry `id`. Zero tests covered the join, so the suite stayed green. Worse: `makeFakeWriteClient` was missing `.maybeSingle()`, swallowed by a try/catch — "every prior `queries_used` re-read in those tests had been asserting a FALSE ZERO. Tests were lying."
**Guard:** DOM/integration regression test *at the wiring point*, mutation-verified (exactly one test red on revert, positive control green). A green suite is evidence about units, not joins — and the fakes themselves can be the liar.

**F. The controller's own ruling being the defect — 6 instances.** ← the subtlest
Examples: "THE CONTROLLER RULING ITSELF WAS WRONG — live full form is 'Democratic' (456 rows), not 'Democrat' (0 rows)"; a Jan-3 date convention that would have written FALSE personal dates (Payne died in office 2024-04-24); plan SQL that would have aborted on apply; a plan spec that mirrored 0005's district-as-permanent-key design; plan wording "culpably ambiguous" enough to cause the rolled-back live link run.
**Guard:** tell reviewers to attack the *ruling*, not just the implementation — a wrong ruling passes review while appearing fixed. **Verify any controller factual claim against live data before encoding it in SQL or a prompt.** (T8c's implementer did exactly this and corrected me from the fetched primary source.)

**G. Async "last-wins" rescope races — fixed, then reintroduced in the very next task.**
Worst shape: concurrent-submit rendering the WRONG address's representatives (KS-under-MO reproduced) — on the page whose entire design goal is privacy.
**Guard:** generation token per fetch scope, applied at write time, not discovered in review.

**H. Source sentinel values stored verbatim as facts — 2 distinct LegiScan date sentinels in one week.**
`1969-12-31` (10 MO roll calls → a live 1969 chart bucket on Onder's profile) and `0000-00-00` (275 of 351 roll calls in session 2122). Same class non-date: numeric status codes rendered as a bare `[1]` on 37,662 MO bills.
**Guard:** validate printed dates against the dataset's own session years and **refuse rather than store**. Expect more sentinels.

---

## 3. Open / unfixed items that are real

### Genuinely blocking (accuracy defects on the public record)

**Status as of 2026-08-02: items 1-4 below are all CLOSED.** Verified against CHATLOG.md's
2026-08-01/02 entries and TODO.md's own items 25-28 (all struck through as done). Item 5 has no
TODO number and is the one genuinely still-open item in this list — verified open by grep, not
assumed closed just because 1-4 were.

**Status as of 2026-08-03: item 5 below has moved from "not started" to "code complete, migration
awaiting Lance" — re-verified live, not assumed from CHATLOG prose.** The underlying data defect
(cross-adapter duplicate votes double-counted in the public vote-aggregate matviews) is **still
100% live in production** — confirmed via `node --env-file=.env scripts/probe-public-surface.js`,
whose `public_votes` check reports "migration 0022 not applied yet." This is the single most
important status change in this document this pass — read item 5's rewritten text below in full
before touching anything vote-aggregate-related.

**Status as of 2026-08-03 (continued): item 5 is now CLOSED too — migration 0022 was applied by**
**Lance and re-confirmed live this pass.** `probe-public-surface.js`'s `public_votes` check now
PASSES; `vote_duplicates` holds 0 rows (the backfill found zero clean matches, a reasoned zero, not a
bug — see the top-of-file note for detail). **Two NEW items replace it below (6 and 7):** item 6
covers the 2026-08-03 comprehensive accuracy audit's 4 criticals (all fixed, all independently
re-verified live this pass); item 7 covers the MO House per-legislator vote-coverage gap the audit
surfaced but did not fix (genuinely still open, Lance's own site-content call).

1. ~~MO 2026 session split across two rows, actively growing~~ **CLOSED.** The 2026-08-01 live run
   merged 34 duplicate bills into their canonical twins, redirected 31 votes, and deleted the
   duplicate session — independently re-verified against the live DB afterward: 0 duplicate bills,
   0 orphaned votes, 31/31 redirected votes correct, casts total unchanged. The ROOT CAUSE (not
   just the cleanup) closed 2026-08-02: `ensureSessionRow` (mo-senate-web) now uses the same
   year+name session resolution `ensureLegiscanSessionRow` already proved correct, so a fresh
   `'2026'` duplicate can no longer be minted — including a same-day self-correction after review
   caught that the first cut would have manufactured a false ambiguity the moment MO calls a
   special session. 29 real cross-source vote discrepancies surfaced during the merge (all trace to
   one root cause: Sen. Fitzwater's yea vote present in every LegiScan roll call, absent from every
   Senate-journal-sourced one — a known pipeline undercount, not a new mystery) and were flagged for
   review rather than hidden; they now sit in the reconciliation-flag queue (49 open, up from 9 —
   see "Accepted residuals" below), not on this accuracy-defect list. (TODO 25)
2. ~~2,005 bills with NULL title AND NULL canonical_url~~ **CLOSED 2026-08-02.**
   `backfill-bill-titles.js` ran live: 1,972 of 1,975 NULL-title bills backfilled from cached
   LegiScan datasets, 0 failures. 3 remain — LegiScan's own cache has no title for them either (all
   `SRM` remonstrance resolutions), correctly left untouched rather than guessed. Independently
   verified against the live DB post-run. `canonical_url` NULLs were not separately re-counted this
   pass. (TODO 26)
3. ~~`legislators.party` unnormalized~~ **CLOSED 2026-08-02.** `correct-data.js party-normalize` ran
   live: 391 `R`→Republican, 209 `D`→Democratic, 1 blank→NULL; independently verified against the
   live DB (860 Republican, 672 Democratic, 66 NULL — exact expected deltas). `Independent` and
   Lieberman's real `Independent Democrat` deliberately left untouched. Fixed AT THE INSERTION
   POINT too (`legiscan-identity.js`), after a same-day follow-up check found LegiScan's own dataset
   prints bare `R`/`D` codes — a future LegiScan-sourced legislator can no longer re-dirty the
   column. (TODO 27)
4. ~~152 stub roll calls with no member positions~~ **CLOSED 2026-08-02.** Live investigation found
   the original framing conflated two structurally different causes (167 rows/60 bills by the time
   this ran — ongoing ingestion, not drift, not decay): OpenStates rows are permanent zero-cast
   bill-action-log stubs (hidden at display time ONLY when the same bill has real cast-bearing data
   elsewhere — never a row-to-row pairing the data doesn't support); MO House rows already carry
   real specific tallies with casts landing later from a separately-polled PDF that updates the SAME
   `vote_id` in place (never touched, never a duplicate, gets honest wording instead of a bare
   all-zero line). Display-only fix in `site/js/bill-page.js` — no data was touched. Verified live
   via dev server + Playwright. (TODO 28)
5. ~~Display-time dedup~~ **CLOSED 2026-08-03 (continued pass).** Migration 0022 applied by Lance
   and independently re-confirmed live this pass: `probe-public-surface.js`'s `public_votes` check
   passes; `votes` and `public_votes` report the identical count (10,043) for both the anon key and
   the service-role key. **The backfill correction found zero clean matches** (dry-run and live both)
   — traced to one real candidate pair (LegiScan roll call 1673444 vs. `mo-house-xml-HB1623-3`):
   MO's own `vote_casts` has only 1 individual position stored for that vote despite the printed
   "103-48" aggregate, so `isPrimaryCastDataComparable` correctly declines to certify a match it can't
   verify. This is a reasoned, documented zero, not a bug — but it means **the mechanism is live and
   wired correctly end-to-end while currently excluding nothing from any public surface,** because
   nothing has qualified yet. Text below (originally written when 0022 was still a draft) is kept for
   the build history; read the top-of-file 2026-08-03 (continued) note for the live-reconfirmation
   detail. RULED BINDING, spec
   (`docs/superpowers/specs/2026-08-03-vote-duplicate-dedup-design.md`) → plan
   (`docs/superpowers/plans/2026-08-03-vote-duplicate-dedup.md`) → implementation, TDD throughout,
   43 new tests (2192→2235, 0 fail). **What's built:** a non-destructive `vote_duplicates` grouping
   table (migration 0022, draft file only — mirrors the `persons`/`person_links` precedent, migration
   0012; neither `votes` row is ever deleted or rewritten), a new `public_votes` view plus an updated
   `public_vote_feed` that both exclude the superseded row, and the same exclusion rewritten into the
   join chain of all three vote-aggregate matviews (`public_position_totals`, `public_party_alignment`,
   `public_party_position_totals`). Detection reuses the existing `crossCheckAgainstPrimarySource`
   matching logic (live LegiScan ingest going forward) plus a one-time backfill correction
   (`correct-data.js vote-duplicates`) for the existing backlog. **Two real bugs found and fixed
   during implementation, both worth knowing about:** (a) the original design gated on
   `crossCheck.reason === 'tally_unique_match'`, but `crossCheckAgainstPrimarySource` has a THIRD
   `matched: true` return branch (plain singleton/singleton match, the most common case in practice)
   that never sets `reason` at all — a reason-string gate silently skipped it; fixed by gating on
   `matched` instead. (b) `correct-data.js` has its own tested architectural rule that it must NEVER
   call `crossCheckAgainstPrimarySource` directly (that function writes `vote_reconciliation_flags`
   as a live-ingest side effect, which a backfill against already-published data has no business
   triggering) — the backfill was redesigned to reimplement the matching locally with only the pure
   comparison primitives, mirroring this file's own existing 1969-sentinel-date correction.
   **[Historical, at time of writing 2026-08-03 morning] Independently confirmed live this pass (not
   just "commit says code complete"):** `node --env-file=.env scripts/probe-public-surface.js`'s own
   `public_votes` check reports "migration 0022 not applied yet" — so as of this refresh, the
   underlying defect (every cross-adapter duplicate vote double-counted in all three public matviews'
   percentages, not just shown twice in a list) is **still 100% live in production**, unchanged from
   the 2026-08-02 framing. **Remaining steps, all Lance's, in order** (full detail in the plan's own
   "Handoff to Lance" section): (1) apply `supabase/migrations/0022_vote_duplicates.sql` in the
   Supabase SQL editor; (2) run `node scripts/probe-public-surface.js` to confirm `public_votes` is
   reachable and shaped correctly; (3) run `npm run refresh:aggregates`; (4) run
   `node --env-file=.env src/cli/correct-data.js vote-duplicates --dry-run` to see the real count,
   then without `--dry-run` to apply it live; (5) run `npm run refresh:aggregates` again; (6)
   spot-check the actual exclusion directly in the SQL editor (`select * from vote_duplicates limit
   5`, confirm the superseded id doesn't appear in `public_votes`/`public_vote_feed`), then
   spot-check a real bill page and a legislator's vote-aggregate chart in a browser.

   **[Current, 2026-08-03 continued pass] All six steps above are DONE.** Lance ran them the same
   day (hit and fixed one real SQL bug along the way, see below); re-verified independently this
   pass: `probe-public-surface.js` passes, `vote_duplicates` holds exactly 0 rows (the backfill's own
   correct, reasoned zero — see the item header above), `votes`/`public_votes` counts match for both
   anon and service-role keys. `npm run refresh:aggregates` hit a PostgREST statement timeout
   (~8s, the RPC does three `REFRESH MATERIALIZED VIEW CONCURRENTLY` passes over 1.46M+ rows in one
   call) — worked around by running `select refresh_vote_aggregates();` directly in the SQL editor,
   which succeeded (matview counts confirmed unchanged: 11,466 / 3,042 / 198, as expected with zero
   duplicates marked). **A real SQL bug in the migration file was found and fixed the same day:**
   Lance's first live run errored (`42809: "public_position_totals" is not a view`) — two stray `drop
   view if exists ... cascade;` lines tried to drop objects that are actually materialized views
   (`DROP VIEW` refuses that even with `IF EXISTS`); fixed (commit `1858195`) by removing both stray
   lines. Confirmed the failed first attempt rolled back cleanly as one transaction, nothing partial
   to clean up; the corrected file is what's in the repo now. This item is no longer in §5's "what
   actually matters next" list — superseded by items 6/7 below and the Cloudflare thread, see §5.
   (No TODO number in TODO.md as a discrete backlog item — tracked in TODO.md's own NOW section prose
   instead, under "Cross-adapter vote duplicate dedup.")

**NEW-A.** *(Not numbered 6 — §3's numbering is one continuous sequence across all three*
*subsections below, already at 12 by "Public-surface leaks"; using letters here rather than*
*renumbering everything downstream.)* **The 2026-08-03 comprehensive accuracy audit's 4 criticals —
CLOSED, all independently re-verified live this pass.** Full detail in the top-of-file 2026-08-03
(continued) note; summary: (a) SB 914 tally contradiction root-caused, deliberately left for Lance to
adjudicate — confirmed still `resolved: false` live, not silently resolved; (b) FECA/BBEDCA glossary
corrections live; (c) all 7 corrupted glossary terms repaired, a text-integrity gate now blocks the
class; (d) Tommie Pierson Sr./Jr. split back into two unlinked rows, confirmed live (`persons`
37→36, `person_links` 76→74), a same-source-key contradiction guard now blocks the class
permanently. Also fixed as part of the same pass: `buildMoVoteRows`'s MO House chamber-hardcoding bug
+ 3 live mislabeled Senate votes corrected. `docs/audits/2026-08-03-comprehensive-accuracy-audit.md`
is the full 16-finding report (4 critical + 12 important); the 12 important findings are NOT all
closed — 0023/0025 (migrations, drafted not applied) and the MO House gap (NEW-B below) are three of
them, still open by design, Lance's own calls.

**NEW-B. MO House per-legislator vote-coverage gap — found by the same audit, deliberately NOT
fixed, genuinely still open.** Independently confirmed at the row level this pass (not just
directionally): exactly **one** `legislators` row has `mo_house_id` set (Mark Matthiesen, `'107'`)
out of 159 MO House `terms` rows; **all 18** `mo-house-xml`-sourced `vote_casts` in the entire
database belong to that one legislator — zero belong to anyone else. Root cause: `persistRoster`
(`ingest-mo-house.js`) seeds exactly one real legislator row against a roster the roll-call-PDF
parser resolves votes against — every other MO House member's own profile page shows zero MO House
votes, forever, with no caveat, while the one fixture legislator looks fully tracked on the same
roll calls. Related to but distinct from item 6 below ("MO House cross-era misattribution trap" —
that's about a future multi-era backfill risk; this is about the CURRENT single-era roster already
resolving almost everyone's votes to nobody). **Explicitly out of scope for the Cloudflare deploy
spec** (Lance's own scoping call, 2026-08-03) — a real, still-open decision on its own: ship visibly
as-is, or add an explicit completeness caveat to `person-page.js`'s MO House vote section first. Not
an agent's call to make silently either way.

**Update 2026-08-05 — investigated end-to-end whether the source is worth fixing; deliberately
deprioritized, not built.** Full investigation (parallel investigate → synthesize → adversarially
verify, verdict CONFIRMED on independent re-check): the pipeline itself is operationally healthy
(214 runs since 2026-07-28, 97% success, the only failures one already-fixed 2026-08-01 timeout
incident, bill backlog draining monotonically) — this was never a stalled-scheduler problem, only a
capped-resolution one. Live-verified: every bill where `mo-house-xml` currently resolves ANY real
cast (~22-24 of its ~130-134 total votes, all 2026) already has a LegiScan vote for the same bill —
100% bill-level overlap, checked directly. (Can't get a dedup-*certified* same-floor-vote match —
`vote_duplicates` shows zero hits — but that's the identical 1-person-roster gap starving the
certifier of enough casts, same limitation already found on `HB1623-3`; reporting this as strong
circumstantial evidence, not an overclaimed certainty.) Whole-MO-House-dataset scope is also much
narrower than "most... structurally incomplete" implies: LegiScan alone covers 96.9% of all 6,652
MO House votes with 0% zero-cast; only 2.7% dataset-wide are zero-cast, split between this source
(106, all 2026) and a separate dead pipeline (`mo-ocd-vote`, 75, all 2022, no longer scheduled at
all). Given that confirmed redundancy for the source's entire currently-useful output, the fix's
real cost (~3.4 days of cooldown budget to wire up the already-defined `fetchMoMemberList`/
`fetchMoRepresentative`, plus a new replay pass since already-"casted" roll calls are never
re-attempted, plus careful navigation of item 6's cross-era `mo_house_id` collision risk if roster
fetching ever grows beyond the current session) was judged not worth building. The site-content
decision above (ship as-is vs. caveat) remains open and remains Lance's call — this investigation
sharpens the evidence, doesn't resolve it. Unrelated finding surfaced along the way: zero MO House
votes exist for 2024 at all in the live dataset, a separate gap not investigated further.

**TODO 29 (hygiene) was also re-verified 2026-08-02, no action needed** — empty `districts` table
and zero `image_url`/`contact` rows are both confirmed by design, not decay.

Items 1-4 above were all draft-then-apply corrections governed by PLAYBOOK lesson 17 (extract the
mapping from the source, put the `.eq()` guard on the UPDATE not in a JS pre-filter, establish
reversibility before approval) — all four ran live and were independently re-verified against the
database, not just the CLI's own report. **Item 5 is now CLOSED too (2026-08-03 continued pass, see
above) — for the first time in this document's history, items 1-5 are ALL closed.** The backend's
one remaining "genuinely blocking" gap is NEW-B (MO House vote coverage) above, which is deliberately
scoped OUT of the Cloudflare deploy spec rather than blocking it — Lance's own call, not a silent
descope.

### Live landmines not tracked in TODO.md at all

**Re-verified individually 2026-08-02 against current code and CHATLOG — not assumed closed or
open from this list's own age.** Result: 6, 7, 9, 11, 12 are STILL OPEN and unchanged; 8 is now
CLOSED; 10 is substantially mitigated by the scheduler's registration (see below).

**2026-08-03 pass: items 6, 7, 9, 10 were NOT independently re-read this pass** — none of the
commits since 08-02 touch `ingest-mo-house.js`, `summarize.js`'s candidate picker,
`person-identity.js`'s unlink route, or `scripts/scheduled-ingest.js`, and TODO.md's own entries for
31/32 (items 6/7 here) are still unchecked as of this pass. Carried forward as still open on that
basis, not re-verified fresh — flagging the distinction rather than implying a fresh check. Items
11 and 12 (public-surface leaks) WERE re-checked this pass, directly below.

6. **MO House cross-era misattribution trap — STILL OPEN, unchanged.** `0005_mo_house_id.sql:11`
   still reads `alter table legislators add column mo_house_id text unique;` (verified by direct
   read 2026-08-02 — never dropped). `src/cli/ingest-mo-house.js` still does
   `insertIfAbsent(client, 'legislators', rows, 'mo_house_id')` against a current-only roster with
   **no unique-violation handling** (grep confirms no `isMoHouseIdUniqueViolation`-equivalent
   anywhere in the file). Now explicitly on the record as TODO 31 (was "never made it" at compile
   time — it has since; still unchecked/open there). The now-registered scheduler's own registry
   entry for `mo-house-xml` hardcodes `--limit 1` with an explicit in-code comment never to add
   `--session`/a year flag, which prevents the SCHEDULER itself from tripping this — but a manual
   historical/multi-era backfill still would.
7. **`summarize.js` candidate picker is still silently truncating — STILL OPEN, unchanged.**
   Verified by direct read 2026-08-02: the `sessions`/`bills`/`votes` lookups inside
   `src/cli/summarize.js`'s `loadFederalBills` are all still bare `.select()` — no `selectAll`, no
   `.range()`, no `.limit()` — against 38,254 bills and roughly 10,000+ votes, both well past
   Supabase's 1,000-row default cap. Now on the record as TODO 32 (unchecked, still open). Both
   summary waves that ran
   since compile (wave 2: 60 bills, 2026-08-01; the review-queue backfill: 15 bills, 2026-08-02)
   continued to route around this CLI entirely (`summary-queue.js` / a small dedicated adapter
   script), so it has not actually fired again — but it is still armed for the next person who
   reaches for `summarize.js` directly.
8. ~~No `*_APPROVED` gate on `summarize.js` / `verify.js`~~ **CLOSED 2026-07-31** (commit 41936f0,
   TODO 30). Both now carry the same mechanical gate as `gloss.js`
   (`SUMMARIZE_RUN_APPROVED=yes` / `VERIFY_RUN_APPROVED=yes`), firing before any Anthropic client is
   constructed; `--dry-run` stays freely runnable. Passed adversarial review. (Note: §1 above still
   describes this as an open TRAP — that line is part of the untouched historical record and was
   not in scope for this refresh pass; flagging the inconsistency here rather than silently leaving
   it unexplained.)
9. **Two adjudicated fast-follows still never built — STILL OPEN, unchanged.** (a) transaction/RPC
   hardening of the non-transactional link sequence — the TOCTOU guard only shrinks the window; (b)
   **a proper unlink route.** Verified absent by direct read 2026-08-02; `person-identity.js:220`
   still says so explicitly in-code ("a scheduled fast-follow, not yet built"). The Bayh mis-link
   was corrected by controller-executed raw SQL against production because there is no in-app undo.
   With 4 open flags awaiting Lance, another wrong link is one click away.
10. **`refresh_vote_aggregates()` is still never called from any `src/` CLI — but the operational
    risk is now substantially mitigated.** Still literally true (grep confirms no `src/` file calls
    it). BUT: the scheduler (`scripts/scheduled-ingest.js`) is now **registered and running** — Lance
    ran the `schtasks` registration 2026-07-31 late night (switched to S4U logon, "run whether
    logged on or not"), confirmed live by its first tick at 22:00 local that night, and every
    ~15-minute tick since (`.superpowers/artifacts/scheduler-logs/`, most recently
    2026-08-02T21:45Z at the time of this pass). It calls `scripts/refresh-aggregates.js`
    automatically after every tick whose chosen source's own recorded counts show it actually wrote
    rows (fail-open on an unrecognized shape). As long as this keeps running, the "charts silently
    drift behind the vote list" failure mode this item describes should no longer recur — the
    underlying design gap (no CLI calls it directly) is unchanged, but the live exposure it created
    is closed. See `docs/SCHEDULED_INGESTION.md` (refreshed this same pass) for the full mechanism.

### Public-surface leaks (small, real, one-line fixes)

**Both re-verified 2026-08-02 by direct read of the current migrations — STILL OPEN, unchanged.
Re-checked again 2026-08-03: migrations 0021 and 0022 (the only two new migration files since 08-02)
touch neither `legiscan_datasets` nor `public_reconciliation_flags` — both items below are
unaffected and still open.**

**2026-08-03 (continued) update: item 11 is now CLOSED. Item 12 is still open, unchanged, but two
new drafted migrations (0023, 0025) touch adjacent ground — see each item below.**

11. ~~`legiscan_datasets` is anon-readable including `local_cache_path`~~ **CLOSED 2026-08-03.**
    Migration 0024 (dropped the `anon_read` policy) applied by Lance and independently re-confirmed
    live this pass: anon key gets `200 []` (0 of 31 rows), service-role key still sees all 31 rows
    intact — RLS default-deny now matches `vote_reconciliation_flags`'s posture, no data touched,
    only public reachability. `0010_legiscan_identity_and_ledger.sql:63`'s original `anon_read`
    policy language is now historical, not live.
12. **`public_reconciliation_flags` publishes the whole free-form `discrepancy` jsonb — STILL OPEN,
    unchanged.** `0016_public_read_surface.sql:60-63` is unchanged: `select vote_id, source_a,
    source_b, discrepancy, resolved, created_at ... grant select on public_reconciliation_flags to
    anon, authenticated`. The column list is supposed to be the wall, but one exposed column is an
    unstructured bag — any future writer adding a diagnostic field publishes it with no code change
    and no review signal. **Re-verified live this pass: open reconciliation flags are now 61** (was
    49 at compile of the earlier 08-03 note, 9 at doc-compile time) — more real rows flow through
    this same unreviewed public column than ever. Note: the audit's own adversarial re-verification
    (`docs/audits/2026-08-03-comprehensive-accuracy-audit.md`, "Refuted" section) downgraded the
    severity of this exact finding — every fact in the jsonb payload is already derivable from other
    anon-readable tables, so it's not a NEW leak, just an unreviewed one; kept open here as "still
    real, still worth a column allowlist someday," not escalated.
    **Separately, migration 0025 (drafted, not applied — see the top-of-file 2026-08-03 (continued)
    note) closes a DIFFERENT, newly-found leak in the same family:** bare `select=*` on `summaries`/
    `glossary_terms` currently returns internal pipeline columns (`model`/`prompt_version`/
    `bill_text_hash`/`run_id` on summaries; those plus `source_hash`/`needs_mapping` on
    glossary_terms) — confirmed still leaking live this pass via direct anon query. Not the same
    table as this item, listed here because it's the same class of defect (column list isn't the
    wall) and not yet its own numbered item in this list.

### Accepted residuals — do NOT "fix" or re-litigate these

- **Identical-full-name dateless same-seat pairs still auto-link** (`src/lib/person-identity.js:211`). This is the *current operating mode* of the merger, not an edge case — it's what let Menendez reach the write set. Durable fix is term-date backfill; T8c did 893 FEDERAL dates, MO terms still carry chamber/district with no dates. Nickname bridging *widened* it (line 225).
- **`identity_flags.cluster_key` drift:** membership change mints a new key; the old flag row sits orphaned/unresolved forever. Mitigation was display-side only. Relevant when reporting "the queue is down to N."
- **275 MO House 2024 roll calls refused** (`0000-00-00`) — they arrive later via house.mo.gov with real dates. **36 MO bills deliberately show status `0`** — LegiScan's codebook has no word for it. **21 bills refused by the 400k gate + 1 image-only PDF** — "nothing was ever truncated." **11 MO Senate journal days quarantined.** **444 roll calls have no bill** (nominations, cloture). **MO 2010-2014 has bills, zero votes** — a source gap (`rollCallsPlanned = 0`). **Federal history is 119th-Congress-only.** **OpenStates MO events carry no per-voter casts** (upstream).
- **Trust-layer residuals deferred to prompt v3:** `evidence_quote` content is unconstrained — a fabricated quote is storable as a public receipt; the sonnet verifier is the declared trust boundary. That acceptance must be restated if the verification model ever changes. **Materially higher-stakes as of 2026-08-03 than when this was first accepted:** migration 0021 (bullet-citation exposure) now RENDERS this exact field publicly on every bill page (`citations` on `public_verification_notes`, confirmed live, 220 rows, 0 shape/gating violations) — this residual used to describe an unconstrained field sitting unused in the database; it now describes an unconstrained field a visitor can actually read and trust as a "receipt." Not re-litigating the acceptance (that's Lance's call, not this pass's), just flagging that its consequence changed.
- **Glossary: 2,103 of 2,219 terms are bare stubs** (was 731 of 847 at the point this residual was first accepted, before the summary-volume growth that mints a term row per new citation — re-verified live 2026-08-03, matches DATA_INVENTORY exactly), 2,072 blocked on an unresolvable citation — a human mapping decision, not review backlog and not API spend. Real content = 116 entries, unchanged.
- **`quarantine:true` in the legiscan reconciler is unreachable from real evidence** — correspondence proof requires tally agreement, hard contradiction requires disagreement; they can't coexist. Cross-source disagreements are **permanently human-review flags by design.** The open vote-reconciliation flag count grew from 9 (compile time) to **49** (live-verified via `node --env-file=.env scripts/data-status.js`, 2026-08-02, re-verified live 2026-08-03 morning, exact match, still 49 open / 0 resolved, still 45 distinct roll calls) — 29 of the 08-02 increase is the Fitzwater undercount class TODO-25's session-merge fix surfaced (see §3 item 1), not new decay. **Re-verified live again 2026-08-03 (continued pass): now 61 open, 0 resolved** (direct query: `resolved=eq.false` and the unfiltered total both return 61 — every open flag is still genuinely unresolved, none silently closed). The 12-row increase since the same-morning 49 is not independently attributed in this pass — plausible sources include the mo-house-chamber correction census or ongoing legiscan/mo-senate-web ingestion ticks; worth a dedicated look if this exact number matters for a future claim. They will not self-clear; that's not a backlog to automate.
- **Retraction is this codebase's ONE sanctioned delete** (FK order, `legiscan-` prefix-guarded). Any other row-deleting code is a violation.

DATA_INVENTORY has a section literally titled *"Numbers that look alarming but are fine"* to stop recurring panic. Read it before flagging a count as a defect.

### Deferred with a gate chain still fully open

- **Glossary Task 7 live E2E was NEVER run.** Chain: 0007 applied ✅ → credits → golden drift ($0.35) → extraction backfill (~$0.75) → gloss batch → adjudicate → anon probes. Blocked on the spend hold since 2026-07-28. The site renders inline glossary terms from a pipeline that has never had a billed end-to-end run. Carries a MUST-REVISIT: `source_url` rendered as a clickable link without scheme validation in the **local review page** (the public `render.js` got a hardened allowlist) — confirm that gap is genuinely local-only.
- **Staff `/admin` review queue (TODO 7)** is genuinely not done — the review server is local-only at 127.0.0.1.
- **On-demand ingestion (TODO 11)** — Lance's stated *launch architecture*: "This will allow us to launch the system without having to fill every single constituents information beforehand and the system can fill it for us as the politician is looked up." **He does not expect a fully pre-filled DB before launch.** An agent optimizing for total coverage before go-live is working against his model.

---

## 4. Things I might wrongly believe

| Belief | Reality |
|---|---|
| **"The only thing gating Cloudflare is Lance's review queue"** (TODO.md:68) | Written *before* the 2026-07-31 evening audit that appended TODO 25-29: *"none were previously recorded."* Draining the queue does not finish the backend. |
| **"Backend live and accurate"** (CLAUDE.md status line, README.md:8) | Both predate the same audit. Five structural defects outstanding. |
| **`quarantine-microfix-report.md`: "0016's `public_freshness` already coalesces that absence to 0, so no fabricated value is ever written"** | **Disproven in production.** Caught live at 01:09:20 with ground truth = 7 quarantined days while the site said zero. The ledger says so explicitly: "the earlier micro-fix report wrongly concluded the 0016 coalesce was harmless." Fixed source-side 2026-07-31 06:09:24Z. |
| **public-site progress line 10: "WHATWG-mirroring strip verified"** | **False** — `\t\r\n` is not the full WHATWG C0 strip set; a leading `\x01` made `javascript:` execute in Chromium. Corrected by final review. |
| **legiscan `task-4-report.md`'s backslash rationale for `decodeStrings:false`** | Recorded as factually wrong. "Do not propagate the backslash rationale into future comments." |
| **MVP spec: "Nothing publishes without his click" + "static pre-render on publish"** | Both superseded. Trust-model v3 **auto-publishes** mechanically-verified-clean items; the shipped site is client-side JS over Supabase REST. The spec is a WORKING DRAFT but these lines aren't individually marked superseded — a fresh session could rebuild a gate v3 deliberately removed. |
| **LegiScan terms doc: primary-source parsers "become the reconciliation/audit layer"** | Later evidence overrides it. The MO Senate journals pipeline is **permanently completeness-critical.** Retiring the slow cron would silently lose an entire class of real floor votes. |
| **0018's comment: "the ingest/backfill CLIs' batch loops call it at batch end"** | They don't. `scripts/refresh-aggregates.js` says it was left as a follow-up. Grep: no `src/` file calls `refresh_vote_aggregates`. |
| **0010: "vote_reconciliation_flags deliberately NOT anon-readable"** and **"legiscan_datasets: harmless metadata (hash + timestamp)"** | 0016 built an anon view over the flags including the whole `discrepancy` jsonb; the datasets policy exposes 4 columns including `local_cache_path`. Both comments now mislead. |
| **Revoking anon on a base table locks it down** | **0018's three matviews FAIL OPEN** — they serve anon from their own independent grant off the last snapshot, indefinitely, after the base tables are revoked. 0016's `security_invoker` views fail CLOSED. Two opposite postures in one schema. 0018's header: *"Whoever touches base-table grants on these three tables in the future must read this comment first."* |
| **"Hardcoded counts were stripped from README and ARTIFACTS"** (CHATLOG) | Not done. README still carries 3,630 / 46,268 / 1,607 / "3,319 of 3,341"; ARTIFACTS still says "3,630 rows" and "1.47M vote casts." DATA_INVENTORY rule 1 forbids exactly this. |
| **TODO build-queue items 5 and 6 are open** | Both completed and merged; the checkboxes are stale. Item 7 (staff /admin) is genuinely still owed. |
| **"37 legislators identified"** | A misreading. Three numbers all legitimately mean "legislators": ~1,607 source ROWS · ~1,568 distinct PEOPLE · **37 merge CLUSTERS**. `persons` is not a roster — a row exists only where 2+ source rows are the same human. |
| **"bills with text" is a funnel stage under passage votes** | It isn't. Text ⊄ passage — 311 text-bearing bills have a non-passage vote. Text (3,630) and passage (3,341) **overlap**; neither contains the other. The 99.3% is 3,319/3,341, not 99.3% of bills (that's 9.5%). **TRAP:** sizing a summary batch off the passage count instead of the text-bearing set is what made 22 bills fail in wave 1. |
| **"draft" means "flagged"** | No such status. `status` lives on `summaries`; clean/flagged is a VERDICT on `summary_verifications`. Of 35 drafts: ~20 adverse, ~14 clean-unpublished, 1 unverified. **Zero published summaries carry an adverse verdict — the gate held.** (Glossary is a deliberate asymmetry: 8 of 116 published terms carry a flagged verdict because they were hand-adjudicated.) |
| **`run_id` tells you which run created a row** | It's the **last** run that wrote it. Grouping bills by `run_id` today attributes 37,662 to a status-patch run. |
| **Lance's "Upcoming bills" scope was descoped** | It was never recorded as deferred anywhere. His words: *"we also need to see items that are in the works that are upcoming that may come to vote soon"* (CHATLOG:75). Only the recorded-vote leg of the trigger was built; there's no upcoming page and `bill_actions` covers 113 of ~38,266 bills (0.3%), so there's no signal to trigger on. This is a **scope question for Lance**, not a silent fix. Same for static pre-rendering (moved to "Not in v1"). |
| *(Appended 2026-08-03, continued pass — this table itself is historical-record/append-only, existing rows above left untouched per this doc's own convention.)* **Row above: "legiscan_datasets: harmless metadata... the policy exposes 4 columns including `local_cache_path`. Both comments now mislead."** | **The exposure half is now fixed, the "comments mislead" half is not.** Migration 0024 dropped the `anon_read` policy (applied by Lance, re-confirmed live this pass: anon key gets `200 []`, 0 of 31 rows). The *data* is no longer publicly reachable. The *comment* in `0010_legiscan_identity_and_ledger.sql` itself was never edited to say so — a fresh reader of that file's own header still sees the original since-superseded rationale. Worth a doc-comment fix someday; not a live defect anymore. |
| **"37 legislators identified" / "37 merge CLUSTERS"** (row above) | **The cluster count itself moved.** The 2026-08-03 audit's Pierson-split correction (critical #1) undid one wrong merge: `persons` is now **36** (was 37), `person_links` **74** (was 76) — both re-verified live this pass by direct query (two `Tommie Pierson` legislator rows, zero `person_links` referencing either). The row's underlying POINT ("persons is not a roster, three different numbers all mean something different") is unaffected — only the specific historical count of 37 is now stale. `docs/DATA_INVENTORY.md` was corrected to 36/74 in a parallel pass the same day. |

---

## 5. The 60-second orientation

*Rewritten 2026-08-02 — the original version of this section was built entirely around the TODO*
*25-29 framing, which is now stale (see §3): those five items, plus 33 and 35, are all closed or*
*corrected. This section no longer centers on them.*

*Rewritten again 2026-08-03 — the 08-02 version's #1 priority ("display-time dedup, nothing built")*
*is now stale: that work is code complete, and the priority has shifted to getting Lance through the*
*apply sequence. This pass also closes out the "severity-sorted review view... his call whether it's*
*worth building" line from 08-02 — he said yes, and it shipped the same day.*

*Rewritten again 2026-08-03 (continued) — a SECOND pass, later the same day. This version's own #1*
*priority from a few hours earlier ("apply migration 0022") is now closed — Lance ran the whole*
*handoff sequence that same day, independently re-confirmed live below. The comprehensive accuracy*
*audit ran in between and all 4 criticals it found are fixed and verified live. The single biggest*
*framing change this pass: the Cloudflare Pages deploy spec is now the active top-level thread, not a*
*deferred milestone waiting on backend work — Lance's own words ("it sure feels like we've locked the*
*backend down"), confirmed against live data rather than taken as an agent's judgment call. Reordered*
*accordingly below.*

*Rewritten again 2026-08-04 — narrow correction only, not a full pass: the test-suite and migration*
*counts just below were stale (2,259/2,259 and 26 files were the 2026-08-03 numbers); corrected in*
*place to 2,294/2,294 and 30 files following a multi-layer* `refresh_vote_aggregates()` *timeout saga*
*that consumed most of that day's session (migrations 0026-0029; full arc in the top-of-file*
*2026-08-04 note). The "What actually matters next" list below was NOT re-derived this pass — flagged*
*inline instead, since this operational bug intervened between when that ranking was written and now.*

**Where it stands.** Backend is live and broadly trustworthy — **for the first time in this**
**document's history, every item in §3's "genuinely blocking" list is closed** (original items 1-5,
plus the new audit's 4 criticals, all independently re-verified live this pass). Real gaps remain
(see the numbered list below), but none of them are "a public number is being computed wrong"
anymore — mostly they're "coverage is thinner than it looks" or "a column leaks internal metadata," a
materially different risk class than what this document was tracking as recently as this morning.
The site is built and merged, **still not deployed, but the deploy spec is now actively being
written**, not paused behind a backend-readiness gate — see item 1 below. Suite: **2,259/2,259
green** (live-verified this pass, `node --test` from repo root, up from 2,235 this morning).
**[Corrected 2026-08-04: now 2,294/2,294 — see the top-of-file 2026-08-04 refresh-pass note.]**
Migrations: **26 files** — 0001-0021 plus **0022 and 0024 applied and confirmed live**, **0023 and
0025 drafted, confirmed NOT yet applied** (§3 and the top-of-file note have the detail on what each
one does and why leaving them drafted is currently safe). **[Corrected 2026-08-04: now 30 files —
0026-0029 landed since, the full `refresh_vote_aggregates()` timeout saga; see the top-of-file
2026-08-04 note for what each one fixes.]** Summary waves unchanged since this
morning: **115 published, 98 draft** (re-verified live, exact match). Identity merge: **36 clusters**
(was 37 — the Pierson-split correction), **74 person_links** (was 76; `DATA_INVENTORY.md` has not
been updated to reflect this yet, per the top-of-file note), 4 open flags awaiting Lance (unchanged).
Glossary: 116 real entries of 2,219 total (unchanged), still no billed E2E run (the spend hold itself
is suspended per §1, but nobody has actually run it). Reconciliation flags: **61 open** (was 49 this
morning), 0 resolved — see §3's "Accepted residuals" for why this isn't decay.

**What actually matters next, in order (revised 2026-08-03, continued) — ⚠️ this ranking predates
2026-08-04 and has NOT been re-derived since; see the top-of-file 2026-08-04 refresh-pass note before
treating it as a live snapshot:**

1. **The Cloudflare Pages deploy spec — NEW #1, the active top-level thread, not a "someday
   milestone."** Lance judged the backend ready, the comprehensive audit confirmed it (4/4 criticals
   fixed, verified above), and the same day he moved into `superpowers:brainstorming` for the deploy
   spec itself. **Status: IN PROGRESS, not complete** — confirmed against TODO.md's NOW section and
   directly against the filesystem this pass. Scope agreed (deploy mechanics only — explicitly
   excludes migration 0025 and the MO House caveat, item 2 below). Section 1 (scope/sequencing)
   approved. Two small pre-deploy fixes decided but **confirmed not yet built this pass**:
   `geocode.js` security headers (still bare `Response.json(...)` calls, no headers option anywhere in
   the file) and `site/404.html` (does not exist on disk). Section 3 (connecting Cloudflare Pages)
   presented in depth with two open sub-questions still needing Lance's answer: **3a** (fresh vs.
   existing Cloudflare account) and **3d** (whether to restrict Cloudflare's default per-branch
   preview deployments, since `site/config.js` hardcodes the real production anon key — every preview
   is a live copy of the real site; not a security hole, RLS is still the actual wall, but worth a
   deliberate answer rather than a default). Sections 2 (the two fixes' implementation detail) and 4
   (post-deploy verification checklist) not yet presented. **Next step when Lance is back:** answer
   3a/3d, finish sections 2 and 4 in the brainstorming conversation, write the spec doc, self-review,
   get sign-off, then `superpowers:writing-plans`. Full detail: TODO.md's NOW section, "Cloudflare
   Pages" entry.
   **Update, 2026-08-04: no forward movement on this spec's open sub-questions (3a/3d) is confirmed
   this pass.** The entire 2026-08-04 session was instead consumed by an urgent operational bug — the
   full multi-layer `refresh_vote_aggregates()` timeout saga (migrations 0026-0029, all root-caused
   and fixed; see the top-of-file 2026-08-04 note) — not by deploy-spec work. This item's own "IN
   PROGRESS" status above is therefore still a 2026-08-03 snapshot, not evidence of continued progress
   since. Cloudflare Pages deployment itself has not happened.
2. **MO House per-legislator vote-coverage gap (§3 item NEW-B)** — the audit found it, Lance
   explicitly scoped it OUT of the Cloudflare spec (a site-content decision, not deploy mechanics),
   and it's independently confirmed stark this pass: every one of the 18 `mo-house-xml` vote_casts in
   the entire database belongs to the same single fixture legislator row (Mark Matthiesen). Real,
   still open, still his call: ship visibly as-is, or add an explicit completeness caveat to the MO
   House vote section on `person-page.js` first.
3. **The remaining open landmines (§3 items 6, 7, 9, 12; item 11 is now CLOSED via migration 0024)**
   — items 6, 7, 9 were NOT independently re-read this pass (nothing in today's commits touches
   `ingest-mo-house.js`'s roster logic, `summarize.js`'s candidate picker, or `person-identity.js`'s
   unlink route); carried forward as still open on that basis, not fresh-verified. Item 12
   (`public_reconciliation_flags.discrepancy` jsonb) re-confirmed still open, now covering 61 rows
   (was 49 this morning). Migration 0025 (drafted, not applied) will close the adjacent `summaries`/
   `glossary_terms` internal-column leak once Lance applies it — confirmed still leaking live this
   pass.
4. **Lance's 4 identity flags** (Brown ×3, Moore ×2, Johnson ×2, Menendez informational) —
   structurally his decision, not an agent's. Unchanged, re-verified live this pass.
5. **98 unpublished summaries** — unchanged since this morning. The severity-sorted review queue
   (shipped 2026-08-03) sorts single-issue items first and names the missing provision inline,
   meant to make Lance's own pass through them materially faster. Still his 98 to work through.
6. **61 open reconciliation flags** (was 49 this morning, 9 at compile time) — the +12 since this
   morning is not independently attributed in this pass (plausible sources noted in §3's "Accepted
   residuals"); not confirmed as new decay, but the exact cause is a genuine open question worth a
   look if this number matters for a future claim.
7. **Two scope questions to surface, not solve:** "Upcoming bills" and static pre-rendering. Both
   were Lance's founding decisions that later work quietly narrowed without a recorded call.
   Unchanged from the original compile.
8. **The API-spend-approval hold is still suspended (§1)** — re-checked this pass (`git log` after
   `1886e88` still shows no reinstatement commit). Worth knowing before the next model call, either
   direction — it removes a procedural gate, not Lance's underlying interest in knowing what's being
   spent.

**Number discipline** (Lance: *"review the documentation... and clarify what we have then document it so we don't get confused again"*): `npm run status` is the **only** source of truth for numbers; `docs/DATA_INVENTORY.md` is the source of truth for structure and meaning. Never hardcode bills / votes / vote_casts counts into a doc. CLAUDE.md's fresh-session read-first list omits both of these — the two artifacts created specifically to stop that confusion.

**Operating reflexes for every batch:** one loop at a time · `npm run refresh:aggregates` at batch end · watch the `ingestion_runs` row, not stdout (and on a failed close read `counts.queriesSpent`, not `queries_used`) · implementers strictly serialized · gate commits on the extracted fail count · never paraphrase the canonical prompts out of `src/lib/summarizer.js` / `verifier.js` into a subagent brief · read the audit *detail*, never the `ok:true`.

**And the one that catches me specifically:** six times the defect was *my own ruling or plan text*, and each time it passed review while appearing fixed, because reviewers check implementations against rulings. Verify controller factual claims against live data before encoding them, and tell reviewers to attack the ruling itself.