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
// rows). The SAME live read also turned up three REAL, unrelated US Senators surnamed Brown
// (Sherrod/OH, Hank/CO, Scott P./MA) with real, differing `terms` districts — exactly the shape the
// district-contradiction rule below must keep apart.
//
// NICKNAME AMENDMENT (.superpowers/sdd/2026-07-29-identity-merge/progress.md, last entry —
// superseding this note as originally written): as of fix round 2 below, the legiscan row's own
// nickname:"Bob" field was resolved by legiscan-identity.js at RESOLUTION time only and never
// stored on the `legislators` row, so the cluster pass had no way to see it and the real four-Onder
// rows split into TWO persons (Robert-form vs Bob-form). Migration 0013 (draft) adds
// `legislators.nickname` (source-printed only, never inferred); src/cli/backfill-nicknames.js
// populates it for already-ingested LegiScan people from the cached dataset ZIPs; the section below
// headed "nickname amendment" is where clusterLegislators now consumes it, as an additional
// exact-match given-name variant, scoped to one surname group at a time (never a cross-surname
// nickname table) — see buildGivenNicknameEquivalence's own comment for the mechanics. WITHOUT a
// persisted nickname (still the live-DB state as of this writing — the backfill has not run live
// yet), the four-Onder split into two clusters described throughout this file's comments remains
// exactly correct and is regression-locked in tests/link-persons-cli.test.js.
//
// FIX ROUND 2 (CRITICAL, execution-proven against the live run — a real wrong-merge, not a
// theoretical one): round 1's name-variant gate only applied to the "same-seat, can't rule out
// overlap because a date is missing" branch — a pair with NO comparable seat evidence at all
// (different chamber, different jurisdiction, or one/both sides evidence-free entirely) skipped
// straight to a vacuous 'compatible' verdict WITHOUT ever checking names. The live run this gap
// let through: 'Symington, Stuart' (Senate) + 'Symington, James W.' (House — father/son, real
// dated `terms` evidence on both sides, but different CHAMBER so never compared); 'Brock Adams' +
// 'Joe Adams' (different jurisdiction); 'Cora Walker' + 'Nathan Walker' (evidence-free on both
// sides). All three: same derived surnameKey, completely different given names, silently
// auto-linked on nothing but a shared surname. RULING (unambiguous form): a full-name-variant
// match (given+family — see fullNameVariantMatch below) is now a NECESSARY condition for ANY
// auto-cluster pair, unconditionally — regardless of chamber, jurisdiction, era, or whether
// comparable evidence exists at all. A pair that shares ONLY a surname (no full-name-variant
// match) never auto-links: if real seat evidence exists between them (same jurisdiction+chamber,
// whatever the district/era verdict), that's still enough of an affirmative signal to warrant
// Lance's review -> flagged; if there's truly nothing but the surname, the rows simply don't pair
// at all (no edge — a bare surname collision is not evidence of shared identity, and flagging
// every one would drown the review queue). See finalPairStatus below for the exact mechanics; this
// is enforced a SECOND time, structurally, by writeAutoCluster in src/cli/link-persons.js (throws
// ClusterNameVariantViolationError before writing anything if the invariant is ever violated) and
// audited a THIRD time, non-destructively, by auditClusterCoherence for every dry-run report.
//
// ACCEPTED RESIDUAL (unchanged from fix round 1, still real, still documented rather than silently
// assumed): a same-seat pair that can't be dated on either side, printed with the SAME full name
// (given+family) and no suffix (or a suffix stripped/never printed by every source that reached
// either row), is mechanically indistinguishable from one re-elected person — `fullNameVariantMatch`
// is (correctly, per its own contract) true either way, so a genuine dynastic Jr./Sr. succession in
// that exact shape still auto-links. The durable fix is term-date backfill (Task 3+); until then,
// Lance's review-tab unlink (Task 2) is the correction path. Both fix rounds are strict NARROWINGS
// of the false-'compatible' surface — neither ever widens it.
// ============================================================================================

// surnameKey — the cluster pass's candidate-pairing key. Prefers the `surname` column when
// populated (MO-driver rows via migration 0006, AND legiscan-identity.js's own legiscanSurname —
// live-verified: the real legiscan-sourced Onder row carries surname='Onder' too; only the
// bioguide/openstates drivers leave it null); otherwise derives it structurally from the row's OWN
// printed full_name — the reordered form's LAST token (normalizePersonName already turns 'Onder,
// Robert F.' into 'robert f onder', so its last token is 'onder', the same as 'Bob Onder' ->
// 'bob onder' -> 'onder'). This is deliberately NOT the same guarded-against move as legiscan-
// identity.js's legiscanSurname comment (never split a full name to WRITE a `surname` column
// value — that overwrote real data with a guess, twice). Nothing is written here; a
// coincidentally-wrong derived key only ever costs a MISSED pairing (two rows that share no key
// never get compared at all) — never a wrong merge on its own, because a shared key is only step
// one of the pairing predicate below, still gated by chamber/district/era compatibility and the
// asymmetric-cost doctrine throughout. Empty/unparseable input yields '' (never guessed). NOTE
// (fix round 2): because this key is structural (not a verified given-name match), the pool of
// same-key candidates it admits can be broad — surnameKey alone is deliberately permissive; it is
// finalPairStatus's unconditional full-name-variant requirement (below) that actually keeps a
// same-surname, different-person pairing from ever auto-linking, not this key.
function lastToken(normalized) {
  const parts = normalized.split(' ').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function surnameKey(row) {
  const surname = row?.surname;
  if (surname != null && String(surname).trim() !== '') return normalizePersonName(surname);
  return lastToken(normalizePersonName(row?.full_name ?? ''));
}

// fullNameVariantMatch — the SINGLE gate finalPairStatus (below) applies unconditionally to every
// candidate pair, per fix round 2's ruling. Compares GIVEN name (first token) + FAMILY name (last
// non-suffix token) of each side's normalizePersonName-folded, comma-reordered full_name — a
// middle name or initial is deliberately NOT part of the match key ("given+family", the ruling's
// own words): 'Onder, Robert F.' (bioguide; reorders to 'robert f onder') and 'Robert Onder'
// (legiscan) share given='robert'/family='onder' despite the middle initial, and this is a
// structural reorder/extraction of the row's OWN printed parts, never an invented equivalence — it
// does NOT bridge 'Bob'/'Robert' (still zero nickname table, CONTROLLER RULING 3 stands: those
// remain two DIFFERENT given names, verified in tests/legiscan-identity.test.js). A printed name
// SUFFIX (Jr./Sr./II/III/IV/V) is handled specially: stripped before comparison (an omitted suffix
// on one side must not block a match — omission isn't evidence of a different person), but if BOTH
// sides print a RECOGNIZED suffix and they DIFFER, that's a positive disqualifying signal (a real,
// printed clue these are two different people in the same family line) — the live worked example:
// 'John Duncan Jr.' vs 'John Duncan Sr.'.
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

function splitGivenFamilySuffix(normalized) {
  let parts = normalized.split(' ').filter(Boolean);
  let suffix = null;
  if (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1])) {
    suffix = parts[parts.length - 1];
    parts = parts.slice(0, -1);
  }
  if (parts.length === 0) return { given: '', family: '', suffix };
  return { given: parts[0], family: parts[parts.length - 1], suffix };
}

// namesMatchStructural — the shared given+family+suffix comparison both fullNameVariantMatch
// (below, strict given equality, unchanged public behavior) and the nickname-aware cluster-pass
// path (rowNameVariantMatch, further below) reduce to. `givenEquals` is the ONLY thing that
// differs between the two: a plain `===` for fullNameVariantMatch, or a nickname-derived
// equivalence lookup for the cluster pass. Extracting this common core means the nickname
// amendment changes zero behavior for fullNameVariantMatch's own (extensively tested) string-only
// contract.
function namesMatchStructural(a, b, givenEquals) {
  if (!a.given || !a.family || a.family !== b.family) return false;
  if (!givenEquals(a.given, b.given)) return false;
  if (a.suffix && b.suffix && a.suffix !== b.suffix) return false;
  return true;
}

export function fullNameVariantMatch(fullNameA, fullNameB) {
  const a = splitGivenFamilySuffix(normalizePersonName(fullNameA));
  const b = splitGivenFamilySuffix(normalizePersonName(fullNameB));
  return namesMatchStructural(a, b, (x, y) => x === y);
}

// ---- nickname amendment (.superpowers/sdd/2026-07-29-identity-merge/progress.md, last entry) ----
//
// Migration 0013 persists LegiScan's own source-printed `person.nickname` field onto
// `legislators.nickname` (backfilled by src/cli/backfill-nicknames.js). This section is the ONLY
// place clusterLegislators' matching predicate consults it — everything above (fullNameVariantMatch
// itself, matchLegislator, buildNameVariantSet) is UNCHANGED, so every pre-existing caller/test
// keeps its exact prior behavior when no row carries a nickname (the overwhelmingly common case
// today: backfill hasn't run live yet).
//
// buildGivenNicknameEquivalence — a union-find over NORMALIZED GIVEN-NAME TOKENS (not row indices),
// built fresh from one candidate GROUP at a time (clusterLegislators already scopes its comparisons
// to one surnameKey group; buildMemberEvidence's nickname field lets auditClusterCoherence
// independently rebuild the identical index from just a cluster's own members). Deliberately
// GROUP-scoped, never global: unioning happens only from a row's OWN printed (given, nickname) pair
// (mirrors legiscan-identity.js's buildLegiscanNameVariants — source-printed, per-person, never an
// invented cross-surname nickname table), but ONE row's assertion ("Robert" is printed elsewhere as
// "Bob" for THIS person) is then honored for every OTHER row already in the same surname-gated
// group — this is what "fixes the whole class" (progress.md's own words): every source's own row
// for the SAME real person can bridge through the ONE row that happens to carry the nickname,
// without ever letting an unrelated "Robert Smith"/"Bob Smith" pair (different surname group,
// nothing in common) bridge off of Onder's nickname.
function buildGivenNicknameEquivalence(rows) {
  const parent = new Map();
  const find = (token) => {
    if (!parent.has(token)) parent.set(token, token);
    let root = token;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(token, root); // path compression
    return root;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const row of rows ?? []) {
    const given = splitGivenFamilySuffix(normalizePersonName(row?.full_name ?? '')).given;
    const nickname = normalizePersonName(row?.nickname ?? '');
    if (given && nickname && given !== nickname) union(given, nickname);
  }
  return { sameGiven: (x, y) => x === y || find(x) === find(y) };
}

// rowNameVariantMatch — like fullNameVariantMatch, but given-token equality is delegated to an
// optional equivalence index (buildGivenNicknameEquivalence above); with no index (or an index that
// saw no nicknames in its group), this is byte-for-byte identical to fullNameVariantMatch(rowA.
// full_name, rowB.full_name) — the "withOUT nickname -> the current two-cluster split" regression
// this amendment must not disturb.
function rowNameVariantMatch(rowA, rowB, equivalence) {
  const a = splitGivenFamilySuffix(normalizePersonName(rowA?.full_name ?? ''));
  const b = splitGivenFamilySuffix(normalizePersonName(rowB?.full_name ?? ''));
  const givenEquals = equivalence ? equivalence.sameGiven : (x, y) => x === y;
  return namesMatchStructural(a, b, givenEquals);
}

// buildGivenNicknameEquivalenceFromEvidence — auditClusterCoherence's own independent re-derivation
// (see that function below): rebuilds the SAME equivalence shape from a cluster's own `evidence`
// entries (camelCase fullName/nickname, buildMemberEvidence's own output shape) rather than raw
// `rows` (snake_case full_name/nickname) — a thin field-name adapter over the same core builder, not
// a second implementation.
function buildGivenNicknameEquivalenceFromEvidence(members) {
  return buildGivenNicknameEquivalence(
    (members ?? []).map((m) => ({ full_name: m.fullName, nickname: m.nickname })),
  );
}

// seatEvidencePairStatus — the per-evidence-entry-pair verdict feeding rowSeatStatus below. PURELY
// evidence-based (no names involved at all — fix round 2 moved every name check out to
// finalPairStatus, a single unconditional outer gate, rather than an inner exception threaded
// through this function). `a`/`b`: { jurisdiction_id, chamber, district, start_date, end_date }
// (the same evidence-entry shape link-persons.js's buildEvidenceRows produces from `terms` rows
// AND per-source identity columns — both count).
//
// - Different jurisdiction_id, or different chamber: these two evidence entries are simply NOT
//   comparable — a federal Senate seat and a MO Senate seat share the word "senate" but are
//   different jobs; a MO House seat and a MO Senate seat are a normal CAREER move. 'no-evidence'
//   (fix round 2: this used to fold into 'compatible' here, which is exactly the gap that let
//   'Symington, Stuart' (Senate) auto-link to 'Symington, James W.' (House) on the live run — a
//   DIFFERENT-chamber pair is not affirmative identity evidence, it's an absence of comparable
//   evidence, and must be classified that way so finalPairStatus can require a name match).
// - Same jurisdiction_id AND chamber, both sides print a CONCRETE district, and the districts
//   differ: a hard, structural fact. 'contradiction' — the Brown/Brown-style guard: three real,
//   unrelated US Senators surnamed Brown, live-verified, are kept apart by exactly this rule.
// - Same jurisdiction_id AND chamber, districts match (or either/both unknown) — same SEAT:
//   eraOverlaps provably non-overlapping -> 'ambiguous'; overlapping, or can't rule it out (dates
//   missing on one/both sides) -> 'compatible'. Whether a 'compatible' verdict here actually
//   licenses an auto-link now depends ENTIRELY on finalPairStatus's unconditional name check below
//   — this function no longer knows or cares about names.
function seatEvidencePairStatus(a, b) {
  if (a.jurisdiction_id !== b.jurisdiction_id || a.chamber !== b.chamber) return 'no-evidence';
  const distA = a.district == null ? null : String(a.district).trim();
  const distB = b.district == null ? null : String(b.district).trim();
  if (distA != null && distB != null && distA !== distB) return 'contradiction';
  const overlaps = eraOverlaps(
    { start_date: a.start_date, end_date: a.end_date },
    { start: b.start_date, end: b.end_date },
  );
  return overlaps ? 'compatible' : 'ambiguous';
}

// rowSeatStatus — combines EVERY evidence entry on row A against EVERY evidence entry on row B (a
// small cross product). A single 'contradiction' anywhere wins outright; otherwise any 'ambiguous'
// anywhere wins over 'compatible'; if NOTHING beyond 'no-evidence' was ever found across the whole
// cross product (e.g. two rows that are each entirely evidence-free, or whose evidence never
// shares a comparable jurisdiction+chamber), the overall verdict is honestly 'no-evidence' — never
// silently upgraded to 'compatible' (fix round 2's core correction).
function rowSeatStatus(evidenceA, evidenceB) {
  let sawAmbiguous = false;
  let sawComparable = false;
  for (const a of evidenceA ?? []) {
    for (const b of evidenceB ?? []) {
      const status = seatEvidencePairStatus(a, b);
      if (status === 'contradiction') return 'contradiction';
      if (status !== 'no-evidence') sawComparable = true;
      if (status === 'ambiguous') sawAmbiguous = true;
    }
  }
  if (!sawComparable) return 'no-evidence';
  return sawAmbiguous ? 'ambiguous' : 'compatible';
}

// finalPairStatus — fix round 2's unconditional gate, the ONE place a full-name-variant match is
// required. Returns 'contradiction' | 'no-pair' | 'ambiguous' | 'compatible'.
//   - seat evidence hard-contradicts -> 'contradiction', UNCONDITIONALLY (a recorded, concrete
//     fact beats a name match too — two different concrete seats can't be reconciled just because
//     the names happen to agree).
//   - no comparable seat evidence at all ('no-evidence'): a name match is the ONLY thing that can
//     license pairing here — 'compatible' if fullNameVariantMatch, else 'no-pair' (the rows simply
//     don't pair; a bare surname collision with nothing else is not evidence of shared identity —
//     this is the exact fix for the live Symington/Adams/Walker wrong-merges: none of those three
//     pairs share a full-name variant, so none of them ever pair now).
//   - real comparable seat evidence exists ('ambiguous' or 'compatible' from rowSeatStatus): if
//     names DON'T match, this is downgraded to 'ambiguous' regardless — affirmative shared-identity
//     evidence with disagreeing names is exactly the shape that belongs in front of Lance, never
//     silently linked (this is what keeps the 9 live dynasty pairs — Bayh, Chafee, Humphrey,
//     Graham, all same-seat/dateless/different-given-names — correctly flagged, unchanged from fix
//     round 1's outcome for them, just reached via this now-unified gate). If names DO match, the
//     seat verdict passes through as-is: 'ambiguous' stays 'ambiguous' (e.g. the same-name,
//     provably-non-overlapping-era case), 'compatible' stays 'compatible' (real corroboration or
//     the accepted dateless-same-name residual, both fix round 1's own examples).
//
// `equivalence` (nickname amendment, optional): a buildGivenNicknameEquivalence index scoped to
// the SAME candidate group this pair was drawn from — rowNameVariantMatch falls back to plain
// fullNameVariantMatch-equivalent behavior when omitted or when the group has no nicknames at all,
// so every pre-amendment call site/test is unaffected.
function finalPairStatus(rowA, rowB, equivalence) {
  const seat = rowSeatStatus(rowA.evidence, rowB.evidence);
  if (seat === 'contradiction') return 'contradiction';
  const namesMatch = rowNameVariantMatch(rowA, rowB, equivalence);
  if (seat === 'no-evidence') return namesMatch ? 'compatible' : 'no-pair';
  if (!namesMatch) return 'ambiguous';
  return seat;
}

const SOURCE_KEY_COLUMNS = ['bioguide_id', 'openstates_id', 'mo_house_id', 'mo_senate_id', 'legiscan_people_id'];

function buildClusterKey(nameKeyValue, ids) {
  return `${nameKeyValue}:${[...ids].sort().join(',')}`;
}

// buildMemberEvidence — nickname amendment: now also carries `nickname` verbatim (null when the
// row has none, e.g. every row before migration 0013/backfill-nicknames.js ever runs) so
// auditClusterCoherence (below) can independently rebuild the SAME given-name equivalence used to
// form this cluster, purely from this evidence snapshot, without re-touching the original `rows`.
function buildMemberEvidence(row, nameKeyValue) {
  const sourceKeys = {};
  for (const col of SOURCE_KEY_COLUMNS) sourceKeys[col] = row[col] ?? null;
  return {
    legislatorId: row.id,
    fullName: row.full_name,
    nickname: row.nickname ?? null,
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
// keys are never compared at all). Within a group of 2+, union rows whose finalPairStatus is
// neither 'contradiction' nor 'no-pair' (fix round 2: 'no-pair' — no comparable seat evidence AND
// no full-name-variant match — now blocks an edge exactly like a hard contradiction does; this is
// what keeps Brown(16)/Brown(26) apart as before, AND now ALSO keeps a bare surname collision like
// Symington/Adams/Walker from ever pairing at all). Each resulting connected component is then
// RE-CHECKED, exhaustively, over every internal pair (not just the union-find edges) — a component
// can only be reached via a third, bridging row whose OWN full-name-variant happens to match one
// side but not the other (e.g. a no-suffix 'John Duncan' bridging 'John Duncan Jr.' and 'John
// Duncan Sr.', which do not match each other directly), and that transitive path must never
// silently launder a real contradiction or a real no-pair verdict into an auto-link. Any internal
// 'contradiction' -> flagged 'internal_contradiction'; else any internal 'no-pair' -> flagged
// 'internal_no_name_variant'; else any internal 'ambiguous' -> flagged 'ambiguous_era'; else -> a
// clean auto cluster (structurally guaranteed, by this construction, that every member pair shares
// a full-name variant — see auditClusterCoherence below, which verifies exactly this independently
// for every dry-run report). Singleton components (including every row whose surnameKey is unique
// in the whole input) land in `singletons`.
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

    // Nickname amendment: the given-name equivalence is built ONCE per surname group, from every
    // row in the group (not just the pair being compared) — this is what lets a nickname printed
    // on ONE row (e.g. legiscan's 'Bob' on an otherwise 'Robert Onder' row) bridge every OTHER
    // row in the SAME surname-gated group, not just that one row's own direct pairs. Trivial
    // (no unions) when no row in the group carries a nickname, so this changes nothing for every
    // pre-amendment group.
    const equivalence = buildGivenNicknameEquivalence(idxs.map((i) => list[i]));

    const statusCache = new Map();
    const pairStatus = (i, j) => {
      const cacheKey = i < j ? `${i}|${j}` : `${j}|${i}`;
      if (statusCache.has(cacheKey)) return statusCache.get(cacheKey);
      const status = finalPairStatus(list[i], list[j], equivalence);
      statusCache.set(cacheKey, status);
      return status;
    };

    for (let a = 0; a < idxs.length; a += 1) {
      for (let b = a + 1; b < idxs.length; b += 1) {
        const status = pairStatus(idxs[a], idxs[b]);
        if (status !== 'contradiction' && status !== 'no-pair') union(idxs[a], idxs[b]);
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
      let hasNoPair = false;
      let hasAmbiguous = false;
      for (let a = 0; a < members.length; a += 1) {
        for (let b = a + 1; b < members.length; b += 1) {
          const status = pairStatus(members[a], members[b]);
          if (status === 'contradiction') hasContradiction = true;
          else if (status === 'no-pair') hasNoPair = true;
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
      } else if (hasNoPair) {
        flagged.push({
          clusterKey: key, candidateIds: memberIds, evidence, reason: 'internal_no_name_variant',
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

// auditClusterCoherence — fix round 2's THIRD, non-destructive layer (after finalPairStatus's own
// construction, and writeAutoCluster's structural throw in src/cli/link-persons.js): an
// independent, mechanical re-verification that EVERY member pair of EVERY proposed cluster shares
// a full-name (or nickname) variant, computed directly off clusterLegislators' own output (each
// cluster's `evidence` entries already carry `fullName`/`nickname` per member — see
// buildMemberEvidence above), not by re-deriving anything from the original `rows`. Nickname
// amendment: rebuilds its OWN given-name equivalence per cluster, from that same cluster's own
// evidence snapshot (buildGivenNicknameEquivalenceFromEvidence) — a genuine independent
// recomputation from the raw fullName/nickname facts, not a re-trust of clusterLegislators'
// verdict, so this still catches a hand-built bad cluster exactly as before (nickname absent on
// every member of a hand-built fixture -> trivial equivalence -> falls back to plain
// fullNameVariantMatch behavior). By construction this should ALWAYS report ok:true for
// clusterLegislators' own output (a clean 'compatible' verdict is only ever reachable when every
// pair's names — including any nickname bridge — already matched) — its value is as a visible,
// permanent line in the CLI's dry-run report: the human operator sees this pass BEFORE any live
// run, and a future regression in the clustering logic would show up here even if the primary
// logic's own guarantee silently broke.
export function auditClusterCoherence(clusters) {
  const violations = [];
  for (const cluster of clusters ?? []) {
    const members = cluster.evidence ?? [];
    const equivalence = buildGivenNicknameEquivalenceFromEvidence(members);
    for (let a = 0; a < members.length; a += 1) {
      for (let b = a + 1; b < members.length; b += 1) {
        const match = rowNameVariantMatch(
          { full_name: members[a].fullName },
          { full_name: members[b].fullName },
          equivalence,
        );
        if (!match) {
          violations.push({
            clusterKey: cluster.key,
            legislatorIdA: members[a].legislatorId,
            legislatorIdB: members[b].legislatorId,
            fullNameA: members[a].fullName,
            fullNameB: members[b].fullName,
          });
        }
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---- display_name precedence (mechanical, never invented — Global Constraints) ----

// reorderCommaName — a STRUCTURAL reorder of a name's own printed parts, nothing more: 'Last,
// First Middle' -> 'First Middle Last'. Deliberately distinct from normalizePersonName's own
// comma-reordering (which also lowercases and folds punctuation for MATCHING purposes) — a
// display_name must preserve the source's own casing and punctuation verbatim (e.g. 'Robert F.'
// keeps its period), so this reorders only, never folds. A name with no comma passes through
// unchanged (every non-bioguide source in this codebase already prints 'First Last').
//
// IMPORTANT fix round 1: the original two-way split (first comma only) corrupted a real bioguide
// suffix name — 'Duncan, John J., Jr.' (family, given, suffix — THREE comma-separated segments)
// produced 'John J., Jr. Duncan', dragging the suffix into the middle of the printed name. Fixed
// to split on EVERY comma: segment 0 is the family name, segment 1 is the given name(s), and any
// further segments are suffixes, re-appended AFTER the family name with their own comma (the
// conventional printed form) — 'John J. Duncan, Jr.'. The plain two-segment case (segment 0 =
// family, segment 1 = given, no suffix segment) is unaffected: 'Onder, Robert F.' -> still exactly
// 'Robert F. Onder'.
export function reorderCommaName(name) {
  const s = String(name ?? '').trim();
  const segments = s.split(',').map((seg) => seg.trim()).filter((seg) => seg !== '');
  if (segments.length <= 1) return s; // no comma (or nothing but stray commas) -> unchanged
  const [family, given, ...suffixes] = segments;
  const reordered = `${given} ${family}`;
  return suffixes.length ? `${reordered}, ${suffixes.join(', ')}` : reordered;
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
