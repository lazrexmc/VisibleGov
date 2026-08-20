import {
  getClient, openRun, closeRun, isMissingRelationError, selectAll,
} from '../lib/db.js';
import { getAnthropicClient, SummaryRefusedError, SummaryTruncatedError } from '../lib/summarizer.js';
import { assessVerdicts, VerificationIncompleteError } from '../lib/verifier.js';
import {
  MODEL, PROMPT_VERSION, authorGloss, fetchGlossSource, splitGlossSentences,
  GLOSS_VERIFIER_MODEL, GLOSS_VERIFY_PROMPT_VERSION, verifyGloss,
  EmptyGlossError, assertGlossNotEmpty, QuoteNotVerbatimError, assertQuoteVerbatim,
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
// Exported (Minor finding 4) so tests can pin what belongs here — in particular, that
// MoBotPageError and MoPageIdentityError (src/adapters/mo-statutes.js) are DELIBERATELY absent:
// per spec §4, a bot-detection page is a whole-run hard stop (abort honestly, never retry-hammer
// or count-and-continue past it), and a page-identity mismatch gets the same treatment — both
// propagate up through fetchGlossSource uncaught and abort the batch, rather than being recorded
// in failures[] and continued past like the types actually listed below.
// QuoteNotVerbatimError (2026-08-19 probe finding) is deliberately IN this list: a receipt
// quote that isn't a verbatim excerpt substring is a per-term authoring flaw — counted,
// retryable next run — never a run-level stop.
export const FAILURE_TYPES = [
  OversizeExcerptError, UscSectionNotFoundError, SubsectionNotFoundError,
  SourceFetchError, RateLimitedError,
  SummaryRefusedError, SummaryTruncatedError, VerificationIncompleteError, EmptyGlossError,
  QuoteNotVerbatimError,
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
// alreadyGlossed (gloss_md already set — nothing to do), rejected (status='rejected' and never
// glossed — see below), and candidates (needs_mapping=false, gloss_md still null, status!=
// 'rejected' — eligible to fetch+author+verify). The four buckets are mutually exclusive and
// exhaustive: Task 4 never sets gloss_md, and only this stage ever does, and only for
// needs_mapping=false, non-rejected rows — a row can never land in more than one bucket.
//
// Final review fix wave (Important finding 1): a term Lance REJECTS on the review page (Task 6 —
// e.g. a bogus extraction that isn't really a statute/act/agency/program/public_law reference at
// all) previously had status='rejected' but was still keyed purely on needs_mapping=false &&
// gloss_md=null, so it silently re-entered `candidates` on the very next run — a billed
// author+verify call, and a gloss written onto a row Lance had already thrown out. status is now
// checked BEFORE the needs_mapping/candidates split (but AFTER the gloss_md check, so a term
// approved-then-later-rejected that already has a gloss stays in alreadyGlossed, the existing,
// separately-tracked no-re-gloss-path gap — see the ledger's "Lance decision list" entry).
//
// Deliberately the INVERSE of summarize.js's rejection semantics (planWork's own
// ALREADY_SUMMARIZED_STATUSES set excludes 'rejected' on purpose, so a rejected SUMMARY regenerates
// on the next run — Lance's prose can always be redone from the same bill text). A rejected
// glossary TERM means something categorically different: the extraction itself was bogus, not
// that a correctly-identified term's gloss text needs a rewrite — so here rejection means "leave
// this alone," the opposite instinct from summaries, and skipping is the correct, honest behavior.
export function planGlossing(terms) {
  const needsMapping = [];
  const alreadyGlossed = [];
  const rejected = [];
  const candidates = [];
  for (const t of terms) {
    if (t.gloss_md) {
      alreadyGlossed.push(t);
    } else if (t.status === 'rejected') {
      rejected.push(t);
    } else if (t.needs_mapping) {
      needsMapping.push(t);
    } else {
      candidates.push(t);
    }
  }
  return { needsMapping, alreadyGlossed, rejected, candidates };
}

// ---- DB-facing helpers ----

// Returns {terms, tableMissing}. Missing-table tolerance applies ONLY when dryRun is true (same
// convention as verify.js's loadAlreadyVerifiedIds / extract-terms.js's loadExtractedSummaryIds —
// migration 0007 is still an unapplied draft). In live mode the error propagates and hard-fails
// the run before any model calls are made — 0007 is the gate, not something live mode works around.
//
// Final-review finding 1 sweep (glossary-trust-surface, controller-adjudicated in-scope): this was
// a bare, unbounded .select() over the SAME glossary_terms table auto-publish-glossary.js's
// loadDraftTerms reads (401 live rows and growing with every summarized bill — it WILL cross
// Supabase's 1000-row cap). Truncation here has the identical consequence class: a term past the
// cap is silently invisible to planGlossing, so it would never get glossed at all, stuck as a bare
// stub forever with no error, no count, nothing to signal why. Routed through selectAll like every
// other glossary_terms/glossary_verifications/glossary_notes read in this codebase. Exported (was
// module-private) so it's directly testable, matching loadDraftTerms's own shape.
export async function loadAllTerms(client, dryRun) {
  const { data, error } = await selectAll(client, GLOSSARY_TERMS_TABLE, 'id,term,kind,citation,gloss_md,needs_mapping,status', {
    filter: (q) => q.order('created_at', { ascending: true }),
  });
  if (error) {
    if (dryRun && isMissingRelationError(error, GLOSSARY_TERMS_TABLE)) {
      return { terms: [], tableMissing: true };
    }
    throw new Error(`${GLOSSARY_TERMS_TABLE} lookup failed: ${error.message}`);
  }
  return { terms: data ?? [], tableMissing: false };
}

// persistGloss: the two dependent writes for a completed gloss, and ONLY those two writes —
// deliberately factored out of glossOne so this write ORDER (and its effect on retry eligibility)
// is unit-testable with a fake `client` alone, no model/network faking required.
//
// Fix round 2 (Important review finding): glossary_verifications is written FIRST, glossary_terms
// SECOND — the reverse of this task's original order. Mirrors extract-terms.js's self-healing
// pattern, where retry eligibility (planExtraction) is keyed off the LAST of its two writes
// (summary_terms), not the first. planGlossing (below) keys `alreadyGlossed` off
// glossary_terms.gloss_md alone; under the ORIGINAL order (glossary_terms updated before
// glossary_verifications inserted), a transient failure on the second write would leave gloss_md
// already committed with NO backing glossary_verifications row — planGlossing would then route
// that term to alreadyGlossed forever, a permanently ungrounded gloss that no future run would
// ever retry (cuts against trust-model v2's audit trail). With verifications written first,
// gloss_md can only ever become non-null once its verification row already exists — so a term
// stays retry-eligible (gloss_md still null) for as long as EITHER write hasn't succeeded, the
// same shape extract-terms.js already has. See tests/gloss-cli.test.js for the failure-then-retry
// proof.
export async function persistGloss(client, runId, term, { glossMd, supportedByQuote, sourceUrl, sourceHash, verdicts, overall }) {
  const { error: verErr } = await client.from(GLOSSARY_VERIFICATIONS_TABLE).insert({
    term_id: term.id, verdicts, overall,
    model: GLOSS_VERIFIER_MODEL, prompt_version: GLOSS_VERIFY_PROMPT_VERSION,
  });
  if (verErr) throw new Error(`${GLOSSARY_VERIFICATIONS_TABLE} insert failed for term ${term.id}: ${verErr.message}`);

  // supported_by_quote (fix round 2, promoted Minor review finding): the author model's claimed
  // supporting quote from the source excerpt, persisted alongside gloss_md for display at review
  // time — previously part of GLOSS_SCHEMA's required output but never written anywhere (dead
  // output). Deliberately NOT added to migration 0007's published-completeness CHECK: it always
  // co-arrives with gloss_md in this same update, so a separate gate on it would be redundant.
  const { error: updErr } = await client.from(GLOSSARY_TERMS_TABLE).update({
    gloss_md: glossMd, supported_by_quote: supportedByQuote, source_url: sourceUrl, source_hash: sourceHash,
    model: MODEL, prompt_version: PROMPT_VERSION, run_id: runId,
  }).eq('id', term.id);
  if (updErr) throw new Error(`${GLOSSARY_TERMS_TABLE} update failed for term ${term.id}: ${updErr.message}`);
}

async function glossOne(client, runId, term, anthropic, fetchSource = fetchGlossSource) {
  const { url, excerptText, hash } = await fetchSource(term.citation);
  const { json: glossJson } = await authorGloss(anthropic, { term: term.term, excerptText });

  // Mechanical receipts gate (2026-08-19 probe finding), BEFORE any verify spend: the public
  // supported_by_quote must be a verbatim (whitespace-collapsed) substring of the excerpt —
  // see assertQuoteVerbatim's own comment. A gated term is a counted, retryable failure.
  assertQuoteVerbatim(glossJson.supported_by_quote, excerptText, { term: term.term, termId: term.id });

  const sentences = splitGlossSentences(glossJson.gloss_md);
  // Fix wave (Minor finding 4): empty-gloss guard, BEFORE any verify call — '' is schema-valid
  // per GLOSS_SCHEMA (no minLength), so nothing upstream flags it; see assertGlossNotEmpty's own
  // comment (glosser.js) for why this can't be left to assessVerdicts' vacuous zero-sentence pass.
  assertGlossNotEmpty(sentences, { term: term.term, termId: term.id });

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

  await persistGloss(client, runId, term, {
    glossMd: glossJson.gloss_md, supportedByQuote: glossJson.supported_by_quote,
    sourceUrl: url, sourceHash: hash, verdicts: verifyJson.verdicts, overall,
  });

  return { overall };
}

// ---- the per-term batch loop (extracted so the abort path is directly testable) ----
//
// F6 (post-audit fix wave, 2026-08-19) — gloss-abort observability. A non-FAILURE_TYPES error is a
// WHOLE-RUN hard stop by design (spec §4: a bot-detection page must abort honestly, never
// retry-hammer or count-and-continue). But the run record only ever carried the error string, and
// MoBotPageError's message names the SOURCE, not which term triggered it — so an aborted run left
// no trace of the culprit, and the operator had to re-derive it by hand. The culprit term is now
// attached to the error and surfaced in both the console line and the closeRun 'failed' detail.
//
// Operator remedy for a citation that pages the bot detector PERMANENTLY (e.g. a section a bill
// created that the revisor does not serve yet): set that term's status='rejected' on the review
// page. planGlossing already routes rejected terms out of `candidates`, so the next run skips it
// instead of aborting on it again. Nothing here retries, widens, or guesses at such a citation.
export async function glossCandidates(client, runId, candidates, anthropic, { fetchSource } = {}) {
  const failures = [];
  let glossed = 0;
  let flagged = 0;
  for (const term of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential billed calls, one term at a time
      const { overall } = await glossOne(client, runId, term, anthropic, fetchSource);
      glossed += 1;
      if (overall === 'flagged') flagged += 1;
    } catch (err) {
      if (isTypedFailure(err)) {
        failures.push({ id: term.id, term: term.term, error: err.name, message: err.message });
      } else {
        if (err && typeof err === 'object') err.term = { id: term.id, citation: term.citation };
        console.error(
          `HARD STOP on term ${term.id} (${term.term} / ${term.citation}): ${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`,
        );
        throw err;
      }
    }
  }
  return { glossed, flagged, failures };
}

// failedRunDetail: the closeRun 'failed' payload, factored out so the "name the culprit" contract
// is pinned by a test rather than living inline in main() where nothing can reach it.
export function failedRunDetail(err) {
  return { error: String(err), ...(err?.term ? { term: err.term } : {}) };
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
  const { needsMapping, alreadyGlossed, rejected, candidates } = planGlossing(terms);

  if (args.dryRun) {
    const out = {
      mode: 'dry-run',
      counts: {
        terms: terms.length,
        needsMapping: needsMapping.length,
        alreadyGlossed: alreadyGlossed.length,
        rejected: rejected.length,
        candidates: candidates.length,
      },
      // status included (fix wave, Important finding 1) so a reviewer can see AT the approval
      // gate that nothing in this list is status='rejected' — planGlossing already guarantees it,
      // but the whole point of the dry-run/cost-estimate gate is letting a human verify that
      // before any billed call runs, not just trust the code silently.
      candidates: candidates.map((t) => ({ id: t.id, term: t.term, kind: t.kind, citation: t.citation, status: t.status })),
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
  try {
    const { glossed, flagged, failures } = await glossCandidates(client, runId, candidates, anthropic);

    const counts = {
      candidates: candidates.length, glossed, flagged,
      needsMappingSkipped: needsMapping.length, rejectedSkipped: rejected.length, failures: failures.length,
    };
    const status = failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, failures });
    console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts, failures }, null, 2));
    if (failures.length > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', failedRunDetail(err));
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
