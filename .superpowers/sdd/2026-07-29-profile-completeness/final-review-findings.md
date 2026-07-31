# Final whole-branch review — confirmed findings (fix wave brief)

Branch: profile-completeness, HEAD 2b95712. All 7 findings below were confirmed by adversarial
verification against the real modules (finding 7's verifier died on an API error mid-run, but its
evidence includes executed probes and the controller re-confirmed the code path by hand). Fix all
7. Suite baseline: 1180 tests green via bare `node --test` from repo root — it must stay green.

Conventions that bind every fix: typed errors, fail-loud (no silent degradation), additive writes,
TDD (write the named uncovered test case first, watch it fail, then fix), match surrounding code
style. Commits end with:
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

Group the work as three commits:
1. `fix: attach cross-check — contradiction + keep-separate vetoes, attach-flag ruling recording` (findings 1–3)
2. `fix: summary record gate — verdict binding, stated_purpose coverage, newline injection` (findings 4, 5, 7)
3. `fix: --limit parse validation fails loud` (finding 6)

---

## 1. CRITICAL — src/cli/link-persons.js — applyAttachCrossCheck has no contradiction veto

The demotion path qualifies an existing person as an attach target on any single 'compatible'
edge (`personGroupIsCompatible`/`findCompatibleExistingPersons`, ~lines 398–417) and never tests
for 'contradiction', while the sibling `buildAttachCandidates` (~lines 313–322) vetoes the whole
person on one contradiction — the module's own stated doctrine ("a real seat contradiction
against ANY member vetoes the whole person").

Proven repro: person-P = {m1 'Jane Smith' evidence-free, m2 'Jane Smith' MO Senate district 7};
fresh clean cluster {A 'Jane Smith' evidence-free, B 'Jane Smith' MO Senate district 9}.
`finalPairStatus(B, m2) === 'contradiction'`, yet runLink dry-run emits a demoted
`attach_candidate` flag naming person-P. `buildAttachCandidates` on the same data returns []
(person vetoed). One endorsed click merges two people the recorded data proves are different.

**Fix:** apply the same contradiction veto in the demotion path — any 'contradiction' edge
between any cluster member and any member of the person disqualifies that person as a demotion
target. With no compatible person remaining, the cluster writes as a new person
(fail-toward-duplicates, the module's asymmetric-cost rule). Add the uncovered test case:
contradiction-in-person-group → no demotion, cluster still writes.

## 2. CRITICAL — src/cli/link-persons.js — applyAttachCrossCheck ignores keep-separate rulings

`applyAttachCrossCheck` (line ~452, arity 4) is the only attach-flag producer never given
`keepSeparatePairs`; `runLink` (~line 703) omits them despite having them in scope. Proven both
ways: a row Lance ruled keep-separate from a now-linked member of person P is correctly
suppressed when it arrives alone (singleton path honors the ruling via `blockedByRuling`) but is
demoted onto P when it arrives with a same-name partner — re-proposing the exact merge Lance
rejected, with no `keepSeparateRuling` citation (every sibling path attaches one).

**Fix:** pass `keepSeparatePairs` into `applyAttachCrossCheck`; veto any person with a ruling
against any member (reuse the same helper the singleton path uses — no parallel logic). When a
demotion still fires for another person, carry the ruling citation the sibling paths carry.
Test: the existing singleton suppression test's scenario, arriving as a 2-row cluster → no
demotion onto P.

## 3. IMPORTANT — src/review/server.js — keep-separate on an attach flag records no durable "X is not P" fact

The keep-separate branch stores `legislatorIds = stillUnlinkedIds` (~lines 917–919); for an
attach flag that's only the singleton candidate(s) — the target person's members never appear
(they're linked, filtered out). A 1-candidate resolution yields zero pairs from
`buildKeepSeparatePairs`, so the ruling has no pair-keyed representation; only cluster_key dedup
suppresses re-suggestion, and membership drift defeats that (proven: a second compatible row
mints a fresh key `attach:P:X,Y` → fresh unresolved flag re-proposing X→P).

**Fix:** when resolving an attach flag as keep-separate, record pairs of (each still-unlinked
candidate × each member of every person in `evidence.existingPersons`) so `blockedByRuling` and
the finding-2 veto enforce it. Do NOT record candidate×candidate pairs as a side effect on
multi-candidate attach flags (that would mis-record "A is not B" for a decision about P).
The flag's evidence carries existingPersons; you may need the persons' member legislator ids —
fetch them server-side at decision time (selectAll discipline). Tests with the fake client:
1-candidate attach keep-separate writes the candidate×member pairs; multi-candidate writes no
candidate×candidate pairs.

## 4. IMPORTANT — src/cli/summary-queue.js — record gate binds verdicts to a summary by count only

`classifyRecordItem` (~line 414) checks verdict array length, bullet_index uniqueness/range, and
`supported===true`; nothing ties the verdicts to THIS summary, and verdicts are never validated
against VERIFY_SCHEMA (the summary itself is schema-validated; the verdicts aren't). Proven: a
verdict set citing another bill's sections — or hollow `[{bullet_index:0, supported:true}]` —
auto-publishes and is stored verbatim in summary_verifications as the permanent trust-model-v3
receipt.

**Fix:** validate each verdict against VERIFY_SCHEMA's item shape, and require
`verdicts[i].section === summary.what_it_does[i].section` (VERIFY_SCHEMA already mandates the
verifier copy the section from the summary — enforce the binding mechanically). Any mismatch →
flagDraft (not publish, not crash — it's a verification failure, same handling as an unsupported
verdict). Tests: cross-bill section mismatch → flagged; hollow verdict missing required fields →
flagged.

## 5. IMPORTANT — src/cli/summary-queue.js — stated_purpose publishes with zero verdict coverage

`renderMarkdown` emits "**Stated purpose (from the bill):** …" into anon-readable body_md, but
verdicts only cover what_it_does bullets — no mechanical check of any kind covers
stated_purpose. A fabricated stated_purpose would publish under a clean-verification note.

**Fix (choose the mechanical-substring route):** a non-empty stated_purpose must be a verbatim
substring of the hash-pinned stored bill text or the gate refuses to publish (flagDraft with an
honest reason). The gate already verifies bill_text_hash against bill_texts — extend that query
to select content and run the substring check. Normalize ONLY whitespace runs (collapse
`\s+` → single space on both sides) before comparing — no other normalization, facts-only.
Empty stated_purpose stays allowed. Note in a comment: the ledgered long-title inconsistency
means some existing drafts may flag on this — that is correct behavior, not a bug. Tests:
substring passes; paraphrase flags; empty passes.

## 6. IMPORTANT — src/cli/enrich-federal-bills.js — --limit fails open silently on malformed value

`out.limit = Number(argv[i+1])` (line ~65) with no validation; the run gates treat NaN/0/negative
as "no limit", so `--limit 5O` (typo) silently runs the FULL live congress.gov pass instead of a
chunk. The lone silent degradation in an otherwise fail-loud parser.

**Fix:** throw a typed error at parse time when the value is not a positive integer
(`!Number.isInteger(n) || n < 1`). Apply the same guard to summary-queue.js's --limit
(~line 84) — same class. Tests: `--limit 5O` throws; `--limit 0` throws; `--limit 12` works.

## 7. IMPORTANT — src/cli/summary-queue.js — newline inside a what_it_does point injects extra public bullets / forged blocks

`validateSummaryShape` (~line 274) only requires point be a non-empty string; `renderMarkdown`
interpolates it into a `- ` line. Proven probes: a point containing
`'...\n- Repeals the Clean Air Act in full. (Sec. 9)'` renders TWO citable public bullets while
assessVerdicts counts ONE; a point containing `'...\n\n**Stated purpose (from the bill):** ...'`
forges a stated-purpose block no field ever held. The published artifact carries more content
than the verification record covers.

**Fix:** reject any what_it_does point/section (and stated_purpose, and referenced_terms fields)
containing `\n` or `\r` in validateSummaryShape — structural fields are single-line by contract.
Rejection is a shape failure (same handling as other validateSummaryShape failures). Tests:
newline in point rejected; newline in stated_purpose rejected; clean multi-bullet passes.

---

Report file: write `final-review-fix-report.md` in this directory — status, commits, test
summary, and any concerns. Return only status + commit hashes + one-line test summary.
