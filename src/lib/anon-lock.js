// src/lib/anon-lock.js — the ONE definition of "is this relation genuinely revoked for anon?"
//
// WHY THIS MODULE EXISTS (2026-08-29). This predicate lived in two places — scripts/
// verify-migrations.mjs's anonRevoked() and an inline expression in scripts/probe-public-surface.js
// — and they disagreed twice in a single day:
//
//   * on `200 []`: the probe accepted it as "locked" while anonRevoked correctly called it ABSENT.
//     That is the exact policy-only signature migrations 0036/0037 exist to remove, and the weaker
//     of the two files is the one an operator runs right after applying a migration.
//   * on `404`: added to the probe's accept set at 12:35 and removed at 19:14 the same day.
//
// The first attempt at a fix was a test asserting the two agreed. That test was theatre: it compared
// the probe's predicate against a HAND-COPIED closure written in the test file, so verify-migrations
// could still change silently — and the copy was not even faithful (the real one matches /42501/
// against raw response TEXT; the copy matched it against JSON.stringify of a PARSED body, which
// differ for any non-string payload). A test that two copies agree cannot bind a third party it
// does not import.
//
// So the copies are gone instead. There is one function, both callers import it, and it is unit
// tested directly. Two probes cannot drift when there is only one predicate.
//
// (verify-migrations.mjs cannot simply export it: that file executes its whole probe at module
// scope and ends in process.exit(), so importing it from a test would run the network probe and
// then kill the test process. Hence a separate module rather than an export added there.)

// Body may arrive as raw text (verify-migrations.mjs's rest() returns res.text()) or as an
// already-parsed value (probe-public-surface.js's rows() returns res.json()). Normalising here is
// deliberate: making each caller pre-format its body is how the two implementations drifted in the
// first place.
function bodyText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// THREE states, because collapsing them caused both historical bugs:
//
//   'locked'      401 / 403 / a 42501 (insufficient_privilege) body. The privilege is genuinely
//                 gone. This is the ONLY passing state.
//   'exposed'     200 of ANY shape. `200 []` is NOT locked — the grant is still live and only a
//                 missing RLS policy is holding the door, one toggle from open.
//   'unexplained' anything else: 404 (not in PostgREST's schema cache), 400 (a malformed request
//                 that never reached a privilege check — e.g. naming a column that does not exist,
//                 which is how the legiscan_datasets check silently tested nothing for weeks),
//                 5xx. NOT a pass, and NOT the same finding as an exposed table: it means the
//                 probe could not determine the answer, and saying "the grant is still live" would
//                 send an operator hunting a grant that may not exist.
export function anonLockState(status, body) {
  if (status === 401 || status === 403) return 'locked';
  if (/42501/.test(bodyText(body))) return 'locked';
  if (status === 200) return 'exposed';
  return 'unexplained';
}

// Convenience for callers that only need the boolean (verify-migrations.mjs's applied/absent axis).
export function isRevokedResponse(status, body) {
  return anonLockState(status, body) === 'locked';
}

// ---------------------------------------------------------------------------
// The RPC case — a DIFFERENT question with a different correct answer on 404.
//
// This lives beside anonLockState deliberately, rather than in the caller, so the divergence is
// visible and deliberate instead of looking like the drift this module exists to prevent. The two
// were nearly merged during a review because they share a 42501 test; merging them would have been
// a real bug.
//
// A TABLE that answers 404 is UNEXPLAINED — the relation is missing from PostgREST's schema cache
// and we cannot tell whether the grant was revoked, so it must not pass a lock check.
//
// A FUNCTION that answers 404 IS denied — PostgREST does not expose an RPC the calling role has no
// EXECUTE on, so 404 is exactly what a successful revoke looks like. Requiring 401 here would
// report a correctly-revoked function as still exposed.
//
// And the state that matters most, from migration 0038: a 400 carrying `0A000 cannot display a
// value of type event_trigger` means anon STILL HAS EXECUTE — PostgREST got far enough to try
// serialising the return value and choked on the pseudo-type. That is a serializer accident, not a
// privilege. Reading it as "denied" would report an unapplied migration as applied, which is the
// precise false-negative verify-migrations.mjs exists to prevent.
export function anonRpcState(status, body) {
  if (status === 404 || status === 401 || status === 403) return 'denied';
  if (/42501/.test(bodyText(body))) return 'denied';
  return 'callable';
}

export function isRpcDeniedResponse(status, body) {
  return anonRpcState(status, body) === 'denied';
}
