# Identity Merge — Design (APPROVED by Lance, 2026-07-29)

**Problem:** legislators are keyed per-source (bioguide_id, openstates_id, mo_house_id,
mo_senate_id, legiscan_people_id), so one real person is several rows — Bob Onder is four.
1,576 rows must resolve into actual people; the politician profile (the product) needs one
page per person aggregating every era and source.

**Decisions (Lance, 2026-07-29):**
1. **Virtual merge.** New `persons` table + nullable `legislators.person_id`. Source rows are
   never deleted or rewritten; a wrong link is one UPDATE to undo; per-source provenance is
   permanent. (Physical merge rejected: destructive, ~1.5M cast-row rewrites, erases origin.)
2. **Auto + flags, trust-model-v3 style.** High-confidence clusters (exact name/nickname
   variants + chamber + district + era evidence via src/lib/person-identity.js — the
   adversarially-proven matcher) link automatically with per-link audit rows. Ambiguity links
   NOTHING and lands in a review queue for Lance with the evidence side by side. Wrong-merge
   is the unacceptable error class; missed-merge is a benign residual.

## Schema (migration 0012, draft-then-apply)

- `persons(id uuid pk, display_name text not null, display_name_source text not null,
  created_at timestamptz)` — display_name is MECHANICAL, highest-authority source wins:
  bioguide (Congress official) > state roster (mo_senate/mo_house full_name) > legiscan >
  openstates; the winning source is recorded. Never invented, never edited by the pipeline.
- `legislators.person_id uuid null references persons(id)` — additive column.
- `person_links(id, person_id fk, legislator_id fk unique, evidence jsonb, decided_by
  ('auto'|'lance'), run_id, created_at)` — the audit trail: one row per linked legislator row,
  carrying the matched evidence (names, chamber, district, era, source keys).
- `identity_flags(id, cluster_key text, candidate_legislator_ids uuid[], evidence jsonb,
  resolved boolean default false, run_id, created_at)` — the ambiguity queue.
- RLS: `persons` anon SELECT (public grouping is public data); `person_links` and
  `identity_flags` service-role only (internal audit; revisit receipts exposure at Plan 3).

## Components

1. **Linker CLI (`src/cli/link-persons.js`, zero model calls):** loads all legislators via
   selectAll; clusters via person-identity.js's matcher extended with a cluster pass
   (pairwise candidate generation on surname/name-variant + chamber/district/era evidence from
   terms rows AND per-source identity columns — both evidence paths, per the ledgered senate
   rulings); unambiguous cluster → insert person (display-name precedence), additivePatch
   person_id onto each row, person_links rows; ANY ambiguity → identity_flags row, zero links.
   Idempotent: rows with person_id set are skipped; re-runs process only unlinked rows.
   --dry-run prints the full proposed clustering with counts, zero writes.
2. **Review-server identity tab:** flagged clusters side by side (full_name, source keys,
   district, era, cast counts per row); Lance's link/keep-separate decision writes
   person/person_links (decided_by 'lance') or marks the flag resolved-separate; CSRF-guarded
   like every other decision route; graceful pre-0012 degradation.
3. **Profile read-path convention (Plan 3 contract):** profiles aggregate by person_id;
   an unlinked legislator row behaves as a single-row person (no breakage mid-rollout).

## Error handling / testing

Typed errors; skip≠empty; honest counts ({clusters, linked, flagged, skipped_already_linked}).
Fixture-first: the real four-Onder shape (bioguide 'Onder, Robert F.', openstates 'Bob Onder',
mo_senate 'Bob Onder' d2, legiscan 'Robert Onder'/nickname Bob) is the canonical test cluster —
NOTE the bioguide row's 'Last, First' name form: normalization already handles reordering.
Same-surname different-people (Brown 16 vs Brown 26) must stay unlinked. Full suite green;
draft-then-apply; live run gated on 0012 applied + dry-run review.

## Out of scope (YAGNI)

Cross-state/federal dedup beyond name+era evidence (no fuzzy matching, no external lookups);
person-level display editing UI; retroactive re-keying of any existing table (votes/casts stay
keyed by legislator_id forever — person_id is a read-time grouping).
