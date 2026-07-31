### Task 9: bill page + glossary

**Files:**
- Create: `site/bill.html`, `site/js/bill-page.js`, `site/js/glossary-inline.js`
- Test: `tests/bill-page.test.js` (pure: tally counting, glossary marking, verification-note assembly)

**Interfaces:**
- Data: bill row (`bills?id=eq.` + session + jurisdiction labels); sponsors (`bill_sponsors?bill_id=eq.&select=sponsor_type,legislators(id,full_name,person_id)`); roll calls (`votes?bill_id=eq.&order=vote_date.desc` then per vote `vote_casts?vote_id=eq.&select=position` via fetchAllRows); summary (current published per bill: `status=eq.published&order=published_at.desc` first row) + `public_verification_notes?summary_id=eq.`; glossary (`summary_terms?summary_id=eq.` → `glossary_terms?id=in.(...)&status=eq.published`).
- Pure (tested):
  - `tallyPositions(castRows)` → `{yea, nay, not_voting, absent, other: {}}` — a mechanical count of stored rows, labeled in the UI as "recorded casts in our data"; rendered NEXT TO `votes.result` (the source's printed outcome), never replacing it. An unknown position lands in `other` under its raw string — displayed, not dropped.
  - `renderSummaryStructured(bodyMd)` → `{statedPurpose, bullets: [{point, section}]}` via Task 4's parsers — the page renders from the parsed structure; if `parseBullets` yields fewer bullets than `body_md`'s raw `- ` lines (the verifier's own coverage rule), fall back to rendering body_md as PLAIN TEXT lines with a "formatting could not be verified" note — never render half.
  - `markTerms(pointText, glossaryTerms)` → array of `{text, term|null}` segments by case-insensitive EXACT string match on `glossary_terms.term`, longest-first, non-overlapping — segments render as text nodes with `<dfn>` wraps; gloss_md shown in an expandable block below (gloss_md through a MINIMAL renderer: paragraphs + `**bold**` only, built on text nodes — no innerHTML).
- Verification note (receipt): "Summary by {summaries.model}, adversarially verified {overall} by {note.model} on {date}" + supporting quote from `glossary_terms.supported_by_quote` on each gloss. No published summary → "No plain-language summary yet — the facts above are the record." MO bills (`jurisdiction_id='mo-legislature'`): the disclaimer line "Bill text and status shown are not official copies; the official record is at the linked source." + `officialBillUrl` link.

- [ ] **Step 1: TDD the three pure functions** (fixtures: real body_md, a cast set with an unexpected position string, term marking with overlapping candidates) — FAIL first.
- [ ] **Step 2: Implement + wire the page.** Every section three-stated. **Step 3: suite green, commit** — `git commit -m "feat: bill page (tallies-beside-printed-result, structured summary, inline glossary)"`
- [ ] **Step 4 (controller smoke):** one published-summary bill (e.g. S 2), one summary-less MO bill, one bill with a reconciliation-flagged vote.

