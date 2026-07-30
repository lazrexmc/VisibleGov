// site/js/profile-model.js — the profile page's pure brain (design spec §3, task-5 brief).
// Browser-native ES module: pure functions only, zero imports, no Node APIs, no fetch. Task 6
// wires this to the DOM and to site/js/rest.js's network calls; this file never touches either.
//
// Honesty rules enforced here (the product's law, not a suggestion, per CLAUDE.md's
// "mechanically neutral" non-negotiable):
// - "present" is BANNED from careerSpan output. An open (null) end_date renders
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

  // Any dated term missing its own end_date means the true end of the career is not known —
  // "currently serving" and "data gap" both look identical from here, so both render the same
  // honest string. This is deliberately NOT limited to only the most-recent term: an open middle
  // term is just as much an unresolved end as an open latest term.
  const hasOpenEnd = dated.some((t) => !t.end_date);
  if (hasOpenEnd) return `${startYear} ${EN_DASH} (end date unrecorded)`;

  const endYear = dated.reduce((max, t) => {
    const y = yearOf(t.end_date);
    return max === null || y > max ? y : max;
  }, null);
  return `${startYear} ${EN_DASH} ${endYear}`;
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

// party: from the most recent term that itself carries a party, else the first legislator row
// carrying a party (caller-supplied order — no additional source-authority precedence invented
// here, unlike pickDisplayName's bioguide/mo_senate/mo_house/legiscan/openstates ranking, since
// the brief specifies no such ranking for this fallback), else null. Rendered by the UI as
// "party unrecorded" — this module returns null, never that string, so the wording stays a
// display concern, not a model concern.
function resolveParty(termRows, legislatorRows) {
  const fromTerm = datedTermsMostRecentFirst(termRows).find((t) => t.party)?.party;
  if (fromTerm) return fromTerm;
  const fromLegislator = legislatorRows.find((l) => l && l.party)?.party;
  return fromLegislator ?? null;
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

export function buildIdentity({ person, legislators, terms }) {
  const legislatorRows = Array.isArray(legislators) ? legislators : [];
  const termRows = Array.isArray(terms) ? terms : [];

  const displayName = person ? person.display_name : (legislatorRows[0]?.full_name ?? null);
  const party = resolveParty(termRows, legislatorRows);

  // Most-recent-by-date term when one exists; otherwise fall back to the first term row so
  // chamber/district still render plainly (task-5 brief: never attempt a fancier "as of the
  // {session-era} record" qualifier when dates are unproven — just label from the row itself).
  const anchorTerm = mostRecentTerm(termRows) ?? termRows[0] ?? null;

  return {
    displayName,
    party,
    chamberLabel: anchorTerm ? chamberLabel(anchorTerm.jurisdiction_id, anchorTerm.chamber) : null,
    districtLabel: anchorTerm ? (anchorTerm.district ?? null) : null,
    careerSpan: careerSpan(termRows),
    photoCandidate: pickPhotoCandidate(legislatorRows),
    rowCount: legislatorRows.length,
  };
}

// public_vote_feed columns (migration 0016, verified live): cast_id, legislator_id, position,
// vote_id, vote_date, chamber, question, result, source_url, jurisdiction_id, bill_id,
// bill_identifier, bill_title, session_id.
export function voteFilterQuery({
  legislatorIds, chamber, year, page,
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
