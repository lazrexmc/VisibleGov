// src/lib/mo-status-codes.js — MO bill status vocabulary (LegiScan's numeric status codes -> their
// printed words). Promoted out of src/cli/correct-data.js (senior engineering audit, 2026-08-03,
// finding 16): correct-data.js, ingest-legiscan.js, and backfill-mo-bill-meta.js all need this
// same lookup, and correct-data.js -> ingest-legiscan.js -> ingest-mo-senate.js -> correct-data.js
// formed a genuine 3-node import cycle over it — safe today only because every cyclic binding
// happened to be used inside function bodies rather than at module top level, but empirically
// demonstrated (via an exact-shape replica) to produce an entry-point-dependent TDZ crash the
// moment that stops being true. Living in src/lib (imported by, never importing from, any
// src/cli/*.js file) makes that class of cycle structurally impossible for this vocabulary.

// MO_STATUS_WORD_MAP — SOURCED, not invented: LegiScan API User Manual, page 42
// (tests/fixtures/research/legiscan/LegiScan_API_User_Manual.pdf), "Status / Progress" table.
// LegiScan encodes bill status as an integer and prints NO word anywhere in the dataset itself —
// decoding it against the source's own published codebook is exactly the same class of operation
// as VOTE_ID_MAP (legiscan-votes.js, 1->yea): decoding a documented lookup, never editorializing.
//
// Deliberately excludes 0 and 7-12 (see MO_STATUS_UNMAPPED_CODE / MO_STATUS_PROGRESS_ONLY_CODES
// below) — those two are NOT eligible to ever be written to bills.status by this module.
export const MO_STATUS_WORD_MAP = {
  1: 'Introduced',
  2: 'Engrossed',
  3: 'Enrolled',
  4: 'Passed',
  5: 'Vetoed',
  6: 'Failed',
};

export const MO_STATUS_MAPPED_CODES = Object.keys(MO_STATUS_WORD_MAP).map(Number);

// MO_STATUS_UNMAPPED_CODE — 0 = "N/A (pre-filed / pre-introduction)" per the manual. No honest
// single word exists for it (the live site already omits a status word for these bills) — left
// untouched by design, only ever COUNTED (leftUntouchedZero), never written.
export const MO_STATUS_UNMAPPED_CODE = 0;

// MO_STATUS_PROGRESS_ONLY_CODES — 7-12 (Override/Chaptered/Refer/Report Pass/Report DNP/Draft) are
// documented by the manual as "Progress array only" — NOT a bill's overall status. If any of these
// somehow appear in bills.status, that is itself a data anomaly worth surfacing
// (unexpectedMappedCode) — but this module never guesses a word for a code the manual says isn't a
// status; those rows are left untouched too.
export const MO_STATUS_PROGRESS_ONLY_CODES = [7, 8, 9, 10, 11, 12];

// mapMoStatusCode — the same lookup every writer of bills.status (ingest-legiscan.js,
// backfill-mo-bill-meta.js, correct-data.js's own mo-status correction) should route through, per
// the original data-corrections brief's "fix the writer too" requirement — one exported constant/
// function, not a second copy of this table anywhere.
export function mapMoStatusCode(code) {
  return MO_STATUS_WORD_MAP[code] ?? null;
}
