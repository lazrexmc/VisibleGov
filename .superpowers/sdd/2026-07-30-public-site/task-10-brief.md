### Task 10: trust page + universal footer

**Files:**
- Create: `site/trust.html`, `site/js/trust-page.js`
- Modify: `site/js/render.js` (`mountFooter` gets its real content), all `site/*.html` (footer mount point — verify each)
- Test: extend `tests/site-modules.test.js` (footer links present; counts render path)

**Interfaces:**
- Trust page sections (anchors): `#pipeline` (the mechanical story: official sources → reconcile-or-refuse → author from official text → adversarial verify → mechanical gates → publish with receipts; flagged items wait for human review and say so), `#flags` (what a reconciliation flag / quarantined day means; primary-source-first display), `#freshness` (the full `public_freshness` table rendered), `#attribution` (LegiScan CC-BY 4.0 with link, Congress.gov, senate.gov LIS, house.mo.gov XML, MO Senate journals with the not-official-copies disclaimer, U.S. Census Bureau Geocoder, bioguide/unitedstates images), `#counts` (live `countOnly` numbers: vote casts, bills, legislators, published summaries, published glossary terms — labeled "live from the same database the site reads").
- Footer (every page): "Every fact links to its source. · [How this works](/trust) · [Data freshness](/trust#freshness) · [Attribution](/trust#attribution)".

- [ ] **Step 1: TDD footer content + counts assembly (failing first). Step 2: implement, wire every page, suite green.**
- [ ] **Step 3: Commit** — `git commit -m "feat: trust page + universal footer (the receipts, explained)"`
- [ ] **Step 4 (controller smoke):** every page shows the footer; every trust anchor lands; counts match DB truth.

