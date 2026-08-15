# Scheduled Summaries (Autonomous Billed Pipeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/scheduled-summaries.js` — an OS-schedulable, budget-capped billed summary
runner (Haiku authors, Sonnet verifies/checks) that autonomously drains the summary backlog
through the existing trust-model-v3 gates, per the approved spec
`docs/superpowers/specs/2026-08-10-scheduled-summaries-design.md`.

**Architecture:** Extract the proven billed 4-stage chain out of `scripts/summary-probe-api.mjs`
into `src/lib/billed-summary-chain.js`; extract the proven DB-objections logic out of
`scripts/build-drain-wave.mjs` (committed 306ee11) into `src/lib/draft-objections.js`; then build
the scheduler script on top of both, reusing the ingest scheduler's exported lock functions and
the `openRun`/`closeRun` ledger. Every publish/flag decision stays with
`src/cli/summary-queue.js record`, spawned as a child CLI.

**Tech Stack:** Node ESM (`node --env-file=.env`), `@anthropic-ai/sdk` (streaming +
`output_config` json_schema), Supabase JS client, `node:test` with fake clients (zero live
API/DB calls in tests), Windows Task Scheduler (registration is Lance's manual step).

## Global Constraints

- `WEEKLY_CAP_USD = 5.00` and `PER_TICK_CAP_USD = 1.00` — constants in the script;
  env-overridable **DOWNWARD only** (an override can shrink spend, never grow it).
- Monster threshold: `> 100000` chars (`MONSTER_THRESHOLD_CHARS = 100000`); at most ONE monster
  per tick, only when remaining tick allowance `> 1.5 ×` worst observed per-bill cost this tick.
- `scripts/scheduled-ingest.js` is **never modified** (importing its exported helpers is fine —
  imports flow INTO the new script, nothing model-calling flows into the ingest scheduler).
- Zero schema changes. Zero migrations.
- The runner **never writes summary rows itself** — all writes go through spawning
  `src/cli/summary-queue.js record`. No gate is loosened.
- Billing/credit error class ends the tick immediately with `balance_depleted: true` and the log
  line `BALANCE DEPLETED — reload required`. **Never assume a credit reload.**
- Tests make **zero live API/DB calls** (fake Anthropic clients, fake Supabase clients — same
  discipline as `tests/scheduled-ingest.test.js`).
- Agents never run `schtasks` — registration is documented for Lance in the runbook only.
- Conventions: repo-root-relative paths computed from `import.meta.url` (never `process.cwd()`),
  one terminal `console.log(JSON.stringify(...))` line per CLI, stderr for progress,
  UTC-dated log files.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; on
  PowerShell, multi-line/quoted commit messages use `git commit -F <file>` (PLAYBOOK lesson 35).
- Run `node --test` in a clean shell (never `source .env` first — PLAYBOOK lesson 30).

---

### Task 1: `src/lib/billed-summary-chain.js` — extract the billed 4-stage chain

**Files:**
- Create: `src/lib/billed-summary-chain.js`
- Modify: `scripts/summary-probe-api.mjs` (import the lib; delete its local copies)
- Test: `tests/billed-summary-chain.test.js`

**Interfaces:**
- Consumes: `SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, MAX_OUTPUT_TOKENS` from
  `src/lib/summarizer.js`; `VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT, buildVerifyMessage,
  VERIFY_MAX_OUTPUT_TOKENS, COMPLETENESS_SCHEMA, COMPLETENESS_SYSTEM_PROMPT,
  buildProvisionsMessage, buildCoverageMessage, VERIFIER_MODEL` from `src/lib/verifier.js`.
- Produces (later tasks rely on these exact exports):
  - `PRICES` (object), `priceOf(model) -> {in, out}`
  - `createCostTracker() -> { record(model, usage, label), spentUsd(), callLog }`
  - `classifyBillingError(err) -> boolean`
  - `apiProvisionsSchema() -> jsonSchema` (COMPLETENESS key_provisions with minItems/maxItems stripped)
  - `loadCheckpoint(stageDir, key) -> object`, `saveCheckpoint(stageDir, key, data)`
  - `buildReAuthorMessage(identifier, title, text, priorSummary, objections) -> string`
  - `callStructured(anthropic, tracker, {model, system, userContent, schema, maxTokens, label}) -> parsedJson`
  - `runBillChain(anthropic, tracker, {bill, text, stageDir, checkpointKey, authorModel, checkerModel, reAuthor}) -> {envelope}`
    where `bill = {bill_id, identifier, title, bill_text_hash}`, `reAuthor` is `null` or
    `{priorSummary, objections}`, and `envelope = {bill_id, identifier, bill_text_hash, summary,
    verdicts, completeness, provenance: 'api', author_model, verifier_model}`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/billed-summary-chain.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PRICES, priceOf, createCostTracker, classifyBillingError, apiProvisionsSchema,
  loadCheckpoint, saveCheckpoint, buildReAuthorMessage, runBillChain,
} from '../src/lib/billed-summary-chain.js';

function fakeAnthropic(responsesByLabelOrder) {
  // Each call pops the next canned {json, usage} and returns a stream-like object whose
  // finalMessage() resolves to the SDK response shape callStructured/runBillChain consume.
  const calls = [];
  return {
    calls,
    messages: {
      stream(req) {
        const canned = responsesByLabelOrder.shift();
        calls.push(req);
        return {
          finalMessage: async () => ({
            usage: canned.usage ?? { input_tokens: 1000, output_tokens: 100 },
            stop_reason: canned.stop_reason ?? 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(canned.json) }],
          }),
        };
      },
    },
  };
}

const SUMMARY = {
  what_it_does: [{ point: 'Does X.', section: 'Sec. 1' }],
  stated_purpose: '',
  classification: 'other',
  referenced_terms: [],
};
const VERIFY = { verdicts: [{ bullet_index: 0, section: 'Sec. 1', supported: true, reason: 'ok', evidence_quote: 'Does X' }], overall: 'clean' };
const PROVISIONS = { key_provisions: [{ section: 'SEC. 1.', provision: 'Does X.' }, { section: 'SEC. 2.', provision: 'Does Y.' }, { section: 'SEC. 3.', provision: 'Does Z.' }] };
const COVERAGE = { coverage: [{ provision_index: 0, covered: true, bullet_index: 0, note: 'n' }, { provision_index: 1, covered: true, bullet_index: 0, note: 'n' }, { provision_index: 2, covered: true, bullet_index: 0, note: 'n' }] };
const BILL = { bill_id: 'b-1', identifier: 'HB 1', title: 'T', bill_text_hash: 'abcdef1234567890' };

test('cost tracker: prices real usage at the model\'s per-Mtok rates', () => {
  const t = createCostTracker();
  t.record('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'author:x');
  assert.equal(t.spentUsd(), PRICES['claude-haiku-4-5'].in + PRICES['claude-haiku-4-5'].out);
  assert.equal(t.callLog.length, 1);
  assert.equal(t.callLog[0].label, 'author:x');
});

test('priceOf throws for an unpriced model — never spends unpriced', () => {
  assert.throws(() => priceOf('claude-nonexistent'), /no price entry/);
});

test('classifyBillingError: credit-class 400s are billing, schema 400s are not', () => {
  assert.equal(classifyBillingError({ status: 400, message: 'Your credit balance is too low' }), true);
  assert.equal(classifyBillingError({ status: 402, message: 'billing issue' }), true);
  assert.equal(classifyBillingError({ status: 400, message: 'minItems values other than 0 or 1 are not supported' }), false);
  assert.equal(classifyBillingError({ status: 500, message: 'overloaded' }), false);
  assert.equal(classifyBillingError(new Error('plain')), false);
});

test('apiProvisionsSchema strips minItems/maxItems (API rejects them) and keeps items shape', () => {
  const s = apiProvisionsSchema();
  assert.equal(s.minItems, undefined);
  assert.equal(s.maxItems, undefined);
  assert.ok(s.items);
});

test('runBillChain: full 4-stage chain produces the record envelope', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([{ json: SUMMARY }, { json: VERIFY }, { json: PROVISIONS }, { json: COVERAGE }]);
  const tracker = createCostTracker();
  const { envelope } = await runBillChain(anthropic, tracker, {
    bill: BILL, text: 'Does X. SEC. 1. SEC. 2. SEC. 3.', stageDir: dir, checkpointKey: 'b-1-abcdef12',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(envelope.bill_id, 'b-1');
  assert.equal(envelope.provenance, 'api');
  assert.equal(envelope.author_model, 'claude-haiku-4-5');
  assert.equal(envelope.summary.what_it_does.length, 1);
  assert.equal(envelope.verdicts.length, 1);
  assert.equal(envelope.completeness.key_provisions.length, 3);
  assert.equal(anthropic.calls.length, 4);
  assert.ok(tracker.spentUsd() > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain: checkpoint resume never re-pays for a completed stage', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  saveCheckpoint(dir, 'b-1-abcdef12', { summary: SUMMARY, verify: VERIFY });
  const anthropic = fakeAnthropic([{ json: PROVISIONS }, { json: COVERAGE }]);
  const { envelope } = await runBillChain(anthropic, createCostTracker(), {
    bill: BILL, text: 't', stageDir: dir, checkpointKey: 'b-1-abcdef12',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
  });
  assert.equal(anthropic.calls.length, 2); // only provisions + coverage ran
  assert.equal(envelope.summary.what_it_does[0].point, 'Does X.');
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain with reAuthor: the author user message carries the prior draft and numbered objections', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([{ json: SUMMARY }, { json: VERIFY }, { json: PROVISIONS }, { json: COVERAGE }]);
  await runBillChain(anthropic, createCostTracker(), {
    bill: BILL, text: 't', stageDir: dir, checkpointKey: 'k',
    authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
    reAuthor: { priorSummary: SUMMARY, objections: ['fix A', 'fix B'] },
  });
  const authorMsg = anthropic.calls[0].messages[0].content;
  assert.match(authorMsg, /PRIOR DRAFT:/);
  assert.match(authorMsg, /1\. fix A/);
  assert.match(authorMsg, /2\. fix B/);
  rmSync(dir, { recursive: true, force: true });
});

test('runBillChain: author refusal/max_tokens surfaces as a thrown error (no envelope)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const anthropic = fakeAnthropic([{ json: {}, stop_reason: 'refusal' }]);
  await assert.rejects(
    () => runBillChain(anthropic, createCostTracker(), {
      bill: BILL, text: 't', stageDir: dir, checkpointKey: 'k2',
      authorModel: 'claude-haiku-4-5', checkerModel: 'claude-sonnet-5',
    }),
    /refused/,
  );
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (clean shell): `node --test tests/billed-summary-chain.test.js`
Expected: FAIL — `Cannot find module '../src/lib/billed-summary-chain.js'`

- [ ] **Step 3: Write the library** (extraction, not invention — every mechanism below is lifted
from `scripts/summary-probe-api.mjs` lines 28-171 with parameters replacing its globals)

```js
// src/lib/billed-summary-chain.js — the billed 4-stage trust-model-v3 chain (Haiku/Sonnet via
// the Anthropic API), extracted VERBATIM-in-mechanism from scripts/summary-probe-api.mjs (the
// $1.98 2026-08-09 campaign runner: $0.041/publish, zero credit errors in 288 calls) so the
// probe CLI and scripts/scheduled-summaries.js share one implementation. This module never
// touches the DB; envelopes go through src/cli/summary-queue.js record, whose mechanical gates
// own every publish/flag decision.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SUMMARY_SCHEMA, SYSTEM_PROMPT, buildUserMessage, MAX_OUTPUT_TOKENS,
} from './summarizer.js';
import {
  VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT, buildVerifyMessage, VERIFY_MAX_OUTPUT_TOKENS,
  COMPLETENESS_SCHEMA, COMPLETENESS_SYSTEM_PROMPT, buildProvisionsMessage, buildCoverageMessage,
  VERIFIER_MODEL,
} from './verifier.js';

export { VERIFIER_MODEL };

// USD per Mtok, interactive tier (same table the probe carried; keep in sync with Anthropic
// pricing — priceOf throws rather than spend unpriced).
export const PRICES = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-sonnet-5': { in: 2.0, out: 10.0 }, // intro pricing through 2026-08-31
  'claude-opus-5': { in: 5.0, out: 25.0 },
};

export function priceOf(model) {
  const p = PRICES[model];
  if (!p) throw new Error(`no price entry for model ${model} — add it before spending`);
  return p;
}

// createCostTracker — real-usage accounting shared by every call this chain makes. spentUsd()
// is the number budget guards trust; callLog is the per-call audit trail for run detail/logs.
export function createCostTracker() {
  let spent = 0;
  const callLog = [];
  return {
    record(model, usage, label) {
      const p = priceOf(model);
      const cost = (usage.input_tokens * p.in + usage.output_tokens * p.out) / 1e6;
      spent += cost;
      callLog.push({
        label, model, in: usage.input_tokens, out: usage.output_tokens, usd: Number(cost.toFixed(4)),
      });
      return cost;
    },
    spentUsd() { return spent; },
    callLog,
  };
}

// classifyBillingError — the spec's "billing/credit error class (HTTP 400/402 with
// credit-related message)". Anthropic SDK errors carry .status and .message; anything else
// (schema 400s, 5xx, plain Errors) is NOT billing and must not stop a whole tick.
export function classifyBillingError(err) {
  const status = Number(err?.status);
  if (status !== 400 && status !== 402) return false;
  const msg = String(err?.message ?? '');
  return /credit|billing|balance|purchase|payment/i.test(msg);
}

// The API's structured-output mode rejects array minItems > 1 (live-diagnosed 400). The 3-7
// provisions bound is enforced mechanically at the record gate anyway, so the API-facing schema
// strips only those two constraints.
export function apiProvisionsSchema() {
  const s = { ...COMPLETENESS_SCHEMA.properties.key_provisions };
  delete s.minItems;
  delete s.maxItems;
  return s;
}

// Per-stage checkpoints: every completed (paid) stage persists immediately; a re-run loads the
// checkpoint and never re-pays for a stage it already has. `key` is caller-chosen: the probe
// keeps its historical plain bill_id keys; the scheduler uses `${bill_id}-${hash8}` so a text
// revision invalidates the checkpoint (spec).
export function loadCheckpoint(stageDir, key) {
  const p = path.join(stageDir, `${key}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

export function saveCheckpoint(stageDir, key, data) {
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(path.join(stageDir, `${key}.json`), JSON.stringify(data), 'utf8');
}

// callStructured — one streamed, schema-constrained call with honest usage accounting.
// Streaming is mandatory: the SDK refuses non-streaming calls that could run >10 min (hit live
// on the first probe run).
export async function callStructured(anthropic, tracker, {
  model, system, userContent, schema, maxTokens, label,
}) {
  const stream = anthropic.messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: userContent }],
  });
  const response = await stream.finalMessage();
  tracker.record(model, response.usage, label);
  if (response.stop_reason === 'refusal') throw new Error(`${label}: model refused`);
  if (response.stop_reason === 'max_tokens') throw new Error(`${label}: hit max_tokens`);
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error(`${label}: no text content`);
  return JSON.parse(textBlock.text);
}

// buildReAuthorMessage — the conversion lane's author message: the standard authoring message
// plus the prior draft and the gates' numbered objections. Ported from the reAuthor branch of
// .claude/workflows/summary-wave.js (same framing, API-message form).
export function buildReAuthorMessage(identifier, title, text, priorSummary, objections) {
  return `${buildUserMessage(identifier, title ?? '', text)}

A PRIOR DRAFT of this summary exists (below) with SPECIFIC OBJECTIONS from the mechanical
verification gates. Author a corrected summary: keep what the text genuinely supports, fix every
objection. Never copy a prior claim without re-checking it against the text yourself.

PRIOR DRAFT:
${JSON.stringify(priorSummary)}

OBJECTIONS TO FIX (each MUST be resolved):
${objections.map((o, i) => `${i + 1}. ${o}`).join('\n')}

ADDITIONAL MECHANICAL RULES the code gates enforce:
- stated_purpose, when non-empty, must be a VERBATIM substring of the bill text (whitespace may collapse; words/characters may not change). If the bill's purpose language cannot be quoted verbatim, return "".
- Every field is SINGLE-LINE: no newline characters inside point/section/stated_purpose/term/citation_raw.
- Every \`section\` string you emit MUST appear VERBATIM as a substring of the bill text — never invent, normalize, or reformat a citation.`;
}

// The wave-2-hard-won grounding reinforcement appended to the provisions stage (its absence is
// exactly what the Haiku checkers tripped on).
const GROUNDING_RULE = '\n\nMECHANICAL GROUNDING RULE (a code gate rejects violations whole): every `section` string you emit MUST appear VERBATIM as a substring of the bill text — never invent, normalize, or reformat a citation (no "115.295(2)" unless the text prints exactly that; no dotted ranges the text does not print).';

// runBillChain — author → verify → blind provisions → coverage, checkpointed per stage.
// Returns the summary-queue record envelope. Throws on refusal/max_tokens/zero-bullets (caller
// decides skip-vs-stop; paid stages stay in the checkpoint either way).
export async function runBillChain(anthropic, tracker, {
  bill, text, stageDir, checkpointKey, authorModel, checkerModel, reAuthor = null,
}) {
  const cp = loadCheckpoint(stageDir, checkpointKey);
  if (!cp.summary) {
    const userContent = reAuthor
      ? buildReAuthorMessage(bill.identifier, bill.title, text, reAuthor.priorSummary, reAuthor.objections)
      : buildUserMessage(bill.identifier, bill.title ?? '', text);
    cp.summary = await callStructured(anthropic, tracker, {
      model: authorModel, system: SYSTEM_PROMPT, userContent, schema: SUMMARY_SCHEMA,
      maxTokens: MAX_OUTPUT_TOKENS, label: `${reAuthor ? 'reauthor' : 'author'}:${bill.identifier}`,
    });
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
  const summary = cp.summary;
  if (!summary.what_it_does || summary.what_it_does.length === 0) {
    throw new Error(`author produced zero bullets for ${bill.identifier}`);
  }
  const bulletsJson = JSON.stringify(summary.what_it_does);
  if (!cp.verify) {
    cp.verify = await callStructured(anthropic, tracker, {
      model: VERIFIER_MODEL, system: VERIFY_SYSTEM_PROMPT,
      userContent: buildVerifyMessage(bill.identifier, bulletsJson, text),
      schema: VERIFY_SCHEMA, maxTokens: VERIFY_MAX_OUTPUT_TOKENS, label: `verify:${bill.identifier}`,
    });
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
  if (!cp.provisions) {
    const prov = await callStructured(anthropic, tracker, {
      model: checkerModel, system: COMPLETENESS_SYSTEM_PROMPT,
      userContent: buildProvisionsMessage(bill.identifier, text) + GROUNDING_RULE,
      schema: {
        type: 'object', additionalProperties: false, required: ['key_provisions'], properties: { key_provisions: apiProvisionsSchema() },
      },
      maxTokens: 4000, label: `provisions:${bill.identifier}`,
    });
    cp.provisions = prov.key_provisions;
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
  if (!cp.coverage) {
    const cov = await callStructured(anthropic, tracker, {
      model: checkerModel, system: COMPLETENESS_SYSTEM_PROMPT,
      userContent: buildCoverageMessage(bill.identifier, JSON.stringify(cp.provisions), bulletsJson),
      schema: {
        type: 'object', additionalProperties: false, required: ['coverage'], properties: { coverage: COMPLETENESS_SCHEMA.properties.coverage },
      },
      maxTokens: 3000, label: `coverage:${bill.identifier}`,
    });
    cp.coverage = cov.coverage;
    saveCheckpoint(stageDir, checkpointKey, cp);
  }
  return {
    envelope: {
      bill_id: bill.bill_id,
      identifier: bill.identifier,
      bill_text_hash: bill.bill_text_hash,
      summary,
      verdicts: cp.verify.verdicts,
      completeness: { key_provisions: cp.provisions, coverage: cp.coverage },
      provenance: 'api',
      author_model: authorModel,
      verifier_model: VERIFIER_MODEL,
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/billed-summary-chain.test.js`
Expected: PASS (all 8)

- [ ] **Step 5: Refactor `scripts/summary-probe-api.mjs` onto the lib.** Replace its local
`PRICES`, `priceOf`, `call`, `API_PROVISIONS_ITEMS`, `loadCheckpoint`, `saveCheckpoint`, and the
per-bill 4-stage body with imports + one `runBillChain` call. Behavior identical: keep its arg
parsing, `--author-only` bank mode (that branch calls only the author stage: keep a direct
`callStructured` author call OR run `runBillChain` and break after summary — implement bank mode
as: load checkpoint, if `!cp.summary` do the author `callStructured` + save, then `continue`),
its `STAGE_DIR = '.superpowers/artifacts/wave3/api-stages'`, its plain `bill.bill_id` checkpoint
keys (existing checkpoints stay valid), its manifest input, its budget guard, its output files
and terminal JSON. The tracker replaces `spentUsd`/`callLog` globals:
`const tracker = createCostTracker();` and `tracker.spentUsd()` / `tracker.callLog` at the
call sites.

- [ ] **Step 6: Run the full suite** (clean shell): `node --test`
Expected: same pass count as before this task plus the 8 new tests, 0 fail.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/billed-summary-chain.js scripts/summary-probe-api.mjs tests/billed-summary-chain.test.js
git commit -m "feat(lib): extract billed 4-stage summary chain into src/lib/billed-summary-chain.js

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `src/lib/draft-objections.js` — DB-sourced objections as a tested library

**Files:**
- Create: `src/lib/draft-objections.js`
- Modify: `scripts/build-drain-wave.mjs` (import `parseBodyMd`/`computeObjections` from the lib;
  delete its local copies)
- Test: `tests/draft-objections.test.js`

**Interfaces:**
- Consumes: nothing project-internal (pure + injected Supabase client).
- Produces:
  - `parseBodyMd(md) -> {what_it_does: [{point, section}], stated_purpose}` (moved verbatim from
    `scripts/build-drain-wave.mjs`, including the balanced-paren section scan)
  - `computeObjections({verdicts, completeness, statedPurpose, text}) -> string[]` (moved verbatim)
  - `loadDraftObjections(client, {draftId, text}) -> {priorSummary, objections, hasVerifications}`

- [ ] **Step 1: Write the failing tests**

```js
// tests/draft-objections.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBodyMd, computeObjections, loadDraftObjections } from '../src/lib/draft-objections.js';

test('parseBodyMd inverts renderMarkdown, including parens inside points and sections', () => {
  const md = '**What it does:**\n- Changes the standard (a big one) to best value. (Sec. 2(a)(1))\n- Second point. (Section A)\n\n**Stated purpose (from the bill):** To do things.';
  const s = parseBodyMd(md);
  assert.equal(s.what_it_does.length, 2);
  assert.equal(s.what_it_does[0].point, 'Changes the standard (a big one) to best value.');
  assert.equal(s.what_it_does[0].section, 'Sec. 2(a)(1)');
  assert.equal(s.what_it_does[1].section, 'Section A');
  assert.equal(s.stated_purpose, 'To do things.');
});

test('computeObjections mirrors the record gates: refuted verdicts, coverage misses, ungrounded purpose', () => {
  const objections = computeObjections({
    verdicts: [
      { bullet_index: 0, section: 'Sec. 1', supported: true, reason: 'ok' },
      { bullet_index: 1, section: 'Sec. 2', supported: false, reason: 'nope' },
    ],
    completeness: {
      key_provisions: [{ section: 'SEC. 3.', provision: 'Adds Z.' }],
      coverage: [{ provision_index: 0, covered: false, bullet_index: null, note: '' }],
    },
    statedPurpose: 'never in the text',
    text: 'SEC. 1. SEC. 2. SEC. 3. Adds Z.',
  });
  assert.equal(objections.length, 3);
  assert.match(objections[0], /Bullet 1 \(cited Sec\. 2\) was REFUTED/);
  assert.match(objections[1], /OMITS a key provision.*\[SEC\. 3\.\] Adds Z\./);
  assert.match(objections[2], /stated_purpose is NOT a verbatim substring/);
});

function fakeClient({ bodyMd, verifications, notes }) {
  const from = (table) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      single: async () => ({ data: { id: 'd-1', body_md: bodyMd }, error: null }),
      then(resolve) { // awaited without .single(): the multi-row tables
        const data = table === 'summary_verifications' ? verifications : notes;
        resolve({ data, error: null });
      },
    };
    return chain;
  };
  return { from };
}

test('loadDraftObjections assembles prior summary + objections from DB rows and dedups the gate note', async () => {
  const client = fakeClient({
    bodyMd: '**What it does:**\n- Point one. (Sec. 1)',
    verifications: [
      { kind: 'support', verdicts: [{ bullet_index: 0, section: 'Sec. 1', supported: false, reason: 'bad' }] },
      { kind: 'completeness', verdicts: { key_provisions: [], coverage: [] } },
    ],
    notes: [
      { note: 'Bullet 0 (cited Sec. 1) was REFUTED by the verifier: bad', action: 'rejected' },
      { note: 'summary omits 1 key provision(s) present in the bill text: X (Y)', action: 'rejected' },
    ],
  });
  const out = await loadDraftObjections(client, { draftId: 'd-1', text: 'Sec. 1' });
  assert.equal(out.priorSummary.what_it_does.length, 1);
  assert.equal(out.hasVerifications, true);
  // the refuted verdict appears once (note dedup'd against it) + the distinct omit-note appears
  assert.equal(out.objections.filter((o) => /REFUTED/.test(o)).length, 1);
  assert.equal(out.objections.filter((o) => /omits 1 key provision/.test(o)).length, 1);
});

test('loadDraftObjections with zero verification rows reports hasVerifications:false', async () => {
  const client = fakeClient({ bodyMd: '**What it does:**\n- P. (S)', verifications: [], notes: [] });
  const out = await loadDraftObjections(client, { draftId: 'd-1', text: 'S' });
  assert.equal(out.hasVerifications, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/draft-objections.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the library.** Move `parseBodyMd` and `computeObjections` from
`scripts/build-drain-wave.mjs` character-for-character (they are already correct and
live-validated on all 103 DB-path drafts, 2026-08-15). Add:

```js
// loadDraftObjections — the conversion lane's evidence reader (spec: "Objections are read from
// the DATABASE, not wave artifacts"). Sources: (a) the draft's own summary_verifications rows —
// kind='support' refuted verdicts, kind='completeness' coverage misses; (b) the draft's
// body_md-derived stated_purpose checked against the hash-pinned text; (c) any summary_notes
// gate-reason rows, appended verbatim but deduplicated (whitespace-collapsed) against the
// objections already computed from (a)+(b).
const GATE_NOTE_RE = /^(summary omits |stated_purpose |verdicts\[\d+\] cites section )/;

export async function loadDraftObjections(client, { draftId, text }) {
  const { data: srow, error: sErr } = await client.from('summaries').select('id,body_md').eq('id', draftId).single();
  if (sErr) throw new Error(`summaries body_md lookup failed for ${draftId}: ${sErr.message}`);
  const { data: vrows, error: vErr } = await client.from('summary_verifications').select('kind,verdicts').eq('summary_id', draftId);
  if (vErr) throw new Error(`summary_verifications lookup failed for ${draftId}: ${vErr.message}`);
  const { data: nrows, error: nErr } = await client.from('summary_notes').select('note,action').eq('summary_id', draftId);
  if (nErr) throw new Error(`summary_notes lookup failed for ${draftId}: ${nErr.message}`);

  const byKind = {};
  for (const r of vrows ?? []) byKind[r.kind] = r.verdicts;
  const priorSummary = parseBodyMd(srow.body_md);
  const objections = computeObjections({
    verdicts: byKind.support,
    completeness: byKind.completeness,
    statedPurpose: priorSummary.stated_purpose,
    text,
  });
  const collapse = (s) => s.replace(/\s+/g, ' ').trim();
  const seen = new Set(objections.map(collapse));
  for (const nrow of nrows ?? []) {
    const note = String(nrow?.note ?? '');
    if (GATE_NOTE_RE.test(note) && !seen.has(collapse(note))) {
      objections.push(note);
      seen.add(collapse(note));
    }
  }
  return { priorSummary, objections, hasVerifications: Boolean(byKind.support || byKind.completeness) };
}
```

Then edit `scripts/build-drain-wave.mjs`: delete its local `parseBodyMd` and `computeObjections`,
add `import { parseBodyMd, computeObjections } from '../src/lib/draft-objections.js';` (its
`collapse` helper stays — the disk path still uses it for stated-purpose checks... note: after
the move, the disk path calls the imported `computeObjections`, so the local `collapse` is only
needed if still referenced; delete it if unused).

- [ ] **Step 4: Run tests + prove the drainer still works**

Run: `node --test tests/draft-objections.test.js` — PASS.
Run: `node --env-file=.env scripts/build-drain-wave.mjs libtest 3` — expect the same pool
numbers as the last build (`re-authorable drafts: <pool>` with `db <n>` unchanged), then delete
`.superpowers/artifacts/wave3/wave-libtest-args.json`.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/draft-objections.js scripts/build-drain-wave.mjs tests/draft-objections.test.js
git commit -m "feat(lib): draft-objections — DB-sourced re-author evidence as a tested library

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Scheduler pure core — budget math, week keys, lane ordering

**Files:**
- Create: `scripts/scheduled-summaries.js` (pure exported functions only in this task; `main()`
  comes in Task 4)
- Test: `tests/scheduled-summaries.test.js`

**Interfaces:**
- Produces (Task 4 and tests rely on these exact exports):
  - `WEEKLY_CAP_USD = 5.00`, `PER_TICK_CAP_USD = 1.00`, `MONSTER_THRESHOLD_CHARS = 100000`
  - `envCapUsd(envVar, defaultUsd) -> number` (downward-only override)
  - `currentWeekKey(date) -> '2026-W33'` (UTC ISO-8601 week)
  - `summarizeWeekSpend(rows, weekKey, perTickCapUsd) -> {spentUsd, crashedTicks}`
  - `tickAllowance({weeklyCapUsd, weeklySpentUsd, perTickCapUsd}) -> number`
  - `sortQueueRecencyFirst(queue, sessionStartByBill) -> queue'` (session DESC → passage → size ASC)
  - `computeDraftOnly(summaryRows) -> Map<billId, {draftRow, rejectedCount}>`
  - `assembleTick({freshQueue, conversions, monsters, parkedIds}) -> [{lane, item}...]`

- [ ] **Step 1: Write the failing tests**

```js
// tests/scheduled-summaries.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKLY_CAP_USD, PER_TICK_CAP_USD, MONSTER_THRESHOLD_CHARS, envCapUsd, currentWeekKey,
  summarizeWeekSpend, tickAllowance, sortQueueRecencyFirst, computeDraftOnly, assembleTick,
} from '../scripts/scheduled-summaries.js';

test('caps: constants match the spec', () => {
  assert.equal(WEEKLY_CAP_USD, 5.00);
  assert.equal(PER_TICK_CAP_USD, 1.00);
  assert.equal(MONSTER_THRESHOLD_CHARS, 100000);
});

test('envCapUsd: overrides can only shrink, never grow; junk is ignored', () => {
  process.env.TEST_CAP = '0.50';
  assert.equal(envCapUsd('TEST_CAP', 1.00), 0.50);
  process.env.TEST_CAP = '9.00';
  assert.equal(envCapUsd('TEST_CAP', 1.00), 1.00);
  process.env.TEST_CAP = 'banana';
  assert.equal(envCapUsd('TEST_CAP', 1.00), 1.00);
  delete process.env.TEST_CAP;
});

test('currentWeekKey: UTC ISO-8601 weeks, including year-boundary cases', () => {
  assert.equal(currentWeekKey(new Date('2026-08-15T12:00:00Z')), '2026-W33');
  assert.equal(currentWeekKey(new Date('2026-01-01T00:00:00Z')), '2026-W01');
  assert.equal(currentWeekKey(new Date('2027-01-01T00:00:00Z')), '2026-W53'); // Jan 1 2027 is a Friday of ISO week 53/2026
  assert.equal(currentWeekKey(new Date('2024-12-30T00:00:00Z')), '2025-W01'); // Monday belonging to next ISO year
});

test('summarizeWeekSpend: sums this week, ignores other weeks, counts crashed ticks at full allowance', () => {
  const rows = [
    { status: 'succeeded', detail: { week_key: '2026-W33', spent_usd: 0.40 } },
    { status: 'partial', detail: { week_key: '2026-W33', spent_usd: 0.25 } },
    { status: 'succeeded', detail: { week_key: '2026-W32', spent_usd: 0.90 } }, // other week
    { status: 'running', detail: {} }, // crashed/unclosed: conservative full-tick assumption
  ];
  const out = summarizeWeekSpend(rows, '2026-W33', 1.00);
  assert.equal(out.spentUsd, 0.40 + 0.25 + 1.00);
  assert.equal(out.crashedTicks, 1);
});

test('tickAllowance: min(weekly remaining, per-tick cap), floored at 0', () => {
  assert.equal(tickAllowance({ weeklyCapUsd: 5, weeklySpentUsd: 4.6, perTickCapUsd: 1 }), 0.4 === 0.4 ? Number((5 - 4.6).toFixed(10)) : 0.4);
  assert.equal(tickAllowance({ weeklyCapUsd: 5, weeklySpentUsd: 2, perTickCapUsd: 1 }), 1);
  assert.equal(tickAllowance({ weeklyCapUsd: 5, weeklySpentUsd: 6, perTickCapUsd: 1 }), 0);
});

test('sortQueueRecencyFirst: session DESC, then passage before other, then smallest first', () => {
  const queue = [
    { bill_id: 'a', priority: 'other', text_length: 100 },
    { bill_id: 'b', priority: 'passage', text_length: 900 },
    { bill_id: 'c', priority: 'other', text_length: 50 },
    { bill_id: 'd', priority: 'passage', text_length: 10 },
  ];
  const sessionStart = new Map([['a', '2026-01-01'], ['b', '2026-01-01'], ['c', '2025-01-01'], ['d', '2026-01-01']]);
  const sorted = sortQueueRecencyFirst(queue, sessionStart);
  assert.deepEqual(sorted.map((q) => q.bill_id), ['d', 'b', 'a', 'c']);
});

test('computeDraftOnly: draft-only bills with rejected-attempt counts; published bills excluded', () => {
  const rows = [
    { id: 's1', bill_id: 'x', status: 'draft', bill_text_hash: 'h1' },
    { id: 's2', bill_id: 'x', status: 'rejected', bill_text_hash: 'h1' },
    { id: 's3', bill_id: 'x', status: 'rejected', bill_text_hash: 'h1' },
    { id: 's4', bill_id: 'y', status: 'draft', bill_text_hash: 'h2' },
    { id: 's5', bill_id: 'z', status: 'draft', bill_text_hash: 'h3' },
    { id: 's6', bill_id: 'z', status: 'published', bill_text_hash: 'h3' },
  ];
  const m = computeDraftOnly(rows);
  assert.equal(m.get('x').rejectedCount, 2);
  assert.equal(m.get('x').draftRow.id, 's1');
  assert.equal(m.get('y').rejectedCount, 0);
  assert.equal(m.has('z'), false);
});

test('assembleTick: fresh → conversions → at most ONE monster; parked and ≥2-rejected conversions skipped', () => {
  const out = assembleTick({
    freshQueue: [{ bill_id: 'f1' }, { bill_id: 'f2' }],
    conversions: [
      { bill_id: 'c1', rejectedCount: 0 },
      { bill_id: 'c2', rejectedCount: 2 }, // spec: skip ≥2 prior rejected attempts
      { bill_id: 'c3', rejectedCount: 1 },
    ],
    monsters: [{ bill_id: 'm1' }, { bill_id: 'm2' }],
    parkedIds: new Set(['c3', 'f2']),
  });
  assert.deepEqual(out.map((e) => `${e.lane}:${e.item.bill_id}`), ['fresh:f1', 'conversion:c1', 'monster:m1']);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/scheduled-summaries.test.js` — FAIL
(module not found).

- [ ] **Step 3: Create `scripts/scheduled-summaries.js`** with a header comment mirroring
`scripts/scheduled-ingest.js`'s (billed-calls carve-out, cap discipline, lock, honesty) and the
pure functions:

```js
export const WEEKLY_CAP_USD = 5.00;
export const PER_TICK_CAP_USD = 1.00;
export const MONSTER_THRESHOLD_CHARS = 100000;

// Downward-only env override (spec: "env-overridable DOWNWARD only ... a typo can shrink spend,
// never grow it") — mirror of envIntervalMs's floor-only discipline, inverted.
export function envCapUsd(envVar, defaultUsd) {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, defaultUsd) : defaultUsd;
}

// UTC ISO-8601 week key ('2026-W33') — Thursday-anchored per ISO 8601.
export function currentWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Weekly spend from ingestion_runs rows (caller pre-filters to source='scheduled-summaries',
// last 10 days). A row stranded at status='running' (crashed tick that never closed) is counted
// AS IF it spent the full per-tick allowance — unknown spend is treated as spent (spec).
export function summarizeWeekSpend(rows, weekKey, perTickCapUsd) {
  let spentUsd = 0;
  let crashedTicks = 0;
  for (const row of rows ?? []) {
    if (row.status === 'running') {
      spentUsd += perTickCapUsd;
      crashedTicks += 1;
      continue;
    }
    if (row.detail?.week_key === weekKey) spentUsd += Number(row.detail?.spent_usd) || 0;
  }
  return { spentUsd, crashedTicks };
}

export function tickAllowance({ weeklyCapUsd, weeklySpentUsd, perTickCapUsd }) {
  return Math.max(0, Math.min(weeklyCapUsd - weeklySpentUsd, perTickCapUsd));
}

// Recency-first ordering, ported from scripts/export-summary-wave.mjs (session start DESC →
// passage priority → text_length ASC; stable for ties).
export function sortQueueRecencyFirst(queue, sessionStartByBill) {
  return [...queue].sort((a, b) => {
    const sa = sessionStartByBill.get(a.bill_id) ?? '';
    const sb = sessionStartByBill.get(b.bill_id) ?? '';
    if (sa !== sb) return sb.localeCompare(sa);
    if (a.priority !== b.priority) return a.priority === 'passage' ? -1 : 1;
    return (a.text_length ?? Infinity) - (b.text_length ?? Infinity);
  });
}

// Draft-only reduction (same convention scripts/build-drain-wave.mjs applies: any
// published/approved row disqualifies the bill; last draft row wins) plus a rejected-attempt
// count for the spec's "skip ≥2 prior superseded/rejected attempts" rule.
export function computeDraftOnly(summaryRows) {
  const byBill = new Map();
  for (const s of summaryRows ?? []) {
    const list = byBill.get(s.bill_id) ?? [];
    list.push(s);
    byBill.set(s.bill_id, list);
  }
  const out = new Map();
  for (const [billId, rows] of byBill) {
    if (rows.some((r) => r.status === 'published' || r.status === 'approved')) continue;
    const drafts = rows.filter((r) => r.status === 'draft');
    if (drafts.length === 0) continue;
    out.set(billId, {
      draftRow: drafts[drafts.length - 1],
      rejectedCount: rows.filter((r) => r.status === 'rejected').length,
    });
  }
  return out;
}

// Lane assembly (spec order): fresh first, then conversions, then AT MOST ONE monster.
// Parked bills and conversions with >=2 prior rejected attempts never enter the tick.
export function assembleTick({ freshQueue, conversions, monsters, parkedIds }) {
  const out = [];
  for (const item of freshQueue ?? []) {
    if (!parkedIds.has(item.bill_id)) out.push({ lane: 'fresh', item });
  }
  for (const item of conversions ?? []) {
    if (parkedIds.has(item.bill_id)) continue;
    if (item.rejectedCount >= 2) continue;
    out.push({ lane: 'conversion', item });
  }
  for (const item of monsters ?? []) {
    if (parkedIds.has(item.bill_id)) continue;
    out.push({ lane: 'monster', item });
    break; // at most one per tick
  }
  return out;
}
```

- [ ] **Step 4: Run tests** — `node --test tests/scheduled-summaries.test.js` — PASS.

- [ ] **Step 5: Commit**

```powershell
git add scripts/scheduled-summaries.js tests/scheduled-summaries.test.js
git commit -m "feat(scheduler): scheduled-summaries pure core — caps, ISO week ledger math, lanes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Scheduler `main()` — lock, ledger, queue, chain, record, log

**Files:**
- Modify: `scripts/scheduled-summaries.js` (add orchestration around Task 3's pure core)
- Test: extend `tests/scheduled-summaries.test.js`

**Interfaces:**
- Consumes: `acquireLock, releaseLock, updateLockMaxDuration, runChildCli` from
  `scripts/scheduled-ingest.js` (all exported, all path/parameter-injectable);
  `openRun, closeRun` from `src/lib/db.js`; `runBillChain, createCostTracker,
  classifyBillingError` from `src/lib/billed-summary-chain.js`; `loadDraftObjections` from
  `src/lib/draft-objections.js`; `MAX_TEXT_CHARS` from `src/lib/summarizer.js`.
- Produces: `runTick(deps) -> tickReport` (dependency-injected orchestrator, tested with fakes)
  and a thin `main()` guarded by `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`
  (same import-guard convention that lets tests import the module without running a tick).

Key mechanics (all inside `runTick`, each dependency injectable for tests):

1. **Paths/constants:** `LOCK_PATH = .superpowers/artifacts/summary-scheduler.lock.json`,
   `LOG_DIR = .superpowers/artifacts/summary-scheduler-logs/`, `STAGE_DIR =
   .superpowers/artifacts/scheduled-summaries/stages/`, `RECORDS_DIR =
   .superpowers/artifacts/scheduled-summaries/`, `PARKED_PATH = RECORDS_DIR + parked.json`,
   `TICK_MAX_DURATION_MS = 30 * 60 * 1000` (lock's declared duration — a tick is bounded by the
   per-tick budget, 30 min is generous headroom for ~25 streamed calls).
2. **Lock:** `acquireLock(LOCK_PATH, {maxRunDurationMs: TICK_MAX_DURATION_MS})`; not acquired →
   log `already running` and exit 0. `releaseLock(LOCK_PATH, nonce)` in `finally`.
3. **Budget:** rows = `ingestion_runs` where `source = 'scheduled-summaries'` and
   `started_at >= now - 10 days` (via `selectAll`); `summarizeWeekSpend(rows,
   currentWeekKey(), perTickCap)`; `allowance = tickAllowance(...)`; allowance below the
   worst-case floor (`WORST_BILL_FLOOR_USD = 0.05`) → log `budget exhausted for ${weekKey}`,
   exit 0 **without opening a run row** (a skipped tick spends nothing and must not pollute the
   ledger with zero-rows).
4. **Queue:** `runChildCli('src/cli/summary-queue.js', ['plan', '--dry-run'])` → parse
   `parsed.queue`; load sessions/bills maps (`selectAll(client, 'sessions', 'id,start_date')`,
   `selectAll(client, 'bills', 'id,session_id')`); `sortQueueRecencyFirst`. Split: fresh =
   `text_length <= MONSTER_THRESHOLD_CHARS`, monsters = the rest (planQueue already excluded
   `> MAX_TEXT_CHARS`). Conversions: `selectAll(client, 'summaries',
   'id,bill_id,bill_text_hash,status,created_at')` → `computeDraftOnly` → order by draftRow
   `created_at` ASC (oldest flag first). Parked: `JSON.parse(readFileSync(PARKED_PATH))` when
   present (`{bill_id: {reason, parked_at}}` object; `parkedIds = new Set(Object.keys(...))`).
5. **Per-bill loop** over `assembleTick(...)`:
   - Stop conditions checked BEFORE each bill: `tracker.spentUsd() >= allowance - worstBillUsd`
     → stop (budget guard); monster additionally requires
     `allowance - tracker.spentUsd() > 1.5 * worstBillUsd`.
   - Text: current `bill_texts` row for the bill (most recent `retrieved_at`, same reduction as
     `scripts/build-drain-wave.mjs`); hash mismatch vs. the queue/draft hash → skip, logged.
   - Fresh/monster: `runBillChain(anthropic, tracker, {bill, text, stageDir: STAGE_DIR,
     checkpointKey: `${bill_id}-${hash.slice(0,8)}`, authorModel: 'claude-haiku-4-5',
     checkerModel: 'claude-sonnet-5'})` → push envelope to `freshResults`.
   - Conversion: `loadDraftObjections(client, {draftId, text})`; `hasVerifications === false` or
     zero objections → skip (belongs to a re-verify lane, logged); else `runBillChain(...,
     {reAuthor: {priorSummary, objections}})` → push envelope to `conversionResults`.
   - Error handling per bill: `classifyBillingError(err)` → set `balanceDepleted = true`, log
     `BALANCE DEPLETED — reload required`, break the loop. Other errors → record in
     `skipped[{identifier, reason}]`, continue (checkpoints preserved the paid stages).
   - `worstBillUsd = Math.max(worstBillUsd, (tracker.spentUsd() - startSpend) * 1.5)` after each
     completed bill (probe convention).
6. **Record:** write `RECORDS_DIR/records-<runId>-fresh.json` (`{results: freshResults}`) and
   spawn `runChildCli('src/cli/summary-queue.js', ['record', '--file', <path>])`; write
   `RECORDS_DIR/records-<runId>-drafts.json` and spawn with `--replace-drafts`. Parse each CLI's
   terminal JSON: accumulate `published/flagged/rejected` from `counts`, and for every
   `failures[]` entry with `error === 'MalformedSummaryError'` add the bill to `parked.json`
   with `{reason: message, parked_at: iso}` (spec: the budget never re-pays a known-unpublishable
   bill). Record CLI failure (non-zero exit / unparseable): log it, keep the records files on
   disk (recovery property), continue to close.
7. **Close:** `closeRun(client, runId, status, detail)` where `status = balanceDepleted ?
   'partial' : (skipped.length ? 'partial' : 'succeeded')` and `detail = {week_key, spent_usd:
   Number(tracker.spentUsd().toFixed(4)), per_call_count: tracker.callLog.length, published,
   flagged, rejected, parked: parkedAdded.length, balance_depleted: balanceDepleted, lanes:
   {fresh: freshResults.length, conversion: conversionResults.length, monster: monsterCount},
   skipped}`. (`openRun` happens right AFTER the allowance check passes and BEFORE the first
   API call, so a crash mid-chain leaves a 'running' row the next tick counts conservatively.)
8. **Log:** append one UTC line to `LOG_DIR/<YYYY-MM-DD>.log`:
   `2026-08-15T12:00:00Z tick=<runId> attempted=<n> published=<n> flagged=<n> spent=$<x> week=<key> total=$<y>/<cap> [BALANCE DEPLETED]`.
9. **--dry-run:** everything through lane assembly runs; then print the tick plan JSON
   (`{allowance, weekKey, weeklySpent, lanes: [...ids]}`) and exit — no Anthropic client is even
   constructed, no run row, no record spawn.
10. **No `ANTHROPIC_API_KEY`** (and not `--dry-run`): log + terminal JSON
    `{error: 'ANTHROPIC_API_KEY not set'}`, exit 0 (an unattended tick must not look like a
    scheduler crash in Task Scheduler history).

- [ ] **Step 1: Write the failing tests** — `runTick` with everything faked. Add to
`tests/scheduled-summaries.test.js`:

```js
import { runTick } from '../scripts/scheduled-summaries.js';

function fakeDeps(overrides = {}) {
  const calls = { childCli: [], closed: [], logs: [], records: [] };
  return {
    calls,
    deps: {
      client: {},
      anthropic: {},
      now: () => new Date('2026-08-15T12:00:00Z'),
      acquireLockFn: () => ({ acquired: true, nonce: 'n1', reason: 'fresh' }),
      releaseLockFn: () => {},
      selectRecentRuns: async () => overrides.recentRuns ?? [],
      openRunFn: async () => 'run-1',
      closeRunFn: async (client, runId, status, detail) => { calls.closed.push({ runId, status, detail }); },
      runChildCliFn: (script, args) => {
        calls.childCli.push({ script, args });
        if (args[0] === 'plan') return { parsed: { queue: overrides.queue ?? [] } };
        return { parsed: overrides.recordResult ?? { counts: { published: 1, gated: 0, failures: 0 }, gated: [], failures: [] } };
      },
      loadSessionStartByBill: async () => overrides.sessionStart ?? new Map(),
      loadSummaryRows: async () => overrides.summaryRows ?? [],
      loadTextRow: async (billId) => (overrides.texts ?? {})[billId] ?? null,
      loadDraftObjectionsFn: async () => overrides.draftObjections ?? { priorSummary: { what_it_does: [{ point: 'p', section: 's' }], stated_purpose: '' }, objections: ['fix it'], hasVerifications: true },
      runBillChainFn: async (a, tracker, { bill }) => {
        tracker.record('claude-haiku-4-5', { input_tokens: 10000, output_tokens: 1000 }, `author:${bill.identifier}`);
        return { envelope: { bill_id: bill.bill_id, identifier: bill.identifier, bill_text_hash: bill.bill_text_hash, summary: {}, verdicts: [], completeness: {}, provenance: 'api', author_model: 'claude-haiku-4-5', verifier_model: 'claude-sonnet-5' } };
      },
      writeRecordsFile: (p, payload) => { calls.records.push({ p, payload }); },
      appendLog: (line) => { calls.logs.push(line); },
      readParked: () => overrides.parked ?? {},
      writeParked: () => {},
      dryRun: overrides.dryRun ?? false,
      ...overrides.deps,
    },
  };
}

test('runTick: budget-exhausted week opens NO run row and spends nothing', async () => {
  const { deps, calls } = fakeDeps({
    recentRuns: [{ status: 'succeeded', detail: { week_key: '2026-W33', spent_usd: 5.0 } }],
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'budget-exhausted');
  assert.equal(calls.closed.length, 0);
});

test('runTick: a fresh bill flows plan → chain → records file → record CLI → closed run with honest detail', async () => {
  const { deps, calls } = fakeDeps({
    queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }],
    texts: { f1: { content: 'text', content_hash: 'h1' } },
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'ok');
  assert.equal(calls.records.length, 1); // fresh records file only (no conversions this tick)
  assert.equal(calls.closed[0].status, 'succeeded');
  assert.equal(calls.closed[0].detail.week_key, '2026-W33');
  assert.ok(calls.closed[0].detail.spent_usd > 0);
  assert.equal(calls.closed[0].detail.lanes.fresh, 1);
});

test('runTick: billing error stops the tick, marks balance_depleted, logs BALANCE DEPLETED', async () => {
  const { deps, calls } = fakeDeps({
    queue: [
      { bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' },
      { bill_id: 'f2', identifier: 'HB 2', title: 'T', bill_text_hash: 'h2', text_length: 600, priority: 'other' },
    ],
    texts: { f1: { content: 't', content_hash: 'h1' }, f2: { content: 't', content_hash: 'h2' } },
    deps: {
      runBillChainFn: async () => { const e = new Error('Your credit balance is too low'); e.status = 400; throw e; },
    },
  });
  const report = await runTick(deps);
  assert.equal(report.balanceDepleted, true);
  assert.equal(calls.closed[0].detail.balance_depleted, true);
  assert.ok(calls.logs.some((l) => /BALANCE DEPLETED/.test(l)));
});

test('runTick: MalformedSummaryError from record parks the bill durably', async () => {
  const parkedWrites = [];
  const { deps } = fakeDeps({
    queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }],
    texts: { f1: { content: 't', content_hash: 'h1' } },
    recordResult: { counts: { published: 0 }, gated: [], failures: [{ bill_id: 'f1', error: 'MalformedSummaryError', message: 'checker floor' }] },
    deps: { writeParked: (obj) => parkedWrites.push(obj) },
  });
  await runTick(deps);
  assert.equal(parkedWrites.length, 1);
  assert.ok(parkedWrites[0].f1);
  assert.match(parkedWrites[0].f1.reason, /checker floor/);
});

test('runTick: dry-run assembles lanes but never opens a run, spends, or records', async () => {
  const { deps, calls } = fakeDeps({
    dryRun: true,
    queue: [{ bill_id: 'f1', identifier: 'HB 1', title: 'T', bill_text_hash: 'h1', text_length: 500, priority: 'other' }],
    texts: { f1: { content: 't', content_hash: 'h1' } },
  });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'dry-run');
  assert.equal(report.lanes.length, 1);
  assert.equal(calls.closed.length, 0);
  assert.equal(calls.records.length, 0);
});

test('runTick: lock not acquired exits quietly without touching anything', async () => {
  const { deps, calls } = fakeDeps({ deps: { acquireLockFn: () => ({ acquired: false, reason: 'already-running' }) } });
  const report = await runTick(deps);
  assert.equal(report.outcome, 'already-running');
  assert.equal(calls.closed.length, 0);
});
```

- [ ] **Step 2: Run to verify failure** — new tests FAIL (`runTick` not exported).

- [ ] **Step 3: Implement `runTick(deps)` + `main()`** following the mechanics list above.
`main()` wires the real dependencies: Supabase client from `src/lib/db.js`'s `getClient()`, a
lazily-constructed `new Anthropic()` (only when not dry-run and lanes are non-empty), the real
lock functions imported from `scripts/scheduled-ingest.js` bound to `LOCK_PATH`,
`selectAll`-based loaders, `runChildCli`, real fs read/write/append helpers, and
`envCapUsd('SUMMARY_WEEKLY_CAP_USD', WEEKLY_CAP_USD)` / `envCapUsd('SUMMARY_TICK_CAP_USD',
PER_TICK_CAP_USD)`. Terminal line: `console.log(JSON.stringify(report))`.

- [ ] **Step 4: Run tests** — `node --test tests/scheduled-summaries.test.js` — PASS (all).

- [ ] **Step 5: Live smoke of the $0 paths only** (no key needed):
`node --env-file=.env scripts/scheduled-summaries.js --dry-run`
Expected: JSON tick plan with real allowance ($1.00), real week key, and real lane counts
(fresh from the live plan queue, conversions from the live draft pile, ≤1 monster). No run row
(verify: `ingestion_runs` has no `scheduled-summaries` row), no artifacts written.

- [ ] **Step 6: Commit**

```powershell
git add scripts/scheduled-summaries.js tests/scheduled-summaries.test.js
git commit -m "feat(scheduler): scheduled-summaries tick orchestration — lock, ledger, 3 lanes, record, honest log

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `scripts/data-status.js` — scheduler freshness block + lesson-36 gauge fix

**Files:**
- Modify: `scripts/data-status.js:70` (gauge), plus the report/print sections around lines
  134-227

**Interfaces:**
- Consumes: `currentWeekKey, summarizeWeekSpend, WEEKLY_CAP_USD, PER_TICK_CAP_USD` from
  `scripts/scheduled-summaries.js`.

- [ ] **Step 1: Gauge fix (PLAYBOOK lesson 36).** Replace the
`count('summaries?status=neq.published&select=id')` at line 70 with TWO counts:
`count('summaries?status=eq.draft&select=id')` and
`count('summaries?status=eq.rejected&select=id')`. Update the destructuring, the `report.review`
block (`summariesAwaitingReview` now the draft count; add `summariesRetired`), and the printed
line to:

```js
console.log(`  summaries draft/flagged .............. ${n(sumDraft)}  <- held back by the trust gate`);
console.log(`  summaries retired (superseded) ....... ${n(sumRejected)}  <- replaced by later attempts, audit trail`);
```

- [ ] **Step 2: Scheduler freshness block.** After the existing `INGESTION FRESHNESS` section,
add a `SUMMARY SCHEDULER` section: query
`ingestion_runs?source=eq.scheduled-summaries&order=started_at.desc&limit=20` (the script's
existing `rows()` helper), compute `currentWeekKey()` + `summarizeWeekSpend(rows, weekKey,
PER_TICK_CAP_USD)`, and print: last tick time + status, `spent this week $X of $5.00`,
`published this week` (sum of `detail.published` for this week's rows), and the parked count
from `.superpowers/artifacts/scheduled-summaries/parked.json` when the file exists. When no
rows exist at all print `  (never ran)` — the pre-registration state.

- [ ] **Step 3: Verify live** — `node --env-file=.env scripts/data-status.js` shows: draft count
~matching the live `draft` status count, retirees separate, and `(never ran)` for the scheduler.

- [ ] **Step 4: Commit**

```powershell
git add scripts/data-status.js
git commit -m "feat(status): summary-scheduler freshness block; fix lesson-36 draft gauge (eq.draft + retirees)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs + policy carve-out

**Files:**
- Create: `docs/SCHEDULED_SUMMARIES.md`
- Modify: `CLAUDE.md` (standing policies), `README.md` (one-line pointer), `TODO.md` (RESUME
  HERE), `CHATLOG.md` (build entry)

- [ ] **Step 1: Write `docs/SCHEDULED_SUMMARIES.md`** in the shape of
`docs/SCHEDULED_INGESTION.md`: what it is (one billed tick a day through the v3 gates), the
Task Scheduler registration command **for Lance to run himself** (`schtasks /create /tn
"VisibleGov Scheduled Summaries" /tr "\"C:\Program Files\nodejs\node.exe\" --env-file=.env
scripts\scheduled-summaries.js" /sc daily /st 06:00` with "Start in" = repo root; agents never
run schtasks), the budget model ($5/ISO-week, $1/tick, downward-only env overrides
`SUMMARY_WEEKLY_CAP_USD`/`SUMMARY_TICK_CAP_USD`), reading the log
(`.superpowers/artifacts/summary-scheduler-logs/`), what `BALANCE DEPLETED — reload required`
means (ticks keep running $0 parts and re-probe with the first call; nothing to clean up),
unparking a bill (delete its key from
`.superpowers/artifacts/scheduled-summaries/parked.json`), dry-run usage, and the recovery
properties (checkpoints, lock reclaim, conservative crashed-tick ledger assumption).

- [ ] **Step 2: `CLAUDE.md` carve-out** — add to the standing policies block, verbatim per spec:

> `scripts/scheduled-summaries.js` runs billed calls unattended under a code-enforced
> $5.00/ISO-week cap (Lance, 2026-08-10; built 2026-08-15); this ledger+cap IS the per-run
> approval for this runner only. Every other billed call still requires explicit per-run
> approval.

- [ ] **Step 3: `README.md`** — one line under the scripts/automation section pointing at
`docs/SCHEDULED_SUMMARIES.md`. **`TODO.md` RESUME HERE** — replace the "autonomy build parked"
item with "scheduled-summaries BUILT (2026-08-15), awaiting Lance: load credits + register the
task per docs/SCHEDULED_SUMMARIES.md". **`CHATLOG.md`** — build entry (what shipped, test
counts, the not-yet-registered state).

- [ ] **Step 4: Commit**

```powershell
git add docs/SCHEDULED_SUMMARIES.md CLAUDE.md README.md TODO.md CHATLOG.md
git commit -m "docs: scheduled-summaries runbook + billed-call carve-out; autonomy build shipped (unregistered)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Full-suite gate + push

- [ ] **Step 1:** Clean shell: `node --test` — extract the literal `fail N` line; commit gate is
`fail 0` (never a pipeline exit status — PLAYBOOK lesson 14).
- [ ] **Step 2:** `git push`. Update memory (`no-api-spend-hold.md`: the carve-out exists but is
inert until credits + registration; billed path otherwise still CLOSED).

## Self-Review (done at write time)

- **Spec coverage:** engine/budget/scope → Tasks 1/3/4; non-negotiables → Global Constraints +
  Task 4 mechanics (record CLI owns writes; ingest scheduler untouched — only imported); ledger →
  Task 3/4 (week_key, crashed-tick assumption); lanes incl. conversion detail → Tasks 2/4;
  failure honesty (per-bill checkpoint retention, billing class, record-CLI failure, structural
  parks) → Tasks 1/4; monitoring + gauge fix → Task 5; policy/docs → Task 6; components list →
  Tasks 1-6 one-to-one; success criteria 3's kill-safety → checkpoints (Task 1) + conservative
  ledger (Task 3) + lock reclaim (reused, Task 4).
- **Placeholder scan:** clean — every step carries real code or exact edit instructions.
- **Type consistency:** `runBillChain(anthropic, tracker, {...})` matches Tasks 1/4;
  `loadDraftObjections(client, {draftId, text})` matches Tasks 2/4; `summarizeWeekSpend(rows,
  weekKey, perTickCapUsd)` matches Tasks 3/5.
- **Known judgment calls encoded:** budget-exhausted ticks write no run row (zero-spend ticks
  must not dilute the 10-day ledger window); `openRun` sits after the allowance check and before
  the first paid call so crashed ticks are counted conservatively; probe keeps its historical
  checkpoint keys while the scheduler uses hash-scoped keys.
