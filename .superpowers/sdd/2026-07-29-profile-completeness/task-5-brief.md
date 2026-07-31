### Task 5: Summary priority queue (code) — subagent orchestration stays with the controller

**Files:** Create `src/cli/summary-queue.js`, tests.
- CODE side (this task): a queue planner + result writer, NO model calls: `plan` mode emits the prioritized worklist (passage-vote bills first — question ~ /passage|third reading/i — then others; excludes: already-summarized, no-text, oversize per MAX_TEXT_CHARS) as JSON; `record` mode accepts one bill's {summary_json, verifier_verdicts} (produced by the controller's subagents), runs the SAME mechanical gates the API pipeline uses (schema shape, completeness derivation via assessVerdicts, section-citation checks), writes summaries/summary_verifications with provenance model='subagent:<model>' + prompt_version, and (clean) auto-publishes per trust-model v3 / (flagged) leaves draft. Idempotent; resumable; honest counts.
- ORCHESTRATION side (NOT this task's code): the controller session dispatches opus-subagent author + sonnet-subagent verifier per queued bill using the canonical SYSTEM_PROMPT/SUMMARY_SCHEMA/verify prompts exported from summarizer.js/verifier.js, then feeds `record`. Overnight chunks, throttled.
- [ ] TDD the planner (priority, exclusions) + record gates (rejects malformed/incomplete; never trusts self-reports) → implement → suite green → commit.

## Global Constraints

- Zero metered-API model calls. The GOLDEN_CHECK/GLOSS gates stay closed. Congress.gov + cached-ZIP reads only; every fetch through the existing polite limiters.
- Additive writes only (insertIfAbsent/additivePatch); selectAll for every multi-row read (legislators 1,576; bills 38,250; votes 9,900+ — everything is past or near the 1,000 cap); provenance run_id everywhere; typed errors; skip≠empty; honest counts.
- DESIGN FREEZE (two-steps-ahead ruling): no new per-state identity columns, ever — future states ride legiscan_people_id + terms. 0014's comments state this.
- Draft-then-apply: 0014 written + committed; Lance applies; everything gated via isMissingRelationError until then.
- Identity invariants are law: full-name-variant necessity, asymmetric cost, writer BELT, pairwise name-sets. Attach-to-existing must reuse the same matcher primitives — no parallel matching logic.
- node:test bare invocation; 979 baseline stays green; fixtures-first (cached ZIPs and real Congress.gov captures are the fixtures). Commits end: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---
