# Audit log

## How this file works

**Append-only. Newest last. Nothing above is ever edited** - a verdict that changed gets a NEW
entry that quotes the old one, so the record shows what was believed and when. Dated audit
*reports* live under `docs/audits/`; this file is the standing ledger of their findings and where
each one now stands.

**Every finding carries one verdict:**

| Verdict | Meaning |
|---|---|
| **Open** | Real, unfixed, and nobody has decided not to fix it |
| **Mitigated** | Reduced but not closed; the mechanism that caused it still exists |
| **Fixed** | Closed, with evidence a stranger could re-run |
| **Accepted Risk** | Real, understood, and deliberately not being fixed - names who accepted it |
| **Obsolete** | The thing it was about no longer exists |

**Two rules this file exists to obey, both learned expensively here:**

1. **A verdict states its EVIDENCE CLASS, not just its value.** "Fixed (reported)" and "Fixed
   (re-verified today, by X)" are different claims and this file keeps them apart. A tidy column of
   "Fixed" that nobody re-checked is the shape of every stale document this project has had to
   correct - see `PLAYBOOK_DELTA.md` lessons 63-64.
2. **Verify by artifact, never by recollection.** A finding is not closed because a commit message
   says so.

**Entry template:**

```
## <date> - <report or trigger>, <N> findings
Source: docs/audits/<file>.md   (or: live check, peer report, incident)
### <ID> - <one-line finding>
**Verdict:** <Open|Mitigated|Fixed|Accepted Risk|Obsolete> - <evidence class>
<what it was, what changed, and how to re-check it>
```

---

## 2026-08-03 - Comprehensive accuracy audit, 16 findings (4 critical + 12 important)

Source: `docs/audits/2026-08-03-comprehensive-accuracy-audit.md`

**Verdict for the set: Fixed - REPORTED, not re-verified by this entry.** All four criticals and
the twelve important findings were recorded as fixed and verified live on the day. This log was
created 2026-09-05, five weeks later, and **did not re-run them.** The individual findings below
carry the report's own verdict; treat them as history until someone re-derives them.

- **C1 - SB 914: contradictory vote records, both counted.** Fixed (reported).
- **C2 - Two published glossary terms contradicted their own verification.** Fixed (reported).
- **C3 - Seven auto-published glossary terms contained corrupted text.** Fixed (reported).
- **C4 - Tommie Pierson Sr. and Jr. merged into one person.** Fixed (reported). The general form -
  a provider's record id is not an identity - became PLAYBOOK lesson 54.
- **I1-I12 - twelve important findings.** Fixed (reported).

**Also recorded, and it is the entry that should be hardest to lose:** a live credential
materialized in plaintext during this audit. Filed in the report as an incident rather than a
finding. **Verdict: Fixed (reported)** - and the standing rule it produced is in `CLAUDE.md`:
never commit secrets, and `.env` is the only place the connection string lives.

## 2026-08-03 - Senior engineering audit, 19 confirmed findings

Source: `docs/audits/2026-08-03-senior-engineering-audit.md`

**Verdict for the set: Fixed - REPORTED, not re-verified by this entry.** Same caveat as above.

The one worth restating because its mechanism recurred: **a bare `.select()` had silently truncated
the cross-adapter dedup backfill to 12% of its target.** Fixed at the time. The general form - a
call that succeeds while doing a fraction of the work - is the ancestor of PLAYBOOK 64.

Findings that did NOT survive adversarial review are listed in the report and are **Obsolete** by
construction: they were retracted before any fix was attempted, which is the process working.

## 2026-08-26 - System audit, 8 defects (D1-D8)

Source: `docs/audits/2026-08-26-system-audit.md`

### D1 - Same-source duplicate vote rows
**Verdict: Fixed - reported and marked RESOLVED in the report itself (2026-08-26).**

### D2 - Signal death on always-partial sources
**Verdict: Fixed - reported, and the mechanism is now guarded.** Became PLAYBOOK lesson 51: a
status word that never varies carries zero bits. `scripts/check-ingest-health.mjs` and
`src/lib/source-registry.js` exist because of this one.

### D3 - 382 reconciliation flags will not self-drain
**Verdict: Open - expectation correction, not a defect.** The report reframed this: the flags are
working as designed and need a deliberate resolution pass
(`scripts/resolve-matched-reconciliation-flags.mjs`, dry-run then `--apply` on Lance's go).
**Re-derive the live count with `npm run status` before quoting 382** - that number is from
2026-08-26 and is not maintained here.

### D4 - One phantom "currently serving" legislator
**Verdict: Open - visitor-visible, tiny.** Not re-checked by this entry.

### D5 - Summary coverage 23% - the product gap
**Verdict: Mitigated - RE-VERIFIED 2026-09-05 by `npm run status`.** Coverage of the accountability
set with text has moved **23% -> 33.7%** (1,046 of 3,108); total published summaries 1,401. The
mechanism is unchanged and the gap is still the product's largest: **2,036 bills remain READY**.
The lane that closes it is PAUSED by Lance's decision (`docs/EXPECTED_FAILURES.md` section 2).

### D6 - The 185 derived vote dates have no public receipt
**Verdict: Fixed - RE-VERIFIED 2026-09-05.** Migration `0035_expose_vote_date_provenance.sql`
exposes `vote_date_provenance` on both public views; `npm run verify:migrations` reports 40 probed,
30 applied, 0 MISSING, so 0035 is live. Each derived date now carries the dated, tallied action it
came from.

### D7 - One orphaned run row
**Verdict: Fixed - reported.** The general capability now exists as
`scripts/close-stranded-runs.mjs`, and `npm run check:ingest` scans for stranded runs on every
invocation, so a recurrence is detected rather than found by audit.

### D8 - Console error on the live site
**Verdict: Open - not re-checked by this entry.** Re-check needs a browser against
https://visiblegov.us; `curl` cannot see it.

---

## 2026-09-05 - Log created

Created on Lance's instruction as the cheapest of the outstanding no-API tasks, closing the gap
`CLAUDE.md` declared under "Owed under the standard, not yet built."

**What this log does NOT do, stated so the next reader does not over-trust it:** it did not re-run
the 2026-08-03 audits. Thirty-five findings are recorded here as *Fixed (reported)*, which is a
weaker claim than *Fixed (verified)*, and the file says so at each one rather than presenting a
uniform column of green. Three findings were re-verified today (D5, D6, and the migration state
behind it); three remain **Open** (D3, D4, D8).

---

## 2026-10-20 - session findings, 5 defects found and fixed outside any audit report

Source: live work during the $200-credit session. **Not an audit** - these surfaced while running
the billed lanes, which is worth recording because none of the three dated audits would have found
them: all five are behaviours visible only when money and schedulers are actually moving.

### S1 - A permanent exclusion fired on a stochastic failure
**Verdict: Fixed - RE-VERIFIED by test, 2026-10-20 (commit `2a8ee76`).**
`scheduled-summaries.js` parked bills forever on any `MalformedSummaryError`, including the
completeness checker mis-shaping its own output. One tick permanently discarded HB 594, HB 1909 and
SB 748. The bound two of them broke (`3-7 key_provisions`) is deleted from the schema the model
generates against, because the API rejects `minItems > 1`. `isStochasticRecordFailure` now gates it;
7 tests, including that an ABSENT `retryable` flag still parks. **4 bills await Lance's
`scripts/unpark-stochastic-parks.mjs --apply`** - deliberately not the 10 completeness-related parks
(four carry three exhausted attempts each; two are a different defect, S5). PLAYBOOK 69.

### S2 - `npm run status` could not run at all
**Verdict: Fixed - RE-VERIFIED 2026-10-20 (commit `6c4026b`).**
A syntax error shipped into `scripts/data-status.js`; the full suite reported 2,847 pass / 0 fail
because **no test imported it.** `tests/scripts-parse.test.js` now `node --check`s every script under
`scripts/`, `src/` and `tests/`. The finding generalises past the typo: a green suite is evidence only
about the code it loads, and the repo's most-reached-for instrument was its least-tested file
precisely because it only prints. PLAYBOOK 70.

### S3 - A 10-minute cooldown was the binding constraint on the glossary lane
**Verdict: Fixed - MEASURED before and after, 2026-10-20 (commit `71d826d`).**
Before: ~110 minutes to rule out 10 sections, 0 fetched. After: a full 958-candidate sweep with
**31 parks, all no-cooldown, 0 fallbacks**, ~5.2 hours of sleeping avoided, $0.00. PLAYBOOK 68.

### S4 - A status line overstated a human's queue by 2.2x
**Verdict: Fixed - RE-VERIFIED live, 2026-10-20 (commit `80c487a`).**
`flagged, awaiting Lance` read 1,356 against a real 619; the other 737 were clean terms awaiting a
free publish step. **The same function's own comment records fixing this once already** (870 vs 427).
Relabelled, and the authoritative split is now named rather than reimplemented. PLAYBOOK 73.

### S5 - Two bills fail on non-verbatim section strings - STILL OPEN
**Verdict: Open - triaged, not fixed, deliberately not bundled with S1.**
HJR 114 cites `"Section 7, Article IX, Constitution of Missouri"` and SJR 41 carries
`"1the state of Missouri"` - a glued-digit text-extraction artifact. This is bill-text quality, not
checker shape, so S1's reasoning does not cover them and one attempt each is not enough to classify
either. They remain parked. **The glued-digit class may affect more than one bill and nobody has
measured how many.**

### S6 - Parked-bill set is backed up but NOT restorable - STILL OPEN
**Verdict: Open - found by grep, 2026-10-20.**
`scripts/migrate-parked-to-ledger.mjs` copies parked.json -> `parked_bills`. **Nothing copies the
table back**, and the scheduler reads only the JSON. A rebuild recovers the set into a table nothing
consults while the scheduler re-attempts every parked bill at real cost - the failure migration 0039
was written to prevent, one step short of prevented. Recorded in `docs/DISASTER_RECOVERY.md`.

### Re-verification of an earlier finding
**D5 (summary coverage, the product gap) - still Mitigated, re-measured 2026-10-20.** 23% at the
2026-08-26 audit, 33.7% on 2026-09-05, **34.5% now** (1,427 of 3,108). 1,993 bills remain READY.
**The lane that closes it is the $0 subscription lane, not credits** - measured today, the billed
path costs $0.55/published against $0, so the $200 cannot buy this gap closed (~$1,100 would).
