// src/lib/pdf-basename.js — journalPdfBasename, promoted out of src/cli/ingest-mo-senate.js
// (senior engineering audit, 2026-08-03, finding 16 — dissolves a genuine 3-node import cycle
// ingest-mo-senate.js was part of: correct-data.js imported this straight from ingest-mo-senate.js,
// which imported SPECIAL_IDENTIFIER_PATTERN from ingest-legiscan.js, which imported
// mapMoStatusCode from correct-data.js). Living in src/lib (imported by, never importing from, any
// src/cli/*.js file) makes that class of cycle structurally impossible for this helper.

// ---- source_key (CONTROLLER RULING 1) ----
//
// day_label ("Day 37") is NOT unique within a year — 2018's Veto Session reuses "Day 01" (12
// duplicate labels in the real fixture, per progress.md). The journal PDF URL's own basename
// (e.g. RDay370308587-610.pdf -> RDay370308587-610) is reviewer-verified unique per year and is
// the day segment of source_key; journal_url is identity, day_label is display-only. Also used for
// a local --journal-pdf-file path in dry-run mode (no journal_url available there at all).
export function journalPdfBasename(urlOrPath) {
  const clean = String(urlOrPath).split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() ?? clean;
  return base.replace(/\.pdf$/i, '');
}
