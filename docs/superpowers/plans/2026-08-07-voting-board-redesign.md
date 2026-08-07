# "The Voting Board" Site-Wide Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder styling with the approved "Voting Board" design system (spec: `docs/superpowers/specs/2026-08-07-voting-board-redesign-design.md`) across every page, both themes, with zero JS-behavior change.

**Architecture:** One rewritten `site/css/site.css` (custom-property tokens, dark default + light override), a shared header/nav + `<main>` container added to all six HTML shells, and class-level hooks in render code where components lack styling handles. Charts keep their CSSOM-width mechanism. CSP untouched.

**Tech Stack:** hand-written CSS (no build step, no frameworks, no font downloads), vanilla HTML shells, `node:test` suite as the regression gate, Playwright (via the reviewer/controller) for visual verification.

## Global Constraints

- **Spec §2 tokens are law** — copy the token table exactly (dark `:root` default, light via `@media (prefers-color-scheme: light)`; note this FLIPS the current file's polarity). Adjust a shade only to fix an AA contrast failure, staying in-hue, and say so in the report.
- **Every existing user-facing string stays byte-identical.** Restyle, never reword. The word "current" stays banned.
- **Zero JS behavior changes.** Render-code edits are class attributes only (`el()` already passes `class`). Pure models, wiring, fetch logic, and vote-charts' `element.style.width` mechanism untouched.
- **CSP byte-identical** — no inline styles, no external resources, `site/_headers` untouched.
- **Honesty rules (spec §6):** party chips neutral (never red/blue); green/red only for Yea/Nay facts; identical treatment for everyone.
- **A11y floor (spec §5):** AA contrast both themes; 2px `--focus-ring` outline (offset 2px) on every interactive element; `prefers-reduced-motion: reduce` disables transitions; the directory toggle keeps its `role="group"`/`aria-pressed` contract.
- **Visual truth:** the approved mockups at `F:\VisibleGov\.superpowers\brainstorm\1865-1786092743\content\visual-direction.html` (card A = directory) and `profile-and-light.html` (profile + light variant) — gitignored session artifacts; read them, match their look. The spec is authoritative where they differ.
- Tests: whole suite `node --test` in a clean shell (NEVER set SUPABASE_* env vars there), parse the runner's pass/fail summary lines, commit only on fail 0. Single-file runs use an explicit path; never a directory arg.
- ENVIRONMENT NOTE (this session): the Bash tool has a broken PATH — use the **PowerShell tool** for all commands (node/git work; PS 5.1: no `&&`, use `;`).
- Branch: `voting-board-redesign` off `main`; commit per task; do NOT push until integration.

---

### Task 1: The design system + shells (tokens, base, header, layout on every page)

**Files:**
- Rewrite: `site/css/site.css` (keep a `/* Voting Board design system (2026-08-07 spec) */` header comment; preserve any rule the pages still need but restate it in the new system — grep the old file for every class it styles and account for each)
- Modify: `site/index.html`, `site/person.html`, `site/legislator.html`, `site/bill.html`, `site/trust.html`, `site/404.html` (shared header + `<main class="board-main">` wrapper)

**Interfaces:**
- Produces: the token block (spec §2, verbatim), base typography, `.site-header` (wordmark `VISIBLE`+`GOV` with `.wordmark-accent`, nav links Directory · Trust), `.board-main` (max-width 880px, centered, `0 1rem` gutters), `.board-card` (surface+border+radius 8px), `.board-label` (amber uppercase letterspaced 11px/600), `.mono` (numeral stack + tabular-nums), `.lit-dot` utilities (`.lit-yea`/`.lit-nay`/`.lit-accent` with dark-only glow), focus-ring and reduced-motion rules. Tasks 2–3 style components ONLY with these primitives plus component-specific rules.

- [ ] **Step 1:** Read the spec §2–§3 + both mockup files + the current `site.css` in full. Inventory every class the old file styles (grep `class=` across `site/js/*.js` and `site/*.html` for consumers).
- [ ] **Step 2:** Rewrite `site.css`: token block verbatim → reset/base (body bg/fg/type, links underlined with `--accent` underline color, `::selection` amber) → `.site-header` (bottom `1px solid --border`, wordmark 15px/600/`.22em`, nav right, muted links) → `.board-main` → primitives (`.board-card`, `.board-label`, `.mono`, lit dots with `text-shadow: 0 0 8px` low-alpha in dark only) → restyled carryovers for every inventoried existing class (`.section-state*`, `.directory-*`, footer, rep-lookup classes, chart classes — flat restatements, low specificity, no behavior assumptions) → focus/motion rules last.
- [ ] **Step 3:** Add to each of the six shells, directly after `<body>`: the shared header (nav = `<a href="/">Directory</a> · <a href="/trust">Trust</a>`), and wrap existing page content in `<main class="board-main">…</main>` (404 keeps its JS-free simplicity — header + one line + link home).
- [ ] **Step 4:** `node --test` clean shell → fail 0 (site-modules tests guard the shells/CSP couplings).
- [ ] **Step 5:** Serve locally (`node scripts/serve-site.js`, background), fetch `/` and one shell, confirm 200 + header markup present; stop server.
- [ ] **Step 6:** Commit: `feat(design): Voting Board token system, base, header + shells (task 1)`.

### Task 2: Directory + address lookup treatment

**Files:**
- Modify: `site/css/site.css` (component rules), `site/js/directory-page.js` (class hooks only, if a component lacks one), `site/index.html` (only if a wrapper class is needed)

**Interfaces:**
- Consumes Task 1 primitives. Match mockup card A: toggle = control strip (border-radius 999px segmented, active segment `--accent` bg + `--accent-contrast` text, counts inside labels); search input on `--surface` with `--border`, muted placeholder; footnote `--faint` 11px; rows separated by `--border-faint`, name 600/14.5px, meta muted 12.5px, tenure fragment as `.mono .lit-yea` (`● since 2023` reading); row hover = `--surface` bg transition; address-lookup form/results as `.board-card`s, candidate date-evidence lines faint mono; ALL state messages restyled via existing `.section-state*` classes.

- [ ] **Step 1:** Style against the REAL rendered DOM: serve locally, view source/snapshot the directory, enumerate actual class names (`.directory-toggle`, `.directory-footnote`, `.directory-list/row/meta`, `.rep-*`, `#address-form` etc.), then write the rules. Add a class in JS only where a needed hook is missing (e.g., the tenure fragment may need its own `<span class="directory-since">` — acceptable class-only markup change inside `renderDirectoryList`'s meta construction, keeping the meta text content byte-identical… if splitting the string is required, keep the visible text identical).
- [ ] **Step 2:** `node --test` clean shell → fail 0 (directory-model tests pin meta/label strings — they must not break).
- [ ] **Step 3:** Local serve; verify against mockup A in BOTH themes (light via emulation); check focus rings + hover.
- [ ] **Step 4:** Commit: `feat(design): directory + address lookup on the board (task 2)`.

### Task 3: Profile, bill, trust, 404 treatments

**Files:**
- Modify: `site/css/site.css`; class hooks only (if needed) in `site/js/person-page.js`, `site/js/bill-page.js`, `site/js/vote-charts.js`, `site/js/render.js`

**Interfaces:**
- Consumes Task 1 primitives. Match the profile mockup: identity block (photo 64px rounded `--surface` frame, name 23px/650, muted meta, lit mono tenure line), `.board-label` section headings, aggregates as board strips (restyle the EXISTING chart bar classes: segment colors `--yea-bar`/`--nay-bar`/`--neutral-bar`, container `.board-card`, mono legends; widths still set by JS via CSSOM — do not touch), vote rows as card rows (bill+reading 600/13.5, date·source faint mono below, lit `● YEA`/`● NAY` right in mono), bill page = tally strip + cast rows on the same vocabulary, trust = prose + cards on tokens, 404 = board + wordmark + link.

- [ ] **Step 1:** Serve locally, snapshot a real profile + bill page, enumerate actual chart/list class names from `vote-charts.js`/`person-page.js`/`bill-page.js` and style those; add class hooks only where missing.
- [ ] **Step 2:** `node --test` clean shell → fail 0.
- [ ] **Step 3:** Local serve; verify profile mockup fidelity + bill/trust/404, both themes, focus/motion rules.
- [ ] **Step 4:** Commit: `feat(design): profile, bill, trust, 404 on the board (task 3)`.

### Task 4: Final review, merge, deploy, live walk (controller)

- [ ] Final whole-branch review (most capable model) with Playwright screenshots dark+light; fix wave if findings; suite green.
- [ ] Merge → push → Pages deploy → live browser walk: directory, a profile, a bill, trust, 404 — both themes, zero console errors, strings byte-identical (footnote, "(end date unrecorded)"), honesty rules visually confirmed (neutral party chips, green/red only on Yea/Nay).
- [ ] Docs sync (CHATLOG/TODO) + workspace cleanup.

## Self-Review

Spec coverage: §1–§2 tokens/type/signature → Task 1; §3 architecture → Tasks 1–3 file boundaries; §4 page treatments → Tasks 2–3; §5 motion/a11y → Task 1 rules + per-task verification; §6 honesty → Global Constraints + Task 4 walk; §7 testing/rollout → per-task gates + Task 4. Placeholders: none — component values come from the spec/mockups, and where the plan defers to "the real rendered DOM" it names the exact discovery step. Type consistency: primitive class names (`.board-main`, `.board-card`, `.board-label`, `.mono`, `.lit-*`) defined in Task 1 and consumed by name in Tasks 2–3.
