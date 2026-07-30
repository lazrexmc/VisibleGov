// site/js/freshness.js — how a public_freshness row is put into words. One copy, shared by both
// surfaces that render it: person-page.js's per-profile freshness box and trust-page.js's full
// table (the LOW-8/slugs.js precedent — a small pure module rather than either page importing the
// other's whole graph, and rather than two lookalike format strings that can drift).
//
// FINAL REVIEW, finding 4. public_freshness used to serve the NEWEST run per source, finished or
// not, so during every ingestion run the box said "last finished (never)" and showed zero
// quarantined days — two false facts, live, for the duration of every run. Migration 0019 splits
// the row into the two different questions it was conflating:
//   - finished_at / quarantined_days / last_finished_status: the latest run that ACTUALLY FINISHED
//   - status: the newest run's status, which may be 'running'
// so an in-flight run can be reported as in-flight WITHOUT erasing the last finished facts.
//
// PRE-APPLY FALLBACK (retires the moment Lance applies 0019): before the migration lands the view
// still returns the old four-column shape, where finished_at belongs to the newest run and is null
// while one is running. Rendering the new wording against those columns would state the new
// semantics over old data — so the shape is feature-detected on the row itself and the old wording
// is kept, with one honesty correction that costs nothing: a running row with no finished_at is
// "(unknown while a run is in progress)", never "(never)", because the old shape genuinely cannot
// tell those two apart. Delete `hasLatestFinishedShape`'s false branch and this paragraph once
// 0019 is applied and the probe confirms the new column set.

const IN_PROGRESS_TEXT = 'ingestion in progress';
const NEVER_FINISHED_TEXT = '(no completed runs)';

// Feature detection is on the COLUMN's presence, not on any value: 0019's last_finished_status is
// null for a source that has never finished, which is a real row, so `row.last_finished_status`
// being falsy proves nothing about the shape.
export function hasLatestFinishedShape(row) {
  return row != null && Object.prototype.hasOwnProperty.call(row, 'last_finished_status');
}

export function isIngestionRunning(row) {
  return row != null && row.status === 'running';
}

// The "Last finished" fact on its own — used as a table cell by the trust page.
export function lastFinishedText(row) {
  if (!hasLatestFinishedShape(row)) {
    if (row?.finished_at) return row.finished_at;
    return isIngestionRunning(row) ? '(unknown while a run is in progress)' : '(never)';
  }
  return row.finished_at || NEVER_FINISHED_TEXT;
}

// The "Status" fact on its own — used as a table cell by the trust page. Under the new shape the
// raw newest-run status is the honest answer, with the in-progress wording spelled out rather than
// left as jargon a reader has to decode.
export function statusText(row) {
  if (!hasLatestFinishedShape(row)) return String(row?.status ?? '');
  if (isIngestionRunning(row)) return `running — ${IN_PROGRESS_TEXT}`;
  return String(row?.status ?? '');
}

// Both facts as one sentence — used by the profile page's one-line-per-source box. A running
// source reads as in-progress ALONGSIDE its last finished date, never instead of it.
export function freshnessSentence(row) {
  if (!hasLatestFinishedShape(row)) {
    return `${row?.status ?? ''}, last finished ${lastFinishedText(row)}`;
  }
  const finished = row.finished_at
    ? `${row.last_finished_status ?? 'finished'}, last finished ${row.finished_at}`
    : NEVER_FINISHED_TEXT;
  return isIngestionRunning(row) ? `${finished} — ${IN_PROGRESS_TEXT}` : finished;
}
