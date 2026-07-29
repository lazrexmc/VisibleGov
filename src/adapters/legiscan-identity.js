import { additivePatch, isMissingColumnError } from '../lib/db.js';
import { normalizePersonName, matchLegislator } from '../lib/person-identity.js';

// LegiScan bulk adapter — person identity (Task 5 of docs/superpowers/plans/2026-07-29-legiscan-
// bulk-adapter.md). Maps a LegiScan `people_id` onto an existing or new `legislators` row. THE
// real matching logic (name normalization, era-overlap, 0/1/>1 classification) lives in the
// reusable src/lib/person-identity.js per CONTROLLER RULING 1 — this module is the LegiScan-
// SHAPED glue around it: the `terms`-table DB query, LegiScan's own field names/formats (role,
// district), and the three-outcome persistence (attach / create / create+flag-ambiguous).
//
// normalizePersonName is re-exported here (not re-implemented) so this module's own published
// interface (task-5-brief.md's original "Interfaces (Produces)" list) stays intact even though
// CONTROLLER RULING 1 moved the canonical implementation to the shared module.
export { normalizePersonName };

// ---- LegiScan field-shape helpers ----
//
// role_id 1/role 'Sen' -> senate is WRONG (verified against the real 189-person fixture,
// dataset-2018-1608: role_id 1 = 'Rep' = house, role_id 2 = 'Sen' = senate) — this maps off the
// STRING `role` field (not role_id) since that's what every real person/sponsor/vote-cast record
// in this plan's fixtures actually carries verbatim; role_id is redundant with it and not used.
const ROLE_CHAMBER = { Sen: 'senate', Rep: 'house' };

export class UnrecognizedLegiscanRoleError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'UnrecognizedLegiscanRoleError';
    Object.assign(this, meta);
  }
}

export function chamberFromRole(role) {
  const chamber = ROLE_CHAMBER[role];
  if (!chamber) {
    throw new UnrecognizedLegiscanRoleError(
      `legiscan-identity: unrecognized role "${role}" (expected "Sen" or "Rep" — verified-exhaustive `
        + 'against the real 189-person fixture, dataset-2018-1608)',
      { role },
    );
  }
  return chamber;
}

// normalizeLegiscanDistrict — LegiScan's district field is 'SD-002' (senate) / 'HD-049' (house) —
// verified against EVERY one of the real 189 person records in dataset-2018-1608 (all 189 match
// this shape, zero exceptions: 156 'HD-N', 33 'SD-N'). The rest of this repo's per-source district
// identity columns (mo_senate_id, mo_house_id — migrations 0008/0005) are bare zero-stripped
// numbers as text ('2', '49'; see mo-senate-web.js's parseSenateRosterHtml/parseSenateRosterPdf
// and mo-house-xml.js's parseMoRepresentative, neither of which ever prints a chamber-letter
// prefix or leading zeros) — this function converts LegiScan's own format to that SAME bare-number
// convention so `terms.district` values from every source line up for the era-scoped join, rather
// than requiring findCandidateLegislatorRows to know about per-source district spellings.
export function normalizeLegiscanDistrict(district) {
  const s = String(district ?? '').trim();
  const m = s.match(/^[SH]D-?(\d+)$/i);
  if (!m) return s; // unrecognized shape: pass through unchanged rather than guess — a
  // downstream 0-candidate no_match is the honest, safe failure mode for a district string this
  // function doesn't understand, never a silently-wrong strip.
  return String(Number(m[1]));
}

// ---- era-scoped candidate lookup (CONTROLLER RULING 5 / task-5-brief.md's explicit interface) ----
//
// Queries `terms` (chamber + district — a server-side filter that bounds this to a handful of
// rows: one seat's occupants across every era on file, never more) joined to `legislators` for
// full_name, per the mo-senate Critical bug's own fix shape (src/cli/ingest-mo-senate.js's
// ensureRosterIdentities/resolveMoSenator comments) — NEVER a bare district lookup on its own.
// Plain .select() (not selectAll, src/lib/db.js:85) is correct here per the brief: the chamber+
// district filter alone already bounds the result set nowhere near the 1000-row page default.
//
// The REAL era-overlap + normalized-name filtering happens in matchLegislator (src/lib/person-
// identity.js) — this function's own job is strictly the DB fetch + reshaping into the pool
// matchLegislator expects, so the actual matching predicate lives in exactly one place, reusable
// by every future source.
export async function findCandidateLegislatorRows(client, {
  fullNameNormalized, chamber, district, sessionStartDate, sessionEndDate,
}) {
  const { data, error } = await client
    .from('terms')
    .select('legislator_id,chamber,district,start_date,end_date,legislators(full_name)')
    .eq('chamber', chamber)
    .eq('district', district);
  if (error) throw new Error(`legiscan-identity candidate lookup failed: ${error.message}`);
  const pool = (data ?? []).map((t) => ({
    legislator_id: t.legislator_id,
    full_name: t.legislators?.full_name ?? null,
    chamber: t.chamber,
    district: t.district,
    start_date: t.start_date,
    end_date: t.end_date,
  }));
  // fullNameNormalized is already normalized by the caller (resolveOrCreateLegiscanPerson) —
  // passed straight through to matchLegislator's `candidate.full_name`. normalizePersonName is
  // idempotent on an already-normalized string (lowercase, no punctuation, no comma), so this is
  // safe even though matchLegislator normalizes again internally.
  const { matches } = matchLegislator(
    {
      full_name: fullNameNormalized,
      chamber,
      district,
      era: { start: sessionStartDate ?? null, end: sessionEndDate ?? null },
    },
    pool,
  );
  return matches;
}

// ---- conflict + gating ----

export class LegiscanIdentityConflictError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LegiscanIdentityConflictError';
    Object.assign(this, meta);
  }
}

function gatedResult(note) {
  return {
    matched: false, created: false, gated: true, legislator_id: null, reason: 'missing_column', note,
  };
}

const MISSING_COLUMN_NOTE = 'legislators.legiscan_people_id column not found — migration 0010 '
  + '(supabase/migrations/0010_legiscan_identity_and_ledger.sql) not yet applied; person resolution '
  + 'skipped for this call. Never guessed — retried automatically once the migration lands.';

// ---- the three-outcome resolver (CONTROLLER RULING 2, task-5-brief.md's explicit interface) ----
//
// legiscanPerson: real fixture shape — a sponsors[]/roll_call.votes[]-adjacent person record (see
// mo-2018-SB894.json's sponsors[] and dataset-2018-1608's people/*.json): { people_id, name,
// first_name, last_name, party, role, district, ... }. sessionWindow: { startDate, endDate } (ISO
// 'YYYY-MM-DD' strings, or null for an unbounded side) — the LegiScan session's own coverage
// window, era-scoping the candidate search (CONTROLLER RULING 5: "the era for matching = the
// session year(s)").
//
// Path 1 (exact-match on legiscan_people_id) is checked FIRST and is the ONLY path a repeat call
// for an already-mapped person ever takes — a safe unique-key lookup, zero fuzzy matching. This is
// the isolation task-5-brief.md's own "Produces" note calls out: the fragile full_name+chamber+
// district matching in findCandidateLegislatorRows/matchLegislator runs at most ONCE per real
// person, never in Task 6's vote-cast resolution hot path.
export async function resolveOrCreateLegiscanPerson(client, runId, legiscanPerson, sessionWindow = {}) {
  const { data: existing, error: selErr } = await client
    .from('legislators')
    .select('id,legiscan_people_id')
    .eq('legiscan_people_id', legiscanPerson.people_id)
    .maybeSingle();
  if (selErr) {
    if (isMissingColumnError(selErr, 'legiscan_people_id')) return gatedResult(MISSING_COLUMN_NOTE);
    throw new Error(`legiscan-identity exact-match lookup failed for people_id=${legiscanPerson.people_id}: ${selErr.message}`);
  }
  if (existing) {
    return {
      matched: true, created: false, gated: false, legislator_id: existing.id, reason: 'exact_key',
    };
  }

  // First time seen for this people_id: the ONE place this plan's fuzzy full_name+chamber+
  // district matching ever runs (task-5-brief.md's own "Produces" note).
  const chamber = chamberFromRole(legiscanPerson.role);
  const district = normalizeLegiscanDistrict(legiscanPerson.district);
  const fullNameNormalized = normalizePersonName(legiscanPerson.name);
  const candidates = await findCandidateLegislatorRows(client, {
    fullNameNormalized,
    chamber,
    district,
    sessionStartDate: sessionWindow.startDate ?? null,
    sessionEndDate: sessionWindow.endDate ?? null,
  });

  if (candidates.length === 0) {
    const { data: created, error: insErr } = await client
      .from('legislators')
      .insert({
        full_name: legiscanPerson.name, party: legiscanPerson.party ?? null, legiscan_people_id: legiscanPerson.people_id, run_id: runId,
      })
      .select('id')
      .single();
    if (insErr) {
      if (isMissingColumnError(insErr, 'legiscan_people_id')) return gatedResult(MISSING_COLUMN_NOTE);
      throw new Error(`legiscan-identity insert (no_candidate) failed for people_id=${legiscanPerson.people_id}: ${insErr.message}`);
    }
    return {
      matched: false, created: true, gated: false, legislator_id: created.id, reason: 'no_candidate',
    };
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    const { data: row, error: rowErr } = await client
      .from('legislators')
      .select('id,legiscan_people_id')
      .eq('id', candidate.legislator_id)
      .single();
    if (rowErr) throw new Error(`legiscan-identity row re-read failed for legislator_id=${candidate.legislator_id}: ${rowErr.message}`);

    // Conflict guard (task-5-brief.md, explicit): a DIFFERENT legiscan_people_id already on this
    // row is a hard error, never a silent overwrite. additivePatch's own fills-null-only semantics
    // would just quietly skip the field on a conflict — that is NOT what's required here, so the
    // conflict is checked explicitly, before additivePatch ever runs.
    if (row.legiscan_people_id != null && row.legiscan_people_id !== legiscanPerson.people_id) {
      throw new LegiscanIdentityConflictError(
        `legislators.id=${row.id} already has legiscan_people_id=${row.legiscan_people_id}, cannot `
          + `attach people_id=${legiscanPerson.people_id} (name match found exactly one candidate — `
          + 'this is a real data conflict, not guessed at)',
        { legislatorId: row.id, existingPeopleId: row.legiscan_people_id, incomingPeopleId: legiscanPerson.people_id },
      );
    }

    const patch = additivePatch(row, { legiscan_people_id: legiscanPerson.people_id });
    if (Object.keys(patch).length === 0) {
      // Same id already attached (idempotent repeat of a single-candidate resolution, e.g. a
      // re-run before the first write's exact-key path would normally short-circuit) — no write
      // needed, matched all the same.
      return {
        matched: true, created: false, gated: false, legislator_id: row.id, reason: 'already_attached',
      };
    }
    const { error: updErr } = await client.from('legislators').update(patch).eq('id', row.id);
    if (updErr) {
      if (isMissingColumnError(updErr, 'legiscan_people_id')) return gatedResult(MISSING_COLUMN_NOTE);
      throw new Error(`legiscan-identity patch failed for legislator_id=${row.id}: ${updErr.message}`);
    }
    return {
      matched: true, created: false, gated: false, legislator_id: row.id, reason: 'single_candidate',
    };
  }

  // >1 candidates: FAIL LOUD — create a new row anyway (never guess-merge between ambiguous
  // candidates), log { matched:false, reason:'ambiguous', candidateCount } for TODO item 8's
  // future identity-merge review.
  const { data: created, error: insErr } = await client
    .from('legislators')
    .insert({
      full_name: legiscanPerson.name, party: legiscanPerson.party ?? null, legiscan_people_id: legiscanPerson.people_id, run_id: runId,
    })
    .select('id')
    .single();
  if (insErr) {
    if (isMissingColumnError(insErr, 'legiscan_people_id')) return gatedResult(MISSING_COLUMN_NOTE);
    throw new Error(`legiscan-identity insert (ambiguous) failed for people_id=${legiscanPerson.people_id}: ${insErr.message}`);
  }
  return {
    matched: false, created: true, gated: false, legislator_id: created.id, reason: 'ambiguous', candidateCount: candidates.length,
  };
}
