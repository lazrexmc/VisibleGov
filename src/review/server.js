import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  getClient, isMissingRelationError, selectAll, additivePatch,
} from '../lib/db.js';
import { pickDisplayName } from '../lib/person-identity.js';
// PersonLinkConflictError reused verbatim (Task 2, controller ruling 4: "conflict-throw path
// intact") — the SAME typed guard link-persons.js's writeAutoCluster throws when a cluster
// member already carries a non-null person_id, now also thrown here for Lance's manual
// per-subset link decisions. isUniqueViolation reused verbatim too (final wave, item 3 — the
// TOCTOU guard's own person_links-race detection). Importing a CLI module into the review server
// is safe: link-persons.js only imports from ../lib/db.js and ../lib/person-identity.js (no
// circularity), and its own `invokedDirectly` guard at the bottom means importing it here never
// runs its main().
import { PersonLinkConflictError, isUniqueViolation } from '../cli/link-persons.js';

// PersonLinkRaceError — final wave, item 3 (TOCTOU guard): distinct from PersonLinkConflictError
// (which fires on the pre-check, against a SELECT snapshot, BEFORE any write for this decision
// happens) — this fires when the guarded WRITE itself (legislators.update(...).is('person_id',
// null), or a person_links unique-violation one step later) discovers a concurrent writer won the
// race in the gap between that snapshot and now. Both map to the same 409 in the route's outer
// catch, but are kept as separate typed errors since PersonLinkRaceError's own handling (persons-
// row cleanup when nothing has linked yet) is specific to the mid-write race, not the pre-check.
export class PersonLinkRaceError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PersonLinkRaceError';
    Object.assign(this, meta);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_HTML = readFileSync(path.join(__dirname, 'page.html'));

export const PORT = 8991;
export const HOST = '127.0.0.1';
export const BODY_LIMIT = 1024 * 1024; // 1MB

// ---- Pure logic (exported for tests) ----

// Legal status transitions. Publishing requires 'approved' — a draft cannot jump straight to
// published (the review gate is the product). Anything not listed here is illegal.
const TRANSITIONS = {
  draft: { approve: 'approved', reject: 'rejected', edit: 'draft' },
  approved: { publish: 'published', reject: 'rejected' },
  stale: { approve: 'approved', reject: 'rejected', edit: 'draft' },
};

// Real-use gap (Lance, live): 'approved' MUST stay in the queue. approve->publish is a legal
// transition (see TRANSITIONS above), but if approved rows aren't listed here they become
// invisible the moment they're approved — the only status with a legal onward move and nowhere
// to make it from. draft/stale are the two "needs a first decision" states; approved is "needs
// publishing" — all three belong in the working queue.
const QUEUE_STATUSES = ['draft', 'stale', 'approved'];

// Trust model v3 mechanism 2 (auto-publish-glossary CLI, src/cli/auto-publish-glossary.js): clean,
// verified glossary drafts now move all the way to 'published' with zero human touch, so the
// glossary review page's job shifted from "review everything actionable" to "surface what the
// pipeline could NOT auto-handle, plus reachable context" — flagged items (the real queue),
// needs_mapping/no-gloss stubs, and a published count + sample pool for Lance's spot-audit role.
// 'published' has to be queryable here for that last part; summaries have no equivalent auto-path
// (yet — see the v3 design doc's open decision 4), so QUEUE_STATUSES above stays untouched.
const GLOSSARY_QUEUE_STATUSES = ['draft', 'stale', 'approved', 'published'];

export function nextStatus(current, action) {
  const next = TRANSITIONS[current] && TRANSITIONS[current][action];
  if (!next) throw new Error('illegal transition');
  return next;
}

// Controller ruling #2: decision action -> summary_notes.action.
const NOTE_ACTION = { approve: 'approved', edit: 'edited', reject: 'rejected', publish: 'published' };

export function mapNoteAction(action) {
  const mapped = NOTE_ACTION[action];
  if (!mapped) throw new Error(`unknown action: ${action}`);
  return mapped;
}

// Controller ruling #3: edit requires body_md; reject requires note. Returns an error message
// string, or null if valid.
export function validateDecisionInput({ action, body_md, note }) {
  if (!NOTE_ACTION[action]) return 'unknown action';
  if (action === 'edit' && !body_md) return 'body_md is required for edit';
  if (action === 'reject' && !note) return 'note is required for reject';
  return null;
}

// Task 6 (glossary review queue), controller ruling #2: same rule as validateDecisionInput,
// mirrored for the glossary domain's editable field (gloss_md instead of body_md). Kept as a
// distinct function — not a generalized field name — so validateDecisionInput's existing
// contract/tests (and its exact error text) stay untouched; NOTE_ACTION (the known-action set) is
// still the single shared source of truth, reused here rather than redeclared.
export function validateGlossaryDecisionInput({ action, gloss_md, note }) {
  if (!NOTE_ACTION[action]) return 'unknown action';
  if (action === 'edit' && !gloss_md) return 'gloss_md is required for edit';
  if (action === 'reject' && !note) return 'note is required for reject';
  return null;
}

// Controller ruling #4: yeas = 'yea' casts, nays = 'nay' casts; other positions not shown.
export function countVoteCasts(casts) {
  let yeas = 0;
  let nays = 0;
  for (const c of casts) {
    if (c.position === 'yea') yeas += 1;
    else if (c.position === 'nay') nays += 1;
  }
  return { yeas, nays };
}

// Controller ruling #4: pick the bill's most recent vote by vote_date when several exist.
export function pickLatestVote(votes) {
  if (!votes || votes.length === 0) return null;
  return votes.reduce((latest, v) => (
    !latest || (v.vote_date ?? '') > (latest.vote_date ?? '') ? v : latest
  ), null);
}

// The raw text shown in the review pane should be the exact text the draft was generated
// from (grounding, PLAYBOOK_DELTA §4.1) — match by content_hash against the summary's
// bill_text_hash when possible; fall back to the most-recently-retrieved row otherwise.
export function pickBillText(texts, targetHash) {
  if (!texts || texts.length === 0) return null;
  const match = texts.find((t) => t.content_hash === targetHash);
  if (match) return match;
  return texts.reduce((latest, t) => (
    !latest || (t.retrieved_at ?? '') > (latest.retrieved_at ?? '') ? t : latest
  ), null);
}

// Task 10 (adversarial verification pass): reduces a summary_verifications row (or none, if the
// summary hasn't been verified yet) to a display-ready {state, label}. Pure so both the API
// (queue's 'verified' field) and tests can exercise it without a DB.
//
// deriveVerificationBadge is the shared mechanical derivation (null -> unverified; overall clean
// -> green with a count; otherwise -> amber with an unsupported/total count) — the SAME derivation
// Task 6's glossary tab uses (controller ruling #3: "same mechanical overall derivation display as
// summaries"). Only the noun differs: verifier.js's verdicts index summary BULLETS; glosser.js's
// verdicts index gloss SENTENCES (see glosser.js's own comment on GLOSS_VERIFY_SCHEMA) — using the
// domain-correct noun here keeps the review page's own labels honest rather than reusing "bullets"
// for a gloss that has none.
function deriveVerificationBadge(verification, noun) {
  if (!verification) return { state: 'unverified', label: 'Unverified' };
  const verdicts = verification.verdicts || [];
  if (verification.overall === 'clean') {
    return { state: 'clean', label: `Verifier found all ${verdicts.length} ${noun} supported` };
  }
  const unsupported = verdicts.filter((v) => !v.supported).length;
  return { state: 'flagged', label: `Verifier flagged ${unsupported} of ${verdicts.length} ${noun}` };
}

export function verificationBadge(verification) {
  return deriveVerificationBadge(verification, 'bullets');
}

// Task 6: glossary tab's equivalent of verificationBadge, over glossary_verifications rows.
export function glossVerificationBadge(verification) {
  return deriveVerificationBadge(verification, 'sentences');
}

// A summary (or glossary term) can be re-verified over time (e.g. after a re-run); the latest row
// by created_at is the one that matters for display — same "last wins" pattern as pickLatestVote.
function latestVerificationByKey(rows, keyField) {
  const map = new Map();
  for (const r of rows || []) {
    const key = r[keyField];
    const existing = map.get(key);
    if (!existing || (r.created_at ?? '') > (existing.created_at ?? '')) map.set(key, r);
  }
  return map;
}

export function latestVerificationBySummary(rows) {
  return latestVerificationByKey(rows, 'summary_id');
}

// Task 6: glossary tab's equivalent of latestVerificationBySummary, over glossary_verifications
// rows keyed by term_id.
export function latestVerificationByTerm(rows) {
  return latestVerificationByKey(rows, 'term_id');
}

// Migration 0004 (summary_verifications) may not be applied yet when this server runs — a query
// against that table then fails with a "relation does not exist" error, and treating that like
// any other DB error would 500 the whole queue/item, a regression of the pre-Task-10 working
// page. Degrade gracefully ONLY for that specific failure (empty rows = "nobody verified yet");
// any OTHER error still throws, so real DB problems are never silently swallowed.
export function resolveVerificationRows({ data, error }, table = 'summary_verifications') {
  if (error) {
    if (isMissingRelationError(error, table)) return [];
    throw error;
  }
  return data ?? [];
}

// isSupportShapedVerification — completeness axis follow-up (2026-07-31): migration 0020 (draft,
// not yet applied when this code ships) adds completeness rows to this SAME summary_verifications
// table, distinguished at the schema level by a `kind` column. Filtering `.eq('kind','support')`
// would 400 against a database 0020 hasn't reached yet — draft-then-apply means this code and that
// migration can land hours apart, in either order, and this file must work correctly in BOTH
// states without knowing which one it's talking to. So: discriminate by the DATA'S OWN SHAPE
// instead of a column that may not exist. A support row's `verdicts` is the array VERIFY_SCHEMA
// defines, each entry carrying `.supported`; a completeness row's `verdicts` holds
// COMPLETENESS_SCHEMA's {key_provisions, coverage} object instead — never an array at all, so
// `Array.isArray` alone already disambiguates them, and the per-entry `.supported` check below is
// belt-and-suspenders. deriveVerificationBadge must never see a coverage row: it would read
// `.supported` as undefined on every entry and silently report "0 of N supported" for a summary
// nothing actually found unsupported.
export function isSupportShapedVerification(row) {
  const verdicts = row?.verdicts;
  if (!Array.isArray(verdicts)) return false;
  if (verdicts.length === 0) return true; // vacuous case: an (empty) array is still support-shaped
  return verdicts.every((v) => v && typeof v.supported === 'boolean');
}

// isCompletenessShapedVerification — the missing counterpart to isSupportShapedVerification above,
// same shape-not-schema discrimination style (see that function's own comment for why: this file
// must work whether or not migration 0020's `kind` column exists on the database it's talking to,
// so rows are told apart by their own data shape, never by trusted metadata). A completeness row's
// `verdicts` is {key_provisions, coverage} — an OBJECT, never an array (a support row's verdicts IS
// an array). Severity-sorted review queue, 2026-08-03.
export function isCompletenessShapedVerification(row) {
  const verdicts = row?.verdicts;
  if (!verdicts || Array.isArray(verdicts)) return false;
  return Array.isArray(verdicts.coverage);
}

// computeIssueCount(supportVerification, completenessVerification) -> number | null. Severity-
// sorted review queue, 2026-08-03: the whole point of this feature is surfacing "how much work does
// this item need" so single-issue flags sort first. null (not 0) when NEITHER verification exists —
// an honestly-unverified item needs a full check run, not a quick fix, and must sort AFTER every
// numeric item, never before (never conflate "unranked" with "zero issues"). Otherwise: unsupported
// bullet count (0 if no support row) + missing provision count (0 if no completeness row) — a
// summary clean on one axis but flagged on the other must show the OTHER axis's real count, never a
// false zero from only checking one side.
export function computeIssueCount(supportVerification, completenessVerification) {
  if (!supportVerification && !completenessVerification) return null;
  const unsupported = supportVerification
    ? (supportVerification.verdicts || []).filter((v) => !v.supported).length
    : 0;
  const missing = completenessVerification
    ? (completenessVerification.verdicts?.coverage || []).filter((c) => !c.covered).length
    : 0;
  return unsupported + missing;
}

// describeMissingProvisions(completenessVerification) -> Array<{section, provision}>. Severity-
// sorted review queue, 2026-08-03: this data has existed in summary_verifications since the
// completeness axis shipped but was NEVER reachable from this review server before this feature —
// isSupportShapedVerification's filter discarded every completeness row outright. Matched via
// coverage's own provision_index, never by array position alone (mirrors assessCompleteness's own
// indexing discipline in src/lib/verifier.js) — coverage entries are not guaranteed to arrive in
// provision_index order.
export function describeMissingProvisions(completenessVerification) {
  if (!completenessVerification) return [];
  const keyProvisions = completenessVerification.verdicts?.key_provisions || [];
  const coverage = completenessVerification.verdicts?.coverage || [];
  return coverage
    .filter((c) => !c.covered)
    .slice()
    .sort((a, b) => a.provision_index - b.provision_index)
    .map((c) => keyProvisions[c.provision_index])
    .filter(Boolean)
    .map((p) => ({ section: p.section, provision: p.provision }));
}

// Task 6, controller ruling #2: migration 0007's glossary_terms_published_complete CHECK (source_url
// / source_hash / gloss_md all required once status='published') will reject a publish attempt on a
// bare stub. That must be surfaced honestly, not pre-filtered away silently — but per this file's
// no-upstream-error-strings-reach-the-page discipline (sendServerError's own comment), the raw
// Postgres error text still never reaches the client; this predicate only lets the caller recognize
// THIS specific, known, non-sensitive business-rule violation so it can respond with its own safe,
// clear message instead of falling into the generic 500 funnel. Postgres reports a CHECK violation
// as SQLSTATE 23514 (check_violation); the constraint name in the message pins it to this exact
// constraint, not any other CHECK on the table.
export function isPublishCompletenessViolation(error) {
  if (!error) return false;
  const code = error.code;
  const msg = String(error.message || '').toLowerCase();
  return code === '23514' && msg.includes('glossary_terms_published_complete');
}

// CSRF guard for POST /api/decision. A cross-origin <form enctype="text/plain"> is a no-preflight
// "simple request" — the browser will happily send it to 127.0.0.1:8991 from any open tab, with
// no CORS check, because we never answer OPTIONS. Two independent conditions close that off:
//   1. Content-Type must start with 'application/json'. A plain HTML form cannot set this content
//      type (only 'application/x-www-form-urlencoded', 'multipart/form-data', or 'text/plain' are
//      formenctype-legal) without triggering a CORS preflight — which this server never answers,
//      so a real cross-origin JSON POST cannot arrive at all. This alone kills the form vector.
//   2. Origin, when the browser sends one, must be exactly this server's own origin
//      (belt-and-suspenders — catches any client that does manage to set a JSON content type).
//      Non-browser callers (curl, this project's own tests) often send no Origin header at all;
//      that is allowed, since there is no browser-enforced same-origin policy to bypass there.
export function isAllowedDecisionRequest(headers) {
  const h = {};
  for (const [key, value] of Object.entries(headers || {})) h[key.toLowerCase()] = value;

  const contentType = String(h['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) return false;

  const origin = h['origin'];
  if (origin !== undefined && origin !== `http://${HOST}:${PORT}`) return false;

  return true;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds limit');
    this.name = 'BodyTooLargeError';
  }
}

// Skip != empty doesn't apply here, but the same discipline does: never silently truncate —
// reject over-limit bodies loudly with a distinct error type.
export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        // Don't req.destroy() here: on IncomingMessage that tears down the underlying socket,
        // which would drop the 413 response before the client ever reads it. Just stop
        // accumulating and let the (already-in-flight, local, single-user) body drain; the caller
        // still gets a fast, truthful 413 instead of a silent connection reset.
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

// ---- HTTP helpers ----

function sendJson(res, status, bodyObj) {
  const body = JSON.stringify(bodyObj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendHtml(res) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(PAGE_HTML);
}

// Every error path funnels here: no key material, no stack traces, no upstream error strings
// reach the page — just a generic message. Full detail is logged server-side only.
function sendServerError(res, context, err) {
  console.error(`[review-server] ${context}:`, err);
  sendJson(res, 500, { error: 'internal error' });
}

// ---- Route handlers ----

async function handleQueue(client, res) {
  if (!client) { sendJson(res, 500, { error: 'internal error' }); return; }
  try {
    const { data, error } = await client
      .from('summaries')
      .select('id,status,created_at,bills(identifier,title)')
      .in('status', QUEUE_STATUSES)
      .order('created_at', { ascending: true });
    if (error) throw error;

    // Same header-overflow guard as the glossary queue below: full small-table select + in-JS
    // filter, never .in() over the whole queue's ids (25 summaries fit today; the glossary tab
    // proved the pattern breaks past ~200 ids).
    const idSet = new Set((data ?? []).map((row) => row.id));
    let latestSupport = new Map();
    let latestCompleteness = new Map();
    if (idSet.size > 0) {
      // Final-review finding 1 (CRITICAL): was a bare unbounded .select() — past Supabase's
      // 1000-row-per-request cap, "latest verification" was computed over an arbitrary subset, so
      // a newer flagged verification could be invisible to this queue. Routed through selectAll
      // (src/lib/db.js), the one shared pagination helper every full-table-ish select now uses.
      const verResult = await selectAll(client, 'summary_verifications', 'summary_id,overall,verdicts,created_at');
      const rows = resolveVerificationRows(verResult).filter((r) => idSet.has(r.summary_id));
      // isSupportShapedVerification (see its own comment): completeness rows share this table and
      // must never reach latestVerificationBySummary/verificationBadge, which are written for the
      // support axis's verdict shape only.
      latestSupport = latestVerificationBySummary(rows.filter(isSupportShapedVerification));
      // Severity-sorted review queue (2026-08-03): completeness rows share this same table/query —
      // one read already covers both kinds, no second DB round-trip needed.
      latestCompleteness = latestVerificationBySummary(rows.filter(isCompletenessShapedVerification));
    }

    const items = (data ?? []).map((row) => {
      const support = latestSupport.get(row.id) ?? null;
      const completeness = latestCompleteness.get(row.id) ?? null;
      return {
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        bill: row.bills ? { identifier: row.bills.identifier, title: row.bills.title } : null,
        verified: verificationBadge(support).state,
        issue_count: computeIssueCount(support, completeness),
        missing_provisions: describeMissingProvisions(completeness),
      };
    });

    // Severity-sorted review queue (2026-08-03): ascending by issue_count, null (unverified) LAST —
    // an unverified item needs a full check, not a quick fix, so surfacing it first would contradict
    // this feature's own purpose. A stable sort preserves the existing created_at tie-break.
    items.sort((a, b) => {
      if (a.issue_count === b.issue_count) return 0;
      if (a.issue_count === null) return 1;
      if (b.issue_count === null) return -1;
      return a.issue_count - b.issue_count;
    });

    sendJson(res, 200, items);
  } catch (err) {
    sendServerError(res, 'queue', err);
  }
}

async function handleItem(client, res, id) {
  if (!client) { sendJson(res, 500, { error: 'internal error' }); return; }
  try {
    const { data: summary, error: sErr } = await client
      .from('summaries')
      .select('id,bill_id,status,body_md,model,prompt_version,bill_text_hash,created_at,published_at')
      .eq('id', id).maybeSingle();
    if (sErr) throw sErr;
    if (!summary) { sendJson(res, 404, { error: 'not found' }); return; }

    const { data: bill, error: bErr } = await client
      .from('bills').select('identifier,title,canonical_url').eq('id', summary.bill_id).maybeSingle();
    if (bErr) throw bErr;

    const { data: texts, error: tErr } = await client
      .from('bill_texts').select('content,content_hash,retrieved_at').eq('bill_id', summary.bill_id);
    if (tErr) throw tErr;
    const text = pickBillText(texts ?? [], summary.bill_text_hash);

    const { data: votes, error: vErr } = await client
      .from('votes').select('id,question,result,vote_date').eq('bill_id', summary.bill_id);
    if (vErr) throw vErr;
    const latestVote = pickLatestVote(votes ?? []);

    let vote = null;
    if (latestVote) {
      const { data: casts, error: cErr } = await client
        .from('vote_casts').select('position').eq('vote_id', latestVote.id);
      if (cErr) throw cErr;
      const { yeas, nays } = countVoteCasts(casts ?? []);
      vote = { question: latestVote.question, result: latestVote.result, yeas, nays };
    }

    // No .limit(1) here (deliberately, completeness-axis follow-up 2026-07-31): applyRecordDecision
    // (src/cli/summary-queue.js) inserts the completeness row immediately AFTER the support row, so
    // the completeness row's created_at is typically the LATER of the two — a DB-side
    // order+limit(1) would very often hand this endpoint the completeness row, not the support one.
    // A single summary_id's verification history is small (never anywhere near the pagination cap
    // selectAll exists for), so fetching all of it and filtering/picking in JS is cheap and correct.
    const verResult = await client
      .from('summary_verifications')
      .select('overall,verdicts,model,created_at')
      .eq('summary_id', id)
      .order('created_at', { ascending: false });
    const allVerRows = resolveVerificationRows(verResult);
    // isSupportShapedVerification/isCompletenessShapedVerification: same shape-not-schema
    // discrimination as handleQueue above. Rows are already newest-first, so the first match of
    // each shape is that kind's latest verification.
    const verification = allVerRows.find(isSupportShapedVerification) ?? null;
    // Severity-sorted review queue (2026-08-03): this data has existed in summary_verifications
    // since the completeness axis shipped but was never reachable from this endpoint before —
    // isSupportShapedVerification's own filter discarded it outright.
    const completenessVerification = allVerRows.find(isCompletenessShapedVerification) ?? null;

    sendJson(res, 200, {
      summary: {
        id: summary.id, status: summary.status, body_md: summary.body_md, model: summary.model,
        prompt_version: summary.prompt_version, created_at: summary.created_at, published_at: summary.published_at,
      },
      bill: bill ? { identifier: bill.identifier, title: bill.title, canonical_url: bill.canonical_url } : null,
      text: text ? text.content : null,
      vote,
      verification,
      completeness_verification: completenessVerification,
      missing_provisions: describeMissingProvisions(completenessVerification),
    });
  } catch (err) {
    sendServerError(res, 'item', err);
  }
}

async function handleDecision(client, req, res) {
  let bodyBuf;
  try {
    bodyBuf = await readBody(req, BODY_LIMIT);
  } catch (err) {
    if (err instanceof BodyTooLargeError) { sendJson(res, 413, { error: 'payload too large' }); return; }
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return;
  }

  const { summary_id, action, body_md, note } = payload ?? {};
  if (!summary_id) { sendJson(res, 400, { error: 'summary_id is required' }); return; }
  const validationError = validateDecisionInput({ action, body_md, note });
  if (validationError) { sendJson(res, 400, { error: validationError }); return; }

  try {
    const { data: summary, error: sErr } = await client
      .from('summaries').select('id,status').eq('id', summary_id).maybeSingle();
    if (sErr) throw sErr;
    if (!summary) { sendJson(res, 404, { error: 'not found' }); return; }

    let newStatus;
    try {
      newStatus = nextStatus(summary.status, action);
    } catch {
      sendJson(res, 400, { error: 'illegal transition' });
      return;
    }

    const patch = { status: newStatus };
    if (action === 'edit') patch.body_md = body_md;
    if (action === 'publish') patch.published_at = new Date().toISOString();

    const { error: uErr } = await client.from('summaries').update(patch).eq('id', summary_id);
    if (uErr) throw uErr;

    const { error: nErr } = await client.from('summary_notes').insert({
      summary_id, note: note ?? '', action: mapNoteAction(action),
    });
    if (nErr) throw nErr;

    sendJson(res, 200, { status: newStatus });
  } catch (err) {
    sendServerError(res, 'decision', err);
  }
}

// ---- Task 6: glossary review queue route handlers ----
//
// Mirrors handleQueue/handleItem/handleDecision above exactly (controller ruling #2: "same
// TRANSITIONS-table pattern") — glossary_terms in place of summaries, term_id in place of
// summary_id, glossary_notes in place of summary_notes. nextStatus/mapNoteAction are reused
// UNCHANGED (no glossary-specific transition table exists; the lifecycle is identical).
//
// Controller ruling #6: migration 0007 (glossary_terms itself, not just its verifications table)
// may not be applied at all when this server runs — unlike summaries, whose table has existed
// since 0001. A missing glossary_terms relation must degrade to an honest, self-describing 200
// response ({available:false, reason}), never a 500, and must never affect the existing summary
// queue (see the "GET /api/item/:id (summary route) still works" regression test).

async function handleGlossaryQueue(client, res) {
  if (!client) { sendJson(res, 500, { error: 'internal error' }); return; }
  try {
    // Final-review finding 1 (CRITICAL): was a bare .order().select() with no pagination — past
    // Supabase's 1000-row-per-request cap, this created_at-ASC select silently dropped the NEWEST
    // terms (the oldest 1000 came back, nothing past them). Routed through selectAll (src/lib/
    // db.js); the `filter` callback keeps the exact same .in(status)/.order(created_at) query,
    // selectAll appends the `id` tiebreaker + pagination loop around it.
    const { data, error } = await selectAll(client, 'glossary_terms', 'id,term,kind,citation,needs_mapping,gloss_md,status,created_at', {
      filter: (q) => q.in('status', GLOSSARY_QUEUE_STATUSES).order('created_at', { ascending: true }),
    });
    if (error) {
      if (isMissingRelationError(error, 'glossary_terms')) {
        sendJson(res, 200, { available: false, reason: 'migration 0007 not applied', items: [] });
        return;
      }
      throw error;
    }

    // Fetch ALL verification rows, never .in('term_id', ids): with 400+ queue terms the id-list
    // URL exceeded undici's 16KB header cap (UND_ERR_HEADERS_OVERFLOW → 500, found live the day
    // 0007 was applied). The table only holds one small row per gloss attempt; filtering to
    // queue ids happens in latestVerificationByTerm's Map lookup anyway.
    //
    // Final-review finding 1 (CRITICAL): same unbounded-select bug as above — past 1000 rows,
    // "latest verification" was computed over an arbitrary subset, so a newer FLAGGED verification
    // could be invisible and auto-publish-glossary.js could publish a flagged gloss claiming clean.
    const idSet = new Set((data ?? []).map((row) => row.id));
    let latestVerification = new Map();
    if (idSet.size > 0) {
      const verResult = await selectAll(client, 'glossary_verifications', 'term_id,overall,verdicts,created_at');
      const rows = resolveVerificationRows(verResult, 'glossary_verifications')
        .filter((r) => idSet.has(r.term_id));
      latestVerification = latestVerificationByTerm(rows);
    }

    sendJson(res, 200, {
      available: true,
      items: (data ?? []).map((row) => ({
        id: row.id,
        status: row.status,
        term: row.term,
        kind: row.kind,
        citation: row.citation,
        needs_mapping: row.needs_mapping,
        has_gloss: Boolean(row.gloss_md),
        created_at: row.created_at,
        verified: glossVerificationBadge(latestVerification.get(row.id) ?? null).state,
      })),
    });
  } catch (err) {
    sendServerError(res, 'glossary-queue', err);
  }
}

async function handleGlossaryItem(client, res, id) {
  if (!client) { sendJson(res, 500, { error: 'internal error' }); return; }
  try {
    const { data: term, error: tErr } = await client
      .from('glossary_terms')
      .select('id,term,kind,citation,gloss_md,supported_by_quote,source_url,status,needs_mapping,created_at,published_at')
      .eq('id', id).maybeSingle();
    if (tErr) {
      if (isMissingRelationError(tErr, 'glossary_terms')) {
        sendJson(res, 200, { available: false, reason: 'migration 0007 not applied' });
        return;
      }
      throw tErr;
    }
    if (!term) { sendJson(res, 404, { error: 'not found' }); return; }

    const verResult = await client
      .from('glossary_verifications')
      .select('overall,verdicts,model,created_at')
      .eq('term_id', id)
      .order('created_at', { ascending: false })
      .limit(1);
    const verRows = resolveVerificationRows(verResult, 'glossary_verifications');
    const verification = verRows[0] ?? null;

    sendJson(res, 200, { available: true, term, verification });
  } catch (err) {
    sendServerError(res, 'glossary-item', err);
  }
}

async function handleGlossaryDecision(client, req, res) {
  let bodyBuf;
  try {
    bodyBuf = await readBody(req, BODY_LIMIT);
  } catch (err) {
    if (err instanceof BodyTooLargeError) { sendJson(res, 413, { error: 'payload too large' }); return; }
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return;
  }

  const { term_id, action, gloss_md, note } = payload ?? {};
  if (!term_id) { sendJson(res, 400, { error: 'term_id is required' }); return; }
  const validationError = validateGlossaryDecisionInput({ action, gloss_md, note });
  if (validationError) { sendJson(res, 400, { error: validationError }); return; }

  try {
    const { data: term, error: tErr } = await client
      .from('glossary_terms').select('id,status').eq('id', term_id).maybeSingle();
    if (tErr) {
      if (isMissingRelationError(tErr, 'glossary_terms')) {
        sendJson(res, 503, { error: 'migration 0007 not applied' });
        return;
      }
      throw tErr;
    }
    if (!term) { sendJson(res, 404, { error: 'not found' }); return; }

    let newStatus;
    try {
      newStatus = nextStatus(term.status, action);
    } catch {
      sendJson(res, 400, { error: 'illegal transition' });
      return;
    }

    const patch = { status: newStatus };
    if (action === 'edit') patch.gloss_md = gloss_md;
    if (action === 'publish') patch.published_at = new Date().toISOString();

    const { error: uErr } = await client.from('glossary_terms').update(patch).eq('id', term_id);
    if (uErr) {
      // Controller ruling #2: don't let the queue's own client-side filtering be the only gate —
      // if the DB CHECK fires anyway (e.g. an approved-but-never-glossed row), surface it honestly
      // as a clear 400, not a generic 500 (isPublishCompletenessViolation's own comment explains
      // why the raw Postgres text still isn't what reaches the client).
      if (isPublishCompletenessViolation(uErr)) {
        sendJson(res, 400, { error: 'cannot publish: term is missing gloss_md, source_url, or source_hash' });
        return;
      }
      throw uErr;
    }

    const { error: nErr } = await client.from('glossary_notes').insert({
      term_id, note: note ?? '', action: mapNoteAction(action),
    });
    if (nErr) throw nErr;

    sendJson(res, 200, { status: newStatus });
  } catch (err) {
    sendServerError(res, 'glossary-decision', err);
  }
}

// ---- Task 2 (identity-merge plan, .superpowers/sdd/2026-07-29-identity-merge/task-2-brief.md):
// identity review tab. Lance's adjudication surface for identity_flags rows link-persons.js
// (Task 1) wrote when a cluster of legislator rows couldn't be linked automatically without risk
// of a wrong merge. Mirrors the glossary tab's route shape (queue/decision, CSRF, degradation,
// selectAll discipline) but the decision payload and write shape are new: per-subset linking
// (controller ruling 1), not a single flag-wide approve/reject.
//
// identity_flags.evidence, as written by link-persons.js's writeIdentityFlag, is already
// `{ reason, candidates: [{ legislatorId, fullName, surnameKeyUsed, sourceKeys, chamberDistrictEra
// }, ...] }` — a full snapshot of exactly the evidence that caused the flag (buildMemberEvidence).
// That snapshot, not a fresh terms/legislators join, is the source of truth for the review
// table's full_name/source-keys/district/era-span columns: it IS the audit trail ("the audit is
// the product's trust story", Task 1's own Global Constraints), and re-deriving it live would
// only risk disagreeing with the very evidence Lance is being asked to adjudicate. The ONE thing
// that legitimately changes between flag-creation and review is person_id (a candidate may have
// been linked already by an earlier partial decision, Task 1/1-lite, or the read that hides the
// flag entirely per ruling 2's "self-healing display") — that alone is fetched live.

// formatCandidateDistrict / formatCandidateEraSpan — pure, table-column-ready summaries over one
// candidate's chamberDistrictEra evidence array (each entry the same {source, jurisdiction_id,
// chamber, district, start_date, end_date} shape buildEvidenceRows in link-persons.js produces).
// Deliberately don't collapse to a single value when a candidate carries several inconsistent-
// looking entries (that inconsistency IS the reviewable signal) — dedupe identical labels only,
// never merge different ones away. Missing bounds render as '?', never guessed or invented.
export function formatCandidateDistrict(evidenceEntries) {
  const seen = new Set();
  const parts = [];
  for (const e of evidenceEntries ?? []) {
    const label = [e?.chamber, e?.district].filter((v) => v != null && String(v).trim() !== '').join(' ');
    if (label && !seen.has(label)) { seen.add(label); parts.push(label); }
  }
  return parts.length ? parts.join(', ') : '(no district evidence)';
}

export function formatCandidateEraSpan(evidenceEntries) {
  let earliestStart = null;
  let latestEnd = null;
  let anyDate = false;
  for (const e of evidenceEntries ?? []) {
    if (e?.start_date != null) {
      anyDate = true;
      if (earliestStart == null || e.start_date < earliestStart) earliestStart = e.start_date;
    }
    if (e?.end_date != null) {
      anyDate = true;
      if (latestEnd == null || e.end_date > latestEnd) latestEnd = e.end_date;
    }
  }
  if (!anyDate) return '(no dates on file)';
  return `${earliestStart ?? '?'} – ${latestEnd ?? '?'}`;
}

// findCandidateEvidence — pulls one member's frozen evidence entry out of a flag's evidence blob
// by legislatorId. Tolerant of a malformed/missing evidence shape (returns null, never throws) —
// this only feeds an audit-trail field on the person_links row, never a decision gate.
export function findCandidateEvidence(flagEvidence, legislatorId) {
  const candidates = flagEvidence && Array.isArray(flagEvidence.candidates) ? flagEvidence.candidates : [];
  return candidates.find((c) => c?.legislatorId === legislatorId) ?? null;
}

// buildLanceLinkEvidence — controller ruling 4: person_links.evidence for a Lance-decided link is
// "evidence from the flag + Lance's selection". Starts from that candidate's own frozen flag
// evidence (names/source keys/chamberDistrictEra — whatever findCandidateEvidence found, or {} if
// none), then layers on which flag this came from and who else Lance grouped with this row in the
// SAME decision (never including the row's own id in its own "linked with" list).
export function buildLanceLinkEvidence(candidateEvidence, {
  flagId, clusterKey, linkedLegislatorIds, note,
}) {
  const base = candidateEvidence ?? {};
  return {
    ...base,
    flagId,
    clusterKey,
    linkedWith: (linkedLegislatorIds ?? []).filter((id) => id !== base.legislatorId),
    note: note ?? null,
  };
}

// buildLanceAttachEvidence — Task 4 (attach-to-existing): reuses buildLanceLinkEvidence VERBATIM
// (same base evidence, same flagId/clusterKey/linkedWith/note shape) and layers on ONE extra fact
// specific to this path — attachedToPersonId, the EXISTING person this candidate joined (contrast
// 'link', which always mints a brand-new person; there is no equivalent fact to record there).
export function buildLanceAttachEvidence(candidateEvidence, {
  flagId, clusterKey, linkedLegislatorIds, personId, note,
}) {
  return {
    ...buildLanceLinkEvidence(candidateEvidence, {
      flagId, clusterKey, linkedLegislatorIds, note,
    }),
    attachedToPersonId: personId,
  };
}

// appendResolution — identity_flags has no notes table and controller ruling 2 is explicit ("no
// schema change"), so a per-decision audit trail for THIS flag lives inside its own `evidence`
// jsonb column: an append-only `resolutions` array, one entry per decision (link-subset or
// keep-separate), layered on top of the original `{reason, candidates}` the flag was created
// with — never overwriting it. `nowIso` is an injectable seam for tests; production calls omit it
// and get the real clock.
export function appendResolution(evidence, resolution, nowIso = new Date().toISOString()) {
  const base = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : {};
  const priorResolutions = Array.isArray(base.resolutions) ? base.resolutions : [];
  return {
    ...base,
    resolutions: [...priorResolutions, { ...resolution, decidedBy: 'lance', decidedAt: nowIso }],
  };
}

const IDENTITY_ACTIONS = new Set(['link', 'keep-separate', 'attach']);

// validateIdentityDecisionInput — controller ruling 1 (per-subset: link needs 2+ distinct ids)
// and ruling 4 (keep-separate "resolves the flag with a note" — mirrors validateDecisionInput's
// own reject-requires-note rule: the one case with no person_links audit row to explain itself,
// so the note IS the record of why these stayed separate). Task 4 (attach-to-existing): 'attach'
// needs only 1+ distinct ids (contrast 'link's 2+ — attach joins candidates into an ALREADY-
// EXISTING person, so a single candidate is a complete, meaningful decision on its own — the
// Onder-shaped fifth row is exactly this shape) plus a person_id naming which existing person.
export function validateIdentityDecisionInput({
  action, legislator_ids, person_id, note,
}) {
  if (!IDENTITY_ACTIONS.has(action)) return 'unknown action';
  if (action === 'link') {
    if (!Array.isArray(legislator_ids) || legislator_ids.length < 2) {
      return 'legislator_ids must include at least 2 ids for link';
    }
    if (new Set(legislator_ids).size !== legislator_ids.length) return 'legislator_ids must not contain duplicates';
  }
  if (action === 'attach') {
    if (!Array.isArray(legislator_ids) || legislator_ids.length < 1) {
      return 'legislator_ids must include at least 1 id for attach';
    }
    if (new Set(legislator_ids).size !== legislator_ids.length) return 'legislator_ids must not contain duplicates';
    if (!person_id) return 'person_id is required for attach';
  }
  if (action === 'keep-separate' && !note) return 'note is required for keep-separate';
  return null;
}

// countCastsForLegislator — the brief's "cast count via selectAll-safe count queries": an exact
// COUNT via head:true (same pattern as ingest-legiscan.js/ingest-mo-house.js's own count queries)
// never fetches a single cast row, so it cannot hit the 1000-row page cap selectAll exists to
// guard against — "selectAll-safe" without literally being selectAll. One query per candidate
// (today's live queue tops out around 70-90 distinct candidates across 21 flags) rather than one
// full-table selectAll+group-by over what could be a much larger vote_casts table.
async function countCastsForLegislator(client, legislatorId) {
  const { count, error } = await client
    .from('vote_casts')
    .select('id', { count: 'exact', head: true })
    .eq('legislator_id', legislatorId);
  if (error) throw error;
  return count ?? 0;
}

// fetchPersonIdsForCandidates — a targeted `.in('id', candidateIds)` lookup (small, bounded by one
// flag's own candidate set — never the "hundreds of ids across many flags" shape the .in() ban is
// about) returning legislator_id -> person_id (or null). Shared by both decision branches below:
// keep-separate needs it to know WHICH of the flag's candidates are still genuinely unlinked (fix
// round 1, minor 1 — the audit entry must name the actual still-open ids, not the literal 'all',
// since an earlier partial link decision may have already closed out some of them); link needs it
// to decide whether the flag is now fully resolved (controller ruling 1).
async function fetchPersonIdsForCandidates(client, candidateIds) {
  if (!candidateIds.length) return new Map();
  const { data, error } = await client.from('legislators').select('id,person_id').in('id', candidateIds);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.id, r.person_id]));
}

// readExistingPersons — the attach_candidate flag's own target-person list, read the SAME way by
// both branches that need it ('attach' validates person_id against it; 'keep-separate' needs the
// persons' members to record the ruling against — finding 3 below). existingPersons is the full
// list; existingPerson (singular) is existingPersons[0], still honored defensively for any flag
// written before both fields existed.
function readExistingPersons(evidence) {
  if (Array.isArray(evidence?.existingPersons) && evidence.existingPersons.length > 0) return evidence.existingPersons;
  return evidence?.existingPerson ? [evidence.existingPerson] : [];
}

// fetchPersonMemberLegislatorIds — every legislator row currently linked to any of the given
// persons. selectAll + filter-in-JS, NOT `.in('person_id', ...)`: the same fetch-all-then-filter
// convention handleIdentityQueue documents above (the undici 16KB header cap found live the day
// 0007 shipped), and legislators is the authoritative membership column the auto path's own
// groupAlreadyLinkedByPerson reads — so a ruling recorded here is keyed on exactly the rows
// src/cli/link-persons.js will compare against on the next run.
async function fetchPersonMemberLegislatorIds(client, personIds) {
  if (!personIds.length) return [];
  const { data, error } = await selectAll(client, 'legislators', 'id,person_id');
  if (error) throw error;
  const wanted = new Set(personIds);
  return (data ?? []).filter((r) => wanted.has(r.person_id)).map((r) => r.id);
}

async function handleIdentityQueue(client, res) {
  if (!client) { sendJson(res, 500, { error: 'internal error' }); return; }
  try {
    const flagsResult = await selectAll(client, 'identity_flags', 'id,cluster_key,candidate_legislator_ids,evidence,created_at', {
      filter: (q) => q.eq('resolved', false).order('created_at', { ascending: true }),
    });
    if (flagsResult.error) {
      if (isMissingRelationError(flagsResult.error, 'identity_flags')) {
        sendJson(res, 200, { available: false, reason: 'migration 0012 not applied', items: [] });
        return;
      }
      throw flagsResult.error;
    }
    const flags = flagsResult.data ?? [];
    if (flags.length === 0) { sendJson(res, 200, { available: true, items: [] }); return; }

    // Live person_id lookup — fetch-all-then-filter-in-JS, the SAME convention the glossary
    // queue's own verification lookup uses (never .in() over a possibly-large id list — see that
    // route's comment on the undici 16KB header cap found live the day 0007 shipped).
    const legResult = await selectAll(client, 'legislators', 'id,person_id');
    if (legResult.error) throw legResult.error;
    const personIdByLegislator = new Map((legResult.data ?? []).map((r) => [r.id, r.person_id]));

    const items = [];
    for (const flag of flags) {
      const candidates = flag.evidence && Array.isArray(flag.evidence.candidates) ? flag.evidence.candidates : [];
      // Controller ruling 2: self-healing display — a flag whose every candidate already carries
      // a person_id (linked via an earlier partial decision, or resolved some other way) is
      // hidden from the queue. Purely a display-time filter — the row itself is never touched by
      // a read, no schema change.
      const allLinked = candidates.length > 0
        && candidates.every((c) => personIdByLegislator.get(c.legislatorId) != null);
      if (allLinked) continue;

      const candidateViews = [];
      for (const c of candidates) {
        // eslint-disable-next-line no-await-in-loop -- sequential, low-traffic admin page; same
        // precedent as link-persons.js's own per-cluster/per-flag write loops.
        const castCount = await countCastsForLegislator(client, c.legislatorId);
        const linkedPersonId = personIdByLegislator.get(c.legislatorId) ?? null;
        candidateViews.push({
          legislator_id: c.legislatorId,
          full_name: c.fullName,
          source_keys: c.sourceKeys ?? {},
          district: formatCandidateDistrict(c.chamberDistrictEra),
          era_span: formatCandidateEraSpan(c.chamberDistrictEra),
          cast_count: castCount,
          already_linked: linkedPersonId != null,
          linked_person_id: linkedPersonId,
        });
      }

      items.push({
        id: flag.id,
        cluster_key: flag.cluster_key,
        reason: (flag.evidence && flag.evidence.reason) || null,
        created_at: flag.created_at,
        candidates: candidateViews,
        // existing_person (Task 4, attach-to-existing): present only on an attach_candidate flag —
        // the EXISTING person's id + display_name (buildAttachFlags, src/cli/link-persons.js),
        // cited directly so the review tab's 'Attach' action can target it without a second lookup.
        existing_person: (flag.evidence && flag.evidence.existingPerson) || null,
        // existing_persons (micro-round, re-review): the FULL list — a cross-check-demoted cluster
        // (applyAttachCrossCheck) can genuinely match MORE than one existing person; the queue UI
        // must list every candidate so Lance can weigh them, not just the first.
        existing_persons: (flag.evidence && Array.isArray(flag.evidence.existingPersons)) ? flag.evidence.existingPersons : [],
      });
    }

    sendJson(res, 200, { available: true, items });
  } catch (err) {
    sendServerError(res, 'identity-queue', err);
  }
}

async function handleIdentityDecision(client, req, res) {
  let bodyBuf;
  try {
    bodyBuf = await readBody(req, BODY_LIMIT);
  } catch (err) {
    if (err instanceof BodyTooLargeError) { sendJson(res, 413, { error: 'payload too large' }); return; }
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return;
  }

  const {
    flag_id, action, legislator_ids, person_id,
  } = payload ?? {};
  const note = payload && payload.note != null ? payload.note : null;
  if (!flag_id) { sendJson(res, 400, { error: 'flag_id is required' }); return; }
  const validationError = validateIdentityDecisionInput({
    action, legislator_ids, person_id, note,
  });
  if (validationError) { sendJson(res, 400, { error: validationError }); return; }

  try {
    const { data: flag, error: fErr } = await client
      .from('identity_flags')
      .select('id,cluster_key,candidate_legislator_ids,evidence,resolved')
      .eq('id', flag_id).maybeSingle();
    if (fErr) {
      if (isMissingRelationError(fErr, 'identity_flags')) {
        sendJson(res, 503, { error: 'migration 0012 not applied' });
        return;
      }
      throw fErr;
    }
    if (!flag) { sendJson(res, 404, { error: 'not found' }); return; }
    if (flag.resolved) { sendJson(res, 400, { error: 'flag already resolved' }); return; }

    if (action === 'keep-separate') {
      // Fix round 1, minor 1: name the ACTUAL still-unlinked candidates, not the literal 'all' —
      // an earlier partial link decision on this same flag may have already closed some of them
      // out, and the audit trail must be precise about which ones this decision actually covers.
      const allCandidateIds = flag.candidate_legislator_ids ?? [];
      const personIdById = await fetchPersonIdsForCandidates(client, allCandidateIds);
      const stillUnlinkedIds = allCandidateIds.filter((id) => (personIdById.get(id) ?? null) == null);

      // FINAL WHOLE-BRANCH REVIEW, finding 3: on an ATTACH flag, "keep separate" means "these
      // candidates are NOT this person" — but legislatorIds alone can never express that. The
      // target person's members are already linked, so they are filtered out of stillUnlinkedIds by
      // construction, and a 1-candidate attach flag therefore yielded ZERO pairs from
      // buildKeepSeparatePairs: the ruling had no pair-keyed representation at all, leaving only
      // cluster_key dedup to suppress re-suggestion — which membership drift defeats (one more
      // compatible row mints a fresh cluster_key and re-proposes the same merge). So the pairs are
      // recorded EXPLICITLY here: each still-unlinked candidate x each member of every person the
      // flag named. Deliberately NOT candidate x candidate — this decision is about the person, and
      // says nothing about whether two candidates are each other; mis-recording that would
      // permanently block a merge Lance never ruled on.
      //
      // ROUND 2, R2-1 (re-review, execution-proven): recording ONLY those pairs silently un-blocked
      // a demoted cluster's own internal merge. src/cli/link-persons.js has two attach-flag
      // producers, and evidence.origin now says which one made this flag:
      //   'singleton'            — each candidate arrived ALONE; clusterLegislators never paired
      //                            them with each other, so this ruling says nothing about whether
      //                            they are each other. No candidate-x-candidate pairs (round 1's
      //                            ruling, unchanged for this producer).
      //   'cross_check_demotion' — the candidates DID form one coherent cluster and only the
      //                            cross-check pulled them apart to ask about the person. Here
      //                            "keep whole flag separate" is genuinely ambiguous between "these
      //                            are not P" and "these are all different people" — and per the
      //                            plan's asymmetric-cost law the machine must NEVER resolve that
      //                            ambiguity toward a silent merge. Recording the
      //                            candidate-x-candidate pairs too keeps the cluster in the flag
      //                            queue (the next run re-flags it citing this very ruling), where
      //                            Lance decides. Missed-merge is the benign direction.
      // A flag carrying NO origin (written before this marker existed, and possibly already sitting
      // in the live queue) is treated as the demotion case for the same reason: an unknown producer
      // might be that one, and only one of the two possible mistakes is silent.
      const targetPersonIds = readExistingPersons(flag.evidence).map((p) => p?.personId).filter(Boolean);
      const isAttachFlag = flag.evidence?.reason === 'attach_candidate' && targetPersonIds.length > 0;
      let legislatorIdPairs = null;
      if (isAttachFlag) {
        const memberIds = await fetchPersonMemberLegislatorIds(client, targetPersonIds);
        legislatorIdPairs = [];
        for (const candidateId of stillUnlinkedIds) {
          for (const memberId of memberIds) legislatorIdPairs.push([candidateId, memberId]);
        }
        if (flag.evidence?.origin !== 'singleton') {
          for (let a = 0; a < stillUnlinkedIds.length; a += 1) {
            for (let b = a + 1; b < stillUnlinkedIds.length; b += 1) {
              legislatorIdPairs.push([stillUnlinkedIds[a], stillUnlinkedIds[b]]);
            }
          }
        }
      }

      const patchedEvidence = appendResolution(flag.evidence, {
        action: 'keep-separate',
        legislatorIds: stillUnlinkedIds,
        note,
        ...(legislatorIdPairs ? { legislatorIdPairs } : {}),
      });
      const { error: uErr } = await client.from('identity_flags')
        .update({ resolved: true, evidence: patchedEvidence }).eq('id', flag_id);
      if (uErr) throw uErr;
      sendJson(res, 200, { resolved: true });
      return;
    }

    if (action === 'attach') {
      // Task 4 (.superpowers/sdd/2026-07-29-profile-completeness/task-4-brief.md):
      // attach-to-existing. legislator_ids here are UNLINKED candidate rows src/cli/link-persons.js's
      // attach pass flagged as possibly belonging to the EXISTING person named by person_id
      // (attach_candidate evidence — buildAttachFlags, matched via the SAME finalPairStatus every
      // other identity path uses). Lance decides which, if any, actually join that person. NEVER
      // creates a new persons row (contrast the 'link' branch below, which always mints one) —
      // person_id must name a real, already-existing person, validated before any write.
      //
      // FIX ROUND 1, CRITICAL 1 (reviewer execution-proven exploit, "SERVER-SIDE VALIDATION GAP"):
      // every OTHER identity write path re-derives its target from server-held state before ever
      // writing (writeAutoCluster's own structural BELT; 'link'/'keep-separate' validate
      // legislator_ids against the flag's own candidate_legislator_ids) — this route did not: it
      // trusted a client-supplied person_id in isolation, so a plain ambiguous_era flag plus an
      // UNRELATED person_id previously produced real writes (HTTP 200). RULING: the flag itself
      // must BE an attach_candidate flag, AND person_id must be one of the persons that flag's own
      // attach pass named — never a value trusted from the request alone. Checked FIRST, before
      // any other work in this branch.
      //
      // MICRO-ROUND (re-review, information-gap finding): a cross-check-demoted cluster
      // (src/cli/link-persons.js's applyAttachCrossCheck) can genuinely match MORE than one
      // existing person — the flag's evidence.existingPersons carries the FULL list (existingPerson
      // singular is existingPersons[0], kept for back-compat with anything still reading it); the
      // valid target set is membership in existingPersons' ids, not exact-equality against a single
      // one. Falls back to wrapping the singular existingPerson only if existingPersons is somehow
      // absent (defensive — every flag this route can ever see is written with both fields by the
      // current writer, src/cli/link-persons.js's writeIdentityFlag).
      const existingPersons = readExistingPersons(flag.evidence);
      const validTargetPersonIds = new Set(existingPersons.map((p) => p?.personId));
      if (flag.evidence?.reason !== 'attach_candidate' || !validTargetPersonIds.has(person_id)) {
        sendJson(res, 400, { error: 'attach is only valid for an attach_candidate flag targeting one of its own existing persons' });
        return;
      }

      const candidateIdSet = new Set(flag.candidate_legislator_ids ?? []);
      const outsiders = legislator_ids.filter((id) => !candidateIdSet.has(id));
      if (outsiders.length > 0) { sendJson(res, 400, { error: 'legislator_ids must all belong to this flag' }); return; }

      const { data: personRow, error: personErr } = await client
        .from('persons').select('id').eq('id', person_id).maybeSingle();
      if (personErr) throw personErr;
      if (!personRow) { sendJson(res, 404, { error: 'person not found' }); return; }

      const { data: selectedRows, error: srErr } = await client
        .from('legislators')
        .select('id,full_name,bioguide_id,openstates_id,mo_house_id,mo_senate_id,legiscan_people_id,person_id')
        .in('id', legislator_ids);
      if (srErr) throw srErr;
      const rows = selectedRows ?? [];
      if (rows.length !== legislator_ids.length) { sendJson(res, 404, { error: 'one or more legislators not found' }); return; }

      // Every selected member's person_id validated null FIRST, before any write happens at all —
      // same all-or-nothing conflict-throw discipline as 'link' below.
      for (const row of rows) {
        if (row.person_id != null) {
          throw new PersonLinkConflictError(
            `legislators.id=${row.id} already has person_id=${row.person_id} — refusing to attach it `
              + '(a non-null person_id is never overwritten)',
            { legislatorId: row.id, existingPersonId: row.person_id, flagId: flag_id },
          );
        }
      }

      // TOCTOU guard, attach variant: same .is('person_id', null) + row-count discipline as the
      // 'link' branch's own guard below — but with NO orphan-cleanup step. Unlike 'link', this path
      // never creates a persons row: person_id names a person that already existed BEFORE this
      // decision and already carries its other members' links, so there is never a just-inserted
      // orphan to clean up here, and — critically — the target person must NEVER be deleted on a
      // race (it is real, pre-existing data, not a candidate for removal). A race simply maps to the
      // same plain 409 the outer catch already produces for PersonLinkRaceError.
      for (const row of rows) {
        const patch = additivePatch(row, { person_id });
        // eslint-disable-next-line no-await-in-loop -- small member loop, same sequential precedent
        // as the 'link' branch's own TOCTOU loop below.
        const { data: updatedRows, error: updErr } = await client
          .from('legislators').update(patch).eq('id', row.id).is('person_id', null).select('id');
        if (updErr) throw updErr;
        if (!updatedRows || updatedRows.length === 0) {
          throw new PersonLinkRaceError(
            `legislator_id=${row.id} was linked by a concurrent request between validation and write`,
            { legislatorId: row.id, personId: person_id, flagId: flag_id },
          );
        }

        const candidateEvidence = findCandidateEvidence(flag.evidence, row.id);
        const linkEvidence = buildLanceAttachEvidence(candidateEvidence, {
          flagId: flag.id, clusterKey: flag.cluster_key, linkedLegislatorIds: legislator_ids, personId: person_id, note,
        });
        // eslint-disable-next-line no-await-in-loop
        const { error: linkErr } = await client.from('person_links').insert({
          person_id, legislator_id: row.id, evidence: linkEvidence, decided_by: 'lance',
        });
        if (linkErr) {
          if (isUniqueViolation(linkErr)) {
            throw new PersonLinkRaceError(
              `legislator_id=${row.id} was linked by a concurrent request (person_links race)`,
              { legislatorId: row.id, personId: person_id, flagId: flag_id },
            );
          }
          throw linkErr;
        }
      }

      const allCandidateIds = flag.candidate_legislator_ids ?? [];
      const personIdById = await fetchPersonIdsForCandidates(client, allCandidateIds);
      const allLinked = allCandidateIds.length > 0
        && allCandidateIds.every((id) => personIdById.get(id) != null);

      const patchedEvidence = appendResolution(flag.evidence, {
        action: 'attach', legislatorIds: legislator_ids, personId: person_id, note,
      });
      const flagPatch = { evidence: patchedEvidence };
      if (allLinked) flagPatch.resolved = true;
      const { error: fpErr } = await client.from('identity_flags').update(flagPatch).eq('id', flag_id);
      if (fpErr) throw fpErr;

      sendJson(res, 200, { person_id, resolved: allLinked });
      return;
    }

    // action === 'link' — controller ruling 1: PER-SUBSET. legislator_ids is Lance's selection
    // within this flag, never assumed to be the flag's whole candidate set (a 14-member blob may
    // contain several real people plus noise — each subset is its own decision).
    const candidateIdSet = new Set(flag.candidate_legislator_ids ?? []);
    const outsiders = legislator_ids.filter((id) => !candidateIdSet.has(id));
    if (outsiders.length > 0) { sendJson(res, 400, { error: 'legislator_ids must all belong to this flag' }); return; }

    const { data: selectedRows, error: srErr } = await client
      .from('legislators')
      .select('id,full_name,bioguide_id,openstates_id,mo_house_id,mo_senate_id,legiscan_people_id,person_id')
      .in('id', legislator_ids);
    if (srErr) throw srErr;
    const rows = selectedRows ?? [];
    if (rows.length !== legislator_ids.length) { sendJson(res, 404, { error: 'one or more legislators not found' }); return; }

    // Every selected member's person_id validated null FIRST, before any write for this decision
    // happens at all (controller ruling 4: "conflict-throw path intact" — same all-or-nothing
    // guard as writeAutoCluster's own pre-check in link-persons.js).
    for (const row of rows) {
      if (row.person_id != null) {
        throw new PersonLinkConflictError(
          `legislators.id=${row.id} already has person_id=${row.person_id} — refusing to link it `
            + '(a non-null person_id is never overwritten)',
          { legislatorId: row.id, existingPersonId: row.person_id, flagId: flag_id },
        );
      }
    }

    const { display_name, display_name_source } = pickDisplayName(rows);
    const { data: person, error: insErr } = await client
      .from('persons').insert({ display_name, display_name_source }).select('id').single();
    if (insErr) throw insErr;
    const personId = person.id;

    // TOCTOU guard (final wave, item 3): the pre-check loop above validated person_id===null
    // against a SELECT snapshot taken before this point — a concurrent request (double-submit
    // from a slow UI, or two admins acting on the same flag) could link one of these rows to a
    // DIFFERENT person in the gap between that snapshot and this write. `.is('person_id', null)`
    // makes the UPDATE itself the guard (not just the earlier read), and `.select('id')` lets us
    // see whether it actually matched anything: zero rows back means the guard lost the race.
    // `linkedCount` tracks how many members ALREADY got real person_links rows before the race was
    // detected — if none (the very first member in this decision), the persons row just inserted
    // above links to nothing at all and is cleaned up rather than left an orphan; if some already
    // succeeded, those stay (an honest partial state, same "leave it, don't half-undo real writes"
    // philosophy PersonLinkConflictError's own all-or-nothing pre-check exists to avoid needing in
    // the common case, but can't fully prevent here since this IS the race window itself).
    let linkedCount = 0;
    try {
      for (const row of rows) {
        const patch = additivePatch(row, { person_id: personId });
        // eslint-disable-next-line no-await-in-loop -- small (2-14) member loop, same sequential
        // precedent as writeAutoCluster's own per-member loop.
        const { data: updatedRows, error: updErr } = await client
          .from('legislators').update(patch).eq('id', row.id).is('person_id', null).select('id');
        if (updErr) throw updErr;
        if (!updatedRows || updatedRows.length === 0) {
          throw new PersonLinkRaceError(
            `legislator_id=${row.id} was linked by a concurrent request between validation and write`,
            { legislatorId: row.id, personId, flagId: flag_id },
          );
        }

        const candidateEvidence = findCandidateEvidence(flag.evidence, row.id);
        const linkEvidence = buildLanceLinkEvidence(candidateEvidence, {
          flagId: flag.id, clusterKey: flag.cluster_key, linkedLegislatorIds: legislator_ids, note,
        });
        // eslint-disable-next-line no-await-in-loop
        const { error: linkErr } = await client.from('person_links').insert({
          person_id: personId, legislator_id: row.id, evidence: linkEvidence, decided_by: 'lance',
        });
        if (linkErr) {
          // person_links.legislator_id is unique (migration 0012) — a 23505 here is the SAME race
          // caught one step later (the legislators guard passed, but a concurrent writer's OWN
          // person_links insert landed first), mapped to the identical 409 path rather than a raw
          // 500.
          if (isUniqueViolation(linkErr)) {
            throw new PersonLinkRaceError(
              `legislator_id=${row.id} was linked by a concurrent request (person_links race)`,
              { legislatorId: row.id, personId, flagId: flag_id },
            );
          }
          throw linkErr;
        }
        linkedCount += 1;
      }
    } catch (loopErr) {
      if (loopErr instanceof PersonLinkRaceError && linkedCount === 0) {
        // Nothing links to the just-created person yet — clean it up rather than leaving an
        // orphaned row with zero person_links pointing at it.
        const { error: cleanupErr } = await client.from('persons').delete().eq('id', personId);
        if (cleanupErr) {
          // Micro-round (re-review, execution-proven): the cleanup delete's OWN error return was
          // never checked — a failed cleanup silently stranded an anon-readable orphaned persons
          // row while the client still got a clean 409, as if nothing were wrong. Logged the same
          // way every other unexpected error in this file is (sendServerError's own
          // `[review-server] <context>:` convention) AND surfaced honestly in the 409 body itself
          // — the orphan is never invisible to the caller either, since it requires a human to
          // actually go remove it.
          console.error('[review-server] identity-decision cleanup:', cleanupErr);
          loopErr.cleanupFailed = true;
          loopErr.orphanedPersonId = personId;
        }
      }
      throw loopErr;
    }

    // Controller ruling 1: "remaining candidates stay in the flag until it's fully resolved" —
    // re-check the flag's FULL candidate set (not just this decision's subset) against fresh
    // person_id state; only mark the flag resolved once every candidate is accounted for.
    const allCandidateIds = flag.candidate_legislator_ids ?? [];
    const personIdById = await fetchPersonIdsForCandidates(client, allCandidateIds);
    const allLinked = allCandidateIds.length > 0
      && allCandidateIds.every((id) => personIdById.get(id) != null);

    const patchedEvidence = appendResolution(flag.evidence, {
      action: 'link', legislatorIds: legislator_ids, personId, note,
    });
    const flagPatch = { evidence: patchedEvidence };
    if (allLinked) flagPatch.resolved = true;
    const { error: fpErr } = await client.from('identity_flags').update(flagPatch).eq('id', flag_id);
    if (fpErr) throw fpErr;

    sendJson(res, 200, { person_id: personId, resolved: allLinked });
  } catch (err) {
    if (err instanceof PersonLinkConflictError) {
      sendJson(res, 409, { error: 'one or more selected legislators are already linked to a different person' });
      return;
    }
    if (err instanceof PersonLinkRaceError) {
      // Micro-round (re-review): if the orphan cleanup itself failed (flagged on the error above),
      // the 409 body says so honestly — 'requires manual removal' is a literal, actionable fact,
      // not just an internal detail swallowed by the generic race message below.
      if (err.cleanupFailed) {
        sendJson(res, 409, {
          error: 'concurrent link detected',
          cleanup: `failed — orphaned person ${err.orphanedPersonId} requires manual removal`,
        });
        return;
      }
      sendJson(res, 409, { error: 'one or more selected legislators were linked by a concurrent request' });
      return;
    }
    sendServerError(res, 'identity-decision', err);
  }
}

// ---- Router ----

// clientOverride is test-only dependency injection (a fake Supabase-shaped client) — production
// callers always invoke this with 2 args, so getClient() (real env-based client) is unaffected.
export async function requestListener(req, res, clientOverride) {
  const client = clientOverride ?? getClient();
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && pathname === '/') { sendHtml(res); return; }

  if (req.method === 'GET' && pathname === '/api/queue') { await handleQueue(client, res); return; }

  const itemMatch = pathname.match(/^\/api\/item\/([^/]+)$/);
  if (req.method === 'GET' && itemMatch) { await handleItem(client, res, decodeURIComponent(itemMatch[1])); return; }

  if (req.method === 'POST' && pathname === '/api/decision') {
    if (!isAllowedDecisionRequest(req.headers)) { sendJson(res, 403, { error: 'forbidden' }); return; }
    await handleDecision(client, req, res);
    return;
  }

  // Task 6: glossary review queue routes. Route allowlist extended per the brief — same
  // isAllowedDecisionRequest CSRF guard (it's header-based, not route-specific) gates this POST too.
  if (req.method === 'GET' && pathname === '/api/glossary/queue') { await handleGlossaryQueue(client, res); return; }

  const glossaryItemMatch = pathname.match(/^\/api\/glossary\/item\/([^/]+)$/);
  if (req.method === 'GET' && glossaryItemMatch) {
    await handleGlossaryItem(client, res, decodeURIComponent(glossaryItemMatch[1]));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/glossary/decision') {
    if (!isAllowedDecisionRequest(req.headers)) { sendJson(res, 403, { error: 'forbidden' }); return; }
    await handleGlossaryDecision(client, req, res);
    return;
  }

  // Task 2: identity review tab routes. Same CSRF allowlist as every other decision route.
  if (req.method === 'GET' && pathname === '/api/identity/queue') { await handleIdentityQueue(client, res); return; }

  if (req.method === 'POST' && pathname === '/api/identity/decision') {
    if (!isAllowedDecisionRequest(req.headers)) { sendJson(res, 403, { error: 'forbidden' }); return; }
    await handleIdentityDecision(client, req, res);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  const server = createServer((req, res) => {
    requestListener(req, res).catch((err) => sendServerError(res, 'unhandled', err));
  });
  server.listen(PORT, HOST, () => {
    console.log(`review server listening on http://${HOST}:${PORT}`);
  });
}
