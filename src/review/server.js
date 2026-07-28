import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getClient, isMissingRelationError } from '../lib/db.js';

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
export function verificationBadge(verification) {
  if (!verification) return { state: 'unverified', label: 'Unverified' };
  const verdicts = verification.verdicts || [];
  if (verification.overall === 'clean') {
    return { state: 'clean', label: `Verifier found all ${verdicts.length} bullets supported` };
  }
  const unsupported = verdicts.filter((v) => !v.supported).length;
  return { state: 'flagged', label: `Verifier flagged ${unsupported} of ${verdicts.length} bullets` };
}

// A summary can be re-verified over time (e.g. after a re-run); the latest row by created_at is
// the one that matters for display — same "last wins" pattern as pickLatestVote.
export function latestVerificationBySummary(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const existing = map.get(r.summary_id);
    if (!existing || (r.created_at ?? '') > (existing.created_at ?? '')) map.set(r.summary_id, r);
  }
  return map;
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
      .in('status', ['draft', 'stale'])
      .order('created_at', { ascending: true });
    if (error) throw error;

    const ids = (data ?? []).map((row) => row.id);
    let latestVerification = new Map();
    if (ids.length > 0) {
      const verResult = await client
        .from('summary_verifications').select('summary_id,overall,verdicts,created_at').in('summary_id', ids);
      latestVerification = latestVerificationBySummary(resolveVerificationRows(verResult));
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
