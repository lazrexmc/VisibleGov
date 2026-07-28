import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs, isCurrentMember } from '../src/cli/ingest.js';
import {
  resolveSenator, finalizeSenateVote, isKnownBillIdentifier,
  lastNameFromFullName, firstNameFromFullName, stateAbbreviation,
} from '../src/adapters/us-senate.js';

const membersJson = JSON.parse(readFileSync('tests/fixtures/us-congress/members-mo.json', 'utf8'));

const SENATORS = [
  { legislator_id: 'leg-hawley', state: 'MO', last_name: 'Hawley' },
  { legislator_id: 'leg-schmitt', state: 'MO', last_name: 'Schmitt' },
  { legislator_id: 'leg-smith-nh', state: 'NH', last_name: 'Smith' },
  { legislator_id: 'leg-smith-mi', state: 'MI', last_name: 'Smith' },
];

// ---- resolveSenator: the 4 cases the brief prescribes ----

test('resolveSenator exact match on (state, last_name)', () => {
  const cast = { state: 'MO', last_name: 'Hawley', first_name: 'Josh', party: 'R' };
  assert.equal(resolveSenator(cast, SENATORS), 'leg-hawley');
});

test('resolveSenator matches case-insensitively and trims whitespace', () => {
  const cast = { state: ' mo ', last_name: ' HAWLEY ', first_name: 'Josh', party: 'R' };
  assert.equal(resolveSenator(cast, SENATORS), 'leg-hawley');
});

test('resolveSenator returns null on ambiguity (>1 match) and never guesses', () => {
  const ambiguous = [...SENATORS, { legislator_id: 'leg-hawley-2', state: 'MO', last_name: 'Hawley' }];
  const cast = { state: 'MO', last_name: 'Hawley', first_name: 'Josh', party: 'R' };
  assert.equal(resolveSenator(cast, ambiguous), null);
});

test('resolveSenator returns null when no senator matches (missing)', () => {
  const cast = { state: 'MO', last_name: 'NoSuchSenator', first_name: 'Ghost', party: 'I' };
  assert.equal(resolveSenator(cast, SENATORS), null);
});

test('resolveSenator returns null against an empty senators list (pre-ensureSenateMembers reality)', () => {
  const cast = { state: 'MO', last_name: 'Hawley', first_name: 'Josh', party: 'R' };
  assert.equal(resolveSenator(cast, []), null);
});

// ---- fix pass (post-Task-3 live backfill: 869 votes, ~87k casts, 4 senators unresolved on
// every vote — 3,474 skipped casts): diacritic folding + first-name ambiguity tiebreak ----

test('resolveSenator folds diacritics on both sides (senate.gov XML strips accents, our DB does not)', () => {
  // Real case: legislators.full_name = 'Luján, Ben Ray' (from congress.gov), but senate.gov
  // roll-call XML casts carry last_name = 'Lujan' with no accent.
  const senators = [{ legislator_id: 'leg-lujan', state: 'NM', last_name: 'Luján' }];
  const cast = { state: 'NM', last_name: 'Lujan', first_name: 'Ben', party: 'D' };
  assert.equal(resolveSenator(cast, senators), 'leg-lujan');
});

test('resolveSenator folds diacritics the other direction too (accented cast, plain DB) for symmetry', () => {
  const senators = [{ legislator_id: 'leg-lujan', state: 'NM', last_name: 'Lujan' }];
  const cast = { state: 'NM', last_name: 'Luján', first_name: 'Ben', party: 'D' };
  assert.equal(resolveSenator(cast, senators), 'leg-lujan');
});

const MURKOWSKI_AK = [
  { legislator_id: 'leg-murkowski-lisa', state: 'AK', last_name: 'Murkowski', first_name: 'Lisa' },
  { legislator_id: 'leg-murkowski-frank', state: 'AK', last_name: 'Murkowski', first_name: 'Frank H.' },
];

test('resolveSenator tiebreaks an ambiguous (state, last_name) match on first_name (Murkowski, current)', () => {
  // Real case: ensureSenateMembers's unfiltered /member list ingested both the current AK
  // senator (Lisa Murkowski) and a historical one (Frank H. Murkowski, 1981-2002) — (state,
  // last_name) alone can't disambiguate; the cast's own first_name can.
  const cast = { state: 'AK', last_name: 'Murkowski', first_name: 'Lisa', party: 'R' };
  assert.equal(resolveSenator(cast, MURKOWSKI_AK), 'leg-murkowski-lisa');
});

test('resolveSenator tiebreaks an ambiguous (state, last_name) match on first_name (Murkowski, historical)', () => {
  const cast = { state: 'AK', last_name: 'Murkowski', first_name: 'Frank', party: 'R' };
  assert.equal(resolveSenator(cast, MURKOWSKI_AK), 'leg-murkowski-frank');
});

test('resolveSenator tiebreaks the real Warner/VA ambiguity (Mark Warner, current, vs John Warner, historical)', () => {
  // Real case from the live backfill. first_name is 'Mark' (not 'Mark R.') — the production
  // shape loadCurrentSenators actually produces via firstNameFromFullName('Warner, Mark R.'),
  // which drops the middle initial the same way it does for every other senator.
  const senators = [
    { legislator_id: 'leg-warner-mark', state: 'VA', last_name: 'Warner', first_name: 'Mark' },
    { legislator_id: 'leg-warner-john', state: 'VA', last_name: 'Warner', first_name: 'John' },
  ];
  const cast = { state: 'VA', last_name: 'Warner', first_name: 'Mark', party: 'D' };
  assert.equal(resolveSenator(cast, senators), 'leg-warner-mark');
});

// Real case from the live backfill (confirmed directly against the DB's terms/legislators rows):
// SC has both 'Graham, Lindsey' (current) and 'Graham, Darline' (also lacks an end date in our
// data) — surname-ambiguous even after ensureSenateMembers' isCurrentMember filter, since that
// filter operates on the raw congress.gov payload and can't fix a same-shaped duplicate there.
const GRAHAM_SC = [
  {
    legislator_id: 'leg-graham-lindsey', state: 'SC',
    last_name: lastNameFromFullName('Graham, Lindsey'), first_name: firstNameFromFullName('Graham, Lindsey'),
  },
  {
    legislator_id: 'leg-graham-darline', state: 'SC',
    last_name: lastNameFromFullName('Graham, Darline'), first_name: firstNameFromFullName('Graham, Darline'),
  },
];

test('resolveSenator tiebreaks the real Graham/SC ambiguity — Lindsey direction', () => {
  const cast = { state: 'SC', last_name: 'Graham', first_name: 'Lindsey', party: 'R' };
  assert.equal(resolveSenator(cast, GRAHAM_SC), 'leg-graham-lindsey');
});

test('resolveSenator tiebreaks the real Graham/SC ambiguity — Darline direction', () => {
  const cast = { state: 'SC', last_name: 'Graham', first_name: 'Darline', party: 'R' };
  assert.equal(resolveSenator(cast, GRAHAM_SC), 'leg-graham-darline');
});

test('resolveSenator returns null when still ambiguous after the first-name tiebreak (never guesses)', () => {
  // Two candidates that ALSO share a first name after folding — the tiebreak itself can't
  // disambiguate, so this must stay unresolved rather than pick one arbitrarily.
  const senators = [
    { legislator_id: 'leg-a', state: 'AK', last_name: 'Murkowski', first_name: 'Lisa' },
    { legislator_id: 'leg-b', state: 'AK', last_name: 'Murkowski', first_name: 'Lisa Marie' },
  ];
  const cast = { state: 'AK', last_name: 'Murkowski', first_name: 'Lisa', party: 'R' };
  assert.equal(resolveSenator(cast, senators), null);
});

test('resolveSenator returns null when the cast has no first_name to tiebreak with', () => {
  assert.equal(resolveSenator({ state: 'AK', last_name: 'Murkowski', first_name: '' }, MURKOWSKI_AK), null);
});

// ---- question-composition rule (design ruling #3) ----

test('finalizeSenateVote keeps a normal bill vote unchanged', () => {
  const vote = { question: 'On Passage of the Bill', bill_identifier: 'HR 5371' };
  const out = finalizeSenateVote(vote, 'H.R. 5371');
  assert.equal(out.bill_identifier, 'HR 5371');
  assert.equal(out.question, 'On Passage of the Bill');
});

test('finalizeSenateVote composes question with the menu issue when bill_id would be null', () => {
  const vote = { question: 'On the Cloture Motion', bill_identifier: null };
  const out = finalizeSenateVote(vote, 'PN373');
  assert.equal(out.bill_identifier, null);
  assert.equal(out.question, 'On the Cloture Motion — PN373');
});

test('finalizeSenateVote leaves question untouched when bill_id is null and there is no issue', () => {
  const vote = { question: 'On the Nomination', bill_identifier: null };
  const out = finalizeSenateVote(vote, null);
  assert.equal(out.bill_identifier, null);
  assert.equal(out.question, 'On the Nomination');
});

test('finalizeSenateVote links an amendment vote to its bill via the menu issue when the roll call document node is absent', () => {
  // Real case observed against live senate.gov data (vote 119-1-616): "On the Amendment" votes
  // have no <document> node in the roll-call XML (only passage votes do), so parseSenateRollCall
  // reports bill_identifier: null even though it's a real bill — the menu's issue carries it.
  const vote = { question: 'On the Amendment', bill_identifier: null };
  const out = finalizeSenateVote(vote, 'H.R. 5371');
  assert.equal(out.bill_identifier, 'HR 5371');
  assert.equal(out.question, 'On the Amendment'); // not composed — it resolved to a real bill
});

test('finalizeSenateVote nulls out a roll-call bill_identifier that is not a known bill type', () => {
  // e.g. a treaty document node that isn't HR/S/HRES/etc.
  const vote = { question: 'On the Resolution of Ratification', bill_identifier: 'TREATY 119-1' };
  const out = finalizeSenateVote(vote, 'PN9999');
  assert.equal(out.bill_identifier, null);
  assert.equal(out.question, 'On the Resolution of Ratification — PN9999');
});

test('isKnownBillIdentifier recognizes the congress.gov bill-type vocabulary and rejects nomination numbers', () => {
  assert.equal(isKnownBillIdentifier('HR 5371'), true);
  assert.equal(isKnownBillIdentifier('S 123'), true);
  assert.equal(isKnownBillIdentifier('PN373'), false);
  assert.equal(isKnownBillIdentifier(null), false);
});

// ---- isCurrentMember (fix round 2): the actual current-member signal in the raw congress.gov
// /member payload — endYear appears on a term item once, and only once, that term has ended.
// Round 1 wrongly claimed no endYear exists anywhere in this payload (sampled only the first few
// current-delegation fixture entries); re-review caught it against the fixture's OWN Bond/
// Carnahan rows, which do carry endYear. Tested here directly against those same real entries. ----

test('isCurrentMember filters out fully-historical members using the real fixture (Bond, Carnahan)', () => {
  const bond = membersJson.members.find((m) => m.name === 'Bond, Christopher S.');
  const carnahan = membersJson.members.find((m) => m.name === 'Carnahan, Jean');
  assert.ok(bond, 'fixture must contain Bond, Christopher S.');
  assert.ok(carnahan, 'fixture must contain Carnahan, Jean');
  assert.equal(isCurrentMember(bond), false);
  assert.equal(isCurrentMember(carnahan), false);
});

test('isCurrentMember keeps a currently-serving member using the real fixture (Hawley)', () => {
  const hawley = membersJson.members.find((m) => m.name === 'Hawley, Josh');
  assert.ok(hawley, 'fixture must contain Hawley, Josh');
  assert.equal(isCurrentMember(hawley), true);
});

test('isCurrentMember keeps a member whose ongoing term is not their FIRST term item (checks ANY, not just latest)', () => {
  // Synthetic but realistic: a past House term that has closed (endYear present) followed by an
  // ongoing Senate term (no endYear yet) — must still be kept, matching the doc comment's claim.
  const pastHouseNowSenate = {
    name: 'Example, Pat',
    terms: { item: [{ chamber: 'House of Representatives', startYear: 2015, endYear: 2019 }, { chamber: 'Senate', startYear: 2019 }] },
  };
  assert.equal(isCurrentMember(pastHouseNowSenate), true);
});

test('isCurrentMember returns false for a member with no term items at all', () => {
  assert.equal(isCurrentMember({ name: 'Nobody', terms: { item: [] } }), false);
});

// ---- supporting pure helpers used by ensureSenateMembers / loadCurrentSenators ----

test('lastNameFromFullName splits congress.gov "Last, First Middle" format', () => {
  assert.equal(lastNameFromFullName('Onder, Robert F.'), 'Onder');
  assert.equal(lastNameFromFullName('Hawley, Josh'), 'Hawley');
});

test('lastNameFromFullName falls back to the whole string when there is no comma', () => {
  assert.equal(lastNameFromFullName('Hawley'), 'Hawley');
});

test('firstNameFromFullName takes the first token after the comma, dropping middle initials', () => {
  assert.equal(firstNameFromFullName('Onder, Robert F.'), 'Robert');
  assert.equal(firstNameFromFullName('Warner, Mark R.'), 'Mark');
  assert.equal(firstNameFromFullName('Luján, Ben Ray'), 'Ben');
});

test('firstNameFromFullName returns empty string when there is no comma', () => {
  assert.equal(firstNameFromFullName('Hawley'), '');
});

test('stateAbbreviation converts congress.gov full state names to the USPS code Senate XML uses', () => {
  assert.equal(stateAbbreviation('Missouri'), 'MO');
  assert.equal(stateAbbreviation('new hampshire'), 'NH');
  assert.equal(stateAbbreviation('Nowhereland'), null);
  assert.equal(stateAbbreviation(null), null);
});

// ---- parseArgs: --source us-senate --session N [--votes M-N] ----

test('parseArgs reads us-senate options with an explicit --votes range', () => {
  const args = parseArgs(['--source', 'us-senate', '--session', '1', '--votes', '616-618']);
  assert.equal(args.source, 'us-senate');
  assert.equal(args.session, '1');
  assert.deepEqual(args.votes, [616, 617, 618]);
});

test('parseArgs omits votes for us-senate when --votes is not given (menu-driven backfill mode)', () => {
  const args = parseArgs(['--source', 'us-senate', '--session', '1']);
  assert.equal(args.source, 'us-senate');
  assert.equal(args.votes, undefined);
});

test('parseArgs accepts --dry-run alongside us-senate options at any position', () => {
  const args = parseArgs(['--source', 'us-senate', '--session', '1', '--votes', '616-618', '--dry-run']);
  assert.equal(args.dryRun, true);
});
