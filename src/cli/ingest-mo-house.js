import { readFileSync } from 'node:fs';
import {
  getClient, openRun, closeRun, insertIfAbsent, additivePatch, isMissingColumnError,
} from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import * as mo from '../adapters/mo-house-xml.js';

// Separate small CLI per task-4-brief.md ("Driver: a separate small CLI ... implementer's call,
// document it") rather than extending src/cli/ingest.js: this source has a fundamentally
// different cadence (30-minute mechanically-enforced limiter vs. the other adapters' sub-10s
// limiters) and a fetch-list-then-loop-per-item shape that doesn't fit ingest.js's existing
// one-collect-call-per-source pattern without complicating it for every other source.

const ROSTER_MEMBER_LIST_FIXTURE = 'tests/fixtures/research/mo-house-xml/member-list-sample-truncated.xml';
const ROSTER_REPRESENTATIVE_FIXTURE = 'tests/fixtures/research/mo-house-xml/representative-107.xml';

export function parseMoHouseArgs(argv) {
  const out = {
    session: mo.DEFAULT_MO_HOUSE_SESSION, limit: 1, dryRun: false, billIdentifier: null, billXmlFile: null,
  };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    const val = argv[i + 1];
    if (key === '--session') out.session = val;
    else if (key === '--limit') out.limit = Number(val);
    else if (key === '--bill') out.billIdentifier = val;
    else if (key === '--bill-xml-file') out.billXmlFile = val;
    else throw new Error(`unknown flag: ${key}`);
    i += 2;
  }
  return out;
}

// ---- collection ----

export async function collectBillList(session) {
  const xmlText = await mo.fetchMoBillList(session);
  return mo.parseMoBillList(xmlText);
}

// Chooses which bill(s) get a per-bill detail fetch this invocation. --bill-xml-file reads a
// LOCAL file instead of a live fetch (never counts against moHouseLimiter) — used this task to
// prove the full bill-detail persistence cycle against an already-captured research fixture
// without spending the second live 30-minute-gated request (see task-4-report.md for why).
export function selectTargets(entries, args) {
  if (args.billXmlFile) {
    if (!args.billIdentifier) throw new Error('--bill-xml-file requires --bill <identifier>');
    return [{ identifier: args.billIdentifier, localFile: args.billXmlFile }];
  }
  if (args.billIdentifier) {
    const found = entries.find((e) => e.identifier === args.billIdentifier);
    if (!found) throw new Error(`bill ${args.billIdentifier} not found in fetched bill list`);
    return [{ identifier: found.identifier, bill_xml_url: found.bill_xml_url }];
  }
  // No documented way to know which bills have RollCall elements without having already
  // fetched their detail XML (BillList.XML carries no such signal) — list-order is the only
  // honest default for a first pass. A future overnight pass could prioritize bills not yet
  // enriched, once some detail has been fetched.
  return entries.slice(0, args.limit).map((e) => ({ identifier: e.identifier, bill_xml_url: e.bill_xml_url }));
}

// ---- persistence ----

async function ensureSessionRow(client, runId, session) {
  await insertIfAbsent(client, 'sessions', [{
    jurisdiction_id: 'mo-legislature', identifier: session, name: mo.MO_HOUSE_SESSION_NAME,
    start_date: null, end_date: null,
  }], 'jurisdiction_id,identifier');
  const { data, error } = await client.from('sessions').select('id')
    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', session).single();
  if (error) throw new Error(`mo-house session lookup failed: ${error.message}`);
  return data;
}

// Additive: insertIfAbsent (upsert + ignoreDuplicates) never overwrites, so a stub row from a
// prior run is left untouched here — persistBillDetail (below) is the only place a bill's
// title/status/canonical_url ever get filled in, via an explicit additive patch.
async function persistBillStubs(client, runId, sessionRow, entries) {
  await insertIfAbsent(client, 'bills', entries.map((e) => ({
    session_id: sessionRow.id, identifier: e.identifier, title: null, status: null, canonical_url: null, run_id: runId,
  })), 'session_id,identifier');
}

// PLAYBOOK_DELTA §3.5 (additive/write-once): a bill already enriched by a prior per-bill fetch
// must never be silently clobbered by a re-fetch. additivePatch only fills currently-null
// fields; bill_actions/votes rely on insertIfAbsent's own unique-constraint dedup instead
// (unique(bill_id,action_date,description) / unique(source_key)) since those are append-only.
async function persistBillDetail(client, runId, sessionRow, parsed) {
  const { data: existing, error: selErr } = await client.from('bills')
    .select('id,title,status,canonical_url')
    .eq('session_id', sessionRow.id).eq('identifier', parsed.bill.identifier).maybeSingle();
  if (selErr) throw new Error(`bill lookup failed: ${selErr.message}`);

  const incoming = { title: parsed.bill.title || null, status: parsed.bill.status, canonical_url: parsed.bill.canonical_url };
  let billId;
  if (!existing) {
    const { data: inserted, error: insErr } = await client.from('bills')
      .insert({ session_id: sessionRow.id, identifier: parsed.bill.identifier, ...incoming, run_id: runId })
      .select('id').single();
    if (insErr) throw new Error(`bill insert failed: ${insErr.message}`);
    billId = inserted.id;
  } else {
    billId = existing.id;
    const patch = additivePatch(existing, incoming);
    if (Object.keys(patch).length > 0) {
      const { error: updErr } = await client.from('bills').update({ ...patch, run_id: runId }).eq('id', billId);
      if (updErr) throw new Error(`bill update failed: ${updErr.message}`);
    }
  }

  const datedActions = parsed.actions.filter((a) => a.date);
  const droppedActions = parsed.actions.length - datedActions.length;
  if (droppedActions > 0) console.error(`note: ${droppedActions} action(s) on ${parsed.bill.identifier} had no PubDate (bill_actions.action_date is not-null); not written`);
  await insertIfAbsent(client, 'bill_actions', datedActions.map((a) => ({
    bill_id: billId, action_date: a.date, description: a.description, run_id: runId,
  })), 'bill_id,action_date,description');

  const voteRows = mo.buildMoVoteRows(parsed.bill.identifier, parsed.rollcalls);
  await insertIfAbsent(client, 'votes', voteRows.map((v) => ({
    bill_id: billId, jurisdiction_id: 'mo-legislature', chamber: v.chamber, vote_date: v.vote_date,
    question: v.question, result: v.result, source_url: v.source_url, source_key: v.source_key, run_id: runId,
  })), 'source_key');

  return { bill_id: billId, actions: parsed.actions.length, rollcalls: parsed.rollcalls.length };
}

// Roster ingestion this task is FIXTURE-SOURCED, not live: the live budget for this task is
// AT MOST ONE live fetch (the bill-list XML) per task-4-brief.md — a live MemberList.XML +
// per-district RepresentativeXML fetch is a future overnight-loop pass, not this run. Exercises
// the real mo_house_id migration-0005 gate against whatever the live DB schema actually is
// right now (skip != empty: a missing column is reported honestly, never silently swallowed).
async function persistRoster(client, runId) {
  const repXml = readFileSync(ROSTER_REPRESENTATIVE_FIXTURE, 'utf8');
  const roster = [mo.parseMoRepresentative(repXml)];
  const rows = roster.map((r) => ({ full_name: r.full_name, mo_house_id: r.mo_house_id, party: r.party, run_id: runId }));
  try {
    await insertIfAbsent(client, 'legislators', rows, 'mo_house_id');
    return {
      attempted: rows.length, persisted: rows.length, skipped: false,
      note: `fixture-sourced roster seed (${ROSTER_REPRESENTATIVE_FIXTURE}) — live per-district roster fetch is a future overnight-loop pass, not this task's live budget`,
    };
  } catch (err) {
    if (isMissingColumnError(err, 'mo_house_id')) {
      return {
        attempted: rows.length, persisted: 0, skipped: true,
        note: 'legislators.mo_house_id column not found — migration 0005 (supabase/migrations/0005_mo_house_id.sql) not yet applied; member persistence skipped this run. bills/actions/votes are unaffected.',
      };
    }
    throw err;
  }
}

// ---- main ----

async function main() {
  const args = parseMoHouseArgs(process.argv.slice(2));

  // The one mandatory live request this task's brief specifies: "(1) the current-session
  // bill-list XML (one request — it is a bulk export listing all bills)". Made unconditionally
  // (even under --dry-run) so --dry-run still reports real, honest counts instead of an empty
  // stub — mirrors src/cli/ingest.js's us-senate --dry-run precedent of still doing real reads.
  const listXml = await mo.fetchMoBillList(args.session);
  console.error(`[${new Date().toISOString()}] fetched bill-list XML (session ${args.session})`);
  const entries = mo.parseMoBillList(listXml);
  const targets = selectTargets(entries, args);

  const client = args.dryRun ? null : getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'dry-run', source: 'mo-house-xml', counts: { bills_listed: entries.length, targets: targets.length } }, null, 2));
    return;
  }

  const runId = await openRun(client, 'mo-house-xml');
  try {
    const sessionRow = await ensureSessionRow(client, runId, args.session);
    await persistBillStubs(client, runId, sessionRow, entries);
    const roster = await persistRoster(client, runId);

    const billResults = [];
    const failures = [];
    for (const target of targets) {
      let xmlText;
      let mode;
      try {
        if (target.localFile) {
          xmlText = readFileSync(target.localFile, 'utf8');
          mode = 'fixture';
          console.error(`[${new Date().toISOString()}] read bill XML ${target.identifier} from local fixture (not a live request): ${target.localFile}`);
        } else {
          xmlText = await mo.fetchMoBillXml(target.bill_xml_url);
          mode = 'live';
          console.error(`[${new Date().toISOString()}] fetched bill XML ${target.identifier} (live)`);
        }
      } catch (err) {
        if (!(err instanceof SourceFetchError)) throw err;
        failures.push({ step: `bill xml ${target.identifier}`, message: err.message });
        continue;
      }
      const parsed = mo.parseMoBillXml(xmlText);
      const result = await persistBillDetail(client, runId, sessionRow, parsed);
      billResults.push({ identifier: target.identifier, mode, ...result });
    }

    const counts = {
      bills_listed: entries.length, bills_detailed: billResults.length, failures: failures.length, roster,
    };
    const status = failures.length === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, billResults, failures, roster });
    console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts, billResults, failures }, null, 2));
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
