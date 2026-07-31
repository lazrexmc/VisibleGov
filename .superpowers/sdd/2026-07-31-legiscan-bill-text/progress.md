Implemented 58a5c74 (1847/1847, ONE probe only — probe corrected the brief's assumed shape: LegiScan
prints url/state_link ON the text object plus a full alt_* document family). Review executed 14
attacks. VERIFIED CLEAN: write-ahead budget (crash mid-query still persists the count — overcount
direction), both close paths carry queries_used, key absent from report/failures/cache/rows/runs,
ERROR responses never cached, Rule 7 holds across runs and after row deletion, dry-run zero-query.
DECISIONS ADJUDICATED: (1) shared 'legiscan' source string CORRECT and load-bearing (a distinct
string would have doubled the effective cap — proven with a decoy run); (2) HALF right — dropping
the HOST filter necessary (all 2,202 proxy-placeholder targets are PDF; we fetch by doc_id so the
allowlist concern does not transfer), dropping the MIME filter falsified by the corpus (6,225
text/html bills all sit on state hosts the sibling reaches; spending 20.8% of the budget to store
nothing) → CONTROLLER RULING: restore mime gate at planning time; (3) graceful budgetRefused ACCEPT;
(4) typed-only bucketing right in principle, wrong in membership.
THREE HIGHs before any live query: Rule 7 double-query (dedup + pre-query existsSync recheck);
response identity never cross-checked (wrong text stored against a bill AND permanent cache poison —
regresses resolveDatasetBytes' own standard); 429/ERROR does not abort (500 requests issued after
LegiScan said stop). Fix round dispatched.
Fix round 1 (c6c851f, 1863/1863): all 3 HIGHs + 4 MEDs + LOWs closed with the reviewer's exact
constructions TDD'd red-first. Rule 7 now enforced twice (planner dedupes by doc_id; the loop
re-checks existsSync per iteration instead of a pre-loop snapshot). Identity cross-check
(assertBillTextIdentity) runs BEFORE the response is trusted for anything, and the cache write
happens only after it passes — so a mismatched live response can never poison a doc_id the rule
says can never be re-fetched. RateLimitedError aborts; consecutive-status-error breaker at 5;
alertMessage surfaced. Mime gate restored at planning time per the controller ruling.
CONTROLLER ADJUDICATIONS of the implementer's concerns: (3) --session startsWith ACCEPTED (two
hashes can hold different bills; dedup is the right fix); (1) dense control flow → re-review will
examine the flow itself; (2) REAL GAP — abort paths discarded the run ledger, the same class fixed
in ingest-mo-senate hours earlier → micro-round dispatched to carry partial counts + a named abort
reason through the failure close while keeping throw semantics.
Micro-round (d5bcb8f, 1868/1868): both abort paths attach err.partialReport (counts, planCounts,
passagePriority, failures, abortReason) before throwing; buildAbortCloseDetail folds it into the
failure close, degrading gracefully for an unexpected crash; exit 2 for a named abort. Implementer
also found and fixed a LATENT TEST-FIXTURE GAP — makeFakeWriteClient's ingestion_runs builder was
missing .maybeSingle(), silently swallowed by buildFailureCloseDetail's try/catch, so every prior
queries_used re-read in those tests had been asserting a FALSE ZERO. Tests were lying; now they
aren't.
PRE-FLIGHT PLAN (dry-run, zero queries): billsPlanned 3,177 priority bills; duplicateDocId 0;
noTextEntry 252; skippedNonPdfMime 6,225 (the restored planning-time gate saving 20.8% of budget);
docCacheHits 0. BUDGET: 79 used this month across 50 runs + 3,177 planned = 3,256 projected,
under even the conservative 5,000 default cap (real account cap 30,000) — no override, no batching
needed for budget. Adversarial pre-flight workflow running (terms compliance / stored-fact
integrity / operator truth) as the final gate. OPERATIONAL PLAN once GO: --limit 25 smoke batch →
spot-check stored content against the real bills → full 3,177 run (~53 min at the 1s cadence) →
refresh aggregates → then summary throughput work.
PRE-FLIGHT WORKFLOW VERDICT: **GO FOR LIVE RUN**. All prior guards verified intact by execution
(Rule-7 dedup + per-iteration existsSync recheck, identity cross-check before cache write,
RateLimitedError abort + circuit breaker, planning-time mime gate, atomic doc-cache writes,
missingSourceUrl refusal). No terms violation in flight; nothing can store a wrong or unverifiable
fact in bill_texts. TWO operator-truth findings survived, both ledger defects:
(1) REACHABLE BY THIS BATCH — buildFailureCloseDetail swallows the ingestion_runs re-read error and
postgrest RESOLVES on failure, so a transient 500/504/timeout at abort-close writes queries_used:0
over the write-ahead ledger (proven: 6 real queries closed as 0). Undercount = the terms-violating
direction, and a re-run could then pass a budget gate that should refuse.
(2) LATENT — datasetsRead/datasetsMissing/sessionUncached never reach the closeRun detail and never
influence status, so a worklist truncated by unreadable cache files closes 'succeeded' exit 0 with
no trace (proven: 1-of-3 readable → inserted 2, 'succeeded', ledger silent). The sibling keeps these
in emptyCounts(); this file regressed by demoting them. Trigger: ingest-legiscan writes 3-9MB
dataset envelopes with a bare writeFileSync (no temp+rename).
Both dispatched before any live query. OPERATOR GUIDANCE from the verdict, adopted: during batches
watch the ingestion_runs row not stdout — confirm counts.billsPlanned matches the dry-run before
trusting a 'succeeded'; if a batch closes 'failed' with abort_reason, read counts.queriesSpent (NOT
queries_used) as the authoritative spend before starting the next batch.
LIVE RUN COMPLETE (2026-07-31 07:07): smoke batch 25/25 clean and spot-verified (real house.mo.gov
PDFs, correct bill attribution incl. the HB 35 combined-vehicle case 'HOUSE BILL NOS. 35 & 323',
versions verbatim Enrolled/Engrossed, source_urls openable). Full priority run: 3,152 planned,
3,152 queries spent, 3,140 inserted, status 'partial' with an HONEST reason — 11 oversizeRefused
(HRB 2467 561k chars, HRB 1 550k, SRB 975 751k — the giant-bill class, refused not truncated) and
1 extractEmpty (HB 90 Conference Sub, an image-only/text-free PDF). 0 identityMismatch,
0 cacheCorrupt, 0 statusError, 0 missingSourceUrl, 0 decodeFailed, 0 budgetRefused.
THE UNLOCK: bill_texts 465 -> 3,630. Bills with a passage vote AND text: 154 -> 3,319 of 3,341
(99.3% coverage; 22 remain = the 11 oversize + extractEmpty + a few without a text entry).
Budget: 3,177 queries spent of the 30,000 monthly account cap (~10.6%), 79 prior = 3,256 total,
inside even the conservative 5,000 default. Aggregates refreshed.
NEXT: summary throughput — the corpus is no longer the constraint; Lance's plan usage is.
