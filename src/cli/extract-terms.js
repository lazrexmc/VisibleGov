import { getClient, openRun, closeRun, insertIfAbsent, isMissingRelationError } from '../lib/db.js';
import { pickBillText } from '../review/server.js';
import { parseCitation } from '../adapters/uscode.js';
import {
  getAnthropicClient, SUMMARY_SCHEMA, MAX_TEXT_CHARS,
  OversizeTextError, SummaryRefusedError, SummaryTruncatedError,
} from '../lib/summarizer.js';

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

const SUMMARY_TERMS_TABLE = 'summary_terms';
const GLOSSARY_TERMS_TABLE = 'glossary_terms';

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

export const EXTRACT_SYSTEM_PROMPT = [
  'You extract ONLY the statutes, acts, agencies, programs, and public laws that a piece of United States legislative bill text itself names or cites.',
  'This is facts-only extraction, nothing else: extract only names/citations the bill text itself prints; never infer a name, kind, or citation the text does not state.',
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

// normalizeTermText: TRIVIAL normalization ONLY — trim + collapse internal whitespace runs to a
// single space. Controller ruling 2, ledgered from Task 1's review: never rewrite the term text
// itself (verbatim-from-bill discipline carries over from extraction the same way it governs
// summarizer.js's referenced_terms rule). This means (kind, term) dedup for unmapped terms is
// exact-string only — a term printed two different ways across two bills mints two distinct
// glossary_terms rows. Accepted and documented, not a bug to "fix" with fuzzier normalization.
export function normalizeTermText(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

// upsertKeyFor: the branched upsert decision (ledgered from Task 1's review — see migration
// 0007's comments on glossary_terms_unmapped_uidx). glossary_terms has two unique paths: the
// base `unique (kind, citation)` constraint when parseCitation resolves citation_raw to a real
// USC cite, and the partial index `(kind, term) where citation is null` when it can't. Which
// applies is decided ENTIRELY by whether parseCitation resolves — never by kind, never a guess.
// Pure: does not itself build the normalized citation string or touch the DB (see
// upsertGlossaryTerm below for that).
export function upsertKeyFor(term) {
  const parsed = parseCitation(term.citation_raw);
  if (parsed) return { by: 'citation', needs_mapping: false };
  return { by: 'term', needs_mapping: true };
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

async function findExistingGlossaryTerm(client, { kind, citation, term }) {
  let query = client.from(GLOSSARY_TERMS_TABLE).select('id').eq('kind', kind);
  query = citation === null ? query.is('citation', null).eq('term', term) : query.eq('citation', citation);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`${GLOSSARY_TERMS_TABLE} lookup failed: ${error.message}`);
  return data;
}

// upsertGlossaryTerm: branches per upsertKeyFor, and the two branches need DIFFERENT DB
// strategies to stay correct against Postgres's actual constraint shapes (real finding, not a
// style choice):
//
// - by:'citation' targets the base `unique (kind, citation)` constraint — a normal, non-partial
//   unique index, so insertIfAbsent's ON CONFLICT(kind,citation) DO NOTHING path (lib/db.js)
//   works exactly as it does everywhere else in this codebase.
// - by:'term' targets glossary_terms_unmapped_uidx, a PARTIAL unique index — `(kind, term) WHERE
//   citation IS NULL`. Postgres only lets ON CONFLICT infer a partial index when the conflict
//   clause repeats that index's own WHERE predicate; PostgREST's upsert `on_conflict` parameter
//   (what insertIfAbsent sends) is a bare column list with no way to express a WHERE clause, so
//   ON CONFLICT(kind,term) can never resolve to this partial index at all — Postgres would
//   reject it outright ("no unique or exclusion constraint matching"). This is the SAME shape as
//   ingest.js's findExistingTerm/upsertTerm working around a nullable start_date breaking
//   ON CONFLICT dedup: manual check-then-insert instead of insertIfAbsent for this branch only.
async function upsertGlossaryTerm(client, runId, rawTerm) {
  const key = upsertKeyFor(rawTerm);
  const term = normalizeTermText(rawTerm.term);
  const kind = rawTerm.kind;

  if (key.by === 'citation') {
    const parsed = parseCitation(rawTerm.citation_raw);
    const citation = `${parsed.title} U.S.C. ${parsed.section}`;
    await insertIfAbsent(client, GLOSSARY_TERMS_TABLE,
      [{ term, kind, citation, status: 'draft', needs_mapping: false, run_id: runId }], 'kind,citation');
    const existing = await findExistingGlossaryTerm(client, { kind, citation, term: null });
    if (!existing) throw new Error(`${GLOSSARY_TERMS_TABLE} row for ${kind}/${citation} missing immediately after upsert`);
    return existing.id;
  }

  const existing = await findExistingGlossaryTerm(client, { kind, citation: null, term });
  if (existing) return existing.id;
  const { data, error } = await client.from(GLOSSARY_TERMS_TABLE)
    .insert({ term, kind, citation: null, status: 'draft', needs_mapping: true, run_id: runId })
    .select('id').single();
  if (error) throw new Error(`${GLOSSARY_TERMS_TABLE} insert failed for ${kind}/"${term}": ${error.message}`);
  return data.id;
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

  let termsUpserted = 0;
  for (const rawTerm of json.referenced_terms ?? []) {
    const termId = await upsertGlossaryTerm(client, runId, rawTerm);
    await insertIfAbsent(client, SUMMARY_TERMS_TABLE, [{ summary_id: summary.id, term_id: termId }], 'summary_id,term_id');
    termsUpserted += 1;
  }
  return { termsUpserted };
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
