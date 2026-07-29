import {
  getClient, openRun, closeRun, isMissingRelationError, selectAll,
} from '../lib/db.js';
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
// publishable) and four honest, mutually-exclusive skip buckets — mirrors gloss.js's
// planGlossing exhaustive-partition style. Eligibility never touches a flag, an unverified item,
// or a needs_mapping row (no resolved citation/source to stand behind) — the exact same "clean"
// state a human reviewer would see via glossVerificationBadge, no separate/looser "auto" rule.
//
// Final-review finding 3 (IMPORTANT, controller ruling): a clean verification only proves the TEXT
// the verifier actually checked was clean — not whatever gloss_md currently holds. If a review-page
// edit (the ONLY way gloss_md changes after initial creation — see handleGlossaryDecision) landed
// AFTER that verification ran, the clean verdict is stale relative to the current text and this
// term must be excluded, honestly, under its own bucket — never silently auto-published on
// unverified text. No migration for this (0007 is already applied): a timestamp comparison against
// glossary_notes' newest 'edited' row for the term, per the ruling; content-hash binding to the
// exact verified text can come later via a migration if wanted. latestEditNoteByTermMap defaults to
// empty so existing callers/tests that don't care about this axis are unaffected.
export function planAutoPublish(terms, latestVerificationByTermMap, latestEditNoteByTermMap = new Map()) {
  const eligible = [];
  const needsMapping = [];
  const noGloss = [];
  const flaggedOrUnverified = [];
  const editedSinceVerification = [];
  for (const t of terms) {
    if (t.needs_mapping) { needsMapping.push(t); continue; }
    if (!t.gloss_md) { noGloss.push(t); continue; }
    const verification = latestVerificationByTermMap.get(t.id) ?? null;
    const badge = glossVerificationBadge(verification);
    if (badge.state !== 'clean') { flaggedOrUnverified.push(t); continue; }
    const latestEditAt = latestEditNoteByTermMap.get(t.id) ?? null;
    if (latestEditAt && (latestEditAt > (verification.created_at ?? ''))) {
      editedSinceVerification.push(t);
      continue;
    }
    eligible.push({ term: t, verification });
  }
  return {
    eligible, needsMapping, noGloss, flaggedOrUnverified, editedSinceVerification,
  };
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
//
// Final-review finding 1 addendum (controller-adjudicated in-scope, not just the four originally
// named call sites): this was the same bare, unbounded .select() shape as loadLatestVerifications
// above — glossary_terms is at 401 live rows and grows with every summarized bill, so it WILL cross
// Supabase's 1000-row cap. Past that cap, this created_at-ASC query would silently drop draft terms
// from auto-publish eligibility entirely (never even considered, not just mis-verified) — the same
// trust-surface finding 1 closes everywhere else. Routed through selectAll like the rest.
export async function loadDraftTerms(client, dryRun) {
  const { data, error } = await selectAll(client, GLOSSARY_TERMS_TABLE, 'id,term,kind,citation,gloss_md,needs_mapping,status,created_at', {
    filter: (q) => q.eq('status', TARGET_STATUS).order('created_at', { ascending: true }),
  });
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
//
// Final-review finding 1 (CRITICAL, live-verified): this used to be a bare, unbounded .select() —
// past Supabase's 1000-row-per-request cap, "latest verification" was computed over an arbitrary
// 1000-row subset, so a newer FLAGGED row could be invisible and a term with a stale/absent
// verification in that subset could get auto-published as if it were clean. Routed through
// selectAll (src/lib/db.js), the one shared pagination helper every full-table-ish select in this
// codebase now uses, per the fix wave's controller ruling.
export async function loadLatestVerifications(client, termIds, dryRun) {
  if (termIds.length === 0) return { map: new Map(), tableMissing: false };
  const { data, error } = await selectAll(client, GLOSSARY_VERIFICATIONS_TABLE, 'term_id,overall,verdicts,model,created_at');
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

// Final-review finding 3 (IMPORTANT): auto-publish eligibility was not bound to the verified TEXT
// — a review-page edit to gloss_md AFTER a term's latest clean verification changed the text the
// verifier actually checked, but planAutoPublish had no way to know that and would auto-publish the
// (now-unverified) edited text anyway. glossary_notes' own 'edited' action rows (written by
// src/review/server.js's handleGlossaryDecision on every edit) are the durable signal — same
// selectAll pagination convention as loadLatestVerifications above, filtered server-side to
// action='edited' (a fixed-string filter, not an id list, so it carries none of the header-overflow
// risk loadLatestVerifications/handleGlossaryQueue guard against). Reduces to the newest edit's
// created_at per term_id — only the TIMESTAMP is needed by planAutoPublish's comparison, not the
// full row, so the map holds a bare ISO string rather than mirroring latestVerificationByTerm's
// whole-row shape.
export async function loadLatestEditNotes(client, dryRun) {
  const { data, error } = await selectAll(client, GLOSSARY_NOTES_TABLE, 'term_id,created_at', {
    filter: (q) => q.eq('action', 'edited'),
  });
  if (error) {
    if (dryRun && isMissingRelationError(error, GLOSSARY_NOTES_TABLE)) {
      return { map: new Map(), tableMissing: true };
    }
    throw new Error(`${GLOSSARY_NOTES_TABLE} lookup failed: ${error.message}`);
  }
  const map = new Map();
  for (const r of data ?? []) {
    const existing = map.get(r.term_id);
    if (existing === undefined || (r.created_at ?? '') > existing) map.set(r.term_id, r.created_at);
  }
  return { map, tableMissing: false };
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
  const { map: latestEditNote, tableMissing: notesMissing } =
    await loadLatestEditNotes(client, args.dryRun);
  const {
    eligible, needsMapping, noGloss, flaggedOrUnverified, editedSinceVerification,
  } = planAutoPublish(terms, latestVerification, latestEditNote);

  if (args.dryRun) {
    const out = {
      mode: 'dry-run',
      counts: {
        draftTerms: terms.length,
        eligible: eligible.length,
        needsMappingSkipped: needsMapping.length,
        noGlossSkipped: noGloss.length,
        flaggedOrUnverifiedSkipped: flaggedOrUnverified.length,
        // Finding 3: never silent — a term excluded because its gloss_md was edited AFTER its
        // latest clean verification gets its own honest count, distinct from "never verified at
        // all" (flaggedOrUnverifiedSkipped) and from every other skip reason.
        editedSinceVerificationSkipped: editedSinceVerification.length,
      },
      eligible: eligible.map(({ term }) => ({ id: term.id, term: term.term })),
      editedSinceVerification: editedSinceVerification.map((t) => ({ id: t.id, term: t.term })),
    };
    if (termsMissing || verMissing || notesMissing) out.note = '(glossary_terms, glossary_verifications, or glossary_notes missing — migration 0007 not applied; treating as zero candidates)';
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

    const counts = {
      eligible: eligible.length, published, failed: failed.length, editedSinceVerification: editedSinceVerification.length,
    };
    const status = failed.length === 0 ? 'succeeded' : 'partial';
    const editedSinceVerificationDetail = editedSinceVerification.map((t) => ({ id: t.id, term: t.term }));
    await closeRun(client, runId, status, { counts, failed, editedSinceVerification: editedSinceVerificationDetail });
    console.log(JSON.stringify({
      mode: 'live', run_id: runId, status, eligible: eligible.length, published, failed, editedSinceVerification: editedSinceVerificationDetail,
    }, null, 2));
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
