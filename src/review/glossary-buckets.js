// Final-review finding 6 (IMPORTANT): the glossary review page's own computeGlossaryGroups
// (src/review/page.html) partitioned queue items with four INDEPENDENT .filter() calls, each
// re-scanning the full item list with its own predicate. That shape can silently drop a row: a
// clean-verified draft (past the 'flagged' filter, not yet 'approved') and an unverified-but-
// glossed draft (has_gloss=true, but no verification row yet) both matched NONE of the four
// predicates and vanished from every bucket AND every count — contradicting the function's own
// comment claiming "nothing from the total silently vanishes."
//
// This module is the canonical, Node-testable fix: ONE exhaustive if/continue chain, so every item
// lands in EXACTLY one bucket by construction (impossible to fall through all branches — the last
// branch has no condition left to fail). page.html has no bundler/import step (a plain <script>
// tag, not type="module"), so it cannot literally `import` this file — it hand-mirrors this exact
// logic instead, the same source-of-truth-duplication convention already used there for
// verificationBadge/glossVerificationBadge/TRANSITIONS (see page.html's own comments on those). This
// file is the one place the logic is actually unit-tested; keep the two in sync by hand.
//
// Bucket priority (checked in this order, first match wins):
//   1. published   — terminal state, the sample-for-audit pool.
//   2. approved     — pending Lance's publish click (a human already decided this one).
//   3. needsMapping — no resolved citation/source at all; distinct from a plain stub because there
//                     is a specific, different reason nothing can happen yet (no source to fetch).
//   4. stubs        — resolved citation, but Task 5's gloss stage hasn't run yet (no gloss_md).
//   5. flagged      — has a gloss AND the adversarial verifier flagged it — Lance's real queue.
//   6. cleanDraft   — has a gloss, verified clean, but trust-model-v3's auto-publish CLI (a
//                     separate cadence job) hasn't picked it up yet — "clean — awaiting
//                     auto-publish", per the controller ruling's own bucket name.
//   7. unverifiedGlossed — has a gloss, but no verification row exists yet at all (pipeline latency
//                     between gloss.js writing the gloss and its own verification landing).
// 'draft' and 'stale' status items are treated identically here (TRANSITIONS in src/review/
// server.js already gives both the same legal actions) — a stale item still falls through to
// whichever of buckets 3-7 actually describes it, never a separate 9th bucket of its own.
export function computeGlossaryBuckets(items) {
  const published = [];
  const approved = [];
  const needsMapping = [];
  const stubs = [];
  const flagged = [];
  const cleanDraft = [];
  const unverifiedGlossed = [];

  for (const it of items) {
    if (it.status === 'published') { published.push(it); continue; }
    if (it.status === 'approved') { approved.push(it); continue; }
    if (it.needs_mapping) { needsMapping.push(it); continue; }
    if (!it.has_gloss) { stubs.push(it); continue; }
    if (it.verified === 'flagged') { flagged.push(it); continue; }
    if (it.verified === 'clean') { cleanDraft.push(it); continue; }
    unverifiedGlossed.push(it);
  }

  return {
    published, approved, needsMapping, stubs, flagged, cleanDraft, unverifiedGlossed,
  };
}
