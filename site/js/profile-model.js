// site/js/profile-model.js — the profile page's pure brain (design spec §3, task-5 brief).
// Browser-native ES module: pure functions only, zero imports, no Node APIs, no fetch. Task 6
// wires this to the DOM and to site/js/rest.js's network calls; this file never touches either.
//
// Honesty rules enforced here (the product's law, not a suggestion, per CLAUDE.md's
// "mechanically neutral" non-negotiable):
// - "present" WAS banned from careerSpan output; that ban was lifted 2026-08-30 on measurement.
//   See the note above the hasOpenEnd branch for the numbers and the reasoning. What follows is
//   the ORIGINAL rule, kept because the instinct behind it is still right and the exception is
//   narrow: an open (null) end_date renders
//   "(end date unrecorded)" — we do not know whether the seat is still held or the data is
//   simply incomplete, and guessing "present" would assert currency we cannot prove.
// - A term set with every start_date null is date-unproven: careerSpan says so plainly
//   ('service dates unrecorded'); chamber/district still render from whatever term row exists,
//   labeled plainly — never a fabricated "as of the {session-era} record" qualifier.
// - groupSponsorships THROWS on any sponsor_type outside the exact 0015 vocabulary
//   (primary/cosponsor/joint/unspecified). A new type means the schema changed underneath us —
//   fail loud, never bucket it silently into an existing group.

const EN_DASH = '–'; // '–' — matches the design spec's careerSpan examples exactly.

function yearOf(dateStr) {
  return Number(String(dateStr).slice(0, 4));
}

// Ranks terms by start_date descending (most-recent first). Only terms carrying a start_date
// can be ranked at all — a term with no start_date has no defined recency.
function datedTermsMostRecentFirst(terms) {
  return terms
    .filter((t) => t && t.start_date)
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? 1 : a.start_date > b.start_date ? -1 : 0));
}

// The single most-recent term by start_date, or null when no term carries one.
function mostRecentTerm(terms) {
  const dated = datedTermsMostRecentFirst(terms);
  return dated.length > 0 ? dated[0] : null;
}

export function careerSpan(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const dated = list.filter((t) => t && t.start_date);
  if (dated.length === 0) return 'service dates unrecorded';

  const startYear = dated.reduce((min, t) => {
    const y = yearOf(t.start_date);
    return min === null || y < min ? y : min;
  }, null);

  // An open (null) end_date now renders "present". The original rule banned that, on the reasoning
  // that "currently serving" and "data gap" look identical from here — which was a fair assumption
  // and turns out to be false. Measured against the live database 2026-08-30:
  //
  //   731 of 1,087 terms are open-ended
  //   729 of those 731 belong to a legislator who cast a vote in 2026
  //     1 last voted in 2025
  //     1 has never voted
  //
  // So an open end_date is a 99.7% reliable currency signal, not a coin flip between two
  // indistinguishable cases. It is also what this codebase ALREADY asserts elsewhere: the directory
  // groups people under a "Serving now" heading from precisely this signal and nothing else
  // (directory-page.js — "an open term is the data literally saying 'not ended'"). Rendering
  // "(end date unrecorded)" here while the directory says "Serving now" from the same field was an
  // inconsistency, and the cautious string was the one that read like an error message about us
  // rather than a fact about the politician.
  //
  // THE HONEST COST, stated rather than hidden: 2 of 731 will read as serving when the record
  // cannot show it. That is disclosed on the trust page rather than papered over. The genuinely
  // unknown cases are untouched — no start_date at all still renders "service dates unrecorded",
  // and a partial record still carries its "(some service dates unrecorded)" suffix.
  //
  // Still deliberately NOT limited to the most-recent term: an open middle term is just as much an
  // unresolved end as an open latest one, and both mean the career has no recorded close.
  const hasOpenEnd = dated.some((t) => !t.end_date);

  // Fix round 1, finding 2 (task review, execution-proven): a term with NO start_date at all used
  // to be dropped entirely by the `dated` filter above, silently discarding its recorded
  // end_date (careerSpan([2013-2018, {start:null, end:2020}]) used to say '2013 – 2018',
  // dropping real 2020 evidence). The END bound below is computed over ALL terms' end_date, not
  // just `dated` — every real end_date is real evidence and stays in, even when its own term's
  // start is unrecorded. The gap itself is still flagged honestly with a suffix, since "some
  // start dates are missing" is itself a fact worth surfacing (this module's own standard).
  const missingStart = list.some((t) => t && !t.start_date);
  const suffix = missingStart ? ' (some service dates unrecorded)' : '';

  if (hasOpenEnd) return `${startYear} ${EN_DASH} present${suffix}`;

  const endYear = list.reduce((max, t) => {
    if (!(t && t.end_date)) return max;
    const y = yearOf(t.end_date);
    return max === null || y > max ? y : max;
  }, null);
  return `${startYear} ${EN_DASH} ${endYear}${suffix}`;
}

const CHAMBER_LABELS = {
  'us-congress:senate': 'U.S. Senate',
  'us-congress:house': 'U.S. House',
  'mo-legislature:senate': 'MO Senate',
  'mo-legislature:house': 'MO House',
};

export function chamberLabel(jurisdictionId, chamber) {
  const known = CHAMBER_LABELS[`${jurisdictionId}:${chamber}`];
  if (known) return known;
  // Unknown combo (a new jurisdiction, most likely): display the raw values rather than drop or
  // guess-map them — a jurisdiction we don't recognize yet is still real data.
  return `${jurisdictionId} ${chamber}`;
}

// Mirrors src/lib/person-identity.js's DISPLAY_NAME_PRIORITY exactly: "bioguide > mo_senate >
// mo_house > legiscan > openstates" (that file's own comment, matching migration 0012's
// persons.display_name_source CHECK constraint vocabulary). DUPLICATED HERE, NOT IMPORTED:
// profile-model.js is browser-clean (zero imports) by design, and person-identity.js is a much
// larger Node-oriented clustering module this file has no other reason to pull in — so this
// order is a small, hand-copied constant instead of a shared import. Tradeoff: there is no
// mechanical link between the two copies; if DISPLAY_NAME_PRIORITY's order ever changes in
// person-identity.js, this constant must be updated by hand to match (a drift risk, accepted).
// EXPORTED (FINAL REVIEW, finding 6): site/js/directory-page.js needs this exact ranking for the
// front door's own party fallback, which had the order-dependent bug this constant was introduced
// to fix — Curls rendered no party on the directory and 'D' on her profile, the same person on two
// pages giving two answers. Shared as a real import, never a second hand-copied list: two copies of
// a neutrality-critical ranking is exactly how a page ends up disagreeing with itself again.
export const SOURCE_PRECEDENCE_COLUMNS = [
  'bioguide_id',
  'mo_senate_id',
  'mo_house_id',
  'legiscan_people_id',
  'openstates_id',
];

// partyBySourcePrecedence — the ranking loop itself, exported alongside the constant so both
// callers run the SAME code, not two loops over the same list. Returns the party carried by the
// highest-precedence legislator row that actually has one, else null (never a display string —
// wording stays a UI concern).
export function partyBySourcePrecedence(legislatorRows) {
  const rows = Array.isArray(legislatorRows) ? legislatorRows : [];
  for (const column of SOURCE_PRECEDENCE_COLUMNS) {
    const row = rows.find((l) => l && l[column] != null && l.party);
    if (row) return row.party;
  }
  return null;
}

// Fix round 1, finding 1 (task review, execution-proven): the legislator-row fallback used to be
// "first row in caller-supplied array order with a party" — swapping two rows in the input array
// flipped the displayed party, and Task 6's query carries no order= clause (Postgres guarantees
// nothing). Party is the single most neutrality-sensitive fact this page renders, so the
// fallback must be mechanical: rank by source precedence, never by incidental array position.
//
// party: from the most recent term that itself carries a party, else the highest-precedence
// legislator row that carries a party, else null. Rendered by the UI as "party unrecorded" —
// this module returns null, never that string, so the wording stays a display concern.
function resolveParty(termRows, legislatorRows) {
  const fromTerm = datedTermsMostRecentFirst(termRows).find((t) => t.party)?.party;
  if (fromTerm) return fromTerm;
  return partyBySourcePrecedence(legislatorRows);
}

// Which legislator row is handed to receipts.js's photoUrl() later (Task 6) — this module never
// builds the image URL itself (that logic already lives in receipts.js; no lookalike copy here).
// Prefers a row that already carries image_url (photoUrl would use it directly), else a row
// carrying bioguide_id (photoUrl's own fallback derivation), else the first row, else null.
function pickPhotoCandidate(legislatorRows) {
  if (legislatorRows.length === 0) return null;
  return legislatorRows.find((l) => l && l.image_url)
    ?? legislatorRows.find((l) => l && l.bioguide_id)
    ?? legislatorRows[0];
}

// Fix round 1, finding 2 (task-6 controller live smoke, IMPORTANT): the distinct (jurisdiction_id,
// chamber, district) affiliations carried by a term set, deduped and in a DETERMINISTIC order
// (sorted by the tuple itself, never by caller-supplied array position — the same class of bug
// already fixed once for party precedence: Task 6's queries carry no order= guarantee).
function distinctAffiliations(termRows) {
  const seen = new Set();
  const result = [];
  for (const t of termRows) {
    if (!t || !t.jurisdiction_id || !t.chamber) continue;
    const key = `${t.jurisdiction_id}|${t.chamber}|${t.district ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ jurisdiction_id: t.jurisdiction_id, chamber: t.chamber, district: t.district ?? null });
  }
  result.sort((a, b) => {
    const ka = `${a.jurisdiction_id}|${a.chamber}|${a.district ?? ''}`;
    const kb = `${b.jurisdiction_id}|${b.chamber}|${b.district ?? ''}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return result;
}

// Fix round 1 (task-8 review, LOW-7): a U.S. Senate term's `district` column stores the state's
// USPS abbreviation (terms.district-as-state convention, backfill-term-states.js's own header
// comment — "Senate terms have stored the state's USPS abbreviation THERE since
// ensureSenateMembers/ensureFederalMemberMetadata first created them"), not a real district
// number. Rendering it as ", district MO" reads as a real congressional district that does not
// exist — U.S. Senate seats have none. Every place that would otherwise print a district suffix
// checks this first; MO/state-legislature districts are real numbers and stay unaffected.
function isMeaninglessDistrict(jurisdictionId, chamber) {
  return jurisdictionId === 'us-congress' && chamber === 'senate';
}

function formatAffiliation(affiliation) {
  const label = chamberLabel(affiliation.jurisdiction_id, affiliation.chamber);
  const showDistrict = affiliation.district && !isMeaninglessDistrict(affiliation.jurisdiction_id, affiliation.chamber);
  return showDistrict ? `${label}, district ${affiliation.district}` : label;
}

export function buildIdentity({ person, legislators, terms }) {
  const legislatorRows = Array.isArray(legislators) ? legislators : [];
  const termRows = Array.isArray(terms) ? terms : [];

  const displayName = person ? person.display_name : (legislatorRows[0]?.full_name ?? null);
  const party = resolveParty(termRows, legislatorRows);

  // Most-recent-by-date term when one exists; otherwise fall back to the first term row so
  // chamber/district still render plainly (task-5 brief: never attempt a fancier "as of the
  // {session-era} record" qualifier when dates are unproven — just label from the row itself).
  const dateOrderedTerm = mostRecentTerm(termRows);
  const anchorTerm = dateOrderedTerm ?? termRows[0] ?? null;

  let chamberLabelOut = null;
  let districtLabelOut = null;
  if (dateOrderedTerm) {
    // Dates DO order the terms — single-line anchor-term behavior stands unchanged (no picking
    // ambiguity: the most-recent-by-date term is a real, evidenced answer, not a guess).
    chamberLabelOut = chamberLabel(anchorTerm.jurisdiction_id, anchorTerm.chamber);
    districtLabelOut = isMeaninglessDistrict(anchorTerm.jurisdiction_id, anchorTerm.chamber)
      ? null
      : (anchorTerm.district ?? null);
  } else if (anchorTerm) {
    // Date-unproven (no term carries a start_date): the data cannot order the terms, so picking
    // one (the old `termRows[0]` fallback) is a guess — the live smoke caught exactly this
    // rendering an arbitrary chamber for a man currently serving in a different one. Asymmetric-
    // cost doctrine: show every distinct affiliation instead. A single distinct affiliation (even
    // across duplicate/multiple term rows) keeps the original single-field shape.
    const affiliations = distinctAffiliations(termRows);
    if (affiliations.length > 1) {
      chamberLabelOut = affiliations.map(formatAffiliation).join(' · ');
      districtLabelOut = null; // already folded into chamberLabelOut; avoids a doubled suffix
    } else if (affiliations.length === 1) {
      chamberLabelOut = chamberLabel(affiliations[0].jurisdiction_id, affiliations[0].chamber);
      districtLabelOut = isMeaninglessDistrict(affiliations[0].jurisdiction_id, affiliations[0].chamber)
        ? null
        : affiliations[0].district;
    }
  }

  return {
    displayName,
    party,
    chamberLabel: chamberLabelOut,
    districtLabel: districtLabelOut,
    careerSpan: careerSpan(termRows),
    photoCandidate: pickPhotoCandidate(legislatorRows),
    rowCount: legislatorRows.length,
  };
}

// public_vote_feed columns (migration 0016, verified live): cast_id, legislator_id, position,
// vote_id, vote_date, chamber, question, result, source_url, jurisdiction_id, bill_id,
// bill_identifier, bill_title, session_id.
//
// H2 (task 6b review, fix round 1): `position` — a chart-bar-click filter (site/js/vote-charts.js
// dispatches 'yea'/'nay'/'other' through the SAME nextVoteFilters reducer the chamber/year/
// missedOnly controls already use). `missedOnly` stays a SPECIAL CASE and wins outright when both
// are somehow set (defensive only — vote-charts.js's own BAR_CLICK_PATCH always clears the other
// lever on every click/checkbox change, so in practice they never coexist): it is the pre-existing
// not_voting+absent toggle, unchanged. `position` maps 'yea'/'nay' to an exact single-value match
// and 'other' to the SAME (present,other) grouping summarizeTotals' own 'other' bucket uses
// (site/js/vote-charts.js) — not_voting/absent are deliberately NOT valid `position` values here,
// since clicking either of those two bars goes through `missedOnly` instead (an exact match: that
// bucket IS the missed-votes set already).
const POSITION_FILTER_CLAUSES = {
  yea: 'position=eq.yea',
  nay: 'position=eq.nay',
  other: 'position=in.(present,other)',
};

export function voteFilterQuery({
  legislatorIds, chamber, year, missedOnly, position, page,
} = {}) {
  // `page` is accepted for signature symmetry with the caller's full filter state (task-5
  // brief's interface line lists it), but pagination is Range-header driven by rest.js's
  // pagedFetch, never a URL filter — deliberately unused here.
  void page;

  const ids = Array.isArray(legislatorIds) ? legislatorIds : [];
  const params = [`legislator_id=in.(${ids.join(',')})`];
  if (chamber) params.push(`chamber=eq.${chamber}`);
  if (year != null) {
    const y = Number(year);
    params.push(`vote_date=gte.${y}-01-01`);
    params.push(`vote_date=lt.${y + 1}-01-01`);
  }
  // Task 6 extension: the missed-votes toggle (design spec §3) — a SERVER filter appended to this
  // same path builder, never a client-side re-filter of an already-fetched partial page. Renders
  // the printed positions as-is (no percentage, no peer comparison — that would be a scorecard).
  if (missedOnly) {
    params.push('position=in.(not_voting,absent)');
  } else if (position && POSITION_FILTER_CLAUSES[position]) {
    params.push(POSITION_FILTER_CLAUSES[position]);
  }
  params.push('order=vote_date.desc.nullslast,cast_id.desc');
  return `public_vote_feed?${params.join('&')}`;
}

// The 0015 vocabulary, exactly — a new sponsor_type printed by the source means the schema
// changed underneath us (a migration widened the check constraint) and this module hasn't been
// told about it yet. Fail loud rather than silently drop the row into an existing bucket.
const SPONSOR_TYPES = ['primary', 'cosponsor', 'joint', 'unspecified'];

export class UnknownSponsorTypeError extends Error {
  constructor(sponsorType) {
    super(`Unknown bill_sponsors.sponsor_type "${sponsorType}" — outside the 0015 vocabulary `
      + '(primary/cosponsor/joint/unspecified). A new printed type means the schema changed; '
      + 'this module must be updated before it can be grouped, not silently bucketed.');
    this.name = 'UnknownSponsorTypeError';
    this.sponsorType = sponsorType;
  }
}

export function groupSponsorships(sponsorRows) {
  const groups = {
    primary: [], cosponsor: [], joint: [], unspecified: [],
  };
  for (const row of (sponsorRows || [])) {
    const type = row?.sponsor_type;
    if (!SPONSOR_TYPES.includes(type)) {
      throw new UnknownSponsorTypeError(type);
    }
    groups[type].push(row);
  }
  return groups;
}
