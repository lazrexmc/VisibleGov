// source-url-granularity — does a source_url name ONE vote, or a DOCUMENT holding many?
//
// This exists because the answer varies by source, and a rule that assumes one answer breaks
// badly in both directions. Both breakages have now happened in this repo, hours apart:
//
//   - Treating a container URL as proof of IDENTITY hid 17 real votes (see same-source-dedup.js:
//     a MO Senate journal page anchor covers several roll calls, so "same URL" did not mean
//     "same vote").
//   - Treating a container URL as proof of MISATTRIBUTION would have been the mirror image. A
//     naive "same source_url + different bill_id = defect" rule, measured against the live
//     database on 2026-08-26, flags 1,101 live votes of which only 693 are the real defect:
//     408 FALSE POSITIVES, 37%. Retracting those would delete real recorded votes.
//
// So granularity is DECLARED per URL shape, never inferred from the payload. Inference was tried
// and fails: "many distinct question texts means it is a container" misclassifies the confirmed
// HB 10 fan-out as legitimate, because its 232 copies carry 2 question variants ("House: HABs FOR
// THIRD READING - HCS HB 10 …" and "House: HB 10 HABs FOR THIRD READING") — more than one, yet all
// naming the same bill. The shape of the URL is the honest signal; the contents are not.
//
// Measured distribution behind the table below (live, 2026-08-26, superseded rows excluded):
//
//   URL shape                     votes   urls  urls>1bill   naive rule flags
//   mo-house rollcall PDF          6770   5945           8                698   <- PER_VOTE
//   mo-senate journal + anchor     1659   1460         169                177   <- CONTAINER
//   us-senate vote XML              890    890           0                  0   <- PER_VOTE
//   us-house rollN.xml              645    645           0                  0   <- PER_VOTE
//   mo-senate journal (bare)        278     50          35                226   <- CONTAINER
//
// The two MO Senate rows are the whole point. Every one of the 35 bare-journal multi-bill URLs
// carries as many distinct questions as it has votes (13 votes / 13 bills / 13 questions on
// RDay330301462-486.pdf, for instance) — a journal PDF is one day's sitting and prints every roll
// call taken that day, across every bill considered. The anchored form is no better: an anchor is a
// PAGE pointer, and a page holds several bills' votes.
//
// Of the 698 flagged under the correctly-scoped PER_VOTE rule, all 698 are worth a human look:
// 693 HB 10 fan-out, 4 rows where the same bill IDENTIFIER appears twice (duplicate `bills` rows —
// TODO 25's known MO session defect surfacing here, not a vote defect), and 1 genuine two-bill
// misattribution (006.004.pdf carries both HB 1979 and SB 903 with different questions).

// A bill identifier as printed inside a question string: "CCS SCS HCS HB 10 BILLS IN CONFERENCE"
// -> "HB 10". Lives here rather than in a script because two scripts need it, and importing it from
// a top-level script would EXECUTE that script's whole database sweep as an import side effect
// (which is exactly what happened the first time, 2026-08-26).
//
// Takes the FIRST chamber-prefixed number: committee-substitute prefixes (CCS/SCS/HCS/SS) precede
// the bill they modify, so the first match is the underlying bill. "SS#2" is stripped first because
// its trailing digit would otherwise parse as a bill number.
export function identifierFromQuestion(question) {
  const m = /\b(HB|SB|HCR|SCR|HJR|SJR|HCS|SCS|HR|SR)\s*#?\s*(\d{1,4})\b/i.exec(
    String(question ?? '').replace(/\bSS#\d+\b/gi, ' '),
  );
  if (!m) return null;
  return `${m[1].toUpperCase()} ${Number(m[2])}`;
}

export const PER_VOTE = 'per_vote';
export const CONTAINER = 'container';

// Order matters only for readability; the patterns are mutually exclusive by construction.
const SHAPES = [
  {
    id: 'mo-house-rollcall-pdf',
    granularity: PER_VOTE,
    // house.mo.gov mints one PDF per roll call: /billtracking/bills231/rollcalls/046.022.pdf.
    // 5,945 such URLs live, only 8 carrying more than one bill.
    test: (u) => /house\.mo\.gov\/billtracking\/bills\d+\/rollcalls\/[\w.]+\.pdf/i.test(u),
  },
  {
    id: 'us-house-rollcall-xml',
    granularity: PER_VOTE,
    // clerk.house.gov/evs/2026/roll283.xml — the roll number IS the identity. 645 urls, 0 multi-bill.
    test: (u) => /clerk\.house\.gov\/evs\/\d+\/roll\d+\.xml/i.test(u),
  },
  {
    id: 'us-senate-vote-xml',
    granularity: PER_VOTE,
    // senate.gov/.../roll_call_votes/vote1191/vote_119_1_00332.xml. 890 urls, 0 multi-bill.
    test: (u) => /senate\.gov\/.*roll_call_votes\/.*vote_\d+_\d+_\d+\.xml/i.test(u),
  },
  {
    id: 'mo-senate-journal-pdf',
    granularity: CONTAINER,
    // One day's sitting, every roll call taken that day, across every bill. Matches the bare form
    // AND the #anchor form deliberately: an anchor is a page pointer, and a page holds several
    // bills' votes (anchor #521 on 2019-03-14 carries both a 29-4 and a 33-0).
    test: (u) => /senate\.mo\.gov\/.*\/Journals\/RDay/i.test(u),
  },
  {
    id: 'legiscan-bill-page',
    granularity: CONTAINER,
    // legiscan.com/mo/bills/2022/HB1720/ — a bill's whole page, not a vote.
    test: (u) => /legiscan\.com\/.*\/bills?\//i.test(u),
  },
];

// Returns { id, granularity }. An unrecognized URL is CONTAINER — the PERMISSIVE answer — because
// the two errors are not symmetric: wrongly calling a URL per-vote leads to retracting a real
// recorded vote, while wrongly calling it a container merely leaves a duplicate visible. When a new
// adapter appears, its votes are simply not checked by the misattribution guard until someone adds
// its shape here deliberately. Silence, not a guess.
export function classifySourceUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return { id: 'none', granularity: CONTAINER };
  for (const shape of SHAPES) {
    if (shape.test(u)) return { id: shape.id, granularity: shape.granularity };
  }
  return { id: 'unknown', granularity: CONTAINER };
}

// The only question the misattribution guard should ever ask of a URL.
export function urlIdentifiesOneVote(url) {
  return classifySourceUrl(url).granularity === PER_VOTE;
}

// Given every live vote row sharing one source_url, is this a misattribution? Only meaningful for
// PER_VOTE shapes; a container legitimately holds many bills and must never be reported.
//
// `billIdentityOf(bill_id)` must return an identity that is stable ACROSS SESSIONS — the identifier
// alone is not one. Missouri renumbers bills from 1 every session, so "SB 3" in the 2025 Regular
// Session and "SB 3" in the 2025 1st Special Session are entirely different bills (fee offices vs
// taxation, different Senate URLs). An earlier version of this function compared bare identifiers
// and therefore labelled four genuine misattributions as `duplicate_bill_rows` — which would have
// led to MERGING two unrelated bills. Pass `${identifier}|${session_id}`.
export function assessSharedUrl(rows, { billIdentityOf } = {}) {
  const url = rows && rows.length ? rows[0].source_url : null;
  if (!rows || rows.length < 2) return { flagged: false, reason: 'not_shared' };
  if (!urlIdentifiesOneVote(url)) return { flagged: false, reason: 'container_url' };
  const billIds = new Set(rows.map((r) => r.bill_id));
  if (billIds.size < 2) return { flagged: false, reason: 'same_bill' };
  const identities = billIdentityOf
    ? new Set(rows.map((r) => billIdentityOf(r.bill_id)).filter((x) => x != null))
    : null;
  if (identities && identities.size === 1) {
    return {
      flagged: true,
      reason: 'duplicate_bill_rows',
      detail: 'one roll call attached to two `bills` rows that are the same bill in the same session — '
        + 'a duplicate-bill defect, not a misattributed vote; merging the bill rows is the repair',
      rows: rows.length,
    };
  }
  return {
    flagged: true,
    reason: 'multiple_bills_on_one_vote_document',
    detail: 'a URL that names exactly one roll call is attached to votes on different bills',
    rows: rows.length,
    bills: billIds.size,
  };
}

// ---- second defect class: a vote dated before the session it is attached to ----
//
// A bill's roll call cannot predate the session that bill belongs to. Twenty live rows violated
// this: twelve 2017 appropriations votes (Feb-Apr 2017) attached to a session starting 2017-06-12,
// and eight 2025 votes (Mar-May 2025) attached to a session starting 2025-06-02. Same root cause as
// the HB 10 fan-out — a provider attaching one roll call to bills that never held it — but it needs
// its own detector because the copies live on DIFFERENT source documents, so the shared-URL test
// never sees them.
//
// This is deliberately NOT "merge the bill rows". The two bills are genuinely different: Missouri
// renumbers from 1 each session, so the 2025 Regular Session's SB 3 (Department of Revenue fee
// offices) and the 1st Special Session's SB 3 (taxation) are unrelated laws. Merging them would
// fuse two real bills into one.

export function sessionContainsDay(session, day) {
  if (!session || !session.start_date) return false;
  const start = String(session.start_date).slice(0, 10);
  const end = session.end_date ? String(session.end_date).slice(0, 10) : '9999-12-31';
  return day >= start && day <= end;
}

// Verdict for one vote whose date precedes its own session's start.
//
// `siblings` are the OTHER votes carrying the identical source_url. It is a clean retraction only
// when exactly one of them sits on a bill with the same identifier whose session DOES contain the
// date — that row is where the vote really belongs, it already exists, and nothing is lost by
// dropping this copy. Zero or several such siblings means the vote might be the only record of a
// real event, so it is reported for review and never touched.
export function assessSessionDateViolation({ vote, bill, session, siblings, billOf, sessionOf }) {
  const day = String(vote?.vote_date ?? '').slice(0, 10);
  if (!day) return { flagged: false, reason: 'no_vote_date' };
  if (!session || !session.start_date) return { flagged: false, reason: 'session_has_no_start_date' };
  if (day >= String(session.start_date).slice(0, 10)) return { flagged: false, reason: 'date_within_session' };

  const good = (siblings ?? []).filter((s) => {
    const sb = billOf(s.bill_id);
    if (!sb || sb.identifier !== bill.identifier) return false;
    return sessionContainsDay(sessionOf(sb.session_id), day);
  });
  if (good.length !== 1) {
    return {
      flagged: true,
      reason: 'vote_predates_session_NEEDS_REVIEW',
      detail: `vote dated ${day} but session "${session.name}" starts `
        + `${String(session.start_date).slice(0, 10)}; ${good.length} sibling copies sit on a bill whose `
        + 'session contains the date, so this may be the only record of a real vote — not retracted',
      candidates: good.length,
    };
  }
  return {
    flagged: true,
    reason: 'vote_predates_session',
    detail: `vote dated ${day} predates session "${session.name}" (starts `
      + `${String(session.start_date).slice(0, 10)}); the identical roll call is already stored on the `
      + 'same bill number in a session that DOES contain the date',
    keepVoteId: good[0].id,
    keepBillId: good[0].bill_id,
  };
}
