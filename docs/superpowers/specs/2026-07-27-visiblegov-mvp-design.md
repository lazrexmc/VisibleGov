# VisibleGov MVP — Design (WORKING DRAFT)

**Status: work-in-progress rough draft, per Lance (2026-07-27).** This is the agreed overall
shape, not a locked spec — details inside every section are expected to be refined as building
begins. Nothing here overrides PLAYBOOK_DELTA §2 (mechanical neutrality); check every refinement
against it.

## The gap this fills (why not just use GovTrack / OpenStates / BillTrack50)

Lance's selections, 2026-07-27: (1) **bills are unreadable** — existing tools still surface
legalese or dry procedural summaries; (2) **no plain accountability view** — you can't quickly go
from "here's my rep" to "here's what they voted for, in plain English"; (3) **nobody actually uses
them** — existing tools are built for researchers and journalists, not regular people. Coverage
level was explicitly *not* the gap. The product bet is readability + one-tap accountability +
being usable by regular people.

## Scope decisions

- **Jurisdictions: US Congress AND the Missouri General Assembly, both from day one.**
  (Lance's call, aware of the two-pipeline risk.) Mitigation: one canonical, jurisdiction-agnostic
  schema; per-source adapters behind a single interface.
- **Front door: legislator directory + "who represents me."** Anyone can browse every legislator;
  entering an address shows your own federal + state reps. (Lance: "combination of who represents
  me and a legislator directory. They can look at anyone but also enter an address to see who is
  there reps.")
- **Bill scope: bills with recorded floor votes get full plain-language treatment, PLUS bills
  approaching a vote** (reported out of committee / placed on a floor calendar) so people can see
  what's coming before it's decided. (Lance: "I like the idea of bills with votes but we also need
  to see items that are in the works that are upcoming that may come to vote soon.") This is a
  mechanical trigger rule, not editorial curation. All other bills get bare listings with official
  links — nothing hidden, just not yet summarized.
- **Trust model (updated 2026-07-27, at Lance's call after the first review session): two-stage.**
  (1) Every draft gets an **adversarial verification pass** by a different model than the author
  (initially claude-sonnet-5 verifying claude-opus-5 output; a different-vendor verifier is the
  planned upgrade for stronger independence — PLAYBOOK §6 pulled forward from "when volume
  demands"). The verifier is prompted to REFUTE: for each bullet, locate the cited section and
  determine whether the claim is fully supported by that section alone; flags carry a reason and
  an evidence quote. (2) **Lance adjudicates**: flagged bullets come to him with the flag
  explained; unflagged summaries he can approve on a skim. Nothing publishes without his click,
  but his role is adjudication and accountability, not primary verification.
- **Architecture: Approach A — proven stack + ingestion CLI** (chosen over Cloudflare-native
  Workers automation and framework SSR). Supabase + Cloudflare Pages + a Node CLI for
  ingestion/summarization, run manually first, promoted to GitHub Actions cron once trusted.
  $0/month except Claude API calls at summarization time.

## Product surface

**Public site** (Cloudflare Pages; bill/legislator pages pre-rendered to static HTML on publish
for speed, link previews, and search indexing — reach is part of the product thesis):

- **Home** — address box ("Who represents me?"), directory entry point, feed of recent roll-call
  votes with one-line plain summaries.
- **Directory** — all legislators in all four chambers (US House, US Senate, MO House, MO Senate);
  filter by chamber/party/district; search by name.
- **Legislator page** — party, district, photo, contact; voting record as one row per roll-call
  vote: bill one-liner, their vote (Yea/Nay/Present/Absent), outcome. Also the factual activity
  record (Lance, 2026-07-27: "Bills proposed, votes made, votes missed"): bills sponsored, votes
  cast, and votes missed (absent/not-voting counts per session) — attendance stated as bare
  counts, identically for every legislator, never editorialized.
- **Bill page** — plain-language summary ("what it does" bullets + stated purpose), lifecycle
  stage (introduced → committee → calendar → voted → law), full vote breakdown (party split +
  every member's vote), prominent link to the official bill text and record. Footer on every
  summary: "AI-assisted, human-reviewed — read the official text here."
- **Upcoming** — bills on a floor calendar (likely to be voted soon).
- **Neutrality mechanics:** identical layout for every bill and legislator regardless of party.
  No scores, grades, or ratings anywhere in the MVP.

**Staff backend** (`/admin` on the same Pages site; Supabase Auth; RLS-gated): review queue
showing each draft summary side-by-side with the actual bill text it was generated from —
approve, edit (edits logged), or reject. Publishing triggers the static rebuild.

## Data model (canonical, jurisdiction-agnostic — draft shapes, will evolve)

- `jurisdictions` → `sessions` → `bills` (identifier, title, lifecycle stage, canonical source
  URL) → `bill_texts` (versioned raw text, content hash, source snapshot ref) + `bill_actions`
  (lifecycle events).
- `legislators` + `terms` (chamber, district, party, dates — people change seats).
- `votes` (roll-call: bill, chamber, date, question, result) → `vote_casts` (one row per
  legislator per vote).
- `summaries` (bill, draft text, status draft/published/rejected, model + prompt version, hash of
  the exact bill-text version summarized, editor edits, ingestion run id).
- `ingestion_runs` (provenance log of every pipeline execution).
- `districts` (jurisdiction + chamber + district → current legislator, for address lookup).
- **RLS:** anonymous reads published/public rows only; staff writes everything; no service keys in
  the browser. RLS is the wall, not the UI.

## Ingestion pipeline

Node CLI (`ingest`) with two adapters behind one interface, both writing canonical shapes:

- **us-congress** — Congress.gov API (free key) for bills, actions, floor calendars; House Clerk +
  Senate roll-call XML feeds for votes; bill text per version as plain text.
- **mo-legislature** — OpenStates API first; direct house.mo.gov / senate.mo.gov scraping only as
  fallback for gaps. Per PLAYBOOK §4.1: spot-check OpenStates vote records against the official
  journals before trusting them — never assume the aggregator matches the primary source.

League rules applied from day one (PLAYBOOK §3): skip ≠ empty (rate-limit/failure is a distinct
error state, never an empty result); one shared rate limiter per source; startup catch-up and
incremental polling are separate code paths; additive writes (never silently overwrite a
previously-set field); every run logged in `ingestion_runs`, every touched row tagged with the
run id.

## Summarization pipeline

- **Trigger (mechanical, not editorial):** bill has a recorded floor vote, OR is reported out of
  committee, OR is placed on a floor calendar (same rule as the scope decision above).
- `summarize` CLI step sends the full actual bill text (specific version, hashed) to the Claude
  API with a fixed, versioned prompt: plain-language "what it does" bullets; stated purpose from
  the bill's own language; no adjectives about merit; no party framing; classify "amends existing
  law" vs "new program" vs "appropriation."
- **Facts-only rule (Lance, 2026-07-27: "There should be no editorial summaries here, people put
  their emotions into their summaries, we are only looking for facts"):** every summary bullet
  must be traceable to a specific section of the bill text; no intent-guessing beyond the bill's
  own stated-purpose language; no characterization of impact beyond what the text says; the
  review queue rejects anything that reads as opinion, emphasis, or emotion. Editor notes
  (rejection reasons, edit rationale) are internal-only — never publicly readable (fixes the
  Task-4 RLS finding: exclude `editor_notes` from the public policy or move it to a staff table).
- Output lands as a `draft` row. Nothing publishes without approval in the queue.
- If the bill text gains a new version after drafting, the summary is flagged stale (hash
  mismatch) and re-queued.
- Prompt changes bump the prompt version so any batch is traceable and re-runnable (§3.3).

## Address lookup

Browser → US Census Geocoder (free, no key) → congressional district + MO house/senate districts
in one call → join `districts` → legislators. The address never touches our database (goes to the
Census API only — say so on the page). If browser calls are blocked, a small Cloudflare Pages
Function proxies it.

## Honest status on the public site

Per-source freshness in every page footer from the last successful ingestion run ("Congress votes
current as of …; Missouri as of …"). A failing source is surfaced as possibly-stale data, never
silently presented as current. Every bill page links the official record — VisibleGov is never
the last word.

## Testing

- Adapter unit tests against saved fixture payloads (real captured API responses); skip-vs-empty
  behavior explicitly tested.
- Schema changes are draft-then-apply: migration written and explained, Lance reviews and runs it.
- Summarizer golden set: a handful of bills with hand-verified summaries, re-run on every prompt
  change to catch drift before it reaches the queue (§4.3).

## Out of scope for MVP

No user accounts, comments, notifications/alerts, scores or ratings, states beyond Missouri, or
news/media integration. Untriggered bills still get bare listing pages (title, status, sponsor,
official link) and appear in search.

## First vertical slice: Bob Onder

Lance's call (2026-07-27): the first legislator to prove end-to-end is **Bob Onder** — US
Representative for Missouri's 3rd district since 2025, and before that a Missouri state senator
(and earlier a state representative). He spans both jurisdictions, so one person exercises both
adapters: his US House roll-call votes via the federal pipeline and his MO General Assembly record
via the Missouri pipeline, on one legislator page. (Career dates/districts above are from memory —
verify against the official records during the build, per the verify-before-asserting rule.)
Neutrality check: he's the *pipeline test subject* because his career shape covers both data
sources — the same treatment applies to every legislator that follows.

## Open items (expected refinement, not blockers)

- Exact Congress.gov / OpenStates endpoint field mappings → canonical schema columns.
- MO roll-call vote data quality — how much falls to the scraping fallback in practice.
- Summary prompt wording and the golden-set bill selection.
- Static pre-render mechanics (build script + Pages deploy hook on publish).
- Domain name / branding.
