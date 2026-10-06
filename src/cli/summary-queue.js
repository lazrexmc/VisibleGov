import { readFileSync } from 'node:fs';
import {
  getClient, openRun, closeRun, selectAll,
} from '../lib/db.js';
import {
  MODEL, PROMPT_VERSION, MAX_TEXT_CHARS, SUMMARY_SCHEMA, renderMarkdown,
} from '../lib/summarizer.js';
import {
  VERIFIER_MODEL, VERIFY_PROMPT_VERSION, VERIFY_SCHEMA, assessVerdicts,
  COMPLETENESS_PROMPT_VERSION, assessCompleteness, minKeyProvisionsFor,
} from '../lib/verifier.js';
import { parsePositiveIntegerFlag } from '../lib/errors.js';
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
    mode, dryRun: false, limit: null, file: null, bill: null, replaceDrafts: false,
  };
  let i = 0;
  while (i < rest.length) {
    const key = rest[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    // --replace-drafts (re-check/re-author lane): lets record supersede a bill's existing DRAFT at
    // the same hash — the old draft is retired to 'rejected' with a note AFTER the new row lands.
    // approved/published rows are never replaceable, flag or no flag.
    if (key === '--replace-drafts') { out.replaceDrafts = true; i += 1; continue; }
    // Final whole-branch review, finding 6: same class, same shared guard as
    // enrich-federal-bills.js's own --limit — plan mode's `args.limit ? queue.slice(...) : queue`
    // reads NaN/0 as "emit the whole queue", so a typo silently defeats the operator's chunking.
    if (key === '--limit') { out.limit = parsePositiveIntegerFlag(rest[i + 1], '--limit'); i += 2; continue; }
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
//
// Fix round 1 (Important finding 3): the original /passage|third reading/i missed the repo's own
// real corpus shapes — MO LegiScan's `"House: SB 894  SBs 3rd READ - INFORMAL"` (tests/fixtures/
// research/legiscan/mo-2018-rollcall-747209.json) and MO's OpenStates motion_text `"Third Read and
// Passed (H) -"` (tests/fixtures/mo-legislature/bills-with-votes.json) both name a real passage-
// adjacent reading vote but neither contains the literal substring "third reading". Widened to
// `third\s+read` / `3rd\s+read` (word-boundary-free — "Third Read" is a prefix match inside
// "Third Reading" too, so the original clean-room form still matches). This is a prioritization
// signal, not a correctness gate (a miss here mis-orders the queue, it never corrupts a write) —
// but the whole point of priority ordering is to serve readers, so it should be true against real
// data, not just the shapes this file's own author imagined.
export const PASSAGE_QUESTION_RE = /passage|third\s+read|3rd\s+read/i;

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

// FINAL WHOLE-BRANCH REVIEW, finding 7 (execution-proven probes): every structural field of a
// summary is SINGLE-LINE by contract, and this is the only thing enforcing it. renderMarkdown
// interpolates each what_it_does point straight into a `- ` line, so a point containing
// '...\n- Repeals the Clean Air Act in full. (Sec. 9)' renders TWO citable public bullets while
// assessVerdicts counts ONE — the published artifact carrying more content than the verification
// record covers — and a point containing '...\n\n**Stated purpose (from the bill):** ...' forges a
// stated-purpose block no field ever held. Rejecting the newline outright (rather than escaping or
// stripping it at render time) keeps the stored fact and the rendered fact identical, which is the
// whole point of the receipts model. referenced_terms fields are included because they are rendered
// by the glossary pipeline downstream, on the same terms.
function containsLineBreak(value) {
  return typeof value === 'string' && /[\r\n]/.test(value);
}

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
    if (containsLineBreak(b.point)) return `summary.what_it_does[${i}].point contains a line break — structural fields are single-line by contract (a newline here renders extra public bullets no verdict covers)`;
    if (typeof b.section !== 'string') return `summary.what_it_does[${i}].section must be a string`;
    if (containsLineBreak(b.section)) return `summary.what_it_does[${i}].section contains a line break — structural fields are single-line by contract`;
  }
  if (typeof summary.stated_purpose !== 'string') return 'summary.stated_purpose must be a string';
  if (containsLineBreak(summary.stated_purpose)) return 'summary.stated_purpose contains a line break — structural fields are single-line by contract (a newline here forges additional rendered blocks)';
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
    if (containsLineBreak(t.term)) return `summary.referenced_terms[${i}].term contains a line break — structural fields are single-line by contract`;
    if (!REFERENCED_TERM_KINDS.has(t.kind)) return `summary.referenced_terms[${i}].kind must be one of: ${[...REFERENCED_TERM_KINDS].join(', ')}`;
    if (typeof t.citation_raw !== 'string') return `summary.referenced_terms[${i}].citation_raw must be a string`;
    if (containsLineBreak(t.citation_raw)) return `summary.referenced_terms[${i}].citation_raw contains a line break — structural fields are single-line by contract`;
  }
  return null;
}

// ---- FINAL WHOLE-BRANCH REVIEW, findings 4 & 5: the two gates that stand between a subagent's
// output and an AUTO-PUBLISHED, anon-readable artifact carrying a "clean adversarial verification"
// note. Both are verification failures, not shape failures, so both route to flagDraft (the same
// handling an unsupported verdict already gets) — never a crash, never a publish. ----

const VERDICT_FIELDS = new Set(Object.keys(VERIFY_SCHEMA.properties.verdicts.items.properties));
const VERDICT_REQUIRED = VERIFY_SCHEMA.properties.verdicts.items.required;

// validateVerdictBinding — finding 4: classifyRecordItem bound verdicts to a summary by COUNT ONLY
// (array length, bullet_index uniqueness/range, supported===true). Nothing tied the verdicts to
// THIS summary, and — unlike the summary itself — the verdicts were never validated against their
// own schema at all. Proven: a verdict set citing another bill's sections, or a hollow
// [{bullet_index: 0, supported: true}], auto-published and was stored verbatim in
// summary_verifications as the permanent trust-model-v3 receipt.
//
// Two mechanical requirements, both derived FROM VERIFY_SCHEMA rather than hand-duplicated (the
// same anti-drift discipline validateSummaryShape applies to SUMMARY_SCHEMA):
//   1. each verdict matches VERIFY_SCHEMA's item shape (required fields present, no extras, right
//      primitive types) — a real Anthropic API call gets json_schema-enforced output for free; a
//      subagent's text response gets no such guarantee, so this is the stand-in;
//   2. each verdict's `section` equals the section of the bullet it names. VERIFY_SCHEMA already
//      MANDATES the verifier copy that value from the summary ("The section cited by this bullet,
//      copied from the summary") — this enforces the mandate instead of trusting it.
// Matched by bullet_index, not array position: bullet_index is what assessVerdicts already
// validated as a complete, gap-free, in-range bijection onto the bullets, so it — not the array's
// incidental ordering — is the verdict's own claim about which bullet it verified.
// Returns a human-readable reason string, or null if every verdict is well-shaped and bound.
export function validateVerdictBinding(verdicts, whatItDoes) {
  if (!Array.isArray(verdicts)) return 'verdicts must be an array';
  for (let i = 0; i < verdicts.length; i += 1) {
    const v = verdicts[i];
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `verdicts[${i}] must be an object`;
    for (const key of Object.keys(v)) {
      if (!VERDICT_FIELDS.has(key)) return `verdicts[${i}] has an unexpected field: ${key}`;
    }
    for (const key of VERDICT_REQUIRED) {
      if (!(key in v)) return `verdicts[${i}] is missing required field: ${key}`;
    }
    if (!Number.isInteger(v.bullet_index)) return `verdicts[${i}].bullet_index must be an integer`;
    if (typeof v.section !== 'string') return `verdicts[${i}].section must be a string`;
    if (typeof v.supported !== 'boolean') return `verdicts[${i}].supported must be a boolean`;
    if (typeof v.reason !== 'string') return `verdicts[${i}].reason must be a string`;
    if (typeof v.evidence_quote !== 'string') return `verdicts[${i}].evidence_quote must be a string`;
    const bullet = whatItDoes[v.bullet_index];
    if (!bullet) return `verdicts[${i}].bullet_index ${v.bullet_index} names no bullet in this summary`;
    if (stripLeadingSectionWord(stripSurroundingParens(v.section)) !== stripLeadingSectionWord(stripSurroundingParens(bullet.section))) {
      return `verdicts[${i}] cites section "${v.section}" but what_it_does[${v.bullet_index}] cites "${bullet.section}" — this verdict is not bound to THIS summary's bullet`;
    }
  }
  return null;
}

// stripSurroundingParens — with stripLeadingSectionWord below, the ONLY normalization the binding
// comparison applies, on BOTH sides.
// Verifier agents intermittently echo a bullet's section wrapped in parentheses ("(Sec. 2)" for a
// bullet citing "Sec. 2"); this flagged 13 otherwise-clean bills across waves AN/AO/AP. The
// section value is the verifier's statement of WHICH bullet it verified — not bill content, so
// facts-only verbatim discipline does not apply to it — and removing one complete surrounding
// pair cannot mask a real cross-section mismatch. Anything short of a complete pair (unbalanced,
// nested-only-on-one-side) is left untouched and fails binding as before.
function stripSurroundingParens(section) {
  const s = String(section).trim();
  if (s.startsWith('(') && s.endsWith(')')) return s.slice(1, -1).trim();
  return s;
}

// stripLeadingSectionWord — same class of verifier-echo drift as the parens case (wave BV, HB 689):
// the verifier cited "135.690" for a bullet citing "section 135.690". A bare leading "section"/
// "sec." token carries no identifying content — the number after it does — so dropping it from
// BOTH sides cannot bind a verdict to the wrong bullet; "section 135.690" vs "135.680" still
// fails. Only the exact leading word (case-insensitive, with optional period, followed by
// whitespace) is dropped; everything else is untouched.
function stripLeadingSectionWord(section) {
  return String(section).replace(/^(?:(?:section|sec\.?)\s+)+/i, '');
}

// collapseWhitespace — the ONLY normalization checkStatedPurposeGrounding applies, on BOTH sides.
// Whitespace runs collapse to a single space (stored bill text wraps and indents; a purpose
// sentence quoted out of it will not carry the same line breaks). Nothing else is normalized — no
// case folding, no punctuation smoothing, no dash unification: facts-only means the words and
// characters must actually be the bill's own.
function collapseWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

// checkStatedPurposeGrounding — finding 5: renderMarkdown emits "**Stated purpose (from the
// bill):** ..." into anon-readable body_md, but verdicts only ever cover what_it_does bullets. NO
// mechanical check of any kind covered stated_purpose, so a fabricated one published under a
// clean-verification note. A non-empty stated_purpose must now appear verbatim (whitespace
// collapsed) in the hash-pinned stored bill text — the same bill_texts row whose content_hash
// classifyRecordItem has already re-verified against the item's claimed hash — or the gate refuses
// to publish. An empty stated_purpose stays allowed: SUMMARY_SCHEMA itself says "empty string if
// the bill states none," which is a real and honest shape.
//
// NOTE (ledgered, not a bug): the long-title inconsistency already recorded in this branch's
// progress notes means some existing drafts whose stated_purpose paraphrases rather than quotes the
// bill will flag on this. That is correct behavior — a paraphrase is precisely what nothing was
// checking. Returns a reason string, or null when the purpose is grounded (or empty).
export function checkStatedPurposeGrounding(statedPurpose, billTextContent) {
  const needle = collapseWhitespace(statedPurpose ?? '');
  if (needle === '') return null;
  if (typeof billTextContent !== 'string' || billTextContent === '') {
    return 'summary.stated_purpose is non-empty but the stored bill text carries no content to ground it against — refusing to publish an unverifiable field';
  }
  if (!collapseWhitespace(billTextContent).includes(needle)) {
    return `summary.stated_purpose is not a verbatim substring of the hash-pinned stored bill text — nothing in the trust chain covers this field, so an ungrounded purpose is never published: "${needle}"`;
  }
  return null;
}

// checkEvidenceQuoteGrounding — 2026-10-06. The SAME defect as checkStatedPurposeGrounding, one
// field over, found live and not by review.
//
// WHAT HAPPENED. Wave W30's verifier for HB 14 returned 63 verdicts for 63 bullets, every one
// supported:true, bullet indices complete with no gaps or duplicates - structurally flawless, so
// validateVerdictBinding passed it and the record gate classified it `published`. Four of those 63
// evidence quotes do not exist in the bill. Not whitespace drift: bullet 30's quote matched 11 of
// its 60 characters ("to support "), bullet 34 matched 9 of 70 ("families "), bullet 57 matched 15
// of 67 ("the Department "). The verifier invented supporting text and nothing noticed.
//
// WHY NOTHING NOTICED. `evidence_quote` is described as "an exact, verbatim quote from the bill
// text" in VERIFY_SCHEMA and again in the verifier's system prompt. Both are instructions to a
// model. The trust model's whole premise is that the verifier's self-report is never trusted -
// `overall` is re-derived, completeness is re-derived, bindings are re-checked - and yet the one
// field a READER uses to check a claim themselves was taken on the verifier's word. Migration 0021
// exposes these quotes publicly as per-bullet citations, so an invented quote is an invented
// receipt on the public site, which is the one non-negotiable.
//
// Same normalization as stated_purpose, deliberately: collapseWhitespace on BOTH sides and nothing
// else. No case folding, no punctuation smoothing - "facts only" means the characters must be the
// bill's own. An EMPTY quote is a failure here rather than an allowance: VERIFY_SCHEMA lists
// evidence_quote in `required`, so unlike stated_purpose ("empty string if the bill states none" is
// a real shape) there is no honest empty case - a verdict with no quote is a verdict with no
// evidence. Reports EVERY offending bullet, not just the first, because a reviewer needs the shape
// of the failure: one bad quote is a slip, four is a verifier that was not reading the text.
export function checkEvidenceQuoteGrounding(verdicts, billTextContent) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return null;
  if (typeof billTextContent !== 'string' || billTextContent === '') {
    return 'verdicts carry evidence quotes but the stored bill text has no content to ground them against — refusing to publish unverifiable receipts';
  }
  const haystack = collapseWhitespace(billTextContent);
  const bad = [];
  for (const v of verdicts) {
    const quote = collapseWhitespace(v?.evidence_quote ?? '');
    if (quote === '') {
      bad.push(`bullet ${v?.bullet_index}: empty evidence_quote`);
      continue;
    }
    if (!haystack.includes(quote)) {
      bad.push(`bullet ${v?.bullet_index}: "${quote.slice(0, 80)}"`);
    }
  }
  if (bad.length === 0) return null;
  return `${bad.length} of ${verdicts.length} verdict evidence_quote(s) are not verbatim in the hash-pinned stored bill text — these are the per-bullet citations migration 0021 publishes to readers, so an ungrounded quote is never published: ${bad.slice(0, 6).join('; ')}${bad.length > 6 ? `; +${bad.length - 6} more` : ''}`;
}

// checkCitationsPresent: schema-shape validation alone lets section:'' through (JSON schema type
// 'string' has no minLength here) — a bullet with an empty cited section is exactly the
// uncited-bullet gap verify.js's own checkBulletCoverage guards against on the review-edit path;
// this is the record-mode equivalent, checked BEFORE any DB write.
//
// Fix round 1 (CRITICAL finding 1): an empty what_it_does array vacuously satisfies BOTH this
// function's own missingAt loop (nothing to iterate, so nothing is ever "missing") AND
// assessVerdicts' documented zero-bullets/zero-verdicts "complete: true, overall: 'clean'" vacuous
// case (verifier.js's own test: "zero bullets, zero verdicts -> complete/clean") — a
// {what_it_does: [], verdicts: []} record item would sail through every gate in this file and
// auto-publish with a body_md of literally nothing, carrying a verification note that falsely
// reads as "clean." This codebase's THIRD encounter with the empty-set-vacuously-passes class (the
// glossary pipeline hit the identical shape as its own final-review finding 4) — rejected here,
// mechanically, before assessVerdicts ever runs. A summary asserting zero points is definitionally
// not a summary.
export function checkCitationsPresent(whatItDoes) {
  if (!whatItDoes || whatItDoes.length === 0) {
    throw new MalformedSummaryError(
      'summary has zero what_it_does bullets — a summary with no substantive points is not a summary',
      { count: 0 },
    );
  }
  const missingAt = [];
  whatItDoes.forEach((b, i) => { if (!b.section || !b.section.trim()) missingAt.push(i); });
  if (missingAt.length > 0) {
    throw new MalformedSummaryError(
      `summary has ${missingAt.length} bullet(s) with no cited section (indices ${missingAt.join(', ')}) — every point must cite a section`,
      { missingAt },
    );
  }
}

// Fix round 1 (Important finding 2): author_model/verifier_model are OPTIONAL (undefined ->
// classifyRecordItem's own MODEL/VERIFIER_MODEL default applies), but if the caller supplies one
// it must be a real bare model id — never an empty string (which would previously slip through
// the `?? MODEL` default check, since `??` only falls back on null/undefined, not '', producing a
// provenance label of the literal string 'subagent:') and never already carrying THIS code's own
// 'subagent:' prefix (a caller that double-supplies the prefix would otherwise get
// 'subagent:subagent:claude-opus-5' stored as provenance — the prefix is applied exactly once,
// by this file, never by the caller).
function validateModelLabel(value, fieldName) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') return `record item's ${fieldName} must be a non-empty string when provided`;
  if (value.startsWith('subagent:') || value.startsWith('api:')) {
    return `record item's ${fieldName} must be the bare model id — the provenance prefix is applied by this code, never supplied by the caller`;
  }
  return null;
}

// Provenance channel (2026-08-07, the $2 Haiku API probe): how the item's model calls were made.
// 'subagent' = Claude Code subagents (the wave path, the default); 'api' = billed Anthropic API
// calls. The stored label must never claim a subagent ran when the API did (or vice versa), and
// there is no free-text channel — an unknown value is a typed pre-write reject.
const PROVENANCE_VALUES = new Set(['subagent', 'api']);

function validateEnvelope(item) {
  if (!item || typeof item !== 'object') return 'record item must be an object';
  if (typeof item.bill_id !== 'string' || !item.bill_id) return 'record item requires a non-empty bill_id';
  if (typeof item.bill_text_hash !== 'string' || !item.bill_text_hash) return 'record item requires a non-empty bill_text_hash';
  if (!item.summary || typeof item.summary !== 'object') return 'record item requires a summary object';
  if (item.provenance !== undefined && !PROVENANCE_VALUES.has(item.provenance)) {
    return `record item's provenance must be one of: ${[...PROVENANCE_VALUES].join(', ')}`;
  }
  // Per-stage overrides (the hybrid pipeline: API-authored, subagent-verified — each stage's
  // label must state how ITS call was actually made, never a single blanket claim).
  if (item.author_provenance !== undefined && !PROVENANCE_VALUES.has(item.author_provenance)) {
    return `record item's author_provenance must be one of: ${[...PROVENANCE_VALUES].join(', ')}`;
  }
  if (item.verifier_provenance !== undefined && !PROVENANCE_VALUES.has(item.verifier_provenance)) {
    return `record item's verifier_provenance must be one of: ${[...PROVENANCE_VALUES].join(', ')}`;
  }
  const authorModelError = validateModelLabel(item.author_model, 'author_model');
  if (authorModelError) return authorModelError;
  const verifierModelError = validateModelLabel(item.verifier_model, 'verifier_model');
  if (verifierModelError) return verifierModelError;
  return null;
}

// classifyRecordItem: all the READ-ONLY mechanical gating for one record item — schema shape,
// citation presence, hash-provenance against the CURRENTLY stored bill text, idempotency against
// any existing summary at that hash, and (re-derived, never trusted from the input) verdict
// completeness/overall. Throws a typed, pre-write error for anything unusable; otherwise returns
// a decision object describing what applyRecordDecision should do. Deliberately performs NO
// writes itself — this is what --dry-run runs standalone, and what recordOne runs before writing,
// so the two paths can never drift apart.
export async function classifyRecordItem(client, item, options = {}) {
  const envelopeError = validateEnvelope(item);
  if (envelopeError) throw new MalformedSummaryError(envelopeError, { billId: item?.bill_id ?? null });

  const { bill_id: billId, bill_text_hash: claimedHash, summary } = item;
  const identifier = item.identifier ?? billId;

  const shapeError = validateSummaryShape(summary);
  if (shapeError) throw new MalformedSummaryError(`summary for bill ${identifier}: ${shapeError}`, { billId });
  checkCitationsPresent(summary.what_it_does);

  // `content` (final whole-branch review, finding 5): the stated-purpose grounding check reads the
  // SAME row whose content_hash is re-verified two lines below — one query, one pinned text, so the
  // purpose can only ever be checked against the exact bytes the hash covers.
  const { data: textRows, error: tErr } = await client.from('bill_texts').select('content,content_hash,retrieved_at').eq('bill_id', billId);
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
  // Minor (fix round 1, finding 4, note-only — inherited check-then-act shape, not fixed here):
  // two concurrent `record` invocations for the SAME bill could both read past this check before
  // either has written, both proceeding to insert a duplicate draft. Accepted: this file's whole
  // design (see the header comment) is a single controller session dispatching subagents and
  // feeding `record` serially, never two concurrent record processes racing the same bill.
  const sameHashBlocking = (existingSummaries ?? []).filter((s) => s.bill_text_hash === claimedHash && ALREADY_SUMMARIZED_STATUSES.has(s.status));
  // --replace-drafts: a DRAFT-only blocker is exactly the re-check/re-author case — carry the old
  // draft ids so applyRecordDecision retires them once the new row exists. Any approved/published
  // row at this hash remains an absolute block: human-touched or live output is never replaced by
  // a re-run, flag or no flag.
  const supersedes = (options.replaceDrafts && sameHashBlocking.length > 0
    && sameHashBlocking.every((s) => s.status === 'draft'))
    ? sameHashBlocking.map((s) => s.id)
    : null;
  const already = supersedes ? null : sameHashBlocking[0];
  if (already) return { action: 'alreadySummarized', billId, identifier, summaryId: already.id };

  const provenance = item.provenance ?? 'subagent';
  const authorProvenance = item.author_provenance ?? provenance;
  const verifierProvenance = item.verifier_provenance ?? provenance;
  const base = {
    ...(supersedes ? { supersedes } : {}),
    billId,
    identifier,
    claimedHash,
    markdown: renderMarkdown(summary),
    authorModelLabel: `${authorProvenance}:${item.author_model ?? MODEL}`,
    verifierModelLabel: `${verifierProvenance}:${item.verifier_model ?? VERIFIER_MODEL}`,
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

  // FINAL WHOLE-BRANCH REVIEW, findings 4 & 5: two further mechanical gates stand between a
  // complete verdict set and an auto-publish. Both run AFTER the completeness gate for a reason —
  // an incomplete verdict set already lands in 'leaveUnverified' (a plain draft, nothing published,
  // no summary_verifications row written), so these only ever need to decide whether a verdict set
  // that PASSED completeness is trustworthy enough to publish behind. A failure of either is a
  // verification failure, not a shape failure: flagDraft, overall 'flagged' (never the re-derived
  // 'clean', which is precisely the claim being refused), with the reason carried through to the
  // operator's report rather than dropped.
  const gateReason = validateVerdictBinding(item.verdicts, summary.what_it_does)
    ?? checkStatedPurposeGrounding(summary.stated_purpose, currentText.content)
    ?? checkEvidenceQuoteGrounding(item.verdicts, currentText.content);
  if (gateReason) {
    return {
      action: 'flagDraft', ...base, verdicts: item.verdicts, overall: 'flagged', gateReason,
    };
  }

  // ---- completeness axis (task brief .superpowers/sdd/2026-07-31-completeness-axis/brief.md,
  // trust model v3): proves the summary COVERS the bill, not just that its claims are true.
  // REQUIRED for publish. Three outcomes, re-derived here — assessCompleteness's return value is
  // trusted, item.completeness's own shape/self-report never is:
  //   - absent entirely (item.completeness === undefined): the safe rollout default while
  //     orchestration is still being wired up — flagged draft, honest named reason, never publish.
  //   - malformed (assessCompleteness): the checker's own output is untrustworthy — reject the
  //     WHOLE item, same class/severity as a malformed summary (MalformedSummaryError, zero writes),
  //     never merely a flagged draft.
  //   - incomplete: flagged draft naming exactly which provisions the summary omits.
  //   - complete: this axis clears; publish still additionally requires the support axis (`overall`)
  //     to be 'clean' — completeness passing never overrides a failed support check.
  if (item.completeness === undefined) {
    return {
      action: 'flagDraft',
      ...base,
      verdicts: item.verdicts,
      overall,
      gateReason: 'completeness_check_absent: no completeness payload was supplied for this item — trust-model v3 requires both axes (support and completeness) verified before auto-publish',
    };
  }
  const completenessResult = assessCompleteness(item.completeness, summary.what_it_does.length, currentText.content, item.completeness_corroboration);
  // corroborated_thin marker (spec 2026-08-18): true exactly when the sub-floor branch is what
  // the gate exercised — i.e., the primary yield sits under the length-scaled floor AND the gate
  // did not malform. Derived here mechanically (never from the checker's self-report).
  const corroboratedThin = Array.isArray(item.completeness?.key_provisions)
    && item.completeness.key_provisions.length < minKeyProvisionsFor(currentText.content.length);
  if (completenessResult.overall === 'malformed') {
    throw new MalformedSummaryError(
      `completeness check for bill ${identifier} is malformed — the checker's own output cannot be trusted: ${completenessResult.reasons.join('; ')}`,
      { billId, reasons: completenessResult.reasons },
    );
  }
  if (completenessResult.overall === 'incomplete') {
    const missingDesc = completenessResult.missing.map((m) => `${m.section} (${m.provision})`).join('; ');
    return {
      action: 'flagDraft',
      ...base,
      verdicts: item.verdicts,
      overall,
      completeness: item.completeness,
      completenessOverall: 'incomplete',
      completenessCorroboration: item.completeness_corroboration ?? null,
      completenessCorroboratedThin: corroboratedThin,
      gateReason: `summary omits ${completenessResult.missing.length} key provision(s) present in the bill text: ${missingDesc}`,
    };
  }

  if (overall === 'clean') {
    return {
      action: 'publish',
      ...base,
      verdicts: item.verdicts,
      overall,
      completeness: item.completeness,
      completenessOverall: 'complete',
      completenessCorroboration: item.completeness_corroboration ?? null,
      completenessCorroboratedThin: corroboratedThin,
    };
  }
  return {
    action: 'flagDraft',
    ...base,
    verdicts: item.verdicts,
    overall,
    completeness: item.completeness,
    completenessOverall: 'complete',
    completenessCorroboration: item.completeness_corroboration ?? null,
    completenessCorroboratedThin: corroboratedThin,
  };
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

  // Task 5 (jurisdiction-aware insert-time dispatch): billId is already in scope (destructured
  // from decision above) — threading it through as bill.id lets the wrapper's own
  // `bill?.id ?? null` derivation (summarize.js) pick it up unchanged.
  const { termsUpserted, warning } = await persistReferencedTermsGracefully(client, runId, {
    bill: { identifier, id: billId }, summaryId, referencedTerms,
  });

  if (decision.action === 'leaveUnverified') {
    return {
      outcome: 'unverifiedDraft', billId, summaryId, termsUpserted, warning,
    };
  }

  const { error: verErr } = await client.from('summary_verifications').insert({
    summary_id: summaryId, kind: 'support', verdicts: decision.verdicts, overall: decision.overall,
    model: verifierModelLabel, prompt_version: VERIFY_PROMPT_VERSION,
  });
  if (verErr) throw new Error(`summary_verifications insert failed for bill ${identifier}: ${verErr.message}`);

  // Completeness axis: its OWN row (migration 0020, kind='completeness') — never merged into the
  // support row above. Only written when classifyRecordItem actually ran assessCompleteness
  // (decision.completeness set); the 'completeness_check_absent' flagDraft path carries no
  // completeness payload at all, so nothing to write here for it — an honest absence, not a
  // fabricated one.
  if (decision.completeness) {
    // corroborated-thin publishes carry the corroborator's list in the SAME row (spec
    // 2026-08-18) — the receipt trail must show the higher evidence bar was met. Additive keys
    // only; readers of the existing shape are unaffected.
    const completenessVerdicts = decision.completenessCorroboratedThin
      ? { ...decision.completeness, corroborated_thin: true, corroboration_key_provisions: decision.completenessCorroboration?.key_provisions ?? null }
      : decision.completeness;
    const { error: compErr } = await client.from('summary_verifications').insert({
      summary_id: summaryId, kind: 'completeness', verdicts: completenessVerdicts, overall: decision.completenessOverall,
      model: verifierModelLabel, prompt_version: COMPLETENESS_PROMPT_VERSION,
    });
    if (compErr) throw new Error(`summary_verifications (completeness) insert failed for bill ${identifier}: ${compErr.message}`);
  }

  if (decision.action === 'flagDraft') {
    await retireSupersededDrafts(client, decision, summaryId);
    return {
      // gateReason (final whole-branch review, findings 4 & 5): non-null only when a MECHANICAL
      // gate — not the verifier's own verdicts — is what refused publication. Carried out of here
      // so main() can print it: a gate that fires silently is a gate nobody can audit.
      outcome: 'flaggedDraft', billId, summaryId, termsUpserted, warning, gateReason: decision.gateReason ?? null,
    };
  }

  await autoPublishSummary(client, summaryId, verifierModelLabel);
  await retireSupersededDrafts(client, decision, summaryId);
  return {
    outcome: 'published', billId, summaryId, termsUpserted, warning,
  };
}

// retireSupersededDrafts (--replace-drafts lane): once the replacement row exists, the old drafts
// move to 'rejected' — the status that already means "redo the prose; re-eligible" — with a note
// naming the replacement. Runs strictly AFTER the new row (and its verification rows) are
// committed, so a failure here can only ever leave a redundant-but-honest extra draft behind,
// never a bill with no summary at all.
async function retireSupersededDrafts(client, decision, newSummaryId) {
  const ids = decision.supersedes;
  if (!ids || ids.length === 0) return;
  const { error: updErr } = await client.from('summaries')
    .update({ status: 'rejected' })
    .in('id', ids)
    .eq('status', 'draft'); // only ever retire what is STILL a draft — never race a human decision
  if (updErr) throw new Error(`superseded-draft retire failed for bill ${decision.identifier}: ${updErr.message}`);
  for (const oldId of ids) {
    const { error: noteErr } = await client.from('summary_notes').insert({
      summary_id: oldId, action: mapNoteAction('reject'), note: `superseded by re-recorded summary ${newSummaryId} (--replace-drafts)`,
    });
    if (noteErr) throw new Error(`superseded-draft note failed for summary ${oldId}: ${noteErr.message}`);
  }
}

// recordOne: classify then apply — the live (non-dry-run) path for a single record item.
// --dry-run runs classifyRecordItem alone (see main() below) so preview and live can never
// silently drift apart; there is exactly one decision function, not two.
export async function recordOne(client, runId, item, options = {}) {
  const decision = await classifyRecordItem(client, item, options);
  return applyRecordDecision(client, runId, decision);
}

function describeDecision(decision) {
  return {
    bill_id: decision.billId,
    identifier: decision.identifier ?? decision.billId,
    would: OUTCOME_BY_ACTION[decision.action],
    summary_id: decision.action === 'alreadySummarized' ? decision.summaryId : null,
    // gate_reason (final whole-branch review, findings 4 & 5): why a mechanical gate refused to
    // publish, surfaced in the --dry-run preview too — the operator sees the same reason before a
    // live run that the live run itself will report.
    gate_reason: decision.gateReason ?? null,
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
        preview.push(describeDecision(await classifyRecordItem(client, item, { replaceDrafts: args.replaceDrafts })));
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
  // gated (final whole-branch review, findings 4 & 5): every item a MECHANICAL gate refused to
  // publish, with its reason. Not a failure (the draft was still written, honestly, as a flagged
  // draft) and not silence either — a gate whose reason never reaches the operator's output is a
  // gate nobody can audit or act on.
  const gated = [];
  const outcomes = {
    alreadySummarized: 0, unverifiedDraft: 0, flaggedDraft: 0, published: 0,
  };
  try {
    for (const item of results) {
      try {
        const result = await recordOne(client, runId, item, { replaceDrafts: args.replaceDrafts });
        outcomes[result.outcome] += 1;
        if (result.gateReason) gated.push({ bill_id: result.billId, summary_id: result.summaryId, reason: result.gateReason });
      } catch (err) {
        if (isTypedFailure(err)) failures.push({ bill_id: item?.bill_id ?? null, error: err.name, message: err.message });
        else throw err;
      }
    }

    const counts = {
      total: results.length, ...outcomes, gated: gated.length, failures: failures.length,
    };
    const status = failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, failures, gated });
    console.log(JSON.stringify({
      mode: 'live', run_id: runId, status, counts, gated, failures,
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
