# VisibleGov Backend — Senior Engineering Audit

**Date:** 2026-08-03
**Scope:** "A full, deep audit of the back end as if you were the world's top leading software design fellow" (Lance's framing) — a software-engineering-quality pass, complementary to the earlier same-day [8-domain data-accuracy audit](2026-08-03-comprehensive-accuracy-audit.md) (4 critical findings, all fixed). This audit asked: is this codebase *well-engineered*, not just *currently correct*?

**Process:** 11 independent domains audited in parallel on Fable 5 at max reasoning effort (architecture, operational resilience/monitoring, database/migration hygiene, testing quality, security architecture, code quality/tech debt, scalability, tonight's own unreviewed changes, dependencies, documentation/onboarding, external-integration robustness). Every finding rated `critical`/`important` was then independently re-verified by a second Fable 5 agent instructed to try to **refute** it — re-running the cited code, re-checking live data, never trusting the first agent's prose. 33 agents total, 770 tool calls, ~2.6M tokens.

**Outcome: 21/21 confirmed. Zero refuted. Two demoted `important → minor` on closer inspection. None escalated to critical.** That convergence — nothing evaporated under adversarial pressure — means the first pass was accurate, not that the bar was low: verifiers routinely found *stronger* live evidence than the original claim (see #1, #12, #17 below).

---

## Overall verdict

This is a well-engineered codebase — clearly above the norm for a solo project at this pace. The disciplines are real, not aspirational: 2,259 behavioral, fixture-grounded tests (independently re-run green by multiple auditors), zero secrets anywhere in git history, layered XSS/zip-slip/CSRF defenses, mechanically enforced rate limits and API budgets ("exemplary" per two independent auditors), a 6-dependency drift-free supply chain, one consistent error philosophy per layer. **Security and supply-chain produced zero important findings — genuinely rare for a project this size.**

The concerning part is equally plain: **every serious defect found fails silently.** No alerting exists anywhere. The scheduler reports failed ticks as healthy exit-0. A 14-hour production staleness outage (already fixed via migration 0026) was found by luck. And — new tonight — a shipped data-integrity remediation was silently defeated by a query truncation that falsified its own completion record. Strong correctness engineering, weak self-observation: that one asymmetry unites roughly 17 of the 21 confirmed findings. Nothing here is rot. Nearly all of it is cheap to fix.

---

## Confirmed findings

### 🔴 Live data-integrity defect — fix first

**1. Vote-dedup scan silently truncated to 1,000 of 8,221 rows — ~63 duplicate vote pairs (≈2,100 double-counted casts) currently live in public aggregates, believed remediated.**

`runCorrectVoteDuplicates` ([src/cli/correct-data.js:1415-1416](../../src/cli/correct-data.js)) uses a bare `.select()` on `votes` filtered by `like('source_key','legiscan-%')` — no `selectAll`, no `order`, no pagination. PostgREST caps any response at 1,000 rows. The scan is structurally blind to 88% of its target population, and because already-matched rows are skipped *in memory* rather than excluded from the query, repeated runs never advance past the same first server page.

Verified live: 8,221 legiscan votes exist; the identical bare select returns exactly 1,000. The verifier went further and ran the repo's own comparison functions against the full unpaginated set — **found 63 real, clean legiscan-vs-primary matches, all 63 beyond row 1,000, all 2018 MO Senate votes** (e.g. `legiscan-1530-rollcall-714400` ↔ `mo-senate-web-2018-RDay330301462-486-vote11`, 33-0). All 104 `mo-senate-web` votes pass the comparability check (null-aggregate shape, casts>0) — which **refutes the CHATLOG's recorded conclusion** that the backfill's `matched:0` result was "not a bug." That earlier session only sampled parseable-aggregate votes and excluded the senate shape entirely. `vote_duplicates` has 0 rows today; migration 0022's aggregate-dedup exclusion has never had anything to exclude.

Same file follows the mandated `selectAll` law correctly two hundred lines away (line 1155, line 1243 cites the rule) — this is an isolated miss, not a pattern. Tests (`tests/correct-data.test.js:259-305`) use small mock clients that never emulate the server's 1,000-row cap, so the defect was untestable as written.

**Fix:** route `correct-data.js:1415` and `:1419` (same bug, `vote_duplicates` read) through `selectAll`; add a regression test asserting the scan sees >1,000 rows; re-run the backfill; re-run `refresh_vote_aggregates()` afterward since ~63 pairs will newly mark and change public numbers.

---

### Operational resilience — the systemic story (all four confirmed)

**2. No alerting channel exists anywhere in the project.** No CI, no notifier, no webhook — repo-wide keyword sweep for every common alerting pattern came back empty except false positives (an LDAP `alertMessage` field, XSS-sanitizer test strings). `schtasks` shows `Last Result: 0` on the live scheduled task after a day that logged 13 consecutive refresh failures. **Fix:** a dead-man's-switch ping (healthchecks.io / ntfy.sh) on any unhealthy tick outcome — this also catches "the scheduler isn't running at all," a failure class exit codes can never signal (and which already happened once this session, when a background bash loop died with its session).

**3. A failed aggregate refresh exits 0, logs `healthy:true`, and logs `aggregatesRefreshed:true`.** All 13 outage ticks from the 0026 incident logged exactly this. `scheduled-ingest.js:931` computes `healthy` from the ingest child alone, before the refresh even runs; `:1150` sets `aggregatesRefreshed` from "refresh attempted," not "refresh succeeded." **Fix:** rename the field to `aggregatesAttempted`, add a real `aggregatesHealthy` boolean, surface failure in exit code or log shape.

**4. Matview staleness is still unmonitored after 0026.** `npm run status` reads only `public_freshness`, which covers ingestion sources, not refreshes. `refresh-aggregates.js` writes no durable record anywhere. The exact class of outage that just got fixed remains fully undetectable if it recurs from a different root cause (lock conflict, dropped index, permission drift). **Fix:** have the refresh write an `ingestion_runs` row so the existing freshness surface picks it up for free.

**5. A revoked service-role key degrades to indefinite, healthy-looking "nothing-due" ticks.** Mechanically reproduced (stubbed client returning Supabase's actual "Invalid API key" shape): every source reports `resolvable:false`, `pickMostOverdue` returns null, the tick logs `mode:'nothing-due'` and exits 0 — indistinguishable from a genuinely quiet period, forever. A separate, related gap: a mid-tick DB failure after the ingest child runs breaks the scheduler's own documented "one log entry per invocation" invariant. **Fix:** a distinct `all-lookups-failed` mode with nonzero exit; wrap post-child reconciliation so a tick still logs on DB failure.

---

### Tonight's own changes, re-reviewed fresh (both confirmed)

**6. Migration 0025 shipped with zero probe coverage.** `probe-public-surface.js` was last committed *before* 0025 existed. The real production regression it caused (bill-page 401) was caught only because a human happened to load the site afterward — not by anything mechanical. Migration 0024 is equally unprobed. **Fix:** extend the probe to assert column denials and replay the site's actual query strings; make "run the probe" part of the migration-apply convention going forward.

**7. Migration 0026's durability fix is enforced by a comment, not a guard.** This exact regression class already fired once — 0022's own author inspected `refresh_vote_aggregates()`, wrote "UNCHANGED" in a comment, and shipped the timeout-dropping version anyway. Two stale timeout-less copies of the function definition (0018, 0022) remain in the migration history as available copy-paste sources for a future edit. **Fix:** a migration-text regression test scoped to confirm the `SET statement_timeout` clause survives any future redefinition, plus the durable-refresh-record fix from #4.

---

### External-integration robustness

**8. Unguarded XML root access crashes an entire ingest run on a 200-status HTML response.** `us-congress.js:83` and `us-senate.js:66` — empirically reproduced with a real captured fixture. The identical bug class already caused a production crash once; a hardened sibling pattern already exists elsewhere in the codebase and simply wasn't ported here. **Fix:** port the guard as a plain typed error (verifier's caveat: not `SourceFetchError`, which would silently swallow legitimate probe failures).

**9. MO House BillList format changes fail silently empty**, poisoning the 24-hour cache with a falsely-"succeeded" run. Six different malformed response shapes all collapse to `[]` with no error; the MO Senate parsers throw loudly on the same class of input by explicit convention. **Fix:** throw on zero entries instead of returning empty.

**10. One bad MO House bill wedges the entire bill-detail pipeline forever** — head-of-line blocking, no quarantine mechanism, 1,946 bills currently pending behind it. The quarantine helpers this needs already exist in the same file for a different purpose. **Fix:** extend the existing `.failed.json` attempt-cap mechanism here; don't count 429s against the cap.

**11. A 200-status non-JSON response escapes the typed-error contract.** `http.js:33`'s body-read is outside the try/catch that wraps everything else; a mid-body connection reset surfaces as a raw `TypeError: terminated` instead of the codebase's own `SourceFetchError`. **Fix:** wrap all body reads, rethrow as the typed error.

---

### Database and migrations

**12. Migration 0022 is a loaded gun with no applied-state ledger.** The file still contains two superseded, dangerous definitions (the pre-0023 `security_invoker=true` views, the pre-0026 timeout-less function). A *partial* re-paste of just one section, or copy-forwarding either definition into a future migration, silently reverts a fix that's already live — and both mechanisms have **realized precedent in this exact repo** (0026's outage was caused by exactly this copy-forward pattern; 0023 documents live-vs-repo drift already having happened once). Verifier's nuance: a *whole-file* re-paste actually self-blocks (0022's `create table vote_duplicates` has no `IF NOT EXISTS`, so it errors and rolls back on second application) — the danger is specifically the partial-section-copy path, which is already an established practice in this repo's own docs. **Fix:** add `SUPERSEDED-BY` header comments to 0016/0018/0019/0020/0022 pointing at what replaced them; consider a lightweight per-migration ledger row as insurance.

**13. The vote-dedup exclusion is view-layer only — the trust page's own published cast count includes the duplicates it's supposed to exclude.** 0022 deliberately left `votes`' direct anon grant untouched as a documented residual; `vote_casts` is fully anon-readable too. `site/js/trust-page.js:63` counts `vote_casts` directly rather than through the dedup-aware view — so the platform's own public accuracy page displays a number that includes exactly the double-counting the dedup feature exists to prevent. Currently reads as 0 impact only because of finding #1 (nothing is marked as a duplicate yet); once #1 is fixed this becomes visibly wrong. **Fix:** point the trust-page count at `public_vote_feed`, or label the number as including duplicates.

---

### Testing

**14. The 0025 production regression class is invisible to the test suite even today.** Verifier ran the pre-fix, broken `bill-page.js` code against the current live test suite: 57/57 still pass. The suite tests component logic, not the query-shape/grant-scope contract that actually broke. **Fix:** a static contract test comparing site query strings against migration-granted columns.

**15. Four backfill test files depend on a gitignored, weekly-mutating local cache.** A fresh-clone simulation produced 12 failures. This has already broken once in this project's history, and the verifier found a second latent time-bomb (`datasetDate` pin) waiting to repeat it. **Fix:** a manifest/floor file plus an `existsSync` skip guard, with the skip count itself gated so silent skips can't quietly reach 100%.

---

### Architecture

**16. `src/cli` has become the de-facto shared library, including one genuine 3-node import cycle** (`ingest-legiscan.js → correct-data.js → ingest-mo-senate.js → ingest-legiscan.js`). 25 CLI-to-CLI utility imports total. The cycle works today only because every cyclic binding happens to be used inside function bodies rather than at module top level; the verifier built an exact-shape replica and empirically demonstrated the entry-point-dependent TDZ crash this invariant is silently protecting against — a crash class that would not reproduce in the module's own tests, which happen to import in a safe order. **Fix:** promote the handful of genuinely shared helpers (unique-violation predicate, dataset-cache readers, `mapMoStatusCode`, `journalPdfBasename`, passage-vote predicate) into `src/lib`.

**17. The two MO ingest CLIs (house, senate) carry parallel-evolved copies of the same ToU-compliance machinery**, including two distinct classes both named `CooldownConvergenceError`. Verifier found this **understated**: the production scheduler imports its cooldown logic from the *senate* copy and uses it to govern due-ness decisions for **all five sources**, including MO House — so a cooldown fix applied only to the house copy would silently not govern house's own scheduling. The senate file's own comment already states the port direction backwards relative to git history. **Fix:** extract the character-identical cooldown trio and cache helpers into `src/lib`; leave quarantine-artifact and done-marker logic alone — those genuinely differ per chamber.

---

### Documentation

**18. No setup/runbook document exists.** `serve-site.js` isn't referenced in `package.json` or `README.md`; the migration-apply procedure is scattered across 4+ docs with no single canonical version. A recurring tax specifically on this project's session-amnesiac working style. **Fix:** a runbook section in README.

**19. `docs/CONTROLLER_BRIEFING.md` is a stale palimpsest** — it currently claims migrations 0023/0025 are "NOT applied" (both are live) and has no awareness 0026 exists, while structurally presenting itself as the higher-authority catch-up document a fresh session should trust most. **Fix:** stop asserting migration applied-state in that doc at all (defer to `TODO.md`/live checks); add a dated banner.

---

### Confirmed but demoted by the verifier

**20. `handleIdentityDecision` is 378 lines / 71 branches** — real, but exhaustively pinned by 40+ HTTP-level tests, and the file is a localhost-only admin tool. `important → minor`. Extract per-action on the next real change, not urgently.

**21. README states the API-spend approval policy as currently binding** when it's actually under Lance's active suspension, and hardcodes counts that will drift. `important → minor` — every count checked out accurate as of the audit, and the error direction is conservative (understates activity, never overstates). Update the sentence; prefer magnitude language ("~2,300 tests") over exact counts that go stale within the hour.

---

## Findings that did not survive adversarial review

**None.** Every `critical`/`important` finding was confirmed. The adversarial pass corrected details (e.g., "structurally untestable" → "untested"; 0022's whole-file re-paste actually self-blocks even though partial re-paste doesn't) and in several cases found the underlying problem was *worse* than first reported (findings #1, #12, #17) — but refuted nothing outright.

---

## Appendix — unverified minor/informational items

**Minor:** 480s child-process timeout vs 600s SQL statement timeout mismatch on the refresh call, and that call is unwrapped by try/catch; missing `bill_sponsors(legislator_id)` index; a few schema-by-convention gaps (published-summary uniqueness, a missing `run_id` FK, a retract-vs-dedup FK ordering note); `legislator-page.js` has no test coverage at all; ~14 tests that just restate a constant; the geocode Cloudflare Function is an open proxy with no rate limit of its own (flagged as pre-deploy work); review-server GET endpoints lack a Host header check (a DNS-rebinding read window on the localhost-only admin tool); a `fast-xml-parser` advisory that doesn't apply (only the unused `XMLBuilder` export is affected); three genuinely dead functions; a couple of stale state-assertion comments; one `// TEMPORARY` guard that has been permanent for a while; 10+ CLIs not listed in `package.json` scripts; the aggregate refresh is O(full history) per tick (ceiling ~39M casts, ~140 years away at current ingest rate); a bill-page N+1 pattern (worst case 47 calls); trust-page uses `count=exact` where `count=planned` would suffice; `finalPairStatus`'s agreement path never increments its own counter plus an invisible singleton-contradiction case; `motionChamber` silently defaults to house on an unrecognized marker; the Pierson-split correction over-deletes by one row; `supabase-js` is declared `^2.45.0` in package.json but 2.110.9 is what's actually running; a heading-level inconsistency in PLAYBOOK_DELTA.md; no retry/backoff on transient network failures (judged mostly acceptable by design given this project's low ingest cadence).

**Verified positives, worth knowing so they don't get "fixed" by accident:** the per-adapter duplication in `src/adapters` is justified and, unusually, explicitly reasoned in comments at the point of decision; comment density (33.2% of `src/`) is mostly load-bearing citation, not noise; ingest CLI idempotency (re-run-after-partial-failure safety) is genuinely solid in all three checked; timeout constants are evidence-derived from real observed run history rather than guessed; the scheduler's locking design is unusually careful; the three-tier RLS/grant architecture is internally coherent; the 2,259-test suite is behavioral and fixture-grounded with near-zero duplication; error-handling philosophy is consistent per architectural layer; TODO/FIXME marker hygiene is exceptionally clean; `selectAll` pagination discipline is followed almost everywhere (this audit's #1 finding is the one real miss); the injection and secret-handling sweeps came back completely clean; trust-boundary input handling is layered and careful; the dependency lockfile has zero drift; the public site is verified genuinely zero-dependency vanilla JS; rate-limiting and API-budget enforcement are real and mechanical, not just documented.

---

## If I had one week

1. **Fix the dedup truncation** (`selectAll` at `correct-data.js:1415`/`:1419`), re-run the backfill, refresh aggregates, add the regression test. This is the only confirmed *live* data defect, and it sits directly on the platform's core accuracy promise.
2. **Make failure loud (~150 lines, closes five findings):** refresh outcome → an `ingestion_runs` row (freshness surfaces it for free); a real `aggregatesHealthy` field; an `all-lookups-failed` scheduler mode; a dead-man's-switch ping on any unhealthy tick or missed heartbeat.
3. **Extend the probe:** column-denial assertions for 0024/0025, replay the site's actual query strings, add the post-0026 statement-timeout migration-text test. Make "run the probe" part of the migration-apply convention itself.
4. **Harden the ingest boundary in one pass:** XML root guards, typed body-parse errors in `http.js`, throw-on-empty MO House list parsers, quarantine for wedged bill-XML targets — all of these are copies of a pattern that already exists elsewhere in the codebase.
5. **Dissolve the import cycle:** move the 5-6 genuinely shared helpers plus the cooldown/cache machinery into `src/lib`; the scheduler stops importing ToU-compliance logic from a 1,322-line CLI file.
6. **Test hygiene:** a manifest/floor fixture and skip guard for the gitignored cache dependency; the static grant-contract test from #14.
7. **Docs half-day:** README runbook section, a stop-asserting-migration-state banner on `CONTROLLER_BRIEFING.md`, `SUPERSEDED-BY` headers on the five migrations that need them.

After that week, the codebase's failure modes would be as loud as its successes — which is the only structural thing it's currently missing.
