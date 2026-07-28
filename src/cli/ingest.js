import { readFileSync } from 'node:fs';
import { getClient, openRun, closeRun, insertIfAbsent, isMissingRelationError } from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import * as us from '../adapters/us-congress.js';
import * as mo from '../adapters/mo-legislature.js';
import * as senate from '../adapters/us-senate.js';

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
    else if (key === '--votes') out.votes = parseRollRange(val);
    else throw new Error(`unknown flag: ${key}`);
    i += 2;
  }
  if (!['us-congress', 'mo-legislature', 'us-senate'].includes(out.source)) {
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

// Task 2 hard constraint: this task must make ZERO congress.gov requests (a House backfill is
// running against it in another process). senate.gov (menu + roll-call XML) is always fetched;
// congress.gov bill-detail lookups are skipped whenever dryRun is true — Task 3's live backfill
// exercises that path. The menu is fetched even when --votes narrows the run, because per-vote
// `issue` context (needed for finalizeSenateVote's nomination/treaty question composition) only
// lives in the menu, not in the individual roll-call XML.
export async function collectUsSenate({ session, votes, dryRun }) {
  const congress = 119; // mirrors collectUsCongress's hardcoded 119th-Congress assumption
  const failures = [];
  const menuXml = await senate.fetchSenateVoteMenu(congress, session); // fatal: nothing to reconcile without it
  const menu = senate.parseSenateVoteMenu(menuXml);
  const menuByNumber = new Map(menu.map((v) => [v.vote_number, v]));
  const targetNumbers = votes && votes.length > 0
    ? votes
    : menu.map((v) => v.vote_number).sort((a, b) => a - b);

  const bills = new Map();
  const voteRows = [];
  for (const num of targetNumbers) {
    let parsed;
    try {
      const xmlText = await senate.fetchSenateRollCall(congress, session, num);
      parsed = senate.parseSenateRollCall(xmlText);
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      failures.push({ step: `vote ${num}`, message: err.message }); // skip != empty
      continue;
    }
    const menuEntry = menuByNumber.get(num) ?? null;
    const finalVote = senate.finalizeSenateVote(parsed.vote, menuEntry?.issue ?? null);
    if (finalVote.bill_identifier && !dryRun) {
      const slug = us.billTypeSlug(finalVote.bill_identifier);
      const numPart = finalVote.bill_identifier.split(' ')[1];
      try {
        const billJson = await us.fetchBillDetail(congress, slug, numPart);
        bills.set(finalVote.bill_identifier, us.parseBillDetail(billJson));
      } catch (err) {
        if (!(err instanceof SourceFetchError)) throw err;
        failures.push({ step: `bill ${finalVote.bill_identifier}`, message: err.message });
        bills.set(finalVote.bill_identifier, { identifier: finalVote.bill_identifier, title: null, status: null, canonical_url: null });
      }
    }
    voteRows.push({ vote: finalVote, casts: parsed.casts });
  }
  return { bills: [...bills.values()], votes: voteRows, failures, notes: [], sessionIdentifier: '119' };
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

// ---- us-senate persistence + resolution ----

// Deliberate deviation from the generic dry-run pattern above (which skips getClient() entirely):
// Task 2's brief requires --dry-run to still report HONEST resolution stats against whatever
// senate-chamber legislators currently exist in the DB. This mirrors verify.js's own precedent
// (loadCandidateSummaries/loadAlreadyVerifiedIds both read the DB during --dry-run) rather than
// the House/MO ingest pattern. Missing-relation tolerance applies ONLY in dry-run (schema may not
// be applied yet — draft-then-apply); in live mode a missing table propagates as a hard gate.
async function loadCurrentSenators(client, { dryRun }) {
  if (!client) return { senators: [], note: 'no DB client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset)' };
  const { data, error } = await client
    .from('terms')
    .select('legislator_id,district,legislators(full_name)')
    .eq('jurisdiction_id', 'us-congress')
    .eq('chamber', 'senate');
  if (error) {
    if (dryRun && isMissingRelationError(error, 'terms')) {
      return { senators: [], note: 'terms table not found (migration not yet applied) — treating as 0 senators' };
    }
    throw new Error(`senate legislators lookup failed: ${error.message}`);
  }
  const senators = (data ?? []).map((r) => ({
    legislator_id: r.legislator_id,
    state: r.district, // no dedicated state column exists; a Senate seat maps 1:1 to a state the
    // same way a House seat maps to a numbered district, so ensureSenateMembers stores the
    // state's USPS abbreviation here rather than requiring a migration.
    last_name: senate.lastNameFromFullName(r.legislators?.full_name),
    first_name: senate.firstNameFromFullName(r.legislators?.full_name), // resolveSenator's ambiguity tiebreak
  }));
  return { senators, note: null };
}

// Fix round 2 (re-review caught round 1's factual error): a raw congress.gov member's term item
// carries `endYear` once — and ONLY once — that term has actually ended. Round 1's "no endYear
// anywhere" claim was wrong; it was checked against only the first few (current-delegation)
// entries of tests/fixtures/us-congress/members-mo.json, which naturally lack endYear because
// they're ongoing. The full fixture has endYear on 45 of its 55 term items (e.g. Bond -> endYear
// 2011, Carnahan -> endYear 2002); it's absent exactly on the currently-serving ones (Hawley,
// Schmitt, Onder...). That IS a cheap, reliable current-member signal. A member is kept iff AT
// LEAST ONE of their term items lacks endYear — not just their latest one — so a member who
// served a past House term (which has closed with an endYear) and is now serving an ongoing
// Senate term (no endYear yet) is still correctly kept.
export function isCurrentMember(rawMember) {
  const items = rawMember.terms?.item ?? [];
  return items.some((t) => t.endYear == null);
}

// LIVE-ONLY (Task 3 exercises this path; never called during --dry-run). Pages congress.gov's
// full member list, filters to CURRENT members (isCurrentMember, above) and then to Senate
// chamber by reusing parseMemberList's chamber-detection semantics, insertIfAbsent by
// bioguide_id, then upserts a us-congress/senate term per member carrying their state (converted
// to a USPS abbreviation) in the term's `district` column.
//
// Historical rows already inserted by round 1 (before this filter existed) remain in the DB —
// additive discipline (PLAYBOOK §3.5) means this fix doesn't retroactively delete or reconcile
// past writes. resolveSenator's first-name tiebreak (above) still exists and still matters for
// those already-ingested rows, and as a second line of defense against any edge case this filter
// itself doesn't catch (e.g. a member whose current term's endYear the API has already back-
// filled ahead of the actual end-of-term date).
export async function ensureSenateMembers(client, runId) {
  const failures = [];
  const senateMembers = [];
  let filteredHistorical = 0;
  let offset = 0;
  for (;;) {
    let json;
    try {
      json = await us.fetchMemberPage(offset, 250);
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      failures.push({ step: `member page offset=${offset}`, message: err.message });
      break;
    }
    const raw = json.members ?? [];
    // parseMemberList throws on ANY member with no terms at all — pre-filter so one odd
    // historical record can't kill the whole page (brief ruling #2).
    const withTerms = raw.filter((m) => (m.terms?.item ?? []).length > 0);
    if (withTerms.length < raw.length) {
      failures.push({ step: `member page offset=${offset}`, message: `${raw.length - withTerms.length} member(s) with no terms skipped (not fatal)` });
    }
    const current = withTerms.filter(isCurrentMember);
    filteredHistorical += withTerms.length - current.length;
    let members = [];
    try {
      members = us.parseMemberList({ members: current });
    } catch (err) {
      failures.push({ step: `member page offset=${offset}`, message: err.message });
    }
    for (const m of members) if (m.chamber === 'senate') senateMembers.push(m);
    if (raw.length < 250) break;
    offset += 250;
  }

  await insertIfAbsent(client, 'legislators',
    senateMembers.map((m) => ({ full_name: m.full_name, bioguide_id: m.bioguide_id, party: m.party, run_id: runId })),
    'bioguide_id');
  const { data: legRows, error } = await client.from('legislators').select('id,bioguide_id')
    .in('bioguide_id', senateMembers.map((m) => m.bioguide_id));
  if (error) throw new Error(`legislators lookup failed: ${error.message}`);
  const byBioguide = new Map(legRows.map((r) => [r.bioguide_id, r.id]));
  for (const m of senateMembers) {
    const legislatorId = byBioguide.get(m.bioguide_id);
    if (!legislatorId) continue;
    await upsertTerm(client, runId, {
      legislatorId, jurisdictionId: 'us-congress', party: m.party,
      role: { chamber: 'senate', district: senate.stateAbbreviation(m.state), start_date: null, end_date: null },
    });
  }
  return { count: senateMembers.length, filteredHistorical, failures };
}

// Writes votes (+ bills already resolved by collectUsSenate) and only the RESOLVED casts —
// unresolved casts are recorded (never guessed, never placeholder-inserted per design ruling #1)
// and returned for the caller to fold into run detail.
async function persistUsSenate(client, runId, data, senators) {
  const { data: sessionRow } = await client.from('sessions').select('id')
    .eq('jurisdiction_id', 'us-congress').eq('identifier', data.sessionIdentifier).single();
  await insertIfAbsent(client, 'bills',
    data.bills.map((b) => ({ session_id: sessionRow.id, identifier: b.identifier, title: b.title, status: b.status, canonical_url: b.canonical_url, run_id: runId })),
    'session_id,identifier');
  const { data: billRows } = await client.from('bills').select('id,identifier').eq('session_id', sessionRow.id);
  const byIdentifier = new Map(billRows.map((r) => [r.identifier, r.id]));

  let resolved = 0;
  const unresolved = [];
  for (const { vote, casts } of data.votes) {
    await insertIfAbsent(client, 'votes', [{
      bill_id: vote.bill_identifier ? byIdentifier.get(vote.bill_identifier) ?? null : null,
      jurisdiction_id: 'us-congress', chamber: vote.chamber, vote_date: vote.vote_date,
      question: vote.question, result: vote.result, source_url: vote.source_url,
      source_key: vote.source_key, run_id: runId,
    }], 'source_key');
    const { data: voteRow } = await client.from('votes').select('id').eq('source_key', vote.source_key).single();
    const resolvedCasts = [];
    for (const cast of casts) {
      const legislatorId = senate.resolveSenator(cast, senators);
      if (legislatorId) {
        resolved += 1;
        resolvedCasts.push({ vote_id: voteRow.id, legislator_id: legislatorId, position: cast.position, run_id: runId });
      } else {
        unresolved.push({
          vote_source_key: vote.source_key, state: cast.state, last_name: cast.last_name,
          first_name: cast.first_name, party: cast.party,
        });
      }
    }
    await insertIfAbsent(client, 'vote_casts', resolvedCasts, 'vote_id,legislator_id');
  }
  return { resolved, unresolved };
}

// Dry-run-only: computes resolved/unresolved counts WITHOUT writing anything, against whichever
// senators loadCurrentSenators found (possibly zero, pre-Task-3 — reported honestly, not hidden).
function computeResolutionStats(votes, senators) {
  let resolved = 0;
  const unresolvedExamples = [];
  let unresolvedCount = 0;
  for (const { vote, casts } of votes) {
    for (const cast of casts) {
      const legislatorId = senate.resolveSenator(cast, senators);
      if (legislatorId) {
        resolved += 1;
      } else {
        unresolvedCount += 1;
        if (unresolvedExamples.length < 10) {
          unresolvedExamples.push({
            vote_source_key: vote.source_key, state: cast.state, last_name: cast.last_name,
            first_name: cast.first_name, party: cast.party,
          });
        }
      }
    }
  }
  return { resolved, unresolved: unresolvedCount, casts: resolved + unresolvedCount, unresolvedExamples };
}

async function runUsSenate(args) {
  const data = await collectUsSenate({ session: args.session, votes: args.votes, dryRun: args.dryRun });

  if (args.dryRun) {
    // Read-only DB peek is intentional even in dry-run (see loadCurrentSenators); never calls
    // ensureSenateMembers or fetches bill details (already skipped inside collectUsSenate).
    const client = getClient();
    const { senators, note } = await loadCurrentSenators(client, { dryRun: true });
    const stats = computeResolutionStats(data.votes, senators);
    const counts = {
      votes: data.votes.length, bills: data.bills.length, casts: stats.casts,
      resolved: stats.resolved, unresolved: stats.unresolved, senators_in_db: senators.length,
      failures: data.failures.length,
    };
    const sample = {
      vote: data.votes[0]?.vote ?? null,
      cast: data.votes.find((v) => v.casts.length > 0)?.casts[0] ?? null,
      unresolved_sample: stats.unresolvedExamples,
    };
    const notes = [
      note,
      'ensureSenateMembers and bill-detail fetch are LIVE-ONLY and were NOT run this pass (dry-run makes senate.gov requests only, per Task 2 hard constraint)',
    ].filter(Boolean);
    console.log(JSON.stringify({ mode: 'dry-run', source: 'us-senate', counts, sample, notes, failures: data.failures }, null, 2));
    if (data.failures.length > 0) process.exitCode = 2;
    return;
  }

  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }
  const runId = await openRun(client, 'us-senate');
  try {
    const ensured = await ensureSenateMembers(client, runId);
    const { senators } = await loadCurrentSenators(client, { dryRun: false });
    const { resolved, unresolved } = await persistUsSenate(client, runId, data, senators);
    const totalFailures = data.failures.length + ensured.failures.length;
    const counts = {
      votes: data.votes.length, bills: data.bills.length, senate_members_ensured: ensured.count,
      senate_members_filtered_historical: ensured.filteredHistorical,
      casts: resolved + unresolved.length, resolved, unresolved: unresolved.length, failures: totalFailures,
    };
    const status = totalFailures === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts, unresolved, failures: [...data.failures, ...ensured.failures] });
    console.log(JSON.stringify({ mode: 'live', run_id: runId, status, counts }, null, 2));
    if (totalFailures > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.source === 'us-senate') {
    await runUsSenate(args);
    return;
  }
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
