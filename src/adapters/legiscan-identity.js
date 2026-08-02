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

// MO_JURISDICTION_ID — CRITICAL fix (round 2, reviewer-reproduced): `terms` is a SHARED table
// across every jurisdiction this repo ingests (us-congress AND mo-legislature use the exact same
// table, same chamber/district vocabulary — see src/cli/ingest.js's persistUsCongress/
// persistMoLegislature, both writing plain `terms` rows). Without a jurisdiction filter, a US
// Congress member's `terms` row (plain numeric district, chamber 'house'/'senate' — the SAME
// vocabulary MO uses) can collide with a LegiScan MO sponsor's chamber+district+name and get
// treated as a real candidate: the reviewer reproduced a MO state sponsor's legiscan_people_id
// attaching to a FEDERAL legislator row as a false 'single_candidate' match. This adapter is
// MO-only by construction (the whole plan is MO bill/vote backfill) — hardcoded here, not passed
// as a parameter, and NOT pushed down into person-identity.js (which stays jurisdiction-agnostic
// per CONTROLLER RULING 1 — a future bioguide/openstates source would supply its OWN jurisdiction
// scoping the same way, at the DB-query layer, not inside the shared matcher).
const MO_JURISDICTION_ID = 'mo-legislature';

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

// LEGISCAN_PARTY_WORD_MAP / normalizeLegiscanParty — FIX (2026-08-02, found during a post-TODO-27
// verification sweep). LegiScan's own cached datasets print party as a bare code ('R'/'D', verified
// directly against the newest cached dataset's real `people[]` — never a full word), while every
// OTHER active source (mo-house-xml, us-congress, us-senate) already writes the full printed word.
// TODO 27's live correction (correct-data.js's party-normalize) fixed the HISTORICAL rows, but did
// nothing to stop a FUTURE LegiScan-introduced legislator from re-dirtying the column the moment
// this driver's own insertIfAbsent below writes their first row — this is that structural fix, at
// the point of insertion, matching the SAME mapping (sourced from migration 0018's own already-
// reviewed CASE expression, not reinvented) rather than leaving normalization to a periodic
// re-correction someone has to remember to re-run. `correct-data.js`'s party-normalize now imports
// this SAME map, so the historical correction and this insertion-time fix can never drift apart.
export const LEGISCAN_PARTY_WORD_MAP = { R: 'Republican', D: 'Democratic' };

export function normalizeLegiscanParty(party) {
  if (party == null) return null;
  return LEGISCAN_PARTY_WORD_MAP[party] ?? party; // unrecognized code (e.g. already 'Independent',
  // or a future code this map doesn't know): pass through unchanged rather than guess.
}

// buildLegiscanNameVariants — CONTROLLER RULING 3, AMENDED (fix round 1). LegiScan's own person
// record prints a `nickname` field alongside `name`/`first_name`/`last_name` (verified in the real
// fixture: Robert Onder, people_id 16351, `name:"Robert Onder"`, `nickname:"Bob"`). When present,
// the nickname variant is built the SAME shape `name` itself already is (first + last, no middle
// name, no suffix — verified: Onder's own `name` field omits `middle_name:"Frank"` and
// `suffix:"Jr."` too), just with `nickname` substituted for the given first name: `"Bob Onder"`.
// This is the source's OWN printed data (person.nickname), never a nickname table this module
// invents or looks up elsewhere — see person-identity.js's buildNameVariantSet for how this feeds
// into matchLegislator's still-exact (never fuzzy) comparison.
export function buildLegiscanNameVariants(legiscanPerson) {
  const variants = [legiscanPerson.name];
  const nickname = String(legiscanPerson.nickname ?? '').trim();
  const lastName = String(legiscanPerson.last_name ?? '').trim();
  if (nickname && lastName) variants.push(`${nickname} ${lastName}`);
  return variants;
}

// ---- per-source identity-column fallback (CONCERN 1 fix round — controller ruling) ----
//
// A REAL, currently-live gap: src/cli/ingest-mo-senate.js's ensureRosterIdentities stamps
// legislators.mo_senate_id directly from the era roster but writes NO `terms` row at all (verified
// by reading that file — the roster ensure only ever inserts/updates the `legislators` row itself).
// mo-house-xml.js's mo_house_id column exists for the identical reason. Without this fallback,
// findCandidateLegislatorRows would find ZERO real candidates for any legislator persisted only
// through those two drivers — including the running example, Bob Onder's live mo_senate row.
//
// A row with mo_senate_id='2' IS senate/district-2 evidence (the column exists ONLY for MO
// senators, stamped only by the mo-senate driver); same for mo_house_id/house. `terms` rows remain
// the PREFERRED evidence when present — they carry real start_date/end_date, so era-overlap can
// genuinely be checked. Column-derived evidence carries NO dates at all (start_date/end_date: null
// below) — era-overlap can never rule it out (eraOverlaps treats null as "cannot rule out
// overlap"), which is an honestly-documented weaker signal, not silently assumed correct. Used
// ONLY as a fallback for legislator_ids the `terms` query did not already find (`alreadyFoundIds`)
// — never a duplicate/second candidate entry for a legislator that already has terms evidence.
// A legislator row with NEITHER a `terms` row NOR the chamber-relevant column set is never fetched
// by either query, so it is never a candidate at all — an honest exclusion, not a silent gap.
//
// No jurisdiction filter needed here (unlike the `terms` query's CRITICAL fix above): mo_senate_id
// and mo_house_id are MO-only columns by construction (migrations 0008/0005 — stamped ONLY by the
// mo-senate/mo-house drivers), never set by us-congress or any other jurisdiction's ingestion, so
// there is no cross-jurisdiction collision surface at this layer.
const CHAMBER_DISTRICT_COLUMN = { senate: 'mo_senate_id', house: 'mo_house_id' };

async function fetchColumnDerivedCandidates(client, chamber, district, alreadyFoundLegislatorIds) {
  const column = CHAMBER_DISTRICT_COLUMN[chamber];
  if (!column) return []; // an unrecognized chamber has no column-evidence fallback at all
  const { data, error } = await client.from('legislators').select(`id,full_name,${column}`).eq(column, district);
  if (error) {
    // Migration 0005/0008 not applied in this environment: no column-derived evidence is
    // available, but this is NOT fatal to the overall lookup — terms-based evidence (if any) still
    // stands on its own; this fallback simply contributes nothing this call.
    if (isMissingColumnError(error, column)) return [];
    throw new Error(`legiscan-identity column-derived candidate lookup failed (${column}): ${error.message}`);
  }
  return (data ?? [])
    .filter((row) => !alreadyFoundLegislatorIds.has(row.id))
    .map((row) => ({
      legislator_id: row.id, full_name: row.full_name, chamber, district, start_date: null, end_date: null,
    }));
}

// ---- era-scoped candidate lookup (CONTROLLER RULING 5 / task-5-brief.md's explicit interface) ----
//
// Queries `terms` (chamber + district — a server-side filter that bounds this to a handful of
// rows: one seat's occupants across every era on file, never more) joined to `legislators` for
// full_name, per the mo-senate Critical bug's own fix shape (src/cli/ingest-mo-senate.js's
// ensureRosterIdentities/resolveMoSenator comments) — NEVER a bare district lookup on its own. Then
// falls back to per-source identity-column evidence (fetchColumnDerivedCandidates above) for any
// legislator the `terms` query didn't already surface. Plain .select() (not selectAll,
// src/lib/db.js:85) is correct here per the brief: the chamber+district filter alone already
// bounds each query's result set nowhere near the 1000-row page default.
//
// The REAL era-overlap + normalized-name(-variant) filtering happens in matchLegislator
// (src/lib/person-identity.js) — this function's own job is strictly the DB fetch(es) + reshaping
// into the pool matchLegislator expects, so the actual matching predicate lives in exactly one
// place, reusable by every future source.
export async function findCandidateLegislatorRows(client, {
  fullNameNormalized, nameVariantsNormalized = [], chamber, district, sessionStartDate, sessionEndDate,
}) {
  const { data, error } = await client
    .from('terms')
    .select('legislator_id,chamber,district,start_date,end_date,legislators(full_name)')
    .eq('jurisdiction_id', MO_JURISDICTION_ID) // CRITICAL fix (round 2): terms is shared across
    // jurisdictions — without this, a same-chamber/same-district/same-name `terms` row from a
    // DIFFERENT jurisdiction (e.g. us-congress) is indistinguishable from a real MO candidate.
    .eq('chamber', chamber)
    .eq('district', district);
  if (error) throw new Error(`legiscan-identity candidate lookup failed: ${error.message}`);
  const termsPool = (data ?? []).map((t) => ({
    legislator_id: t.legislator_id,
    full_name: t.legislators?.full_name ?? null,
    chamber: t.chamber,
    district: t.district,
    start_date: t.start_date,
    end_date: t.end_date,
  }));
  const termsLegislatorIds = new Set(termsPool.map((r) => r.legislator_id));
  const columnPool = await fetchColumnDerivedCandidates(client, chamber, district, termsLegislatorIds);
  const pool = [...termsPool, ...columnPool];
  // fullNameNormalized/nameVariantsNormalized are already normalized by the caller
  // (resolveOrCreateLegiscanPerson) — passed straight through to matchLegislator's
  // `candidate.full_name`/`nameVariants`. normalizePersonName is idempotent on an
  // already-normalized string (lowercase, no punctuation, no comma), so this is safe even though
  // matchLegislator normalizes again internally.
  const { matches } = matchLegislator(
    {
      full_name: fullNameNormalized,
      nameVariants: nameVariantsNormalized,
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

// legiscanSurname — MINOR 1 fix (round 2, promoted by review): a brand-new `legislators` row
// created on the no_candidate/ambiguous paths never populated `surname`, unlike
// ensureRosterIdentities' own inserts (src/cli/ingest-mo-senate.js) — a surname-based resolver
// would be blind to LegiScan-originated rows. That resolver now exists (src/lib/person-identity.js's
// surnameKey, Task 1 of the identity-merge plan — live-verified: the real legiscan-sourced Onder
// row carries surname='Onder', populated by exactly this function) and depends on it.
// RULING: populate it from the SOURCE's own printed `last_name` field (verified present on every
// real fixture person record — Onder/Libla/Fitzwater all carry it verbatim), NEVER derived by
// splitting `full_name` — this project has been burned twice already by a surname reconstructed
// from a full-name split breaking on a multi-word first or last name (migration
// 0006_legislators_surname.sql's own header comment documents the first occurrence). Absent on a
// given record (falsy/empty) -> null, never guessed.
function legiscanSurname(legiscanPerson) {
  const lastName = String(legiscanPerson.last_name ?? '').trim();
  return lastName || null;
}

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
  // CONTROLLER RULING 3 (amended, fix round 1): include the source-printed nickname variant, if
  // any (buildLegiscanNameVariants) — still exact matching, never fuzzy (see that function's own
  // comment and person-identity.js's buildNameVariantSet).
  const nameVariantsNormalized = buildLegiscanNameVariants(legiscanPerson).map(normalizePersonName);
  const candidates = await findCandidateLegislatorRows(client, {
    fullNameNormalized,
    nameVariantsNormalized,
    chamber,
    district,
    sessionStartDate: sessionWindow.startDate ?? null,
    sessionEndDate: sessionWindow.endDate ?? null,
  });

  if (candidates.length === 0) {
    const { data: created, error: insErr } = await client
      .from('legislators')
      .insert({
        full_name: legiscanPerson.name,
        surname: legiscanSurname(legiscanPerson),
        // finding 8 (final wave): persist the source-printed nickname AT INGEST time (migration
        // 0013's own column) rather than relying solely on src/cli/backfill-nicknames.js to
        // retroactively patch it in later — dissolves the backfill-ordering dependency for every
        // NEW row from here on (a fresh LegiScan person with a printed nickname is immediately
        // visible to the cluster pass, no separate backfill run required). `?? null`: absent on the
        // source record -> null, never guessed, same convention as legiscanSurname above.
        nickname: legiscanPerson.nickname ?? null,
        party: normalizeLegiscanParty(legiscanPerson.party),
        legiscan_people_id: legiscanPerson.people_id,
        run_id: runId,
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
      full_name: legiscanPerson.name,
      surname: legiscanSurname(legiscanPerson),
      // finding 8 (final wave): same reasoning as the no_candidate insert above — persist the
      // source-printed nickname at ingest time, never guessed.
      nickname: legiscanPerson.nickname ?? null,
      party: normalizeLegiscanParty(legiscanPerson.party),
      legiscan_people_id: legiscanPerson.people_id,
      run_id: runId,
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
