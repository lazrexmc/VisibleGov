// site/js/districts.js — pure district-matching brain for the address lookup (design spec §5,
// task-8-brief.md). Browser-native ES module: zero imports, no DOM, no fetch. Consumed by
// site/js/directory-page.js, which owns the /geocode fetch and the DOM.
//
// Currency-honesty law (spec §5, verbatim behavior, non-negotiable): results NEVER use the word
// "current" — the terms-date backfill is a known-parked gap, so some seat-holdings cannot prove
// they are current. asOf() below is built from the matched terms' own start_date evidence when
// present; when it is not, the exact honest fallback string is used, verbatim, every time.
//
// Ambiguous seats (two+ legislators geographically match one seat — "era overlap unprovable"):
// this module makes NO attempt to pick a winner, even when both matched terms carry dates that
// LOOK non-overlapping — see matchReps' own comment. Showing every candidate honestly, with its
// own term as "date evidence," beats guessing.

const EN_DASH = '–'; // matches profile-model.js's careerSpan EN_DASH exactly

// Strips leading zeros from a printed district number ('02' -> '2', '060' -> '60'). An all-zero
// value ('00', the at-large convention some Census layers use) normalizes to '0', not ''. A
// non-numeric district string (defensive; today's real data is always numeric) passes through
// unchanged — normalization only ever removes leading zeros, never reshapes the value.
export function normalizeDistrict(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return null;
  const stripped = str.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

// Real Census Geocoder layer keys carry a year/congress-number PREFIX
// ('119th Congressional Districts', '2024 State Legislative Districts - Upper') — verified
// against tests/fixtures/census/capitol.json, a real captured payload. Matching by substring
// (not startsWith) is robust to whatever congress/year prefix a future vintage ships with,
// without this module needing to know the current congress number.
function findLayerBySubstring(geographies, substring) {
  if (!geographies || typeof geographies !== 'object') return null;
  const key = Object.keys(geographies).find((k) => k.includes(substring));
  return key ? geographies[key] : null;
}

function firstRow(layer) {
  return Array.isArray(layer) && layer.length > 0 ? layer[0] : null;
}

// result.addressMatches[0].geographies -> {state, cd, sldu, sldl}. No match (garbage/unmatched
// address, or a malformed/empty payload) -> all nulls, never throws — the caller renders an
// honest empty state, not a crash.
export function parseGeographies(censusJson) {
  const nulls = {
    state: null, cd: null, sldu: null, sldl: null,
  };
  const match = censusJson?.result?.addressMatches?.[0];
  const geographies = match?.geographies;
  if (!geographies) return nulls;

  const stateRow = firstRow(geographies.States);
  const state = stateRow?.STUSAB ?? null;

  const cdRow = firstRow(findLayerBySubstring(geographies, 'Congressional Districts'));
  const cd = cdRow ? normalizeDistrict(cdRow.CD119 ?? cdRow.BASENAME ?? null) : null;

  const slduRow = firstRow(findLayerBySubstring(geographies, 'State Legislative Districts - Upper'));
  const sldu = slduRow ? normalizeDistrict(slduRow.SLDU ?? slduRow.BASENAME ?? null) : null;

  const sldlRow = firstRow(findLayerBySubstring(geographies, 'State Legislative Districts - Lower'));
  const sldl = sldlRow ? normalizeDistrict(sldlRow.SLDL ?? sldlRow.BASENAME ?? null) : null;

  return {
    state, cd, sldu, sldl,
  };
}

// Per-candidate date evidence for the UI (an ambiguous seat renders this next to EACH returned
// candidate). Mirrors profile-model.js's careerSpan honesty rules at the single-term level:
// "present"/"current" are banned; an open end says so plainly; no start_date at all says so too.
export function termDateEvidence(term) {
  if (!term || !term.start_date) return 'dates unrecorded';
  if (!term.end_date) return `${term.start_date} ${EN_DASH} (end date unrecorded)`;
  return `${term.start_date} ${EN_DASH} ${term.end_date}`;
}

// The exact honest fallback, verbatim, whenever no matched term across the whole result carries a
// start_date — never guessed, never "current."
const ASOF_FALLBACK = 'per the most recent term evidence in our data (dates unrecorded)';

// Fix round 1 (task-8 review, LOW-6): the dates-present form now reads as a variant of the SAME
// sentence as the fallback, rather than a differently-worded one — "per the most recent term
// evidence in our data" stays the constant lead-in either way; only the parenthetical changes
// between "(dates unrecorded)" and "(most recent: <date>)."
function asOfLabel(matchedTerms) {
  const dated = (matchedTerms || []).filter((t) => t && t.start_date);
  if (dated.length === 0) return ASOF_FALLBACK;
  const mostRecent = dated.reduce(
    (latest, t) => (t.start_date > latest ? t.start_date : latest),
    dated[0].start_date,
  );
  return `per the most recent term evidence in our data (most recent: ${mostRecent})`;
}

// Fix round 1 (task-8 review, LOW-13): state codes are compared case-insensitively everywhere —
// STUSAB from Census is always uppercase in practice, but terms.state/terms.district are filled
// by several independent adapters/backfills over time, so nothing here should depend on every
// writer having matched Census's casing convention by coincidence.
function sameState(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase();
}

// Micro-round (task-8 re-review, N2): exported so directory-page.js's SEAT_IN_SCOPE gate uses the
// SAME case-insensitive check matchReps itself uses below, rather than a second, stricter
// (case-sensitive) copy that could silently disagree with it — a lowercase STUSAB used to make
// matchReps correctly find MO candidates while directory-page.js's own scope gate still called
// that category out-of-scope, dropping a real matched rep with no message at all (skip != empty).
export function isMOState(state) {
  return sameState(state, 'MO');
}

function buildCandidates(matchedTerms, legislatorById) {
  return matchedTerms
    .map((term) => {
      const legislator = legislatorById.get(term.legislator_id) || null;
      return legislator ? { legislator, term } : null;
    })
    .filter(Boolean);
}

// {terms, legislators}, {state, cd, sldu, sldl} -> {usSenators, usHouse, moSenate, moHouse, asOf}.
// Each category's array holds { legislator, term } pairs — the raw matched term rides along as
// each candidate's own "date evidence" (termDateEvidence above renders it). No picking between
// multiple geographic matches for one seat: era overlap is unprovable from this data, so every
// match is returned (asymmetric-cost doctrine — showing candidates honestly beats guessing).
export function matchReps({ terms, legislators } = {}, {
  state, cd, sldu, sldl,
} = {}) {
  const termList = Array.isArray(terms) ? terms : [];
  const legislatorList = Array.isArray(legislators) ? legislators : [];
  const legislatorById = new Map(legislatorList.filter(Boolean).map((l) => [l.id, l]));

  const isMO = isMOState(state);

  const usSenatorTerms = state
    ? termList.filter((t) => t && t.jurisdiction_id === 'us-congress' && t.chamber === 'senate'
      && sameState(t.state ?? t.district, state))
    : [];

  // MAJOR-2 (task-8 review, live-verified at-large hole): six states (AK/DE/ND/SD/VT/WY) have
  // exactly one, statewide, at-large U.S. House seat. The federal ingestion adapter's own
  // convention (src/adapters/us-congress.js) stores that seat's `district` as null rather than a
  // printed '0' or '00' — but the Census Geocoder returns CD119='00' for an at-large address,
  // which normalizeDistrict reduces to '0'. Without this bridge, a null term.district can never
  // equal cd='0' and every at-large state's House seat silently, honestly-but-WRONGLY reports
  // "not found." Ingestion writing a real '0' into these terms is a queued upstream follow-up
  // (would let this bridge retire); until then this is the mechanical fix at the matching layer,
  // not a guess: null + cd==='0' is the ONE specific, evidenced convention this bridges, nothing
  // broader (a null district still fails to match any OTHER real cd value).
  const usHouseTerms = (state && cd != null)
    ? termList.filter((t) => t && t.jurisdiction_id === 'us-congress' && t.chamber === 'house'
      && sameState(t.state, state)
      && (normalizeDistrict(t.district) === cd || (t.district == null && cd === '0')))
    : [];

  const moSenateTerms = (isMO && sldu != null)
    ? termList.filter((t) => t && t.jurisdiction_id === 'mo-legislature' && t.chamber === 'senate'
      && normalizeDistrict(t.district) === sldu)
    : [];

  const moHouseTerms = (isMO && sldl != null)
    ? termList.filter((t) => t && t.jurisdiction_id === 'mo-legislature' && t.chamber === 'house'
      && normalizeDistrict(t.district) === sldl)
    : [];

  const usSenators = buildCandidates(usSenatorTerms, legislatorById);
  const usHouse = buildCandidates(usHouseTerms, legislatorById);
  const moSenate = buildCandidates(moSenateTerms, legislatorById);
  const moHouse = buildCandidates(moHouseTerms, legislatorById);

  const asOf = asOfLabel([...usSenatorTerms, ...usHouseTerms, ...moSenateTerms, ...moHouseTerms]);

  return {
    usSenators, usHouse, moSenate, moHouse, asOf,
  };
}
