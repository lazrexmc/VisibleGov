// site/js/receipts.js — provenance-field -> "see the source" URL mapping (browser-native ES
// module). Every mapping here is mechanical: it reads a field already stored with the row, never
// invents or guesses a URL (design spec §1, docs/superpowers/specs/2026-07-30-public-site-
// design.md: "nothing renders that is not in the DB with provenance").

export function voteReceiptUrl(feedRow) {
  return feedRow?.source_url ?? null;
}

// rollCallLabel — the SOURCE'S OWN identifier for a roll call, derived from the url we already
// store and already render as the "source" link.
//
// WHY (measured 2026-08-26). After the profile renderer started showing question + date + tally,
// 50,070 rendered rows were still indistinguishable. Measuring them showed these are NOT duplicates
// — every single one is a genuinely DISTINCT vote (zero were the same vote appearing twice). They
// collapse because the source's own question text is generic: the US Senate labels twenty separate
// vote-a-rama motions "On the Motion", and LegiScan labels both an adoption motion and a third
// reading "Senate: Third Reading". 99.3% of them (49,737) carry a distinct source_url holding the
// identifier that DOES separate them:
//
//   clerk.house.gov/evs/2026/roll283.xml                    25,126 rows
//   senate.gov/.../vote_119_1_00332.xml                     13,515 rows
//   house.mo.gov/.../rollcalls/046.022.pdf                   8,160 rows
//   senate.mo.gov/.../RDay....pdf#1876.2                     2,936 rows
//   (nothing derivable)                                        333 rows
//
// This is the honest way to tell two real votes apart: it is the source's own number, mechanically
// parsed, never a distinction we invented. It is also literally the receipt — the same url the
// "source" link opens.
//
// Returns null rather than guessing. A bare journal PDF with no anchor locates nothing, and an
// unrecognised host means a new adapter nobody has taught this function about yet; in both cases
// rendering nothing is correct and rendering a guess would be worse than the ambiguity it replaces.
export function rollCallLabel(sourceUrl) {
  const u = String(sourceUrl ?? '').trim();
  if (!u) return null;

  // US House: /evs/<year>/roll283.xml — leading zeros are the url's padding, not the Clerk's
  // number, so roll007 prints as 7.
  const usHouse = /clerk\.house\.gov\/evs\/\d+\/roll(\d+)\.xml/i.exec(u);
  if (usHouse) return `Roll call ${Number(usHouse[1])}`;

  // US Senate: vote_<congress>_<session>_<vote>.xml — only the LAST number is the roll call.
  const usSenate = /roll_call_votes\/[^/]*\/vote_\d+_\d+_(\d+)\.xml/i.exec(u);
  if (usSenate) return `Roll call ${Number(usSenate[1])}`;

  // MO House: /rollcalls/046.022.pdf — day.rollcall. Printed VERBATIM rather than reformatted into
  // "Day 46, RC 22": 046.022 is the token the Clerk uses, and a visitor comparing the page against
  // the PDF should see the same string on both.
  const moHouse = /billtracking\/bills\d+\/rollcalls\/([\d.]+)\.pdf/i.exec(u);
  if (moHouse) return `Roll call ${moHouse[1]}`;

  // MO Senate journal: the #fragment is the page (and position on it). A journal url WITHOUT a
  // fragment covers a whole sitting and identifies nothing — that is the same distinction
  // src/lib/source-url-granularity.js draws, for the same reason.
  const moSenate = /senate\.mo\.gov\/.*\/Journals\/RDay[^#]*#([\d.]+)/i.exec(u);
  if (moSenate) return `Journal p. ${moSenate[1]}`;

  return null;
}

// voteDateDerivedNote — the receipt for a vote date the source never printed.
//
// WHY (migrations 0032 and 0035). LegiScan prints 275 of the 2024 Missouri House floor roll calls
// with the missing-date sentinel 0000-00-00, and the ingest refuses to invent a date. For 185 votes
// it derives one from the SAME source's own dated, tallied history action, and stores the evidence
// in votes.vote_date_provenance. Until 0035 those views did not carry the column, so the profile
// page printed a date whose origin the reader could not see — the one fact on the row that most
// needs a receipt, because it is the one that was not printed on the roll call at all.
//
// This is the same contract as rollCallLabel above: read a field already stored with the row,
// render it verbatim, and return null rather than guess. The quoted action text is the source's
// own string, tally included, so a reader can match it against the bill's printed history.
//
// Returns null — rendering nothing — for the overwhelming majority of votes, whose date WAS
// printed and therefore carries no provenance object. Also null when the payload is present but
// unrecognised or incomplete: an unfamiliar `source` means a new derivation rule this function has
// not been taught, and a missing action date/text means there is no evidence to show. In every one
// of those cases printing nothing is correct and printing a partial claim would be worse.
const DERIVED_DATE_SOURCES = new Set(['legiscan_history_tally_match']);

export function voteDateDerivedNote(voteRow) {
  const p = voteRow?.vote_date_provenance;
  if (!p || typeof p !== 'object') return null;
  if (!DERIVED_DATE_SOURCES.has(p.source)) return null;

  const action = p.action;
  if (!action || typeof action !== 'object') return null;
  const actionDate = String(action.date ?? '').trim();
  const actionText = String(action.action ?? '').trim();
  if (!actionDate || !actionText) return null;

  // legislative_day is nullable by design (0032) — it is the extra guard the driver applies when
  // the roll-call PDF link prints a day number, not something every derived date has.
  const day = Number.isFinite(Number(p.legislative_day)) && p.legislative_day != null
    ? ` (legislative day ${p.legislative_day})`
    : '';

  return `Date not printed on this roll call — derived from the bill's own history: `
    + `${actionDate} “${actionText}”${day}`;
}

// Bioguide photo derivation (design spec §3, "the ruled no-NEW-column decision"): legislators.
// image_url (OpenStates-era) wins when a source already provided one; otherwise the well-known
// unitedstates/images bioguide path is derived at render time from bioguide_id, never stored.
const BIOGUIDE_PHOTO_BASE = 'https://unitedstates.github.io/images/congress/450x550';

export function photoUrl(legislatorLike) {
  if (!legislatorLike) return null;
  if (legislatorLike.image_url) return legislatorLike.image_url;
  if (legislatorLike.bioguide_id) return `${BIOGUIDE_PHOTO_BASE}/${legislatorLike.bioguide_id}.jpg`;
  return null;
}

export function officialBillUrl(bill) {
  return bill?.canonical_url ?? null;
}
