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
