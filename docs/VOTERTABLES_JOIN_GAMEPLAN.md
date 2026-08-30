# VisibleGov × VoterTables - Join Gameplan

**Status: PROPOSAL for Phases 2-3; Phase 1 ALREADY SHIPPED 2026-07-30 (commit 9252d6c, live
since the 2026-08-05 deploy). Written 2026-08-17 at Lance's request ("Look into joining
VisibleGov and VoterTables and make a gameplan"). Phases 2-3 are not built. (Superseded
2026-08-23: the original header read "not started ... Nothing here is built; the drain lane
and its pause discipline are unaffected" - Phase 1 had in fact shipped 18 days before this
doc was written, and the drain lane ran to empty 2026-08-22; see the sequencing note.)**

**Last verified 2026-08-23** against the live site, both databases, and the repo's decision
trail (TODO.md inbox entry "2026-08-17 (Lance: 'Look into joining VisibleGov and
VoterTables...')" and the 2026-08-22 docs-refresh note that flagged Phase 1 as already
shipped). Lance has not yet answered the open questions at the bottom (no answer in CHATLOG as
of this date) - when he does, record each answer there, dated, and move this line. **Spend
posture: no phase involves an LLM or any billed API call** (the Census geocoder is free and
keyless; the SoS files are documents) - the standing no-API-spend hold and the per-run
approval rule do not gate this work; only Lance's explicit go does. None of the repo's
in-flight work on 2026-08-23 (the MO Senate journal replay, migration 0032 for vote-date
provenance, the 2024 MO House roll-call dating) touches anything in this plan.

## What each side actually has today (verified against both databases 2026-08-17; re-verified 2026-08-23)

**VisibleGov** (Supabase Postgres, live at visiblegov.pages.dev): legislators with terms
keyed by (chamber, district) - `terms` (about 1,100 rows, 2026-08-23) is the LIVE carrier of
the join key; a `districts` table (jurisdiction_id, chamber, district; anon-read RLS) exists
in migration 0001 but is **empty and unused** (0 rows; nothing in `src/`, `scripts/`, or
`site/js` reads or writes it - corrected 2026-08-23; the original text called it "explicit"
as if it carried the key) - bills, real roll-call votes, and ~1,000+ published plain-language
summaries under trust model v3 (run `npm run status` for the live count; "~980" was the
2026-08-17 figure). The product loop is directory -> profile -> votes -> bill -> tally. **What
it already answers: "who represents ME?"** - the home page's address lookup (shipped
2026-07-30; see Phase 1 below) returns the U.S. Senate, U.S. House, MO Senate, and MO House
seats for a street address. (Superseded 2026-08-23: the original text said "there is no
address -> district entry point" - wrong when written.) **What it still cannot answer:** any
electoral context for a seat (margins, turnout, precinct or voter counts).

**Schema-collision note (added 2026-08-23):** both databases use the same table names for
different things. VisibleGov `jurisdictions` = legislatures (two rows: `us-congress`,
`mo-legislature`); VoterTables `jurisdictions` = 116 election authorities. VisibleGov
`districts` is the empty table above; VoterTables has `house_districts` / `senate_districts`
/ `congressional_districts`. A port must name, for each VoterTables table, which existing
VisibleGov table it maps onto or the deliberately new name it takes - `election_jurisdictions`
in Phase 2 is deliberate for exactly this reason, and Phase 2/3 must decide whether to
populate `districts` or keep joining on `terms`.

**VoterTables** (`c:\Users\lance\VoterTables`, SQLite, Flask viewer): 116 Missouri election
authorities - not counties (Missouri has 114): the list adds St. Louis City and splits
Jackson County into the Kansas City and Jackson County election boards, and every row is
`type='authority'` (clarified 2026-08-23) - with full clerk contact metadata; an email/phone
outreach campaign that logged 53 responses but produced precinct counts for only **43 of
116** authorities (1,086 precincts reported, 0 formally verified). The rest of the schema -
precincts, house/senate/congressional district tables, address points/ranges, voters,
elections/contests/candidates/precinct_results - is **built but entirely empty** (0 rows in
every one). District seed SQL files exist in `data/` but were never loaded. A stub script
(`extract_precinct_counts.py`, 2025-12-27) targets the SoS 2024 General Election results PDF
but **never matched the file's actual layout**: its regex expects "Adair 12"-style county lines
and the PDF has none - what the PDF carries is a contest header of the form "State
Representative - District 1 (36 of 36 Precincts Reported)" (verified 2026-08-23 against the
UTF-16 text dump: 322 such headers - 163 State Representative, 17 State Senator, 8 U.S.
Representative - 0 county rows, 0 regex matches). It is the germ of the pivot below only if
re-aimed at that header pattern. (Superseded 2026-08-23: the original text said it "parses
precinct counts out of" the PDF.)

**The lesson VoterTables already paid for:** county/precinct election officials are not a
workable primary data channel (43/116 after a full campaign). Any join plan that depends on
finishing that outreach inherits the blockage.

## The join key

**District.** VisibleGov knows who holds each MO House/Senate seat and how they voted.
VoterTables (populated) would know where each district physically lives and what its
elections looked like. Every phase below joins on (chamber, district number) - a key both
schemas already carry.

**District-map vintage (added 2026-08-23):** the live lookup asks the Census geocoder for
`vintage=Current_Current`, whose layers come back named "2024 State Legislative Districts"
and "119th Congressional Districts" - the boundaries drawn after the 2020 Census and first
used in the 2022 elections. Results from earlier elections sit on the previous decade's maps,
so Phase 3 needs a map-vintage key on `elections`/`contests` (or a stated cutoff); a bare
(chamber, district) join would silently mix maps.

## Recommended plan - three phases, each independently shippable, $0/month

### Phase 1 - "Find my legislators" on VisibleGov - ALREADY SHIPPED 2026-07-30 (live 2026-08-05)
**Corrected 2026-08-23:** this phase was written as a to-build item, but it had shipped 18
days before this doc existed (commit 9252d6c, "directory + address lookup (geocode
pass-through, currency-honest matching)"; deployed with the site 2026-08-05; verified live
2026-08-23 - the Capitol address returns MO Senate 6, MO House 60, U.S. House 3). The
original reasoning stands: the **US Census Bureau geocoder** (free, no API key, public)
returns state legislative districts (SLDL = MO House, SLDU = MO Senate) and the
congressional district for any street address, and neither precinct nor address data is
needed. What exists - the inventory a fresh session must not break:
- Files: `site/index.html` `#address-lookup` (the home-page form, "Find my
  representatives"), `site/js/directory-page.js` (form wiring + rendering),
  `site/js/districts.js` (Census response parsing + (chamber, district) matching against
  `terms`), `site/functions/geocode.js` (Cloudflare Pages Function),
  `tests/districts.test.js` + `tests/fixtures/census/capitol.json`.
- Actual architecture - NOT the "client-side fetch" the original text proposed: browser ->
  **POST /geocode** (address in the JSON body; the Pages Function forwards it to the Census
  geographies endpoint and writes it nowhere) -> district numbers -> `districts.js` matches
  against `terms` -> existing profiles. The Census API sends no CORS headers, so the browser
  cannot call it directly; and the function must stay POST, never GET - Cloudflare logs
  `ClientRequestURI` at the edge, so `?address=` would put home addresses in our own edge
  logs. The privacy sentence on the page ("not stored or logged - not by us, not ever") is a
  review-blocking contract, not a comment.
- Currency-honesty law (`site/js/districts.js`): results never use the word "current" -
  terms-date gaps mean some seat-holdings cannot prove they are current, so the page renders
  "per the most recent term evidence in our data (...)" from the matched terms' own start
  dates. Any Phase 3 seat panel that names the seat holder inherits this rule.
- Scope: the lookup already covers **U.S. Senate and U.S. House** seats as well as MO
  House/Senate. Phases 2-3 below are written for MO legislative seats; whether congressional
  contests are in scope for the electoral-context work is open question 4.
- This makes VoterTables' empty address_points/address_ranges tables - and the entire
  address-collection problem - unnecessary. Delete-by-obsolescence, not by effort.
- Neutrality check: pure lookup, no editorializing. Passes trivially.
- (Superseded 2026-08-23: "Estimated shape: one page + one JS module; no schema change; no
  new spend" - it shipped as a home-page form plus two modules and a Pages Function; "no
  schema change, no new spend" held true.)

### Phase 2 - Precinct spine from official results, not from clerks
Pivot the data channel from clerk outreach to **officially published election results** - a
document channel that cannot decline to answer. **Corrected 2026-08-23 - what is actually in
hand:** the 2024 General Election file Lance has (`2024GeneralElection.pdf`) is the Board of
State Canvassers' official returns - 36 pages, 322 contests, each a statewide, per-district,
or per-judicial-circuit total under a "(N of N Precincts Reported)" header. It carries **zero
county rows and zero precinct rows**. What it yields: a precinct COUNT per contest/district
(e.g. "State Representative - District 1 (36 of 36 Precincts Reported)") plus candidate / party
/ votes / percent for every State Representative (163) and State Senator (17) contest -
directly useful for Phase 3 and for per-district precinct counts, but NOT a precinct inventory
per election authority. (Superseded 2026-08-23: the original text called it "SoS-published
precinct-level election results ... plus its Excel/CSV siblings on sos.mo.gov" and said
extracting it "yields the full 116-county precinct inventory as a byproduct".) Those siblings
are **unverified** - sos.mo.gov refuses scripted fetches (403, 2026-08-23) - and Missouri
precinct-by-precinct results are normally published by each county election authority's
canvass, not by the SoS. Precinct-by-precinct results, wherever they are published, *are* the
authoritative precinct list per authority; but this plan cannot commit to "SoS files replace
clerk outreach" until a source inventory exists.
- **Source inventory (prerequisite, not yet done):** for each candidate source record the
  URL, granularity (statewide / district / county / precinct), format, and which of the 116
  authorities it covers - the SoS downloads Lance can open in a browser, and the county
  election authorities that publish precinct canvass reports. Until that table exists, the
  stalled 43/116 outreach is replaced only for per-district precinct counts, not for the
  precinct inventory.
- Replace `extract_precinct_counts.py`, re-aimed at the "(N of N Precincts Reported)" contest
  headers (its county-line regex matches nothing in the file); add a second extractor only
  once the source inventory names a precinct-level source and its layout.
- Land the result in VisibleGov's Supabase as new anon-read tables:
  `election_jurisdictions` (the 116 election authorities - keyed on authority, not county,
  since Jackson County is two authorities and St. Louis City is its own - with clerk
  metadata as provenance; the name is deliberate so it cannot collide with VisibleGov's
  legislature-level `jurisdictions`), `precincts` (authority, name, code), and append-only
  `precinct_counts` - a direct port of the working third of the VoterTables schema.
  Draft-then-apply: migration drafted for Lance's review like every other VisibleGov
  migration.
- Keep the clerk-response history (`jurisdiction_responses`) archived as provenance; retire
  outreach as a primary channel (use it only to resolve specific discrepancies).

### Phase 3 - Electoral context on legislator profiles
Ingest the state-legislative **contest results** from the same SoS files into
`elections/contests/candidates/precinct_results` (VoterTables' schema, ported to Supabase),
then surface on each VisibleGov profile a mechanically neutral seat panel: last election's
candidates, party, raw votes, margin, precinct count, turnout. Same treatment for every
seat regardless of party; raw numbers with a source link - the receipts pattern the site
already uses for summaries.
- (Added 2026-08-23) Every `elections`/`contests` row carries its district-map vintage (see
  "The join key"); the panel's "who holds the seat" line inherits the currency-honesty law
  from Phase 1 - the word "current" never appears; dates come from `terms` evidence.
- This is where "hold your representative accountable with real information" gets its
  electoral half: what they voted for (VisibleGov) beside how their seat votes (VoterTables).

## Hard constraints (non-negotiable)
- **PII firewall:** the VoterTables `voters` table design (names, DOB, party registration)
  is person-level PII. It stays OUT of VisibleGov and out of any public database, period.
  Only aggregates (counts, results) cross over. This also honors the global no-PII /
  no-bulk-contact rule - the clerk email list is provenance metadata, never a mailing list.
- **Mechanical neutrality** (PLAYBOOK_DELTA §2) applies to every rendered number: both/all
  candidates shown, no characterization of margins, source links on everything.
- **$0/month:** Census geocoder is free; SoS files are free; existing Supabase/Pages tiers
  carry the new tables. No new services.

## What NOT to do
- Do not resume clerk outreach as a data channel.
- Do not migrate or populate voters/address tables anywhere.
- Do not merge repos yet - VoterTables stays a standalone research/staging workspace until
  Phase 2 makes its aggregate layer live in Supabase; then decide whether the Flask viewer
  retires (the VisibleGov site supersedes it).

## Open questions for Lance
*(No answers recorded as of 2026-08-23. When Lance answers, write the answer under the
question, dated, and update the "Last verified" line at the top.)*
1. Approve the channel pivot (officially published results replace clerk outreach as
   primary)? - noting, per the 2026-08-23 correction above, that the file in hand gives
   per-district counts and contest results, and a precinct-level source still has to be
   inventoried.
2. ~~Phase 1 first? It ships user-visible value with zero data migration.~~ Moot
   (2026-08-23): Phase 1 had already shipped 2026-07-30.
3. Should the VoterTables Flask app be retired once Phases 2-3 land, or kept as the
   internal research console?
4. (Added 2026-08-23) Are U.S. House contests in scope for Phases 2-3? The address lookup
   already returns the congressional district, and the 2024 returns file carries the 8 U.S.
   Representative contests alongside the state-legislative ones.

## Sequencing note
One project at a time. (Superseded 2026-08-23: when written, this read "the drain lane
finishes/pauses first (currently pausing after wave DF per Lance)" - the lane was closed
2026-08-18, reopened, and ran to empty 2026-08-22; summaries are now owned by the daily
`scripts/scheduled-summaries.js` scheduler under its $1/tick + $5/week ledger, so that
precondition no longer exists.) Nothing gates this plan except Lance's explicit go, phase by
phase: it enters the normal flow - brainstorm refinements -> spec -> plan -> build - only then.
No billed call is involved in any phase (see the header).
