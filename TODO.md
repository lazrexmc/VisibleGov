# VisibleGov — TODO / Backlog

*How to use: dump raw ideas in INBOX anytime. We triage from there into real work.*

---

## NOW

- [x] ~~Lance reviews the MVP design draft~~ (approved as working draft 2026-07-27)
- [ ] **Execute Plan 1: foundation + ingestion (Onder slice)** —
  `docs/superpowers/plans/2026-07-27-slice1-foundation-ingestion.md`. Lance's setup steps
  before the blocked tasks: (a) free API keys — Congress.gov (api.congress.gov/sign-up) and
  OpenStates (open.pluralpolicy.com) — into `.env`; (b) create Supabase project + apply the
  Task 4 migration; then Task 10 runs live. Plans 2 (summarization + review queue) and
  3 (public site + admin) follow.

## 🛠 BUILD QUEUE

1. **First vertical slice: Bob Onder end-to-end** (Lance's call, 2026-07-27). US House MO-3
   (since 2025) + prior MO General Assembly career = one legislator exercising BOTH adapters.
   Verify his actual career dates/districts against official records first — don't trust memory.
   Slice = ingest his votes from both sources → summarize the triggered bills → review queue →
   published legislator page.
2. Schema migration draft (canonical tables + RLS) — draft-then-apply, Lance runs it.
3. Congress.gov adapter (bills, actions, calendars, roll-call XML).
4. OpenStates/MO adapter (+ spot-check votes against official journals before trusting).
5. Summarization CLI (versioned prompt, hash-tied to bill text version, review queue).
6. Public site: directory, legislator page, bill page, address lookup (Census Geocoder).
7. Staff `/admin` review queue.

## 📥 INBOX (raw idea capture, 2026-07-27, Lance's own words)

> "I'd like to expose all the politicians by breaking down the bills and laws they propose into
> layman terms so that everyone can easily read them and their purpose and then we can all see how
> our constituents voted on said bills so we can hold them accountable as they are CLEARLY running
> amuck these days"

Multi-faceted per Lance: (1) plain-language bill/law breakdowns, (2) purpose/intent surfaced
clearly, (3) voting-record tracking tied to individual legislators, (4) accountability - making the
above easy enough that regular people actually use it. Decomposed 2026-07-27 into the MVP design
draft — see NOW.
