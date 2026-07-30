// site/js/receipts.js — provenance-field -> "see the source" URL mapping (browser-native ES
// module). Every mapping here is mechanical: it reads a field already stored with the row, never
// invents or guesses a URL (design spec §1, docs/superpowers/specs/2026-07-30-public-site-
// design.md: "nothing renders that is not in the DB with provenance").

export function voteReceiptUrl(feedRow) {
  return feedRow?.source_url ?? null;
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
