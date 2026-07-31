# Bulk adjudication -> full automation (trust model v3 mechanism 2) — report

**Status:** Done, except the one step that requires Lance's own hands: the live (non-dry-run)
execution of the new CLI against the production DB. That was blocked twice, consistently, by the
sandbox's auto-mode permission classifier as a live-DB-mutating action outside this session's
authority — not a bug, and not something I attempted to route around per the tool-use policy on
denied actions. Everything else (code, tests, commit, a live `--dry-run` proof against the real
DB, and a full manual UI verification against the real DB) is complete and green.

**Commit SHA:** `1af17416cc9e9d130c76c421ccf42ff8797d8b7e` (branch `mo-senate-adapter`)

**Test summary:** `node --test` → 579/579 pass (563 baseline + 16 new: 14 in
`tests/auto-publish-glossary-cli.test.js`, 2 in `tests/review-logic.test.js`). No regressions.

## What shipped (superseded mid-task by Lance's own design change to full automation)

- `src/cli/auto-publish-glossary.js` (new) — `npm run auto-publish:glossary`. Selects
  `glossary_terms` rows with `status='draft'`, a gloss, `needs_mapping=false`, and whose latest
  `glossary_verifications` row derives `'clean'` via the SAME mechanical badge derivation the
  review page itself uses (`glossVerificationBadge`/`latestVerificationByTerm`, reused unchanged
  from `src/review/server.js`) — flagged, unverified, and needs_mapping rows are never eligible.
  Each eligible term transitions `draft -> approved -> published` via the existing `nextStatus`
  rules, writing one `glossary_notes` row per hop. `action` stays inside migration 0007's existing
  CHECK (`'approved'`/`'published'` — no schema change needed); the "auto" distinction lives in the
  note text (`"trust-model v3: clean adversarial verification (<verifier model>),
  auto-approved"` / `"...auto-published"`). The publish hop's
  `glossary_terms_published_complete` CHECK (23514) is the final wall — a violation there is
  recorded per-item and never aborts the batch (the approve hop and its note are left standing,
  an honest partial state). Zero model calls, zero external fetches — pure DB reads/writes, so no
  spend-approval gate applies.
- `src/review/server.js` — `/api/glossary/queue` now also includes `status='published'` rows (a
  new `GLOSSARY_QUEUE_STATUSES` constant; summaries' own `QUEUE_STATUSES` is untouched) so the
  review page can show published counts and let the sample-audit feature pull from them. No other
  server changes — no new POST route (the original brief's bulk buttons were dropped per the
  design change, since the CLI now owns that job entirely).
- `src/review/page.html` — glossary tab reworked around a flagged-first presentation: **Flagged —
  needs review** and **Approved — pending publish** groups are shown expanded by default (both
  genuinely need Lance's action); **Pending stubs** (no gloss yet / needs_mapping) and
  **Published** are reachable behind their own toggle buttons with honest live counts
  (`"N flagged · N approved (pending publish) · N published · N pending stubs"`). The
  **"Sample 5 published for audit"** button replaces the original bulk-approve flow — client-side
  random pick from the in-memory published list, each rendered expanded (gloss +
  `supported_by_quote` + source link) via `/api/glossary/item/:id` (no server change needed, that
  route already returns full detail for any status). All model/user text stays `textContent`-only
  (escaping discipline unchanged, verified by extracting and `node --check`-ing the inline script).

## Live verification against the real DB (migrations 0007/0009 applied)

- `node --env-file=.env src/cli/auto-publish-glossary.js --dry-run` (read-only, ran successfully):
  **397 draft terms · 30 eligible · 2 flagged/unverified (untouched) · 282 needs_mapping-skipped ·
  83 no-gloss-skipped.** (The coordinator's ~34/2 estimate was in the right neighborhood; 30 is the
  real number.)
- Full manual UI pass with a live review server against the real DB (Playwright): Glossary tab
  correctly showed `"2 flagged · 0 approved (pending publish) · 4 published · 365 pending stubs"`
  (4 published rows already existed in the DB from prior work), flagged item detail rendered
  correctly with its verifier-flag reasoning, both toggles worked (stub toggle verified — label
  and select contents updated, current selection preserved), and "Sample 5 published for audit"
  correctly pulled and rendered all 4 real published items with gloss/quote/source link.
- **Live (non-dry-run) run was NOT executed.** Two consecutive attempts at
  `node --env-file=.env src/cli/auto-publish-glossary.js` were denied by the sandbox's auto-mode
  classifier ("Blocked by classifier" — a live-database-mutating action). Per the tool-use policy
  on denials, I did not attempt to route around it. This is also consistent with trust model v2/v3:
  an agent-relayed instruction is not the same as Lance's own click, and publishing 30 items to the
  public-facing glossary is exactly the kind of consequential action that should go through his own
  hands or explicit interactive approval, not an automated pipeline's say-so.
  **Lance: run `npm run auto-publish:glossary` (or `node --env-file=.env
  src/cli/auto-publish-glossary.js`) yourself when ready — the dry-run above already proves it will
  find 30 eligible and publish them, 2 flagged items untouched.**

## Concerns / notes for Lance

1. **The live run is still outstanding** — see above. Nothing is broken; it just needs your own
   hands on it per the permission boundary.
2. Real eligible count (30) came in a bit under the ~34 estimate in the design-change message —
   2 flagged + 282 needs_mapping + 83 no-gloss account for the rest of the 397 drafts; nothing
   looked wrong in the dry-run output, just a more precise number than the earlier guess.
3. I found and killed an orphaned `node` process already bound to port 8991 (stale review-server
   instance from earlier today) in order to verify the UI changes against a fresh server — it was
   local-only (127.0.0.1) and clearly this same project's dev server, not anything else.
4. The original bulk-decision HTTP route/buttons from the pre-design-change brief were never built
   (the design change arrived before I'd written any server route code) — nothing to clean up
   there, and CSRF/bulk-route tests from the original brief were dropped accordingly since there's
   no new route to guard.
5. Trust model v3 (`docs/superpowers/specs/2026-07-28-trust-model-v3-design.md`) is still marked
   "DRAFT, awaiting Lance's approval" at the top of that file — worth a formal status update there
   now that mechanism 2 (in its full-automation form) actually shipped in code, if you're happy
   with the direction.
