### Task 4: summary-parse — one shared parser, one-liner extraction

**Files:**
- Create: `site/js/summary-parse.js`
- Modify: `src/cli/verify.js` (parseBullets moves out; re-import + re-export from the new file so existing consumers/tests are untouched)
- Test: `tests/summary-parse.test.js`

**Interfaces:**
- Produces (in `site/js/summary-parse.js`, imported by BOTH the browser and `src/cli/verify.js` — one copy, no build step; Node imports across directories fine):
  - `parseBullets(bodyMd)` → `[{index, point, section}]` — MOVED VERBATIM from `src/cli/verify.js:37` including its comment block. Not reformatted, not "improved".
  - `extractStatedPurpose(bodyMd)` → string | null — the line starting `**Stated purpose (from the bill):** ` (exact prefix, the renderMarkdown contract), prefix stripped, trimmed; null when absent.
  - `extractOneLiner(bodyMd)` → string | null — `extractStatedPurpose(...) ?? parseBullets(...)[0]?.point ?? null`. This is the spec §3 mechanical one-liner: stated purpose when non-empty, else first bullet point, else null (render title-only).

- [ ] **Step 1: TDD** — failing tests: a real body_md fixture (purpose + 3 bullets) → one-liner is the purpose; purpose-less fixture → first bullet point; empty/garbage → null; `parseBullets` behavior pinned by two cases copied from the existing verify tests (sections containing parentheses split on LAST ` (`). Run: `node --test` — FAIL on the new file.
- [ ] **Step 2: Move + implement.** `src/cli/verify.js` becomes `import { parseBullets } from '../../site/js/summary-parse.js'; export { parseBullets };` — its `countRawBulletLines` and everything else stays put.
- [ ] **Step 3: FULL suite green** (this proves the move broke no verifier consumer), commit — `git commit -m "feat: shared summary parser + mechanical one-liner extraction (verify.js re-imports)"`

