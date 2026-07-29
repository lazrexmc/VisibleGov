import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getClient, isMissingRelationError, selectAll } from '../lib/db.js';

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
    let latestVerification = new Map();
    if (idSet.size > 0) {
      // Final-review finding 1 (CRITICAL): was a bare unbounded .select() — past Supabase's
      // 1000-row-per-request cap, "latest verification" was computed over an arbitrary subset, so
      // a newer flagged verification could be invisible to this queue. Routed through selectAll
      // (src/lib/db.js), the one shared pagination helper every full-table-ish select now uses.
      const verResult = await selectAll(client, 'summary_verifications', 'summary_id,overall,verdicts,created_at');
      const rows = resolveVerificationRows(verResult).filter((r) => idSet.has(r.summary_id));
      latestVerification = latestVerificationBySummary(rows);
    }

    sendJson(res, 200, (data ?? []).map((row) => ({
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      bill: row.bills ? { identifier: row.bills.identifier, title: row.bills.title } : null,
      verified: verificationBadge(latestVerification.get(row.id) ?? null).state,
    })));
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

    const verResult = await client
      .from('summary_verifications')
      .select('overall,verdicts,model,created_at')
      .eq('summary_id', id)
      .order('created_at', { ascending: false })
      .limit(1);
    const verRows = resolveVerificationRows(verResult);
    const verification = verRows[0] ?? null;

    sendJson(res, 200, {
      summary: {
        id: summary.id, status: summary.status, body_md: summary.body_md, model: summary.model,
        prompt_version: summary.prompt_version, created_at: summary.created_at, published_at: summary.published_at,
      },
      bill: bill ? { identifier: bill.identifier, title: bill.title, canonical_url: bill.canonical_url } : null,
      text: text ? text.content : null,
      vote,
      verification,
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
