// Shared glossary-term persistence: turning a model's referenced_terms array into glossary_terms
// stubs + a summary_terms join row. Originally lived only in extract-terms.js's backfill.
//
// Fix wave (final review, Important finding 2): summarize.js's v2 SUMMARY_SCHEMA already asks
// opus-5 for referenced_terms in the SAME billed call that authors a summary's markdown (rides in
// the same call, near-zero added cost, per the design doc's own framing — see
// docs/superpowers/specs/2026-07-28-glossary-design.md) — but createDraftSummary discarded
// json.referenced_terms entirely, so every NEW summary still needed a second, separately-billed
// extract-terms.js pass just to rediscover terms it already had. Factoring this logic out here
// lets summarize.js call the exact same upsert/join code extract-terms.js's backfill uses —
// identical needs_mapping/as-cited-citation rules, no risk of the two ever drifting apart — right
// after a draft summary row exists, instead of only ever retroactively.
import { parseCitation } from '../adapters/uscode.js';
import { insertIfAbsent } from './db.js';

export const GLOSSARY_TERMS_TABLE = 'glossary_terms';
export const SUMMARY_TERMS_TABLE = 'summary_terms';

// normalizeTermText: TRIVIAL normalization ONLY — trim + collapse internal whitespace runs to a
// single space. Controller ruling 2, ledgered from Task 1's review: never rewrite the term text
// itself (verbatim-from-bill discipline carries over from extraction the same way it governs
// summarizer.js's referenced_terms rule). This means (kind, term) dedup for unmapped terms is
// exact-string only — a term printed two different ways across two bills mints two distinct
// glossary_terms rows. Accepted and documented, not a bug to "fix" with fuzzier normalization.
export function normalizeTermText(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

// upsertKeyFor: the branched upsert decision (ledgered from Task 1's review — see migration
// 0007's comments on glossary_terms_unmapped_uidx). glossary_terms has two unique paths: the
// base `unique (kind, citation)` constraint when parseCitation resolves citation_raw to a real
// USC cite, and the partial index `(kind, term) where citation is null` when it can't. Which
// applies is decided ENTIRELY by whether parseCitation resolves — never by kind, never a guess.
// Pure: does not itself build the normalized citation string or touch the DB (see
// upsertGlossaryTerm below for that).
export function upsertKeyFor(term) {
  const parsed = parseCitation(term.citation_raw);
  if (parsed) return { by: 'citation', needs_mapping: false };
  return { by: 'term', needs_mapping: true };
}

// normalizeCitation: the stored `glossary_terms.citation` string, AS-CITED granularity (fix
// round 1 controller ruling, glossary plan Task 5 follow-up). Preserves a captured subsection
// (parseCitation's `subsection` field — see uscode.js) rather than collapsing every citation to
// section level: a bill citing "42 U.S.C. 1396b(i)" and one citing "42 U.S.C. 1396b" bare
// intentionally yield DISTINCT glossary_terms rows. Rationale (controller ruling, recorded here
// verbatim for the next reader): the design doc's own example term is section-specific ("Social
// Security Act, Sec. 1903"); a gloss of the actually-cited subsection is more relevant to that
// bill's reader than a gloss of the whole (possibly huge) section; dedup only splits when bills
// genuinely cite DIFFERENT subsections of the same section (a modest, accepted cost); and this
// changes cheaply now because 0007 is still unapplied and this extraction backfill has never run
// live — no data migration, no existing rows to reconcile. This is also what makes uscode.js's
// subsection-level oversize fallback (extractSubsectionText, gated on parseCitation re-resolving
// a subsection from THIS stored string) reachable at all from the live pipeline — see
// glosser.js's fetchGlossSource, which calls parseCitation on exactly this stored value. Pure:
// assumes citationRaw already parses (only ever called from the `by: 'citation'` branch below,
// which upsertKeyFor has already gated on parseCitation succeeding).
export function normalizeCitation(citationRaw) {
  const parsed = parseCitation(citationRaw);
  const base = `${parsed.title} U.S.C. ${parsed.section}`;
  return parsed.subsection ? `${base}(${parsed.subsection})` : base;
}

// ---- DB-facing helpers ----

async function findExistingGlossaryTerm(client, { kind, citation, term }) {
  let query = client.from(GLOSSARY_TERMS_TABLE).select('id').eq('kind', kind);
  query = citation === null ? query.is('citation', null).eq('term', term) : query.eq('citation', citation);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`${GLOSSARY_TERMS_TABLE} lookup failed: ${error.message}`);
  return data;
}

// upsertGlossaryTerm: branches per upsertKeyFor, and the two branches need DIFFERENT DB
// strategies to stay correct against Postgres's actual constraint shapes (real finding, not a
// style choice):
//
// - by:'citation' targets the base `unique (kind, citation)` constraint — a normal, non-partial
//   unique index, so insertIfAbsent's ON CONFLICT(kind,citation) DO NOTHING path (lib/db.js)
//   works exactly as it does everywhere else in this codebase.
// - by:'term' targets glossary_terms_unmapped_uidx, a PARTIAL unique index — `(kind, term) WHERE
//   citation IS NULL`. Postgres only lets ON CONFLICT infer a partial index when the conflict
//   clause repeats that index's own WHERE predicate; PostgREST's upsert `on_conflict` parameter
//   (what insertIfAbsent sends) is a bare column list with no way to express a WHERE clause, so
//   ON CONFLICT(kind,term) can never resolve to this partial index at all — Postgres would
//   reject it outright ("no unique or exclusion constraint matching"). This is the SAME shape as
//   ingest.js's findExistingTerm/upsertTerm working around a nullable start_date breaking
//   ON CONFLICT dedup: manual check-then-insert instead of insertIfAbsent for this branch only.
export async function upsertGlossaryTerm(client, runId, rawTerm) {
  const key = upsertKeyFor(rawTerm);
  const term = normalizeTermText(rawTerm.term);
  const kind = rawTerm.kind;

  if (key.by === 'citation') {
    const citation = normalizeCitation(rawTerm.citation_raw);
    await insertIfAbsent(client, GLOSSARY_TERMS_TABLE,
      [{ term, kind, citation, status: 'draft', needs_mapping: false, run_id: runId }], 'kind,citation');
    const existing = await findExistingGlossaryTerm(client, { kind, citation, term: null });
    if (!existing) throw new Error(`${GLOSSARY_TERMS_TABLE} row for ${kind}/${citation} missing immediately after upsert`);
    return existing.id;
  }

  const existing = await findExistingGlossaryTerm(client, { kind, citation: null, term });
  if (existing) return existing.id;
  const { data, error } = await client.from(GLOSSARY_TERMS_TABLE)
    .insert({ term, kind, citation: null, status: 'draft', needs_mapping: true, run_id: runId })
    .select('id').single();
  if (error) throw new Error(`${GLOSSARY_TERMS_TABLE} insert failed for ${kind}/"${term}": ${error.message}`);
  return data.id;
}

// persistReferencedTerms: for each {term, kind, citation_raw} in referencedTerms, upsert a
// glossary_terms stub and join it to summaryId via summary_terms — the exact loop body
// extract-terms.js's extractOne used to run inline, factored out so summarize.js can call the
// identical logic (see that file's createDraftSummary) instead of a second copy. Deliberately NO
// missing-relation tolerance here: that policy decision differs by caller (extract-terms.js wants
// to hard-fail before any model call even runs — see its own loadExtractedSummaryIds comment;
// summarize.js wants graceful degradation so a summary draft still succeeds — see that file's
// persistReferencedTermsGracefully), so it belongs at each call site, not baked into this shared
// mechanical layer.
export async function persistReferencedTerms(client, runId, { summaryId, referencedTerms }) {
  let termsUpserted = 0;
  for (const rawTerm of referencedTerms) {
    const termId = await upsertGlossaryTerm(client, runId, rawTerm);
    await insertIfAbsent(client, SUMMARY_TERMS_TABLE, [{ summary_id: summaryId, term_id: termId }], 'summary_id,term_id');
    termsUpserted += 1;
  }
  return { termsUpserted };
}
