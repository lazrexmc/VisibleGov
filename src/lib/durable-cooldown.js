// src/lib/durable-cooldown.js — the ToU-cooldown primitives shared by ingest-mo-house.js and
// ingest-mo-senate.js (character-identical in both files before this move — senate's own comment
// said "ported from ingest-mo-house.js... behavior here is intentionally identical"), and also
// depended on by scripts/scheduled-ingest.js for ALL FIVE registry sources' due-ness computation,
// not just MO House/Senate. Promoted here (senior engineering audit, 2026-08-03, finding 17):
// the production scheduler importing ToU-compliance logic from a 1,322-line CLI file (previously
// ingest-mo-senate.js) meant a fix applied to only ONE chamber's copy would silently not govern
// the scheduler's own due-ness decisions for that source — the two copies' text had already begun
// drifting (a chamber-specific quarantined-day set existed on one copy but not the other) with no
// mechanical check that the trio itself stayed identical. Living in src/lib makes "the same trio,
// used identically everywhere" the only possible state, not a convention three files had to
// maintain by hand.
//
// Deliberately NOT promoted here: each CLI's own enforceDurableCooldown wrapper (the query
// function inside it is genuinely source-specific — 'mo-house-xml' vs 'mo-senate-web' — and each
// file's own default minIntervalMs differs too) and the quarantine/done-marker machinery (also
// genuinely chamber-specific, different artifact shapes and keying). Only the three primitives
// below were ever byte-identical between the two files.

// Pure + testable without a DB: given the most recent run's started_at (ISO string) and the
// required minimum interval, how much longer must we wait (0 if the cooldown has elapsed, or if
// there is no prior run at all).
export function remainingCooldownMs(lastStartedAtIso, minIntervalMs, now = Date.now()) {
  if (!lastStartedAtIso) return 0;
  const elapsed = now - new Date(lastStartedAtIso).getTime();
  return Math.max(0, minIntervalMs - elapsed);
}

export function formatCooldownWait(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}m ${secs}s`;
}

// A typed, dedicated error for a durable-cooldown convergence loop's "never converged" case —
// never mistaken for a plain lookup-failed Error, and carries the iteration count for debugging.
// Thrown only if a cooldown-wait loop truly never converges, which per each CLI's own
// enforceDurableCooldown comment should be impossible under normal operation.
export class CooldownConvergenceError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'CooldownConvergenceError';
    Object.assign(this, meta);
  }
}
