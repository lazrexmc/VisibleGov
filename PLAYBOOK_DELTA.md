# PLAYBOOK_DELTA — what VisibleGov inherits, and what it will add

*Companion docs (to be created as the project takes shape): `CHATLOG.md` (word-for-word decision
trail), `CLAUDE.md` (this project's own working rules), `TODO.md` (backlog). This file is seeded
2026-07-27, before any VisibleGov code exists — it's the distilled, reusable lessons pulled from
Lance's other projects, read BEFORE the first line of VisibleGov gets written, per his own
established method.*

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
VisibleGov's own job is to prove the method works on a FIFTH domain - public civic data - and add
its own delta back to this chain.

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
   retroactively with guessed metadata; leave them untagged and move on.
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
   revalidation headers.
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
later, since Supabase's own docs explicitly warn this area changes).

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

Lesson 25 caught PowerShell mangling `node -e` one-liners; the same failure has a second face:
**any argument containing embedded double quotes gets re-tokenized when PowerShell 5.1 hands it to
a native executable** — even from inside a single-quoted here-string, which protects the text from
PowerShell's *parser* but not from its broken native-argument *marshalling*. Live failure: a
`git commit -m @'...'@` whose message quoted a gate reason (`"(SEC. 2)" vs "SEC. 2"`) exploded into
multiple arguments; git treated the fragments as pathspecs and the commit failed. The general rule:
prose destined for a native tool — commit messages, PR bodies, JSON payloads — gets WRITTEN TO A
FILE (with the Write tool, not `Set-Content`, per lesson 25) and passed by path: `git commit -F
<file>`, `--body-file`, `--file`. Arguments are for identifiers; files are for text.

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
receipt, not a delivery receipt. Related but distinct from the 25k-token Read cap (lesson
band): that one truncates what you READ, this one truncates what you SEND.

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
