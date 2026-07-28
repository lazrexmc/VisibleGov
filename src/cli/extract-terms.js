import { getClient, openRun, closeRun, isMissingRelationError } from '../lib/db.js';
import { pickBillText } from '../review/server.js';
import {
  getAnthropicClient, SUMMARY_SCHEMA, MAX_TEXT_CHARS,
  OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
} from '../lib/summarizer.js';
import {
  normalizeTermText, upsertKeyFor, normalizeCitation, persistReferencedTerms, SUMMARY_TERMS_TABLE,
} from '../lib/glossary-terms.js';

// Fix wave (final review, Important finding 2): normalizeTermText/upsertKeyFor/normalizeCitation
// and the upsert/join logic itself moved to src/lib/glossary-terms.js so summarize.js can reuse
// them (see that file's createDraftSummary). Re-exported here UNCHANGED so every existing test
// import (`from '../src/cli/extract-terms.js'`) and this file's own behavior stay exactly as they
// were — this backfill's own tests were the review's explicit bar: "behavior unchanged".
export { normalizeTermText, upsertKeyFor, normalizeCitation };

// Extraction backfill (glossary plan Task 4): for EXISTING summaries that were generated before
// (or without) referenced_terms ever being persisted, run a small, separate extraction-only call
// against the same stored bill text and populate glossary_terms/summary_terms retroactively.
// Deliberately claude-sonnet-5 (not opus-5, summarizer.js's MODEL) and its own prompt-version
// track — this is a cheap, narrow extraction pass, not a full re-summarization; the two must be
// able to version independently.
export const EXTRACT_MODEL = 'claude-sonnet-5';
export const EXTRACT_PROMPT_VERSION = 'v1';
// Tiny output on purpose: a handful of {term, kind, citation_raw} triples, nowhere near
// summarizer.js's MAX_OUTPUT_TOKENS (16000) for a full what_it_does/stated_purpose summary.
export const EXTRACT_MAX_OUTPUT_TOKENS = 4000;
export const EXTRACT_COST_PER_SUMMARY_USD = 0.03; // per the plan's own estimate (~25 x ~$0.03 ~= $0.75)

// Mirrors SUMMARY_SCHEMA's referenced_terms shape by REFERENCE (controller ruling 1: "JSON-schema
// output mirroring SUMMARY_SCHEMA's referenced_terms shape") — not a re-typed copy, so the two
// can never silently drift apart. The wrapper is the only new thing: a top-level object whose
// only property is the same referenced_terms array summarizer.js already extracts inline.
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['referenced_terms'],
  properties: {
    referenced_terms: SUMMARY_SCHEMA.properties.referenced_terms,
  },
};

// Completeness AND scope, both explicit (Task 3 test bar — see summarizer.js's SYSTEM_PROMPT,
// which this line deliberately mirrors verbatim): "for every ... the bill text itself names or
// cites" is the completeness half (don't skip any that are there); "ONLY ... the bill text
// itself prints; never infer" is the scope half (don't invent any that aren't).
export const EXTRACT_SYSTEM_PROMPT = [
  'You extract referenced terms from United States legislative bill text for a civic-transparency glossary pipeline.',
  'For every statute, act, agency, program, or public law the bill text itself names or cites, record {term, kind, citation_raw}.',
  'This is facts-only extraction, nothing else: extract ONLY names/citations the bill text itself prints; never infer a name, kind, or citation the text does not state.',
  "citation_raw is verbatim from the bill text (e.g. '42 U.S.C. 1396b'), or an empty string if the bill text names the term without printing a citation for it.",
  'If the bill text prints no such terms, return an empty array for referenced_terms.',
].join('\n');

export function buildExtractUserMessage(identifier, title, text) {
  return `Bill ${identifier} — ${title}\n\n<bill_text>\n${text}\n</bill_text>\n\nExtract referenced_terms per your rules.`;
}

// extractTerms: the extraction-only model call. Same typed-failure shapes as summarizer.js
// (reused, not re-declared — verifier.js does the same for its own non-summary call) since these
// names describe generic model-response outcomes (refusal/truncation/oversize input), not
// anything specific to full-summary generation.
export async function extractTerms(client, { identifier, title, text }) {
  if (text.length > MAX_TEXT_CHARS) {
    throw new OversizeTextError(`bill text ${text.length} chars exceeds ${MAX_TEXT_CHARS}; will not truncate silently`, { identifier, length: text.length });
  }
  const response = await client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: EXTRACT_MAX_OUTPUT_TOKENS,
    system: EXTRACT_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    messages: [{ role: 'user', content: buildExtractUserMessage(identifier, title, text) }],
  });
  if (response.stop_reason === 'refusal') {
    throw new SummaryRefusedError(`model declined to extract terms for ${identifier}`, { identifier });
  }
  if (response.stop_reason === 'max_tokens') {
    throw new SummaryTruncatedError(`extraction for ${identifier} hit max_tokens — raise the cap or reduce input`, { identifier });
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new SummaryTruncatedError(`no text content returned for ${identifier}`, { identifier });
  }
  const json = JSON.parse(textBlock.text);
  return { json };
}

const FAILURE_TYPES = [OversizeTextError, SummaryRefusedError, SummaryTruncatedError];

function isTypedFailure(err) {
  return FAILURE_TYPES.some((T) => err instanceof T);
}

export function parseArgs(argv) {
  const out = { dryRun: false };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') {
      out.dryRun = true;
      i += 1;
      continue;
    }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// ---- pure parts ----

// planExtraction: summaries lacking ANY summary_terms row need extraction — a backfill over the
// whole summaries table (no status filter: which statutes/acts a bill's text cites is orthogonal
// to where that summary sits in the editorial pipeline). extractedSummaryIds is a Set<string> of
// summary_ids that already have at least one summary_terms row (empty if the table doesn't exist
// yet — see loadExtractedSummaryIds' dry-run tolerance below).
export function planExtraction(summaries, extractedSummaryIds) {
  return summaries.filter((s) => !extractedSummaryIds.has(s.id));
}

// ---- DB-facing helpers ----

async function loadAllSummaries(client) {
  const { data, error } = await client
    .from('summaries')
    .select('id,bill_id,status,bill_text_hash,created_at,bills(identifier,title)')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`summaries lookup failed: ${error.message}`);
  return data ?? [];
}

// Returns {extractedIds, tableMissing}. Missing-table tolerance applies ONLY when dryRun is true
// (same convention as verify.js's loadAlreadyVerifiedIds) — migration 0007 is not applied on the
// live DB yet (controller ruling 3), so summary_terms (and glossary_terms) don't exist there. In
// live mode the error propagates and hard-fails the run before any model calls are made — 0007
// is the gate, not something live mode silently works around.
async function loadExtractedSummaryIds(client, summaryIds, dryRun) {
  if (summaryIds.length === 0) return { extractedIds: new Set(), tableMissing: false };
  const { data, error } = await client
    .from(SUMMARY_TERMS_TABLE).select('summary_id').in('summary_id', summaryIds);
  if (error) {
    if (dryRun && isMissingRelationError(error, SUMMARY_TERMS_TABLE)) {
      return { extractedIds: new Set(), tableMissing: true };
    }
    throw new Error(`${SUMMARY_TERMS_TABLE} lookup failed: ${error.message}`);
  }
  return { extractedIds: new Set((data ?? []).map((r) => r.summary_id)), tableMissing: false };
}

async function extractOne(client, runId, summary, anthropic) {
  const identifier = summary.bills ? summary.bills.identifier : summary.bill_id;
  const title = summary.bills ? summary.bills.title : '';

  const { data: texts, error: tErr } = await client
    .from('bill_texts').select('content,content_hash,retrieved_at').eq('bill_id', summary.bill_id);
  if (tErr) throw new Error(`bill_texts lookup failed: ${tErr.message}`);
  const textRow = pickBillText(texts ?? [], summary.bill_text_hash);
  if (!textRow) throw new Error(`no bill text on file for bill ${summary.bill_id}`);

  const { json } = await extractTerms(anthropic, { identifier, title, text: textRow.content });

  // Fix wave (final review, Important finding 2): the upsert/join loop itself moved to
  // src/lib/glossary-terms.js's persistReferencedTerms (identical logic, same call order) so
  // summarize.js's own v2 path can reuse it — see that shared module's own header comment.
  // Behavior here is UNCHANGED: any DB error still propagates and hard-fails this summary's
  // extraction (isTypedFailure in main() below doesn't know about DB errors, same as before this
  // fix — extract-terms.js has always preferred a loud crash over a silently partial backfill).
  return persistReferencedTerms(client, runId, { summaryId: summary.id, referencedTerms: json.referenced_terms ?? [] });
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const summaries = await loadAllSummaries(client);
  const { extractedIds, tableMissing } = await loadExtractedSummaryIds(client, summaries.map((s) => s.id), args.dryRun);
  const candidates = planExtraction(summaries, extractedIds);

  if (args.dryRun) {
    const out = {
      mode: 'dry-run',
      counts: { summaries: summaries.length, alreadyExtracted: extractedIds.size, candidates: candidates.length },
      candidates: candidates.map((s) => ({ id: s.id, status: s.status, identifier: s.bills ? s.bills.identifier : null })),
    };
    if (tableMissing) out.note = `(${SUMMARY_TERMS_TABLE} missing — migration 0007 not applied; treating all summaries as candidates)`;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const estimate = (candidates.length * EXTRACT_COST_PER_SUMMARY_USD).toFixed(2);
  console.log(`Cost estimate: ${candidates.length} summary(ies) x ~$${EXTRACT_COST_PER_SUMMARY_USD.toFixed(2)} = ~$${estimate} in live model calls.`);

  // Mechanical per-run approval gate (controller ruling 1) — same standing policy as
  // GOLDEN_CHECK_APPROVED in golden.js: no live, billed Anthropic call runs without Lance's
  // explicit per-run opt-in, checked here regardless of whether credits currently exist.
  if (process.env.GLOSS_RUN_APPROVED !== 'yes') {
    console.log(
      'BLOCKED: extraction makes live, billed Anthropic API calls. Per the owner\'s standing policy, '
      + 'each run requires his explicit per-run approval — set GLOSS_RUN_APPROVED=yes to proceed.',
    );
    process.exitCode = 1;
    return;
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'ANTHROPIC_API_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const runId = await openRun(client, 'extract-terms');
  const failures = [];
  try {
    let extracted = 0;
    let termsUpserted = 0;
    for (const summary of candidates) {
      try {
        const result = await extractOne(client, runId, summary, anthropic);
        extracted += 1;
        termsUpserted += result.termsUpserted;
      } catch (err) {
        if (isTypedFailure(err)) {
          const identifier = summary.bills ? summary.bills.identifier : summary.bill_id;
          failures.push({ id: summary.id, identifier, error: err.name, message: err.message });
        } else {
          throw err;
        }
      }
    }

    const counts = { candidates: candidates.length, extracted, termsUpserted, failures: failures.length };
    const status = failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, failures });
    console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts, failures }, null, 2));
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
