# Completeness Floor: Corroborated Honest Yield — Design

**Date:** 2026-08-18 · **Status:** Approved direction (Lance, 2026-08-17 "proceed with recommendation"; design approved 2026-08-18 "proceed") · **Path:** brainstorm → spec → TDD with review

## Problem

The blind completeness checker's mechanical floor (`minKeyProvisionsFor` in `src/lib/verifier.js`,
commit df771db) scales the minimum required `key_provisions` count by bill text length: under
2,500 chars → 1; under 5,000 → 2; otherwise `MIN_KEY_PROVISIONS` (3). That fixed the wave-C
tiny-bill catch-22 (live proof: HR 3095, 2,873 chars, published 2026-08-17 with 2 provisions).

What remains broken is the **long-but-thin class**: bills whose raw text is ≥ 5,000 characters but
whose honest substantive yield is 1–2 provisions. The floor demands 3, the checker honestly
returns fewer, and `assessCompleteness` correctly refuses to trust the check → `malformed` →
unpublishable, forever. Known members (2026-08-17 evidence):

| Bill | Text length | Honest yield | Where it sits |
|---|---|---|---|
| SRES 377 | 7,597 | 1 | scheduler self-park (tick d744297c) |
| SRES 690 | 8,126 | 1 | scheduler self-park |
| SRES 520 | 12,904 | 1 | scheduler self-park |
| SRES 412 | 16,163 | 1 | scheduler self-park |
| HB 606 | 5,219 | 2 | drain PARKED (Malformed class) + seeded parked.json |
| HB 64 | 6,609 | 1 | drain PARKED (Malformed class) + seeded parked.json |
| SB 626 | 7,496 | 1 | drain PARKED (Malformed class) + seeded parked.json |
| HB 1607 | 11,703 | 2 | drain PARKED (Malformed class) + seeded parked.json |

(A ninth entry was investigated and excluded: HRES 1299, parked by the 2026-08-17 stopgap's
resolution-class lens, turns out to be 303,648 chars — a monster above the ~191k estimate-guard
line, permanently skipped at $0 regardless of this fix. Its park reason is falsified; the
rollout deletes the entry and lets the estimate guard do its documented job. It is not a member
of the long-but-thin class.)

Length is a falsified proxy for this class (SRES 412 failed at 16k chars; SRES 532 passed at 14k —
ceremonial "whereas" bulk hides single-provision substance), and the class includes regular MO
bills, not just resolutions. Scope ruling (Lance, 2026-08-18): the fix covers **both** classes —
no editorial exclusion of ceremonial resolutions.

## Design: corroborated honest yield

The floor stays. What changes: a phase-1 yield **below** the floor is no longer automatically
malformed — it becomes publishable **only** when a second, fully independent, blind phase-1
extraction mechanically corroborates that the bill is genuinely that thin. The gate never trusts
either self-report alone; it compares two independent reports using existing mechanical
disciplines (counts, and normalize-whitespace-then-substring section grounding). Sub-floor
publishes therefore require MORE evidence than at-floor publishes, never less.

### Trigger (producers)

After the standard phase-1 provisions call, the producer computes
`minKeyProvisionsFor(billText.length)`. If `1 ≤ key_provisions.length < floor`, the producer makes
ONE additional phase-1 call: same `buildProvisionsMessage(identifier, billText)`, a **fresh
conversation** (no memory of the first run, no summary, no phase 2), same blindness discipline.
Its output is carried in the envelope as `completeness_corroboration`. If the yield is at/above
the floor, no extra call is made and the envelope field is absent — the at-floor path is
byte-for-byte today's behavior.

The corroboration response is schema-bound to a narrowed shape (`key_provisions` only — same
items shape as `COMPLETENESS_SCHEMA.properties.key_provisions`, minItems 1, maxItems
`MAX_KEY_PROVISIONS`; no `coverage`). Export it from `verifier.js` as
`CORROBORATION_SCHEMA` so both producers share one definition.

Phase 2 (coverage) always runs against the PRIMARY list only. The corroborator's list is never
covered, never merged, never shown to any later stage — it exists solely for the gate's
comparison.

### The gate (`assessCompleteness`)

New signature: `assessCompleteness(completeness, bulletCount, billText, corroboration)` — still
pure, no I/O, never throws. Rules, in order:

1. Payload-shape, zero-provisions, and MAX-ceiling rules: unchanged. Zero primary provisions is
   malformed unconditionally — corroboration cannot rescue a vacuous check.
2. `minRequired = minKeyProvisionsFor(billText.length)` as today.
3. **At/above floor** (`minRequired ≤ count ≤ MAX_KEY_PROVISIONS`): identical behavior to today.
   A stray `corroboration` argument is ignored, not an error.
4. **Sub-floor** (`1 ≤ count < minRequired`): malformed unless ALL of the following hold, each
   failure producing its own specific reason string (the gate collects every failure found, per
   its existing full-diagnostic convention):
   - Corroboration present and shaped: an object whose `key_provisions` is a non-empty array of
     `{section, provision}` entries, length ≤ `MAX_KEY_PROVISIONS`. Missing/malformed →
     `sub-floor key_provisions (N < M) without a well-formed corroboration run — an
     uncorroborated thin check cannot support the receipt it would earn`. Empty →
     `corroboration lists zero provisions — a corroborator that finds none has not checked
     anything`.
   - **Count rule:** `corroboration.key_provisions.length ≤ primary count`. A corroborator that
     finds MORE provisions than the primary means the primary may have missed substance →
     `corroboration found K provisions but the primary check found N — the primary may have
     missed substance, so its coverage verdict cannot be trusted`.
   - **Grounding rule:** every corroborator `section` must appear in `billText` under the
     existing `collapseWhitespace`-then-substring discipline (identical to the primary's
     grounding check) → else `corroboration cites section "…" not found in the bill text — the
     corroborator invented it`.
   - **Overlap rule:** every corroborator provision's normalized `section` must match some
     primary provision's normalized `section`, where "match" is substring containment in either
     direction after `collapseWhitespace` → else `corroboration section "…" matches no primary
     provision's section — the two runs identified different substance`.
5. When rule 4 fully passes, the check is **corroborated**: evaluation proceeds through the
   existing structural checks (coverage cardinality, index rules, grounding) and the normal
   `complete` / `incomplete` decision against the primary list. Nothing downstream of the floor
   changes.

### Envelope, record CLI, and audit trail

- Envelope: optional top-level field `completeness_corroboration` beside `completeness` — shape
  `{ key_provisions: [{section, provision}, …] }`. All existing envelopes (absent field) remain
  valid: absent means "no corroboration run", which only matters sub-floor.
- `src/cli/summary-queue.js` (`classifyRecordItem` path, the gate's single consumer): pass
  `item.completeness_corroboration` as the 4th argument. No other record logic changes.
- Audit trail: when a publish (or flag) passed through the corroborated-thin path, the existing
  completeness support row's payload carries `corroborated_thin: true` plus the corroborator's
  `key_provisions`, so the receipt trail shows the higher evidence bar was met. Exact placement
  follows the existing support-row shape at implementation time (the plan pins it; no new table,
  no schema migration).

### Producers

**Billed chain (`src/lib/billed-summary-chain.js`):** a new conditional stage
`provisions-corroboration` immediately after `provisions`, run only on the sub-floor trigger.
Checkpointed exactly like every other paid stage (`saveCheckpoint`/`loadCheckpoint`, keyed by
bill_id + text hash + stage), so a crash never re-pays for it. `estimateBillCostUsd` is NOT
changed — the extra call is one small provisions-sized request, well inside the estimator's
existing 1.5× output padding and the sonnet-in ×3 input padding.

**Drain workflow (`.claude/workflows/summary-wave.js`):** the completeness phase gains one
conditional agent mirroring the same trigger: when the provisions agent's yield is sub-floor for
the bill's text length, dispatch a second, independent provisions agent (fresh context, same
phase-1 message discipline) and carry its output into the envelope's
`completeness_corroboration`. The workflow computes the trigger with the same exported
`minKeyProvisionsFor`.

### Explicit non-goals

- No operative-text/whereas-stripping heuristics; no per-format text preprocessing.
- No class-aware (identifier-based) floors.
- No change to: `minKeyProvisionsFor` thresholds, `MAX_KEY_PROVISIONS`, the zero-provision rule,
  the estimator, tick/weekly caps, or any publish gate outside the sub-floor branch.
- No database schema changes.

## Mechanical neutrality (PLAYBOOK_DELTA §2)

The rule is content-blind: it keys on provision counts and grounded section strings — never on
subject, sponsor, party, chamber, or outcome. It applies identically to every bill at every
length. Sub-floor bills face a strictly higher evidence bar (two independent blind extractions
plus mechanical agreement) than full-size bills (one). Receipts remain per-bullet and
per-provision, traceable to the official text, exactly as today.

## Rollout (after the code lands and the suite is green in a clean shell)

1. **Unpark the scheduler side:** delete from
   `.superpowers/artifacts/scheduled-summaries/parked.json` the 4 scheduler self-parks
   (SRES 377/690/520/412) and the mispremised HRES 1299 stopgap entry
   (source=tiny-bill-stopgap-2026-08-17; a 303k-char monster the estimate guard skips at $0 —
   its "thin class" park reason is false).
2. **Unpark the drain side:** remove HB 606, HB 64, SB 626, HB 1607 from the `PARKED` set in
   `scripts/build-drain-wave.mjs` with a dated note (their park class — the floor artifact — is
   repaired; every 3-strike/shifting-demands park STAYS). Delete the same four bills' seeded
   entries from `parked.json`, then re-run `scripts/seed-scheduler-parks.mjs` and confirm counts
   reconcile.
3. **Wave-C check:** verify the live state of the ~20 wave-C flagged tiny bills (flags predate
   df771db). Report findings; they are Lance-reviewable flags, not auto-retryable — no automatic
   action in this rollout.
4. **Re-attempts ride the normal lanes** — the daily scheduler's fresh lane picks the unparked
   bills up by its own ordering; no special runs, no manual ticks. Expected re-attempt cost:
   well under $1 total across coming ticks, inside existing caps.

## Testing (TDD; all tests written first, red, then green)

Unit — `assessCompleteness` (in the file and style where its existing tests live — the plan
names the exact path):
1. Sub-floor + corroboration equal count, overlapping grounded sections → proceeds to coverage;
   `complete` when covered (the happy path).
2. Sub-floor + corroborator finds fewer than the primary (primary 2, corroborator 1, sections
   overlapping) → corroborated.
3. Sub-floor + corroborator finds MORE → malformed, count-rule reason.
4. Sub-floor + corroborator section absent from bill text → malformed, grounding reason.
5. Sub-floor + corroborator section matching no primary section → malformed, overlap reason.
6. Sub-floor + corroboration absent / wrong shape / empty list → malformed, each with its
   distinct reason.
7. Zero primary provisions + perfect corroboration → still malformed (vacuous rule wins).
8. At-floor payload with a stray corroboration argument → byte-identical result to today's
   (regression: corroboration ignored).
9. At-floor and above-ceiling behaviors unchanged (existing tests keep passing untouched).

Chain — `billed-summary-chain`:
10. Sub-floor yield triggers exactly one corroboration call, checkpointed; envelope carries the
    field.
11. At-floor yield makes NO corroboration call; envelope lacks the field.
12. Checkpoint replay skips a completed corroboration stage (no double pay).

Workflow/record:
13. Record CLI passes the envelope field through to the gate (fixture-backed, no live DB).
14. Corroborated-thin publish writes the `corroborated_thin` audit marker in the support row.

Suite discipline: full `node --test` in a CLEAN shell (never `source .env` first — lesson 30);
gate any commit on the extracted fail count, never pipeline exit status (lesson 14).

## Success criteria

- The 8 known long-but-thin bills become attemptable and each either publishes or fails on real
  grounds (refutations, coverage) — never on the floor artifact.
- At-floor behavior provably unchanged (regression tests + untouched existing tests).
- Future thin arrivals flow through the same path unattended, at one extra provisions-sized call
  each, under existing caps.
