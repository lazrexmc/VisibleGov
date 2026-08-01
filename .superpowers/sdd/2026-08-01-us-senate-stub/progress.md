# SDD ledger — us-senate not-yet-published hotfix (2026-08-01, overnight)

Defect: scheduler's hourly us-senate probe crashed (TypeError) on not-yet-cast vote numbers —
senate.gov returns HTTP 200 + fixed HTML stub ("Roll Call Vote Unavailable"), never 404, so
!res.ok passed it to the XML parser (rootless tree, no throw, crash on first field access).

Fix (31dc3b3, implementer sonnet): RollCallNotYetPublishedError extends SourceFetchError for the
byte-verified stub template ONLY; any other rootless payload throws a plain loud non-SourceFetchError.
Fixture: tests/fixtures/us-senate/roll-call-unavailable.html (raw scrape, hash-identical across 3
vote numbers). 3 red-first tests. Suite 2092/0.

Review (sonnet): SHIP, no Critical/Important. Mechanically verified: revert-reproduced the exact
TypeError; mutation-tested the guard (loosening it fails test 2); 15+ adversarial payloads (500s,
CAPTCHA, truncation, JSON) — zero misclassified as expected-miss; collectUsSenate + scheduler +
us-congress byte-identical to parent. Minors accepted: (1) mid-transfer truncation still
hard-crashes loudly (pre-existing, fails safe); (2) stub predicate coupled to current wording —
template change = noisy safe-direction failures; (3) ledger created post-hoc (this file).

Implementer disclosures accepted: 7 limiter-spaced capture requests instead of 1 (vote 211 had
been published by fix time — frontier probed to find the real stub); catch-loop verified by
reading (pre-existing code, unchanged).
