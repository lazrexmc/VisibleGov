// Person-identity matching — REUSABLE, source-agnostic core (CONTROLLER RULING 1,
// .superpowers/sdd/2026-07-29-legiscan-bulk-adapter/task-5-brief.md): "this task's person-
// matching is the design seed for cross-source identity merge (TODO item 8), not a fifth silo."
// Any source that needs to map its own per-source person record onto an EXISTING `legislators`
// row (bioguide/openstates/mo_house/mo_senate/legiscan, today and future) converges on
// matchLegislator below, not a bespoke copy per source.
//
// This module exists to contain, in exactly ONE place, the risk shape the mo-senate adapter's
// Critical bug demonstrated (src/cli/ingest-mo-senate.js's own extensive comment,
// ~lines 422-517): full_name + chamber + district fuzzy matching, done carelessly, silently
// misattributed a successor's votes to their predecessor because a per-era, REUSED value (a
// district seat) was treated as a stable identity key. matchLegislator's contract is therefore
// deliberately narrow and fail-loud: exactly one era-overlapping, name-matching row -> 'match';
// zero -> 'no_match' (a benign duplicate row is created by the caller, never guessed); more than
// one -> 'ambiguous' (NEVER pick one, no matter how tempting the tiebreak looks).

// normalizePersonName — CONTROLLER RULING 3: conservative ONLY. Case/whitespace/punctuation
// folding and 'Last, First' <-> 'First Last' reordering. Deliberately NO nickname table, NO fuzzy
// distance. Asymmetric costs, per the ruling: a miss creates a benign duplicate row (fixable
// later by TODO item 8's real cross-source merge); a wrong merge corrupts vote attribution to a
// real person (the mo-senate bug's exact failure mode) and may never be caught. Fail toward
// duplicates, always.
export function normalizePersonName(fullName) {
  let s = String(fullName ?? '').trim();
  // 'Last, First [Middle...]' -> 'First [Middle...] Last' — reordering only, structural, not a
  // name-content change. A name with no comma is already 'First Last' and passes through as-is.
  const commaIdx = s.indexOf(',');
  if (commaIdx !== -1) {
    const last = s.slice(0, commaIdx).trim();
    const first = s.slice(commaIdx + 1).trim();
    s = `${first} ${last}`;
  }
  return s
    .toLowerCase()
    .replace(/[.,'"()]/g, '') // punctuation fold (periods, commas, quotes, parens)
    .replace(/\s+/g, ' ') // whitespace fold
    .trim();
}

// eraOverlaps — a term row (start_date/end_date, either possibly null/open-ended) overlaps a
// candidate era window (start/end, either possibly null/unbounded) iff neither range is provably
// entirely before or after the other. Null on either side of a comparison means "unbounded in
// that direction" (an ongoing term with no end_date yet; a candidate era with no known bound) —
// treated as "cannot rule out overlap", never as "definitely overlaps" or "definitely doesn't".
// ISO 'YYYY-MM-DD' strings compare correctly with plain string/lexicographic comparison
// (fixed-width, zero-padded) — no Date parsing needed, same convention this repo already relies
// on for date columns elsewhere.
export function eraOverlaps(row, era) {
  const rowStart = row?.start_date ?? null;
  const rowEnd = row?.end_date ?? null;
  const eraStart = era?.start ?? null;
  const eraEnd = era?.end ?? null;
  if (rowStart != null && eraEnd != null && rowStart > eraEnd) return false;
  if (rowEnd != null && eraStart != null && rowEnd < eraStart) return false;
  return true;
}

// buildNameVariantSet — CONTROLLER RULING 3, AMENDED (fix round 1, controller adjudication on
// task-5-report.md concern 2): conservative normalization stands, with ONE principled extension —
// when the SOURCE ITSELF prints an alternate name form for a person (LegiScan's own
// `person.nickname` field is the first concrete case: verified in the real fixture,
// `nickname:"Bob"` on Robert Onder, people_id 16351), the candidate's name-variant set is
// { given-name form, source-printed alternate form }, each matched EXACTLY under the SAME
// conservative folding normalizePersonName already does — never a fuzzy/edit-distance match, never
// a nickname table this module invents or looks up. This is still exact matching over PRINTED
// variants; the asymmetric-cost rule (fail toward duplicates) is intact: ambiguity ACROSS variants
// (one variant hits row A, a different variant hits a DIFFERENT row B) is still 'ambiguous', never
// picked. `candidate.nameVariants` (optional array of RAW alternate full-name strings — the
// caller's job to construct from ITS OWN source data, e.g. legiscan-identity.js's
// buildLegiscanNameVariants) is unioned with `candidate.full_name` after normalization.
function buildNameVariantSet(candidate) {
  const variants = new Set();
  variants.add(normalizePersonName(candidate.full_name));
  for (const raw of candidate.nameVariants ?? []) {
    const norm = normalizePersonName(raw);
    if (norm) variants.add(norm);
  }
  return variants;
}

// matchLegislator — THE reusable matching function (CONTROLLER RULING 1's literal words):
// candidate: { full_name, chamber, district, era: { start, end }, nameVariants? } (full_name is
// RAW, not pre-normalized — this function owns normalization so every caller normalizes
// identically; nameVariants is an optional array of additional RAW source-printed alternate full
// names, see buildNameVariantSet above).
// existingRows: a POOL of candidate rows already fetched by the caller's own source-specific
// query (e.g. legiscan-identity.js's findCandidateLegislatorRows queries `terms` joined to
// `legislators`, plus a per-source identity-column fallback) — this function does NOT touch a
// database; it is pure and independently testable for exactly that reason. Each row:
// { legislator_id, full_name, chamber, district, start_date, end_date }.
//
// Returns { outcome: 'match' | 'no_match' | 'ambiguous', matches: [...] } — 'matches' always
// carries every row that satisfied the full predicate (0, 1, or 2+ elements), so a caller can log
// candidateCount on the ambiguous path without a second pass. Never throws — "fail loud" here
// means "return an outcome the caller cannot silently ignore", not an exception from inside pure
// matching logic; the CALLER (e.g. resolveOrCreateLegiscanPerson) decides what to do with
// 'ambiguous' (create a new row, log it for review — never guess-merge).
export function matchLegislator(candidate, existingRows) {
  const nameVariants = buildNameVariantSet(candidate);
  const districtNorm = candidate.district == null ? null : String(candidate.district).trim();
  const filtered = (existingRows ?? []).filter((row) => (
    row.chamber === candidate.chamber
    && String(row.district ?? '').trim() === districtNorm
    && nameVariants.has(normalizePersonName(row.full_name))
    && eraOverlaps(row, candidate.era)
  ));
  // Dedupe by legislator_id: the SAME real person can legitimately hold more than one `terms` row
  // for the same seat (e.g. non-consecutive terms with a gap) — two overlapping TERM rows that
  // both belong to ONE legislator_id are still exactly one candidate, not an ambiguous collision
  // between two different people. Ambiguity is only real when the matched rows point at DIFFERENT
  // legislator_ids.
  const byLegislator = new Map();
  for (const row of filtered) {
    if (!byLegislator.has(row.legislator_id)) byLegislator.set(row.legislator_id, row);
  }
  const matches = [...byLegislator.values()];
  if (matches.length === 0) return { outcome: 'no_match', matches: [] };
  if (matches.length === 1) return { outcome: 'match', matches };
  return { outcome: 'ambiguous', matches };
}

// ============================================================================================
// Cluster pass (Task 1, docs/superpowers/plans/2026-07-29-identity-merge.md) — cross-source
// identity merge over the WHOLE `legislators` table (1,576 rows today), not the single-candidate,
// DB-narrowed lookup matchLegislator/findCandidateLegislatorRows do per incoming record. Same
// module, same purity discipline (zero imports), same asymmetric-cost doctrine: wrong-merge is
// the unacceptable error class, missed-merge is benign — ANY ambiguity flags, never guesses.
//
// Live-verified against the REAL data this runs over (read-only orientation query, 2026-07-29,
// against the actual `legislators`/`terms` tables): Robert "Bob" Onder is FOUR real rows today —
// bioguide 'Onder, Robert F.' (O000177, federal, zero terms rows), openstates 'Bob Onder'
// (ocd-person/..., zero terms rows), mo_senate 'Bob Onder' (mo_senate_id '2', ONE real terms row:
// mo-legislature/senate/district 2), legiscan 'Robert Onder' (legiscan_people_id 16351, zero terms
// rows, no nickname persisted anywhere on the row — LegiScan's own nickname:"Bob" field, used by
// legiscan-identity.js at RESOLUTION time, is never stored on the `legislators` row itself, so the
// cluster pass cannot and does not depend on it). The SAME live read also turned up three REAL,
// unrelated US Senators surnamed Brown (Sherrod/OH, Hank/CO, Scott P./MA) with real, differing
// `terms` districts — exactly the shape the district-contradiction rule below must keep apart.
// ============================================================================================

// surnameKey — the cluster pass's candidate-pairing key. Prefers the `surname` column when
// populated (only MO-driver rows carry it today, migration 0006); otherwise derives it
// structurally from the row's OWN printed full_name — the reordered form's LAST token
// (normalizePersonName already turns 'Onder, Robert F.' into 'robert f onder', so its last token
// is 'onder', the same as 'Bob Onder' -> 'bob onder' -> 'onder'). This is deliberately NOT the
// same guarded-against move as legiscan-identity.js's legiscanSurname comment (never split a full
// name to WRITE a `surname` column value — that overwrote real data with a guess, twice). Nothing
// is written here; a coincidentally-wrong derived key only ever costs a MISSED pairing (two rows
// that share no key never get compared at all) — never a wrong merge, because a shared key is
// only step one of the pairing predicate below, still gated by chamber/district/era compatibility
// and the asymmetric-cost doctrine throughout. Empty/unparseable input yields '' (never guessed).
function lastToken(normalized) {
  const parts = normalized.split(' ').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function surnameKey(row) {
  const surname = row?.surname;
  if (surname != null && String(surname).trim() !== '') return normalizePersonName(surname);
  return lastToken(normalizePersonName(row?.full_name ?? ''));
}

// evidencePairStatus — the per-evidence-entry-pair verdict feeding rowPairStatus below.
// `a`/`b`: { jurisdiction_id, chamber, district, start_date, end_date } (the SAME evidence-entry
// shape link-persons.js's buildEvidenceRows produces from `terms` rows AND per-source identity
// columns — both count, per the plan's own words, "terms rows and identity columns both count").
//
// - Different jurisdiction_id, or different chamber: NOT comparable evidence for THIS pair — a
//   federal Senate seat and a MO Senate seat share the word "senate" but are different jobs, and a
//   MO House seat and a MO Senate seat are a normal CAREER move, never a contradiction by
//   themselves (the plan's explicit ruling: "federal-vs-state chamber difference is NOT a
//   contradiction, it's a career"; extended here, deliberately, to a state House<->Senate move for
//   the identical reason). 'compatible' (vacuously — nothing here rules anything out).
// - Same jurisdiction_id AND chamber, both sides print a CONCRETE district, and the districts
//   differ: a hard, structural fact — two real, recorded seats for the same job at once (or,
//   un-era-qualified, two recorded seat-holders with no evidence they're the same person moving
//   between them). 'contradiction' — this is the Brown/Brown-style guard: three real, unrelated US
//   Senators surnamed Brown, live-verified, are kept apart by exactly this rule (OH vs CO vs MA).
// - Same jurisdiction_id AND chamber, districts match (or either/both unknown): check era via the
//   SAME eraOverlaps this module already uses for matchLegislator. Provably non-overlapping ->
//   'ambiguous' (same seat, different but non-touching windows — could be the same person
//   re-elected after a gap, or an unrelated same-named successor; never guessed either way).
//   Otherwise (overlapping, or either side's era is unknown/unbounded) -> 'compatible'.
function evidencePairStatus(a, b) {
  if (a.jurisdiction_id !== b.jurisdiction_id || a.chamber !== b.chamber) return 'compatible';
  const distA = a.district == null ? null : String(a.district).trim();
  const distB = b.district == null ? null : String(b.district).trim();
  if (distA != null && distB != null && distA !== distB) return 'contradiction';
  const overlaps = eraOverlaps(
    { start_date: a.start_date, end_date: a.end_date },
    { start: b.start_date, end: b.end_date },
  );
  return overlaps ? 'compatible' : 'ambiguous';
}

// rowPairStatus — combines EVERY evidence entry on row A against EVERY evidence entry on row B
// (a small cross product — each row carries at most a handful of terms/column-derived entries).
// A single 'contradiction' anywhere wins outright (a hard fact beats an absence of one); otherwise
// any 'ambiguous' anywhere wins over the rest; two rows with NO shared comparable evidence at all
// (e.g. the three Onder rows that carry zero terms/column evidence whatsoever) fall through both
// loops and land on 'compatible' — vacuously, honestly: nothing contradicts, nothing corroborates,
// same as eraOverlaps' own "cannot rule out" treatment of an unbounded/unknown side.
function rowPairStatus(evidenceA, evidenceB) {
  let sawAmbiguous = false;
  for (const a of evidenceA ?? []) {
    for (const b of evidenceB ?? []) {
      const status = evidencePairStatus(a, b);
      if (status === 'contradiction') return 'contradiction';
      if (status === 'ambiguous') sawAmbiguous = true;
    }
  }
  return sawAmbiguous ? 'ambiguous' : 'compatible';
}

const SOURCE_KEY_COLUMNS = ['bioguide_id', 'openstates_id', 'mo_house_id', 'mo_senate_id', 'legiscan_people_id'];

function buildClusterKey(nameKeyValue, ids) {
  return `${nameKeyValue}:${[...ids].sort().join(',')}`;
}

function buildMemberEvidence(row, nameKeyValue) {
  const sourceKeys = {};
  for (const col of SOURCE_KEY_COLUMNS) sourceKeys[col] = row[col] ?? null;
  return {
    legislatorId: row.id,
    fullName: row.full_name,
    surnameKeyUsed: nameKeyValue,
    sourceKeys,
    chamberDistrictEra: row.evidence ?? [],
  };
}

// clusterLegislators — the pure cluster pass. `rows`: every candidate legislator row (caller's
// job to pre-filter to unlinked rows, per link-persons.js's "already-linked skip" — this function
// has no concept of person_id at all), each shaped
// { id, full_name, surname, bioguide_id, openstates_id, mo_house_id, mo_senate_id,
//   legiscan_people_id, evidence: [{jurisdiction_id, chamber, district, start_date, end_date}, ...] }
// (evidence pre-assembled by the caller from `terms` rows AND per-source identity columns — the
// DB-shape translation, same division of labor as findCandidateLegislatorRows/matchLegislator).
//
// Algorithm: group by surnameKey (candidate pairing's first, broad gate — two rows with different
// keys are never compared at all, per Task 1's cluster rule). Within a group of 2+, union rows
// whose rowPairStatus is NOT 'contradiction' (a hard district conflict is the one thing that can
// keep two same-surname rows from ever joining the same component — this is what actually keeps
// Brown(16) and Brown(26) apart as two singletons, not a flag: no edge is ever drawn between them).
// Each resulting connected component is then RE-CHECKED, exhaustively, over every internal pair
// (not just the union-find edges) — a component can only be reached via a third, evidence-free
// bridging row (e.g. a row with zero terms/column evidence pairing vacuously with both ends of a
// real contradiction), and that transitive path must never silently launder a real contradiction
// into an auto-link. Any internal contradiction -> flagged ('internal_contradiction'); else any
// internal 'ambiguous' (the same-name/same-seat/non-overlapping-era case) -> flagged
// ('ambiguous_era'); else -> a clean auto cluster. Singleton components (including every row whose
// surnameKey is unique in the whole input) land in `singletons`.
export function clusterLegislators(rows) {
  const list = rows ?? [];
  const groups = new Map();
  list.forEach((row, idx) => {
    const key = surnameKey(row);
    if (!key) return; // no derivable name at all -> falls through to the final singleton sweep
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idx);
  });

  const clusters = [];
  const flagged = [];
  const singletons = [];
  const handled = new Set();

  for (const [nameKeyValue, idxs] of groups) {
    if (idxs.length === 1) {
      singletons.push(list[idxs[0]].id);
      handled.add(idxs[0]);
      continue;
    }

    const parent = new Map(idxs.map((i) => [i, i]));
    const find = (x) => {
      let cur = x;
      while (parent.get(cur) !== cur) cur = parent.get(cur);
      return cur;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    const statusCache = new Map();
    const pairStatus = (i, j) => {
      const cacheKey = i < j ? `${i}|${j}` : `${j}|${i}`;
      if (statusCache.has(cacheKey)) return statusCache.get(cacheKey);
      const status = rowPairStatus(list[i].evidence, list[j].evidence);
      statusCache.set(cacheKey, status);
      return status;
    };

    for (let a = 0; a < idxs.length; a += 1) {
      for (let b = a + 1; b < idxs.length; b += 1) {
        if (pairStatus(idxs[a], idxs[b]) !== 'contradiction') union(idxs[a], idxs[b]);
      }
    }

    const components = new Map();
    for (const i of idxs) {
      const root = find(i);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(i);
    }

    for (const members of components.values()) {
      members.forEach((i) => handled.add(i));
      if (members.length === 1) {
        singletons.push(list[members[0]].id);
        continue;
      }

      let hasContradiction = false;
      let hasAmbiguous = false;
      for (let a = 0; a < members.length; a += 1) {
        for (let b = a + 1; b < members.length; b += 1) {
          const status = pairStatus(members[a], members[b]);
          if (status === 'contradiction') hasContradiction = true;
          else if (status === 'ambiguous') hasAmbiguous = true;
        }
      }

      const memberRows = members.map((i) => list[i]);
      const memberIds = memberRows.map((r) => r.id);
      const key = buildClusterKey(nameKeyValue, memberIds);
      const evidence = memberRows.map((r) => buildMemberEvidence(r, nameKeyValue));

      if (hasContradiction) {
        flagged.push({
          clusterKey: key, candidateIds: memberIds, evidence, reason: 'internal_contradiction',
        });
      } else if (hasAmbiguous) {
        flagged.push({
          clusterKey: key, candidateIds: memberIds, evidence, reason: 'ambiguous_era',
        });
      } else {
        clusters.push({ key, memberIds, evidence });
      }
    }
  }

  list.forEach((row, idx) => {
    if (!handled.has(idx)) singletons.push(row.id);
  });

  return { clusters, flagged, singletons };
}

// ---- display_name precedence (mechanical, never invented — Global Constraints) ----

// reorderCommaName — a STRUCTURAL reorder of a name's own printed parts, nothing more: 'Last,
// First Middle' -> 'First Middle Last'. Deliberately distinct from normalizePersonName's own
// comma-reordering (which also lowercases and folds punctuation for MATCHING purposes) — a
// display_name must preserve the source's own casing and punctuation verbatim (e.g. 'Robert F.'
// keeps its period), so this reorders only, never folds. A name with no comma passes through
// unchanged (every non-bioguide source in this codebase already prints 'First Last').
export function reorderCommaName(name) {
  const s = String(name ?? '').trim();
  const commaIdx = s.indexOf(',');
  if (commaIdx === -1) return s;
  const last = s.slice(0, commaIdx).trim();
  const first = s.slice(commaIdx + 1).trim();
  return `${first} ${last}`;
}

export class NoDisplayNameSourceError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'NoDisplayNameSourceError';
    Object.assign(this, meta);
  }
}

// DISPLAY_NAME_PRIORITY — Global Constraints, verbatim: "bioguide > mo_senate > mo_house >
// legiscan > openstates printed names, source recorded in display_name_source." Matches
// migration 0012's own persons.display_name_source CHECK constraint exactly (same 5 values).
const DISPLAY_NAME_PRIORITY = [
  ['bioguide', 'bioguide_id'],
  ['mo_senate', 'mo_senate_id'],
  ['mo_house', 'mo_house_id'],
  ['legiscan', 'legiscan_people_id'],
  ['openstates', 'openstates_id'],
];

// pickDisplayName — mechanical, highest-authority-source-wins selection over a cluster's member
// rows (each the same shape clusterLegislators consumes: full_name + the 5 source-key columns).
// The winning row's full_name is reordered via reorderCommaName ONLY (word-reorder of its own
// printed parts, never invented) — the concrete case this closes: the real four-Onder cluster's
// winning bioguide row prints 'Onder, Robert F.'; display_name becomes 'Robert F. Onder',
// display_name_source 'bioguide'. Every `legislators` row is created by exactly one of the five
// known ingestion drivers, each of which stamps at least one of the five key columns — a member
// set with NONE of them set would violate that invariant, so this throws a typed error rather than
// inventing a sixth, unconstrained display_name_source value the DB's own CHECK would reject.
export function pickDisplayName(members) {
  for (const [source, column] of DISPLAY_NAME_PRIORITY) {
    const winner = (members ?? []).find((m) => m?.[column] != null);
    if (winner) {
      return { display_name: reorderCommaName(winner.full_name), display_name_source: source };
    }
  }
  throw new NoDisplayNameSourceError(
    'pickDisplayName: no member carries any of the five recognized source-key columns '
      + '(bioguide_id/openstates_id/mo_house_id/mo_senate_id/legiscan_people_id) — cannot derive '
      + 'a display_name_source without inventing one outside the persons table\'s own CHECK constraint',
    { memberIds: (members ?? []).map((m) => m?.id) },
  );
}
