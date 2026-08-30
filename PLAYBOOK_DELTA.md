# PLAYBOOK_DELTA — what VisibleGov inherits, and what it will add

*Companion docs: `CHATLOG.md` (word-for-word decision trail), `CLAUDE.md` (this project's own
working rules), `TODO.md` (backlog — its RESUME HERE block is the only live-verified status). This
file was seeded 2026-07-27, before any VisibleGov code existed — the distilled, reusable lessons
pulled from Lance's other projects, read BEFORE the first line of VisibleGov got written, per his
own established method — and has carried VisibleGov's own lessons since (§7 and the numbered
lessons after it). Seed-time framing updated 2026-08-23; an index of the lessons follows.*

---

## Index of lessons (added 2026-08-23)

**Numbering convention.** Lessons 1-13 are the numbered list items under "§7. VisibleGov's own
delta" — cite them as "§7 lesson N" or plainly "lesson N". From 14 on, each lesson is its own H2,
`## Lesson N — <title> (<date>)`, so `grep -n '^## Lesson 27 '` jumps straight to it (a
`grep '^## Lesson 9'` finds nothing — lesson 9 is a list item). The form switched at 14 (commit
44c5799, 2026-07-31): from there, entries are multi-paragraph write-ups — a failure narrative, the
diagnosis, then the rule — which a list item cannot hold. §3-§6 are INHERITED lessons from the
sibling projects and are cited by section ("§3.3", "§5.2"), never by lesson number. This file is
past the Read tool's 25k-token single-Read cap (a cold Read truncates partway through), so page it
with offset/limit or jump by grep.

| # | Date | Lesson |
|---|------|--------|
| 1 | §7 | `node --test <dir>` breaks on Node 24 / Windows — run bare `node --test` |
| 2 | §7 | Never let the audited model grade its own completeness — derive the verdict mechanically |
| 3 | §7 | HTML-strip traps in government text — strip the known marker before decoding, never bracket-strip decoded text |
| 4 | §7 | Supabase edge blocks secret keys on browser-like user agents — use curl/node |
| 5 | §7 | Read LinkedUmp's deploy lessons in place (deploy done 2026-08-05; registrar cruft still applies to the custom domain) |
| 6 | §7 | Append controller rulings INTO the brief file |
| 7 | §7 | Attribute cross-process effects before judging honesty |
| 8 | §7 | Verify the actual counterfactual before overruling a subagent |
| 9 | §7 | Additive pipeline stages must never fail the primary product |
| 10 | §7 | Sentence-splitting legal text: over-split, never silent merge |
| 11 | §7 | Control characters don't survive tool-write escaping — generate sentinels at runtime |
| 12 | §7 | Hotfixes get task reviews too — urgency is when review matters most |
| 13 | §7 | A shared surname is not identity; write plan predicates as MUST/NEVER, not slash-alternatives |
| 14 | 07-31 | `&&` after a `grep` is not a test gate — gate on the extracted fail count |
| 15 | 07-31 | A schema bound is a request, not a guarantee — re-verify at the gate |
| 16 | 07-31 | Audit output exists to be read, not to be `ok: true` |
| 17 | 07-31 | Correcting production data: source the mapping, guard the write |
| 18 | 08-01 | Never hand-transcribe machine-readable lists into agent dispatches |
| 19 | 08-01 | Government sources say "not found" with HTTP 200 + a human-readable page |
| 20 | 08-02 | This project's Supabase endpoint never populates `count` on `.update().select()` |
| 21 | 08-02 | A regex capture group is a string; a JSON field of the same name may not be |
| 22 | 08-02 | A status flag is not the invariant if more than one writer can set it |
| 23 | 08-03 | Grepping a function's branches for a marker proves only the branches that HAVE it |
| 24 | 08-03 | An existing test can encode an architectural boundary a new design missed |
| 25 | 08-03 | The Bash tool strips a layer of backslash-escaping before Node sees a `-e` command |
| 26 | 08-04 | RPC calls hit a ~120s edge-gateway timeout (fixed by pg_cron, 0027); grep CHATLOG before re-diagnosing |
| 27 | 08-04 | Postgres `statement_timeout` is armed ONCE, from the GUC ambient at statement start |
| 28 | 08-04 | The `LEFT JOIN ... WHERE x IS NULL` anti-join can be catastrophically misestimated by the planner |
| 29 | 08-04 | Run a plain `EXPLAIN` BEFORE any empirical timing investigation |
| 30 | 08-05 | A contaminated SHELL turns correct tests red — never `source .env` before `node --test` |
| 31 | 08-05 | "Relative to what?" — every path field in a deploy console is silently asking it |
| 32 | 08-05 | A static host applies its OWN URL semantics before your rules run |
| 33 | 08-05 | Fix every object that carries a bad idiom and extend the guard to the whole class |
| 34 | 08-06 | `state` + `chamber` do not identify a legislature; `jurisdiction_id` does |
| 35 | 08-09 | Quote-bearing text for a native exe goes through a FILE, never an argument (PowerShell 5.1) |
| 36 | 08-09 | A negative-predicate gauge silently absorbs every status value invented after it |
| 37 | 08-10 | Diagnose a silently-dead background task from its disk artifacts; resume from journaled state |
| 38 | 08-10 | Park a failing STRUCTURAL CLASS, not one instance at a time |
| 39 | 08-16 | A tool-call parameter can be silently truncated in transport (~50KB) |
| 40 | 08-17 | Too big to send: bank it to a file and send a pointer |
| 41 | 08-19 | A test fake that mirrors return shapes but not CONSTRAINTS passes every concurrency test |
| 42 | 08-19 | A verbatim-quote check is only as strong as the excerpt's provenance |
| 43 | 08-21 | Killing a background SHELL does not kill its node child; verify liveness by PID |
| 44 | 08-21 | A spend cap that only gates BEFORE submission cannot stop a batch; project from disk, calibrate HIGH |
| 45 | 08-22 | A mostly-NULL sort key degrades silently; measure coverage, grep every consumer |
| 46 | 08-22 | Anything retyped into a launch call is a transcription; keep it tiny, point at the rest |
| 47 | 08-22 | `Workflow({name})` can serve a cached script; launch edited workflows by `scriptPath` |
| 48 | 08-23 | A grammar verified on two fixtures is a hypothesis; ground-truth EVERY quarantined instance |
| 49 | 08-23 | "Needs human review" is honest only if a human could resolve it; a bill-less roll call is a typed record |
| 50 | 08-23 | A never-exercised fallback is a hope; "not derivable" is true only of the derivation tried |
| 51 | 08-26 | A status word that is always the same value carries zero bits; probe one record you already hold |
| 52 | 08-26 | Identical payloads are not identical identity; prove sameness from the source's own record pointer |
| 53 | 08-26 | Writing the lesson does not mean obeying it; enumerate the discriminators BEFORE applying |
| 54 | 08-26 | A provider's record id is not an identity; N ids can name one physical event |
| 55 | 08-26 | A missing capability is a blocker to raise, not a fork to quietly take |

Dates are 2026; "§7" rows are undated list items (seeded 2026-07-27, accumulated through
2026-07-29 — lesson 13, commit e4f884d; lesson 14 on 2026-07-31 began the H2 form). When a new
lesson lands, add its row here in the same commit.

---

## 0. The lineage — five domains, one compounding method

The transferable asset across Lance's projects has never been a codebase — it's a **method for
keeping LLM-driven production coherent over long horizons**, sharpened by each project and carried
to the next.

- **NBA2K → league (`F:\NBA2K`, `F:\league`) — quant/ingestion platform → LONG-HORIZON discipline.**
  485+ documented sessions; layered promotion gates (staged validation windows, multi-metric
  "2-of-3 wins" thresholds, frozen-job invalidation if a gated file mutates mid-window); drift
  detection with concrete statistical tests (Cohen's d per feature); a three-layer durable-memory
  system (a dated session log, a tagged structured chat transcript, a cross-tool export bridge);
  adversarial cross-model audits (one model's "10 findings" turned out to be 10 fabrications - a
  SECOND independent model is what actually caught real bugs). **Carried forward: promotion gates +
  drift detection + durable memory + adversarial audits = ingestion/model work that compounds
  instead of silently drifting.**
- **Pokemon (`F:\Pokemon`) — TCG deck-building workbench → GROUNDING discipline.** An offline
  database of every real card (20,324 rows, full-text search) exists specifically so an LLM
  proposing deck ideas can never hallucinate content - "LLM proposes, deterministic engine
  verifies, DB grounds." Hard lessons: a vendor-supplied "authoritative" field turned out to be
  unreliable and had to be cross-checked against raw source data; keyword/regex sweeps over text
  missed real hits that only a full manual pass caught; config choices don't carry safely between
  contexts without re-verifying. **Carried forward: never let an LLM assert content that isn't
  grounded in a real, queryable source-of-record - and don't trust a single upstream field as
  ground truth without a cross-check.**
- **IBTP / Inoculated by the Phoenix (`F:\Inoculated by the Phoenix`, `F:\ue5\IBTP`) — feature-film
  pipeline → CANON + HANDOFF discipline, in a non-code domain.** One Treatment document owns all
  timecodes as the sole source of truth; derived working files sync bidirectionally against it; a
  paste-ready `LLM_HANDOFF.md` onboards a fresh AI session in minutes; an anti-repeat protocol
  checks what already exists before generating anything new. **Carried forward: one canonical
  source of truth + a paste-ready handoff doc + check-before-you-generate.**
- **Glizzness (`C:\...\MidMoConsultant\James Jason Trinton Johnson`) — small-business ops platform
  → the REUSABLE STACK + SECURITY + the replication playbook itself.** The $0 stack (Cloudflare
  Pages + Supabase + vanilla JS); RLS as the actual wall, not UI hiding; a `REPLICATION_PLAYBOOK.md`
  that packaged the method for reuse. **Carried forward: a reusable stack + security-as-a-wall +
  a written replication playbook.**
- **LinkedUmp (`C:\...\MidMoConsultant\LinkedUmp`) — two-sided marketplace → the RAPID-LAUNCH LOOP,
  standing on all four above.** Idea → compile → spec → freeze → build → adversarial review-gate →
  deploy; chatlog + memory as crash-proof continuity; compile-don't-extrapolate; schema pre-pays
  the roadmap; model the workflow's REAL stages (a tournament is announced, then registered, then
  scheduled - not all-at-once); full system audits that catch real live bugs (an assigner could
  verify their own credentials; a delete silently no-op'd). **Carried forward: the whole pipeline
  as one repeatable loop + periodic adversarial system audits, not just one-time review gates.**

**The compounding claim:** promotion-gates-and-drift-detection (league) + grounding-against-a-real-
source (Pokemon) + canon-and-handoff (IBTP) + stack-and-security (Glizzness) + the rapid-launch
loop (LinkedUmp) all land on VisibleGov at once, for the first time merged into one seed document.
VisibleGov's own job is to prove the method works on a SIXTH domain - public civic data - and add
its own delta back to this chain. *(The seed text said "FIFTH"; five prior domains are listed
above, so VisibleGov is the sixth — arithmetic corrected 2026-08-23.)*

---

## 1. Why VisibleGov is a strong fit for (almost) all of it

VisibleGov's actual shape - ingest legislative data from government sources, generate plain-
language bill summaries, track and surface roll-call votes - maps onto inherited lessons more
directly than any prior project has:

- It's an **ingestion pipeline** (bill text, vote records, legislator rosters from public APIs) -
  exactly league's domain. Rate limits, partial/stale responses, schema drift from the source, and
  incremental-vs-backfill collection are all real risks here, not hypothetical.
- It will almost certainly involve **LLM-generated summaries of real source text** - exactly
  Pokemon's domain. A hallucinated bill summary is not a cosmetic bug, it's the whole product
  failing at its one job. Ground every summary in the actual retrieved bill text; never let the
  model "fill in" what a bill probably says.
- It needs **one canonical source of truth per bill/vote** (the actual government record) with
  everything else - the plain-language summary, any tagging/categorization - treated as a derived,
  re-verifiable layer, not an independent fact. IBTP's canon discipline, applied to law instead of
  a film treatment.

## 2. Non-negotiable principle (VisibleGov's own "soul" - set before any code exists)

The entire value of this product is that people trust it *more* than they trust the politicians or
the media spin around them. That only holds if it is **mechanically neutral**: identical treatment
regardless of party or office, every claim traceable to the actual bill text and the actual
recorded vote, no editorializing baked into a summary. If a design choice would make the tool read
as favoring one side, it is wrong regardless of how well-intentioned the motivation behind building
it is. Revisit this section before shipping any summarization or scoring logic.

## 3. Ingestion-pipeline lessons (from league, directly applicable)

1. **Distinguish "skip" from "empty."** A rate-limited or failed fetch must never be represented
   the same way as "the source genuinely has nothing new" - league shipped a real bug where a
   rate-limit skip returned an empty set and got misread as "no data," causing bad downstream
   decisions. Use a distinct exception/state, never a falsy return.
2. **Rate limits are a shared resource, not a per-caller budget.** If more than one process/job can
   hit the same government API, centralize the limiter state so counts aren't double-spent.
3. **Provenance-tag every derived write.** Every stored bill summary / vote record should carry
   which ingestion run, which source snapshot, and which model/prompt version produced it - so a
   bad batch can be traced and re-run without guessing. Don't backfill provenance for old rows
   retroactively with guessed metadata; leave them untagged and move on. *(Concrete instance for
   DATES, 2026-08-23: a vote date printed on the roll call and a date derived from the same
   source's tallied history action are different provenances — migration
   `0032_vote_date_provenance.sql` (DRAFTED, awaiting Lance's apply as of 2026-08-23) adds
   `votes.vote_date_provenance`, NULL for printed dates and a verbatim receipt for derived ones,
   and the ingest refuses to store a derived date until the column exists. See lesson 50.)*
4. **Startup recovery and steady-state polling are different code paths.** Collect everything once
   on process start (catch up after downtime), then poll incrementally after that - don't conflate
   the two.
5. **Backfill/import should be additive and write-once by default** - only fill genuinely missing
   fields, never silently overwrite an already-set value from a prior run.
6. **A staged promotion gate beats a single-sample decision** - if VisibleGov ever auto-classifies
   or auto-tags bills (topic, likely impact, etc.), don't trust one small batch of results; gate any
   "this classifier is ready" decision behind volume + multiple metrics, the way league gates model
   promotion.

## 4. Grounding + verification lessons (from Pokemon, directly applicable)

1. **Never trust a single upstream field as ground truth without a cross-check** - Pokemon's vendor
   "legalities" field looked authoritative and was wrong; the real answer had to be derived from a
   different raw field. A bill-status or vote-outcome field from any secondary aggregator should be
   cross-checked against the primary government source, not assumed correct.
2. **Text-pattern/keyword sweeps miss real hits.** If bills get tagged by topic via keyword
   matching, expect misses; don't treat a keyword pass as exhaustive without periodic manual spot-
   checks against the full text.
3. **Config/prompt choices don't carry safely between contexts.** A summarization prompt tuned for
   one bill type (say, a budget bill) may silently misfire on a different type (a resolution, a
   constitutional amendment) if reused without re-verification.
4. **Sanitize search input.** Bill titles/legislator names will contain punctuation that can break
   naive full-text search queries if not escaped.

## 5. Cross-cutting build/process lessons (from Glizzness + LinkedUmp, already proven twice)

1. **Spec → freeze → build → adversarial review-gate.** Don't skip the review-gate step because the
   spec felt obvious - LinkedUmp's per-task reviews caught 9 real defects before any of them touched
   a live database.
2. **Chatlog + memory are the flywheel, not overhead.** Log every substantive exchange in
   `CHATLOG.md` as it happens; persist decision-bearing facts to durable memory immediately.
3. **Model the real lifecycle stages, not the end state.** A bill isn't just "introduced" or
   "passed" - it moves through introduction → committee → floor vote → passage/failure → (for some)
   executive action, and each stage has genuinely different available data. Building UI/schema
   around the end state only (like LinkedUmp initially assumed every tournament already had a full
   game grid) will misfire the same way here.
4. **Run periodic full-system audits, not just point-in-time review gates.** LinkedUmp's later
   audit found a live security gap (a role could self-verify its own credentials) that no per-
   feature review had caught, because the two features were built in different sessions months
   apart. Schedule a real audit pass once there's enough surface area to have gaps between features.
5. **Draft-then-apply for anything touching production data.** Write the migration/change, explain
   it, let Lance review and apply it himself.
6. **The owner is the spec's other half.** Lance's own reasons for building this (see his own words
   in CHATLOG once captured) and his own sense of which politicians/bills matter most are exactly
   where the distinctive, non-generic product decisions will come from - don't design this as a
   generic "GovTrack clone," ask what's missing from the existing tools that made him want to build
   this instead of just using them.

## 6. Adversarial-audit + honest-status lessons (from league, worth adopting from day one)

- **A single model's "findings" are not verification.** League's own audit history shows one model
  fabricating 10 nonexistent bugs while a second, independent model caught 2 real ones. Any claim
  of the form "the bill summary is accurate" or "the vote data matches the official record" should
  survive an independent second check before being trusted, not just a single pass.
- **Honest-status language over hopeful framing.** "The classifier looks promising on this batch"
  is a different claim than "the classifier is validated" - say which one is true. Applies doubly
  here: overclaiming accuracy on a civic-trust tool is a credibility risk, not just an engineering
  one.

---

## 7. VisibleGov's own delta (accumulating as of 2026-07-27)

1. **`node --test <dir>` breaks on Node 24 / Windows.** Passing a directory arg to the test
   runner (`node --test tests/`) dies with MODULE_NOT_FOUND — Node treats the dir as a module
   entry. Bare `node --test` (default `*.test.js` discovery, excludes node_modules) works and
   also avoids the manual-registration trap of an index.js test shim (a forgotten future test
   file would silently never run). Cost two fix commits + a controller/implementer dispute to
   settle.
2. **Never let the audited model grade its own completeness.** Slice 2's verifier (sonnet
   refuting opus) returned an `overall` verdict — and we initially stored it as-is. The final
   review caught it: a verifier returning 3 verdicts for 5 bullets + "clean" would pass silently.
   Rule: derive the verdict mechanically from the verdicts themselves (count match, index
   coverage, all-supported), never from the model's self-report. The model being audited on X
   doesn't get to assert X.
3. **HTML-strip traps in government text.** GPO bill HTML carries a literal `&lt;DOC&gt;` marker;
   a "helpful" second tag-strip pass AFTER entity decoding silently swallowed everything between
   two decoded angle brackets (e.g. `< 100 ... > 50`). Strip the specific known marker before
   decoding; never run an unrestricted bracket-strip on decoded text.
4. **Supabase edge blocks secret keys on browser-like user agents.** PowerShell's
   Invoke-RestMethod gets 403 "Forbidden use of secret API key in browser" — use curl/node for
   service-role REST checks.
5. **At Plan-3 deploy time, read LinkedUmp PLAYBOOK_DELTA §4.3-4.4, §5 (four-phase deploy
   runbook), and §8.2 in place** (`C:\...\MidMoConsultant\LinkedUmp\PLAYBOOK_DELTA.md`):
   Cloudflare funnels to Workers (use Pages → Connect to Git); registrar DNS cruft fights
   custom domains; Pages ignores `_headers` Cache-Control on assets — verify deploys at the
   ORIGIN with curl+cachebuster, never a browser screenshot; never combine `?v=` pins with
   revalidation headers. *(Deploy DONE 2026-08-05 — lessons 31-33 record what it taught;
   `docs/CLOUDFLARE_DEPLOY.md` is the runbook. §4.3's registrar-DNS-cruft warning is the part
   still live: it applies to the pending `visiblegov.us` custom-domain phase, decided 2026-08-22,
   Lance's console work.)*
6. **Append controller rulings INTO the brief file.** A reviewer flagged an honest implementer for a "fabricated citation" that was actually verbatim from the controller dispatch - invisible to the reviewer because dispatches are not files. Rulings that extend a brief belong in the brief.
7. **Attribute cross-process effects before judging honesty.** A background driver loop auto-running newly-committed code wrote an artifact the reviewer pinned on the implementer. Long-lived loops reload code per invocation; check process logs before concluding anyone lied.
8. **Verify the actual counterfactual before overruling a subagent.** The controller "verified"
   that removing a shim was safe by running the suite — with the shim still present. The
   implementer re-tested with the file actually absent, pushed back with evidence, and was
   right. An adversarial check only counts if it tests the world in the state being claimed
   (league's §6 lesson, now proven in-house).
9. **Additive pipeline stages must never fail the primary product.** Wiring glossary-term
   persistence into the summarize CLI initially guarded only the "table missing" case; ANY
   other glossary-side error crashed the whole batch — and closeRun('failed') overwrote the
   run detail, erasing the honest record of every bill already processed. Rule: a secondary
   write rides in a catch-all that records a structured warning; the primary row always lands;
   a later backfill self-heals the secondary (key its retry eligibility off the SECOND write's
   existence, not the first's).
10. **Sentence-splitting legal text: bias ambiguity toward over-split, never silent merge.**
    Dotted citations ("42 U.S.C.") both break naive splitters and, once "protected", can
    swallow a real sentence boundary — which silently under-verifies (one verdict covering two
    claims). Protect every dot EXCEPT the abbreviation's last; accept documented over-split
    noise. In a verification pipeline, noisy-but-honest always beats quiet-but-wrong.
11. **Control characters don't survive tool-write escaping.** Writing a \x01 placeholder as a
    source-level escape produced a literal NUL byte in the file — grep/git then treated the
    source as binary. Generate control-char sentinels at runtime (String.fromCharCode), byte-
    check the file after, and sanitize the sentinel out of INPUT before using it (a
    pre-existing occurrence otherwise round-trips into corruption).
12. **Hotfixes get task reviews too — urgency is when review matters most.** Two "quick"
    commits shipped outside the SDD review loop during a busy stretch (a review-page query fix
    and an auto-publish CLI) contained 3 of the 6 findings the final whole-branch review
    confirmed — including a Critical (unbounded selects silently truncating at Supabase's
    1000-row cap, which THIS repo had already documented hitting live in another file). The
    repo's own recorded lessons don't transfer through un-reviewed code paths; reviewers are
    how they transfer.
13. **A shared surname is not evidence of identity — and matching predicates in plans must be
    stated as necessary conditions, not slash-alternatives.** An identity-clustering plan said
    pairs form "on surname/name-variant equality"; the implementation read the slash as OR, and
    a live run merged Stuart with James Symington (father and son) before the post-run
    spot-check caught it. Two lessons: (a) the full-name(+variant) match is a NECESSARY
    condition for any automated identity link, everywhere, forever; (b) when a plan states a
    matching rule, write MUST/NEVER conditions, not compact alternates a reader can interpret
    permissively. The post-run spot-check protocol (sample and eyeball N groupings before
    declaring success) is what contained it — keep it mandatory for any bulk-linking run.

## Lesson 14 — `&&` after a `grep` is not a test gate (recurrence, 2026-07-31)

Ran `node --test | grep -E "^ℹ (tests|pass|fail)" && git commit && git push`. The grep *succeeded*
(it found the summary lines — including `fail 15`), so the chain proceeded and pushed a red suite.
This is the SECOND occurrence of this exact mistake in this project; the first was ledgered during
the LegiScan wave and evidently not internalized.

The rule, mechanically: **gate on the extracted fail count, never on a command's exit status when
that command is a filter.**

**THIRD occurrence, 2026-08-27 — a new disguise, so record it: the harness's own "exit code 0".**
Launched a long fetch as `node scripts/gloss-batch-mo.mjs --fetch-only | tail -15` as a background
task. It reported **`[exited with code 0]`** and the task notification said *completed (exit code
0)*. It had not completed — it died on an `ECONNRESET` from revisor.mo.gov partway through. The
exit status belonged to **`tail`**, the last command in the pipeline, not to `node`.

This is the same bug wearing a uniform that is much easier to trust, because the *harness* is the
one telling you it succeeded. A green task notification on a piped command is worth nothing.

- **Never pipe a long-running or failure-prone command whose success you intend to believe.**
  Redirect instead: `node script.mjs > out.log 2> err.log` — then the reported exit status is the
  program's own.
- If you must pipe, in bash set `set -o pipefail` first, or check `${PIPESTATUS[0]}`.
- **Verify from the artifact, not the status.** This run was caught because the expected final line
  (`{"fetched":N,...}`) was absent from the output — the checkpoint files on disk were the honest
  record, and `--resume` picked up from them with nothing lost.

```bash
FAILCOUNT=$(node --test 2>&1 | grep -E "^ℹ fail" | awk '{print $3}')
if [ "$FAILCOUNT" = "0" ]; then git commit ... && git push; else echo "RED — NOT COMMITTING"; fi
```

Why it recurs: `grep` exits 0 when it finds *anything*, and a failing test run still prints the
lines being grepped for. The failure mode is invisible in the transcript because the numbers scroll
past in the same output that "succeeded." Recovery cost here was small (caught on the next command,
fixed and re-pushed within minutes) but the same pattern on a data-writing CLI would not be.

## Lesson 15 — A schema bound is a request, not a guarantee (2026-07-31)

`COMPLETENESS_SCHEMA` declared `minItems: 3, maxItems: 7` for the provision list, and the prompt
said the same. The assessor never checked. A checker returning **one** trivially-covered provision
earned the identical "complete" verdict — and the identical public receipt claiming an independent
check found the summary covers the bill — as a genuine 3-7 provision check.

Generalized: **anything you declare in a schema or ask for in a prompt must be re-verified
mechanically at the gate if a downstream claim depends on it.** A JSON Schema constrains what a
well-behaved producer sends; it says nothing about what actually arrives, and it says nothing at
all about whether the work behind the payload was real. This is the same doctrine as "never trust
the verifier's self-report," one level lower down — the self-report was already distrusted, but the
*shape* of the work product was still taken on faith.

## Lesson 16 — Audit output exists to be read, not to be `ok: true` (2026-07-31)

The identity linker's coherence audit returned `ok: true, violations: []` — and every single one of
the 31 clusters it was about to write was flagged in the same output as `residualOnlyClusters`
(held together purely by identical-name edges with no corroborating evidence). The code's own
comments say plainly that this listing exists "so Lance can specifically scrutinize a residual-heavy
cluster before trusting it."

Trusting the boolean would have merged a sitting U.S. Senator with his son. Reading the *detail*
caught it. When a system reports both a verdict and its basis, **the basis is the part that
carries information** — the verdict is a summary of rules that were already known to be incomplete
(that's why the detail is emitted at all). Budget the time to look.

## Lesson 17 — On correcting production data: source the mapping, guard the write (2026-07-31)

Two corrections against live rows (37,662 status codes, 10 sentinel dates). What made them safe:

1. **The mapping was extracted, not remembered.** LegiScan encodes status as an integer with no
   printed word anywhere in the payload, so the decode table *is* the correction. It came from
   their own API manual page 42, pulled with the repo's own PDF extractor, cited in a comment.
   A remembered mapping would have been a guess wearing a fact's clothes.
2. **The `.eq()` guard lives on the UPDATE, never in a JS pre-filter.** `update({status: word})
   .eq('status', '1')` cannot touch a federal bill, an already-corrected row, or anything else,
   by construction rather than by care.
3. **Reversibility was established before approval** — originals re-derivable from cached datasets.
4. **Codes the source says aren't statuses were left alone and counted**, never guessed a word for.

And the near-miss: the delete path in correction B matched a "duplicate" on bill + chamber + exact
yea/nay **tally**, which a review proved could delete a genuinely different roll call that happened
to share a tally. The fix used exact set-equality on the *legislator IDs* who voted each way —
strictly stronger, and still exact rather than fuzzy. **When a heuristic decides whether to delete,
the bar is identity, not resemblance.**

## Lesson 18 — Never hand-transcribe machine-readable lists into agent dispatches (2026-08-01)

Wave 2's batch-1 args listed 20 bill directories; the controller typed the second ten from
memory and got ALL TEN wrong (confabulated plausible tags like `b17-SB_190` for slots actually
holding different bills). Cost: 10 wasted opus author dispatches. Two layers saved it: the
subagents each REFUSED to substitute the bill they could actually find ("no bill text means
every point would be fabricated" — the refuse-don't-improvise instinct the prompts demand), and
the manifest on disk stayed authoritative. Rule: any list that exists in a file is passed by
GENERATING the dispatch from the file (a script bakes the literals in), never by retyping.
A preview that prints sizes but not names is not verification of names.

## Lesson 19 — Government sources say "not found" with HTTP 200 + a human-readable page (2026-08-01)

senate.gov LIS returns **200** with a fixed HTML page ("Roll Call Vote Unavailable") for a
not-yet-cast vote number — never a 404 — so an `!res.ok` guard passes it straight to the XML
parser, which produced a rootless tree WITHOUT throwing (fast-xml-parser parses HTML happily),
and the first field access crashed with a bare TypeError. Meanwhile clerk.house.gov cleanly
404s for the same situation. Rule: for every source, capture what "doesn't exist yet" ACTUALLY
returns (fixture it — ours proved byte-identical across vote numbers, so exact-match detection
is safe) and classify it as a typed expected-miss; any OTHER structure-missing payload must
stay a loud failure so real outages can't hide inside the expected-miss class. Related: §7
lesson 3 (government HTML inside expected-XML channels).

## Lesson 20 — This project's Supabase endpoint never populates `count` on `.update().select()` (2026-08-02)

`.from(t).update(patch).eq(...).select('id', { count: 'exact' })` returns `count: null` — always,
verified by direct production probe (an update that genuinely touched 8 real rows still returned
`count: null`; `data` correctly held all 8). Three call sites across two files read `count ?? 0`
instead of `data.length` and were silently broken: two branches of the shipped `mo-status`
correction (37,662 rows corrected live on 2026-07-31 — the DATA was right, independently verified
at the time, but every reported `matched` count was 0, previously misdiagnosed in this very log as
"the counters read post-write state" rather than the real cause), a brand-new `party-normalize`
correction (601 rows correctly changed, reported `updated: 0`), and a dead concurrent-write safety
check in `backfill-bill-titles.js` (`count === 0` can never be true against `null` — the underlying
`.is('title', null)` WHERE guard still protected the data, but the intended race detection never
fired). Caught because the SAME broken pattern recurred a third time and this time got investigated
instead of re-explained away.

**Root cause of it staying hidden:** the shared test fake client faithfully computed
`count: matched.length` for every mode including `update` — MORE accurate than the real endpoint,
which meant every test built against it was proving code worked against a fantasy backend. Fixed
the fake to mirror reality (`update` mode always returns `count: null`, matching the live probe)
before touching any production code — this immediately turned 6 previously-green tests red across
two files, proving the bug was real and shipped, not hypothetical.

**Rule, mechanically: after any `.update()` or `.delete()`, read `data.length` (or `(data ?? [])
.length`) for an affected-row count — never the `count` metadata field, on this project's endpoint,
regardless of whether `{count:'exact'}` was requested.** `select()`'s own `count:'exact'` (including
`head:true`) IS reliable — this is scoped specifically to update/delete, confirmed by direct probe,
not a blanket "count is broken" claim. A test fake for this project's DB layer must reproduce this
asymmetry (`select` count real, `update`/`delete` count always null) or it will mask the exact class
of defect this lesson exists to prevent recurring a fourth time.

## Lesson 21 — A regex capture group is a string; a JSON field of the same name may not be (2026-08-02)

Two different writers produced `roll_call_id` for the SAME logical field with different JS types:
LegiScan's own live ingest path reads it straight out of parsed JSON (a genuine number), while a
same-day correction (TODO 25's vote reconciliation) parsed it out of a `source_key` string via
regex (`m[2]`, always a string, never coerced). Both wrote into the same `discrepancy` JSONB
column read by an idempotency check using strict `===`. The DB's own unique index (migration 0011)
casts both sides to `::integer` before comparing and correctly treated them as the same row; the
in-memory pre-check did not, so a live LegiScan run hit a genuine duplicate-key error the code's
own race-recovery branch was supposed to catch and couldn't, because THAT recheck used the exact
same broken strict comparison. The failure surfaced hours later, on a routine scheduled tick, far
from the commit that caused it — caught only by a post-hoc verification sweep, not by any test at
the time (nothing asserted on the TYPE of a parsed id, only its value).

**Rule: when a comparison exists specifically to mirror a DB-level uniqueness guarantee, it must be
at least as type-tolerant as the guarantee it mirrors.** A Postgres unique index over a JSONB
`->>'field'` expression coerces types by construction (the `::integer` cast); an in-memory
`===` check over the same logical field does not, unless written to. Never assume two writers of
the same JSON key agree on JS type — coerce explicitly at the comparison, and coerce at the write
site too (fixing only one is a patch; fixing both closes it for both directions).

## Lesson 22 — A status flag is not the invariant, if more than one writer can set it (2026-08-02)

Designed a public DB view to expose a new field only for `summaries.status = 'published'`, reasoning
that publish requires an adversarial verifier to have re-derived `overall='clean'` first — true for
the code's own auto-publish path (`classifyRecordItem` → `autoPublishSummary`), which does enforce
it. Missed, until an adversarial design review (deliberately run before any code was written) caught
it: a SECOND path sets the same status column — the staff review server's manual approve/publish
button — and it never looks at verification data at all. Nothing in the schema ties the two
together; the safety property held only because, by coincidence of what had happened to be published
so far, every live row satisfied it. The moment a human uses the second path on an item that doesn't
satisfy it (here: manually publishing one of the ~100 items sitting in the flagged review queue,
which is the queue's own designed exit), the exposed data would silently start lying — presenting a
verifier's REFUTING quote as if it were supporting evidence, because the fields that would reveal the
refutation (`supported`, `reason`) were deliberately the ones being stripped for public display.

**Rule: when gating what a view/API exposes, gate on the actual invariant your safety argument
depends on (here: `overall = 'clean'`, computed straight from the verification row), never on a
status flag that's merely correlated with it today.** A status column is safe to gate on ONLY if
every writer that can set it enforces the same invariant — audit every write site (`grep` for the
column being set), not just the one you built. A status flag review-checked once eventually gets a
second writer nobody re-checks against the first writer's promises; a live re-derivation can't drift
that way because there's nothing to drift out of sync with. This is the same "never trust a
self-report, always re-derive mechanically" discipline this project already applies to verifier
output (`assessVerdicts`/`assessCompleteness`) — the same discipline applies to status flags with
more than one writer, not just to model output.

## Lesson 23 — Grepping a function's branches for a marker string proves the branches that HAVE the marker, not the branches that don't (2026-08-03)

Extended `crossCheckAgainstPrimarySource` (a carefully-reviewed, multi-branch cross-source matcher)
to report a new field on every "clean match" outcome, so a caller downstream could act on it. Found
the branches to fix by `grep`-ing the file for the literal string `reason: 'tally_unique_match'` —
two hits, both fixed, both unit-tested, both green. Wired the caller to gate on that same string.
Live end-to-end test (real fixture data, not a fake) showed a genuine clean match producing zero
effect: a THIRD `matched: true` branch existed — the plainest, most common case (a single candidate,
no same-day siblings, tallies simply agree) — that had never been given a `reason` string at all,
because it predates the two disambiguation branches that later needed one. The grep found every
branch that already said the marker; it structurally cannot find a branch that doesn't say anything.
The bug was invisible to code review of the two "found" branches (both were correctly fixed) and
invisible to their own unit tests (both passed) — it only surfaced because a downstream integration
test exercised the untouched third branch and asserted on the field being present, not merely on
the two branches the design session had already located.

**Rule: when a task is "find every branch that does X" inside an existing function, grepping for a
string that CURRENT instances of X happen to share is not a census — it only enumerates branches
that already conform to today's convention. A branch that does X differently (or that predates the
convention) is invisible to that grep by construction.** The reliable version of "find every branch"
is structural, not textual: read the function's actual control flow (every `return` in scope), or —
cheaper and more honest about the risk — write a test that exercises the SIGNAL the caller actually
needs (here: "does every clean-match return carry the new field") against real/representative input
per branch, not a test that merely confirms the branches you already found behave as expected. A
green test suite for the branches you found says nothing about the branches you didn't.

## Lesson 24 — An existing test can encode an architectural boundary a new feature's design missed (2026-08-03)

Designed a new correction (`correct-data.js`'s `runCorrectVoteDuplicates`) to reuse an existing,
carefully-built cross-source matcher (`crossCheckAgainstPrimarySource`) directly, on the reasonable-
sounding principle "reuse, don't reinvent." Wrote the code, wired it in, and only then hit a
pre-existing test — unrelated to this feature, written for a different correction (TODO-25's session
merge) months earlier — that asserts, unconditionally, `correct-data.js` must never import or call
that function at all, because it is a live pre-store gate with its own side-effecting writes
(reconciliation flags) that a backfill against already-published data has no business triggering.
The new correction's own author had no reason to know that assertion existed until the test failed.

**Rule: before reusing a function across a module boundary, check whether the CALLING module already
has a test asserting it never does that — not just whether the function itself looks reusable.** A
codebase's own test suite can carry architectural rules that never made it into a comment or a doc
(this one only lived in one test's own docstring). The fix, once found, was itself a reusable pattern
already established elsewhere in the same file for the same reason (reuse the PURE comparison
primitives the gated function is built from; reimplement only the thin orchestration around them) —
worth checking for a sibling implementation solving the identical problem before assuming a
fresh design is needed. A full-suite run before considering a design "done" is what caught this; it
would not have been caught by testing the new correction in isolation.

## Lesson 25 — The Bash tool strips a layer of backslash-escaping before Node ever sees a `-e` command (2026-08-03)

Diagnosing 7 corrupted glossary entries (undecoded `—` unicode-escape leaks, stray control
characters) by running `node -e '...'` one-liners through the Bash tool, typing `\\u2014` to mean
"a literal 6-character backslash-u-2014 sequence." The diagnosis came back silently wrong: a regex
`.replace(/\\u2014/g, ...)` reported zero matches against text that (per a separate, correct
character-code dump) definitely contained that exact sequence. The cause: the Bash tool's
invocation path collapses `\\` to `\` before Node's parser ever runs — so `"field \\u2014 an"` typed
in the command arrives at Node as `"field — an"`, which JavaScript's own double-quoted-string
parser then decodes as a real em-dash character, not as the 6 literal characters intended. The
diagnostic script "worked" (ran without error, printed plausible-looking output) while silently
operating on a different string than the one actually stored in the database — the worst kind of
tool failure, since nothing signals it happened.

**Rule: never diagnose or fix byte-level string corruption (raw escape sequences, control
characters, encoding artifacts) via inline `node -e`/`python -c` one-liners passed through a shell
tool.** Write a real script file (`.mjs`/`.py`) instead and run it — a file's content reaches the
interpreter exactly as written, with no shell-layer re-interpretation in between. This class of bug
is specifically dangerous because the broken version doesn't error — it runs, looks reasonable, and
produces confidently-wrong conclusions. Confirmed the fix by writing the diagnostic to a file,
re-running it, and getting genuinely different (and this time internally consistent, cross-checked
against explicit `codePointAt()` dumps) results. Applies to any tool-mediated shell invocation, not
just this project — worth checking for the same stripping behavior in a new environment before
trusting a quick one-liner for anything backslash-sensitive.

## Lesson 26 — `refresh_vote_aggregates()` RPC calls hit a hard ~120s Supabase edge-gateway timeout, separate from and shorter than the function's own 600s DB-side `statement_timeout` (2026-08-04)

Five live attempts at `npm run refresh:aggregates` after the vote-dedup backfill (59 rows written)
all failed — alternating `"canceling statement due to lock timeout"` (~8s, a later attempt colliding
with an earlier one's still-running server-side query) and `"upstream request timeout"` (~120-130s).
Diagnosed by bypassing the SDK entirely with a raw `fetch()` (5-minute client-side `AbortSignal`) to
rule out any client/SDK-imposed limit: it still died at **125,374ms with HTTP 504, `server:
cloudflare`, `sb-gateway-version`/`sb-project-ref` headers, body `"upstream request timeout"`**. This
is Supabase's own edge/gateway infrastructure (Cloudflare in front of the whole API surface)
enforcing a fixed synchronous-request ceiling, completely independent of Postgres's own
`statement_timeout` (migration 0026 already correctly sets that to 600s on the function itself — it's
just irrelevant here, since the HTTP connection watching the request dies first). The underlying
`REFRESH MATERIALIZED VIEW CONCURRENTLY` calls are very likely still completing successfully
server-side in every failed attempt; the client (and whatever's fronting PostgREST) just never sees
the response.

**This is genuinely a scale problem, not a fluke**: the same function completed in ~19s earlier the
same day (right after 0026 was verified) and now consistently exceeds the ~120s gateway ceiling —
`vote_casts` sits at ~1.47M rows and grows continuously via the scheduler; whatever margin existed is
shrinking as the dataset grows, and this will keep getting worse. A per-call code fix (splitting the
one function's three sequential `REFRESH ... CONCURRENTLY` passes into three separate RPC calls)
would buy time but not remove the ceiling — the durable fix is running the refresh as a scheduled
`pg_cron` job directly inside Postgres, with no HTTP/gateway layer involved in the routine case at
all (`select cron.schedule('refresh-vote-aggregates', '*/30 * * * *', 'select
refresh_vote_aggregates();');` is the current, confirmed-live Supabase Cron syntax as of this
writing — verify against `https://supabase.com/docs/guides/cron` again if this project revisits it
later, since Supabase's own docs explicitly warn this area changes). *(Done: that exact statement
shipped as migration `0027_pg_cron_refresh_aggregates.sql`, applied and confirmed live by Lance
2026-08-04; lesson 27 picks up from the job's first runs. Status note added 2026-08-23.)*

**The costlier miss: this exact problem — the RPC call to THIS SAME function timing out no matter
what — already happened once, earlier the SAME session, and was already solved.** CHATLOG.md
(2026-08-03, "0022 has been ran in supabase" entry) records a prior ~8s PostgREST-role-level timeout
on the identical function, worked around by having Lance run `select refresh_vote_aggregates();`
directly in the Supabase SQL editor — a bypass that (not obviously, but as it turns out) also sidesteps
the DIFFERENT, newly-discovered gateway-level timeout, since the SQL editor doesn't route through the
same REST/gateway path at all. Five retries plus a full SDK-bypass diagnostic investigation happened
before this was found, and only because Lance directly asked "are the calls utilizing the connection
properly" and separately told me to re-read CHATLOG/PLAYBOOK line by line — not because the check
happened on its own.

**Rule: before spending any diagnostic effort on an infrastructure/operational problem that "shouldn't
be happening," grep CHATLOG.md (`grep -in "<function name>\|<error keyword>\|timeout"` at minimum) for
whether this exact class of problem already occurred and was already solved.** A project with this
kind of durable, word-for-word decision trail defeats its own purpose if a fresh problem gets
re-diagnosed from zero instead of consulting it first — the whole point of CHATLOG per PLAYBOOK_DELTA
§5.2 ("chatlog + memory are the flywheel, not overhead") is that this class of miss should be
structurally rare, not routine. Applies doubly to anything involving a specific named function,
script, or error message that's likely to have come up before in a long-running project.

## Lesson 27 — Postgres `statement_timeout` is armed ONCE, at the start of the top-level statement, using whatever GUC value is ambient at that instant (2026-08-04)

A function's own `SET statement_timeout = 'X'` clause (whether via `CREATE FUNCTION ... SET ...` or
a separate `ALTER FUNCTION`) can **never retroactively extend** the cancellation deadline for the
outer statement that invoked it — that deadline was already fixed before the function body (or its
own `SET`) ever ran. Confirmed against real Postgres core-developer (Tom Lane) mailing-list threads,
not guessed. This bit twice in the same investigation: once for the real
`refresh_vote_aggregates()` function (pg_cron issuing `select refresh_vote_aggregates();` as a
top-level statement armed the deadline from Supabase's own **built-in 2-minute database-level
default** — `alter database "postgres" set "statement_timeout" to '2min'`, stored in
`pg_db_role_setting` keyed on database, invisible to a plain `pg_roles.rolconfig` role-level check —
regardless of the function's own 600s override), and again, self-inflicted, in a one-off debug
function built to diagnose it (its own inner `set statement_timeout = '30min'` was silently
overridden by whatever the database-level default happened to be at that moment).

**The only fix that actually works: raise the ambient default itself** (database- or role-level, via
`alter database <db> set statement_timeout = 'Xs'` or an equivalent role-level `ALTER ROLE`), so it
is already correct BEFORE the top-level statement starts. A function-level `SET` is still worth
keeping for documentation/defense-in-depth (protects a hypothetical future caller that nests the
function inside another statement), but never rely on it alone for anything that might ever be
invoked as — or from — a top-level statement. Verify a fix actually took effect via the observable
proof, not by assumption: if the timeout ceiling shifts to exactly the new value on the next
failure (rather than continuing to fail at the old boundary), the new default is genuinely in
effect for that connection.

## Lesson 28 — `LEFT JOIN x ON ... WHERE x.col IS NULL` (the classic anti-join idiom) can get its selectivity catastrophically misestimated by the Postgres planner (2026-08-04)

A materialized view excluding ~59 "superseded" rows out of ~10,103 via
`left join vote_duplicates vd on vd.superseded_vote_id = v.id ... where vd.id is null` had this
anti-join's selectivity estimated by the planner as **1 row** — when the honest answer was ~10,044
(99.4% of rows have no match, i.e. should survive the filter). The likely mechanism: the planner
estimates a post-LEFT-JOIN `IS NULL` filter using the joined column's OWN null-fraction statistic
(here, `vote_duplicates.id`, a primary key — 0% null, always) rather than correctly modeling how
often the join itself fails to match and produces a null-extended row. That single ~10,000x
misestimate cascaded into Nested Loop joins for the ENTIRE downstream query plan (fine for an
estimated 1 row, catastrophic once the true cardinality reached ~1.34M rows after further joins) —
turning a query that should complete in seconds into one that ran past 40 minutes without ever
completing.

**Fix: rewrite the same exclusion as `NOT EXISTS`** —
`where not exists (select 1 from vote_duplicates vd where vd.superseded_vote_id = v.id)`. Identical
semantics, but Postgres has dedicated, far more reliable anti-join selectivity estimation for this
shape; confirmed via `EXPLAIN` that the same query produced a correct `Hash Anti Join` estimate and
Hash Joins throughout instead of Nested Loops. **Prefer `NOT EXISTS` over `LEFT JOIN ... WHERE x IS
NULL` by default for any anti-join in this codebase going forward** — not just when a problem is
already observed; the LEFT JOIN form is a real, standing planner-misestimation risk, not a style
preference. This is worth checking in any other Postgres project with the same idiom, especially
once a "small reference/exclusion table, large base table" join has been running fine for a while
and then degrades sharply as the base table grows — that growth curve, not a sudden code change, is
usually the actual trigger.

## Lesson 29 — Run a plain `EXPLAIN` (no `ANALYZE`) BEFORE any empirical timing investigation, not after (2026-08-04)

Root-causing the slow-query problem above (Lesson 28) took roughly two hours of empirical
timing attempts — raising `statement_timeout` progressively higher, building a one-off pg_cron debug
function just to get a real duration reading past Supabase's dashboard/gateway ceiling, watching
`pg_stat_activity` to confirm the query was genuinely still computing and not stuck — before finally
reaching for a plain `EXPLAIN` (no `ANALYZE`), which **returns in milliseconds regardless of how long
the real query would take to execute**, and immediately revealed the exact catastrophic misestimate
(1 row estimated at the anti-join node vs. the true ~10,044 there, which then cascades into a
~1.34M-row final workload) that explained everything. Every minute spent on empirical timing before
that point added no diagnostic value the plan itself didn't already contain for free.

**Rule: for ANY unexplained query slowness, run a plain `EXPLAIN` FIRST — before `ANALYZE`, before
raising timeouts, before building any workaround to get a real duration reading.** It's free (no
execution, no lock contention, no timeout risk of its own) and directly shows the planner's chosen
strategy and row estimates. Nested Loop joins over large estimated-vs-actual row-count gaps, sequential
scans on large tables, or any node whose estimate looks obviously wrong relative to known table sizes
— any of these should be ruled out (or confirmed) before spending any effort measuring actual
execution time. Reach for `EXPLAIN (ANALYZE, BUFFERS)` — which DOES execute the query and carries
real timeout/lock risk — only once the plain plan looks sane and the question is genuinely "how long
does this correctly-planned query take," not "why is this slow at all."

## Lesson 30 — A contaminated SHELL can turn correct tests red; the failure looks exactly like a real regression (2026-08-05)

Ran a batched health check before a documentation pass: `set -a && source .env && set +a`, then a
few live `curl` probes, then `node --test` — all in one shell invocation, to save round trips. The
suite came back **RED**: `review-logic.test.js`, `expected: 500, actual: 200`. Nothing had changed
in that file for days.

The instinct that saves time here is the one that almost didn't fire: *before* bisecting commits,
ask whether the TEST HARNESS was run in the same conditions as the last green run. It wasn't.
Sourcing `.env` exported `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` into the shell, `node --test`
inherited them, and two tests that specifically assert the review server degrades cleanly when **no
database client is configured** got a real client instead — so the endpoint correctly returned 200
where the test correctly expected 500. Both the test and the code were right. The shell was wrong.

Proven deterministically rather than assumed (the whole point — an intermittent-looking failure
invites hand-waving): same file, clean shell → 181 pass / 0 fail; identical command with `.env`
sourced first → 179 pass / **2 fail**. Reproducible on demand, in both directions.

**Rule: never `source` a `.env` into a shell that will also run the test suite.** This repo already
had the correct pattern everywhere — every CLI is invoked as `node --env-file=.env <path>`, which
scopes credentials to ONE process precisely so they cannot leak into sibling commands. Batching a
live-data `curl` check together with `node --test` for convenience is what defeats it.

**The generalizable trap, worth carrying to any project:** a test that asserts behavior under
*absent* configuration is silently coupled to the environment it runs in, and therefore to whatever
else the shell did first. That coupling is invisible in the test file, invisible in the diff, and
invisible in the failure message — which names an HTTP status, not an env var. Two defenses, both
cheap: run the suite in its own clean invocation always (not just when you suspect something), and
when a "no config present" test fails, suspect the harness before the code. The cost of missing
this is a bisect hunt for a break that never happened — the exact tail-chasing this playbook exists
to prevent, and doubly expensive right before a machine restart when a red suite reads as "we broke
something and don't know what."

## Lesson 31 — "Relative to what?" is the question every path field in a deploy console is silently asking (2026-08-05)

Wrote a Cloudflare Pages runbook specifying **Root directory: `site`** AND **Build output
directory: `site`**. Both individually defensible, both matching how the repo is laid out — and
together, broken. Build output directory is resolved *relative to* root directory, so the pair
resolves to `<repo>/site/site/`, which does not exist. Caught only because the owner opened the
real wizard, compared it field-by-field against the doc, and asked "do I need any changes to this?"
before clicking Save. The correct config leaves output EMPTY, meaning "the root directory itself."

The reasoning error is worth naming precisely: I derived each field from the repo layout
independently ("the site lives in `site/`" → true for both fields in isolation) instead of asking
what each field is measured FROM. Two settings that are each correct against the filesystem can be
wrong against each other the moment one is relative to the other.

**Rule: for every path field in a deploy/CI console, write down what it is relative to before
writing its value — and when two path fields appear in the same form, state their relationship
explicitly in the doc, not just their values.** A runbook that lists `A: site` and `B: site` on
adjacent rows looks internally consistent and reads as confirmation; it hides the composition
entirely. The corrected table now carries the relationship and both valid combinations, because the
alternative config (root empty + output `site`) *also* "works" for static files while silently not
deploying the Functions directory — a failure that would have looked like a code bug in
`geocode.js` rather than a settings mistake, and been debugged in the wrong place.

Two broader points this cost nothing to learn but could have cost a bad afternoon:
- **A doc written from the repo's structure is not the same as a doc written from the tool's
  semantics.** The repo says where files are; the console asks how it should interpret paths. Only
  the second one is what you are filling in.
- **The owner reading a runbook against the real UI is a genuine review pass, not a formality.**
  This is the second time in this project that a human comparing a document to live reality caught
  something no amount of internal consistency-checking would have (the first: the resume docs
  drifting from live DB state). Build the runbook to be checkable — exact field names, one value
  per row — so that comparison is cheap enough to actually happen.

## Lesson 32 — A static host applies its OWN URL semantics before your rules run; a local dev server that skips them will pass a config that production breaks on (2026-08-05)

First Cloudflare Pages deploy. Every `_redirects` rewrite was broken in production, none of it
caught locally. Two distinct failures, one root cause: **Cloudflare Pages automatically
canonicalizes `.html` paths to their extensionless form with a 308** (`/person.html` -> 308 ->
`/person`, `/index.html` -> `/`), and it does this BEFORE your rewrite rules resolve. Our
`_redirects` targets pointed AT `.html` files, so:

- `/trust` -> rewrite to `/trust.html` -> Pages 308s to `/trust` -> rewrite again -> **infinite
  redirect loop**; the page was unreachable.
- `/person/<uuid>` -> rewrite to `/person.html` -> 308 to `/person` -> **the uuid was stripped from
  the URL**, so the page's JS (which reads the id out of `location.pathname`) had nothing to render.
  Every deep link to a legislator or bill — the core of the product — was dead.

The fix was to point rewrite targets at the EXTENSIONLESS path Pages actually serves, and to delete
the `/trust` rule entirely (Pages serves `trust.html` at `/trust` natively — the rule was the loop).
But the reusable lesson is why local dev never caught it: `scripts/serve-site.js` resolved a rewrite
straight to a file on disk and never modeled the `.html` canonicalization at all. A dev server whose
entire purpose is "behaves the same as production" silently diverged on exactly the behavior that
broke. This was the SECOND such divergence found on this one deploy (the first: Pages Functions do
not inherit `_headers`, Lesson-adjacent, so `/geocode` shipped bare).

**Rule: a static/edge host (Pages, Netlify, S3+CloudFront, …) imposes its own path semantics —
trailing-slash policy, `.html` canonicalization, case handling, index resolution — that run BEFORE
your redirect/rewrite config and can invert what it does. Enumerate those semantics from the host's
own behavior (curl the real deploy: `/foo.html`, `/foo`, `/foo/`, a missing path) before writing a
single rule, and make the local dev server reproduce them, not just serve files.** A dev server that
resolves paths more simply than production is not a smaller version of production; it is a different
system that happens to agree on the easy cases. And verify redirect rules by their STATUS and
`Location`, not just "does the page load" — a 308 loop and a correct 200 both eventually render
something in a browser, so the browser is the worst place to check this; curl the chain.

## Lesson 33 — When you fix a bad idiom, fix every object that carries it and extend the guard to the whole class — not just the objects currently failing (2026-08-05)

The `LEFT JOIN vote_duplicates ... WHERE vd.id IS NULL` anti-join, which Postgres misestimates
catastrophically (Lesson-class: the planner reads the IS-NULL selectivity off the joined PK's 0%
null-fraction, estimates ~1 row SURVIVING the anti-join where the true survivor count is ~10,044
(the ~59 rows it should EXCLUDE are the small set), and cascades into nested loops over a
million-row workload), surfaced live TWICE before it was fully contained:

1. It broke the three vote-aggregate MATVIEWS' refresh (40+ min, timeout). Fixed by migration 0029,
   rewriting them to `NOT EXISTS`. A regression test was written — but scoped to the matviews only.
2. On the first production deploy, it broke `public_vote_feed`/`public_votes` (two plain VIEWS
   carrying the identical idiom, untouched by 0029) — the query crossed the ANON role's 3s
   `statement_timeout` and every anonymous profile's vote list returned HTTP 500. Fixed by 0031.

The idiom was the same all three times; only the object and the timeout it blew differed. 0029 fixed
the objects that were failing THEN and wrote a test that pinned exactly those objects — so when the
same idiom sat in two other objects that weren't failing yet (because `vote_duplicates` was still
empty at the time), nothing flagged them, and they shipped to production and failed there.

**Rule: a fix for a bad pattern has two parts, and the second is the one that gets skipped. (a)
Rewrite EVERY object that carries the pattern in the same pass — grep the whole schema/codebase for
the idiom, not just the object in front of you (`grep -rl "left join vote_duplicates"` would have
found all five in one line). (b) Write the guard test against the PATTERN across the whole object
class, not against the specific objects that happened to fail — the test that pinned "the three
matviews use NOT EXISTS" should have been "no view OR matview definition uses the LEFT JOIN + IS
NULL idiom."** A regression test scoped to yesterday's failures cannot catch tomorrow's instance of
the same bug in a sibling object; it just makes you feel covered. The corrected test now scans every
current definition of all five objects (3 matviews + 2 views) for the forbidden idiom — proven
red-green — so a sixth object born with the same idiom fails the suite before it can reach a deploy.

Corollary on WHY it hid until production: the misplanned query is only slow when there is something
to anti-join against. `vote_duplicates` was empty when the site was browser-verified locally on
2026-08-03, so the bad plan had nothing to be slow about; the 59-row backfill (62 now, after live ingest
added 3) plus cast growth to ~1.47M pushed it past anon's budget later. A latent performance bug gated on data volume will pass
every check run before the data crosses the threshold — the first check run AFTER it does (here, the
first anon browser walk on prod) is where it surfaces. Load-bearing verification has to run under the
real role (anon, not service_role, whose 3s-vs-longer timeout was the entire difference here) against
real data volume, or it is testing a different, easier system.

## Lesson 34 — `state` + `chamber` do NOT identify a legislature; `jurisdiction_id` does — and a mid-decade remap moves only the map it belongs to (2026-08-06)

A `terms` row carries `chamber` (`'house'`/`'senate'`) and `state` (`'MO'`), and it is tempting to
read `chamber='house' AND state='MO'` as "Missouri House of Representatives." It is not: that filter
also matches every member of **Missouri's US House delegation** (federal), because a US Representative
from Missouri is likewise a `house` member from `MO`. The only column that separates the two
legislatures is **`jurisdiction_id`** (`'mo-legislature'` vs `'us-congress'`). Live proof: 167 rows
match `chamber='house', state='MO'` — 159 `mo-legislature` (state reps) + 8 `us-congress` (the federal
delegation: Bell D1 … Smith D8). Any scoping, counting, or dating query over one legislature MUST
filter `jurisdiction_id`, or it silently rakes in the other. The same person can legitimately hold a
row in BOTH (Bob Onder: a stale `mo-legislature` Senate D2 row AND a live `us-congress` House D3 row).

Two corollaries that cost real time here:

1. **A zero can be a stale identity artifact, not a data-collection gap.** Onder's `mo-legislature`
   Senate D2 row had 0 vote_casts while all 193 real current MO members had 427–5,073. The zero did
   not mean "his votes failed to ingest" — it meant the row is a *former* senator's leftover,
   duplicating the real current D2 senator. Before treating a zero as a pipeline failure, check
   whether the row is a duplicate of a populated one (same chamber+district, different id) — the
   populated sibling is the tell.

2. **A mid-decade redistricting only moves the district system it belongs to.** Missouri redrew its
   **congressional (US House)** map in 2026; its **state** house (163) / senate (34) districts follow
   the 2022 census map and did not change. So "the 2026 remap" is relevant when reasoning about
   `us-congress` rows and MUST be reflected when the UI renders the federal delegation — but it is
   irrelevant to any `mo-legislature` row. Don't let a congressional-map caveat leak into state-seat
   logic (or vice-versa); the `jurisdiction_id` tells you which map even applies.

## Lesson 35 — Quote-bearing text for a native exe goes through a FILE, never an argument (Windows PowerShell 5.1) (2026-08-09)

Lesson 25 caught the Bash tool stripping escapes from `node -e` one-liners; the same failure class
(a shell layer rewriting text before the target program sees it) has a second face, in PowerShell:
**any argument containing embedded double quotes gets re-tokenized when PowerShell 5.1 hands it to
a native executable** — even from inside a single-quoted here-string, which protects the text from
PowerShell's *parser* but not from its broken native-argument *marshalling*. Live failure: a
`git commit -m @'...'@` whose message quoted a gate reason (`"(SEC. 2)" vs "SEC. 2"`) exploded into
multiple arguments; git treated the fragments as pathspecs and the commit failed. The general rule:
prose destined for a native tool — commit messages, PR bodies, JSON payloads — gets WRITTEN TO A
FILE (with the Write tool, not `Set-Content` — the cmdlet's value is itself a PowerShell argument,
and it defaults to the system ANSI codepage) and passed by path: `git commit -F <file>`,
`--body-file`, `--file`. Arguments are for identifiers; files are for text. *(Attribution corrected
2026-08-23: this lesson used to credit lesson 25 with a PowerShell failure; lesson 25 is about the
Bash tool, not PowerShell.)*

## Lesson 36 — A negative-predicate gauge silently absorbs every status value invented after it (2026-08-09)

`data-status.js` reported "summaries draft/flagged" as `count(status neq. 'published')` — correct
when the only statuses were published/draft. Months later a new mechanism (`--replace-drafts`)
began retiring superseded drafts to `'rejected'`, and the gauge silently swallowed all 106 of
them: it read 395 while actual open drafts were 289. Nothing errored; the number just quietly
stopped meaning what its label said. The class: **any aggregate written as "everything except X"
(neq / NOT IN / `!=`) auto-absorbs every enum value added after it, with no failing test to tell
you.** Write gauges as positive enumerations (`status = 'draft'`) so a new status shows up as a
VISIBLE gap (totals stop adding up) instead of an invisible inflation — and when you introduce a
new status value anywhere, grep the codebase for negative predicates over that column before
calling the change done.

## Lesson 37 — A silently-dead background task is indistinguishable from a slow one until you check its artifacts; diagnose liveness from disk, then resume from journaled state (2026-08-10)

A 12-bill wave (48 subagents) died mid-run — PC sleep or harness restart — with NO failure
notification: the task simply vanished from the tracker while looking, from the conversation's
view, exactly like a long-running job. It surfaced only because the operator asked "is it
running?" and the answer was checked rather than assumed. The diagnostic that works: **look at
the work's own artifacts on disk** (transcript/journal file mtimes) — activity that stopped
hours ago plus a task ID the tracker no longer knows = dead, not slow. The recovery that works:
the workflow journal held 45/48 completed agent results, so resuming with the SAME inputs
(`resumeFromRunId` + verbatim args) replayed 45 from cache and ran only the 3 stragglers live —
minutes instead of a full re-run. Two rules: (1) never relaunch a dead background job from
scratch before checking what its journal/checkpoints already hold; (2) when reporting on
long-running background work, verify liveness from artifacts rather than asserting it from
memory — "I launched it" is not evidence it is still running.

## Lesson 38 — Park a failing STRUCTURAL CLASS, not one instance at a time — and sweep for siblings the moment the second instance fails (2026-08-10)

A completeness gate kept structurally-unpublishable documents honest: single-provision "list"
documents (a bill that is one list of 66 ZIP-code communities; Senate en-bloc nomination
resolutions that are one list of 48 nominees) can never meet a size-scaled minimum-provisions
floor. The retry policy that wasted the least work: first structural failure → one retry (a
different checker sometimes legitimately splits differently — one retry DID convert two such
bills); second identical failure → park the bill with the reason written next to the park entry.
The step that saved the most work: when the SECOND instance of the same shape failed (twin
en-bloc resolutions), the remaining queue was swept for siblings of that shape and three more
were parked proactively — before paying a full author/verify/check cycle each to learn what the
class already proved. Corollary: a parked list without written reasons becomes a mystery
blocklist in a month; every entry carries its why, and unparking is deliberately a one-line
human edit.

## Lesson 39 — A tool-call parameter can be silently truncated in transport; a "launched successfully" reply proves nothing about what arrived (2026-08-16)

A workflow launch carrying a ~52KB JSON args string returned a normal "launched in background"
success message — and the workflow died 9ms later with "args string is not valid JSON:
Unterminated string", zero agents run. The parameter had been truncated somewhere between the
tool call and the workflow runtime; nearly identical 53-54KB launches had squeaked through on
prior days, so the ceiling is real but fuzzy. Two mechanics: (1) treat any single tool-call
parameter approaching ~50KB as at-risk — split the payload (two 3-bill launches instead of one
6-bill launch) rather than betting on the limit; (2) the failure signature to recognize is
instant death with a parse error and 0 work done — the launch acknowledgment is an enqueue
receipt, not a delivery receipt. Related but distinct from the Read tool's 25k-token cap (not a
numbered lesson — it is the tool's own truncation notice, and the reason this file now carries an
index at the top; a dangling "(lesson band)" reference here was fixed 2026-08-23): that one
truncates what you READ, this one truncates what you SEND.

## Lesson 40 — When a payload is too big to send, bank it to a file and send a pointer — agents can Read what transport can't carry (2026-08-17)

A final-attempt re-author needed a 56KB prior draft carried to the author agent, but the
transport ceiling (lesson 39) sits near ~50KB and the bulk was irreducible (91 verbose bullets;
the referenced_terms strip that saved other oversized entries recovered nothing because the
terms weren't the bulk). The fix that worked on the first try: write the full prior JSON to a
repo-local artifacts file, and replace the inline payload with a small stub whose first field
is an explicit read instruction ("Before authoring, Read the file <absolute path> — treat its
content exactly as you would treat an inline PRIOR DRAFT"). The author agent (which already
Reads the bill text and the system-prompt contract from disk) followed the pointer, applied
both pre-fixes from the objections, regenerated the omitted referenced_terms as instructed, and
the result came back clean at 92/92 verdicts. Two mechanics: (1) this works because the
consumer is an AGENT with file tools, not the runtime — the script's own sandbox cannot read
files, but the prompt it assembles can tell the agent to; (2) make the stub self-sufficient
against the pointer being ignored: keep the mandatory fixes spelled out verbatim in the
objections themselves so the worst case (agent authors fresh without the prior) still lands the
required changes and only risks regression on previously-held bullets, not the fixes.

## Lesson 41 — A test fake that reproduces a backend's return shapes but not its CONSTRAINTS passes every concurrency test you write against it (2026-08-19)

The MO-glossary backfill CLI shipped through five green review rounds with an in-memory fake DB
that faithfully mirrored PostgREST return shapes (lesson 20: never trust `count`) — and enforced
zero constraints. An adversarial audit then produced, with executed evidence, three failures the
suite structurally could not see: an update racing a concurrent insert violated the real
`unique (kind, citation)` key and aborted the whole apply with no partial audit trail; a loser
delete racing a concurrently-minted link hit the real un-cascaded FK; and a stale link snapshot
let the merge path silently destroy rows minted after planning while reporting full success. The
fix was two-sided: the code gained typed 23505/23503 handlers, live re-reads, and
`err.partialResult`, and the FAKE gained the real constraints (unique key checked against live
store state on update; FK checked on delete) so those tests could exist at all. The rule: when a
write path's correctness depends on what the DATABASE refuses, the fake must refuse it too —
shape fidelity without constraint fidelity is a fake that can only ever agree with you. Cheapest
mechanical form: derive violations from the fake's own store state at execute time, never from
canned error injections keyed to test names.

## Lesson 42 — A verbatim-quote check is only as strong as the excerpt's provenance: an index or TOC excerpt lets a true quote "support" a claim about a DIFFERENT law (2026-08-19)

The glossary trust chain verifies every claim against an exact quote from the fetched official
excerpt. That is sound only while the excerpt is OPERATIVE TEXT of the cited thing. The MO
chapter design fetched the chapter index page — revisor-authored catchlines plus cross-reference
lines naming OTHER chapters' subjects — so a gloss claiming "Chapter 536 provides auxiliary
services for deaf persons" would carry the literal, verifiable quote "Deaf persons, auxiliary
services and aids, 476.750 to 476.766"... which is a cross-reference to a different chapter. The
verifier passes it CLEAN; auto-publish follows; the receipt UI renders an index line as a
quotation from the cited law. Nothing in the chain lies, and the output is still wrong. Caught
only by an adversarial audit constructing the failure, after the design survived a spec audit,
five task reviews, and a whole-branch review. The rule: before wiring any new source into a
quote-grounded pipeline, ask what KIND of text the excerpt is — statute body, index, editorial
annotation, headnote — and refuse everything that is not the operative text itself (the same
pass also found revisor case-law annotations riding inside section excerpts; same class). Scope
reduction (chapters left v1) beats a clever gate you cannot prove.

## Lesson 43 — Killing a background SHELL does not kill its node child; verify liveness by PID, never by command-line matching (2026-08-21)

"Pause all activity" was executed with a TaskStop on the PowerShell wrapper around a long-running
node runner. The wrapper died; the node child was orphaned and kept running for ~2 hours — it
finished a 1,546-page fetch sweep and SUBMITTED A BILLED BATCH (~$1-1.5) after the operator had
asked for everything paused. Two liveness checks said "0 runner processes" because they filtered
Win32_Process on CommandLine -match 'gloss-batch' — and Windows returns a NULL CommandLine for
processes the querying session no longer owns, so the orphan silently failed the match. The
honest signal was there the whole time (checkpoint files kept changing) and was not consulted.
Rules: (1) launch long-running children with Start-Process -PassThru and WRITE THE PID to a file
at launch; stop by Stop-Process on that PID (tree), then confirm the PID is gone — never confirm
by grepping command lines. (2) After any "stop," re-read the job's own checkpoint/state files a
few minutes later: a state file that keeps moving is a process that is still alive, whatever the
process table says. (3) Disclose an unpaused process and any spend it incurred immediately and
plainly; the checkpoint design made this one recoverable, not invisible.

*Where the recipe lives (added 2026-08-23): nowhere greppable yet — no launcher script exists and
`scripts/gloss-batch-mo.mjs` has no PID handling; the relaunch was done by hand and is recorded in
CHATLOG.md (2026-08-21: "Relaunched with Start-Process -PassThru and the PID written to
.superpowers/artifacts/gloss-batch-mo/runner.pid so a future stop is real" — the exact command
was not journaled). The shape, PowerShell 5.1:
`$p = Start-Process node -ArgumentList '--env-file=.env','scripts/<runner>.mjs'
-PassThru; Set-Content <artifacts-dir>/runner.pid $p.Id` — stop with `Stop-Process -Id (Get-Content
<pid-file>) -Force` (`taskkill /PID <pid> /T /F` if the runner spawns children), then confirm
`Get-Process -Id <pid>` errors AND the checkpoint files have stopped moving. The closest in-repo
relative is the scheduler's lock file (`acquireLock` in `scripts/scheduled-ingest.js` writes
`process.pid` into its lock JSON) — a lock, not a launch recipe, but the same liveness idea.*

## Lesson 44 — A spend cap that only gates BEFORE each submission cannot stop a single batch; project every batch from the data on disk, and calibrate the projection HIGH against a real run (2026-08-21)

The USC glossary drain was estimated at ~$5.2 against a $5.62 balance and a $8 cap. It spent
$8.31. Two separate mistakes, both cheap to avoid:
1. **The estimate was a per-term rate carried over from a different corpus.** The MO probe's
   $0.0063/term was applied to 669 USC terms without looking at the USC bank that was ALREADY
   ON DISK — its excerpts averaged 11,056 chars vs MO's 4,371 (2.5x). A one-line script over
   excerpts.json would have said "this bank is bigger than the whole MO bank." Rule: never
   estimate a billed run from a rate; estimate it from the actual inputs you have banked.
2. **The cap was checked only before each submission.** Three author rounds spent $3.07; the
   verify batch was then submitted as ONE unit and cost $5.24 — there was no point at which any
   check could fire. A cap is meaningless for a step whose cost is larger than the remainder
   unless the step's cost is PROJECTED before it is submitted. Rule: before every submission,
   project that submission's cost from its inputs and refuse if spent + projected > cap; the
   up-front check should cover the minimum path (first author pass + verify) times a retry
   allowance, so a run cannot sink its author rounds and then be refused at verify.
3. **Calibrate the projection in the HIGH direction against a real run, and pin it with a
   test.** The first projection used a flat 500-token output allowance for every phase; replayed
   against the actual run it came out 25% LOW for verify (a verify result restates every sentence
   with verdict, reason, and quote — ~1,000 output tokens/item) and would still have allowed the
   batch. The replay caught it before commit; a calibration test now asserts the projection never
   falls below the measured actuals, so a quiet price-table or prompt change cannot re-open the
   hole. A projection that errs 25% high costs a larger --budget-usd; one that errs 25% low costs
   real money the operator did not approve.
4. **Disclose the overspend first, then the results.** The glosses were sound (every gate
   passed) — that does not change the order of the report.

## Lesson 45 — A sort key that is NULL for most rows degrades silently; measure the key's coverage, and grep for EVERY consumer before claiming a blast radius (2026-08-22)

"Recency-first" had been the documented ordering for both the summary exporter and the daily
scheduler for two weeks. It was never true: `sessions.start_date` was NULL for 30 of 31 Missouri
sessions, so the comparator saw '' for 95% of rows and fell through to its tiebreaks
(passage-first, smallest-first). Nothing errored, nothing warned, and the output looked plausible
— small bills from every year. Three rules:
1. **When an ordering or filter rests on a column, measure that column's coverage first** (one
   `count(*) where col is null`). A key that is mostly NULL is not an ordering; it is a tiebreak
   wearing an ordering's name. Now both consumers fall back to a parseable year AND report how
   many rows needed the fallback — a degraded sort must say so.
2. **"Only X consumes this" is a claim; grep for it.** The first write-up said "the scheduler is
   unaffected (it sorts by text size)" from memory of one comment. The adversarial review grepped
   and found `sortQueueRecencyFirst` keyed on the same column with no fallback. Blast-radius
   claims go in docs only after `grep -rn <column>` across site/, src/, scripts/, and views.
3. **A backfill from "the obvious source" deserves a second, independent source before it is
   written.** OpenStates' published special-session dates looked authoritative; the session's own
   LegiScan dataset (already cached locally) showed four of them were days-to-weeks LATE — a
   recorded bill action proves the session had begun. And the same datasets carried out-of-year
   stray entries in three regular sessions, which is why the second source is also guarded (a date
   outside the session's year is reported, never written). Write the earlier-attested date, name
   the source per row, and keep "both sources agree" for identical dates only.

## Lesson 46 — Anything a human (or a model) retypes into a launch call is a transcription, not a copy; keep the retyped part tiny and point at the rest (2026-08-22)

Wave EB's manifest was 14KB of inline prior-draft JSON, read from the generated file and
retyped into the workflow launch call "verbatim." One character drifted — a stray backslash
before the final quote — and the run died at `JSON.parse` before a single agent started.
$0 lost, but the failure mode is general: a file read back and re-emitted by hand is a
transcription with a per-character error rate, and a 14KB payload gives that rate a lot of
characters to work with. The fix is not "be more careful" — it is to make the retyped part
too small to corrupt: bank the bulk to a file by code and pass a stub with a pointer the
consumer (an agent with file tools) dereferences itself (lesson 40's mechanism, now the
DEFAULT for re-author waves via `build-drain-wave.mjs --pointer`, not a fallback for oversized
priors). Corollary: when a launch fails at parse, look for the transcription error in the
LAUNCH, not in the generated file — the file was fine.

## Lesson 47 — `Workflow({name})` can serve a session-cached copy of the script; after editing a workflow, launch it by `scriptPath` and verify the persisted script carries the edit (2026-08-22)

Right after committing the `reAuthor_file` pointer mode into `.claude/workflows/summary-wave.js`,
wave EB was launched the usual way — `Workflow({name: 'summary-wave-3', args})`. It ran, $0,
no error — and both author agents were authoring FRESH: no "RE-AUTHORING", no prior draft, no
objections, no pointer read. The harness had resolved the name to a copy of the script cached
earlier in the session; the persisted per-run script file (`…/workflows/scripts/summary-wave-3-
<runId>.js`) had zero occurrences of the new helper, and the stubs — carrying only
`reAuthor_file` — fell through the old `bill.reAuthor ? … : bill.checkpoint_file ? … : fresh`
chain into the fresh branch. Nothing failed loudly, which is the dangerous part: the wave would
have produced verifiable summaries on the wrong lane and charged a strike against bills whose
objections were never applied. Mechanics: (1) after editing a workflow file, launch with
`Workflow({scriptPath: '<repo path>', args})` — the tool reads that file from disk and says so
("Script file: F:\…\summary-wave.js"); (2) before trusting any run of an edited workflow, grep
the persisted script in the run's "Script file" path for the edit, and grep the first agent
transcript for a prompt phrase unique to the new branch; (3) a silent fallthrough is a design
smell — an item that carries a field the script does not recognise should throw, not author
fresh (captured in TODO, not yet built).

## Lesson 48 — A grammar verified against two fixtures is a hypothesis about the corpus, not a fact about it; before designing the fix, ground-truth EVERY quarantined instance and let the classes fall out (2026-08-23)

The MO Senate journal parser's "the sentence before the anchor names the bill" rule was verified
against 24 real motion sentences in two fixture days, shipped with three review rounds of
hardening, and then quarantined 20 of the session's days — because the rule was true of those 24
sentences and false of the session. The productive move was not to read two failing journals and
patch the first phrasing seen (the first one read showed three classes; the corpus had nine,
including non-bill roll calls that no bill grammar can ever satisfy). It was: fetch every
quarantined document once, reproduce each failure with the adapter's own functions, fan out one
classifier + one adversarial verifier per document, and only then design — against a table of
137 ground-truthed blocks that doubled as the test oracle (137/137 on the first full run after
the last three fixes). The second trap inside this one: capitalization was signal. The journal
names a vehicle in Title Case/CAPS and cites enactment history in lowercase ('as enacted by ...
senate bill no. 982'); a case-insensitive grammar read a title block as a three-bill ambiguity.
When a document's own typography is consistent, encode it rather than normalizing it away.

## Lesson 49 — "Needs human review" is only honest when a human could resolve it; a roll call with no bill is not a failed parse, it is a different kind of record (2026-08-23)

Four quarantined days contained nothing but quorum calls, votes on simple resolutions, an
amendment to the journal, and an appointment confirmation. The fail-loud gate filed each as
"no bill reference found in motion - needs human review" and quarantined the day — but no human
review could ever attach a bill, so the day sat quarantined forever and every bill vote on such a
day would have sat with it. Fail-loud is the right default for the unknown; for a shape the code
can recognise mechanically as legitimately bill-less, the honest output is a typed classification
that is reported and counted, not a failure. Corollary for the data model: votes.bill_id was
nullable from day one ("some votes are procedural") and nothing ever used it — the schema knew
something the parser did not.

*(Status 2026-08-23, same day: the fix is merged — commit 5ced4eb; all 20 quarantined days parse,
137/137 ground-truthed blocks, suite green — so the quarantined set is 0 and replay is in
progress: the first live 2018 day completed as non-bill (0979a57's "0/3/0" is 0 votes written /
3 non-bill roll calls / 0 failures; the day's done marker reads `votes: 0, non_bill_votes: 3,
gated: false`), the 14 2026-session days drain through the scheduler one per day-writing slot
(~every 1.5-1.75 h on 08-23, not every tick — `total_pending_days` 14 → 11 by 12:30Z; TODO's
RESUME HERE carries the live remainder), and the replay surfaced a 52-day 2018 journal backlog
(TODO INBOX, Lance's call). Two corrections to the corollary above: (a) the journal's non-bill
blocks are classified and COUNTED (`nonBillVotes`), not stored — the adapter says "for now, never
stored as votes"; (b) "nothing ever used it" was already wrong when written — the federal Senate
adapter stores bill-less roll calls (cloture, motion-to-proceed and confirmation votes on
nominations, PN numbers) with a NULL `bill_id`: hundreds are live, all 119th-Congress (451 at
2026-08-23, one of them a House vote; re-count live for current), and `site/js/person-page.js`
renders them without a bill link — the question text itself (e.g. "On the Cloture Motion —
PN13-11"), falling back to "(procedural vote, no associated bill)" only when a row has no
question. The schema knew, one adapter was already using it; the journal parser was the one that
did not. What the replay itself teaches is not yet a lesson. Cadence, done-marker fields and the
person-page wording corrected on review, 2026-08-23.)*

## Lesson 50 — A documented fallback that was never exercised is a hope, not a plan; and "not derivable" is only true for the derivation you actually tried (2026-08-23)

TODO 23 carried, for three weeks, the line "all 275 are House roll calls the primary house.mo.gov
pipeline supplies WITH real dates — so they arrive on that source's own timeline." Nobody had
ever run that pipeline for 2024; when the question finally came ("why is 2024 missing?"), one
browser click showed the House XML export serves only the current General Assembly. The fallback
was a sentence, not a path. Two mechanics: (1) when a ruling defers a gap to "source B will cover
it," verify source B serves that era BEFORE the ruling is filed — a single polite fetch, or a human
click where the ToU forbids scripting; (2) the same ruling said the dates were "not honestly
derivable," and the evidence was one perfection vote whose history printed no tally. Floor
passage actions in the same history print the tally and the date. "Not derivable" had been
tested against one derivation on one example; a corpus pass (275 roll calls, offline, minutes)
found a printed, exact, tally-keyed match for 185 of them (184 before an adversarial review
hardened the rule). Before accepting that a gap is
permanent, enumerate the derivations the source's own printed data allows and measure each over
the whole corpus — and spot-check the per-item endpoint before concluding a bulk-export sentinel
is the source's final word (here it was, but that is a query, not an assumption).

## Lesson 51 — A status word that never varies carries zero bits, and a classifier that only reaches a log line is not wired (2026-08-26)

`us-congress` closed 121 of 121 scheduled runs `partial`. `us-senate`, 121 of 121. Both sources
were perfectly healthy the entire time: the probe window is DESIGNED to overshoot the last real
roll call, so every tick 404s on the numbers past the edge, and every one of those 404s was being
recorded as a *failure*. The run status was therefore a constant. A constant cannot signal.

Three separate mechanics came out of fixing it, and the first two are the transferable ones.

**1. Distinguish "the source answered, and its answer is no such record" from "we got no answer."**
They arrive as the same exception type through the same catch, which is exactly why they got filed
together. A 404 (or senate.gov's HTTP-200 "Roll Call Vote Unavailable" stub) is a source that is up,
reachable, and telling you something true. A 500, a timeout, a rate limit, a body-read failure, a
parse error is a source you could not read. Only the second kind should degrade a run. Once split,
a recess tick closes `succeeded` with `absent: 10` and the word means something again.

**2. A classification that does not reach the durable record has not been wired.** This is the part
that would have been easy to miss and is the reason to check before building: the classifier
ALREADY EXISTED. `isExpectedTailProbeOutcome()` was written, commented, and unit-tested months
earlier, and it correctly returned "this partial is just tail probing." But its verdict fed only the
scheduler's own in-memory `healthy` flag — one log line and an optional healthcheck ping. The
`ingestion_runs` row still said `partial`, and `public_freshness`, which is what `npm run status`
prints and what an operator actually reads, renders that row. **Before writing a classifier, grep
for one; then follow its return value all the way to the surface a human reads.** Half this fix was
deleting the assumption that it was missing.

**3. A window that only probes PAST the known edge cannot tell "nothing new" from "the source
moved."** This was the hole in the audit's own stated plan, found while implementing it. If
clerk.house.gov changed its URL structure, every roll in a forward-only window would 404 — byte-
identical, at the ingest layer, to a quiet week, and now *worse* than before, because the
absent-vs-failure split would confidently close it `succeeded`. The fix is one extra request:
start the window AT the last roll already on file instead of one past it. That record must come
back. An absence at or below the known edge is never routine — it is the shape a retired endpoint,
a changed path, or an auth change makes — and it forces the tick unhealthy even though the child
exited 0 and its own run row says `succeeded`. **Every liveness probe needs one input whose correct
answer you already know.** A test suite full of "does not exist" assertions passes just as happily
against a server that has ceased to exist.

Generalization worth carrying: audit a status field by its **distribution**, not by reading one
row. `select status, count(*) group by status` over a source's history is a two-second query, and
"121 partial, 0 anything else" is a defect signature on its own, independent of what the rows say.

## Lesson 52 — Identical payloads are not identical identity; make the SOURCE prove sameness, not the data (2026-08-26)

An audit finding said 195 vote rows were stored twice, "measured by comparing cast lists (the only
honest test)". Building the fix started by re-measuring, which produced a different number (278) and
then, on inspection, destroyed the method entirely.

On 2025-06-30 the US Senate cast ten roll calls on one bill in one day. Every senator voted the
party line every time. Ten byte-identical 100-cast lists, identical question ("On the Motion"),
identical result ("Motion Rejected"), same bill, same chamber, same date. **Ten real votes.** The
"only honest test" would have hidden nine of them — and hiding a real recorded vote from a
legislator's record is precisely the thing this project exists not to do.

The generalization: **a payload fingerprint proves two records CONTAIN the same thing, never that
they ARE the same thing.** Any process that can legitimately repeat will eventually emit identical
payloads — a legislature voting the party line, a sensor reading a steady value, a job retried with
the same input. Deduplicating on content silently destroys real repetitions, and the destruction is
invisible because the survivor looks correct.

What actually proves identity is the source's own pointer at its own record. Here that was the
`source_url` fragment: two LegiScan `roll_call` records citing
`…RDay250220426-442.pdf#430.2` are the source saying "these are the same spot in the same journal".
Three refinements were each forced by a real case, and they are the reusable shape of the problem:

- **The document is not the record.** A MO journal PDF covers a whole sitting; `mo-senate-web`
  numbers several distinct votes against that one bare URL (`…-vote3`, `…-vote4`). Require the
  pointer to identify one record — here, a `#fragment` — not merely the container.
- **Even a fine-grained pointer can be shared.** Anchor `#521` (2019-03-14) carries both a 29-4 and
  a 33-0 roll call. Corroborating fields must still agree.
- **Vacuous agreement is not agreement.** Two NULL results satisfy "same result" while carrying no
  information. Require the corroborating field to be PRESENT, not just equal.

Two more things worth carrying. **State the asymmetry of the two errors out loud before choosing a
threshold** — a missed duplicate shows one redundant row; a false duplicate hides real evidence, so
the rule should be tuned to refuse under doubt, and 179 of 217 candidate groups being refused is a
success, not a shortfall. And **record WHY each refusal happened** (`different_source_url` 147,
`source_url_pins_no_specific_vote` 19, `cast_list_too_small` 13): a dry run that only lists what it
would change cannot be audited, because a silently-dropped group looks the same as one that was
never considered.

Postscript on the audit that raised it: three of the finding's four factual claims were wrong — the
count, the method, the cited example (SB 68's duplicate is 2019, not 2025), and the claim that
fixing it would drain reconciliation flags (it drains exactly zero). All were written confidently.
An audit finding is a lead, not a result; re-measure before building on one, including your own.

## Lesson 53 — Writing the lesson does not mean you obeyed it; and a rule that hides evidence must be dry-run against its own rejects (2026-08-26)

Lesson 52 was written the same hour this happened, and says in plain words: *a legislature voting
the party line twice emits byte-identical records, so make the SOURCE prove sameness.* The rule
shipped alongside it then went to production and **hid 17 real votes out of 38 pairs** — for exactly
that reason. The lesson was correct, freshly written, and did not prevent the defect it described.

What went wrong mechanically, both instances of one error — accepting a discriminator without
checking that it discriminates:

- **`#0` is not an anchor.** The rule demanded the `source_url` carry a `#fragment`, on the argument
  that a bare journal PDF covers a whole sitting and pins nothing. Sound. But LegiScan emits
  `…RDay02010981-89.pdf#0` when it has no page location at all, which *satisfies "has a fragment"*
  while carrying precisely the evidence the rule had just rejected as insufficient. 4 pairs.
- **A journal anchor is a PAGE pointer, and a page holds several roll calls.** The MO Senate adopts
  a substitute and then third-reads the same bill the same day; both pass with the identical tally
  from the identical members, and both rows legitimately carry the same page anchor. Only the
  `question` text separates "Senate: Adopt Substitute" from "Senate: Third Reading" — and the rule
  never compared it, despite having *measured* that 31 of 57 candidate pairs disagreed on question
  and then not acting on the number. 13 pairs.

Three transferable mechanics:

1. **Enumerate what each field can mean, including its null/placeholder form, before trusting it.**
   "Has a fragment" was tested; "the fragment means something" was not. Every identifier has a
   sentinel — `0`, `-1`, `0000-00-00`, `unknown`, the empty string — and a rule that treats presence
   as meaning will accept the sentinel as evidence. This project already had a lesson about the
   `0000-00-00` date sentinel; it did not generalise it to fragments.
2. **When a measurement contradicts the rule, act on it or write down why not.** The verification
   pass printed `question: 31` — thirty-one candidate pairs whose two rows had different question
   text — and it was read as a curiosity instead of a refutation. A number you produce and then do
   not explain is a finding you have decided to ignore.
3. **For any rule that HIDES data, dry-run it against its own rejects.** The dry run listed the 38
   it would supersede and nothing about the 179 it refused. Had it printed a sample of both, "keeps
   Adopt Substitute, hides Third Reading" would have been visible in one screen. A destructive or
   concealing rule should be reviewed by what it removes AND by whether its rejects look like the
   things it accepted.

Cost and recovery: caught within minutes because the apply output was actually read rather than
skimmed for the success line — the `#0` URLs were visible in it. Recovery was cheap only because the
design was non-destructive: nothing was deleted, the marking table is separate from `votes`, and
un-hiding was a `DELETE` of 17 marking rows. **Build the reversal path before the forward path when
the operation conceals evidence** — the `--prune` mode that fixed this had to be written after the
fact, under pressure, and should have existed first.

Postscript on the process: the two rulings behind this rule were the owner's to make. He was asked,
did not answer, and the work proceeded on stated assumptions — which was right. But "proceed under
stated assumptions" raises the bar on verification rather than lowering it, and that is the part
that slipped.

## Lesson 54 — An upstream provider's record id is not an identity, and `insertIfAbsent` on it will faithfully store the same event N times (2026-08-26)

For months the live site showed 196 Missouri bills whose ENTIRE public vote list belonged to a
different bill — 47 of them with published summaries, sitting in the `/bills` index. A visitor
reading HB 114, "Reduces the tax on diapers and feminine hygiene products," saw a 155-2 conference
committee vote on HB 10, an appropriations bill. Per-legislator 2023 totals were inflated 2.3x
(one member published as 1,182 yea when his real record was 489).

Cause: LegiScan's 2023 MO dataset mints a **separate `roll_call_id` per bill** for one physical
House floor vote. Three HB 10 roll calls were each carried under 232 different ids. Our ingest was
working exactly as designed — `source_key` is the provider's roll_call_id and it is genuinely
unique, so `insertIfAbsent` dutifully wrote 232 rows with 232 full cast lists. **No error, no
warning, no failed parse.** 693 phantom vote rows and 112,728 redundant casts, silently.

The generalizable trap: **a provider's identifier answers "is this the same RECORD I gave you
before", never "is this the same EVENT in the world".** Any dedup keyed on it inherits the
provider's identity model, including its bugs. Ask separately what the real-world event is and
what independently identifies it. Here that was the roll-call document itself — one PDF is one
physical vote — and the vote's own question text, which named HB 10 in all 232 copies.

Three mechanics worth carrying:

1. **The correct guard is source-family scoped, and the scoping is the whole job.** The obvious
   rule — "same source_url on a different bill_id is a defect" — flags 1,101 live votes of which
   only 693 are real: 408 false positives, because a MO Senate journal PDF is one day's sitting and
   legitimately prints every roll call taken that day across every bill. Granularity per URL shape
   must be DECLARED, and inference from the payload fails in the dangerous direction: "many
   distinct questions means container" waves the real fan-out through, since its 232 copies carry 2
   question variants. Unrecognized shapes default to the permissive answer, because the two errors
   are not symmetric — wrongly calling a URL per-vote deletes a real recorded vote.
2. **Retract, do not suppress, when the RELATIONSHIP is wrong.** A duplicate-marking table hides a
   redundant copy of a real vote on the right bill. It is the wrong tool when the `bill_id` itself
   is false: the row would still assert, in the base table, that a bill held a vote it never held,
   queryable by anything that does not join the exclusion perfectly. But retract to a **tombstone
   carrying the full cast list**, never a bare delete — that is what makes the operation replayable
   backwards if the rule proves wrong, and on this same day a rule DID prove wrong (lesson 53).
3. **Adversarial review earns its cost on exactly this shape of defect.** This was found by an
   8-dimension audit where every finding faced two independent skeptics instructed to refute it and
   re-measure rather than trust quoted evidence: 28 findings raised, **19 refuted, 9 survived**. A
   solo audit of the same system that morning had missed it entirely and had instead produced three
   confidently-wrong claims. The refuted:survived ratio is the point — a review process that
   confirms most of what it raises is not reviewing.

Postscript on verification hygiene, which failed three times in one day and each time produced a
false reading: `(data || [])` around a query that can ERROR silently converts a broken query into a
confident zero. It reported "0 open reconciliation flags" (wrong table name), then "0 feed rows for
this legislator" (`selectAll` defaults to `orderBy: 'id'` and the view's key is `cast_id`). **Check
the error before using the data, every time** — a swallowed error does not look like a bug, it looks
like a finding.

## Lesson 55 — A missing capability is a blocker to RAISE, not a fork in the road to quietly take (2026-08-26)

A session opened with a system notice: `plugin:supabase:supabase` requires authentication before
its tools can be used. That notice was read and never mentioned to the operator.

What happened instead, over the next few hours: noticing that database sweeps were slow, adding a
`pg` dependency, writing a ~400-line direct-Postgres client with a read-only transaction contract,
a verification script, unit tests, and setup documentation — and asking the operator to **reset his
database password**, a credential rotation with unknown blast radius, to obtain a connection string.

He asked one question — "would the database password have been used anywhere else?" — which forced
a check that turned up the `MCP — Connect your agent` tab. One click later the MCP was authorized
and, within minutes, it:

- found an **unindexed `votes.bill_id`** behind every bill-page query (a sequential scan discarding
  10,184 rows to return 2), via Supabase's performance advisor — **an API that is not reachable
  over REST at all**;
- let a `SECURITY DEFINER` warning be **tested and dismissed** as a false positive rather than
  guessed at;
- turned a 20-row retraction into **one atomic transaction with eight abort guards**, instead of 20
  separate non-atomic writes.

Everything the detour built was strictly worse than the thing that was already sitting there,
switched off.

**The rule.** When a capability you need is unavailable — an MCP not authorized, a credential
absent, an API not enabled, a permission denied — that is *information the operator needs*, and it
is almost always cheaper for them to fix than for you to route around. Say so, help them fix it,
then proceed. Building an alternative silently is a decision to spend their time and possibly their
security posture, made on their behalf, without telling them.

**Why the failure is easy and feels virtuous.** Routing around an obstacle reads as
resourcefulness. Every step of the detour was individually defensible and individually well-built.
Nothing felt like an error, which is exactly why nothing triggered a check. The tell is
*structural*, not emotional: **you are building infrastructure to reach a capability that already
exists.** A new dependency, a new credential, or a second access path to something the project
already has is the signal to stop and ask, no matter how good the code is.

**Mechanics adopted here.** `scripts/preflight-mcp.mjs` declares which MCP servers the project
depends on and what breaks without each; it runs from a SessionStart hook in
`.claude/settings.json`. It deliberately does NOT claim to check authorization — that is
per-session runtime state and cannot be read from disk — so it prints the rule instead of
pretending to enforce it. A preflight that misreports is worse than none: the first version of this
script read the plugin registry's per-plugin ARRAY as an object and cheerfully printed version
"unknown", which looks exactly like a check that passed.

The general form worth carrying: **for any capability gate, separate what a script can prove from
what only a human can resolve, and make the script loudly hand off the second half** rather than
quietly implying it covered both.

## Lesson 56 — a patched CVE is not a fixed architecture, and a finding split across two notes is a finding neither one makes (2026-08-29)

`pdfjs-dist` 6.1.200 carried GHSA-hq66-cqwq-w95j, arbitrary JS execution on a malicious PDF. It was
found, bumped to 6.3.289, proven byte-identical against six fixtures, and closed. The audit wrote
the blast radius as *"a process holding SUPABASE_SERVICE_ROLE_KEY"*.

That sentence is true and it is half the finding. **The other half is WHERE that process runs.** It
was Windows Task Scheduler on a personal desktop, every 15 minutes, parsing PDFs fetched from
external government sites, with the RLS-bypassing key sitting at rest in a `.env` beside a browser
profile and several other projects' credentials. The exploit would not have landed in an ephemeral
container that vanishes; it would have landed in the middle of everything the operator owns.

**Upgrading the dependency removed the instance and changed nothing about the blast radius.** The
next PDF-parser CVE — and there will be one, this is the third in that library's recent history —
arrives into exactly the same conditions.

### The reason it was missed twice

Two separate notes each held one half:

- one argued **availability**: a local scheduler dies while you are away;
- the other argued **privilege**: the worker holds the highest key.

Neither is wrong. Neither is the finding. The finding is the **product** of the two, and it only
becomes visible when you ask *where does the privileged thing actually execute?* — a question
neither note prompts on its own, because each is individually complete and individually reassuring.

**The rule:** when two notes describe the same component from different axes, cross-link them and
state the compound explicitly. A split finding is invisible in exactly proportion to how sensible
each half looks alone. Both halves were read many times; the product was never stated once.

### The corollary that saved money here

"Fix the architecture" is not automatically "migrate to CI". Migrating this repo to GitHub Actions
at its existing `*/15` cadence on a **private** repo would have cost $30-55/month against a 2,000
free-minute tier — breaking the project's $0/month premise to close a security gap. The fix was
real; the first-proposed shape of it was not affordable. **Measure the proposed remedy the same way
you measured the defect** — real run durations out of `ingestion_runs`, not an estimate. Hourly
lands inside the free tier and loses nothing, because roll calls do not change every 15 minutes.

And check what a remedy drags with it: going public would have made minutes free and the git history
was genuinely clean, but publishing exposes ALL history — here an unshipped commercial roadmap,
client names, and a personal email. Cleaning that up means rewriting the history that is the
project's own record of why. The cheap-looking option was the expensive one.

## Lesson 57 — an action nobody can re-run is a story, not evidence (2026-08-29)

Three times in one night I offered proof that could not be checked, and a reviewer had to catch each
one. The failures look different and are the same:

1. **Hand-abbreviated command output**, pasted into a commit message as a captured run. The lines
   had been reformatted, and the result (all 401) would have been identical under *every* version of
   the predicate being changed — so it did not exercise the branch it was cited for.
2. **"I proved the guard fires"** — by writing a file containing each evasion form, watching the
   guard name them, and deleting it. True, and unverifiable: nothing in the repo records it.
3. **"Reintroduced the bug, watched the test fail, restored cleanly"** — a working-tree excursion
   with no commit, stash or reflog entry. "It left no trace" was trivially true *because* it left no
   trace, which is the opposite of evidence.

Each was honest. None was checkable, and a claim a reader cannot check is worth what an unchecked
claim is worth, however true it happens to be.

**What actually constitutes evidence here, in ascending order of strength:**

- A **committed test** that fails when the defect is reintroduced. Durable, re-runnable by anyone,
  and it keeps working after everyone involved has forgotten the incident.
- A **reviewer's independent reproduction**. The reason the `/42501/` narrowness finding stood was
  not my selftest file; it was a peer running `node -e` and enumerating forms I had not thought of.
- A **tree hash or diff against a known commit** — `git diff --stat scripts/` proving a restore, not
  a sentence saying the restore happened.

**The discipline:** keep doing the ephemeral checks — they genuinely catch things, and two of the
three above found real defects. Just stop *citing* them as proof. Either convert the check into a
committed test, or say plainly "I ran X and saw Y; nothing in the repo records it."

**Why this is worth a lesson rather than a note:** the pull is strongest exactly when you have just
been careful. Having done the work, it feels dishonest *not* to mention it — so the temptation is to
write it up as evidence rather than as narrative. The tell is asking: *could a stranger re-run this
from the repo alone?* If not, it is a story.

**Related, from the same night:** a restore that misfired because `cp A || cp B` short-circuited —
the first `cp` succeeded to a Git Bash `/tmp` path (which Windows processes cannot open) so the
fallback never ran, and the buggy file survived a full test run. A fallback chain only fires on
failure, and "succeeded somewhere useless" is not failure. There was a durable copy the whole time —
the commit — and reaching for an ad-hoc backup instead of `git checkout` is the same instinct as
citing an ephemeral run: preferring the artifact you just made to the one that already exists.
