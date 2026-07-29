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

// matchLegislator — THE reusable matching function (CONTROLLER RULING 1's literal words):
// candidate: { full_name, chamber, district, era: { start, end } } (full_name is RAW, not
// pre-normalized — this function owns normalization so every caller normalizes identically).
// existingRows: a POOL of candidate rows already fetched by the caller's own source-specific
// query (e.g. legiscan-identity.js's findCandidateLegislatorRows queries `terms` joined to
// `legislators`) — this function does NOT touch a database; it is pure and independently testable
// for exactly that reason. Each row: { legislator_id, full_name, chamber, district, start_date,
// end_date }.
//
// Returns { outcome: 'match' | 'no_match' | 'ambiguous', matches: [...] } — 'matches' always
// carries every row that satisfied the full predicate (0, 1, or 2+ elements), so a caller can log
// candidateCount on the ambiguous path without a second pass. Never throws — "fail loud" here
// means "return an outcome the caller cannot silently ignore", not an exception from inside pure
// matching logic; the CALLER (e.g. resolveOrCreateLegiscanPerson) decides what to do with
// 'ambiguous' (create a new row, log it for review — never guess-merge).
export function matchLegislator(candidate, existingRows) {
  const nameNorm = normalizePersonName(candidate.full_name);
  const districtNorm = candidate.district == null ? null : String(candidate.district).trim();
  const filtered = (existingRows ?? []).filter((row) => (
    row.chamber === candidate.chamber
    && String(row.district ?? '').trim() === districtNorm
    && normalizePersonName(row.full_name) === nameNorm
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
