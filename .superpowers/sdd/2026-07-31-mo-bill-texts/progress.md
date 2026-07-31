# MO bill-text fetcher — ledger

Implemented 6b87523, 1776/1776 (1726 baseline + 50 new, TDD red-first).
Built: src/adapters/pdf-text.js (NEW shared pdfjs core — a genuine triplication existed:
reconstructPageText + pdfjs setup were byte-identical in mo-rollcall-pdf.js and
mo-senate-journal-pdf.js; both refactored onto it, their real-PDF fixture suites pass unchanged);
src/cli/backfill-mo-bill-texts.js (--dry-run/--limit/--session); tests/backfill-mo-bill-texts.test.js.
Reuses: legiscan-dataset decode+normalize, backfill-mo-bill-meta's cache/session/bill loaders,
summary-queue's isPassageVote, link-persons' isUniqueViolation, us-congress-text's sha256,
summarizer's MAX_TEXT_CHARS/OversizeTextError, moHouse/moSenate limiter singletons dispatched by
state_link hostname.
IMPLEMENTER CONCERNS (for review): (a) used plain .insert()+isUniqueViolation instead of db.js
insertIfAbsent because the upsert form cannot distinguish inserted vs alreadyPresent for honest
counts; (b) pdfjs parse exceptions folded into extractEmpty rather than inventing a 14th count
field; (c) no real MO bill PDF fetched — all tests use injected fake fetch/extract.
HARNESS NOTE: the subagent's Write of a report file was blocked by a new restriction (subagents
return findings as text); content captured here instead.

REVIEW (opus): wrong-text safety properties ALL HOLD (additivity DB-enforced by bare .insert() +
unique(bill_id,version); matching collision-free via unique(session_id,identifier) and
unique legiscan_session_id; version verbatim; source_url = state_link). HEADLINE: the host allowlist
PREVENTED a catastrophe — 2,202 bills' state_link is the SAME literal reflect.legiscan.com/Proxy.php
placeholder; without the check, one identical wrong document would have been written against 2,202
different bills. Findings: HIGH 252 bills with empty texts[] vanish into an unnamed count hole
(counts don't reconcile); HIGH the 2,202 policy refusals are invisible to --dry-run, burn --limit,
and are mislabeled fetchFailed (host is knowable without fetching — hoist pickLimiterForUrl into
planning). MED pickLatestTextEntry mis-selects on missing/malformed date (latent: 0 in real data);
MED alreadyHasVersion keys on type alone so a corrected reprint can never land (1,531 entries share
a type); MED a run abort discards all counts. Concerns adjudicated: (a) plain .insert() ACCEPTED
(stronger reason than the implementer gave: it cannot be config-flipped into an overwrite);
(b) prior upheld but cheaper fix — differentiate `step` to parse|extract|oversize rather than add a
14th count; (c) accepted as scoped. ALSO: real MO type vocabulary is {Amended, Comm Sub, Conference
Sub, Engrossed, Enrolled, Introduced, Substitute} — brief's examples don't occur.
LANCE DECISION: LegiScan getBillText is the volume path (3,116 priority bills ~10% of one month's
30k budget). The 2,202 proxy-placeholder bills have NO usable state_link — getBillText is their only
source, which strengthens the choice. State-direct CLI remains the fallback.
