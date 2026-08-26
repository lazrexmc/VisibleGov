// same-source-dedup — deciding when TWO ROWS FROM THE SAME ADAPTER are one real vote.
//
// Migration 0022's dedup handles the CROSS-source case: LegiScan and a primary source (journal/PDF)
// each legitimately write their own row for one floor vote, and the primary wins. It is structurally
// blind to the same-source case, where one adapter emits two rows for one vote — LegiScan carrying
// two `roll_call` records that point at the identical journal page anchor, for instance.
//
// This module is deliberately, aggressively conservative, because the cost of the two errors is not
// symmetric. Missing a duplicate shows a visitor one redundant row. A FALSE duplicate hides a real
// recorded vote from a legislator's record — which is the project's one non-negotiable. So every
// condition below must hold, and each exists because a real case in this database defeated the
// weaker rule that preceded it (2026-08-26 audit, defect D1):
//
//   1. IDENTICAL CAST LISTS ARE NOT ENOUGH. On 2025-06-30 the US Senate cast ten roll calls
//      (119-1-332 … 119-1-353) on one bill, one day, every senator voting the party line every
//      time: ten byte-identical 100-cast lists, identical question ("On the Motion") and identical
//      result ("Motion Rejected"). Ten real votes. A cast-list rule would have hidden nine.
//   2. A SHARED SOURCE URL IS NOT ENOUGH. A MO Senate journal PDF covers a whole sitting, and
//      mo-senate-web numbers several distinct votes against that one bare URL (…-vote3, …-vote4).
//      The URL must carry a FRAGMENT (#430.2) — the anchor is what pins one specific vote on the
//      page. A journal URL with no fragment pins nothing.
//   3. THE FRAGMENT ALONE IS NOT ENOUGH EITHER. Anchors #1540 and #1540.2, or #1546.2 and #1546.3,
//      are adjacent but different votes, and one anchor (#521, 2019-03-14) covers two roll calls
//      that differ 29-4 vs 33-0 — so result must agree too, and must not be NULL (two NULLs satisfy
//      "same result" vacuously, which is no evidence at all).
//   4a. A "#0" FRAGMENT IS NOT AN ANCHOR. LegiScan emits `…RDay02010981-89.pdf#0` when it has no
//      page location for the vote at all. It satisfies "has a fragment" while pinning exactly
//      nothing — the same evidentiary value as the bare journal URLs rejected by condition 2, so it
//      must be rejected the same way. Found 2026-08-26 AFTER the first version of this rule had
//      already been applied to the live database; 4 of its 38 pairs rested on it.
//   4b. THE QUESTION MUST MATCH. A MO Senate journal anchor is a PAGE pointer, and a page holds
//      more than one roll call — so two rows can share an anchor and still be different votes. The
//      Senate routinely adopts a substitute and then third-reads the same bill on the same day,
//      both passing with the identical tally from the identical members: "Senate: Adopt Substitute"
//      and "Senate: Third Reading" are two real votes with one cast fingerprint. This is condition
//      1's confounder wearing a different hat, and it defeated the first applied version of this
//      rule in 13 of 38 pairs. Like result, the question must be PRESENT, not merely equal.
//   5. A TINY CAST LIST PROVES NOTHING. The mo-house-xml adapter resolves against a roster holding
//      one real legislator (a known, documented defect), so its rows can carry a single cast that
//      matches any other single cast. HB2010-4 and HB2010-5 matched on one cast while being a
//      conference-report adoption (133-17) and a third reading (132-17) — plainly different votes.
//
// Measured against the live database 2026-08-26: of 217 groups that share family+bill+chamber+date
// AND have byte-identical cast lists, only 21 survive all conditions. Every one is a pair of
// LegiScan roll_call records on one anchored MO Senate journal location, agreeing on the question.
//
// HISTORY, kept deliberately: the first version of this rule lacked 4a and 4b, confirmed 38 pairs,
// and was applied live. 17 of those 38 were FALSE — they hid real votes. The pruning path in
// scripts/dedup-same-source-votes.mjs exists because of that, and PLAYBOOK lesson 53 records it.

export const DEFAULT_CAST_FLOOR = 5;

// The adapter that wrote a row, read from its own source_key shape. Two rows can only be the same
// SOURCE record if the same source wrote them; a legiscan row and an mo-senate-web row describing
// one vote is the CROSS-source case that migration 0022 already owns, and must not be handled here.
export function sourceFamily(sourceKey) {
  const s = String(sourceKey ?? '');
  if (/^legiscan-/.test(s)) return 'legiscan';
  if (/^us-house-/.test(s)) return 'us-house';
  if (/^us-senate-/.test(s)) return 'us-senate';
  if (/^mo-senate/.test(s)) return 'mo-senate-web';
  if (/^mo-house/.test(s)) return 'mo-house-xml';
  return s.split('-').slice(0, 2).join('-') || null;
}

// Normalizes ONLY the scheme and any trailing slash. Never the path, query or fragment: 25 of the
// 38 confirmed pairs differ solely by http:// vs https://, and the fragment is the load-bearing
// part (#430.2 is which vote on the page), so normalizing it away would destroy the evidence.
export function normalizeSourceUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return null;
  return s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// True when the URL pins one specific vote rather than a whole document, or nothing at all.
// See conditions 2 and 4a — a fragment must exist AND mean something.
export function urlPinsOneVote(normalized) {
  if (!normalized) return false;
  const hash = normalized.indexOf('#');
  if (hash === -1) return false;
  const fragment = normalized.slice(hash + 1);
  if (!fragment) return false;
  // '#0' (and '#00', '#0.0') is LegiScan's "no location known" placeholder, not a location.
  if (/^0+(\.0+)*$/.test(fragment)) return false;
  return true;
}

// Order-independent identity of who voted and how. Sorted, so two rows built by different code
// paths still compare equal; joined with a separator that cannot occur in a uuid or a position.
export function castFingerprint(casts) {
  return (casts ?? [])
    .map((c) => `${c.legislator_id}:${c.position}`)
    .sort()
    .join('|');
}

export function voteDay(vote) {
  return String(vote?.vote_date ?? '').slice(0, 10);
}

// The cheap pre-filter: rows that could conceivably be the same vote. Never sufficient on its own.
export function candidateKey(vote) {
  return [
    sourceFamily(vote.source_key), vote.jurisdiction_id, vote.chamber, voteDay(vote),
    vote.bill_id ?? `Q:${vote.question ?? ''}`,
  ].join('|');
}

// The decision. `rows` is a candidate group that ALREADY shares candidateKey and a cast fingerprint;
// this applies the four conditions above and returns a verdict carrying the reason it was refused,
// so a dry run can show exactly why 179 of 217 groups are left alone rather than just omitting them.
export function confirmDuplicateGroup(rows, { castFloor = DEFAULT_CAST_FLOOR, castCount } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return { duplicate: false, reason: 'not_a_group' };
  if (typeof castCount === 'number' && castCount < castFloor) {
    return { duplicate: false, reason: 'cast_list_too_small' };
  }
  const families = new Set(rows.map((r) => sourceFamily(r.source_key)));
  if (families.size !== 1 || [...families][0] === null) {
    return { duplicate: false, reason: 'not_same_source' };
  }
  const urls = new Set(rows.map((r) => normalizeSourceUrl(r.source_url)));
  if (urls.size !== 1 || [...urls][0] === null) return { duplicate: false, reason: 'different_source_url' };
  const url = [...urls][0];
  if (!urlPinsOneVote(url)) return { duplicate: false, reason: 'source_url_pins_no_specific_vote' };
  const results = new Set(rows.map((r) => (r.result == null ? null : String(r.result))));
  if (results.size !== 1) return { duplicate: false, reason: 'different_result' };
  const result = [...results][0];
  if (result === null || result === '') return { duplicate: false, reason: 'result_missing' };
  // Condition 4b. Checked LAST because it is the one that most often fires on otherwise-perfect
  // evidence: same anchor, same tally, same members, different motion.
  const questions = new Set(rows.map((r) => (r.question == null ? null : String(r.question).trim())));
  if (questions.size !== 1) return { duplicate: false, reason: 'different_question' };
  const question = [...questions][0];
  if (question === null || question === '') return { duplicate: false, reason: 'question_missing' };
  return {
    duplicate: true,
    reason: 'identical_casts_result_question_and_anchored_source_url',
    url,
    result,
    question,
  };
}

// RULING (2026-08-26): the canonical row is the one whose SOURCE RECORD ID is lowest — for LegiScan,
// the numeric roll_call_id in the source_key. Deliberately NOT "earliest ingested": ingestion order
// is not reproducible, so a rebuild-from-scratch (docs/DISASTER_RECOVERY.md) could pick the opposite
// winner and silently swap which vote the public site shows. The source's own record id is a
// property of the DATA, identical on every rebuild. Both rows stay stored either way — this only
// decides which one displays — but a display that flips on rebuild is still a defect.
export function sourceRecordId(sourceKey) {
  const m = /(\d+)\s*$/.exec(String(sourceKey ?? ''));
  return m ? Number(m[1]) : null;
}

export function chooseCanonical(rows) {
  const ranked = [...rows].sort((a, b) => {
    const ra = sourceRecordId(a.source_key);
    const rb = sourceRecordId(b.source_key);
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
    // Fallback for a source_key with no trailing number: lexicographic on the key itself. Still
    // deterministic and data-derived, never insertion order.
    return String(a.source_key).localeCompare(String(b.source_key));
  });
  return { canonical: ranked[0], superseded: ranked.slice(1) };
}
