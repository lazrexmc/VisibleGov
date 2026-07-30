import { readFileSync } from 'node:fs';
import {
  getClient, openRun, closeRun, selectAll,
} from '../lib/db.js';
import {
  MODEL, PROMPT_VERSION, MAX_TEXT_CHARS, SUMMARY_SCHEMA, renderMarkdown,
} from '../lib/summarizer.js';
import {
  VERIFIER_MODEL, VERIFY_PROMPT_VERSION, assessVerdicts,
} from '../lib/verifier.js';
import { nextStatus, mapNoteAction } from '../review/server.js';
import { persistReferencedTermsGracefully } from './summarize.js';

// summary-queue — Task 5 of the profile-completeness plan
// (.superpowers/sdd/2026-07-29-profile-completeness/task-5-brief.md). The CODE half of the $0
// subagent summarization system: a priority-queue planner (`plan`) and a mechanical-gate result
// writer (`record`). This file makes NO model calls, ever, and needs no ANTHROPIC_API_KEY — the
// controller session runs the actual opus-author/sonnet-verifier subagents OUTSIDE this code
// (Claude Code subagent dispatch, not a billed Anthropic API call) and feeds their output back in
// through `record`. That split is the whole point: the trust chain's mechanical parts (schema
// shape, completeness derivation, hash-provenance, auto-publish eligibility) live in code where a
// review can attack them; only the authoring/adversarial-verification judgment calls are
// delegated to subagents.

// ---- typed errors (record mode's pre-write rejection vocabulary) ----

// A record item that cannot even be considered: bad envelope (missing bill_id/bill_text_hash),
// a summary JSON that doesn't match SUMMARY_SCHEMA's shape (mechanically re-checked — the
// orchestrator's subagent output is NEVER trusted just because it claims to follow the schema),
// or a well-shaped summary with a bullet that cites no section. None of these ever reach a DB
// write — the item is rejected whole, honestly counted, and left for the controller to redo.
export class MalformedSummaryError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'MalformedSummaryError';
    Object.assign(this, meta);
  }
}

// The record item's bill_text_hash does not match the CURRENTLY stored bill_texts row for that
// bill. This is the load-bearing check that stops a subagent's summary from being recorded
// against text it never actually saw (stale text handed to it, or a fabricated hash) — the
// orchestrator must have summarized the REAL stored text, mechanically re-verified here rather
// than trusted from the input.
export class TextHashMismatchError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'TextHashMismatchError';
    Object.assign(this, meta);
  }
}

// No bill_texts row at all exists for this bill — plan mode's own `noText` exclusion should have
// kept this bill out of the queue in the first place, but record mode re-checks independently
// (never trusts that the item it was handed actually came from THIS code's own plan output) and
// refuses the same way it refuses a hash mismatch.
export class MissingBillTextError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'MissingBillTextError';
    Object.assign(this, meta);
  }
}

const RECORD_FAILURE_TYPES = [MalformedSummaryError, TextHashMismatchError, MissingBillTextError];
function isTypedFailure(err) {
  return RECORD_FAILURE_TYPES.some((T) => err instanceof T);
}

// ---- CLI arg parsing ----

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'plan' && mode !== 'record') {
    throw new Error(`unknown mode: ${mode ?? '(none)'} — expected 'plan' or 'record'`);
  }
  const out = {
    mode, dryRun: false, limit: null, file: null, bill: null,
  };
  let i = 0;
  while (i < rest.length) {
    const key = rest[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    if (key === '--limit') { out.limit = Number(rest[i + 1]); i += 2; continue; }
    if (key === '--file') { out.file = rest[i + 1]; i += 2; continue; }
    if (key === '--bill') { out.bill = rest[i + 1]; i += 2; continue; }
    throw new Error(`unknown flag: ${key}`);
  }
  if (mode === 'record' && !out.file) throw new Error('record mode requires --file <path>');
  return out;
}

// ============================================================
// `plan` mode: prioritized worklist, pure planning + DB reads only
// ============================================================

// Passage/third-reading votes are the priority signal the plan doc names explicitly: a bill that
// has actually been voted on for final passage is the one readers most want explained first.
// Everything else (procedural motions, amendment votes, committee votes) sorts after.
export const PASSAGE_QUESTION_RE = /passage|third reading/i;

export function isPassageVote(question) {
  return PASSAGE_QUESTION_RE.test(String(question ?? ''));
}

// Mirrors summarize.js's planWork's own ALREADY_SUMMARIZED_STATUSES set exactly (draft/approved/
// published — 'rejected' deliberately excluded so a rejected summary is honestly re-eligible,
// same rationale as that file's own comment: Lance's rejection means "redo the prose," not "never
// touch this bill again").
const ALREADY_SUMMARIZED_STATUSES = new Set(['draft', 'approved', 'published']);

// pickCurrentTextRow: the "current" bill text for a bill is the most-recently-retrieved
// bill_texts row (a bill can accumulate rows across multiple text-version types over time) — same
// reduction rule summarize.js's loadCurrentState and review/server.js's pickBillText both apply,
// factored out here since record mode needs the SAME "what is current right now" answer
// independent of any hash a caller supplies.
export function pickCurrentTextRow(rows) {
  if (!rows || rows.length === 0) return null;
  return rows.reduce((latest, r) => (
    !latest || (r.retrieved_at ?? '') > (latest.retrieved_at ?? '') ? r : latest
  ), null);
}

// planQueue: pure priority/exclusion logic, no I/O — the same exhaustive-partition style as
// gloss.js's planGlossing / auto-publish-glossary.js's planAutoPublish. Inputs:
//   bills:     {id, identifier, title}[] — the candidate universe (caller has already restricted
//              this to voted-on bills; see loadPlanState below)
//   texts:     {bill_id, content_hash, length}[] — ONE row per bill, the "current" text (caller
//              resolves via pickCurrentTextRow); length may be null if unknown
//   summaries: {bill_id, bill_text_hash, status}[] — assumed ordered oldest-first so the last
//              entry per bill_id wins as "current" (matches summarize.js's planWork convention)
//   votes:     {bill_id, question}[] — raw, any order; grouped internally
// Returns { queue, excluded } — queue is priority-sorted (passage-vote bills first, stable order
// otherwise preserved within each group); excluded partitions into alreadySummarized/noText/
// oversize, each an honest, non-overlapping bucket (a bill can only ever land in ONE bucket or
// the queue, never both — exclusion checks run in a fixed order: no-text, then oversize, then
// already-summarized, so a bill with no text is never also reported oversize).
export function planQueue(bills, texts, summaries, votes) {
  const textByBill = new Map(texts.map((t) => [t.bill_id, t]));
  const summaryByBill = new Map();
  for (const s of summaries) summaryByBill.set(s.bill_id, s); // last wins = most recent
  const votesByBill = new Map();
  for (const v of votes) {
    if (!v.bill_id) continue;
    const list = votesByBill.get(v.bill_id) ?? [];
    list.push(v);
    votesByBill.set(v.bill_id, list);
  }

  const queued = [];
  const excluded = { alreadySummarized: [], noText: [], oversize: [] };

  for (const bill of bills) {
    const text = textByBill.get(bill.id);
    if (!text) {
      excluded.noText.push({ bill_id: bill.id, identifier: bill.identifier });
      continue;
    }
    if (typeof text.length === 'number' && text.length > MAX_TEXT_CHARS) {
      excluded.oversize.push({ bill_id: bill.id, identifier: bill.identifier, length: text.length });
      continue;
    }
    const summary = summaryByBill.get(bill.id);
    if (summary && summary.bill_text_hash === text.content_hash && ALREADY_SUMMARIZED_STATUSES.has(summary.status)) {
      excluded.alreadySummarized.push({ bill_id: bill.id, identifier: bill.identifier });
      continue;
    }
    const passage = (votesByBill.get(bill.id) ?? []).some((v) => isPassageVote(v.question));
    queued.push({
      bill_id: bill.id,
      identifier: bill.identifier,
      title: bill.title ?? null,
      bill_text_hash: text.content_hash,
      text_length: text.length ?? null,
      priority: passage ? 'passage' : 'other',
    });
  }

  const passageItems = queued.filter((q) => q.priority === 'passage');
  const otherItems = queued.filter((q) => q.priority === 'other');
  return { queue: [...passageItems, ...otherItems], excluded };
}

// ---- plan mode: DB-facing loader ----

// loadPlanState: candidate universe = bills with at least one recorded vote (same "voted-on
// bills" restriction summarize.js/enrich-federal-bills.js both apply — a bill nobody voted on
// isn't in VisibleGov's scope yet, and its `question` text can't feed the priority signal
// anyway). Every multi-row read goes through selectAll (Global Constraints: bills 38,250, votes
// 9,900+ — both past or near the 1,000-row cap); id-list filtering happens in JS via a Set, never
// a bare .in(billIds) call, for the same header-overflow reason review/server.js's
// handleGlossaryQueue documents.
export async function loadPlanState(client, billFilter = null) {
  const { data: billRows, error: billsErr } = await selectAll(client, 'bills', 'id,identifier,title');
  if (billsErr) throw new Error(`bills lookup failed: ${billsErr.message}`);

  const { data: voteRows, error: votesErr } = await selectAll(client, 'votes', 'bill_id,question');
  if (votesErr) throw new Error(`votes lookup failed: ${votesErr.message}`);
  const votedBillIds = new Set((voteRows ?? []).filter((v) => v.bill_id).map((v) => v.bill_id));

  let bills = (billRows ?? []).filter((b) => votedBillIds.has(b.id));
  if (billFilter) bills = bills.filter((b) => b.identifier === billFilter);
  const billIdSet = new Set(bills.map((b) => b.id));

  const { data: textRows, error: textsErr } = await selectAll(client, 'bill_texts', 'bill_id,content,content_hash,retrieved_at');
  if (textsErr) throw new Error(`bill_texts lookup failed: ${textsErr.message}`);
  const textRowByBill = new Map();
  for (const row of textRows ?? []) {
    if (!billIdSet.has(row.bill_id)) continue;
    const existing = textRowByBill.get(row.bill_id);
    if (!existing || (row.retrieved_at ?? '') > (existing.retrieved_at ?? '')) textRowByBill.set(row.bill_id, row);
  }
  const texts = [...textRowByBill.values()].map((r) => ({
    bill_id: r.bill_id,
    content_hash: r.content_hash,
    length: typeof r.content === 'string' ? r.content.length : null,
  }));

  const { data: summaryRows, error: summariesErr } = await selectAll(client, 'summaries', 'bill_id,status,bill_text_hash,created_at', {
    filter: (q) => q.order('created_at', { ascending: true }),
  });
  if (summariesErr) throw new Error(`summaries lookup failed: ${summariesErr.message}`);
  const summaries = (summaryRows ?? []).filter((s) => billIdSet.has(s.bill_id));

  const votes = (voteRows ?? []).filter((v) => billIdSet.has(v.bill_id));

  return { bills, texts, summaries, votes };
}

// ============================================================
// `record` mode: mechanical gates + writer for one subagent-produced result
// ============================================================

const TOP_LEVEL_FIELDS = new Set(Object.keys(SUMMARY_SCHEMA.properties));
const WHAT_IT_DOES_FIELDS = new Set(Object.keys(SUMMARY_SCHEMA.properties.what_it_does.items.properties));
const REFERENCED_TERM_FIELDS = new Set(Object.keys(SUMMARY_SCHEMA.properties.referenced_terms.items.properties));
const CLASSIFICATION_VALUES = new Set(SUMMARY_SCHEMA.properties.classification.enum);
const REFERENCED_TERM_KINDS = new Set(SUMMARY_SCHEMA.properties.referenced_terms.items.properties.kind.enum);

// validateSummaryShape: mechanical re-check of a subagent's summary JSON against SUMMARY_SCHEMA's
// actual shape (required fields, additionalProperties:false, enums) — derived FROM SUMMARY_SCHEMA
// itself (not a hand-duplicated parallel list) so this validator can never silently drift out of
// sync with the schema the author subagent is actually instructed to follow. Returns a
// human-readable reason string, or null if the shape is valid. Deliberately does NOT accept the
// subagent's own claim of conformance — a real Anthropic API call gets json_schema-enforced
// output for free; a subagent's text response gets no such guarantee, so this is the mechanical
// stand-in for that guarantee.
export function validateSummaryShape(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return 'summary must be a JSON object';
  for (const key of Object.keys(summary)) {
    if (!TOP_LEVEL_FIELDS.has(key)) return `summary has an unexpected field: ${key}`;
  }
  for (const key of SUMMARY_SCHEMA.required) {
    if (!(key in summary)) return `summary is missing required field: ${key}`;
  }
  if (!Array.isArray(summary.what_it_does)) return 'summary.what_it_does must be an array';
  for (let i = 0; i < summary.what_it_does.length; i += 1) {
    const b = summary.what_it_does[i];
    if (!b || typeof b !== 'object' || Array.isArray(b)) return `summary.what_it_does[${i}] must be an object`;
    for (const key of Object.keys(b)) {
      if (!WHAT_IT_DOES_FIELDS.has(key)) return `summary.what_it_does[${i}] has an unexpected field: ${key}`;
    }
    if (typeof b.point !== 'string' || b.point.trim() === '') return `summary.what_it_does[${i}].point must be a non-empty string`;
    if (typeof b.section !== 'string') return `summary.what_it_does[${i}].section must be a string`;
  }
  if (typeof summary.stated_purpose !== 'string') return 'summary.stated_purpose must be a string';
  if (!CLASSIFICATION_VALUES.has(summary.classification)) {
    return `summary.classification must be one of: ${[...CLASSIFICATION_VALUES].join(', ')}`;
  }
  if (!Array.isArray(summary.referenced_terms)) return 'summary.referenced_terms must be an array';
  for (let i = 0; i < summary.referenced_terms.length; i += 1) {
    const t = summary.referenced_terms[i];
    if (!t || typeof t !== 'object' || Array.isArray(t)) return `summary.referenced_terms[${i}] must be an object`;
    for (const key of Object.keys(t)) {
      if (!REFERENCED_TERM_FIELDS.has(key)) return `summary.referenced_terms[${i}] has an unexpected field: ${key}`;
    }
    if (typeof t.term !== 'string' || t.term.trim() === '') return `summary.referenced_terms[${i}].term must be a non-empty string`;
    if (!REFERENCED_TERM_KINDS.has(t.kind)) return `summary.referenced_terms[${i}].kind must be one of: ${[...REFERENCED_TERM_KINDS].join(', ')}`;
    if (typeof t.citation_raw !== 'string') return `summary.referenced_terms[${i}].citation_raw must be a string`;
  }
  return null;
}

// checkCitationsPresent: schema-shape validation alone lets section:'' through (JSON schema type
// 'string' has no minLength here) — a bullet with an empty cited section is exactly the
// uncited-bullet gap verify.js's own checkBulletCoverage guards against on the review-edit path;
// this is the record-mode equivalent, checked BEFORE any DB write.
export function checkCitationsPresent(whatItDoes) {
  const missingAt = [];
  whatItDoes.forEach((b, i) => { if (!b.section || !b.section.trim()) missingAt.push(i); });
  if (missingAt.length > 0) {
    throw new MalformedSummaryError(
      `summary has ${missingAt.length} bullet(s) with no cited section (indices ${missingAt.join(', ')}) — every point must cite a section`,
      { missingAt },
    );
  }
}

function validateEnvelope(item) {
  if (!item || typeof item !== 'object') return 'record item must be an object';
  if (typeof item.bill_id !== 'string' || !item.bill_id) return 'record item requires a non-empty bill_id';
  if (typeof item.bill_text_hash !== 'string' || !item.bill_text_hash) return 'record item requires a non-empty bill_text_hash';
  if (!item.summary || typeof item.summary !== 'object') return 'record item requires a summary object';
  return null;
}

// classifyRecordItem: all the READ-ONLY mechanical gating for one record item — schema shape,
// citation presence, hash-provenance against the CURRENTLY stored bill text, idempotency against
// any existing summary at that hash, and (re-derived, never trusted from the input) verdict
// completeness/overall. Throws a typed, pre-write error for anything unusable; otherwise returns
// a decision object describing what applyRecordDecision should do. Deliberately performs NO
// writes itself — this is what --dry-run runs standalone, and what recordOne runs before writing,
// so the two paths can never drift apart.
export async function classifyRecordItem(client, item) {
  const envelopeError = validateEnvelope(item);
  if (envelopeError) throw new MalformedSummaryError(envelopeError, { billId: item?.bill_id ?? null });

  const { bill_id: billId, bill_text_hash: claimedHash, summary } = item;
  const identifier = item.identifier ?? billId;

  const shapeError = validateSummaryShape(summary);
  if (shapeError) throw new MalformedSummaryError(`summary for bill ${identifier}: ${shapeError}`, { billId });
  checkCitationsPresent(summary.what_it_does);

  const { data: textRows, error: tErr } = await client.from('bill_texts').select('content_hash,retrieved_at').eq('bill_id', billId);
  if (tErr) throw new Error(`bill_texts lookup failed for bill ${identifier}: ${tErr.message}`);
  const currentText = pickCurrentTextRow(textRows ?? []);
  if (!currentText) {
    throw new MissingBillTextError(`no bill text on file for bill ${identifier} — cannot verify what the orchestrator actually summarized`, { billId });
  }
  if (currentText.content_hash !== claimedHash) {
    throw new TextHashMismatchError(
      `bill ${identifier}: record item's bill_text_hash does not match the currently stored bill text — the orchestrator must have summarized stale or wrong text; reject, never trust an unverified hash`,
      { billId, claimedHash, currentHash: currentText.content_hash },
    );
  }

  const { data: existingSummaries, error: sErr } = await client.from('summaries').select('id,status,bill_text_hash').eq('bill_id', billId);
  if (sErr) throw new Error(`summaries lookup failed for bill ${identifier}: ${sErr.message}`);
  const already = (existingSummaries ?? []).find((s) => s.bill_text_hash === claimedHash && ALREADY_SUMMARIZED_STATUSES.has(s.status));
  if (already) return { action: 'alreadySummarized', billId, identifier, summaryId: already.id };

  const base = {
    billId,
    identifier,
    claimedHash,
    markdown: renderMarkdown(summary),
    authorModelLabel: `subagent:${item.author_model ?? MODEL}`,
    verifierModelLabel: `subagent:${item.verifier_model ?? VERIFIER_MODEL}`,
    referencedTerms: summary.referenced_terms ?? [],
  };

  // Mechanical completeness gate (never trusting the subagent's own overall claim, per verifier.js's
  // assessVerdicts contract, reused verbatim — not re-derived): a malformed/incomplete verdict set
  // does NOT block the summary draft itself (the author subagent did its job; a flaky verifier
  // subagent shouldn't waste that) — it lands in the exact same DB state a fresh summarize.js draft
  // is in before verify.js has ever run: 'draft', zero verification rows, "Unverified" on the
  // review page. Only a COMPLETE verdict set ever gets a summary_verifications row written, so no
  // row is ever mislabeled 'flagged' just because the verifier's OUTPUT was broken.
  const { complete, overall } = assessVerdicts(item.verdicts, summary.what_it_does.length);
  if (!complete) return { action: 'leaveUnverified', ...base };
  if (overall === 'clean') return { action: 'publish', ...base, verdicts: item.verdicts, overall };
  return { action: 'flagDraft', ...base, verdicts: item.verdicts, overall };
}

const OUTCOME_BY_ACTION = {
  alreadySummarized: 'alreadySummarized', publish: 'published', flagDraft: 'flaggedDraft', leaveUnverified: 'unverifiedDraft',
};

function buildAutoPublishNote(verifierModelLabel, actionWord) {
  return `trust-model v3: clean adversarial verification (${verifierModelLabel}), ${actionWord}`;
}

// autoPublishSummary: the two-hop transition (draft -> approved -> published) for a summary whose
// re-derived overall is 'clean', trust-model v3 mechanism 2 — mirrors auto-publish-glossary.js's
// autoPublishOne exactly (same nextStatus/mapNoteAction reuse, same note-text convention naming
// the verifier model and "auto-approved"/"auto-published" rather than a new notes.action enum
// value), summaries/summary_notes in place of glossary_terms/glossary_notes. Unlike
// glossary_terms, the summaries table carries no published-completeness CHECK constraint (0001/
// 0003 never added one) — body_md is guaranteed non-empty here regardless, since it was written
// moments earlier in the very same applyRecordDecision call, so there is no PublishCompletenessError
// analog to catch.
export async function autoPublishSummary(client, summaryId, verifierModelLabel) {
  const approvedStatus = nextStatus('draft', 'approve');
  const { error: aErr } = await client.from('summaries').update({ status: approvedStatus }).eq('id', summaryId);
  if (aErr) throw new Error(`summaries update (approve) failed for summary ${summaryId}: ${aErr.message}`);

  const { error: anErr } = await client.from('summary_notes').insert({
    summary_id: summaryId, action: mapNoteAction('approve'), note: buildAutoPublishNote(verifierModelLabel, 'auto-approved'),
  });
  if (anErr) throw new Error(`summary_notes insert (approve) failed for summary ${summaryId}: ${anErr.message}`);

  const publishedStatus = nextStatus(approvedStatus, 'publish');
  const { error: pErr } = await client.from('summaries').update({ status: publishedStatus, published_at: new Date().toISOString() }).eq('id', summaryId);
  if (pErr) throw new Error(`summaries update (publish) failed for summary ${summaryId}: ${pErr.message}`);

  const { error: pnErr } = await client.from('summary_notes').insert({
    summary_id: summaryId, action: mapNoteAction('publish'), note: buildAutoPublishNote(verifierModelLabel, 'auto-published'),
  });
  if (pnErr) throw new Error(`summary_notes insert (publish) failed for summary ${summaryId}: ${pnErr.message}`);
}

// applyRecordDecision: performs the writes classifyRecordItem's decision calls for. summaries has
// no unique constraint to upsert against (summarize.js's own createDraftSummary comment: each
// generation is a fresh row, matching the summary_notes history model) — a plain .insert(), same
// as createDraftSummary. referenced_terms persistence reuses persistReferencedTermsGracefully
// UNCHANGED (summarize.js precedent): a glossary-side persistence failure degrades to an honest
// warning and NEVER unwinds the already-committed summary draft.
export async function applyRecordDecision(client, runId, decision) {
  if (decision.action === 'alreadySummarized') {
    return {
      outcome: 'alreadySummarized', billId: decision.billId, summaryId: decision.summaryId, termsUpserted: 0, warning: null,
    };
  }

  const {
    billId, identifier, claimedHash, markdown, authorModelLabel, verifierModelLabel, referencedTerms,
  } = decision;

  const { data: inserted, error: insErr } = await client.from('summaries').insert({
    bill_id: billId, status: 'draft', body_md: markdown, model: authorModelLabel,
    prompt_version: PROMPT_VERSION, bill_text_hash: claimedHash, run_id: runId,
  }).select('id').single();
  if (insErr) throw new Error(`summary insert failed for bill ${identifier}: ${insErr.message}`);
  const summaryId = inserted.id;

  const { termsUpserted, warning } = await persistReferencedTermsGracefully(client, runId, {
    bill: { identifier }, summaryId, referencedTerms,
  });

  if (decision.action === 'leaveUnverified') {
    return {
      outcome: 'unverifiedDraft', billId, summaryId, termsUpserted, warning,
    };
  }

  const { error: verErr } = await client.from('summary_verifications').insert({
    summary_id: summaryId, verdicts: decision.verdicts, overall: decision.overall,
    model: verifierModelLabel, prompt_version: VERIFY_PROMPT_VERSION,
  });
  if (verErr) throw new Error(`summary_verifications insert failed for bill ${identifier}: ${verErr.message}`);

  if (decision.action === 'flagDraft') {
    return {
      outcome: 'flaggedDraft', billId, summaryId, termsUpserted, warning,
    };
  }

  await autoPublishSummary(client, summaryId, verifierModelLabel);
  return {
    outcome: 'published', billId, summaryId, termsUpserted, warning,
  };
}

// recordOne: classify then apply — the live (non-dry-run) path for a single record item.
// --dry-run runs classifyRecordItem alone (see main() below) so preview and live can never
// silently drift apart; there is exactly one decision function, not two.
export async function recordOne(client, runId, item) {
  const decision = await classifyRecordItem(client, item);
  return applyRecordDecision(client, runId, decision);
}

function describeDecision(decision) {
  return {
    bill_id: decision.billId,
    identifier: decision.identifier ?? decision.billId,
    would: OUTCOME_BY_ACTION[decision.action],
    summary_id: decision.action === 'alreadySummarized' ? decision.summaryId : null,
  };
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: args.mode, status: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (args.mode === 'plan') {
    const { bills, texts, summaries, votes } = await loadPlanState(client, args.bill);
    const { queue, excluded } = planQueue(bills, texts, summaries, votes);
    const emitted = args.limit ? queue.slice(0, args.limit) : queue;
    console.log(JSON.stringify({
      mode: 'plan',
      counts: {
        candidates: bills.length,
        queued: queue.length,
        emitted: emitted.length,
        passage: queue.filter((q) => q.priority === 'passage').length,
        other: queue.filter((q) => q.priority === 'other').length,
        alreadySummarized: excluded.alreadySummarized.length,
        noText: excluded.noText.length,
        oversize: excluded.oversize.length,
      },
      queue: emitted,
      excluded,
    }, null, 2));
    return;
  }

  // record mode
  let payload;
  try {
    payload = JSON.parse(readFileSync(args.file, 'utf8'));
  } catch (err) {
    console.log(JSON.stringify({ mode: 'record', status: 'blocked', reason: `could not read/parse --file ${args.file}: ${err.message}` }, null, 2));
    process.exitCode = 1;
    return;
  }
  const results = Array.isArray(payload?.results) ? payload.results : null;
  if (!results) {
    console.log(JSON.stringify({ mode: 'record', status: 'blocked', reason: '--file JSON must have a top-level "results" array' }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    const preview = [];
    const rejects = [];
    for (const item of results) {
      try {
        preview.push(describeDecision(await classifyRecordItem(client, item)));
      } catch (err) {
        if (isTypedFailure(err)) rejects.push({ bill_id: item?.bill_id ?? null, error: err.name, message: err.message });
        else throw err;
      }
    }
    const counts = { total: results.length, rejects: rejects.length };
    for (const outcome of Object.values(OUTCOME_BY_ACTION)) counts[outcome] = preview.filter((p) => p.would === outcome).length;
    console.log(JSON.stringify({
      mode: 'dry-run', counts, preview, rejects,
    }, null, 2));
    return;
  }

  const runId = await openRun(client, 'summary-queue-record');
  const failures = [];
  const outcomes = {
    alreadySummarized: 0, unverifiedDraft: 0, flaggedDraft: 0, published: 0,
  };
  try {
    for (const item of results) {
      try {
        const result = await recordOne(client, runId, item);
        outcomes[result.outcome] += 1;
      } catch (err) {
        if (isTypedFailure(err)) failures.push({ bill_id: item?.bill_id ?? null, error: err.name, message: err.message });
        else throw err;
      }
    }

    const counts = { total: results.length, ...outcomes, failures: failures.length };
    const status = failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, failures });
    console.log(JSON.stringify({
      mode: 'live', run_id: runId, status, counts, failures,
    }, null, 2));
    if (failures.length > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
