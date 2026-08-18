# Completeness Floor: Corroborated Honest Yield — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make honestly-thin bills (phase-1 yield below the length-scaled floor) publishable when — and only when — a second independent blind extraction mechanically corroborates the thinness.

**Architecture:** The gate (`assessCompleteness`, sole consumer `classifyRecordItem`) gains a sub-floor corroboration branch judged by pure mechanical rules (counts + grounded section strings). Two producers gather the corroboration payload: the billed chain adds a conditional checkpointed stage; the drain workflow adds a conditional agent. Rollout unparks the 8 known long-but-thin bills plus one mispremised park.

**Tech Stack:** Node 22 ESM, `node:test` + `node:assert/strict`, Anthropic SDK (streamed structured calls), Supabase JS (fixture-faked in tests).

**Spec:** `docs/superpowers/specs/2026-08-18-completeness-floor-corroboration-design.md` — the plan argues from it; read it first.

## Global Constraints

- Mechanical neutrality (PLAYBOOK_DELTA §2): rules key on counts and grounded strings only — never subject, sponsor, party, chamber, outcome.
- The at-/above-floor path must be **byte-identical** to today; a stray corroboration argument there is ignored, never an error.
- Zero primary provisions stays malformed unconditionally — corroboration cannot rescue a vacuous check.
- `assessCompleteness` stays pure: no I/O, never throws, collects EVERY failure reason found.
- No database schema changes; the audit marker rides inside the existing `summary_verifications` completeness row's `verdicts` JSON.
- Workflow scripts cannot `import` repo modules — any constant duplicated into `.claude/workflows/summary-wave.js` carries a sync comment naming `minKeyProvisionsFor`.
- Tests run in a CLEAN shell — never `source .env` first (PLAYBOOK lesson 30; it turns 2 correct tests red).
- Gate every commit on the extracted `# fail` count from `node --test` output, never on pipeline exit status (lesson 14).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: The gate — `CORROBORATION_SCHEMA` + sub-floor corroboration rules in `assessCompleteness`

**Files:**
- Modify: `src/lib/verifier.js` (schema export near `COMPLETENESS_SCHEMA` ~line 201; the sub-floor branch replaces the single floor check at lines 247–259)
- Test: `tests/completeness.test.js` (append after the existing `assessCompleteness` block)

**Interfaces:**
- Consumes: existing `collapseWhitespace`, `minKeyProvisionsFor`, `MAX_KEY_PROVISIONS`, `COMPLETENESS_SCHEMA`.
- Produces: `export const CORROBORATION_SCHEMA` (object schema, `key_provisions` only); `assessCompleteness(completeness, bulletCount, billText, corroboration)` — 4th parameter optional; unchanged return shape `{ overall, missing, reasons }`. Tasks 2–4 rely on these exact names.

- [ ] **Step 1: Write the failing tests** — append to `tests/completeness.test.js`. The file already imports `assessCompleteness`; extend the import with `CORROBORATION_SCHEMA`. Fixtures first:

```js
// ============================================================
// sub-floor corroboration (spec 2026-08-18): a yield below the length-scaled floor is
// publishable ONLY when a second independent blind extraction mechanically corroborates it
// ============================================================

// ≥5,000 chars → minKeyProvisionsFor floor of 3; the substance is one Resolved clause + one
// grant section, so honest yields of 1-2 are SUB-floor here.
const WHEREAS_PAD = 'Whereas the Congress has found further considerations worth weighing; '.repeat(80);
const LONG_THIN_TEXT = `${WHEREAS_PAD}Resolved, That the Senate designates the week. SEC. 2. Establishes a grant program.`;

function thinPayload(overrides = {}) {
  return {
    key_provisions: [{ section: 'Resolved,', provision: 'Designates the week.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'covered by bullet 0' }],
    ...overrides,
  };
}
const thinCorroboration = () => ({ key_provisions: [{ section: 'Resolved,', provision: 'Designates the week.' }] });

test('CORROBORATION_SCHEMA: key_provisions only, no coverage, additionalProperties false', () => {
  assert.deepEqual(CORROBORATION_SCHEMA.required, ['key_provisions']);
  assert.equal(CORROBORATION_SCHEMA.properties.coverage, undefined);
  assert.equal(CORROBORATION_SCHEMA.additionalProperties, false);
});

// spec test 1 — the happy path
test('assessCompleteness sub-floor: corroborated equal count + overlapping grounded sections -> complete', () => {
  const result = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, thinCorroboration());
  assert.deepEqual(result, { overall: 'complete', missing: [], reasons: [] });
});

// spec test 2 — corroborator finds fewer than the primary
test('assessCompleteness sub-floor: primary 2, corroborator 1 with overlapping section -> corroborated', () => {
  const payload = thinPayload({
    key_provisions: [
      { section: 'Resolved,', provision: 'Designates the week.' },
      { section: 'SEC. 2.', provision: 'Establishes a grant program.' },
    ],
    coverage: [
      { provision_index: 0, covered: true, bullet_index: 0, note: 'n' },
      { provision_index: 1, covered: true, bullet_index: 0, note: 'n' },
    ],
  });
  const result = assessCompleteness(payload, 1, LONG_THIN_TEXT, thinCorroboration());
  assert.equal(result.overall, 'complete');
});

// spec test 3 — corroborator finds MORE -> the primary may have missed substance
test('assessCompleteness sub-floor: corroborator finds more provisions than primary -> malformed', () => {
  const cor = { key_provisions: [
    { section: 'Resolved,', provision: 'Designates the week.' },
    { section: 'SEC. 2.', provision: 'Establishes a grant program.' },
  ] };
  const result = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, cor);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /primary may have missed substance/);
});

// spec test 4 — ungrounded corroborator section
test('assessCompleteness sub-floor: corroborator cites a section absent from the bill -> malformed', () => {
  const cor = { key_provisions: [{ section: 'SEC. 99.', provision: 'Invented.' }] };
  const result = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, cor);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /not found in the bill text/);
});

// spec test 5 — grounded but non-overlapping section
test('assessCompleteness sub-floor: corroborator section matches no primary section -> malformed', () => {
  const cor = { key_provisions: [{ section: 'SEC. 2.', provision: 'Establishes a grant program.' }] };
  const result = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, cor);
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /matches no primary provision/);
});

// spec test 6 — absent / wrong shape / empty, each with its distinct reason
test('assessCompleteness sub-floor: corroboration absent, malformed, or empty -> malformed with distinct reasons', () => {
  const absent = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT);
  assert.equal(absent.overall, 'malformed');
  assert.match(absent.reasons.join(' '), /without a well-formed corroboration run/);

  const wrongShape = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, { key_provisions: 'nope' });
  assert.equal(wrongShape.overall, 'malformed');
  assert.match(wrongShape.reasons.join(' '), /without a well-formed corroboration run/);

  const empty = assessCompleteness(thinPayload(), 1, LONG_THIN_TEXT, { key_provisions: [] });
  assert.equal(empty.overall, 'malformed');
  assert.match(empty.reasons.join(' '), /corroborator that finds none has not checked anything/);
});

// spec test 7 — the vacuous rule always wins
test('assessCompleteness: zero primary provisions + perfect corroboration -> still malformed', () => {
  const result = assessCompleteness({ key_provisions: [], coverage: [] }, 1, LONG_THIN_TEXT, thinCorroboration());
  assert.equal(result.overall, 'malformed');
  assert.match(result.reasons.join(' '), /zero key_provisions/);
});

// spec test 8 — at-floor path byte-identical; stray corroboration ignored
test('assessCompleteness at-floor: stray corroboration argument is ignored — result identical to the 3-arg call', () => {
  const withCor = assessCompleteness(goodPayload(), 3, BILL_TEXT, { key_provisions: [{ section: 'garbage', provision: 'garbage' }] });
  const withoutCor = assessCompleteness(goodPayload(), 3, BILL_TEXT);
  assert.deepEqual(withCor, withoutCor);
  assert.equal(withCor.overall, 'complete');
});

// spec test 9 (regression) — sub-floor corroborated but coverage incomplete -> incomplete, not complete
test('assessCompleteness sub-floor corroborated: uncovered provision still reads incomplete', () => {
  const payload = thinPayload({ coverage: [{ provision_index: 0, covered: false, bullet_index: null, note: 'missing' }] });
  const result = assessCompleteness(payload, 1, LONG_THIN_TEXT, thinCorroboration());
  assert.equal(result.overall, 'incomplete');
  assert.equal(result.missing.length, 1);
});
```

- [ ] **Step 2: Run the new tests, verify they fail**

Run (clean shell): `node --test tests/completeness.test.js 2>&1 | tail -15`
Expected: the new sub-floor tests FAIL (`overall` comes back `'malformed'` on the happy paths because the 4th argument doesn't exist yet); every pre-existing test still passes.

- [ ] **Step 3: Implement in `src/lib/verifier.js`.** Three edits.

(a) After the `COMPLETENESS_SCHEMA` definition (~line 201), add:

```js
// CORROBORATION_SCHEMA — the response shape for the independent sub-floor re-extraction
// (spec 2026-08-18): phase 1 only, no coverage. Both producers (billed chain, drain workflow)
// bind the corroboration call to this one definition.
export const CORROBORATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key_provisions'],
  properties: {
    key_provisions: {
      ...COMPLETENESS_SCHEMA.properties.key_provisions,
      description: 'Independent blind re-extraction of the key provisions, bill text only — used solely to corroborate a sub-floor primary check; never merged, never covered',
    },
  },
};
```

(b) Change the signature at line 238 to `export function assessCompleteness(completeness, bulletCount, billText, corroboration) {` and replace the single floor check (lines 252–259) with:

```js
  const minRequired = minKeyProvisionsFor(typeof billText === 'string' ? billText.length : NaN);
  if (keyProvisions.length > MAX_KEY_PROVISIONS) {
    return {
      overall: 'malformed',
      missing: [],
      reasons: [`key_provisions has ${keyProvisions.length} entries, outside the required ${minRequired}-${MAX_KEY_PROVISIONS} — the check does not meet the standard its verdict would claim`],
    };
  }
  if (keyProvisions.length < minRequired) {
    // Sub-floor (spec 2026-08-18): an honest thin yield is acceptable ONLY with independent
    // mechanical corroboration — two blind runs agreeing beats one, and the comparison below
    // never trusts either self-report alone. Failure here is malformed, exactly as the plain
    // floor breach was before.
    const corroborationReasons = assessCorroboration(keyProvisions, corroboration, billText, minRequired);
    if (corroborationReasons.length > 0) {
      return { overall: 'malformed', missing: [], reasons: corroborationReasons };
    }
  }
```

(c) Add the module-private helper directly above `assessCompleteness` (it uses `collapseWhitespace`, defined above it):

```js
// assessCorroboration — the sub-floor branch's mechanical comparison (spec 2026-08-18).
// Returns [] when the corroboration run confirms the primary's thinness; otherwise every
// failure reason found. Rules, all mechanical: present and shaped; non-empty; count <= the
// primary's count (more means the primary may have missed substance); every section grounded
// in the bill text (same collapse-then-substring discipline as the primary's own grounding);
// every section overlapping some primary section (containment either way after collapsing).
function assessCorroboration(primaryProvisions, corroboration, billText, minRequired) {
  const n = primaryProvisions.length;
  const cor = corroboration && Array.isArray(corroboration.key_provisions) ? corroboration.key_provisions : null;
  if (!cor) {
    return [`sub-floor key_provisions (${n} < ${minRequired}) without a well-formed corroboration run — an uncorroborated thin check cannot support the receipt it would earn`];
  }
  if (cor.length === 0) {
    return ['corroboration lists zero provisions — a corroborator that finds none has not checked anything'];
  }
  const reasons = [];
  if (cor.length > MAX_KEY_PROVISIONS) {
    reasons.push(`corroboration lists ${cor.length} provisions, above the ${MAX_KEY_PROVISIONS} ceiling — not a shape this gate accepts`);
  }
  if (cor.length > n) {
    reasons.push(`corroboration found ${cor.length} provisions but the primary check found ${n} — the primary may have missed substance, so its coverage verdict cannot be trusted`);
  }
  const normalizedBillText = collapseWhitespace(billText ?? '');
  const normalizedPrimarySections = primaryProvisions.map((p) => (p && typeof p.section === 'string' ? collapseWhitespace(p.section) : ''));
  cor.forEach((p) => {
    const section = p && p.section;
    const normalized = typeof section === 'string' ? collapseWhitespace(section) : '';
    if (normalized === '' || !normalizedBillText.includes(normalized)) {
      reasons.push(`corroboration cites section ${JSON.stringify(section ?? null)} not found in the bill text — the corroborator invented it`);
      return;
    }
    const overlaps = normalizedPrimarySections.some((ps) => ps !== '' && (ps.includes(normalized) || normalized.includes(ps)));
    if (!overlaps) {
      reasons.push(`corroboration section ${JSON.stringify(section)} matches no primary provision's section — the two runs identified different substance`);
    }
  });
  return reasons;
}
```

- [ ] **Step 4: Run the file's tests, verify all pass**

Run: `node --test tests/completeness.test.js 2>&1 | tail -5`
Expected: `# fail 0` (gate on that extracted count).

- [ ] **Step 5: Commit**

```bash
git add src/lib/verifier.js tests/completeness.test.js
git commit -m "feat(verifier): sub-floor corroborated-honest-yield branch in assessCompleteness + CORROBORATION_SCHEMA"
```

---

### Task 2: Record CLI — corroboration passthrough + `corroborated_thin` audit marker

**Files:**
- Modify: `src/cli/summary-queue.js` (the `assessCompleteness` call at ~line 625; the publish/flagDraft returns at ~lines 632–652; the completeness-row insert in `applyRecordDecision` at ~lines 737–743; the import list at ~line 10 gains `minKeyProvisionsFor`)
- Test: `tests/summary-queue-cli.test.js` (reuse its `baseItem`/`goodCompleteness`/`writeDecision` helpers — read them at ~lines 328–390 first)

**Interfaces:**
- Consumes: Task 1's 4-arg `assessCompleteness` and `minKeyProvisionsFor` from `../lib/verifier.js`.
- Produces: envelope items may carry optional `completeness_corroboration: { key_provisions: [...] }`; decisions carry `completenessCorroboration` (the payload or `null`) and `completenessCorroboratedThin` (boolean); the `kind:'completeness'` row's `verdicts` JSON gains `corroborated_thin: true` + `corroboration_key_provisions` exactly when the sub-floor path was used.

- [ ] **Step 1: Write the failing tests** — two tests appended to `tests/summary-queue-cli.test.js`, following the file's own fixture conventions:

```js
// ---- sub-floor corroboration passthrough (spec 2026-08-18) ----

// ≥5,000 chars so minKeyProvisionsFor demands 3; the item's honest yield is 1.
const THIN_PAD = 'Whereas further considerations were weighed by the chamber in question; '.repeat(75);
const THIN_TEXT = `${THIN_PAD}Resolved, That the week is designated. SEC. 1. Does X.`;

test('classifyRecordItem: sub-floor completeness WITH mechanical corroboration -> publish; WITHOUT -> MalformedSummaryError', () => {
  const thinCompleteness = {
    key_provisions: [{ section: 'Resolved,', provision: 'Designates the week.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'ok' }],
  };
  const corroboration = { key_provisions: [{ section: 'Resolved,', provision: 'Designates the week.' }] };
  const item = baseItem({ completeness: thinCompleteness, completeness_corroboration: corroboration });
  const decision = classifyRecordItem(item, { content: THIN_TEXT }, /* summaries */ []);
  assert.equal(decision.action, 'publish');
  assert.equal(decision.completenessCorroboratedThin, true);
  assert.deepEqual(decision.completenessCorroboration, corroboration);

  const uncorroborated = baseItem({ completeness: thinCompleteness });
  assert.throws(
    () => classifyRecordItem(uncorroborated, { content: THIN_TEXT }, []),
    /without a well-formed corroboration run/,
  );
});

test('applyRecordDecision: corroborated-thin publish writes corroborated_thin + corroboration_key_provisions into the completeness row', async () => {
  const completeness = {
    key_provisions: [{ section: 'SEC. 1.', provision: 'Does X.' }],
    coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'ok' }],
  };
  const corroboration = { key_provisions: [{ section: 'SEC. 1.', provision: 'Does X.' }] };
  const client = fakeRecordClient(); // whatever helper the neighboring applyRecordDecision tests construct — reuse it verbatim
  const result = await applyRecordDecision(client, 'run-1', writeDecision('publish', {
    completeness, completenessOverall: 'complete',
    completenessCorroboration: corroboration, completenessCorroboratedThin: true,
  }));
  assert.equal(result.outcome, 'published');
  const completenessRow = verInserts(client).find((c) => c.args[0].kind === 'completeness');
  assert.equal(completenessRow.args[0].verdicts.corroborated_thin, true);
  assert.deepEqual(completenessRow.args[0].verdicts.corroboration_key_provisions, corroboration.key_provisions);
  assert.deepEqual(completenessRow.args[0].verdicts.key_provisions, completeness.key_provisions);
});
```

The `fakeRecordClient()`/`verInserts()` names above stand for the file's ACTUAL helpers used by the neighboring `applyRecordDecision` tests at ~lines 705–743 — read those tests and reuse their exact client-faking calls; do not invent a parallel harness. The `classifyRecordItem` call signature must likewise be copied from that file's existing `classifyRecordItem` tests (argument order and any extra fixture args).

- [ ] **Step 2: Run to verify both fail** — `node --test tests/summary-queue-cli.test.js 2>&1 | tail -8`. Expected: first test throws `MalformedSummaryError` on the corroborated case (4th arg not passed yet); second fails on missing marker keys. Pre-existing tests all green.

- [ ] **Step 3: Implement in `src/cli/summary-queue.js`.**

(a) Import: add `minKeyProvisionsFor` to the existing `../lib/verifier.js` import at ~line 10.

(b) At ~line 625, pass the 4th argument and compute the marker once:

```js
  const completenessResult = assessCompleteness(item.completeness, summary.what_it_does.length, currentText.content, item.completeness_corroboration);
  // corroborated_thin marker (spec 2026-08-18): true exactly when the sub-floor branch is what
  // the gate exercised — i.e., the primary yield sits under the length-scaled floor AND the gate
  // did not malform. Derived here mechanically (never from the checker's self-report).
  const corroboratedThin = Array.isArray(item.completeness?.key_provisions)
    && item.completeness.key_provisions.length < minKeyProvisionsFor(currentText.content.length);
```

(c) Thread it into the three returns that already carry `completeness` (the `incomplete` flagDraft at ~634, the publish at ~646, the final flagDraft at ~650) — each gains two properties:

```js
      completenessCorroboration: item.completeness_corroboration ?? null,
      completenessCorroboratedThin: corroboratedThin,
```

(d) In `applyRecordDecision`'s completeness insert (~lines 737–743), build the verdicts payload conditionally:

```js
  if (decision.completeness) {
    // corroborated-thin publishes carry the corroborator's list in the SAME row (spec
    // 2026-08-18) — the receipt trail must show the higher evidence bar was met. Additive keys
    // only; readers of the existing shape are unaffected.
    const completenessVerdicts = decision.completenessCorroboratedThin
      ? { ...decision.completeness, corroborated_thin: true, corroboration_key_provisions: decision.completenessCorroboration.key_provisions }
      : decision.completeness;
    const { error: compErr } = await client.from('summary_verifications').insert({
      summary_id: summaryId, kind: 'completeness', verdicts: completenessVerdicts, overall: decision.completenessOverall,
      model: verifierModelLabel, prompt_version: COMPLETENESS_PROMPT_VERSION,
    });
    if (compErr) throw new Error(`summary_verifications (completeness) insert failed for bill ${identifier}: ${compErr.message}`);
  }
```

- [ ] **Step 4: Run the file's tests** — `node --test tests/summary-queue-cli.test.js 2>&1 | tail -5`. Expected `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/summary-queue.js tests/summary-queue-cli.test.js
git commit -m "feat(record): pass completeness_corroboration to the gate; corroborated_thin audit marker in the completeness row"
```

---

### Task 3: Billed chain — conditional checkpointed `provisions-corroboration` stage

**Files:**
- Modify: `src/lib/billed-summary-chain.js` (import at ~line 14 gains `minKeyProvisionsFor`; new block between the provisions stage ending ~line 177 and the coverage stage starting ~line 178; envelope at ~lines 190–202)
- Test: `tests/billed-summary-chain.test.js` (reuse its `fakeAnthropic`, `SUMMARY`, `VERIFY`, `PROVISIONS`, `COVERAGE`, `BILL` fixtures at lines 11–42)

**Interfaces:**
- Consumes: `minKeyProvisionsFor` from `./verifier.js`; existing `callStructured`, `apiProvisionsSchema`, `saveCheckpoint`, `GROUNDING_RULE`.
- Produces: envelopes with optional `completeness_corroboration: { key_provisions: [...] }`; checkpoint field `cp.provisionsCorroboration`; tracker label `provisions-corroboration:<identifier>`.

- [ ] **Step 1: Write the failing tests** — append to `tests/billed-summary-chain.test.js`:

```js
// ---- sub-floor corroboration stage (spec 2026-08-18) ----

const THIN_PROVISIONS = { key_provisions: [{ section: 'SEC. 1.', provision: 'Does X.' }] };
const THIN_COVERAGE = { coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'n' }] };
// ≥5,000 chars → floor 3, so a 1-provision yield is sub-floor and must trigger corroboration.
const LONG_TEXT = `${'W'.repeat(5200)} SEC. 1. Does X.`;

test('runBillChain: sub-floor provisions yield triggers ONE corroboration call, checkpointed, and the envelope carries the field', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([
    { json: SUMMARY }, { json: VERIFY }, { json: THIN_PROVISIONS },
    { json: THIN_PROVISIONS }, // the corroboration call's canned response
    { json: THIN_COVERAGE },
  ]);
  const tracker = createCostTracker();
  const { envelope } = await runBillChain(anthropic, tracker, {
    bill: BILL, text: LONG_TEXT, stageDir: dir, checkpointKey: 'b-1-thin0001',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(anthropic.calls.length, 5);
  assert.deepEqual(envelope.completeness_corroboration, { key_provisions: THIN_PROVISIONS.key_provisions });
  assert.ok(tracker.callLog.some((c) => c.label === 'provisions-corroboration:HB 1'));
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain: at-floor yield makes NO corroboration call and the envelope lacks the field', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([{ json: SUMMARY }, { json: VERIFY }, { json: PROVISIONS }, { json: COVERAGE }]);
  const tracker = createCostTracker();
  const { envelope } = await runBillChain(anthropic, tracker, {
    bill: BILL, text: 'Does X. SEC. 1. SEC. 2. SEC. 3.', stageDir: dir, checkpointKey: 'b-1-atfloor1',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(anthropic.calls.length, 4);
  assert.equal(envelope.completeness_corroboration, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain: checkpoint replay skips a completed corroboration stage — no double pay', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const first = fakeAnthropic([
    { json: SUMMARY }, { json: VERIFY }, { json: THIN_PROVISIONS }, { json: THIN_PROVISIONS }, { json: THIN_COVERAGE },
  ]);
  await runBillChain(first, createCostTracker(), {
    bill: BILL, text: LONG_TEXT, stageDir: dir, checkpointKey: 'b-1-replay01',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  const second = fakeAnthropic([]); // every stage checkpointed — a replay must make ZERO calls
  const { envelope } = await runBillChain(second, createCostTracker(), {
    bill: BILL, text: LONG_TEXT, stageDir: dir, checkpointKey: 'b-1-replay01',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(second.calls.length, 0);
  assert.deepEqual(envelope.completeness_corroboration, { key_provisions: THIN_PROVISIONS.key_provisions });
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify they fail** — `node --test tests/billed-summary-chain.test.js 2>&1 | tail -8`. Expected: test 1 fails on call count (4, not 5 — and the popped-in-order canned responses will have fed the corroboration JSON to coverage, another visible failure); tests observing `completeness_corroboration` fail on `undefined`.

- [ ] **Step 3: Implement.** Add `minKeyProvisionsFor` to the `./verifier.js` import at line 14. Between the provisions block (ends line 177) and the coverage block (line 178), insert:

```js
  // Sub-floor corroboration stage (spec 2026-08-18): a yield under the length-scaled floor gets
  // ONE independent blind re-extraction — same prompt, fresh call — and the gate accepts the thin
  // check only if the two runs mechanically agree. Conditional (rare; pennies) and checkpointed
  // like every paid stage; estimateBillCostUsd is deliberately NOT changed (one provisions-sized
  // call sits well inside its existing padding).
  if (cp.provisions.length >= 1 && cp.provisions.length < minKeyProvisionsFor(text.length) && !cp.provisionsCorroboration) {
    const cor = await callStructured(anthropic, tracker, {
      model: checkerModel, system: COMPLETENESS_SYSTEM_PROMPT,
      userContent: buildProvisionsMessage(bill.identifier, text) + GROUNDING_RULE,
      schema: {
        type: 'object', additionalProperties: false, required: ['key_provisions'], properties: { key_provisions: apiProvisionsSchema() },
      },
      maxTokens: 4000, label: `provisions-corroboration:${bill.identifier}`,
    });
    cp.provisionsCorroboration = cor.key_provisions;
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
```

And in the envelope object (after the `completeness:` line at ~197):

```js
      ...(cp.provisionsCorroboration ? { completeness_corroboration: { key_provisions: cp.provisionsCorroboration } } : {}),
```

- [ ] **Step 4: Run the file's tests** — `node --test tests/billed-summary-chain.test.js 2>&1 | tail -5`. Expected `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/billed-summary-chain.js tests/billed-summary-chain.test.js
git commit -m "feat(billed-chain): conditional checkpointed provisions-corroboration stage for sub-floor yields"
```

---

### Task 4: Drain workflow — conditional corroboration agent

**Files:**
- Modify: `.claude/workflows/summary-wave.js` (meta phase detail at line 5; new stage between stage 3 ending ~line 98 and stage 4 starting ~line 100; envelope assembly at ~line 122)

**Interfaces:**
- Consumes: the workflow's existing `PROVISIONS_SCHEMA` (lines 42–43), the stage-3 provisions agent's prompt construction (line ~96 — copy it exactly), `agent()` with `{ label, phase, model, schema }`.
- Produces: envelopes with optional `completeness_corroboration: { key_provisions: [...] }` — the exact field Task 2's record CLI consumes.

Workflow scripts run in the Workflow sandbox and CANNOT import repo modules, so the floor cannot be read from `verifier.js`. Rule used instead: **corroborate whenever the provisions yield is under 3** (the maximum possible floor). On genuinely small bills whose real floor is 1–2 this gathers a corroboration the gate then ignores (spec: at-floor stray corroboration is ignored) — a harmless extra $0 subagent call on this path. Carry this comment in the code:

```js
  // Corroborate below 3 = the MAX possible floor (verifier.js minKeyProvisionsFor: <2.5k chars
  // -> 1; <5k -> 2; else 3). The workflow cannot import verifier.js (sandbox), and on this $0
  // subagent path an occasionally-unneeded corroboration is free — the gate ignores a stray one
  // at-floor (spec 2026-08-18). KEEP IN SYNC with minKeyProvisionsFor's ceiling.
```

- [ ] **Step 1: Add the conditional stage.** After the stage-3 `.then((prov) => ({ ...acc, provisions: prov.key_provisions }))` (line 98) insert a new pipeline stage, copying the stage-3 prompt expression verbatim (same bill-text sourcing, same instructions) with only the label changed:

```js
  // Stage 3b: sub-floor corroboration — an INDEPENDENT second blind provisions extraction
  // (fresh agent = fresh context; independence by construction). See the sync comment above.
  (acc, bill) => {
    if (!acc || !acc.provisions || acc.provisions.length === 0 || acc.provisions.length >= 3) return acc;
    return agent(
      /* the stage-3 provisions prompt expression, copied verbatim from the stage above */,
      { label: `provisions-corroboration:${bill.identifier}`, phase: 'Summarize', model: 'sonnet', schema: PROVISIONS_SCHEMA }
    ).then((cor) => ({ ...acc, provisionsCorroboration: cor.key_provisions }));
  },
```

(The `/* copied verbatim */` placeholder above is resolved by copying line 96's actual template literal — it is long and lives in the file; duplicating it here in the plan risks drift. The implementer copies it character-for-character.)

- [ ] **Step 2: Extend the envelope assembly** at ~line 122:

```js
    if (acc.provisions && acc.coverage) envelope.completeness = { key_provisions: acc.provisions, coverage: acc.coverage }
    if (acc.provisionsCorroboration) envelope.completeness_corroboration = { key_provisions: acc.provisionsCorroboration }
```

- [ ] **Step 3: Update meta** — line 5's phase detail becomes `'per bill: opus author -> sonnet verify -> blind provisions (sub-floor corroborated) -> coverage'`.

- [ ] **Step 4: Verify syntax** — `node --check .claude/workflows/summary-wave.js`. Expected: no output, exit 0. (Documented deviation from the spec's test matrix: workflow scripts have no unit harness in this repo; verification is syntax check + the task reviewer's read + the first live drain wave.)

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/summary-wave.js
git commit -m "feat(drain-workflow): conditional independent corroboration agent for sub-floor provisions yields"
```

---

### Task 5: Rollout — unparks, wave-C verification, docs, full-suite gate

**Files:**
- Modify: `scripts/build-drain-wave.mjs` (remove 4 PARKED entries: lines 36, 38, 39, 44 — HB 606 `12288cfc-…`, HB 64 `10a0178e-…`, SB 626 `301ec8a7-…`, HB 1607 `1b19c5bb-…`)
- Modify: `.superpowers/artifacts/scheduled-summaries/parked.json` (local artifact, NOT committed — 9 deletions)
- Modify: `TODO.md` (the completeness-floor catch-22 entry → resolved), `CHATLOG.md` (rollout entry, inserted before the `- **Parens-binding gate fix (2026-08-10` marker line)

**Interfaces:** consumes Tasks 1–4 landed and green; produces the live system state the spec's rollout section describes.

- [ ] **Step 1: Full suite in a CLEAN shell first** (nothing rolls out on a red suite):

`node --test 2>&1 | tail -5` — gate on the `# fail` line reading `0`. NEVER `source .env` in this shell (lesson 30).

- [ ] **Step 2: Drain-side unpark.** In `scripts/build-drain-wave.mjs`, delete the four PARKED lines for HB 606, HB 64, SB 626, HB 1607, and add one comment line in their place:

```js
  // 2026-08-18: HB 606, HB 64, SB 626, HB 1607 UNPARKED — their park class (the fixed
  // MIN_KEY_PROVISIONS floor rejecting honest 1-2 provision yields on >=5k-char bills) is
  // repaired by the corroborated-honest-yield gate (spec 2026-08-18). Every 3-strike park stays.
```

- [ ] **Step 3: Scheduler-side unpark.** Delete 9 entries from `parked.json` — the 4 scheduler self-parks, the mispremised HRES 1299, and the 4 drain-seeded duplicates of Step 2's bills:

```bash
node -e "
const {readFileSync, writeFileSync} = require('node:fs');
const P = 'F:/VisibleGov/.superpowers/artifacts/scheduled-summaries/parked.json';
const ids = [
  '7b95714e-3d6e-438a-8fc2-7395b165f419', // SRES 377 (scheduler self-park)
  '8a3c33dc-8484-4540-9ff3-d4962395ca06', // SRES 690 (scheduler self-park)
  '87fabff0-1bf0-463a-b7dc-5643fc839ebb', // SRES 520 (scheduler self-park)
  'fc57f149-7e0d-4764-a5ab-2904931fbc04', // SRES 412 (scheduler self-park)
  '567658ab-cbcd-48df-8ae8-003b4e5f8729', // HRES 1299 (mispremised stopgap park; 303k-char monster — estimate guard owns it)
  '12288cfc-662c-4754-b539-a77a2b605945', // HB 606 (drain seed)
  '10a0178e-b4e4-4309-987b-7f937836f14b', // HB 64 (drain seed)
  '301ec8a7-3543-4881-8497-380c2179a57c', // SB 626 (drain seed)
  '1b19c5bb-80be-4a3c-9a4f-ae524a07a793', // HB 1607 (drain seed)
];
const parked = JSON.parse(readFileSync(P, 'utf8'));
let removed = 0;
for (const id of ids) { if (parked[id]) { delete parked[id]; removed++; } }
writeFileSync(P, JSON.stringify(parked, null, 2) + '\n');
console.log('removed', removed, 'remaining', Object.keys(parked).length);
"
```

Expected: `removed 9 remaining 23`.

- [ ] **Step 4: Reconcile the seed.** `node scripts/seed-scheduler-parks.mjs` — expected `parsed_from_source: 23, added: 0, total_in_parked_json: 23` (the 23 surviving drain parks, nothing re-added). If `added` is not 0, STOP: Step 2's PARKED edit and Step 3's deletions disagree — reconcile before continuing.

- [ ] **Step 5: Dry-run the scheduler** — `node --env-file=.env scripts/scheduled-summaries.js --dry-run` (this is the one scheduler mode agents may run). Confirm in its JSON: lane count grew by the unparked fresh-queue members and none of the 23 parked ids appear in `lanes`.

- [ ] **Step 6: Wave-C verification (report only — spec rollout item 3).** Query the live DB for flagged summaries on sub-2.5k-char bills (the wave-C class), report the count and identifiers in the task report and CHATLOG entry. No automatic action: they are Lance-reviewable flags.

```bash
node --env-file=.env -e "
import('@supabase/supabase-js').then(async ({createClient}) => {
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: flagged } = await c.from('summaries').select('bill_id, status').eq('status', 'flagged');
  const ids = (flagged ?? []).map((r) => r.bill_id);
  let tiny = 0; const sample = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data: texts } = await c.from('bill_texts').select('bill_id, content').in('bill_id', ids.slice(i, i + 50));
    for (const t of (texts ?? [])) if (t.content.length < 2500) { tiny++; if (sample.length < 25) sample.push(t.bill_id); }
  }
  console.log(JSON.stringify({ flagged_total: ids.length, flagged_tiny: tiny, sample }, null, 1));
});
"
```

- [ ] **Step 7: Docs.** TODO.md: mark the completeness-floor catch-22 entry resolved (strikethrough + `RESOLVED 2026-08-18` note naming this plan and the corroboration mechanism, matching the file's existing resolved-entry convention). CHATLOG.md: rollout entry (suite count, unpark numbers, wave-C findings) inserted before the `- **Parens-binding gate fix (2026-08-10, TDD, commit 92816ff):**` marker line.

- [ ] **Step 8: Final clean-shell suite + commit + push**

`node --test 2>&1 | tail -5` → `# fail 0`, then:

```bash
git add scripts/build-drain-wave.mjs TODO.md CHATLOG.md
git commit -m "feat(rollout): unpark the long-but-thin class — corroborated-honest-yield gate is live"
git push
```

---

## Verification when done

- `node --test` clean shell: `# fail 0`, suite magnitude unchanged-or-larger (~2,440+).
- The 8 spec-table bills are absent from every park list and present in the plan queue; tomorrow's 6 AM tick may attempt them under normal lane ordering — no manual ticks (the spec's rollout: re-attempts ride the normal lanes).
- At-floor regression: the pre-existing completeness tests pass untouched.
