# Referenced-Context Glossary — Design (APPROVED by Lance, 2026-07-28)

**Origin (Lance, 2026-07-28, verbatim):** "I've noticed that the golden jsons reference other
bills, departments or offices that aren't exactly clearly defined in the text when we read it,
it's as if readers should know every single previous bill, we need a way to relay the important
information from those referenced items to the reader so that the context is available to the
reader otherwise we aren't fully getting to 'layman's terms'."

**The tension this design must resolve:** background context (what the Social Security Act IS,
what an agency does) is by definition NOT in the bill text — so the facts-only rule as written
forbids it. The design must add context without opening the door to ungrounded model assertions
(PLAYBOOK §"never let an LLM assert content that isn't grounded in a real, queryable
source-of-record").

---

## Three approaches

### A. Grounded-fetch glossary (RECOMMENDED)

Referenced statutes/acts/programs get glossed FROM THEIR OWN PRIMARY TEXT, fetched from
official sources — the same grounding discipline bills already get:

- **US Code sections** (the dominant reference type — "Sec. 1903 of the Social Security Act"
  = 42 U.S.C. 1396b): fetch from uscode.house.gov (Office of the Law Revision Counsel — the
  official codification) or the govinfo.gov API (GPO, official, free, documented).
- **Referenced bills/public laws**: already in reach via Congress.gov (existing adapter).
- **Agencies/programs**: glossed from the statute that created them (fetchable as above) —
  NOT from model knowledge.

Pipeline: summarizer prompt v2 additionally EMITS a structured list of referenced terms
(extraction, not explanation — rides in the same call, near-zero added cost) → a separate
`gloss` stage fetches each term's primary text and generates a 1-2 sentence plain-language
gloss FROM that text with the same JSON-schema + citation discipline → the same adversarial
verifier refutes each gloss against the fetched source → Lance adjudicates in the same review
page → approved glosses land in a reusable table.

**Why recommended:** it extends the existing trust chain instead of weakening it. Every gloss
is traceable to an official text, adversarially verified, human-adjudicated — the identical
story as summaries. And glosses are WRITE-ONCE, REUSED EVERYWHERE (the SSA gloss is written
one time, attached to every bill that references it), so cost amortizes toward zero.

### B. Model-knowledge glossary, labeled

Opus writes glosses from training knowledge; Sonnet verifies from ITS training knowledge;
rendered with a "Background — AI-provided, not from the bill text" label. Cheapest, fastest,
no new fetch sources — but verification is two models sharing training biases (weak
independence), and it directly violates the grounding playbook rule. NOT recommended for a
trust product; listed for completeness.

### C. Curated-only glossary

Lance hand-writes/approves every entry; the model only SELECTS which approved entries attach
to a summary. Maximum control, but coverage grows at human speed and the writing burden lands
on the one person the trust model tries not to bottleneck.

### Recommendation: A + C hybrid

A's grounded-fetch generation produces DRAFT entries; Lance's adjudication (C's control point)
approves them once; approved entries become the curated, reusable vocabulary. Model knowledge
(B) is never the source of a factual gloss.

---

## Schema (draft-then-apply migration 0007, if approach approved)

```sql
create table glossary_terms (
  id             uuid primary key default gen_random_uuid(),
  term           text not null,              -- display name, e.g. 'Social Security Act, Sec. 1903'
  kind           text not null check (kind in ('statute','act','agency','program','public_law')),
  citation       text,                       -- normalized cite, e.g. '42 U.S.C. 1396b'
  gloss_md       text,                       -- the 1-2 sentence plain-language explanation
  source_url     text not null,              -- the official text it was written from
  source_hash    text not null,              -- sha256 of the fetched source excerpt
  status         text not null default 'draft' check (status in ('draft','approved','published','rejected','stale')),
  model          text, prompt_version text, run_id uuid,
  created_at     timestamptz default now(), published_at timestamptz,
  unique (kind, citation)
);
create table summary_terms (
  summary_id uuid not null references summaries(id),
  term_id    uuid not null references glossary_terms(id),
  primary key (summary_id, term_id)
);
-- RLS: anon reads published glossary_terms only; summary_terms anon-readable; writes service-role.
```

## Rendering rule (public site, Plan 3)

Glosses NEVER interleave with summary bullets. They render in a visually distinct "Background"
block below the summary, each entry labeled with its official source link — the reader always
sees which words come from the bill and which are context.

## Verifier treatment

Same refute-stance pass as summaries: the verifier receives the fetched source excerpt + the
gloss and attempts to refute each sentence against the excerpt alone. Same
completeness-derivation rule (never trust the verifier's self-report).

## Costs (per Lance's approval policy — nothing runs without a per-run OK)

- Term extraction: rides in summarize calls (~free).
- Gloss generation: ~$0.05-0.11 per UNIQUE term, one-time (reuse thereafter).
- Gloss verification: ~$0.05 per unique term.
- Realistic steady state: a few hundred unique terms across a Congress ≈ $30-60 TOTAL,
  amortizing to near zero as the vocabulary saturates.
- New fetch sources (uscode.house.gov / govinfo API): free, official, no keys required
  (govinfo has an optional free API key for higher limits — Lance's call if needed).

## Decisions (Lance, 2026-07-28 — all four resolved)

1. Approach: **A+C hybrid approved** (grounded-fetch generation + curated reuse).
2. Fetch sources: **uscode.house.gov + govinfo.gov approved**.
3. Background label: **"Background — from the referenced law_s official text"** + per-entry source link.
4. Scope: **federal first**; RSMo/revisor.mo.gov joins after the federal pattern proves out.

## Superseded: original open-decision list

1. Approve approach A+C (or redirect).
2. Approve uscode.house.gov / govinfo.gov as new fetch sources (both official/federal).
3. Rendering label wording for the Background block (draft: "Background — from the official
   text of the referenced law, reviewed like everything else").
4. Whether glosses for STATE statutes (Missouri RSMo, revisor.mo.gov) join now or later.
