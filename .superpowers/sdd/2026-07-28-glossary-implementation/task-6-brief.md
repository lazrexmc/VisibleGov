### Task 6: Review server glossary queue

**Files:** Modify `src/review/server.js`, `src/review/page.html`; tests
- New section/tab: glossary drafts + their verification strips + needs_mapping list; approve/reject/publish with the same gated-transition pattern (draft→approved→published; publish requires approved); decisions logged (reuse summary_notes? FK mismatch — glossary_notes table in 0007 OR a generic notes table... RULING: add `glossary_notes` to 0007, same shape as summary_notes). Same CSRF guard applies (existing isAllowedDecisionRequest covers new POST route via the same origin/content-type rules — extend the route allowlist).
- Escaping discipline: gloss text + quotes render via textContent/escaped renderer (model output).
- [ ] TDD transitions/pure parts → implement → green → smoke (0007-gated paths degrade gracefully pre-apply) → commit.


## CONTROLLER RULINGS (binding, appended)

1. The plan's mid-text RULING stands resolved: glossary_notes already exists in migration 0007 (Task 1 included it) — use it; do NOT add tables or migrations this task. 0007 has since been amended (nullable source_url/source_hash, published-completeness CHECK, supported_by_quote column) — read the CURRENT file, not the plan's description of it.
2. Glossary transitions mirror summaries exactly: draft→approved→published (+rejected), publish requires approved, same TRANSITIONS-table pattern. The DB-level published-completeness CHECK will reject publishing a bare stub — surface that error honestly in the UI response, don't pre-filter it away silently (the queue SHOULD only offer publish on glossed+verified terms, but if the constraint fires anyway, show the DB error).
3. Display per term: term, kind, citation (or needs_mapping badge), gloss_md, supported_by_quote (labeled as the author model's claimed supporting quote), source_url link, verification strip derived from glossary_verifications rows (same mechanical overall derivation display as summaries — latest verification per term wins), decision notes via glossary_notes.
4. The Background label string, exactly: "Background — from the referenced law's official text" — show it on the glossary tab so review context matches what the public site will say.
5. Escaping: ALL model-authored text (gloss_md, supported_by_quote, term, evidence quotes) renders via textContent/the existing escaped-render discipline. No innerHTML with model output.
6. Graceful degradation: pre-0007 (missing relations) the glossary tab renders an honest "migration 0007 not applied" state, never a 500 (isMissingRelationError pattern; the review server must keep working for the existing 22 summary drafts regardless).
