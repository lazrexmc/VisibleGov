### Task 1: Live capture — roster pages, journal index, second journal day (bounded, ≤14 requests)

**Files:**
- Create: `tests/fixtures/research/mo-senate/` additions (see below)
- Modify: `tests/fixtures/research/SOURCES.md` (append exact URLs + dates + request count)

**What to capture** (2s spacing, self-identifying UA `VisibleGov research (contact: repo owner)`, log each URL; budget ≤14 requests including misses; STOP at budget and report if the shapes can't be found — do not brute-force):
1. **Journal index/list page** for 2018 and for the current year — start at `https://www.senate.mo.gov/journallist/` (research-verified to exist with a year selector); capture the HTML that enumerates day-journal links for a chosen year. Save as `journallist-2018.html`, `journallist-current.html`.
2. **Senate roster page** for 2018 and current year — the `<yy>info` archive tree is verified real (`/18info/pdf-jrnl/DAY37.pdf` works); look for the roster/member listing linked from the journal-list or `senate.mo.gov` nav (candidates to try, in order: `/18info/SenateRoster.htm`, `/18info/senalpha.htm`, the members page linked from the year's archive landing page). MUST contain, per senator: name (at minimum surname), district number, party if printed. Save as `roster-2018.html`, `roster-current.html`.
3. **One more journal day PDF from a different year than 2018** (any small/quiet day from the current year's list) — to confirm the vote-block format is stable across sessions before the parser hard-codes it. Save as `<year>-day<NN>-journal.pdf`.

- [ ] Capture per above; append every URL + date + total request count to SOURCES.md; note any shape corrections vs this plan's guesses.
- [ ] Commit: `chore: capture MO Senate roster/journal-index fixtures (research-budgeted)`

**Produces (for later tasks):** real HTML/PDF fixtures anchoring every parser test; the confirmed roster-page URL pattern and journal-index URL pattern, documented in SOURCES.md.

