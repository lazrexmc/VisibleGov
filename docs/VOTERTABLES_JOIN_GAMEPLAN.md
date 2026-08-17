# VisibleGov × VoterTables — Join Gameplan

**Status: PROPOSAL — not started. Written 2026-08-17 at Lance's request ("Look into joining
VisibleGov and VoterTables and make a gameplan"). Nothing here is built; the drain lane and
its pause discipline are unaffected.**

## What each side actually has today (verified against both databases 2026-08-17)

**VisibleGov** (Supabase Postgres, live at visiblegov.pages.dev): legislators with terms
keyed by (chamber, district), an explicit `districts` table (jurisdiction_id, chamber,
district; anon-read RLS), bills, real roll-call votes, and ~980 published plain-language
summaries under trust model v3. The product loop is directory → profile → votes → bill →
tally. What it cannot answer today: **"who represents ME?"** — there is no address → district
entry point — and it has no electoral context for any seat (margins, turnout, voter counts).

**VoterTables** (`c:\Users\lance\VoterTables`, SQLite, Flask viewer): 116 Missouri election
jurisdictions with full county-clerk contact metadata; an email/phone outreach campaign that
logged 53 responses but produced precinct counts for only **43 of 116** jurisdictions (1,086
precincts reported, 0 formally verified). The rest of the schema — precincts, house/senate/
congressional district tables, address points/ranges, voters, elections/contests/candidates/
precinct_results — is **built but entirely empty** (0 rows in every one). District seed SQL
files exist in `data/` but were never loaded. A started-but-unfinished script
(`extract_precinct_counts.py`) parses precinct counts out of the SoS 2024 General Election
results PDF — this is the germ of the pivot below.

**The lesson VoterTables already paid for:** county/precinct election officials are not a
workable primary data channel (43/116 after a full campaign). Any join plan that depends on
finishing that outreach inherits the blockage.

## The join key

**District.** VisibleGov knows who holds each MO House/Senate seat and how they voted.
VoterTables (populated) would know where each district physically lives and what its
elections looked like. Every phase below joins on (chamber, district number) — a key both
schemas already carry.

## Recommended plan — three phases, each independently shippable, $0/month

### Phase 1 — "Find my legislators" on VisibleGov (no VoterTables data needed at all)
The single highest-value join outcome requires neither precinct nor address data: the **US
Census Bureau geocoder** (free, no API key, public) returns state legislative districts
(SLDL = MO House, SLDU = MO Senate) and the congressional district for any street address.
- New site page: address box → Census geocoder (client-side fetch) → district numbers →
  existing VisibleGov profiles for those seats.
- This makes VoterTables' empty address_points/address_ranges tables — and the entire
  address-collection problem — unnecessary. Delete-by-obsolescence, not by effort.
- Neutrality check: pure lookup, no editorializing. Passes trivially.
- Estimated shape: one page + one JS module; no schema change; no new spend.

### Phase 2 — Precinct spine from official results, not from clerks
Pivot the data channel from clerk outreach to **SoS-published precinct-level election
results** (the 2024 General Election file Lance already has, plus its Excel/CSV siblings on
sos.mo.gov). Precinct-by-precinct results *are* the authoritative precinct list per county —
extracting them yields the full 116-county precinct inventory as a byproduct, replacing the
stalled 43/116 outreach with a document channel that cannot decline to answer.
- Finish/replace `extract_precinct_counts.py` against the SoS results file(s).
- Land the result in VisibleGov's Supabase as new anon-read tables:
  `election_jurisdictions` (the 116 counties + clerk metadata as provenance),
  `precincts` (county, name, code), and append-only `precinct_counts` — a direct port of
  the working third of the VoterTables schema. Draft-then-apply: migration drafted for
  Lance's review like every other VisibleGov migration.
- Keep the clerk-response history (`jurisdiction_responses`) archived as provenance; retire
  outreach as a primary channel (use it only to resolve specific discrepancies).

### Phase 3 — Electoral context on legislator profiles
Ingest the state-legislative **contest results** from the same SoS files into
`elections/contests/candidates/precinct_results` (VoterTables' schema, ported to Supabase),
then surface on each VisibleGov profile a mechanically neutral seat panel: last election's
candidates, party, raw votes, margin, precinct count, turnout. Same treatment for every
seat regardless of party; raw numbers with a source link — the receipts pattern the site
already uses for summaries.
- This is where "hold your representative accountable with real information" gets its
  electoral half: what they voted for (VisibleGov) beside how their seat votes (VoterTables).

## Hard constraints (non-negotiable)
- **PII firewall:** the VoterTables `voters` table design (names, DOB, party registration)
  is person-level PII. It stays OUT of VisibleGov and out of any public database, period.
  Only aggregates (counts, results) cross over. This also honors the global no-PII /
  no-bulk-contact rule — the clerk email list is provenance metadata, never a mailing list.
- **Mechanical neutrality** (PLAYBOOK_DELTA §2) applies to every rendered number: both/all
  candidates shown, no characterization of margins, source links on everything.
- **$0/month:** Census geocoder is free; SoS files are free; existing Supabase/Pages tiers
  carry the new tables. No new services.

## What NOT to do
- Do not resume clerk outreach as a data channel.
- Do not migrate or populate voters/address tables anywhere.
- Do not merge repos yet — VoterTables stays a standalone research/staging workspace until
  Phase 2 makes its aggregate layer live in Supabase; then decide whether the Flask viewer
  retires (the VisibleGov site supersedes it).

## Open questions for Lance
1. Approve the channel pivot (SoS results replace clerk outreach as primary)?
2. Phase 1 first? It ships user-visible value with zero data migration.
3. Should the VoterTables Flask app be retired once Phases 2-3 land, or kept as the
   internal research console?

## Sequencing note
One project at a time: the drain lane finishes/pauses first (currently pausing after wave
DF per Lance). This plan enters the normal flow — brainstorm refinements → spec → plan →
build — only on Lance's explicit go, phase by phase.
