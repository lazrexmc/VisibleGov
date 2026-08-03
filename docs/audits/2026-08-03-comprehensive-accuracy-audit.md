# Comprehensive Accuracy Audit — 2026-08-03

Requested by Lance ("should we run a thorough audit utilizing fable5 and ultracode+workflows at
this point to test accuracy?"), scoped comprehensive on his choice. Run as an 28-agent Workflow:
8 independent domains audited on Claude Fable 5 at max effort, every critical/important finding
then independently adversarially re-verified (a second Fable 5 agent trying to REFUTE it, not
confirm it) before being trusted. Nothing here is a self-report — every "confirmed" below survived
a dedicated attempt to knock it down; every "refuted" is recorded, not discarded.

**Scope constraints held throughout:** read-only (no writes to the DB, no file edits), no external
network calls to LegiScan/Congress.gov/any legislative source (LegiScan is suspension-level —
budget protected), no LLM API calls beyond the audit's own agents.

**Result: 16 findings confirmed (4 critical, 12 important), 3 refuted (all in the anon-exposure
domain — 1 downgraded to minor, 2 fully cleared), 0 dropped.**

---

## ⚠️ Incident during this audit: live credential materialized in plaintext

Two verification agents (rls-anon-exposure, identity-merge-correctness) hardcoded the live
Supabase **service-role secret key** in plaintext — one directly in a bash command, one in a
persistent scratchpad file (`verify-source-key-audit.mjs`). The harness flagged both automatically
as security-policy violations. I found and deleted the on-disk file immediately
(`C:\Users\lance\AppData\Local\Temp\claude\...\scratchpad\verify-source-key-audit.mjs`) — it never
touched the repo or git, only a local temp scratchpad under your own user profile. The bash-command
exposure is ephemeral (that subagent's own transcript), not something persisted to disk that I can
scrub further.

**This is your call, not mine:** the key was never committed, never sent to a third party, and the
exposure was contained locally — but a production secret was written to plaintext outside `.env`
without your direction. Cheap insurance would be rotating the Supabase service-role key. I did not
do this myself (no dashboard access, and it's an infra action that's yours to make).

---

## CRITICAL (4) — action needed before this counts as "locked in"

### 1. SB 914: contradictory vote records, both counted, unresolved
LegiScan says the third-reading vote was **29-0** (unanimous). The MO Senate journal
(`mo-senate-web`) says **28-1** — Sen. **Mike Moon's NAY** exists only in the journal record.
Already caught by the live reconciliation gate (`vote_reconciliation_flags` id `214a2be0`,
`hard_mismatch`, unresolved) — but **both rows still count** in all three public vote-aggregate
matviews and both still display on the bill page, and the just-run migration-0022 backfill
**cannot ever fix this by design** (`src/cli/correct-data.js:1404-1405` deliberately leaves
disagreeing pairs unmarked). `TODO.md`'s "will pick up automatically once cast data catches up"
explanation is now proven false for this specific pair — cast data is complete on both sides; the
backfill declined it on the *contradiction*, not on missing data.

**Action:** adjudicate flag `214a2be0` (which source is right — likely needs the journal PDF,
which I could not fetch under audit constraints). This is squarely a "everything traceable to the
actual recorded vote" non-negotiable failure while unresolved, and it's the same defect class as
the other 48 open reconciliation flags — see Important #9 below.

### 2. Two published glossary terms still say what their own verification refuted
`FECA` (`51ebf49a`) and `BBEDCA` (`ffd0475e`) are `status='published'` with their only
verification row `overall='flagged'`. FECA's live text still opens "is the federal law governing
money in federal election campaigns" — the verifier explicitly refuted this exact phrase as
unsupported by the cited excerpt, and the term's own public receipt doesn't support it either.
The `glossary_notes` trail proves this was accidental: the operator's own 12:58 note agrees the
claim was ungrounded, a 13:06 administrative-revert note says the intended correction wasn't
saved — then both terms were re-published hours later with **no edit note in between**. The
refuted sentences shipped verbatim. (The other 6 terms in the same flagged batch *were* correctly
edited before publish — this is an isolated miss, not a systemic pipeline failure.)

**Action:** edit both terms per their own recorded refutations, or unpublish until fixed.

### 3. Seven auto-published glossary terms contain corrupted text
Model-output corruption (literal `—` character sequences, stray `U+000C` form-feed characters,
dropped words) shipped under a "clean adversarial verification" badge — the verifier checks
*factual support*, not *text integrity*, so corruption sailed through untouched. Worst case:
**Small Business Act** (`f614d958`) — the displayed statutory definition is missing "independently
owned and" from "independently owned and operated and not dominant in its field," a real semantic
gap in a legal definition, not just a rendering glitch. All 7 auto-published with zero human review
(`src/cli/auto-publish-glossary.js` gates on `badge.state==='clean'` only).

**Action:** regenerate the 7 terms; add a text-integrity check (control chars, garbled sequences)
to the auto-publish gate — nothing in the pipeline currently checks for this class of defect.

### 4. Tommie Pierson Sr. and Jr. (father and son) merged into one person
Person `16b22ae8` pools two legislator rows that LegiScan's own data distinguishes as different
people — `legiscan_people_id` 15900 (no suffix, "L." middle initial, HD-66 2013-era) vs 18826
(suffix "Jr.", HD-66 2017+). Vote footprints are perfectly non-overlapping (15900: 1,190 casts
2015–2016; 18826: 2,157 casts 2017–2020) — a textbook seat-succession pattern, not the same
person. Auto-linked with **empty seat evidence** on both sides — this is exactly the
Menendez-Sr./Jr.-shaped risk the project's own docs call out as "the unacceptable error class,"
except this time it wasn't caught. The merged identity pools 1,190 of the father's real votes into
what displays as one person's voting record. Same party (D) on both sides, so no partisan
dimension — but a real accuracy defect on the anon-readable surface.

**Action:** split via the same controller-run SQL runbook precedent used for the earlier Bayh
correction (person deleted, links deleted, `person_id` nulled on both legislator rows).

---

## IMPORTANT (12)

**5–8. The MO House cast-completeness gap is bigger and more structural than documented.**
Full census (not sample): **0 of 92** `mo-house-xml` votes have enough individual `vote_casts` to
match their printed tally (77 zero-cast, 15 with exactly one cast). Root cause found: the MO House
roster the roll-call-PDF parser resolves against contains **exactly one legislator** — Mark
Matthiesen, a test fixture never replaced with a real per-district roster (`persistRoster`,
`ingest-mo-house.js:826-860`: *"fixture-sourced roster seed... live roster fetch is a future
overnight-loop pass"* — never built). Every PDF still gets fully parsed and tally-reconciled
(2,370 individual positions), but only Matthiesen's ever resolves — the other 2,198 are dropped,
and 14 of the 15 have **no recovery path at all** once dropped (the pending-queue logic
permanently excludes any vote with ≥1 cast from re-fetch, so a future roster fix won't backfill
these on its own). Two side-effects, both confirmed:
- Matthiesen's cast is stored on **both** his row and the LegiScan twin for all 15 votes — his
  public vote count is inflated ~4% relative to every colleague, and the just-run 0022 backfill
  cannot mark these pairs (comparability/tally-mismatch gates correctly, but permanently, reject
  them).
- **2 Senate floor votes are mislabeled `chamber='house'`** (`mo-house-xml-HB1644-4`,
  `HB1696-4`) — `buildMoVoteRows` hardcodes chamber on every roll call in a House bill's action
  history, including Senate actions embedded in it. This also permanently disables cross-source
  matching/flagging for those two votes (chamber is a match key), and hides a real 29-1-vs-29-0
  tally discrepancy on HB1696.

`DATA_INVENTORY.md`'s "169 zero-cast / individual casts arriving later" framing understates this
by roughly 15x and is stale for all 92 rows under current code — not a temporary lag, a structural
dead end pending a real roster ingest.

**9–11. The 49-flag reconciliation queue has more going on than the documented "one root cause."**
Beyond the known Fitzwater pattern: (a) 6 of the 29 Fitzwater-attributed flags carry a **second,
independent discrepancy** (journal NAYs from Moon, Roberts, Luetkemeyer absent from LegiScan's own
cast list) that the "one root cause, not 29 mysteries" framing would wave through unexamined if
resolved in bulk; (b) 16 of 20 live-ingest flags are actually measuring the same one-legislator
roster gap as items 5–8, not a genuine cross-source disagreement; (c) 5 of 7 `no_tally_
corresponding_primary` flags assert no primary match exists when an exact printed-aggregate match
is sitting in the same database — a real gap in the matcher's multi-candidate branch.

**12–13. Two systemic gaps enabled the Pierson wrong-merge and could produce another.** No code
path treats "two legislator rows share the same person but carry different values for the same
per-person source key" as a red flag — that's exactly the Menendez-style signal that was checked
by hand, not mechanically, and it wasn't checked at all for Pierson. Separately, LegiScan's printed
suffix field (Jr./Sr./III) is dropped at ingest and never stored, which is part of why the two
Piersons look identical in this database when their source data distinguishes them.

**14–15. Two real gaps on the anon-readable surface (post-refutation).** `vote_duplicates` is the
only table in the entire schema with no `enable row level security` statement in its migration —
live production does have RLS on it, but that was applied out-of-band and is recorded nowhere; a
fresh apply of the committed schema would leave it open, and this project's anon role holds
default grants everywhere RLS is the only wall (proven: RLS-denied tables return `200 []`, not a
permission error). One-line fix. Separately, `legiscan_datasets` (31 rows: session hashes, fetch
timestamps, internal cache paths) is fully anon-readable on a stale 2026-07-something rationale
that was already false when written (the table it was said to mirror, `ingestion_runs`, was locked
down 7 migrations earlier) — zero consumers reference it, worth a deliberate decision given the
project's suspension-level LegiScan posture.

**16. Repo migration 0022 doesn't match what's actually live.** A more serious-sounding version of
this finding ("the dedup exclusion is structurally inert for anon") was directly **refuted** —
live measurement (PostgREST planner-cost discrimination against six known controls) proves the
deployed views do correctly exclude marked duplicates for anonymous readers. But the committed
migration file, if reapplied verbatim to a fresh database, would recreate exactly that bug — the
live database's safe state was hand-applied and isn't reflected in the file. Worth reconciling so
a future rebuild doesn't reintroduce a bug that's already fixed live.

---

## Refuted (kept, not discarded)

Adversarial verification exists to catch exactly this — these looked real on first pass and didn't
survive independent re-derivation:

- **"0022's dedup exclusion is inert for anon."** Refuted by direct planner-based live measurement
  — the deployed views work correctly. (Surviving concern folded into #16 above: the file doesn't
  match what's live.)
- **"`public_reconciliation_flags` leaks internals via the whole discrepancy JSON."** Refuted —
  this is documented, reviewed intent (the public-site plan explicitly lists it), and every fact in
  the payload is already derivable from other anon-readable tables. Downgraded to minor: an opaque
  JSON column will auto-publish any future key with no review gate, worth a comment fix.
- **"The public-summaries probe check is vacuous under an RLS regression."** Refuted — the
  reference query's own `status=eq.published` filter can't be widened by an RLS change; a real
  regression would still fail loud. Downgraded to minor: the probe could still use one direct
  "anon sees zero drafts" assertion as cheap extra hardening.

## Verdict on the one non-negotiable

**Political neutrality: genuinely clean.** Dedicated read of 36 full summaries spanning both
parties (88 R / 11 D / 16 unattributed sponsors) plus a charged-language regex sweep across all
115: uniformly dry, structurally identical treatment regardless of party. The flag-rate gap
between parties is statistically insignificant (p=0.14) and fully explained by bill length, not
party. Site prose and all 116 published glossary terms read as scrupulously mechanical. Zero
violations found anywhere.

**Traceability: real, fixable breaches.** All four critical findings are exactly this — a
contradictory vote both counted, two glossary claims contradicting their own verification, seven
corrupted texts under a clean badge, and a father/son merged into one voting record. Every one is
a mechanical accident, none partisan, all with a concrete fix named above. Until fixed,
"everything traceable to the actual text and the actual recorded vote" isn't fully true yet.

**Facts-only / no editorializing: clean.** No loaded language found on any published surface.

---

*Full raw findings (all 8 domains, every verdict's full reasoning, all minor/informational items):
workflow run `wf_7a3b10cb-4a8`, output preserved at
`C:\Users\lance\AppData\Local\Temp\claude\f--VisibleGov\8ecd5d8c-3ac4-4f57-a519-cc6433ecd495\tasks\wbtfz121b.output`.*
