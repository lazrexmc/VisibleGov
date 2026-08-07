# Site-wide visual redesign — "The Voting Board" — design

**Status:** approved design (Lance, 2026-08-07 — direction chosen from three live mockups in the
visual companion: "A"; light-mode policy chosen: "A — Auto"; design presentation approved: "yes").
**Origin:** Lance, 2026-08-06 — *"functionable… but absolutely elementary and look like shit… old
school beginning geocities type layout. We need to clean this up and make it much more usable and
enjoyable while asthetically pleasing."*
**What was approved visually:** three direction mockups on the real directory page, then the chosen
direction extended to a full legislator-profile mockup plus a light-mode A/B. The mockups lived in
the (gitignored) brainstorm session; this spec is the standalone record of what they showed.

---

## 1. The identity

**"The Voting Board"** — the design language of the chamber's own electronic tally board: dark
housing, names in lit rows, one amber "rostrum light" accent, monospace numerals for every count.
The site reads as *the record, lit up* — stately, not gamer; generous spacing and muted glow keep
it civic.

Two themes, honoring each visitor's `prefers-color-scheme` exactly as the site does today:

- **Dark (the identity):** the board itself.
- **Light ("the gallery"):** the same language rendered on daylight paper — warm off-white walls,
  the same amber, the same lit-dot vocabulary, deepened colors for contrast.

## 2. Design tokens (the custom-property system)

One rule set, themed entirely through CSS custom properties on `:root` +
`@media (prefers-color-scheme: light)` override (dark is the `:root` default — dark is the
identity; the current file's light-default/dark-override polarity flips).

| Token | Dark (default) | Light ("gallery") |
|---|---|---|
| `--bg` (page) | `#14161b` | `#f5f4f1` |
| `--surface` (cards/rows) | `#1b1e25` | `#ffffff` |
| `--border` | `#2a2e37` | `#ddd9d2` |
| `--border-faint` (row separators) | `#232732` | `#e8e5df` |
| `--fg` | `#e8ebf1` | `#23262d` |
| `--muted` | `#8b93a3` | `#5c6472` |
| `--faint` | `#6d7484` | `#8a8f99` |
| `--accent` (amber rostrum light) | `#d9a441` | `#8a6318` |
| `--accent-contrast` (text on accent) | `#14161b` | `#ffffff` |
| `--yea` (text/dot) | `#9fd9a3` | `#2e7d3f` |
| `--yea-bar` | `#3f7d4a` | `#4c9a5f` |
| `--nay` (text/dot) | `#d98f8f` | `#a83c3c` |
| `--nay-bar` | `#8c3b3b` | `#c25454` |
| `--neutral-bar` (absent/other) | `#3a3f4b` | `#d5d8dd` |
| `--link` | `#e8ebf1` underline `--accent` | `#23262d` underline `--accent` |
| `--focus-ring` | `#d9a441` | `#8a6318` |

Contrast floor: every fg/bg pair above must meet WCAG AA (4.5:1 body, 3:1 large/UI); the
implementation verifies the pairs and adjusts a shade where needed rather than shipping a failure
(adjusting stays within the named hue).

**Type:**
- UI/display: `system-ui, "Segoe UI", -apple-system, sans-serif`. Wordmark + section labels:
  600 weight, uppercase, letterspaced (`.18em`–`.22em`).
- Numerals & receipts: `Consolas, "Cascadia Mono", Menlo, monospace` with
  `font-variant-numeric: tabular-nums` wherever counts/dates align in columns.
- Body 16px base, 1.55 line-height; display sizes step 23/19/15/13.5/12/11 per the mockups.
- **No font downloads** — system stacks only; CSP untouched.

**Signature elements (the memorable, repeated vocabulary):**
- The **lit indicator**: a `●` dot in `--yea`/`--nay`/`--accent` for vote positions and
  serving-status lines (e.g. `● serving — since 2023-01-04 (end date unrecorded)`), with a subtle
  glow (`text-shadow`/`box-shadow`, amber or green, low alpha) in dark; glow omitted in light.
- **Board strips**: tally/aggregate bars as flat segmented strips (`--yea-bar`/`--nay-bar`/
  `--neutral-bar`), slight inner glow in dark, mono tabular legends beneath.
- **Amber section labels**: uppercase letterspaced (`POSITION DISTRIBUTION`, `RECORDED VOTES`,
  `SERVING NOW`) in `--accent`, 600 weight, ~11px.
- The **wordmark**: `VISIBLE` in `--fg` + `GOV` in `--accent`, letterspaced `.22em`.

## 3. Architecture — where the work happens

- **`site/css/site.css` is rewritten** (the 396-line "placeholder base styles" scaffold becomes
  the real system). Single file, custom-property themed, mobile-responsive (single column;
  max-width container ~880px centered, `padding: 0 1rem` gutters).
- **HTML shells** (`index.html`, `person.html`, `legislator.html`, `bill.html`, `trust.html`,
  `404.html`) gain a shared site header (wordmark linking `/`, nav links Directory · Trust) and
  a `<main class="board">` container wrapper; otherwise structural markup is preserved.
- **Render-code touches are class-level only:** `el()` already passes `class` attributes; where a
  component needs a styling hook it gains/changes a class, never behavior. Explicitly unchanged:
  all pure models, all wiring/fetch logic, vote-charts' CSSOM `element.style.width` mechanism
  (CSP note in `_headers` stays true).
- **CSP byte-identical** (`style-src 'self'`, `script-src 'self'`, no inline styles, no external
  fonts/CDNs). `_headers` is not touched.
- Every page gets the treatment; no page keeps the old look.

## 4. Page treatments (as approved in the mockups)

- **Directory (index):** site header; the Serving now / Past members toggle restyled as the
  board's control strip (amber active segment, counts in the labels); search field on `--surface`
  with `⌕` affordance (CSS/text, no icon font); rows on `--border-faint` separators with hover
  lift (`--surface`), name 600-weight, meta muted, tenure as a lit mono fragment right-aligned or
  inline per current markup; footnote text byte-identical, styled `--faint`.
- **Profile (person/legislator):** identity block — photo in a rounded `--surface` frame (or
  "photo" placeholder), name 23px/650, meta muted, the lit serving/tenure line in mono; aggregates
  as board strips with mono legends; vote list as `--surface` card rows: bill + reading left,
  date · source receipt in faint mono below, lit `● YEA`/`● NAY` right.
- **Bill page:** same header/labels/cards; tally strip at top; per-legislator cast rows with lit
  dots; summary bullets keep their citation receipts styled as faint mono.
- **Trust page:** prose page on the same tokens; tables/lists as `--surface` cards.
- **404:** wordmark + one line + link home, on the board.
- **Address lookup (index):** form + results restyled as cards; per-candidate date-evidence lines
  in faint mono; all existing state/empty/failed messages keep their wording.

## 5. Motion & accessibility

- Motion: `transition` on hover/focus (background, glow) ~120–160ms only; no entrance animations;
  `@media (prefers-reduced-motion: reduce)` disables transitions.
- Visible focus: 2px `--focus-ring` outline (offset 2px) on every interactive element.
- Keyboard/AT: no structural regressions; the toggle keeps its `role="group"`/`aria-pressed`
  contract; contrast per §2.

## 6. Honesty rules, binding on the design

- Party is a neutral text chip (`--surface` + `--muted` border/text) — **never** red/blue styling.
- Green/red appear **only** where they are the fact (Yea/Nay positions and tally segments).
- Every existing user-facing string is **byte-identical** — the footnote, `(end date unrecorded)`,
  empty/failed states, labels. The redesign restyles; it never rewords. (The word "current"
  remains banned.)
- Nothing decorative encodes opinion; both parties, all legislators, identical treatment.

## 7. Testing & rollout

- Suite stays green (`node --test` — site-modules tests pin CSP/dev-server/string couplings).
- No new unit tests (pure-CSS change); the gate is visual: local `scripts/serve-site.js` walk in
  BOTH themes (dark + light emulation), then merge → push → Pages deploy → live browser walk of
  directory, a profile, a bill page, trust, 404 in both themes with zero console errors.
- Rollout is a single cutover (one stylesheet serves every page); no feature flag.
