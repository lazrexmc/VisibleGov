# LegiScan substitute-vehicle attribution — bounded investigation (research only)

**Date:** 2026-07-29. **Status:** research complete, no production code changed (per CONTROLLER
RULING 2, `task-7-brief.md` — the deliverable is evidence + a ruling recommendation, not an
implementation). **Branch:** `legiscan-bulk-adapter`. **Task:** Task 7 of
`docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md`
(`.superpowers/sdd/2026-07-29-legiscan-bulk-adapter/task-7-brief.md`).

## Why this exists

`tests/fixtures/research/SOURCES.md` flagged an open question after Task 2's LegiScan probe:
SB894's real `getBill` fixture carries exactly ONE roll call (747209, House, `"House: SB 894  SBs
3rd READ - INFORMAL"` — note the plural "SBs"), but none of SB894's own recorded Senate-passage
actions have a corresponding roll call in its `votes[]` array. The working hypothesis on record
was that LegiScan attributes the Senate roll call for the combined vehicle (`SS for SCS for SBs
894 & 921`, per our own `tests/fixtures/research/mo-senate/2018-day37-journal-onder-era.pdf`
ground truth) to SB921's bill record instead. This doc settles that with real payloads, bounded to
&le;3 live LegiScan queries, before any attribution rule is implemented in Task 9.

**Honest-status key**, used on every claim below (same convention as
`docs/research/2026-07-28-mo-senate-sources.md`):
- **VERIFIED-BY-PAYLOAD** — fetched/parsed the real thing (live LegiScan query this task, or an
  already-held fixture) and can point at the exact bytes.
- **DOCUMENTED-UNVERIFIED** — read in an official source but not independently confirmed against a
  payload in this investigation.
- **UNKNOWN** — could not determine either way; what would resolve it is stated.

## Query budget: 1 of &le;3 used

Per CONTROLLER RULING 3 ("a query spent on something the fixtures already answer is a budget
violation"), every already-held fixture was exhausted first (masterlist bill_ids for both SB894
and SB921, SB894's own `getBill` payload, the dataset ZIP bill payloads' `sasts` shape, LegiScan's
own PHP client + `schema-mysql.sql` from the already-held `legiscan-current.tar.gz`, and the
Day 37 journal ground truth via the real `mo-senate-journal-pdf.js` parser) before any live call.
That exhaustion resolved everything except one question the fixtures genuinely could not answer:
whether SB921's *own* `getBill` record carries a Senate roll call SB894's doesn't. That required
one live query.

1. `getBill`: `https://api.legiscan.com/?key=REDACTED&op=getBill&id=1061416` (200 OK, `status:
   "OK"`). `id=1061416` is SB921's `bill_id`, already known from the held masterlist fixture
   (`tests/fixtures/research/legiscan/mo-2018-masterlist.json`, entry 2067) — no list re-query, per
   the brief's own instruction.

Result saved as `tests/fixtures/research/legiscan/mo-2018-SB921.json` (raw `{status, bill}`
envelope, same convention as `mo-2018-SB894.json`). Grepped clean of key material before
committing.

The brief's second planned probe (`getRollCall` for whatever roll call SB921 turned out to carry)
was **not needed and not spent**: SB921's `votes[]` array is empty (see below), so there was no
roll call id to fetch. 2 of the 3 budgeted queries were never spent.

## Finding (a): does the combined vehicle's roll call appear under one sibling, both, or neither?

**Neither. VERIFIED-BY-PAYLOAD.** This is the "third shape neither anticipated" the brief asked to
watch for — not hypothesis (a) (voice vote) and not hypothesis (b) (attributed to the other
sibling) as originally framed, though closer to a variant of (a): **LegiScan's own data for this
bill simply has no Senate roll call at all, for either sibling, despite a real individually
recorded roll call existing in the primary source.**

### SB894's own `getBill` (already held, `mo-2018-SB894.json`)

`votes[]` has exactly one entry: roll call 747209, `chamber: "H"`, `date: "2018-05-02"`,
`desc: "House: SB 894  SBs 3rd READ - INFORMAL"`. No Senate-chamber roll call anywhere in the
array. `sasts: []` (empty — see Finding (b)).

### SB921's own `getBill` (new, this task, `mo-2018-SB921.json`)

```json
{
  "bill_id": 1061416, "bill_number": "SB921",
  "status": 1, "status_date": "1969-12-31",
  "history": [
    {"date": "2018-01-17", "chamber": "S", "action": "S First Read--SB 921-Rizzo"},
    {"date": "2018-01-25", "chamber": "S", "action": "Second Read and Referred S Economic Development Committee"},
    {"date": "2018-02-06", "chamber": "S", "action": "Hearing Conducted S Economic Development Committee"},
    {"date": "2018-02-20", "chamber": "S", "action": "Bill Combined w/(SCS SBs 894 & 921)"}
  ],
  "votes": [],
  "sasts": []
}
```

SB921's own `history` **stops at the combination event** (2018-02-20) — LegiScan never updated
SB921's record again after that (`status_date: "1969-12-31"` and the masterlist's own
`last_action_date: "0000-00-00"` are LegiScan's null-date sentinels, not real dates). `votes: []`
— confirmed empty, not just missing a Senate entry. **No roll call of any kind is attributed to
SB921 anywhere in LegiScan's data.**

### Ground truth: the vote was real and individually recorded (not a voice vote)

Parsed `tests/fixtures/research/mo-senate/2018-day37-journal-onder-era.pdf` with the real
`extractJournalText`/`parseJournalVotes` from `src/adapters/mo-senate-journal-pdf.js` (no mocking,
no re-implementation). Result: 13 votes parsed, 0 failures. Block 6:

```
motion: "On motion of Senator Libla, SS for SCS for SBs 894 and 921 was read the 3rd time
         and passed by the following vote:"
bill_refs: ["SB 894", "SB 921"]
tallies: { yeas: 31, nays: 0, absent: 0 }, vacancies: 1
yeas: Brown, Chappelle-Nadal, Cierpiot, Crawford, Cunningham, Curls, Dixon, Eigel, Emery,
      Hegeman, Holsman, Hoskins, Hummel, Koenig, Libla, Munzlinger, Nasheed, Onder, Richard,
      Riddle, Rizzo, Romine, Rowden, Schaaf, Schatz, Schupp, Sifton, Wallingford, Walsh,
      Wasson, Wieland
absentWithLeave: Kehoe, Sater
```

31-0, individually named, reconciled against the journal's own printed `—31` count by the parser's
existing reconcile-or-throw gate (never bypassed for this check). **This is not a voice vote** —
it is exactly the kind of real, named roll call LegiScan's data model is built to carry, and
LegiScan simply does not have it for either SB894 or SB921.

### Correction to the brief's own framing

`task-7-brief.md` describes the missing Senate roll calls as "`S Third Read and Passed`, `Truly
Agreed To and Finally Passed`, both 2018-05-03." SB894's real `history` array (already held,
re-read for this task) shows this actually collapses **two separate Senate events**, not one:

1. **2018-03-08**: `S Third Read and Passed` — the Senate's *original* passage of `SS for SCS for
   SBs 894 & 921`. This is the event the Day 37 journal (March 8, 2018) captures — the brief's own
   framing omitted this earlier date entirely.
2. **2018-05-03**: `S concurs in HCS, as amended` + `S Third Read and Passed` (logged under
   LegiScan's `H` chamber-track, likely because it's part of the House-amendment concurrence
   sequence) + `S Truly Agreed To and Finally Passed` — the Senate concurring in the House's
   amended version, a *different*, later vote.

Both events are entirely absent from SB894's `votes[]`, and neither is attributed to SB921 either.
Whether the May 3 concurrence vote was *also* individually recorded in the Senate journal is
**UNKNOWN** — that would require fetching a different day's journal PDF from `senate.mo.gov`
(not a LegiScan query, so it wouldn't count against this task's 3-query budget, but it was out of
this task's bounded scope and wasn't fetched). It does not change the finding above: LegiScan has
zero Senate roll calls for this bill regardless of which of the two dates is meant.

## Finding (b): do the two siblings cross-reference each other structurally (`sasts`)?

**No — VERIFIED-BY-PAYLOAD, and the gap is broader than just this bill pair.**

- SB894's `sasts: []` (already held). SB921's `sasts: []` (this task's new fixture). Neither side
  carries a structured link to the other.
- Checked every bill payload already held in the two committed dataset-ZIP fixtures
  (`tests/fixtures/research/legiscan/dataset-2018/.../bill/*.json`,
  `.../dataset-2018-1608/.../bill/*.json` — 27 bill files total) for a non-empty `sasts` array:
  **zero found.** This repo currently holds **no real-payload example of a populated `sasts`
  array anywhere** — its structure below is DOCUMENTED-UNVERIFIED (from LegiScan's own schema),
  not confirmed against a real API response.
- The `sasts` mechanism does exist in LegiScan's own schema (extracted from the already-held
  `legiscan-current.tar.gz` → `legiscan/schema-mysql.sql`, `ls_bill_sast` table: `bill_id,
  sast_type_id, sast_bill_id, sast_bill_number`; `ls_sast_type` seed values: 1 Same As, 2 Similar
  To, 3 Replaced by, 4 Replaces, 5 Crossfiled, 6 Enabling for, 7 Enabled by, 8 Related, 9 Carry
  Over). **No "Combined" type exists.** For this real combination event, LegiScan recorded the
  relationship only as free text in `history`/`last_action` (`"Bill Combined w/(SCS SBs 894 &
  921)"`), not through the structured `sasts` cross-reference at all — the structured mechanism
  was available and was not used for this case.
- Structural fact, also from `schema-mysql.sql` (`ls_bill_vote`, line 218):
  `bill_id mediumint(8) UNSIGNED NOT NULL` — a single scalar foreign key, not a join table. **This
  means LegiScan's own data model cannot attribute one roll call to two bill_ids at once, ever.**
  If LegiScan had captured this Senate vote at all, it could only have landed under SB894's
  `bill_id` OR SB921's, never both — hypothesis (b) was never structurally capable of being
  "both," only "one or the other." We checked both and found neither.

## Finding (c): attribution rule recommendation for Task 9

**Recommendation: ship option (i) from the plan's binding ruling
(`docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md`, Task 7 section — "Schema
implication, ruled in advance") — single-bill-primary attribution, no schema change. Do NOT build
a bill↔vote join table.** The real finding supports this more strongly than the plan anticipated,
for two independent reasons:

1. **LegiScan's own production schema already proves (i) at scale.** `ls_bill_vote.bill_id` is a
   single scalar FK across LegiScan's entire multi-state dataset (all 50 states, hundreds of
   thousands of bills) — LegiScan itself never uses a join table for a combined-vehicle roll call,
   it just picks one bill_id. A system operating at that scale settling on single-attribution is
   real evidence the pattern is sufficient, not just convenient.
2. **This exact pattern is already shipped, working code in this repo — not a proposal.**
   `src/cli/ingest-mo-senate.js` (lines ~663-677) already implements it for the primary-source MO
   Senate path: every sibling in `vote.bill_refs` gets a `bills` stub row
   (`insertIfAbsent(client, 'bills', vote.bill_refs.map(...), 'session_id,identifier')`), but the
   `votes` row's `bill_id` is resolved from `primaryRef = vote.bill_refs[0]` only — one `votes`
   row, one `vote_casts` set, per real floor action. `votes.question` is set to the verbatim
   motion text (`vote.motion`), which already names every sibling (`"...SS for SCS for SBs 894 and
   921 was read the 3rd time..."`) — this is the traceability mechanism the plan's own ruling
   pointed at ("siblings are traceable via the verbatim motion/desc text"), already live.

**Concretely, for Task 9's LegiScan driver:**
- Use `roll_call.bill_id` verbatim as the FK to resolve `votes.bill_id` (via the normalized
  bill-identifier lookup Task 9 already plans) — no picking logic is needed on LegiScan's side,
  because LegiScan's own schema has already picked (see Finding (b)'s structural point above).
- Store `roll_call.desc` verbatim in `votes.question` (already the plan's design;
  `reconcileLegiscanTallies` already returns `question: rollCall.desc`) — this preserves the
  "SBs 894 & 921" style plural/sibling text LegiScan itself sometimes prints (as seen in roll call
  747209's own `desc`), giving the same text-based traceability `ingest-mo-senate.js` relies on.
- **Do not synthesize a second `votes`/`vote_casts` row for a sibling bill_id under any
  circumstance.** There is no evidence LegiScan ever needs this (Finding (b)), and doing so would
  be the double-counting failure mode described next.

### Double-counting analysis

If a combined-vehicle roll call were instead written as two full `votes` rows (one per sibling
bill_id, each with its own complete `vote_casts` set for every legislator), a single real floor
action — 31 senators each casting exactly one vote on 2018-03-08 — would be represented as **two**
recorded votes per legislator instead of one. Any aggregate computed over `vote_casts`
(participation rate, "how often has Senator X voted yea," party-line comparisons, etc.) would
silently double-weight this one floor action relative to every other vote in the same legislator's
record. That is a real, mechanical accuracy defect, not a cosmetic one — it directly conflicts with
this project's one non-negotiable (`CLAUDE.md`: "mechanically neutral... everything traceable to
the actual recorded vote"). A duplicated vote_casts set is not traceable to a second real vote;
it's a phantom.

Option (i) avoids this by construction: exactly one `votes` row and one `vote_casts` set per real
recorded roll call, matching the actual number of times each legislator actually voted. The cost
is a display-time gap, not a data-integrity one: a sibling bill's own page (e.g. SB921's, were it
ever rendered) will not surface this vote via a plain `votes.bill_id = SB921` lookup, since the
row lives under SB894. Per the plan's own ruling ("even then only if Plan 3's bill-page scoping
actually demands it, not preemptively here"), this is **not** built now — flagged here as a known,
deliberate gap for whoever builds Plan 3's bill-page rendering: that work will need to also match
on `votes.question`/bill_refs text (or a future lightweight lookup) to show a combined-vehicle vote
on every sibling's page, without ever writing a second `votes` row to do it.

## Fixtures committed this task

- `tests/fixtures/research/legiscan/mo-2018-SB921.json` — new. Live `getBill` response for SB921
  (bill_id 1061416), `{status, bill}` envelope, same shape as the already-held
  `mo-2018-SB894.json`. Grepped clean of key material.

No other new fixtures were needed — every other claim above was settled against fixtures already
held before this task started (`mo-2018-masterlist.json`, `mo-2018-SB894.json`,
`mo-2018-rollcall-747209.json`, `legiscan-current.tar.gz`, the two dataset-ZIP bill directories,
and `2018-day37-journal-onder-era.pdf`, parsed with the real `src/adapters/mo-senate-journal-pdf.js`
rather than re-implemented).

## What Lance/the controller needs to rule on

Whether to accept the option (i) recommendation above for Task 9's brief (single-bill-primary
attribution via `roll_call.bill_id` verbatim, `question` carries sibling text, no join table) —
per CONTROLLER RULING 2, this doc is the recommendation for the controller to rule on before
Task 9 is written, not a decision made unilaterally here.
