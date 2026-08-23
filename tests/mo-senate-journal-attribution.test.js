// Bill attribution for the motion families the MO Senate journal prints WITHOUT the bill inside
// the motion sentence — the class that quarantined 18 of 20 journal days (14 of them in the 2026
// session) as of 2026-08-22. Every expectation below was ground-truthed against the journal text
// by a two-stage agent fan-out (one classifier + one adversarial verifier per day, 72 findings, 0
// disagreements, 0 misattributions among the OK blocks) — see CHATLOG 2026-08-22/23.
//
// Fixtures are the adapter's OWN extractJournalText output for real journal PDFs (sha256 of each
// source PDF is recorded next to its basename), so these tests exercise parseJournalVotes on the
// exact text the live driver sees:
//   RDay6205061522-1559  2026-05-06  FY2027 appropriations day: 12 CCR-adoption + CCS-third-reading pairs (HB 2002-2013)
//                        pdf 8fc06b2cd5c314d63f7aecf49245af1b8b05d3ee9fba1078c045a25912cea0d5
//   RDay6805151864-1889  2026-05-15  CCRs on SJR 87 and SBs 835 & 1111, spelled-out reconsideration, swallowed motions
//                        pdf 8e2e9f3c2e8903740c509b880d1722b0c68aa704dbd4ed2aa7c2ca566f771526
//   RDay220218398-409    2026-02-18  two floor-amendment roll calls on SS for SB 1233
//                        pdf 26dd6066f97dab7339a1b0b1eec9ed8f9bb241f37cf7c979146bd5f11a7de563
//   RDay160131222-234    2018-01-31  zero bill votes: two amendments to SR 1137 (Senate rules) + an appointment confirmation
//                        pdf adfd7a151387b504fcba297921dd15b9851f6f3cb3cd6156f30dc163c287efc1
//   RDay290222385-401    2018-02-22  a mid-debate quorum call, an EC continuation, a procedural reconsideration on SB 625
//                        pdf c5f8449781d481c735d08d2c76c70878983d130e5fe7242730cbef3597e135d5
//   RDay200212377-386    2026-02-12  NAYS count printed on the header line ("NAYS—Senators—2" then the names)
//                        pdf 01b89d1e17926c8a730125779a1a0a209952f71a4ec0274c47fb40736b5a03f6
//   RDay320309541-561    2026-03-06  the day's only roll call is on an amendment to the SENATE JOURNAL (SB 888 quoted 8x inside it)
//                        pdf f28b52d470ce0864f6a9b446ba90953956e0d40ed2ca75924f5a3dc376197c4f
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBillRefs, parseJournalVotes } from '../src/adapters/mo-senate-journal-pdf.js';

const FIXTURES = 'tests/fixtures/research/mo-senate';
const load = (base) => parseJournalVotes(readFileSync(`${FIXTURES}/${base}.txt`, 'utf8'));
const byOrdinal = (parsed) => new Map(parsed.votes.map((v) => [v.ordinal, v]));

// ---- spelled-out bill forms (headings, CCR text, amendment instructions) ----

test('extractBillRefs: spelled-out forms map to the same identifiers as the abbreviated tokens', () => {
  assert.deepEqual(extractBillRefs('CONFERENCE COMMITTEE SUBSTITUTE FOR HOUSE COMMITTEE SUBSTITUTE FOR HOUSE BILL NO. 2002'), ['HB 2002']);
  assert.deepEqual(extractBillRefs('Senate Committee Substitute for House Committee Substitute for House Bill No. 2474, as amended'), ['HB 2474']);
  assert.deepEqual(extractBillRefs('SENATE COMMITTEE SUBSTITUTE FOR SENATE BILLS NOS. 835 and 1111'), ['SB 835', 'SB 1111']);
  assert.deepEqual(extractBillRefs('Amend Senate Substitute for Senate Committee Substitute for Senate Bills Nos. 627 & 925, Page 35'), ['SB 627', 'SB 925']);
  assert.deepEqual(extractBillRefs('SENATE SUBSTITUTE FOR SENATE JOINT RESOLUTION NO. 87'), ['SJR 87']);
  assert.deepEqual(extractBillRefs('House Concurrent Resolution No. 12'), ['HCR 12']);
  // a line-wrapped heading ("for House\nBill No. 2002", real in RDay5404221064-1119)
  assert.deepEqual(extractBillRefs('Amend Senate Substitute for House\nBill No. 2002, Page 3'), ['HB 2002']);
});

test('extractBillRefs: amendment designators, simple resolutions, and amendment headings are NEVER bill tokens', () => {
  assert.deepEqual(extractBillRefs('SA 2, as amended, was adopted by the following vote:'), []);
  assert.deepEqual(extractBillRefs('SENATE AMENDMENT NO. 2'), []);
  assert.deepEqual(extractBillRefs('SENATE AMENDMENT NO. 1 TO SENATE AMENDMENT NO. 2'), []);
  assert.deepEqual(extractBillRefs('Amend Senate Substitute for Senate Resolution No. 1137, Page 2, Rule 25'), []);
  assert.deepEqual(extractBillRefs('On motion of Senator O\'Laughlin, SR 640 was adopted by the following vote:'), []);
  assert.deepEqual(extractBillRefs('Amend Senate Journal, Second Regular Session, Thirty-First Day'), []);
});

test('extractBillRefs: lowercase enactment-history citations inside an "An Act" title are NOT bill tokens (real title block, 2026-04-29 HBs 2637 & 3155)', () => {
  const title = 'An Act to repeal sections 43.500 and 632.520, RSMo, sections 211.021 and 589.425 as enacted by senate substitute no. 3 for senate bill number 888, one hundred third general assembly, second regular session, section 589.407 as truly agreed to and finally passed by house committee substitute for senate bill no. 982, one hundred third general assembly, second regular session, and sections 589.400 and 589.414 as enacted by senate substitute for senate committee substitute for house committee substitute for house bills nos. 2273, 1946, 1814, and 2551, one hundred third general assembly';
  assert.deepEqual(extractBillRefs(title), []);
  assert.deepEqual(extractBillRefs(`On motion of Senator Schroer, CCS for SS for SCS for HCS for HBs 2637 and 3155, entitled: CONFERENCE COMMITTEE SUBSTITUTE FOR HOUSE BILLS NOS. 2637 and 3155 ${title}`), ['HB 2637', 'HB 3155', 'HB 2637', 'HB 3155']);
});

test('extractBillRefs: a numbered substitute ("SS No. 2 for SCS for SB 1012") still yields the bill, never the substitute number', () => {
  assert.deepEqual(extractBillRefs('On motion of Senator Nicola SS No. 2 for SCS for SB 1012 was read the 3rd time and passed'), ['SB 1012']);
});

// ---- 2026-05-06: the appropriations day (23 of 31 blocks quarantined live) ----

test('RDay6205061522-1559: all 31 blocks parse, zero failures, zero non-bill votes', () => {
  const p = load('RDay6205061522-1559');
  assert.deepEqual(p.failures.map((f) => `${f.ordinal}: ${f.message}`), []);
  assert.equal(p.votes.length, 31);
  assert.deepEqual(p.nonBillVotes, []);
});

test('RDay6205061522-1559: every CCR-adoption block attributes to the bill named in the report heading, every CCS third reading to the "entitled:" sentence', () => {
  const v = byOrdinal(load('RDay6205061522-1559'));
  const expected = {
    1: 'HB 2017', 2: 'HB 2018', 3: 'HB 2019', 4: 'HB 2020', 29: 'SB 1012', 31: 'SB 999',
  };
  for (let hb = 2002, ord = 5; hb <= 2013; hb += 1, ord += 2) { expected[ord] = `HB ${hb}`; expected[ord + 1] = `HB ${hb}`; }
  for (const [ord, ref] of Object.entries(expected)) assert.deepEqual(v.get(Number(ord)).bill_refs, [ref], `block ${ord}`);
  assert.deepEqual(v.get(30).bill_refs, ['SB 1694', 'SB 1688']);
  for (let ord = 5; ord <= 27; ord += 2) {
    if (ord === 7) continue; // "moved that the conference committee report on SS for SCS for HCS for HB 2003 be adopted" names the bill itself
    assert.equal(v.get(ord).attribution, 'conference_committee_report', `block ${ord}`);
  }
  for (let ord = 6; ord <= 28; ord += 2) assert.equal(v.get(ord).attribution, 'title_block', `block ${ord}`);
  assert.equal(v.get(7).attribution, 'motion');
});

test('RDay6205061522-1559: a period inside "SS No. 2" no longer truncates the motion sentence', () => {
  const v = byOrdinal(load('RDay6205061522-1559'));
  assert.equal(v.get(29).motion, 'On motion of Senator Nicola SS No. 2 for SCS for SB 1012 was read the 3rd time and passed by the following vote:');
  assert.equal(v.get(31).motion, 'On motion of Senator Hudson SS No. 2 for SB 999 was read the 3rd time and passed by the following vote:');
});

// ---- 2026-05-15: SJR / combined-vehicle CCRs, a spelled-out reconsideration, swallowed motions ----

test('RDay6805151864-1889: all 20 blocks parse, zero failures', () => {
  const p = load('RDay6805151864-1889');
  assert.deepEqual(p.failures.map((f) => `${f.ordinal}: ${f.message}`), []);
  assert.equal(p.votes.length, 20);
  assert.deepEqual(p.nonBillVotes, []);
});

test('RDay6805151864-1889: CCR heading forms — a joint resolution and a two-bill combined vehicle ("SENATE BILLS NOS. 835 and 1111")', () => {
  const v = byOrdinal(load('RDay6805151864-1889'));
  assert.deepEqual(v.get(1).bill_refs, ['SJR 87']);
  assert.equal(v.get(1).attribution, 'conference_committee_report');
  assert.deepEqual(v.get(2).bill_refs, ['SJR 87']);
  assert.equal(v.get(2).attribution, 'title_block');
  assert.deepEqual(v.get(4).bill_refs, ['SB 835', 'SB 1111']);
  assert.deepEqual(v.get(5).bill_refs, ['SB 835', 'SB 1111']);
});

test('RDay6805151864-1889: a motion that spells the bill out ("House Bill No. 2474") attributes from the motion itself, with the sentence intact', () => {
  const v = byOrdinal(load('RDay6805151864-1889'));
  assert.deepEqual(v.get(13).bill_refs, ['HB 2474']);
  assert.equal(v.get(13).attribution, 'motion');
  assert.match(v.get(13).motion, /^Pursuant to Senate Rule 92 and having voted on the prevailing side, Senator Henderson moved that the vote by which Senate Committee Substitute for House Committee Substitute for House Bill No\. 2474, as amended, was adopted be reconsidered/);
});

test('RDay6805151864-1889: a motion sentence never reaches back into the previous block\'s vote lists (no duplicate bill_refs, no YEAS in motion)', () => {
  const v = byOrdinal(load('RDay6805151864-1889'));
  assert.equal(v.get(7).motion, 'On motion of Senator Henderson, HCS for SB 1572 was read the 3rd time and passed by the following vote:');
  assert.deepEqual(v.get(7).bill_refs, ['SB 1572']);
  assert.equal(v.get(12).motion, 'On motion of Senator Crawford, HCS for SB 1019 was read the 3rd time and passed by the following vote:');
  assert.equal(v.get(18).motion, 'On motion of Senator Bean, HCS for SB 953 was read the 3rd time and passed by the following vote:');
  assert.match(v.get(9).motion, /^On motion of Senator McCreery, SS No\. 2 for SCS for HCS for HB 2292, as amended, was read the 3rd time/);
  for (const vote of v.values()) {
    assert.doesNotMatch(vote.motion, /YEAS/, `block ${vote.ordinal} motion contains a vote list`);
    assert.equal(new Set(vote.bill_refs).size, vote.bill_refs.length, `block ${vote.ordinal} has duplicate bill_refs`);
  }
});

// ---- 2026-02-18: floor-amendment roll calls (the bill is named only in the "Amend ..." instruction) ----

test('RDay220218398-409: amendment roll calls attribute from the amendment\'s own instruction line, both verbs ("was adopted" / "failed of adoption")', () => {
  const p = load('RDay220218398-409');
  assert.deepEqual(p.failures, []);
  assert.equal(p.votes.length, 2);
  for (const v of p.votes) {
    assert.deepEqual(v.bill_refs, ['SB 1233'], `block ${v.ordinal}`);
    assert.equal(v.attribution, 'amendment_instruction', `block ${v.ordinal}`);
  }
  assert.equal(p.votes[0].motion, 'SA 2, as amended, was adopted by the following vote:');
  assert.equal(p.votes[1].motion, 'SA 3 failed of adoption by the following vote:');
});

// ---- non-bill roll calls: classified, reported, never attributed, never quarantining ----

test('RDay160131222-234 (2018): a day whose only roll calls are on a Senate-rules resolution and an appointment completes with zero failures and three non-bill votes', () => {
  const p = load('RDay160131222-234');
  assert.deepEqual(p.failures, []);
  assert.deepEqual(p.votes, []);
  assert.deepEqual(p.nonBillVotes.map((n) => [n.ordinal, n.kind]), [[1, 'simple_resolution'], [2, 'simple_resolution'], [3, 'appointment']]);
  // the middle-initial period in "John B. Hurst" no longer truncates the sentence
  assert.equal(p.nonBillVotes[2].motion, 'The committee report on John B. Hurst was adopted by the following vote:');
});

test('RDay320309541-561: an amendment to the Senate JOURNAL is a non-bill vote even though SB 888 is quoted eight times inside it', () => {
  const p = load('RDay320309541-561');
  assert.deepEqual(p.failures, []);
  assert.deepEqual(p.votes, []);
  assert.deepEqual(p.nonBillVotes.map((n) => [n.ordinal, n.kind]), [[1, 'journal_amendment']]);
  assert.equal(p.nonBillVotes[0].motion, 'SA 1 failed of adoption by the following vote:');
});

test('RDay290222385-401 (2018): a mid-debate quorum call is a non-bill roll, the EC continuation still cross-checks, and a procedural reconsideration attributes from its own narrative', () => {
  const p = load('RDay290222385-401');
  assert.deepEqual(p.failures.map((f) => `${f.ordinal}: ${f.message}`), []);
  assert.deepEqual(p.nonBillVotes.map((n) => [n.ordinal, n.kind]), [[1, 'quorum_call']]);
  const v = byOrdinal(p);
  assert.deepEqual([...v.keys()], [2, 3, 4, 5, 6]);
  assert.deepEqual(v.get(2).bill_refs, ['SB 608']);
  assert.deepEqual(v.get(3).bill_refs, ['SB 826']);
  assert.deepEqual(v.get(4).bill_refs, ['SB 826']);
  assert.equal(v.get(4).attribution, 'preceding_taken_up');
  assert.deepEqual(v.get(5).bill_refs, ['SB 625']);
  assert.equal(v.get(5).attribution, 'narrative_window');
  assert.match(v.get(5).motion, /^Having voted on the prevailing side, Senator Sifton moved that the vote by which the motion to postpone debate was defeated be reconsidered/);
  assert.deepEqual(v.get(6).bill_refs, ['SB 625']);
  assert.doesNotMatch(v.get(6).motion, /YEAS/);
});

// ---- the NAYS-count-on-the-header-line shape ----

test('RDay200212377-386: "NAYS—Senators—2" with the names on the next line parses and reconciles', () => {
  const p = load('RDay200212377-386');
  assert.deepEqual(p.failures, []);
  assert.equal(p.votes.length, 4);
  const v = byOrdinal(p);
  assert.deepEqual(v.get(3).bill_refs, ['SB 994']);
  assert.deepEqual(v.get(3).nays.map((n) => n.surname), ['Nicola', 'Moon']);
  assert.equal(v.get(3).tallies.nays, 2);
  assert.equal(v.get(3).tallies.yeas, 28);
});

// ---- fail-loud posture is unchanged for anything outside the observed families ----

test('a bill-less motion of an unrecognised shape still fails loud for human review, even when exactly one bill is mentioned nearby', () => {
  const text = 'SB 100 was laid over. The Senate observed a moment of silence, and by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\nNAYS—Senators—None\nAbsent—Senators—None\nAbsent with leave—Senators—None\nVacancies—None\n';
  const { votes, failures, nonBillVotes } = parseJournalVotes(text);
  assert.deepEqual(votes, []);
  assert.deepEqual(nonBillVotes, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'no bill reference found in motion - needs human review');
});

test('a bare third reading whose narrative window names TWO different bills fails loud (never picks one)', () => {
  const text = 'Vacancies—None On motion of Senator A, SB 100, entitled: AN ACT relating to SB 200 matters. Was read the 3rd time and passed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\nNAYS—Senators—None\nAbsent—Senators—None\nAbsent with leave—Senators—None\nVacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].category, 'bill_refs');
  assert.match(failures[0].message, /SB 100/);
  assert.match(failures[0].message, /SB 200/);
});

test('a CCR-adoption motion with no CONFERENCE COMMITTEE REPORT heading in its window fails loud', () => {
  const text = 'Vacancies—None Senator A moved that the above conference committee report be adopted, which motion prevailed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\nNAYS—Senators—None\nAbsent—Senators—None\nAbsent with leave—Senators—None\nVacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].category, 'bill_refs');
  assert.equal(failures[0].reason, 'no conference committee report heading found in the block narrative');
});

test('a second-conference heading ("CONFERENCE COMMITTEE REPORT NO. 2 ON ...") is the same mechanical shape', () => {
  const text = 'Vacancies—None Senator A, on behalf of the conference committee on SS for HB 100, moved that the following conference committee report be taken up, which motion prevailed. '
    + 'CONFERENCE COMMITTEE REPORT NO. 2 ON SENATE SUBSTITUTE FOR HOUSE BILL NO. 100 The Conference Committee appointed on Senate Substitute for House Bill No. 100, begs leave to report. '
    + 'Senator A moved that the above conference committee report be adopted, which motion prevailed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\nNAYS—Senators—None\nAbsent—Senators—None\nAbsent with leave—Senators—None\nVacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(failures, []);
  assert.deepEqual(votes[0].bill_refs, ['HB 100']);
  assert.equal(votes[0].attribution, 'conference_committee_report');
});

test('a CCR-adoption block whose taken-up sentence and report heading name DIFFERENT bills fails loud', () => {
  const text = 'Vacancies—None Senator A, on behalf of the conference committee on SS for HB 100, moved that the following conference committee report be taken up, which motion prevailed. '
    + 'CONFERENCE COMMITTEE REPORT ON SENATE SUBSTITUTE FOR HOUSE BILL NO. 200 The Conference Committee appointed on Senate Substitute for House Bill No. 200, begs leave to report. '
    + 'Senator A moved that the above conference committee report be adopted, which motion prevailed by the following vote:\n'
    + 'YEAS—Senators\nAlpha Beta—2\nNAYS—Senators—None\nAbsent—Senators—None\nAbsent with leave—Senators—None\nVacancies—None\n';
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].category, 'bill_refs');
  assert.equal(failures[0].reason, 'ambiguous narrative window - more than one bill named');
  assert.deepEqual(failures[0].candidates, ['HB 100', 'HB 200']);
});

// ---- review findings (2026-08-23): the amendment rule must tie the instruction to the
// amendment the motion names, never to the nearest 'Amend ...' line ----

const LISTS = 'YEAS—Senators\nAlpha Beta—2\nNAYS—Senators—None\nAbsent—Senators—None\nAbsent with leave—Senators—None\nVacancies—None\n';

test('a pending amendment recalled from the Informal Calendar (no reprinted instruction) attributes from the recall sentence — never from another bill\'s amendment offered in between', () => {
  const text = 'Vacancies—None Senator Trent moved that SB 1233 be taken up for perfection, which motion prevailed. Senator Trent offered SS for SB 1233. Senator Nicola offered SA 3: '
    + 'SENATE AMENDMENT NO. 3 Amend Senate Substitute for Senate Bill No. 1233, Page 1, In the Title, Line 5, by striking the licensing of accountants. '
    + 'At the request of Senator Trent, SB 1233, with SS and SA 3 (pending), was placed on the Informal Calendar. '
    + 'Senator Bean moved that SB 1000 be taken up for perfection, which motion prevailed. Senator Bean offered SA 1: '
    + 'SENATE AMENDMENT NO. 1 Amend Senate Bill No. 1000, Page 2, Section 1, Line 3, by inserting after said line the following. '
    + 'Senator Bean moved that the above amendment be adopted, which motion prevailed. On motion of Senator Bean, SB 1000, as amended, was declared perfected. '
    + 'Senator Trent moved that SB 1233, with SS and SA 3 (pending), be called from the Informal Calendar and again taken up for perfection, which motion prevailed. '
    + 'SA 3 was again taken up. Senator Nicola moved that the above amendment be adopted. Senator Beck requested a roll call vote be taken. '
    + 'SA 3 failed of adoption by the following vote:\n' + LISTS;
  const { votes, failures, nonBillVotes } = parseJournalVotes(text);
  assert.deepEqual(failures.map((f) => f.message), []);
  assert.deepEqual(nonBillVotes, []);
  assert.deepEqual(votes[0].bill_refs, ['SB 1233']);
  // the amendment's own heading is in this block's narrative, so the instruction is the statement
  // and the recall sentence corroborates it (the SB 1000 business in between is not in the window)
  assert.equal(votes[0].attribution, 'amendment_instruction');

  // Same recall, but the amendment was offered BEFORE an earlier roll call (its heading is outside
  // this block's narrative): the recall sentence itself is the statement.
  const earlier = 'Senator Trent offered SA 3: SENATE AMENDMENT NO. 3 Amend Senate Substitute for Senate Bill No. 1233, Page 1, Line 5, by striking a word. '
    + 'At the request of Senator Trent, SB 1233, with SS and SA 3 (pending), was placed on the Informal Calendar. '
    + 'On motion of Senator Bean, SB 1000 was read the 3rd time and passed by the following vote:\n' + LISTS
    + 'Senator Trent moved that SB 1233, with SS and SA 3 (pending), be called from the Informal Calendar and again taken up for perfection, which motion prevailed. '
    + 'SA 3 was again taken up. SA 3 failed of adoption by the following vote:\n' + LISTS;
  const p2 = parseJournalVotes(earlier);
  assert.deepEqual(p2.failures, []);
  assert.deepEqual(p2.votes.map((v) => [v.bill_refs, v.attribution]), [[['SB 1000'], 'motion'], [['SB 1233'], 'pending_amendment_recall']]);
});

test('a recalled bill amendment is never classified non-bill because a Senate-rules amendment was voice-adopted in between', () => {
  const text = 'Vacancies—None Senator Trent offered SA 3: SENATE AMENDMENT NO. 3 Amend Senate Substitute for Senate Bill No. 1233, Page 1, In the Title, Line 5, by striking a word. '
    + 'At the request of Senator Trent, SB 1233, with SS and SA 3 (pending), was placed on the Informal Calendar. '
    + 'Senator Walsh offered SA 1: SENATE AMENDMENT NO. 1 Amend Senate Substitute for Senate Resolution No. 1137, Page 2, Rule 25, Line 18, by striking all of said line. '
    + 'Senator Walsh moved that the above amendment be adopted, which motion prevailed. '
    + 'Senator Trent moved that SB 1233, with SS and SA 3 (pending), be called from the Informal Calendar and again taken up for perfection, which motion prevailed. '
    + 'SA 3 was again taken up. SA 3 failed of adoption by the following vote:\n' + LISTS;
  const { votes, failures, nonBillVotes } = parseJournalVotes(text);
  assert.deepEqual(failures, []);
  assert.deepEqual(nonBillVotes, []);
  assert.deepEqual(votes[0].bill_refs, ['SB 1233']);
});

test('an amendment roll call with neither its own heading nor a "(pending)" recall sentence in its narrative fails loud', () => {
  const text = 'Vacancies—None Senator Bean offered SA 1: SENATE AMENDMENT NO. 1 Amend Senate Bill No. 1000, Page 2, Section 1, Line 3, by inserting a line. '
    + 'Senator Bean moved that the above amendment be adopted, which motion prevailed. '
    + 'SA 3 was again taken up. SA 3 failed of adoption by the following vote:\n' + LISTS;
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes, []);
  assert.equal(failures[0].reason, 'no amendment instruction or recall sentence found in the block narrative');
});

test('a journal amendment whose quoted body contains an "Amend ... Bill No. N, Page" line is still a journal amendment (the instruction under the heading decides)', () => {
  const text = 'Vacancies—None Senator Roberts offered SA 1, which was read: SENATE AMENDMENT NO. 1 Amend Senate Journal, Second Regular Session, Thirty-First Day, Thursday, March 5, 2026, Page 536, Line 27, '
    + 'by striking all of said line and inserting in lieu thereof the following: "Amend Senate Substitute No. 3 for Senate Bill No. 888, Page 2, Section 1, Line 4". '
    + 'Senator Roberts moved that the above amendment be adopted. SA 1 failed of adoption by the following vote:\n' + LISTS;
  const { votes, failures, nonBillVotes } = parseJournalVotes(text);
  assert.deepEqual(failures, []);
  assert.deepEqual(votes, []);
  assert.deepEqual(nonBillVotes.map((n) => n.kind), ['journal_amendment']);
});

test('an amendment instruction using the plural locator ("Sections ...") ends at its own locator; two bills in one instruction fail loud', () => {
  const one = 'Vacancies—None Senator A offered SA 1: SENATE AMENDMENT NO. 1 Amend Senate Bill No. 1233, Sections 326.256 and 326.277, by striking the words. '
    + 'Senator B offered SA 2: SENATE AMENDMENT NO. 2 Amend Senate Bill No. 1233, Page 4, Line 1, by inserting a word. '
    + 'SA 1 was adopted by the following vote:\n' + LISTS;
  const p1 = parseJournalVotes(one);
  assert.deepEqual(p1.failures, []);
  assert.deepEqual(p1.votes[0].bill_refs, ['SB 1233']);
  const two = 'Vacancies—None Senator A offered SA 1: SENATE AMENDMENT NO. 1 Amend Senate Bill No. 1233 and Senate Bill No. 1234, Page 1, Line 1, by striking a word. '
    + 'SA 1 was adopted by the following vote:\n' + LISTS;
  const p2 = parseJournalVotes(two);
  assert.deepEqual(p2.votes, []);
  assert.equal(p2.failures[0].reason, 'ambiguous amendment instruction - more than one bill named');
});

test('a sub-amendment motion ("SSA 1 for SA 2") is tied to ITS heading, not to SA 2\'s', () => {
  const text = 'Vacancies—None Senator A offered SA 2: SENATE AMENDMENT NO. 2 Amend Senate Bill No. 500, Page 1, Line 1, by striking a word. '
    + 'Senator B offered SSA 1 for SA 2: SENATE SUBSTITUTE AMENDMENT NO. 1 FOR SENATE AMENDMENT NO. 2 Amend Senate Bill No. 500, Page 1, Line 1, by striking two words. '
    + 'Senator B moved that the above substitute amendment be adopted. SSA 1 for SA 2 was adopted by the following vote:\n' + LISTS;
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(failures, []);
  assert.deepEqual(votes[0].bill_refs, ['SB 500']);
  assert.equal(votes[0].attribution, 'amendment_instruction');
});

// ---- review findings: reconsideration relevance, classifier breadth, boundary exemptions ----

test('a bill-less reconsideration borrows its bill only from floor-action sentences — a committee report naming another bill after a quorum call does not count', () => {
  const text = 'Vacancies—None Senator Cierpiot moved that SB 625 be read the 3rd time and passed. A quorum was established by the following vote:\n'
    + 'Present—Senators\nAlpha Beta—2\nAbsent—Senators—None\nAbsent with leave—Senators—None\nVacancies—None\n'
    + 'Senator Hough, Chairman of the Committee on Fiscal Oversight, submitted the following report: Mr. President: Your Committee on Fiscal Oversight, to which was referred SS No. 2 for SB 999, begs leave to report that it has considered the same and recommends that the bill do pass. '
    + 'Having voted on the prevailing side, Senator Sifton moved that the vote by which the motion to postpone debate was defeated be reconsidered, which motion failed by the following vote:\n' + LISTS;
  const { votes, failures, nonBillVotes } = parseJournalVotes(text);
  assert.deepEqual(nonBillVotes.map((n) => n.kind), ['quorum_call']);
  assert.deepEqual(votes, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'no bill reference found in motion - needs human review');
});

test('a bill-less reconsideration whose motion quotes "read the 3rd time" is labelled narrative_window, not title_block', () => {
  const text = 'Vacancies—None Senator Cierpiot moved that SB 625 be read the 3rd time and passed, which motion prevailed. '
    + 'Senator Sifton moved that the vote by which the bill was read the 3rd time and passed be reconsidered, which motion failed by the following vote:\n' + LISTS;
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(failures, []);
  assert.deepEqual(votes[0].bill_refs, ['SB 625']);
  assert.equal(votes[0].attribution, 'narrative_window');
});

test('a bill-less third reading with no "entitled:" title block in its narrative fails loud instead of attributing from proximity', () => {
  const text = 'Vacancies—None SB 100 was laid over. Was read the 3rd time and passed by the following vote:\n' + LISTS;
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes, []);
  assert.equal(failures[0].reason, 'third reading without a bill or a title block');
});

test('non-bill classifiers are exact shapes: "quorum" elsewhere in a motion or a bill named after the appointments report never classifies non-bill', () => {
  const quorum = 'Vacancies—None The motion to declare a quorum present was adopted by the following vote:\n' + LISTS;
  const q = parseJournalVotes(quorum);
  assert.deepEqual(q.nonBillVotes, []);
  assert.equal(q.failures.length, 1);
  const appointment = 'Vacancies—None Your Committee on Gubernatorial Appointments, to which was referred the appointment of Jane Doe, begs leave to report that it has considered the same and recommends that the Senate do give its advice and consent. '
    + 'SB 300 was taken up. The committee report on Jane Doe was adopted by the following vote:\n' + LISTS;
  const a = parseJournalVotes(appointment);
  assert.deepEqual(a.nonBillVotes, []);
  assert.equal(a.failures.length, 1);
  const genuine = 'Vacancies—None Your Committee on Gubernatorial Appointments, to which was referred the appointment of John B. Hurst, begs leave to report. '
    + 'The committee report on John B. Hurst was adopted by the following vote:\n' + LISTS;
  const g = parseJournalVotes(genuine);
  assert.deepEqual(g.failures, []);
  assert.deepEqual(g.nonBillVotes.map((n) => n.kind), ['appointment']);
  assert.equal(g.nonBillVotes[0].motion, 'The committee report on John B. Hurst was adopted by the following vote:');
});

test('a bill reachable only across a single-initial period is never attributed as "motion"', () => {
  const text = 'Vacancies—None Senator A moved that SB 300 be taken up per Exhibit A. The motion was adopted by the following vote:\n' + LISTS;
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(votes, []);
  assert.equal(failures[0].reason, 'bill reference reachable only across an exempted initial period');
});

test('an uppercase "NO." inside a motion sentence is not a sentence boundary', () => {
  const text = 'Vacancies—None Was taken up. On motion of Senator A, SENATE BILL NO. 12 was read the 3rd time and passed by the following vote:\n' + LISTS;
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(failures, []);
  assert.equal(votes[0].motion, 'On motion of Senator A, SENATE BILL NO. 12 was read the 3rd time and passed by the following vote:');
  assert.deepEqual(votes[0].bill_refs, ['SB 12']);
});

test('a motion naming two different bills fails loud; a bill number followed by bare prose digits is one bill', () => {
  const two = 'Vacancies—None On motion of Senator A, SB 100 and HB 200 were read the 3rd time and passed by the following vote:\n' + LISTS;
  const p = parseJournalVotes(two);
  assert.deepEqual(p.votes, []);
  assert.equal(p.failures[0].reason, 'ambiguous motion - more than one bill named');
  assert.deepEqual(extractBillRefs('SB 100 2026 was read'), ['SB 100']);
});

test('a hyphenated surname in an "Excused from voting" tail does not leak the tail into the next motion', () => {
  const text = 'On motion of Senator A, SB 1 was read the 3rd time and passed by the following vote:\n' + LISTS.replace('Vacancies—None\n', 'Vacancies—None\nExcused from voting—Senator Chappelle-Nadal—1\n')
    + 'On motion of Senator B, SB 2 was read the 3rd time and passed by the following vote:\n' + LISTS;
  const { votes, failures } = parseJournalVotes(text);
  assert.deepEqual(failures, []);
  assert.equal(votes[1].motion, 'On motion of Senator B, SB 2 was read the 3rd time and passed by the following vote:');
});

test('emergency clause after a CCS passage corroborates from the preceding title block; a second bill in between fails loud', () => {
  const ccs = 'Vacancies—None On motion of Senator Schroer, CCS for HCS for HB 2637, entitled: CONFERENCE COMMITTEE SUBSTITUTE FOR HOUSE COMMITTEE SUBSTITUTE FOR HOUSE BILL NO. 2637 An Act relating to public safety, with an emergency clause. Was read the 3rd time and passed by the following vote:\n' + LISTS;
  const ec = 'The President declared the bill passed. The emergency clause was adopted by the following vote:\n' + LISTS;
  const ok = parseJournalVotes(ccs + ec);
  assert.deepEqual(ok.failures, []);
  assert.deepEqual(ok.votes.map((v) => [v.bill_refs, v.attribution]), [[['HB 2637'], 'title_block'], [['HB 2637'], 'preceding_title_block']]);
  const stray = parseJournalVotes(ccs + 'SB 9 was laid over. ' + ec);
  assert.equal(stray.votes.length, 1);
  assert.equal(stray.failures[0].reason, 'ambiguous narrative window - more than one bill named');
});

test('a non-bill block with no Vacancies line fails loud instead of leaking its lists into the next motion', () => {
  const text = 'A quorum was established by the following vote:\nPresent—Senators\nAlpha Beta—2\nAbsent—Senators—None\n'
    + 'On motion of Senator B, SB 2 was read the 3rd time and passed by the following vote:\n' + LISTS;
  const { votes, failures, nonBillVotes } = parseJournalVotes(text);
  assert.deepEqual(nonBillVotes, []);
  assert.equal(failures[0].category, 'vacancies');
  assert.equal(votes.length, 1);
});
