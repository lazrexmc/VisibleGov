### Task 4: `src/adapters/mo-senate-journal-pdf.js` — multi-vote journal parser + reconcile gate + resolution

**Files:**
- Create: `src/adapters/mo-senate-journal-pdf.js`, `tests/mo-senate-journal-pdf.test.js`

**Interfaces (Produces):**
```js
export class JournalParseError extends Error   // meta-carrying, mirrors RollCallParseError
export async function extractJournalText(pdfBuffer) -> string
export function parseJournalVotes(text) -> [{
  ordinal,            // 1-based order within the day (stable: the PDF is immutable)
  motion,             // verbatim motion sentence, e.g. 'On motion of Senator X, SS for SCS for SBs 894 & 921 ... was read the 3rd time and passed by the following vote:'
  bill_refs,          // mechanically extracted, normalized: ['SB 894', 'SB 921'] (first = primary)
  yeas, nays, absent, absentWithLeave,   // arrays of bare surnames as printed
  vacancies,          // number
  tallies             // { yeas: N, nays: N, absent: N|0 } — the printed —N per category
}]
export function resolveMoSenator(surname, roster) -> legislator_id | null
  // roster rows: { legislator_id, surname, mo_senate_id } — fail-loud like resolveMoRep
```

**Implementation notes (from the verified fixture format, research Q2):**
- `extractJournalText`: reuse `mo-rollcall-pdf.js`'s exact pdfjs-dist legacy-build pattern (Uint8Array conversion, sequential pages). The Senate journal is justified flowing text, not a grid — VERIFY against the real Day 37 fixture whether the coordinate-based row reconstruction or plain stream order is correct, and write down which in a comment (research flags this as needs-reverifying, not assumable).
- Vote blocks anchor on `by the following vote:` (covers 'passed by the following vote:', 'adopted by the following vote:', etc.); each block's categories are `YEAS—Senators`, `NAYS—Senators`, `Absent—Senators`, `Absent with leave—Senators`, `Vacancies—<N>`; a category's surname run terminates at the next category header; the last surname in a run carries `—<count>`. Categories can print `—None`. Em-dash vs hyphen: match what the extracted text ACTUALLY contains (check both `—` and `-`), assert from the fixture.
- Surnames may be hyphenated (`Chappelle-Nadal` is IN the real 2018 fixture — the House parser's known hyphen gap does NOT carry over; the surname token pattern must accept hyphens from day one).
- **Reconcile gate per category per block:** parsed surname count must equal that category's printed `—<count>` (Absent-with-leave and Vacancies have counts too where printed; reconcile every category that prints one) else `JournalParseError` naming the block ordinal and category. One bad block fails THAT block (typed, counted); other blocks in the same day still parse — return shape must make per-block failure recordable (throwing from parseJournalVotes kills the whole day; instead return `{ votes, failures }` — deviation from the single-vote House parser, justified: one day = many independent votes).
- `bill_refs`: from the motion text, match bill tokens `((?:SS|SCS|HS|HCS|CCS)\s+for\s+)*(SB|HB|SJR|HJR|SCR|HCR)s?\s*\d+(\s*&\s*\d+)*` and normalize each number to `'<TYPE> <NNN>'` (combined vehicles like 'SBs 894 & 921' expand to ['SB 894','SB 921']). Substitute prefixes (SS/SCS/...) are NOT part of the bill identifier — the motion string preserves them verbatim for traceability.
- Position mapping to `vote_casts.position`: yeas→`yea`, nays→`nay`, absent→`absent`, absentWithLeave→`absent` (it is an absence; the verbatim category survives in nothing — acceptable: position enum has no finer value, and the House maps `@`→absent identically). Vacancies are seats, never casts (House precedent).

- [ ] TDD against the REAL Day 37 fixture: assert 13 vote blocks parse (research-verified count); assert the SBs 894&921 block's bill_refs = ['SB 894','SB 921']; assert Onder appears in that block's yeas; assert every block's categories reconcile; assert a deliberately corrupted copy (drop one surname) yields a per-block failure naming the category, with the other 12 blocks still returned.
- [ ] Also test against the Task 1 second-year journal fixture (format stability across sessions — at minimum: block count > 0 and all blocks reconcile).
- [ ] `resolveMoSenator` tests: unique match → id; 0 matches → null; 2 same-surname rosters → null (no district disambiguation exists in journal text — that's WHY it must fail loud); case/whitespace-insensitive; hyphenated surname exact-match.
- [ ] Implement, green, commit `feat: mo-senate journal PDF parser - multi-vote blocks + reconcile gate`.


## CONTROLLER RULINGS (binding, appended)

1. ANCHOR WRAP (review-verified): the anchor phrase can wrap across a line break in extracted text ('passed by the following\nvote:') — the anchor regex must tolerate arbitrary whitespace incl. newlines within the phrase. Day-39 ground truth for your second-fixture test: exactly 11 YEAS blocks = 10 third-read passages + 1 emergency-clause adoption ('emergency clause ... adopted by the following vote' variant) — motion variants beyond 'passed' are real; capture them all, filter none.
2. DISTRICT SUFFIXES (fixture-verified in 2026): surname collisions print a district suffix in vote lists AND attendance rolls — 'Brown (16)' vs 'Brown (26)', 'Gregory (15)' vs 'Gregory (21)'. The surname token must accept an optional ' (NN)' suffix, carried as { surname, district } like the House's splitSurnameDistrict. resolveMoSenator gains the House's two-branch logic: suffix present → surname+district must match exactly one roster row; absent → unique-surname-only, else null. Tests: collision WITHOUT suffix → null (both 2018-style and hypothetical); collision WITH suffix → resolves; hyphenated surname (Chappelle-Nadal, real in the 2018 fixture) resolves.
3. Roster rows for resolveMoSenator come from Task 3's parsers: { legislator_id, surname, mo_senate_id } (mo_senate_id = district as text — match ' (NN)' suffixes against it).
4. extractJournalText: reuse the pdfjs legacy pattern; DECIDE empirically (against the real Day 37 fixture) whether coordinate-based row reconstruction or plain stream order is correct for these justified-text journals, and record which in a comment (Task 1's report notes run-on two-column artifacts in the ROSTER pdf; the journal may differ).
5. parseJournalVotes returns { votes, failures } (per-block typed failures; one corrupt block must not kill the other 12 — the plan's Task 4 section specifies the corruption test).
6. Do NOT create Task 5's CLI or touch db.js — parser + resolver only this task.
