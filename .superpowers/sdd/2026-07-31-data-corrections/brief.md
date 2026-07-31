# Task brief — data corrections (draft-then-apply; Lance runs the live pass)

Two production-data corrections. Build the CLI, TDD it, and make it dry-run-able. **Do NOT run it
live** — Lance approved building it *ready*; the live pass needs his separate explicit word. Each
correction is REVERSIBLE (originals re-derivable from the cached LegiScan datasets), which is what
makes them safe to draft.

CLI: `node --env-file=.env src/cli/correct-data.js <which> [--dry-run] [--limit N]`
where `<which>` is `mo-status` | `mo-1969-dates` | `all`. Default to requiring an explicit
`<which>` (no accidental all-corrections run). `--limit` uses the shared fail-loud positive-integer
validation. Every mode: honest counts that reconcile, a `failures[]` array, a run record.

## Correction A — `mo-status`: numeric LegiScan status codes → their printed words

**The mapping is SOURCED, not invented** — LegiScan's own API manual, page 42
(`tests/fixtures/research/legiscan/LegiScan_API_User_Manual.pdf`, "Status / Progress" table). Copy
this table into a documented constant with that citation in a comment. LegiScan encodes bill status
as an integer and prints NO word anywhere in the dataset, so decoding it with the source's own
published codebook is exactly the same class as `VOTE_ID_MAP` (1→yea) — decoding, not editorializing:

```
0  N/A (pre-filed / pre-introduction)   -> LEAVE UNTOUCHED (no honest single word; the site already omits it)
1  Introduced
2  Engrossed
3  Enrolled
4  Passed
5  Vetoed
6  Failed
7-12  Override/Chaptered/Refer/Report Pass/Report DNP/Draft -> "Progress array only" per the manual;
      these are NOT a bill's overall status and must not appear in bills.status. If any DO appear,
      LEAVE UNTOUCHED and count them (unexpectedMappedCode) — never guess a word for a code the
      manual says isn't a status.
```

Live DB counts confirmed by the controller (targets for the dry-run to reproduce): status `"1"`=33,068,
`"2"`=2,542, `"3"`=111, `"4"`=1,849, `"5"`=92, `"6"`=0, `"0"`=36 (left untouched), other=0.

Behavior:
- For each mapped code 1-6: `update({status: word}).eq('status', code)` — the `.eq` on the update
  itself is the guard, so a federal bill (text status) or an already-corrected word can NEVER match
  a numeric code. Additive-safe by construction; no bill outside the exact numeric match is touched.
- Do it per-code (six updates) so the counts are per-code and exact; `.select('id')` to count rows
  actually changed (not just "no error").
- Honest counts `{perCode:{1:n,...}, updated, leftUntouchedZero, unexpectedMappedCode, failures}`.
- **Fix the writer too** so re-ingestion never reintroduces a numeric code: find every writer of
  `bills.status` sourced from LegiScan (start with `src/cli/backfill-mo-bill-meta.js`; grep for
  `.status` writes against bills). At the write site, map the code to the word via the SAME exported
  constant before writing. A writer that only fills-null won't regress the corrected rows, but a
  NEW bill first-seen must store the word, not the code. If a writer is out of this task's safe
  scope, name it precisely in your report rather than editing broadly.

## Correction B — `mo-1969-dates`: 10 votes carrying LegiScan's 1969-12-31 sentinel

10 `votes` rows (session 1530 / 2018 Regular, all `chamber:senate`, `vote_date` =
`1969-12-31T00:00:00+00:00`) carry LegiScan's missing-date sentinel. Sample source_url:
`https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf#470`.

**Primary-wins, and NEVER write a guessed date.** Investigate, in this order, and use the first that
yields a *traceable* real date; if none does for a given row, LEAVE it and count it
`unresolvableDate` (a wrong date is worse than a sentinel we already flag):
1. **Duplicate check first:** does the MO Senate *journal* pipeline (the primary/completeness layer)
   already hold the SAME roll call with a correct date? Match on bill + the roll call's identity.
   If a dated primary copy exists, the LegiScan sentinel row is a duplicate — the correct
   primary-wins action is to DELETE the sentinel row (and its casts), not re-date it. Verify
   carefully before any delete; a delete is only safe if the primary copy genuinely covers the same
   cast set.
2. **Derive from the primary source URL:** the journal filename encodes the date —
   `/18info/` = 2018, `RDay33` `0301` = March 01 → 2018-03-01. This is the primary source's own
   filename stating the date, so it is traceable. Parse it mechanically and defensively; if the
   pattern does not cleanly parse for a row, do not guess — count `unresolvableDate`.
- Whichever path: touch ONLY these ≤10 rows (guard the update/delete on `vote_date` = the sentinel
  AND the exact vote id), refresh nothing here (controller refreshes aggregates after).
- Honest counts `{seen, deletedAsDuplicate, redatedFromSource, unresolvableDate, failures}`.

## Tests (TDD, failing first)

`tests/correct-data.test.js`, fakes + the real manual-sourced constant:
- the status map matches the manual table exactly (a test that pins each of 1-6 to its word and
  asserts 0 and 7-12 are NOT in the "safe to write" set);
- an update only fires against an exact numeric match (a word-status row and a federal row are
  never touched — assert the `.eq('status', code)` guard);
- per-code counts reconcile to `updated`;
- `mo-1969-dates`: a sentinel row with a dated primary duplicate → delete path; a sentinel row with
  no duplicate but a parseable source URL → re-date to the parsed date; a sentinel row whose URL
  won't parse and has no duplicate → `unresolvableDate`, untouched; a NON-sentinel vote is never
  touched;
- `--dry-run` performs zero writes for both corrections; `--limit` validation.

Full suite: bare `node --test` from repo root, baseline **1950** stays green.

## Out of scope

The 275 undated 2024 House roll calls — those were REFUSED at ingest and never stored (0 null-date
votes in the DB, confirmed), so there is nothing to correct; they stay refused (primary house.mo.gov
yields dated facts). Any live run. Aggregate refresh (controller does it after the live pass).

Commit: `feat: data-correction CLI (MO status words from LegiScan's codebook, 1969-sentinel dates)`
ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
