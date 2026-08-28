// voteDateDerivedNote — the receipt for a vote date the source never printed.
//
// Guards migrations 0032/0035 and the profile-page render. The rule this file exists to pin is the
// one receipts.js states for every function in it: read a stored field, render it verbatim, and
// return null rather than guess. A partial or invented receipt is worse than no receipt, because
// the whole point of the line is that the reader can check it.
//
// The payload shape asserted here is REAL, copied from a live row (2026-08-28, service read):
//   vote 904a7860-8e25-4a25-a915-1869f9732b50, vote_date 2024-03-28.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { voteDateDerivedNote } from '../site/js/receipts.js';

const LIVE_ROW = {
  vote_date: '2024-03-28T00:00:00+00:00',
  vote_date_provenance: {
    action: {
      date: '2024-03-28',
      action: 'Third Read and Passed (H) - AYES: 109 NOES: 36 PRESENT: 3',
      chamber: 'H',
      chamber_source: 'action_suffix',
    },
    source: 'legiscan_history_tally_match',
    printed_date: '0000-00-00',
    legislative_day: 48,
  },
};

test('renders the source action verbatim, with its date and legislative day', () => {
  const note = voteDateDerivedNote(LIVE_ROW);
  assert.ok(note, 'a live provenance row must produce a note');
  assert.match(note, /Date not printed on this roll call/);
  assert.match(note, /2024-03-28/);
  // Verbatim, tally included — a reader matches this string against the bill's printed history.
  assert.ok(
    note.includes('Third Read and Passed (H) - AYES: 109 NOES: 36 PRESENT: 3'),
    'the action text must appear verbatim, not reworded or truncated',
  );
  assert.match(note, /legislative day 48/);
});

test('renders nothing for the overwhelming majority — a printed date has no provenance', () => {
  // 10,010 of 10,195 votes measured 2026-08-28. The column is NULL for every one of them.
  assert.equal(voteDateDerivedNote({ vote_date: '2024-03-28T00:00:00+00:00' }), null);
  assert.equal(voteDateDerivedNote({ vote_date_provenance: null }), null);
  assert.equal(voteDateDerivedNote(null), null);
  assert.equal(voteDateDerivedNote(undefined), null);
});

test('omits the legislative day when the driver did not record one (0032: nullable by design)', () => {
  const row = {
    vote_date_provenance: { ...LIVE_ROW.vote_date_provenance, legislative_day: null },
  };
  const note = voteDateDerivedNote(row);
  assert.ok(note);
  assert.doesNotMatch(note, /legislative day/, 'no day recorded means no day clause, not "day null"');
});

test('returns null for an UNRECOGNISED derivation source — fail closed, never guess', () => {
  // A new source value means a derivation rule this function has not been taught. Printing the
  // payload anyway would present evidence whose meaning we do not know.
  const row = {
    vote_date_provenance: { ...LIVE_ROW.vote_date_provenance, source: 'some_future_rule' },
  };
  assert.equal(voteDateDerivedNote(row), null);
});

test('returns null when the evidence itself is incomplete', () => {
  const noDate = {
    vote_date_provenance: {
      ...LIVE_ROW.vote_date_provenance,
      action: { ...LIVE_ROW.vote_date_provenance.action, date: '' },
    },
  };
  const noText = {
    vote_date_provenance: {
      ...LIVE_ROW.vote_date_provenance,
      action: { ...LIVE_ROW.vote_date_provenance.action, action: '   ' },
    },
  };
  const noAction = {
    vote_date_provenance: { source: 'legiscan_history_tally_match', printed_date: '0000-00-00' },
  };
  assert.equal(voteDateDerivedNote(noDate), null, 'no action date = no receipt');
  assert.equal(voteDateDerivedNote(noText), null, 'no action text = no receipt');
  assert.equal(voteDateDerivedNote(noAction), null, 'no action object = no receipt');
});

test('a non-object payload is refused rather than coerced', () => {
  assert.equal(voteDateDerivedNote({ vote_date_provenance: 'legiscan_history_tally_match' }), null);
  assert.equal(voteDateDerivedNote({ vote_date_provenance: 42 }), null);
});
