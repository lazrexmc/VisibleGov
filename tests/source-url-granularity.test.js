import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySourceUrl, urlIdentifiesOneVote, assessSharedUrl, identifierFromQuestion,
  assessSessionDateViolation, sessionContainsDay, PER_VOTE, CONTAINER,
} from '../src/lib/source-url-granularity.js';

// Every case below is a real URL shape from the live database, and the container cases are the
// load-bearing ones: a naive "same source_url + different bill_id = defect" rule flags 1,101 live
// votes of which only 693 are the real defect — 408 false positives, 37%. Retracting those would
// delete real recorded votes.

// ---- identifierFromQuestion: which bill does a roll call's own question name? ----
// This is what arbitrates a retraction, so it has to be right. Every string below is a real
// `question` value from the live database.

test('identifierFromQuestion sees past committee-substitute prefixes to the underlying bill', () => {
  assert.equal(identifierFromQuestion('House: BILLS IN CONFERENCE - CCS SCS HCS HB 10 BILLS IN CONFERENCE'), 'HB 10');
  assert.equal(identifierFromQuestion('House: HABs FOR THIRD READING - HCS HB 10 HABs FOR THIRD READING'), 'HB 10');
  assert.equal(identifierFromQuestion('House: HB 10 HABs FOR THIRD READING'), 'HB 10');
});

test('identifierFromQuestion strips SS#2 — its trailing digit is not a bill number', () => {
  // "House: SBs FOR THIRD READING SS#2 SB 4" must be SB 4, never SS 2.
  assert.equal(identifierFromQuestion('House: SBs FOR THIRD READING SS#2 SB 4'), 'SB 4');
  assert.equal(identifierFromQuestion('House: SBs 3rd READ - INFORMAL SS SB 1'), 'SB 1');
});

test('identifierFromQuestion normalises spacing and case to one canonical form', () => {
  assert.equal(identifierFromQuestion('house: sb  105 third reading'), 'SB 105');
  assert.equal(identifierFromQuestion('HB1979 HBs FOR THIRD READING'), 'HB 1979');
  assert.equal(identifierFromQuestion('House: SB 903 HBs FOR THIRD READING'), 'SB 903');
});

test('identifierFromQuestion returns null rather than guessing when no bill is named', () => {
  assert.equal(identifierFromQuestion('Senate: Third Reading'), null);
  assert.equal(identifierFromQuestion('On the Motion'), null);
  assert.equal(identifierFromQuestion(''), null);
  assert.equal(identifierFromQuestion(null), null);
});

test('identifierFromQuestion handles resolutions, not just bills', () => {
  assert.equal(identifierFromQuestion('Senate: SCR 12 Third Reading'), 'SCR 12');
  assert.equal(identifierFromQuestion('House: HJR 45 adopted'), 'HJR 45');
});

// ---- PER_VOTE shapes ----

test('a MO House roll-call PDF names exactly one vote', () => {
  const u = 'https://www.house.mo.gov/billtracking/bills231/rollcalls/046.022.pdf';
  assert.equal(classifySourceUrl(u).granularity, PER_VOTE);
  assert.equal(classifySourceUrl(u).id, 'mo-house-rollcall-pdf');
  assert.equal(urlIdentifiesOneVote(u), true);
});

test('a US House roll-call XML names exactly one vote', () => {
  assert.equal(urlIdentifiesOneVote('https://clerk.house.gov/evs/2026/roll283.xml'), true);
});

test('a US Senate vote XML names exactly one vote', () => {
  assert.equal(urlIdentifiesOneVote(
    'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00332.xml',
  ), true);
});

// ---- CONTAINER shapes: the reason this module exists ----

test('a MO Senate journal PDF is a CONTAINER — one sitting, every roll call taken that day', () => {
  // RDay330301462-486.pdf carries 13 votes across 12 bills with 13 distinct questions. Every one
  // is a real, separately-cast vote. Flagging these would delete 226 live votes.
  const u = 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf';
  assert.equal(classifySourceUrl(u).granularity, CONTAINER);
  assert.equal(urlIdentifiesOneVote(u), false);
});

test('a MO Senate journal ANCHOR is still a container — an anchor is a PAGE, and a page holds several votes', () => {
  // Anchor #521 (2019-03-14) carries both a 29-4 and a 33-0 roll call. The anchored form covers
  // 1,659 live votes across 1,460 URLs; 169 of those URLs carry more than one bill.
  assert.equal(urlIdentifiesOneVote('https://www.senate.mo.gov/19info/Journals/RDay370314512-532.pdf#521'), false);
  assert.equal(urlIdentifiesOneVote('https://www.senate.mo.gov/25info/Journals/RDay250220426-442.pdf#430.2'), false);
});

test('a LegiScan bill page is a container — it is a whole bill, not a vote', () => {
  assert.equal(urlIdentifiesOneVote('https://legiscan.com/mo/bills/2022/HB1720/'), false);
});

test('an UNRECOGNIZED url defaults to CONTAINER — the permissive answer', () => {
  // The two errors are not symmetric. Wrongly calling a URL per-vote retracts a real recorded
  // vote; wrongly calling it a container merely leaves a duplicate visible. A new adapter must be
  // added here deliberately, never guessed into the guard.
  assert.equal(classifySourceUrl('https://example.gov/some/new/source').granularity, CONTAINER);
  assert.equal(classifySourceUrl('https://example.gov/some/new/source').id, 'unknown');
  assert.equal(urlIdentifiesOneVote(null), false);
  assert.equal(urlIdentifiesOneVote(''), false);
  assert.equal(classifySourceUrl('').id, 'none');
});

// ---- assessSharedUrl ----

const MO_HOUSE = 'https://www.house.mo.gov/billtracking/bills231/rollcalls/046.022.pdf';
const MO_SENATE = 'https://www.senate.mo.gov/18info/Journals/RDay330301462-486.pdf';

test('FLAGS the real defect: one MO House roll-call PDF attached to different bills', () => {
  const rows = [
    { source_url: MO_HOUSE, bill_id: 'bill-hb10' },
    { source_url: MO_HOUSE, bill_id: 'bill-hb114' },
  ];
  const v = assessSharedUrl(rows, { billIdentityOf: (id) => (id === 'bill-hb10' ? 'HB 10|s1' : 'HB 114|s1') });
  assert.equal(v.flagged, true);
  assert.equal(v.reason, 'multiple_bills_on_one_vote_document');
});

test('NEVER flags a container, no matter how many bills share it', () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({ source_url: MO_SENATE, bill_id: `bill-${i}` }));
  const v = assessSharedUrl(rows, { billIdentityOf: (id) => id });
  assert.equal(v.flagged, false);
  assert.equal(v.reason, 'container_url');
});

test('separates a DUPLICATE BILL ROW from a misattributed vote — they need opposite fixes', () => {
  // Four live cases are one roll call attached to two `bills` rows carrying the SAME identifier
  // (SB 3, SB 4 twice, SB 1) — TODO 25's duplicate-MO-session defect surfacing here. Retracting a
  // vote would be the wrong repair; the bill rows are what is duplicated.
  const rows = [
    { source_url: MO_HOUSE, bill_id: 'bill-a' },
    { source_url: MO_HOUSE, bill_id: 'bill-b' },
  ];
  const v = assessSharedUrl(rows, { billIdentityOf: () => 'SB 4|session-regular-2025' });
  assert.equal(v.flagged, true);
  assert.equal(v.reason, 'duplicate_bill_rows');
});

test('does not flag one bill legitimately holding several rows on its own document', () => {
  const rows = [
    { source_url: MO_HOUSE, bill_id: 'bill-a' },
    { source_url: MO_HOUSE, bill_id: 'bill-a' },
  ];
  assert.equal(assessSharedUrl(rows, { billIdentityOf: () => 'HB 10|s1' }).reason, 'same_bill');
});

test('a single row is never a shared-url finding', () => {
  assert.equal(assessSharedUrl([{ source_url: MO_HOUSE, bill_id: 'x' }]).reason, 'not_shared');
  assert.equal(assessSharedUrl([]).reason, 'not_shared');
});

test('assessSharedUrl works without a billIdentifierOf resolver, defaulting to the vote finding', () => {
  const rows = [
    { source_url: MO_HOUSE, bill_id: 'bill-a' },
    { source_url: MO_HOUSE, bill_id: 'bill-b' },
  ];
  const v = assessSharedUrl(rows);
  assert.equal(v.flagged, true);
  assert.equal(v.reason, 'multiple_bills_on_one_vote_document');
});

// ---- assessSessionDateViolation: a vote cannot predate the session it is attached to ----
// Twenty live rows violated this. Missouri renumbers bills from 1 every session, so LegiScan's
// special-session datasets carried regular-session roll calls onto same-numbered special-session
// bills. Merging those bills would fuse unrelated laws — the 2025 Regular Session's SB 3 is about
// Department of Revenue fee offices, the 1st Special Session's SB 3 is about taxation.

const REGULAR = { id: 's-reg', name: '2025 Regular Session', start_date: '2025-01-08', end_date: null };
const SPECIAL = { id: 's-sp1', name: '2025 1st Special Session', start_date: '2025-06-02', end_date: null };
const BILL_REG = { id: 'b-reg', identifier: 'SB 3', session_id: 's-reg' };
const BILL_SP = { id: 'b-sp', identifier: 'SB 3', session_id: 's-sp1' };
const DOC = 'https://documents.house.mo.gov/billtracking/bills251/rollcalls/072.006.pdf';
const billOf = (id) => ({ 'b-reg': BILL_REG, 'b-sp': BILL_SP }[id] ?? null);
const sessionOf = (id) => ({ 's-reg': REGULAR, 's-sp1': SPECIAL }[id] ?? null);

test('sessionContainsDay: open-ended sessions run to the far future, missing start dates never match', () => {
  assert.equal(sessionContainsDay(REGULAR, '2025-05-15'), true);
  assert.equal(sessionContainsDay(SPECIAL, '2025-05-15'), false);
  assert.equal(sessionContainsDay(SPECIAL, '2025-06-02'), true, 'the start date itself is inside');
  assert.equal(sessionContainsDay({ start_date: null }, '2025-05-15'), false);
  assert.equal(sessionContainsDay(null, '2025-05-15'), false);
  assert.equal(sessionContainsDay({ start_date: '2025-01-08', end_date: '2025-05-30' }, '2025-06-15'), false);
});

test('FLAGS a vote 18 days before its session convened, when the real copy already exists', () => {
  const vote = { id: 'v-sp', bill_id: 'b-sp', vote_date: '2025-05-15T00:00:00+00:00', source_url: DOC };
  const sibling = { id: 'v-reg', bill_id: 'b-reg', vote_date: '2025-05-15T00:00:00+00:00', source_url: DOC };
  const v = assessSessionDateViolation({
    vote, bill: BILL_SP, session: SPECIAL, siblings: [sibling], billOf, sessionOf,
  });
  assert.equal(v.flagged, true);
  assert.equal(v.reason, 'vote_predates_session');
  assert.equal(v.keepVoteId, 'v-reg', 'keeps the copy on the session that actually contains the date');
  assert.equal(v.keepBillId, 'b-reg');
});

test('REFUSES to retract when no sibling copy exists — it may be the only record of a real vote', () => {
  const vote = { id: 'v-sp', bill_id: 'b-sp', vote_date: '2025-05-15T00:00:00+00:00', source_url: DOC };
  const v = assessSessionDateViolation({
    vote, bill: BILL_SP, session: SPECIAL, siblings: [], billOf, sessionOf,
  });
  assert.equal(v.flagged, true);
  assert.equal(v.reason, 'vote_predates_session_NEEDS_REVIEW');
  assert.equal(v.candidates, 0);
  assert.equal(v.keepVoteId, undefined, 'nothing is nominated for retraction');
});

test('REFUSES when several siblings qualify — ambiguous, so untouched', () => {
  const vote = { id: 'v-sp', bill_id: 'b-sp', vote_date: '2025-05-15T00:00:00+00:00', source_url: DOC };
  const extra = { id: 'b-reg2', identifier: 'SB 3', session_id: 's-reg' };
  const billOf2 = (id) => (id === 'b-reg2' ? extra : billOf(id));
  const v = assessSessionDateViolation({
    vote,
    bill: BILL_SP,
    session: SPECIAL,
    siblings: [{ id: 'v-a', bill_id: 'b-reg' }, { id: 'v-b', bill_id: 'b-reg2' }],
    billOf: billOf2,
    sessionOf,
  });
  assert.equal(v.reason, 'vote_predates_session_NEEDS_REVIEW');
  assert.equal(v.candidates, 2);
});

test('a sibling with a DIFFERENT bill number does not qualify', () => {
  const vote = { id: 'v-sp', bill_id: 'b-sp', vote_date: '2025-05-15T00:00:00+00:00', source_url: DOC };
  const other = { id: 'b-other', identifier: 'SB 999', session_id: 's-reg' };
  const billOf2 = (id) => (id === 'b-other' ? other : billOf(id));
  const v = assessSessionDateViolation({
    vote, bill: BILL_SP, session: SPECIAL, siblings: [{ id: 'v-x', bill_id: 'b-other' }], billOf: billOf2, sessionOf,
  });
  assert.equal(v.reason, 'vote_predates_session_NEEDS_REVIEW');
});

test('does NOT flag a vote inside its own session, or a session with no start date', () => {
  const ok = { id: 'v-reg', bill_id: 'b-reg', vote_date: '2025-05-15T00:00:00+00:00', source_url: DOC };
  assert.equal(assessSessionDateViolation({
    vote: ok, bill: BILL_REG, session: REGULAR, siblings: [], billOf, sessionOf,
  }).reason, 'date_within_session');
  assert.equal(assessSessionDateViolation({
    vote: ok, bill: BILL_REG, session: { name: 'x', start_date: null }, siblings: [], billOf, sessionOf,
  }).reason, 'session_has_no_start_date');
  assert.equal(assessSessionDateViolation({
    vote: { ...ok, vote_date: null }, bill: BILL_REG, session: REGULAR, siblings: [], billOf, sessionOf,
  }).reason, 'no_vote_date');
});
