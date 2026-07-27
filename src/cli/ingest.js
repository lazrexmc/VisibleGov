import { readFileSync } from 'node:fs';
import { getClient, openRun, closeRun, insertIfAbsent } from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import * as us from '../adapters/us-congress.js';
import * as mo from '../adapters/mo-legislature.js';

export function parseRollRange(spec) {
  const m = String(spec).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`bad roll range: ${spec}`);
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

export function parseArgs(argv) {
  const out = { pages: 1, year: new Date().getFullYear(), dryRun: false };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') {
      out.dryRun = true;
      i += 1;
      continue;
    }
    const val = argv[i + 1];
    if (key === '--source') out.source = val;
    else if (key === '--rolls') out.rolls = parseRollRange(val);
    else if (key === '--year') out.year = Number(val);
    else if (key === '--session') out.session = val;
    else if (key === '--pages') out.pages = Number(val);
    else throw new Error(`unknown flag: ${key}`);
    i += 2;
  }
  if (!['us-congress', 'mo-legislature'].includes(out.source)) {
    throw new Error(`unknown source: ${out.source}`);
  }
  return out;
}

// ---- collection (pure of DB: returns canonical rows + failures, never swallows into []) ----

export async function collectUsCongress({ rolls, year }) {
  const failures = [];
  const memberJson = await us.fetchMemberList('MO'); // throws on failure: fatal, nothing to reconcile
  const legislators = us.parseMemberList(memberJson);
  const bills = new Map();
  const votes = [];
  for (const roll of rolls) {
    try {
      const xmlText = await us.fetchHouseRollCall(roll, year);
      const { vote, casts } = us.parseHouseRollCall(xmlText, { year });
      if (vote.bill_identifier) {
        const slug = us.billTypeSlug(vote.bill_identifier);
        const num = vote.bill_identifier.split(' ')[1];
        try {
          const billJson = await us.fetchBillDetail(119, slug, num);
          bills.set(vote.bill_identifier, us.parseBillDetail(billJson));
        } catch (err) {
          if (!(err instanceof SourceFetchError)) throw err;
          failures.push({ step: `bill ${vote.bill_identifier}`, message: err.message });
          bills.set(vote.bill_identifier, { identifier: vote.bill_identifier, title: null, status: null, canonical_url: null });
        }
      }
      votes.push({ vote, casts });
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      failures.push({ step: `roll ${roll}`, message: err.message }); // skip != empty: recorded, not silent
    }
  }
  return { legislators, bills: [...bills.values()], votes, failures, notes: [], sessionIdentifier: '119' };
}

export async function collectMoLegislature({ session, pages }) {
  const failures = [];
  const notes = [];
  const sessionsJson = await mo.fetchSessions();
  const sessions = mo.parseSessions(sessionsJson);
  const cfg = JSON.parse(readFileSync('slice.config.json', 'utf8'));
  const personJson = await mo.fetchPersonById(cfg.onder.openstates_id);
  const person = mo.parsePerson(personJson);

  // Controller ruling: Onder is retired, so OpenStates returns roles: []. Derive a single
  // role from slice.config.json's verified mo_senate_district so a district/chamber is never
  // silently missing for the one legislator this slice cares about.
  let roles = person.roles;
  if (roles.length === 0) {
    roles = [{ chamber: 'senate', district: String(cfg.onder.mo_senate_district), start_date: null, end_date: null }];
    notes.push('derived:slice.config');
    console.error(
      `note: derived:slice.config — synthesized role for ${person.full_name} `
      + `(chamber=senate, district=${cfg.onder.mo_senate_district}); upstream OpenStates `
      + 'person record has no current_role/other_roles (retired member)',
    );
  }

  const bills = [];
  const votes = [];
  for (let page = 1; page <= pages; page += 1) {
    try {
      const pageJson = await mo.fetchBillsWithVotes(session, page);
      for (const item of mo.parseBillsWithVotes(pageJson)) {
        bills.push(item.bill);
        for (const v of item.votes) votes.push({ ...v, bill_identifier: item.bill.identifier });
      }
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      failures.push({ step: `bills page ${page}`, message: err.message });
    }
  }
  // Known data reality (Tasks 7-8, verified): OpenStates MO vote events carry empty per-voter
  // casts arrays. `votes` above legitimately has entries with casts: [] — that is not a failure.
  return {
    legislators: [{ openstates_id: person.openstates_id, full_name: person.full_name, party: person.party, roles }],
    bills, votes, failures, notes,
    sessionIdentifier: session, sessionMeta: sessions.find((s) => s.identifier === session) ?? null,
  };
}

// ---- persistence ----

async function persistUsCongress(client, runId, data) {
  await insertIfAbsent(client, 'legislators',
    data.legislators.map((l) => ({ full_name: l.full_name, bioguide_id: l.bioguide_id, party: l.party, run_id: runId })),
    'bioguide_id');
  const { data: sessionRow } = await client.from('sessions').select('id')
    .eq('jurisdiction_id', 'us-congress').eq('identifier', data.sessionIdentifier).single();
  await insertIfAbsent(client, 'bills',
    data.bills.map((b) => ({ session_id: sessionRow.id, identifier: b.identifier, title: b.title, status: b.status, canonical_url: b.canonical_url, run_id: runId })),
    'session_id,identifier');
  const { data: legRows } = await client.from('legislators').select('id,bioguide_id').not('bioguide_id', 'is', null);
  const byBioguide = new Map(legRows.map((r) => [r.bioguide_id, r.id]));
  const { data: billRows } = await client.from('bills').select('id,identifier').eq('session_id', sessionRow.id);
  const byIdentifier = new Map(billRows.map((r) => [r.identifier, r.id]));
  for (const { vote, casts } of data.votes) {
    await insertIfAbsent(client, 'votes', [{
      bill_id: vote.bill_identifier ? byIdentifier.get(vote.bill_identifier) ?? null : null,
      jurisdiction_id: 'us-congress', chamber: vote.chamber, vote_date: vote.vote_date,
      question: vote.question, result: vote.result, source_url: vote.source_url,
      source_key: vote.source_key, run_id: runId,
    }], 'source_key');
    const { data: voteRow } = await client.from('votes').select('id').eq('source_key', vote.source_key).single();
    const unknown = casts.filter((c) => !byBioguide.has(c.bioguide_id));
    await insertIfAbsent(client, 'legislators',
      unknown.map((c) => ({ full_name: c.bioguide_id, bioguide_id: c.bioguide_id, run_id: runId })), 'bioguide_id');
    if (unknown.length > 0) {
      const { data: refreshed } = await client.from('legislators').select('id,bioguide_id').not('bioguide_id', 'is', null);
      for (const r of refreshed) byBioguide.set(r.bioguide_id, r.id);
    }
    await insertIfAbsent(client, 'vote_casts',
      casts.map((c) => ({ vote_id: voteRow.id, legislator_id: byBioguide.get(c.bioguide_id), position: c.position, run_id: runId })),
      'vote_id,legislator_id');
  }
}

// Controller ruling: rows with a null start_date can't be deduped by insertIfAbsent's
// upsert-on-conflict — Postgres unique indexes never treat two NULLs as equal, so every
// re-run would insert a fresh duplicate term. Manually check for an existing row first.
async function findExistingTerm(client, { legislatorId, jurisdictionId, chamber, district }) {
  let query = client.from('terms').select('id')
    .eq('legislator_id', legislatorId)
    .eq('jurisdiction_id', jurisdictionId)
    .eq('chamber', chamber);
  query = district === null || district === undefined ? query.is('district', null) : query.eq('district', district);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`terms lookup failed: ${error.message}`);
  return data;
}

async function upsertTerm(client, runId, { legislatorId, jurisdictionId, party, role }) {
  const row = {
    legislator_id: legislatorId, jurisdiction_id: jurisdictionId, chamber: role.chamber,
    district: role.district, party, start_date: role.start_date, end_date: role.end_date, run_id: runId,
  };
  if (role.start_date === null || role.start_date === undefined) {
    const existing = await findExistingTerm(client, {
      legislatorId, jurisdictionId, chamber: role.chamber, district: role.district,
    });
    if (existing) return;
    const { error } = await client.from('terms').insert(row);
    if (error) throw new Error(`terms insert failed: ${error.message}`);
    return;
  }
  await insertIfAbsent(client, 'terms', [row], 'legislator_id,jurisdiction_id,chamber,district,start_date');
}

async function persistMoLegislature(client, runId, data) {
  await insertIfAbsent(client, 'sessions', [{
    jurisdiction_id: 'mo-legislature', identifier: data.sessionIdentifier,
    name: data.sessionMeta?.name ?? null, start_date: data.sessionMeta?.start_date ?? null,
    end_date: data.sessionMeta?.end_date ?? null,
  }], 'jurisdiction_id,identifier');
  const { data: sessionRow } = await client.from('sessions').select('id')
    .eq('jurisdiction_id', 'mo-legislature').eq('identifier', data.sessionIdentifier).single();
  for (const l of data.legislators) {
    await insertIfAbsent(client, 'legislators',
      [{ full_name: l.full_name, openstates_id: l.openstates_id, party: l.party, run_id: runId }], 'openstates_id');
    const { data: legRow } = await client.from('legislators').select('id').eq('openstates_id', l.openstates_id).single();
    for (const role of (l.roles ?? [])) {
      await upsertTerm(client, runId, {
        legislatorId: legRow.id, jurisdictionId: 'mo-legislature', party: l.party, role,
      });
    }
  }
  await insertIfAbsent(client, 'bills',
    data.bills.map((b) => ({ session_id: sessionRow.id, identifier: b.identifier, title: b.title, status: b.status, canonical_url: b.canonical_url, run_id: runId })),
    'session_id,identifier');
  const { data: billRows } = await client.from('bills').select('id,identifier').eq('session_id', sessionRow.id);
  const byIdentifier = new Map(billRows.map((r) => [r.identifier, r.id]));
  const { data: legRows } = await client.from('legislators').select('id,openstates_id').not('openstates_id', 'is', null);
  const byOsId = new Map(legRows.map((r) => [r.openstates_id, r.id]));
  for (const { vote, casts, bill_identifier } of data.votes) {
    await insertIfAbsent(client, 'votes', [{
      bill_id: byIdentifier.get(bill_identifier) ?? null,
      jurisdiction_id: 'mo-legislature', chamber: vote.chamber, vote_date: vote.vote_date,
      question: vote.question, result: vote.result, source_url: vote.source_url,
      source_key: vote.source_key, run_id: runId,
    }], 'source_key');
    const { data: voteRow } = await client.from('votes').select('id').eq('source_key', vote.source_key).single();
    // Known data reality: MO casts arrays are legitimately empty (OpenStates gap) — every
    // filter/insert below is a correct, harmless no-op in that case, not an error path.
    const resolvable = casts.filter((c) => c.openstates_id);
    const unknown = resolvable.filter((c) => !byOsId.has(c.openstates_id));
    await insertIfAbsent(client, 'legislators',
      unknown.map((c) => ({ full_name: c.voter_name, openstates_id: c.openstates_id, run_id: runId })), 'openstates_id');
    if (unknown.length > 0) {
      const { data: refreshed } = await client.from('legislators').select('id,openstates_id').not('openstates_id', 'is', null);
      for (const r of refreshed) byOsId.set(r.openstates_id, r.id);
    }
    await insertIfAbsent(client, 'vote_casts',
      resolvable.map((c) => ({ vote_id: voteRow.id, legislator_id: byOsId.get(c.openstates_id), position: c.position, run_id: runId })),
      'vote_id,legislator_id');
    const dropped = casts.length - resolvable.length;
    if (dropped > 0) console.error(`note: ${dropped} cast(s) on ${vote.source_key} had no voter id (name-only); not written`);
  }
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const collect = args.source === 'us-congress' ? collectUsCongress : collectMoLegislature;
  const data = await collect(args);
  const counts = {
    legislators: data.legislators.length,
    bills: data.bills.length,
    votes: data.votes.length,
    casts: data.votes.reduce((n, v) => n + v.casts.length, 0),
    failures: data.failures.length,
  };
  const sample = {
    legislator: data.legislators[0] ?? null,
    bill: data.bills[0] ?? null,
    vote: data.votes[0]?.vote ?? null,
    cast: data.votes.find((v) => v.casts.length > 0)?.casts[0] ?? null,
  };
  // Controller ruling: --dry-run skips getClient() entirely (schema may not exist yet); absent
  // the flag, a missing/incomplete Supabase client still falls back to dry-run automatically.
  const client = args.dryRun ? null : getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'dry-run', source: args.source, counts, sample, notes: data.notes, failures: data.failures }, null, 2));
  } else {
    const runId = await openRun(client, args.source);
    try {
      if (args.source === 'us-congress') await persistUsCongress(client, runId, data);
      else await persistMoLegislature(client, runId, data);
      const status = data.failures.length === 0 ? 'succeeded' : 'partial';
      await closeRun(client, runId, status, { counts, notes: data.notes, failures: data.failures });
      console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts, failures: data.failures }, null, 2));
    } catch (err) {
      await closeRun(client, runId, 'failed', { counts, error: String(err) });
      throw err;
    }
  }
  if (data.failures.length > 0) process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
