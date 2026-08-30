// Verify WHICH MIGRATIONS ARE ACTUALLY APPLIED, by artifact — never by recollection or by a doc.
//
// WHY THIS EXISTS. This project has no migration ledger table. Applied state has therefore lived in
// prose, and prose drifts: on 2026-08-28 the migration count in CLAUDE.md was wrong for the FIFTH
// time, and one of those wrong statements ("0035 is PENDING") was committed and became false eight
// minutes later. The same morning the operator said he did not recall whether 0034 or 0035 had ever
// been run — a question no document could answer, because every document was a claim about the
// database rather than a reading of it.
//
// The rule this script mechanises is already in CLAUDE.md and PLAYBOOK_DELTA: verify at the origin;
// the convenient surface lies. A doc, a memory and a migration file are all convenient surfaces.
// The database is the origin.
//
// HOW IT WORKS. Every migration is paired with an ARTIFACT it must have created — a table, a view,
// a column, a policy outcome — and the artifact is probed live. Two tiers:
//
//   TIER 1 (always available, needs only SUPABASE_URL + the two keys already in .env):
//     PostgREST probes. Can see relations, columns, and what anon is allowed to read.
//
//   TIER 2 (only when SUPABASE_DB_URL is set — the same optional direct-Postgres path
//     scripts/verify-pg.mjs documents): pg_catalog probes. Can additionally see indexes, functions,
//     grants and view definitions.
//
// Tier 1 alone CANNOT see indexes, function bodies, role grants, or a view's text. Those migrations
// report `unverifiable (needs SQL)` rather than a guess — an honest unknown, never a silent pass.
// That distinction is the whole point: a checker that reports green on what it cannot see is worse
// than no checker (learned the same day, when the anti-join guard could not see a
// `create or replace view` migration and kept asserting against a superseded file).
//
// DRIFT IS AN ERROR, NOT A SILENCE. If a .sql file exists in supabase/migrations with no probe
// entry below, this script FAILS and names it. That is what stops the manifest rotting the way the
// prose did — adding a migration forces adding its probe.
//
// Read-only in every sense: only GET requests and read-only catalog queries. It cannot write.
//
// Usage:
//   node --env-file=.env scripts/verify-migrations.mjs
//   node --env-file=.env scripts/verify-migrations.mjs --json
//
// Exit code: 0 when every probeable migration is APPLIED; 1 when any is ABSENT or unprobed.
// `unverifiable` alone does not fail the run — it is reported and counted.

import { isRevokedResponse, isRpcDeniedResponse } from '../src/lib/anon-lock.js';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'supabase', 'migrations');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JSON_OUT = process.argv.includes('--json');

if (!SUPABASE_URL || !SERVICE) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Run with --env-file=.env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Probe primitives (Tier 1 — PostgREST)
// ---------------------------------------------------------------------------

async function rest(path, key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return { status: res.status, body: await res.text() };
}

// Does a relation (table, view or matview) exist? Probed with the SERVICE key so that "no grant"
// cannot be mistaken for "does not exist" — with anon those are both non-200 and the answer would
// be ambiguous.
async function relationExists(relation) {
  const { status } = await rest(`${relation}?select=*&limit=0`, SERVICE);
  if (status === 200) return 'applied';
  if (status === 404) return 'absent';
  return 'absent';
}

// Does a relation expose a column? PostgREST answers 400/42703 for an unknown column, which is a
// clean signal. Service key again, for the same disambiguation reason.
async function columnExists(relation, column) {
  const { status, body } = await rest(`${relation}?select=${column}&limit=0`, SERVICE);
  if (status === 200) return 'applied';
  if (status === 400 && /42703|does not exist|column/i.test(body)) return 'absent';
  if (status === 404) return 'absent';
  return 'absent';
}

// Can ANON read this relation? Used for the lock-down migrations, where the artifact is a REFUSAL
// rather than a thing — and it distinguishes THREE outcomes, not two, because the middle one is
// the whole point:
//
//   401 / 42501  -> `revoked`     the GRANT is gone. Anon is refused at the privilege layer.
//   200 with rows-> `open`        data is reachable. A lock-down migration did not take.
//   200 with []  -> `policy-only` the grant is STILL THERE; only the absence of an RLS policy is
//                                 holding the door. Nothing leaks today, and one
//                                 `disable row level security` during a late-night fix opens it.
//
// The Glizzness replication playbook states this exactly (§4.2, §8.7): "that REVOKE is the whole
// ballgame... if you get `200 []`, your REVOKE is missing and only RLS is holding the door."
// Collapsing `policy-only` into "fine" is how that lesson gets lost, so it is reported separately.
async function anonAccess(relation, expect) {
  const { status, body } = await rest(`${relation}?select=*&limit=1`, ANON);
  if (status !== 200) return expect === 'denied' ? 'applied' : 'absent';
  let rows = [];
  try { rows = JSON.parse(body); } catch { rows = []; }
  if (expect === 'denied') return rows.length > 0 ? 'absent' : 'policy-only';
  return 'applied';
}

// Is anon REVOKED at the privilege layer — a real 401/42501, not merely an empty result? This is
// the strict form of anonAccess: `policy-only` is a FAILURE here, because the whole point of a
// revoke migration is to move the protection from the policy layer to the privilege layer.
async function anonRevoked(relation) {
  const { status, body } = await rest(`${relation}?select=*&limit=1`, ANON);
  // Shared with scripts/probe-public-surface.js via src/lib/anon-lock.js. These two files
  // disagreed twice in one day (on `200 []`, and on 404) while each looked correct in isolation;
  // there is now one predicate rather than two that a test hopes are equivalent.
  if (isRevokedResponse(status, body)) return 'applied';
  // `200 []` here is ABSENT, not `policy-only`. For a revoke migration the empty result IS the
  // symptom: the grant is still there and the migration has not been applied. Reporting it as the
  // softer `policy-only` would let an unapplied migration exit 0 — which is precisely the question
  // this script was built to answer ("did 0034 ever actually run?").
  return 'absent';
}

// Can ANON still CALL a function by name over /rpc/? The right probe for an EXECUTE revoke, and
// it needs its own primitive because rest() above is GET-only while RPC is POST.
//
// The states are easy to mix up, so name them precisely:
//   400 + 0A000 "cannot display a value of type event_trigger"
//        -> anon HAS execute. PostgREST got far enough to try to serialise the return value and
//           choked on the pseudo-type. The grant is still live => the migration is ABSENT.
//   404 / 401 / 403 / 42501
//        -> anon cannot reach the function at all => APPLIED.
// Reading that 400 as "denied" would be the exact false-negative this script exists to prevent:
// the call is refused by a serializer accident, not by a privilege.
async function anonRpcDenied(fn) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.text();
  // src/lib/anon-lock.js's anonRpcState — deliberately NOT the same predicate as the table one
  // beside it: for an RPC, 404 IS denial (PostgREST hides a function the role cannot execute),
  // while for a table 404 is unexplained. The two live together there so that difference is
  // documented rather than looking like drift.
  if (isRpcDeniedResponse(res.status, body)) return 'applied';
  return 'absent';
}

// Can ANON read a SPECIFIC column? The right probe for column-scoping migrations: after 0025,
// `select=*` on summaries returns 401/42501 (there is no table-wide grant any more) while
// `select=bill_id` returns 200. Probing with `*` there reports a false MISSING — the 401 is
// evidence the migration WORKED, not that it is absent. (Caught on this script's first run.)
async function anonColumnReadable(relation, column) {
  const { status } = await rest(`${relation}?select=${column}&limit=1`, ANON);
  return status === 200 ? 'applied' : 'absent';
}

// Does a table hold rows? For seed migrations, whose artifact is data rather than structure.
async function hasRows(relation) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${relation}?select=*&limit=1`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  if (res.status !== 200) return 'absent';
  const rows = JSON.parse(await res.text());
  return rows.length > 0 ? 'applied' : 'absent';
}

// ---------------------------------------------------------------------------
// Probe primitives (Tier 2 — direct Postgres, only when SUPABASE_DB_URL is set)
// ---------------------------------------------------------------------------

let pg = null;
async function pgReady() {
  if (pg !== null) return pg;
  if (!process.env.SUPABASE_DB_URL) { pg = false; return false; }
  try {
    const mod = await import('../src/lib/pg.js');
    pg = mod.getPgPool() ? mod : false;
  } catch {
    pg = false;
  }
  return pg;
}

async function sqlScalarTrue(query) {
  const mod = await pgReady();
  if (!mod) return 'unverifiable';
  const rows = await mod.pgQuery(query);
  const v = rows?.[0] ? Object.values(rows[0])[0] : false;
  return v ? 'applied' : 'absent';
}

const indexExists = (name) => sqlScalarTrue(
  `select exists (select 1 from pg_indexes where schemaname='public' and indexname='${name}')`);
const functionExists = (name) => sqlScalarTrue(
  `select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='${name}')`);
const viewDefMatches = (view, needle) => sqlScalarTrue(
  `select pg_get_viewdef('public.${view}'::regclass, true) ilike '%${needle}%'`);
const roleLacksExecute = (role, sig) => sqlScalarTrue(
  `select not has_function_privilege('${role}', '${sig}', 'execute')`);

// ---------------------------------------------------------------------------
// THE MANIFEST — one entry per migration file. A file with no entry FAILS the run.
//
// `artifact` is what the migration must have created. `why` is only present where the choice of
// artifact needs explaining (a later migration redefining the same object, an artifact that is a
// refusal rather than a thing).
// ---------------------------------------------------------------------------

const PROBES = {
  '0001_core_schema.sql':                                    { artifact: 'table bills',                    run: () => relationExists('bills') },
  '0002_seed_jurisdictions.sql':                             { artifact: 'jurisdictions has rows',         run: () => hasRows('jurisdictions'), why: 'a seed migration: its artifact is data, not structure' },
  '0003_summary_notes_freshness.sql':                        { artifact: 'table summary_notes',            run: () => relationExists('summary_notes') },
  '0004_summary_verifications.sql':                          { artifact: 'table summary_verifications',    run: () => relationExists('summary_verifications') },
  '0005_mo_house_id.sql':                                    { artifact: 'legislators.mo_house_id',        run: () => columnExists('legislators', 'mo_house_id') },
  '0006_legislators_surname.sql':                            { artifact: 'legislators.surname',            run: () => columnExists('legislators', 'surname') },
  '0007_glossary.sql':                                       { artifact: 'table glossary_terms',           run: () => relationExists('glossary_terms') },
  '0008_mo_senate_id.sql':                                   { artifact: 'legislators.mo_senate_id',       run: () => columnExists('legislators', 'mo_senate_id') },
  '0009_mo_senate_id_nonunique.sql':                         { artifact: 'index legislators_mo_senate_id_idx', run: () => indexExists('legislators_mo_senate_id_idx') },
  '0010_legiscan_identity_and_ledger.sql':                   { artifact: 'table legiscan_datasets',        run: () => relationExists('legiscan_datasets') },
  '0011_flag_idempotency.sql':                               { artifact: 'index vote_reconciliation_flags_dedup_key', run: () => indexExists('vote_reconciliation_flags_dedup_key') },
  '0012_identity_merge.sql':                                 { artifact: 'table persons',                  run: () => relationExists('persons') },
  '0013_nickname.sql':                                       { artifact: 'legislators.nickname',           run: () => columnExists('legislators', 'nickname') },
  '0014_bill_sponsors.sql':                                  { artifact: 'table bill_sponsors',            run: () => relationExists('bill_sponsors') },
  '0015_sponsor_types.sql':                                  { artifact: 'bill_sponsors accepts sponsor_type', run: () => columnExists('bill_sponsors', 'sponsor_type'), why: 'widens a check constraint; the column is the closest observable artifact — the constraint itself needs Tier 2' },
  '0016_public_read_surface.sql':                            { artifact: 'view public_vote_feed',          run: () => relationExists('public_vote_feed') },
  '0017_vote_casts_legislator_index.sql':                    { artifact: 'index vote_casts_legislator_id_idx', run: () => indexExists('vote_casts_legislator_id_idx') },
  '0018_vote_aggregates.sql':                                { artifact: 'matview public_position_totals', run: () => relationExists('public_position_totals') },
  '0018a_refresh_timeout.sql':                               { artifact: 'refresh_vote_aggregates exists', run: () => functionExists('refresh_vote_aggregates'), why: 'sets a statement_timeout inside the function; only the function itself is observable, and 0026/0027 supersede its body' },
  '0019_view_scoping_and_freshness.sql':                     { artifact: 'view public_freshness',          run: () => relationExists('public_freshness') },
  '0020_completeness_checks.sql':                            { artifact: 'summary_verifications.kind',     run: () => columnExists('summary_verifications', 'kind') },
  '0021_bullet_citations.sql':                               { artifact: 'view public_verification_notes', run: () => relationExists('public_verification_notes'), why: '0019/0020/0021 all redefine this view; existence is the shared artifact, the 0021 body needs Tier 2' },
  '0022_vote_duplicates.sql':                                { artifact: 'table vote_duplicates',          run: () => relationExists('vote_duplicates') },
  '0023_vote_duplicates_rls_and_view_drift.sql':             { artifact: 'view public_votes',              run: () => relationExists('public_votes') },
  '0024_lock_down_legiscan_datasets.sql':                    { artifact: 'anon DENIED on legiscan_datasets', run: () => anonAccess('legiscan_datasets', 'denied'), why: 'the artifact is a refusal: a 200 here means the lock-down is missing' },
  '0025_scope_summaries_glossary_columns.sql':               { artifact: 'anon reads summaries.bill_id but not *', run: () => anonColumnReadable('summaries', 'bill_id'), why: 'column-scoped: select=* now returns 401/42501 and a single granted column returns 200 — probing with * reports a FALSE MISSING' },
  '0026_fix_refresh_aggregates_timeout_regression.sql':      { artifact: 'function refresh_vote_aggregates', run: () => functionExists('refresh_vote_aggregates'), why: 'replaces the function BODY; Tier 1 cannot see bodies at all' },
  '0027_pg_cron_refresh_aggregates.sql':                     { artifact: 'function refresh_vote_aggregates', run: () => functionExists('refresh_vote_aggregates'), why: 'schedules pg_cron; the schedule itself is not observable from either tier here' },
  '0028_fix_statement_timeout_arm_timing.sql':               { artifact: 'function refresh_vote_aggregates', run: () => functionExists('refresh_vote_aggregates'), why: 'a body-only fix — indistinguishable from 0026/0027 without reading the source' },
  '0029_fix_vote_duplicates_antijoin_planner_misestimate.sql': { artifact: 'matview public_party_alignment', run: () => relationExists('public_party_alignment') },
  '0030_revoke_refresh_aggregates_from_authenticated.sql':   { artifact: 'authenticated lacks EXECUTE',    run: () => roleLacksExecute('authenticated', 'public.refresh_vote_aggregates()'), why: 'a revoke: only visible to Tier 2' },
  '0031_fix_public_views_antijoin_planner_misestimate.sql':  { artifact: 'public_votes uses NOT EXISTS',   run: () => viewDefMatches('public_votes', 'NOT (EXISTS'), why: 'Postgres renders the anti-join as NOT (EXISTS (...)) — matching bare "NOT EXISTS" gives a FALSE NEGATIVE, as it did on 2026-08-28' },
  '0032_vote_date_provenance.sql':                           { artifact: 'votes.vote_date_provenance',     run: () => columnExists('votes', 'vote_date_provenance') },
  '0033_retracted_votes.sql':                                { artifact: 'table retracted_votes',          run: () => relationExists('retracted_votes') },
  '0034_bill_page_indexes.sql':                              { artifact: 'index votes_bill_id_vote_date_idx', run: () => indexExists('votes_bill_id_vote_date_idx') },
  '0035_expose_vote_date_provenance.sql':                    { artifact: 'public_vote_feed.vote_date_provenance', run: () => columnExists('public_vote_feed', 'vote_date_provenance') },
  '0036_revoke_internal_tables_from_anon.sql':               { artifact: 'anon REVOKED (401/42501) on legiscan_datasets', run: () => anonRevoked('legiscan_datasets'), why: 'strict: `200 []` is policy-only and FAILS here — moving the protection to the privilege layer is the entire point of this migration' },
  '0037_revoke_bill_texts_from_anon.sql':                    { artifact: 'anon REVOKED (401/42501) on bill_texts', run: () => anonRevoked('bill_texts'), why: 'the rls-probe found bill_texts still anon-readable AFTER 0036 closed the other three; same strict rule — `200 []` is policy-only and FAILS. Safe to revoke because no site code reads bill_texts: the public surface serves the plain-language SUMMARY, never the raw text.' },
  '0038_lock_down_rls_auto_enable.sql':                      { artifact: 'anon cannot call rpc/rls_auto_enable', run: () => anonRpcDenied('rls_auto_enable'), why: 'a SECURITY DEFINER function that runs DDL had EXECUTE granted to PUBLIC. Not exploitable today only because its event_trigger return type makes PostgREST refuse it with 400 — a serializer accident, not a privilege. This migration ALSO codifies the ensure_rls trigger itself, which existed only in the live database and would have been missing from any rebuild.' },
};

// ---------------------------------------------------------------------------

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const unprobed = files.filter((f) => !PROBES[f]);
const orphaned = Object.keys(PROBES).filter((f) => !files.includes(f));

const results = [];
for (const file of files) {
  const probe = PROBES[file];
  if (!probe) continue;
  let state;
  try {
    state = await probe.run();
  } catch (err) {
    state = 'error';
    probe.error = err?.message ?? String(err);
  }
  results.push({ file, artifact: probe.artifact, state, why: probe.why ?? null, error: probe.error ?? null });
}

const tier2 = Boolean(await pgReady());
const counts = results.reduce((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {});
const applied = counts.applied ?? 0;
const absent = counts.absent ?? 0;
const unverifiable = counts.unverifiable ?? 0;
const errored = counts.error ?? 0;
const policyOnly = counts['policy-only'] ?? 0;

if (JSON_OUT) {
  console.log(JSON.stringify({ tier2, counts, unprobed, orphaned, results }, null, 2));
} else {
  const MARK = { applied: 'OK ', absent: 'MISSING', unverifiable: '?  ', error: 'ERR', 'policy-only': 'POLICY-ONLY' };
  console.log(`\nMigration applied-state — verified by artifact against the live database`);
  console.log(`Tier 2 (direct Postgres: indexes, functions, grants, view bodies): ${tier2 ? 'ENABLED' : 'OFF — set SUPABASE_DB_URL to enable'}\n`);
  for (const r of results) {
    console.log(`  ${MARK[r.state].padEnd(8)} ${r.file.replace('.sql', '').padEnd(56)} ${r.artifact}`);
    if (r.why && r.state !== 'applied') console.log(`           ${' '.repeat(56)} ${r.why}`);
    if (r.state === 'policy-only') console.log(`           ${' '.repeat(56)} anon still holds the GRANT; only the missing RLS policy is holding the door (200 []).`);
    if (r.error) console.log(`           ${' '.repeat(56)} error: ${r.error}`);
  }
  console.log(`\n  ${results.length} migrations probed — ${applied} applied, ${absent} MISSING, `
    + `${policyOnly} policy-only, `
    + `${unverifiable} unverifiable${tier2 ? '' : ' (Tier 2 off)'}, ${errored} errored`);
  // The counts must account for every probed migration. A summary that silently drops a state is
  // the same failure this whole script exists to prevent.
  const accounted = applied + absent + policyOnly + unverifiable + errored;
  if (accounted !== results.length) {
    console.log(`\n  BUG IN THIS SCRIPT: ${results.length} probed but only ${accounted} accounted `
      + `for in the summary — a state is being dropped. States seen: ${Object.keys(counts).join(', ')}`);
  }
  if (policyOnly) {
    console.log(`\n  POLICY-ONLY is neither a pass nor a leak. Nothing is exposed today, but the`);
    console.log(`  protection is an ABSENT POLICY rather than a revoked grant — one RLS toggle from open.`);
  }
  if (unprobed.length) {
    console.log(`\n  DRIFT: ${unprobed.length} migration file(s) have no probe in this script:`);
    for (const f of unprobed) console.log(`    - ${f}`);
    console.log('  Add an entry to PROBES. An unprobed migration is an unverified claim.');
  }
  if (orphaned.length) {
    console.log(`\n  DRIFT: ${orphaned.length} probe(s) name a file that no longer exists:`);
    for (const f of orphaned) console.log(`    - ${f}`);
  }
  console.log('');
}

// Gate on the extracted counts, never on the absence of a thrown error (PLAYBOOK_DELTA lesson 14).
// policy-only is reported loudly but does not fail the run: nothing is exposed, and the fix is a
// deliberate migration rather than an emergency.
const failed = absent > 0 || errored > 0 || unprobed.length > 0 || orphaned.length > 0;
process.exit(failed ? 1 : 0);
