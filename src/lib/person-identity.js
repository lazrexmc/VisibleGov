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

// splitCommaNameSegments — the ONE place a comma-separated printed name is parsed into its parts,
// shared by normalizePersonName (below) and reorderCommaName (further down, display-name
// formatting) — extracted here (final wave, CRITICAL fix) so the two can never drift apart on
// this again (they briefly did: reorderCommaName was fixed in an earlier round to handle a
// trailing suffix segment correctly; normalizePersonName was not, see the CRITICAL note below).
// 'Family, Given [Middle...][, Suffix]' — segment 0 is the family name, segment 1 is the given
// name(s), and any further segments (there is normally at most one, e.g. ', Jr.') are suffix
// segments. Returns null for a name with no comma (or nothing but stray/empty commas) — the
// caller's cue to leave the input exactly as printed.
function splitCommaNameSegments(raw) {
  const segments = raw.split(',').map((seg) => seg.trim()).filter((seg) => seg !== '');
  if (segments.length <= 1) return null;
  const [family, given, ...suffixSegments] = segments;
  return { family, given, suffixSegments };
}

// normalizePersonName — CONTROLLER RULING 3: conservative ONLY. Case/whitespace/punctuation
// folding and 'Last, First' <-> 'First Last' reordering. Deliberately NO nickname table, NO fuzzy
// distance. Asymmetric costs, per the ruling: a miss creates a benign duplicate row (fixable
// later by TODO item 8's real cross-source merge); a wrong merge corrupts vote attribution to a
// real person (the mo-senate bug's exact failure mode) and may never be caught. Fail toward
// duplicates, always.
//
// CRITICAL fix (final wave, execution-proven by review): the original implementation reordered on
// the FIRST comma only ('Duncan, John J., Jr.' -> last='Duncan', first='John J., Jr.' ->
// 'John J., Jr. Duncan') — a trailing suffix segment ended up stranded MID-STRING instead of at
// the end. splitGivenFamilySuffix (further below) only ever looks at the LAST token to recognize a
// suffix, so it silently parsed suffix=null for BOTH 'Duncan, John J., Jr.' and 'Duncan, John J.,
// Sr.' — the printed Jr./Sr. disqualifier in fullNameVariantMatch/rowNameVariantMatch NEVER fired
// for a comma-form name, and a comma-form dynasty pair could auto-merge through the matcher, the
// writeAutoCluster BELT, and auditClusterCoherence alike (all three share this one parse). Fixed by
// splitting on EVERY comma (splitCommaNameSegments) and re-appending any suffix segment(s) at the
// very END of the reordered string, SPACE-joined (not comma-joined — this is the matching form, not
// the display form; a comma here would get stripped by the punctuation fold below anyway, but the
// point is the suffix token must land at the true end of the string so the last-token check that
// already existed keeps working, for free, on this now-correctly-shaped input): 'Duncan, John J.,
// Jr.' -> 'John J. Duncan Jr.' -> folded 'john j duncan jr' -> splitGivenFamilySuffix correctly
// finds suffix='jr'. The plain two-segment case (no suffix segment) is byte-for-byte unchanged:
// 'Onder, Robert F.' -> still exactly 'robert f onder'.
export function normalizePersonName(fullName) {
  let s = String(fullName ?? '').trim();
  const parsed = splitCommaNameSegments(s);
  if (parsed) {
    const { family, given, suffixSegments } = parsed;
    s = suffixSegments.length ? `${given} ${family} ${suffixSegments.join(' ')}` : `${given} ${family}`;
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
// nickname table) — see nameSetEdgeBasis/buildRowNameSet's own comments for the mechanics (STALE
// REFERENCE fixed, final wave: this originally named buildGivenNicknameEquivalence, a token-
// union-find implementation removed entirely in the nickname amendment's own fix round 1 for
// fabricating unsourced equivalences — replaced by the pairwise printed-name-set intersection those
// two functions now implement; see the "nickname amendment" section below for the full ruling).
// Migration 0013 is applied live and the backfill HAS run (52 nicknames patched from cached ZIPs,
// source-printed data — see progress.md); Lance's own live adjudication has since linked the real
// Onder rows by hand regardless. The two-cluster split this comment describes is the behavior
// WITHOUT a persisted nickname on a given row — still real and still regression-locked in
// tests/link-persons-cli.test.js for any row the backfill never reached (or a future source that
// prints no nickname at all), just no longer the live state for Onder specifically.
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
// the correction path is a controller-executed SQL runbook (ledgered in
// .superpowers/sdd/2026-07-29-identity-merge/progress.md — this is what Lance's live Bayh
// mis-adjudication correction actually used: person deleted, links deleted, person_ids nulled, by
// hand) — NOT a review-tab unlink route, which does not exist yet (STALE CLAIM fixed, final wave:
// this comment previously named one; a proper unlink route is a scheduled fast-follow, not yet
// built). Both fix rounds are strict NARROWINGS of the false-'compatible' surface — neither ever
// widens it.
//
// RESIDUAL WIDENING (IMPORTANT, nickname amendment fix round 1 — reviewer-mandated disclosure,
// beside this SAME accepted residual, not a new one): the identical-full-name residual above does
// NOT itself depend on nicknames at all (it only ever compares two rows' plain printed given
// names) — but a nickname-sourced `direct_name` edge (see nameSetEdgeBasis further below) can now
// connect a component that previously would never have been assembled at all, or would have stayed
// smaller/disconnected. Once nickname bridging pulls MORE rows into the SAME connected component,
// the exhaustive pairwise recheck evaluates every pair inside that now-larger group — INCLUDING any
// identical-full-name pair that happens to land inside it, which still auto-matches via the
// residual above regardless of whether the nickname evidence said anything about THAT specific
// pair. Concretely: a real, DISTINCT person sharing an identical full name with a cluster member,
// in a jurisdiction/seat with no comparable evidence to contradict it, can still merge silently —
// this was already possible pre-amendment (the residual predates nicknames entirely), but nickname
// reach widens the SET of groups where it can fire, by making more rows co-members of one component
// in the first place. This is not gated (the residual itself remains an accepted, documented trade-
// off, not a bug) — auditClusterCoherence's `residualOnlyClusters`/`clusterEdgeBasis` output (below)
// is the operator's window into it: a cluster whose connectivity traces back to residual edges is
// visibly flagged as such in every dry-run report, so Lance can specifically scrutinize a residual-
// heavy cluster before trusting it, rather than this widening being invisible.
// ============================================================================================

// surnameKey — the cluster pass's candidate-pairing key. Prefers the `surname` column when
// populated (MO-driver rows via migration 0006, AND legiscan-identity.js's own legiscanSurname —
// live-verified: the real legiscan-sourced Onder row carries surname='Onder' too; only the
// bioguide/openstates drivers leave it null); otherwise derives it structurally from the row's OWN
// printed full_name via splitGivenFamilySuffix's own `.family` (defined further below, referenced
// here by hoisting — a plain `function` declaration, safe regardless of textual order): the
// reordered, folded form's family token, WITH any trailing suffix correctly stripped first
// ('Onder, Robert F.' -> 'robert f onder' -> family 'onder', same as 'Bob Onder' -> 'bob onder' ->
// family 'onder'). CRITICAL fix, final wave: this used to be a bare last-token grab, which broke
// the moment normalizePersonName was fixed to correctly relocate a comma-form suffix to the true
// end of the string ('Duncan, John J., Jr.' -> 'john j duncan jr') — a bare last-token read would
// then derive the surname key as 'jr' instead of 'duncan', a real (missed-pairing, never a wrong-
// merge) regression this fix closes by reusing the SAME suffix-aware split already used everywhere
// else. This is deliberately NOT the same guarded-against move as legiscan-identity.js's
// legiscanSurname comment (never split a full name to WRITE a `surname` column value — that
// overwrote real data with a guess, twice). Nothing is written here; a coincidentally-wrong derived
// key only ever costs a MISSED pairing (two rows that share no key never get compared at all) —
// never a wrong merge on its own, because a shared key is only step one of the pairing predicate
// below, still gated by chamber/district/era compatibility and the asymmetric-cost doctrine
// throughout. Empty/unparseable input yields '' (never guessed). NOTE (fix round 2): because this
// key is structural (not a verified given-name match), the pool of same-key candidates it admits
// can be broad — surnameKey alone is deliberately permissive; it is finalPairStatus's unconditional
// full-name-variant requirement (below) that actually keeps a same-surname, different-person
// pairing from ever auto-linking, not this key.
export function surnameKey(row) {
  const surname = row?.surname;
  if (surname != null && String(surname).trim() !== '') return normalizePersonName(surname);
  return splitGivenFamilySuffix(normalizePersonName(row?.full_name ?? '')).family;
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
// path (rowNameVariantMatch, further below) reduce to. `givenMatches` is the ONLY thing that
// differs between the two: a plain `a.given === b.given` for fullNameVariantMatch, or the pairwise
// printed-name-set check (nameSetEdgeBasis) for the cluster pass. Extracting this common core means
// the nickname amendment changes zero behavior for fullNameVariantMatch's own (extensively tested)
// string-only contract.
function namesMatchStructural(a, b, givenMatches) {
  if (!a.given || !a.family || a.family !== b.family) return false;
  if (!givenMatches) return false;
  if (a.suffix && b.suffix && a.suffix !== b.suffix) return false;
  return true;
}

export function fullNameVariantMatch(fullNameA, fullNameB) {
  const a = splitGivenFamilySuffix(normalizePersonName(fullNameA));
  const b = splitGivenFamilySuffix(normalizePersonName(fullNameB));
  return namesMatchStructural(a, b, a.given === b.given);
}

// ---- nickname amendment (.superpowers/sdd/2026-07-29-identity-merge/progress.md, last entry;
// FIX ROUND 1, controller-reviewed CRITICAL finding, execution-proven) ----
//
// Migration 0013 persists LegiScan's own source-printed `person.nickname` field onto
// `legislators.nickname` (backfilled by src/cli/backfill-nicknames.js). This section is the ONLY
// place clusterLegislators' matching predicate consults it — everything above (fullNameVariantMatch
// itself, matchLegislator, buildNameVariantSet) is UNCHANGED, so every pre-existing caller/test
// keeps its exact prior behavior when no row carries a nickname.
//
// FIX ROUND 1 (CRITICAL, reviewer-caught, execution-proven): the original implementation here was a
// union-find over NORMALIZED GIVEN-NAME TOKENS, shared across an entire surname group. That
// fabricates equivalences NO SOURCE ever printed: if row X prints (given 'robert', nickname 'bob')
// and, separately, row Y prints (given 'robert', nickname 'rob') — two DIFFERENT rows, each with
// its OWN, independently real nickname — the union-find's shared pivot token 'robert' transitively
// welds 'bob' and 'rob' into the SAME equivalence class, even though no row anywhere ever printed
// that Bob and Rob are the same name. auditClusterCoherence's own "independent" re-check rebuilt
// this exact same flawed structure from the cluster's evidence, so it was not actually independent
// for this failure class — it would have rubber-stamped the fabrication.
//
// RULING (unambiguous, binding): NO union-find over tokens, NO cross-row token equivalence, EVER.
// Replaced with PAIRWISE PRINTED-NAME-SET INTERSECTION — each row's name-set is {its own normalized
// given, its own normalized nickname if present} (buildRowNameSet below), fixed data about THAT ROW
// alone, never merged with another row's set. Two rows' given-parts "match" iff (a) their PLAIN
// given names are literally identical (residual_identical_name — the PRE-EXISTING, nickname-
// unrelated accepted residual documented above evidencePairStatus/fullNameVariantMatch, still
// present with zero nickname data anywhere), OR (b) their OWN two printed name-sets share a token
// that is NOT simply both plain givens agreeing (direct_name — this edge exists ONLY because at
// least one side's SOURCE-PRINTED nickname supplied the shared token). See nameSetEdgeBasis.
//
// Consequence, honestly worked through (encoded in tests/link-persons-cli.test.js): a BRIDGING row
// that itself prints two name forms (e.g. LegiScan's own 'Robert Onder' row with nickname 'Bob')
// creates real, sourced, DIRECT edges to whichever OTHER rows print either 'Robert' or 'Bob' — but
// two rows on OPPOSITE ends of that bridge, which never share a token with EACH OTHER directly
// (e.g. a row that only ever prints 'Robert', compared to a row that only ever prints 'Bob', with
// no nickname on either), still do NOT pairwise-match each other. clusterLegislators' PRE-EXISTING
// exhaustive-pairwise-recheck safety net (unchanged by this fix — see its own comment above) then
// correctly FLAGS such a group ('internal_no_name_variant') rather than auto-clustering it, exactly
// as it already does for the "John Duncan" suffix-omission bridge — this is the SAME mechanism,
// just reached via a nickname bridge instead of a suffix-omission one, and it is the SAFE, honest
// outcome: real bridging evidence surfaced for Lance's review, never silently trusted across a gap
// neither end's own printed data actually closes.
//
// buildRowNameSet — a row's OWN printed given-name-level tokens only.
function buildRowNameSet(row) {
  const set = new Set();
  const given = splitGivenFamilySuffix(normalizePersonName(row?.full_name ?? '')).given;
  if (given) set.add(given);
  const nickname = normalizePersonName(row?.nickname ?? '');
  if (nickname) set.add(nickname);
  return set;
}

// nameSetEdgeBasis — classifies HOW (or whether) two rows' given-name-level printed data connects.
// `parsedA`/`parsedB` are the caller's already-computed splitGivenFamilySuffix(normalizePersonName(
// full_name)) results (avoids re-parsing full_name a third time when the caller — rowNameVariantMatch
// or auditClusterCoherence — already has them). Returns 'residual_identical_name' |
// 'direct_name' | null (no shared token at all). Exported for auditClusterCoherence's own
// independent, per-cluster edge-basis tally (below) and for direct unit testing.
export function nameSetEdgeBasis(rowA, rowB, parsedA, parsedB) {
  const a = parsedA ?? splitGivenFamilySuffix(normalizePersonName(rowA?.full_name ?? ''));
  const b = parsedB ?? splitGivenFamilySuffix(normalizePersonName(rowB?.full_name ?? ''));
  if (a.given && b.given && a.given === b.given) return 'residual_identical_name';
  const setB = buildRowNameSet(rowB);
  for (const token of buildRowNameSet(rowA)) {
    if (setB.has(token)) return 'direct_name';
  }
  return null;
}

// rowNameVariantMatch — like fullNameVariantMatch, but the given-part check is nameSetEdgeBasis
// (pairwise printed-name-set intersection) instead of plain given-string equality. With no
// nickname on either row, buildRowNameSet(row) = {given} for both sides, so this collapses to
// EXACTLY fullNameVariantMatch(rowA.full_name, rowB.full_name)'s own residual_identical_name path —
// the "withOUT nickname -> the current two-cluster split" regression this amendment must not
// disturb. `rowA`/`rowB` are row-shaped ({ full_name, nickname? }), not raw strings — this is the
// ONLY difference from fullNameVariantMatch's own contract.
//
// EXPORTED (nickname amendment FIX ROUND 2, controller-extended scope): this is now
// src/cli/link-persons.js's writeAutoCluster BELT check too (in place of the narrower, nickname-
// blind fullNameVariantMatch(full_name, full_name) it used before) — the structural invariant a
// cluster must satisfy before ANY write happens has to validate exactly the property
// clusterLegislators itself guarantees, or a real, matcher-legal, nickname-bridged cluster would
// wrongly fail the BELT and never write at all. A residual_identical_name edge is just as valid
// for the BELT as a direct_name one (nameSetEdgeBasis only distinguishes edge PROVENANCE for
// auditClusterCoherence's own visibility reporting — the BELT only cares whether a real edge
// exists at all, i.e. whether the pair is INCOHERENT, never which kind of edge it is).
export function rowNameVariantMatch(rowA, rowB) {
  const a = splitGivenFamilySuffix(normalizePersonName(rowA?.full_name ?? ''));
  const b = splitGivenFamilySuffix(normalizePersonName(rowB?.full_name ?? ''));
  return namesMatchStructural(a, b, nameSetEdgeBasis(rowA, rowB, a, b) != null);
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
// EXPORTED (Task 4, .superpowers/sdd/2026-07-29-profile-completeness/task-4-brief.md,
// attach-to-existing): the Global Constraints there are explicit — "Attach-to-existing must reuse
// the same matcher primitives — no parallel matching logic." finalPairStatus IS the one function
// that already encodes "same pairwise matcher, same evidence rules" for an arbitrary pair of rows
// (name-variant gate + seat-evidence compatibility, fix round 2's own unconditional gate, unchanged
// above) — src/cli/link-persons.js's attach pass calls this verbatim, pairing an unlinked row
// against an ALREADY-LINKED row, exactly the same call shape clusterLegislators' own internal
// pairStatus(i,j) already uses. No logic here changes for this export; only its visibility widens.
export function finalPairStatus(rowA, rowB) {
  const seat = rowSeatStatus(rowA.evidence, rowB.evidence);
  if (seat === 'contradiction') return 'contradiction';
  const namesMatch = rowNameVariantMatch(rowA, rowB);
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
// auditClusterCoherence (below) can independently RE-DERIVE the same pairwise printed-name-set
// match (nameSetEdgeBasis/rowNameVariantMatch) used to form this cluster, purely from this
// evidence snapshot, without re-touching the original `rows` (STALE WORDING fixed, final wave:
// "rebuild the SAME given-name equivalence" described the removed token-union-find design; there
// is no equivalence STRUCTURE left to rebuild — matching is pure pairwise comparison now, so this
// recomputes fresh per pair rather than reconstructing any shared state).
// EXPORTED (Task 4, attach-to-existing): reused verbatim by src/cli/link-persons.js's attach pass
// to shape an attach_candidate flag's per-candidate evidence in the EXACT SAME shape every other
// identity_flags row's evidence.candidates already carries (legislatorId/fullName/nickname/
// surnameKeyUsed/sourceKeys/chamberDistrictEra) — so src/review/server.js's existing
// formatCandidateDistrict/formatCandidateEraSpan/findCandidateEvidence need no reason-specific
// branching to render an attach flag's candidates. No logic change; only its visibility widens.
export function buildMemberEvidence(row, nameKeyValue) {
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

    const statusCache = new Map();
    const pairStatus = (i, j) => {
      const cacheKey = i < j ? `${i}|${j}` : `${j}|${i}`;
      if (statusCache.has(cacheKey)) return statusCache.get(cacheKey);
      const status = finalPairStatus(list[i], list[j]);
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
// buildMemberEvidence above), not by re-deriving anything from the original `rows`, and not by
// re-trusting clusterLegislators' own verdict — this recomputes rowNameVariantMatch/
// nameSetEdgeBasis directly from the raw fullName/nickname facts stored on the evidence snapshot
// (FIX ROUND 1: genuinely independent for the nickname class too, now that matching is pure
// pairwise printed-name-set intersection with no group-level state to accidentally re-trust — the
// original union-find version rebuilt the SAME flawed equivalence here, which made this layer NOT
// actually independent of the bug it was supposed to catch). By construction this should ALWAYS
// report ok:true for clusterLegislators' own output — its value is as a visible, permanent line in
// the CLI's dry-run report: the human operator sees this pass BEFORE any live run, and a future
// regression in the clustering logic would show up here even if the primary logic's own guarantee
// silently broke.
//
// FIX ROUND 1 addition (AUDIT INDEPENDENCE, reviewer-mandated — visibility, NOT a new gate): each
// passing cluster's matching pairs are also classified by nameSetEdgeBasis and tallied into
// `clusterEdgeBasis` ({ clusterKey, direct_name_edges, residual_identical_name_edges }) — so the
// operator can SEE, per cluster, how much of its connectivity rests on a source-printed nickname
// bridge (direct_name) versus the pre-existing, nickname-unrelated identical-full-name residual
// (residual_identical_name — see the ACCEPTED RESIDUAL comment above evidencePairStatus: this
// residual is not new, and this amendment gives it MORE reach since a nickname bridge can now
// connect rows that would otherwise never have been compared at all — see the ACCEPTED RESIDUAL
// note further above for the full "residual widening" implication). `residualOnlyClusters` lists
// the clusterKey of every cluster held together ENTIRELY by residual edges (zero direct_name_edges)
// — a real, mechanically-derived signal for the review tooling to surface distinctly, not a new
// pass/fail condition (a residual-only cluster is still `ok:true` if every pair matched).
export function auditClusterCoherence(clusters) {
  const violations = [];
  const clusterEdgeBasis = [];
  const residualOnlyClusters = [];
  for (const cluster of clusters ?? []) {
    const members = cluster.evidence ?? [];
    let directNameEdges = 0;
    let residualIdenticalNameEdges = 0;
    for (let a = 0; a < members.length; a += 1) {
      for (let b = a + 1; b < members.length; b += 1) {
        const rowA = { full_name: members[a].fullName, nickname: members[a].nickname };
        const rowB = { full_name: members[b].fullName, nickname: members[b].nickname };
        const parsedA = splitGivenFamilySuffix(normalizePersonName(rowA.full_name));
        const parsedB = splitGivenFamilySuffix(normalizePersonName(rowB.full_name));
        if (!namesMatchStructural(parsedA, parsedB, nameSetEdgeBasis(rowA, rowB, parsedA, parsedB) != null)) {
          violations.push({
            clusterKey: cluster.key,
            legislatorIdA: members[a].legislatorId,
            legislatorIdB: members[b].legislatorId,
            fullNameA: members[a].fullName,
            fullNameB: members[b].fullName,
          });
          continue;
        }
        const basis = nameSetEdgeBasis(rowA, rowB, parsedA, parsedB);
        if (basis === 'direct_name') directNameEdges += 1;
        else if (basis === 'residual_identical_name') residualIdenticalNameEdges += 1;
      }
    }
    clusterEdgeBasis.push({
      clusterKey: cluster.key,
      direct_name_edges: directNameEdges,
      residual_identical_name_edges: residualIdenticalNameEdges,
    });
    if (directNameEdges === 0 && residualIdenticalNameEdges > 0) residualOnlyClusters.push(cluster.key);
  }
  return {
    ok: violations.length === 0, violations, clusterEdgeBasis, residualOnlyClusters,
  };
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
// to split on EVERY comma (splitCommaNameSegments, shared with normalizePersonName above — the
// CRITICAL fix, final wave, extracted this exact splitting logic into one place after the two
// functions drifted apart on it once already): segment 0 is the family name, segment 1 is the
// given name(s), and any further segments are suffixes, re-appended AFTER the family name with
// their own comma (the conventional PRINTED form — contrast normalizePersonName's own
// space-joined-at-the-end form, which exists purely so its downstream last-token suffix check
// keeps working) — 'John J. Duncan, Jr.'. The plain two-segment case (segment 0 = family, segment
// 1 = given, no suffix segment) is unaffected: 'Onder, Robert F.' -> still exactly
// 'Robert F. Onder'.
export function reorderCommaName(name) {
  const s = String(name ?? '').trim();
  const parsed = splitCommaNameSegments(s);
  if (!parsed) return s; // no comma (or nothing but stray commas) -> unchanged
  const { family, given, suffixSegments } = parsed;
  const reordered = `${given} ${family}`;
  return suffixSegments.length ? `${reordered}, ${suffixSegments.join(', ')}` : reordered;
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
