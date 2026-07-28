import { getClient, openRun, closeRun, isMissingRelationError } from '../lib/db.js';
import { nextStatus, mapNoteAction, glossVerificationBadge, latestVerificationByTerm, isPublishCompletenessViolation } from '../review/server.js';

// Trust model v3 (docs/superpowers/specs/2026-07-28-trust-model-v3-design.md), mechanism 2, full
// automation (Lance's design-change call, 2026-07-28, superseding the mo-senate-adapter bulk-
// adjudication brief's owner-click bulk buttons): a glossary term whose latest adversarial
// verification derives 'clean' — the SAME mechanical badge derivation the review page itself uses
// (glossVerificationBadge), never a separate "auto" rule — moves draft -> approved -> published
// with zero human touch. Lance only ever sees FLAGGED items on the review page from here on. This
// CLI is also the one-time backfill for whatever clean drafts already exist when it's first run.
//
// Zero model calls, zero external fetches — pure DB reads/writes. No GOLDEN_CHECK/GLOSS_RUN_APPROVED
// -style spend gate applies (that standing policy is specifically about billed Anthropic calls;
// this makes none). The mechanical eligibility derivation below, plus the DB's own
// glossary_terms_published_complete CHECK as the unmovable final wall, are this run's real gates.

const GLOSSARY_TERMS_TABLE = 'glossary_terms';
const GLOSSARY_VERIFICATIONS_TABLE = 'glossary_verifications';
const GLOSSARY_NOTES_TABLE = 'glossary_notes';
const TARGET_STATUS = 'draft';

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

// planAutoPublish: partitions every status='draft' glossary_terms row into eligible (auto-
// publishable) and three honest, mutually-exclusive skip buckets — mirrors gloss.js's
// planGlossing exhaustive-partition style. Eligibility never touches a flag, an unverified item,
// or a needs_mapping row (no resolved citation/source to stand behind) — the exact same "clean"
// state a human reviewer would see via glossVerificationBadge, no separate/looser "auto" rule.
export function planAutoPublish(terms, latestVerificationByTermMap) {
  const eligible = [];
  const needsMapping = [];
  const noGloss = [];
  const flaggedOrUnverified = [];
  for (const t of terms) {
    if (t.needs_mapping) { needsMapping.push(t); continue; }
    if (!t.gloss_md) { noGloss.push(t); continue; }
    const verification = latestVerificationByTermMap.get(t.id) ?? null;
    const badge = glossVerificationBadge(verification);
    if (badge.state !== 'clean') { flaggedOrUnverified.push(t); continue; }
    eligible.push({ term: t, verification });
  }
  return { eligible, needsMapping, noGloss, flaggedOrUnverified };
}

// Recognized, expected failure: the publish hop's DB CHECK (glossary_terms_published_complete) is
// the final wall (controller ruling carried over from the review server's own
// isPublishCompletenessViolation) — a violation there is recorded per-item and the batch keeps
// going, the same isTypedFailure convention verify.js/gloss.js already use for expected,
// non-catastrophic failures. Any OTHER DB error is a genuine unexpected failure and propagates to
// abort the run, same as those sibling CLIs.
export class PublishCompletenessError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = 'PublishCompletenessError';
    Object.assign(this, meta);
  }
}

// glossary_notes.action stays inside the DB's existing CHECK — ('approved'|'edited'|'rejected'|
// 'published') only, per migration 0007 — mapNoteAction is reused UNCHANGED rather than adding a
// new 'auto-approved'/'auto-published' enum value a migration would be needed for. The "auto"
// distinction lives in the note TEXT instead, naming trust model v3 and the verifier that produced
// the clean quorum this run acted on.
function buildNote(verifierModel, actionWord) {
  return `trust-model v3: clean adversarial verification (${verifierModel}), ${actionWord}`;
}

// ---- DB-facing helpers ----

// Returns {terms, tableMissing}. Missing-table tolerance applies ONLY when dryRun is true — same
// convention as verify.js's loadAlreadyVerifiedIds / gloss.js's loadAllTerms: migration 0007 is
// the gate in live mode, never silently worked around.
export async function loadDraftTerms(client, dryRun) {
  const { data, error } = await client
    .from(GLOSSARY_TERMS_TABLE)
    .select('id,term,kind,citation,gloss_md,needs_mapping,status,created_at')
    .eq('status', TARGET_STATUS)
    .order('created_at', { ascending: true });
  if (error) {
    if (dryRun && isMissingRelationError(error, GLOSSARY_TERMS_TABLE)) {
      return { terms: [], tableMissing: true };
    }
    throw new Error(`${GLOSSARY_TERMS_TABLE} lookup failed: ${error.message}`);
  }
  return { terms: data ?? [], tableMissing: false };
}

// Full small-table select + in-JS filter (never .in('term_id', ids) over a large candidate set) —
// same header-overflow-avoidance pattern as the review server's handleGlossaryQueue, for the same
// reason (see that function's own comment: 400+ ids overflowed undici's 16KB header cap).
export async function loadLatestVerifications(client, termIds, dryRun) {
  if (termIds.length === 0) return { map: new Map(), tableMissing: false };
  const { data, error } = await client
    .from(GLOSSARY_VERIFICATIONS_TABLE)
    .select('term_id,overall,verdicts,model,created_at');
  if (error) {
    if (dryRun && isMissingRelationError(error, GLOSSARY_VERIFICATIONS_TABLE)) {
      return { map: new Map(), tableMissing: true };
    }
    throw new Error(`${GLOSSARY_VERIFICATIONS_TABLE} lookup failed: ${error.message}`);
  }
  const idSet = new Set(termIds);
  const rows = (data ?? []).filter((r) => idSet.has(r.term_id));
  return { map: latestVerificationByTerm(rows), tableMissing: false };
}

// autoPublishOne: the two-hop transition (draft -> approved -> published) for one eligible term,
// each hop its own status update + its own glossary_notes row — the same "each item transitions
// via the existing nextStatus rules and writes its own note row" shape the per-item review flow
// already has (src/review/server.js's handleGlossaryDecision), just driven by this CLI instead of
// Lance's click. If the approve hop fails outright, or either glossary_notes insert fails, that's
// an unexpected error and propagates (aborts the run — see isTypedFailure discipline above). If
// the publish hop specifically fails the completeness CHECK, the approve hop and its note already
// committed — the term is left, honestly, sitting at 'approved' for Lance to notice and fix.
export async function autoPublishOne(client, term, verifierModel) {
  const approvedStatus = nextStatus(term.status, 'approve');
  const { error: aErr } = await client.from(GLOSSARY_TERMS_TABLE)
    .update({ status: approvedStatus }).eq('id', term.id);
  if (aErr) throw new Error(`${GLOSSARY_TERMS_TABLE} update (approve) failed for term ${term.id}: ${aErr.message}`);

  const { error: anErr } = await client.from(GLOSSARY_NOTES_TABLE).insert({
    term_id: term.id, action: mapNoteAction('approve'), note: buildNote(verifierModel, 'auto-approved'),
  });
  if (anErr) throw new Error(`${GLOSSARY_NOTES_TABLE} insert (approve) failed for term ${term.id}: ${anErr.message}`);

  const publishedStatus = nextStatus(approvedStatus, 'publish');
  const { error: pErr } = await client.from(GLOSSARY_TERMS_TABLE)
    .update({ status: publishedStatus, published_at: new Date().toISOString() }).eq('id', term.id);
  if (pErr) {
    if (isPublishCompletenessViolation(pErr)) {
      throw new PublishCompletenessError(
        `term ${term.id} ("${term.term}") failed the published-completeness CHECK after auto-approve (missing gloss_md/source_url/source_hash)`,
        { termId: term.id, term: term.term },
      );
    }
    throw new Error(`${GLOSSARY_TERMS_TABLE} update (publish) failed for term ${term.id}: ${pErr.message}`);
  }

  const { error: pnErr } = await client.from(GLOSSARY_NOTES_TABLE).insert({
    term_id: term.id, action: mapNoteAction('publish'), note: buildNote(verifierModel, 'auto-published'),
  });
  if (pnErr) throw new Error(`${GLOSSARY_NOTES_TABLE} insert (publish) failed for term ${term.id}: ${pnErr.message}`);
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

  const { terms, tableMissing: termsMissing } = await loadDraftTerms(client, args.dryRun);
  const { map: latestVerification, tableMissing: verMissing } =
    await loadLatestVerifications(client, terms.map((t) => t.id), args.dryRun);
  const { eligible, needsMapping, noGloss, flaggedOrUnverified } = planAutoPublish(terms, latestVerification);

  if (args.dryRun) {
    const out = {
      mode: 'dry-run',
      counts: {
        draftTerms: terms.length,
        eligible: eligible.length,
        needsMappingSkipped: needsMapping.length,
        noGlossSkipped: noGloss.length,
        flaggedOrUnverifiedSkipped: flaggedOrUnverified.length,
      },
      eligible: eligible.map(({ term }) => ({ id: term.id, term: term.term })),
    };
    if (termsMissing || verMissing) out.note = '(glossary_terms or glossary_verifications missing — migration 0007 not applied; treating as zero candidates)';
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const runId = await openRun(client, 'auto-publish-glossary');
  const failed = [];
  try {
    let published = 0;
    for (const { term, verification } of eligible) {
      try {
        await autoPublishOne(client, term, verification.model);
        published += 1;
      } catch (err) {
        if (err instanceof PublishCompletenessError) {
          failed.push({ id: term.id, term: term.term, error: err.message });
        } else {
          throw err;
        }
      }
    }

    const counts = { eligible: eligible.length, published, failed: failed.length };
    const status = failed.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, failed });
    console.log(JSON.stringify({ mode: 'live', run_id: runId, status, eligible: eligible.length, published, failed }, null, 2));
    if (failed.length > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
