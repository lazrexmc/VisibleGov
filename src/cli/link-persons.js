import {
  getClient, openRun, closeRun, selectAll, additivePatch,
} from '../lib/db.js';
import {
  clusterLegislators, pickDisplayName, rowNameVariantMatch, auditClusterCoherence,
} from '../lib/person-identity.js';

// link-persons — Task 1 of docs/superpowers/plans/2026-07-29-identity-merge.md. Loads every
// `legislators` row + every `terms` row (selectAll — the 1000-row lesson; legislators is at 1,576
// live, terms at 457), assembles per-row chamber/district/era evidence (terms rows AND per-source
// identity columns, both count — same division of labor as legiscan-identity.js's
// findCandidateLegislatorRows, just over the WHOLE table instead of one DB-narrowed lookup), then
// hands unlinked rows to src/lib/person-identity.js's clusterLegislators (the pure cluster pass).
// Unambiguous clusters get a new `persons` row (mechanical display-name precedence) + additive
// `legislators.person_id` + one `person_links` row per member, decided_by 'auto'. Anything short of
// a single coherent cluster writes an `identity_flags` row (check-then-insert on cluster_key,
// 23505-tolerant) and links nothing — the ledgered asymmetric-cost rule: wrong-merge is the
// unacceptable error class, missed-merge is benign. Already-linked rows (person_id already set,
// from a prior run) are skipped before clustering even runs, with an honest count. Zero model
// calls, zero external fetches. Migration 0012 is APPLIED live (verified 2026-07-29) — persons/
// person_links/identity_flags and legislators.person_id all exist; no draft-then-apply gating
// needed here the way legiscan-identity.js still gates on migration 0010.

const LEGISLATORS_TABLE = 'legislators';
const TERMS_TABLE = 'terms';
const PERSONS_TABLE = 'persons';
const PERSON_LINKS_TABLE = 'person_links';
const IDENTITY_FLAGS_TABLE = 'identity_flags';

export function parseArgs(argv) {
  const out = { dryRun: false };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') {
      out.dryRun = true;
      i += 1;
      continue;
    }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// ---- DB loads (plain selectAll — no filter needed, this pass is whole-table by design) ----

export async function loadLegislators(client) {
  const { data, error } = await selectAll(
    client,
    LEGISLATORS_TABLE,
    // nickname: 0013 (applied 2026-07-29) — source-printed only; clusterLegislators consumes it
    // as an exact-match given-name variant (the Robert/'Bob' Onder bridge).
    'id,full_name,surname,nickname,bioguide_id,openstates_id,mo_house_id,mo_senate_id,legiscan_people_id,person_id',
  );
  if (error) throw new Error(`${LEGISLATORS_TABLE} lookup failed: ${error.message}`);
  return data ?? [];
}

export async function loadTerms(client) {
  const { data, error } = await selectAll(
    client,
    TERMS_TABLE,
    'legislator_id,jurisdiction_id,chamber,district,start_date,end_date',
  );
  if (error) throw new Error(`${TERMS_TABLE} lookup failed: ${error.message}`);
  return data ?? [];
}

// ---- pure-ish assembly: legislators rows + terms rows -> clusterLegislators's own `rows` input ----

// partitionByLinkStatus — "already-linked skip", honestly counted (Global Constraints: "skip !=
// empty"). A row with a non-null person_id was linked by a PRIOR run (auto or Lance's review-tab
// adjudication, Task 2) — never re-clustered, never re-considered a candidate for anyone else's
// cluster either (it's simply excluded from the pool clusterLegislators ever sees).
export function partitionByLinkStatus(legislatorRows) {
  const unlinked = [];
  const alreadyLinked = [];
  for (const row of legislatorRows) {
    if (row.person_id != null) alreadyLinked.push(row);
    else unlinked.push(row);
  }
  return { unlinked, alreadyLinked };
}

// buildEvidenceRows — the DB-shape -> matcher-shape translation (findCandidateLegislatorRows's own
// division of labor, applied whole-table instead of one chamber/district-scoped lookup). Every
// `terms` row for a legislator becomes one evidence entry; mo_senate_id/mo_house_id (MO-only
// columns, migrations 0008/0005) contribute a SECOND, dateless evidence entry when set — "terms
// rows and identity columns both count" (plan doc, verbatim), never deduplicated against a
// matching terms row (redundant, not wrong: two evidence entries agreeing on the same seat is
// harmless, and NOT deduplicating keeps this function simple and honest about what it actually
// found rather than guessing the two describe the same underlying term).
export function buildEvidenceRows(legislatorRows, termRows) {
  const evidenceByLegislator = new Map(legislatorRows.map((row) => [row.id, []]));
  for (const t of termRows) {
    const list = evidenceByLegislator.get(t.legislator_id);
    if (!list) continue; // a terms row for a legislator outside this snapshot — defensive, not expected
    list.push({
      source: 'terms',
      jurisdiction_id: t.jurisdiction_id,
      chamber: t.chamber,
      district: t.district,
      start_date: t.start_date,
      end_date: t.end_date,
    });
  }
  for (const row of legislatorRows) {
    const list = evidenceByLegislator.get(row.id);
    if (row.mo_senate_id != null) {
      list.push({
        source: 'mo_senate_id', jurisdiction_id: 'mo-legislature', chamber: 'senate', district: row.mo_senate_id, start_date: null, end_date: null,
      });
    }
    if (row.mo_house_id != null) {
      list.push({
        source: 'mo_house_id', jurisdiction_id: 'mo-legislature', chamber: 'house', district: row.mo_house_id, start_date: null, end_date: null,
      });
    }
  }
  return legislatorRows.map((row) => ({ ...row, evidence: evidenceByLegislator.get(row.id) ?? [] }));
}

// ---- conflict guard (Global Constraints: "a non-null person_id is NEVER overwritten — conflict
// throws typed") ----

export class PersonLinkConflictError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PersonLinkConflictError';
    Object.assign(this, meta);
  }
}

// ClusterNameVariantViolationError — fix round 2's BELT: the review-server link path (Task 2)
// already requires Lance's own judgment before it writes anything, so it is exempt by design; the
// AUTO path (this file) is the one place a bug could silently write a wrong merge, so it is the
// one place this invariant is enforced STRUCTURALLY, not just behaviorally. clusterLegislators'
// own construction should make this unreachable (a clean 'compatible' cluster is only ever
// produced when every internal pair's names already matched — see finalPairStatus/
// auditClusterCoherence in src/lib/person-identity.js) — this is the second, independent layer:
// even if a future bug in the matcher ever produced a cluster that violates the invariant,
// writeAutoCluster refuses to write it rather than trusting the caller.
//
// NICKNAME AMENDMENT FIX ROUND 2 (controller-extended scope): the BELT check below now calls
// rowNameVariantMatch (row-shaped, nickname-aware) instead of the narrower, full_name-only
// fullNameVariantMatch it used before fix round 1 rewired clusterLegislators' own matcher onto
// pairwise printed-name-set intersection (nameSetEdgeBasis, src/lib/person-identity.js). This
// alignment matters: the BELT must validate EXACTLY the property clusterLegislators guarantees, or
// a real, matcher-legal, nickname-bridged 2-row cluster (e.g. a LegiScan row printing 'Robert
// Onder'/nickname 'Bob' directly bridging a plain 'Bob Onder' row) would wrongly fail this
// structural check and never write at all — a real availability gap, not a wrong-merge risk (the
// old, narrower check only ever fails SAFE, by refusing to write), but real now that migration
// 0013 is applied live and link-persons.js's own loadLegislators selects nickname. A
// residual_identical_name edge is exactly as valid for the BELT as a direct_name edge — the two
// kinds are ONLY distinguished for auditClusterCoherence's own operator-visibility reporting
// (clusterEdgeBasis/residualOnlyClusters); the BELT itself guards against INCOHERENCE (no shared
// printed name at all), never which kind of edge justified coherence.
export class ClusterNameVariantViolationError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ClusterNameVariantViolationError';
    Object.assign(this, meta);
  }
}

// ---- writes ----

// writeAutoCluster — persons insert (display-name precedence) + additivePatch person_id + one
// person_links row PER member, in that order, for one unambiguous cluster. Two validations run
// FIRST, before any write for this cluster happens at all — a single violation of either aborts
// the whole cluster cleanly, never a partially-linked person: (1) every member's person_id is
// null (PersonLinkConflictError otherwise); (2) fix round 2's BELT — every PAIR of members shares
// a name variant, nickname-aware (ClusterNameVariantViolationError otherwise; rowNameVariantMatch,
// see its own comment for the nickname-amendment-fix-round-2 alignment). `memberRowsById`: a
// Map(legislator_id -> the SAME row objects buildEvidenceRows produced) — the caller's snapshot,
// looked up by id so pickDisplayName and the per-member writes share one source of truth. Those
// same row objects (full_name + nickname, when loadLegislators selects it) are what feed
// rowNameVariantMatch below — no separate re-fetch or re-shaping needed.
export async function writeAutoCluster(client, runId, cluster, memberRowsById) {
  const memberRows = cluster.memberIds.map((id) => memberRowsById.get(id));
  for (const row of memberRows) {
    if (row.person_id != null) {
      throw new PersonLinkConflictError(
        `legislators.id=${row.id} already has person_id=${row.person_id} — refusing to link it into `
          + `cluster ${cluster.key} (a non-null person_id is never overwritten)`,
        { legislatorId: row.id, existingPersonId: row.person_id, clusterKey: cluster.key },
      );
    }
  }

  for (let a = 0; a < memberRows.length; a += 1) {
    for (let b = a + 1; b < memberRows.length; b += 1) {
      if (!rowNameVariantMatch(memberRows[a], memberRows[b])) {
        throw new ClusterNameVariantViolationError(
          `cluster ${cluster.key} pairs legislator_id=${memberRows[a].id} `
            + `("${memberRows[a].full_name}") with legislator_id=${memberRows[b].id} `
            + `("${memberRows[b].full_name}") — no name variant match between them (full name or `
            + 'source-printed nickname); refusing to write (the structural invariant every '
            + 'auto-cluster member pair must satisfy, fix round 2, nickname-aware as of fix round 2 '
            + 'of the nickname amendment)',
          {
            clusterKey: cluster.key, legislatorIdA: memberRows[a].id, legislatorIdB: memberRows[b].id,
          },
        );
      }
    }
  }

  const { display_name, display_name_source } = pickDisplayName(memberRows);
  const { data: person, error: insErr } = await client
    .from(PERSONS_TABLE)
    .insert({ display_name, display_name_source })
    .select('id')
    .single();
  if (insErr) throw new Error(`${PERSONS_TABLE} insert failed for cluster ${cluster.key}: ${insErr.message}`);
  const personId = person.id;

  for (let i = 0; i < memberRows.length; i += 1) {
    const row = memberRows[i];
    const patch = additivePatch(row, { person_id: personId });
    const { error: updErr } = await client.from(LEGISLATORS_TABLE).update(patch).eq('id', row.id);
    if (updErr) throw new Error(`legislators.person_id patch failed for id=${row.id}: ${updErr.message}`);

    const { error: linkErr } = await client.from(PERSON_LINKS_TABLE).insert({
      person_id: personId, legislator_id: row.id, evidence: cluster.evidence[i], decided_by: 'auto', run_id: runId,
    });
    if (linkErr) throw new Error(`${PERSON_LINKS_TABLE} insert failed for legislator_id=${row.id}: ${linkErr.message}`);
  }

  return { personId, memberCount: memberRows.length };
}

function isUniqueViolation(error) {
  return error?.code === '23505';
}

// writeIdentityFlag — check-then-insert on cluster_key (23505-tolerant), the SAME idempotency
// shape already established by legiscan-votes.js's findExistingReconciliationFlag/
// writeReconciliationFlag: an app-level check is the primary defense (single-process driver,
// race-safe enough per that precedent); a 23505 from a concurrent insert (should migration 0012
// ever gain a matching unique index the way 0011 backstopped vote_reconciliation_flags) is caught
// and treated identically to finding the row already there, never surfaced as an error. A re-run
// before Lance resolves a flag (Task 2) recomputes the SAME candidate set -> the SAME
// deterministic cluster_key -> correctly deduped, never a fresh duplicate.
export async function writeIdentityFlag(client, runId, flag) {
  const { data: existing, error: selErr } = await client
    .from(IDENTITY_FLAGS_TABLE)
    .select('id,cluster_key')
    .eq('cluster_key', flag.clusterKey)
    .maybeSingle();
  if (selErr) throw new Error(`${IDENTITY_FLAGS_TABLE} lookup failed for cluster_key=${flag.clusterKey}: ${selErr.message}`);
  if (existing) return { ...existing, deduped: true };

  const { data, error } = await client
    .from(IDENTITY_FLAGS_TABLE)
    .insert({
      cluster_key: flag.clusterKey,
      candidate_legislator_ids: flag.candidateIds,
      evidence: { reason: flag.reason, candidates: flag.evidence },
      run_id: runId,
    })
    .select('id,cluster_key')
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const { data: recheck, error: recheckErr } = await client
        .from(IDENTITY_FLAGS_TABLE)
        .select('id,cluster_key')
        .eq('cluster_key', flag.clusterKey)
        .maybeSingle();
      if (recheckErr) throw new Error(`${IDENTITY_FLAGS_TABLE} re-check failed for cluster_key=${flag.clusterKey}: ${recheckErr.message}`);
      if (recheck) return { ...recheck, deduped: true };
    }
    throw new Error(`${IDENTITY_FLAGS_TABLE} insert failed for cluster_key=${flag.clusterKey}: ${error.message}`);
  }
  return { ...data, deduped: false };
}

// ---- orchestration (the testable seam between argv/env-parsing main() and the actual work) ----

// runLink — dry-run mode does ONLY the three loads/pure-planning calls above and returns the full
// proposed clustering + honest counts; ZERO writes are even reachable from this branch (writeAutoCluster/
// writeIdentityFlag are never called). Live mode performs the writes and returns the same honest
// counts shape the plan's Global Constraints specify verbatim: {clusters, personsCreated, linked,
// flagged, alreadyLinked, singletons}. `coherenceAudit` (fix round 2): auditClusterCoherence run
// over the proposed clusters, on EVERY call (dry-run and live alike) — the permanent, visible
// mechanical double-check that every proposed cluster's member pairs share a full-name variant,
// independent of writeAutoCluster's own structural throw. Computed BEFORE any write, so a live run
// with coherenceAudit.ok === false would still hit writeAutoCluster's per-cluster throw on the
// offending cluster specifically — this audit is reported for every cluster at once, up front.
export async function runLink(client, { dryRun = false, runId = null } = {}) {
  const legislatorRows = await loadLegislators(client);
  const termRows = await loadTerms(client);
  const { unlinked, alreadyLinked } = partitionByLinkStatus(legislatorRows);
  const evidenceRows = buildEvidenceRows(unlinked, termRows);
  const { clusters, flagged, singletons } = clusterLegislators(evidenceRows);
  const coherenceAudit = auditClusterCoherence(clusters);

  const counts = {
    clusters: clusters.length,
    personsCreated: 0,
    linked: 0,
    flagged: flagged.length,
    alreadyLinked: alreadyLinked.length,
    singletons: singletons.length,
  };

  if (dryRun) {
    return {
      mode: 'dry-run', counts, clusters, flagged, singletons, coherenceAudit,
    };
  }

  const rowsById = new Map(evidenceRows.map((r) => [r.id, r]));
  let flaggedWritten = 0;
  let flaggedDeduped = 0;
  for (const cluster of clusters) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design, same precedent as
    // selectAll's own page loop: this is a batch CLI, not a request handler.
    await writeAutoCluster(client, runId, cluster, rowsById);
    counts.personsCreated += 1;
    counts.linked += cluster.memberIds.length;
  }
  for (const flag of flagged) {
    // eslint-disable-next-line no-await-in-loop
    const result = await writeIdentityFlag(client, runId, flag);
    if (result.deduped) flaggedDeduped += 1;
    else flaggedWritten += 1;
  }

  return {
    mode: 'live', counts, flaggedWritten, flaggedDeduped, coherenceAudit,
  };
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();
  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    const report = await runLink(client, { dryRun: true });
    // Fix round 2: coherenceAudit is a PERMANENT part of the dry-run report — the operator sees
    // this mechanical "every proposed cluster's members share a full-name variant" re-check before
    // any live run is ever considered, independent of the clustering logic's own guarantee.
    console.log(JSON.stringify({
      mode: 'dry-run',
      counts: report.counts,
      coherenceAudit: report.coherenceAudit,
      clusters: report.clusters.map((c) => ({ key: c.key, memberIds: c.memberIds })),
      flagged: report.flagged.map((f) => ({ clusterKey: f.clusterKey, candidateIds: f.candidateIds, reason: f.reason })),
      singletons: report.singletons,
    }, null, 2));
    if (!report.coherenceAudit.ok) {
      console.error('COHERENCE AUDIT FAILED — see coherenceAudit.violations above. Do not run live.');
      process.exitCode = 2;
    }
    return;
  }

  const runId = await openRun(client, 'link-persons');
  try {
    const report = await runLink(client, { dryRun: false, runId });
    await closeRun(client, runId, 'succeeded', {
      counts: report.counts, flaggedWritten: report.flaggedWritten, flaggedDeduped: report.flaggedDeduped,
    });
    console.log(JSON.stringify({
      mode: 'live', run_id: runId, ...report.counts, flaggedWritten: report.flaggedWritten, flaggedDeduped: report.flaggedDeduped, coherenceAudit: report.coherenceAudit,
    }, null, 2));
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
