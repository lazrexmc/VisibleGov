import { getClient, openRun, closeRun, isMissingRelationError } from '../lib/db.js';
import { getAnthropicClient, SummaryRefusedError, SummaryTruncatedError } from '../lib/summarizer.js';
import { assessVerdicts, VerificationIncompleteError } from '../lib/verifier.js';
import {
  MODEL, PROMPT_VERSION, authorGloss, fetchGlossSource, splitGlossSentences,
  GLOSS_VERIFIER_MODEL, GLOSS_VERIFY_PROMPT_VERSION, verifyGloss,
} from '../lib/glosser.js';
import { OversizeExcerptError, UscSectionNotFoundError, SubsectionNotFoundError } from '../adapters/uscode.js';
import { SourceFetchError, RateLimitedError } from '../lib/errors.js';

// Glosser CLI (glossary plan Task 5): for every glossary_terms row Task 4 stubbed in
// (needs_mapping=false, gloss_md still null), fetch the term's own official source text,
// author a 1-2 sentence gloss (claude-opus-5), adversarially verify it (claude-sonnet-5), and
// write gloss_md/source_url/source_hash + a glossary_verifications row. needs_mapping=true rows
// are SKIPPED with an honest count (controller ruling 1) — they await manual curation on the
// review page (Task 6), never guessed at.
export const GLOSS_COST_PER_TERM_USD = 0.16; // per the plan's own estimate (authoring + verify)

const GLOSSARY_TERMS_TABLE = 'glossary_terms';
const GLOSSARY_VERIFICATIONS_TABLE = 'glossary_verifications';

// Reused typed-failure vocabulary: uscode.js's source-fetch failures (including the oversize-
// without-cited-subsection skip — controller ruling 2's final clause), http.js's generic source-
// fetch failures (network/429), and the same model-response/verification-completeness failures
// verify.js and extract-terms.js already established. A term hitting any of these is recorded in
// failures[] and the batch continues — never a silent drop, never an aborted run.
const FAILURE_TYPES = [
  OversizeExcerptError, UscSectionNotFoundError, SubsectionNotFoundError,
  SourceFetchError, RateLimitedError,
  SummaryRefusedError, SummaryTruncatedError, VerificationIncompleteError,
];

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

// planGlossing: partitions ALL glossary_terms rows into needsMapping (skipped, awaiting curation),
// alreadyGlossed (gloss_md already set — nothing to do), and candidates (needs_mapping=false,
// gloss_md still null — eligible to fetch+author+verify). The three buckets are mutually exclusive
// and exhaustive: Task 4 never sets gloss_md, and only this stage ever does, and only for
// needs_mapping=false rows — a row can never land in both needsMapping and alreadyGlossed.
export function planGlossing(terms) {
  const needsMapping = [];
  const alreadyGlossed = [];
  const candidates = [];
  for (const t of terms) {
    if (t.gloss_md) {
      alreadyGlossed.push(t);
    } else if (t.needs_mapping) {
      needsMapping.push(t);
    } else {
      candidates.push(t);
    }
  }
  return { needsMapping, alreadyGlossed, candidates };
}

// ---- DB-facing helpers ----

// Returns {terms, tableMissing}. Missing-table tolerance applies ONLY when dryRun is true (same
// convention as verify.js's loadAlreadyVerifiedIds / extract-terms.js's loadExtractedSummaryIds —
// migration 0007 is still an unapplied draft). In live mode the error propagates and hard-fails
// the run before any model calls are made — 0007 is the gate, not something live mode works around.
async function loadAllTerms(client, dryRun) {
  const { data, error } = await client
    .from(GLOSSARY_TERMS_TABLE)
    .select('id,term,kind,citation,gloss_md,needs_mapping,status')
    .order('created_at', { ascending: true });
  if (error) {
    if (dryRun && isMissingRelationError(error, GLOSSARY_TERMS_TABLE)) {
      return { terms: [], tableMissing: true };
    }
    throw new Error(`${GLOSSARY_TERMS_TABLE} lookup failed: ${error.message}`);
  }
  return { terms: data ?? [], tableMissing: false };
}

async function glossOne(client, runId, term, anthropic) {
  const { url, excerptText, hash } = await fetchGlossSource(term.citation);
  const { json: glossJson } = await authorGloss(anthropic, { term: term.term, excerptText });

  const sentences = splitGlossSentences(glossJson.gloss_md);
  const { json: verifyJson } = await verifyGloss(anthropic, { term: term.term, sentences, excerptText });

  // Mechanical completeness gate (same discipline as verify.js's verifyOne): overall is DERIVED
  // here, never trusted from the model's own json.overall. An incomplete/inconsistent verdict set
  // writes nothing — the term stays honestly ungloosed rather than gaining a fabricated 'clean'.
  const { complete, overall } = assessVerdicts(verifyJson.verdicts, sentences.length);
  if (!complete) {
    throw new VerificationIncompleteError(
      `gloss for "${term.term}" (id ${term.id}): verifier returned an incomplete or inconsistent verdict set for ${sentences.length} sentence(s)`,
      { term: term.term, termId: term.id, sentenceCount: sentences.length },
    );
  }

  const { error: updErr } = await client.from(GLOSSARY_TERMS_TABLE).update({
    gloss_md: glossJson.gloss_md, source_url: url, source_hash: hash,
    model: MODEL, prompt_version: PROMPT_VERSION, run_id: runId,
  }).eq('id', term.id);
  if (updErr) throw new Error(`${GLOSSARY_TERMS_TABLE} update failed for term ${term.id}: ${updErr.message}`);

  const { error: verErr } = await client.from(GLOSSARY_VERIFICATIONS_TABLE).insert({
    term_id: term.id, verdicts: verifyJson.verdicts, overall,
    model: GLOSS_VERIFIER_MODEL, prompt_version: GLOSS_VERIFY_PROMPT_VERSION,
  });
  if (verErr) throw new Error(`${GLOSSARY_VERIFICATIONS_TABLE} insert failed for term ${term.id}: ${verErr.message}`);

  return { overall };
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

  const { terms, tableMissing } = await loadAllTerms(client, args.dryRun);
  const { needsMapping, alreadyGlossed, candidates } = planGlossing(terms);

  if (args.dryRun) {
    const out = {
      mode: 'dry-run',
      counts: {
        terms: terms.length,
        needsMapping: needsMapping.length,
        alreadyGlossed: alreadyGlossed.length,
        candidates: candidates.length,
      },
      candidates: candidates.map((t) => ({ id: t.id, term: t.term, kind: t.kind, citation: t.citation })),
    };
    if (tableMissing) out.note = `(${GLOSSARY_TERMS_TABLE} missing — migration 0007 not applied; treating as zero terms)`;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const estimate = (candidates.length * GLOSS_COST_PER_TERM_USD).toFixed(2);
  console.log(`Cost estimate: ${candidates.length} term(s) x ~$${GLOSS_COST_PER_TERM_USD.toFixed(2)} = ~$${estimate} in live model calls (authoring + verify).`);

  // Mechanical per-run approval gate (controller ruling 1) — same standing policy as
  // GOLDEN_CHECK_APPROVED in golden.js and this same GLOSS_RUN_APPROVED gate in extract-terms.js:
  // no live, billed Anthropic call runs without Lance's explicit per-run opt-in.
  if (process.env.GLOSS_RUN_APPROVED !== 'yes') {
    console.log(
      'BLOCKED: glossing makes live, billed Anthropic API calls (author + verify per term). Per the owner\'s standing policy, '
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

  const runId = await openRun(client, 'gloss');
  const failures = [];
  try {
    let glossed = 0;
    let flagged = 0;
    for (const term of candidates) {
      try {
        const { overall } = await glossOne(client, runId, term, anthropic);
        glossed += 1;
        if (overall === 'flagged') flagged += 1;
      } catch (err) {
        if (isTypedFailure(err)) {
          failures.push({ id: term.id, term: term.term, error: err.name, message: err.message });
        } else {
          throw err;
        }
      }
    }

    const counts = {
      candidates: candidates.length, glossed, flagged,
      needsMappingSkipped: needsMapping.length, failures: failures.length,
    };
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
