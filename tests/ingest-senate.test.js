import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli/ingest.js';
import {
  resolveSenator, finalizeSenateVote, isKnownBillIdentifier,
  lastNameFromFullName, stateAbbreviation,
} from '../src/adapters/us-senate.js';

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

// ---- supporting pure helpers used by ensureSenateMembers / loadCurrentSenators ----

test('lastNameFromFullName splits congress.gov "Last, First Middle" format', () => {
  assert.equal(lastNameFromFullName('Onder, Robert F.'), 'Onder');
  assert.equal(lastNameFromFullName('Hawley, Josh'), 'Hawley');
});

test('lastNameFromFullName falls back to the whole string when there is no comma', () => {
  assert.equal(lastNameFromFullName('Hawley'), 'Hawley');
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
