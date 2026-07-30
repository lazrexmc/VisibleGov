import {
  getClient, openRun, closeRun, selectAll, additivePatch,
} from '../lib/db.js';
import {
  clusterLegislators, pickDisplayName, rowNameVariantMatch, auditClusterCoherence,
  surnameKey, finalPairStatus, buildMemberEvidence,
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

// loadIdentityFlags — final wave item 2: EVERY identity_flags row (resolved or not; a
// keep-separate resolution only ever exists on a resolved flag — src/review/server.js's
// handleIdentityDecision sets resolved:true unconditionally on that action — but this reads all of
// them anyway rather than adding a resolved-only filter, since the resolutions HISTORY is what
// matters, not the flag's current top-level state). No filter needed — whole-table by design, the
// same convention as loadLegislators/loadTerms.
export async function loadIdentityFlags(client) {
  const { data, error } = await selectAll(client, IDENTITY_FLAGS_TABLE, 'id,cluster_key,evidence');
  if (error) throw new Error(`${IDENTITY_FLAGS_TABLE} lookup failed: ${error.message}`);
  return data ?? [];
}

// loadPersons — Task 4 (attach-to-existing): every existing `persons` row's own display_name, the
// EXACT text an attach_candidate flag's evidence must cite ("evidence carries the existing
// person_id + display_name", the brief's own words) — never re-derived via pickDisplayName over
// the person's member rows, which would risk silently disagreeing with the actual persisted value
// (e.g. if a future correction path ever hand-edits display_name directly). selectAll — whole-table
// by design, same convention as loadLegislators/loadTerms/loadIdentityFlags (persons is small,
// 7 rows live today, nowhere near the 1000-row cap, but the convention is followed regardless).
export async function loadPersons(client) {
  const { data, error } = await selectAll(client, PERSONS_TABLE, 'id,display_name');
  if (error) throw new Error(`${PERSONS_TABLE} lookup failed: ${error.message}`);
  return new Map((data ?? []).map((p) => [p.id, p.display_name]));
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

// ---- keep-separate ruling enforcement (final wave, item 2): binds the AUTO path to Lance's own
// prior review-tab decisions, not just the matcher's own current verdict ----

function pairKey(idA, idB) {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

// buildKeepSeparatePairs — scans every identity_flags row's `evidence.resolutions` (the append-
// only per-decision audit trail src/review/server.js's handleIdentityDecision writes via its own
// appendResolution) for 'keep-separate' entries, and returns a Map keyed on every LEGISLATOR-ID
// PAIR named in that resolution's own `legislatorIds` array — deliberately NOT keyed on
// cluster_key. A flag's cluster_key is derived from the candidate id SET at the moment it was
// created (buildClusterKey, src/lib/person-identity.js) and can drift across runs (the ledgered
// cluster_key-drift note, progress.md) — the actual ruling Lance made was about SPECIFIC ROWS,
// never a cluster_key string, so keying on cluster_key would silently stop protecting the exact
// pair Lance ruled on the moment anything about the surrounding group's membership changed. This
// binds unconditionally: even if a LATER run's matcher verdict changes (e.g. a newly-backfilled
// nickname makes a previously name-incompatible pair suddenly read 'compatible'), Lance's own
// keep-separate ruling on that specific pair still overrides it.
//
// FINAL WHOLE-BRANCH REVIEW, finding 3: a resolution may instead carry an EXPLICIT
// `legislatorIdPairs` array ([[a, b], ...]) — written by src/review/server.js when the flag being
// resolved is an attach_candidate flag. That case cannot be expressed as a cross-product over one
// flat id list: the ruling is "each still-unlinked candidate is NOT a member of person P", which
// pairs candidates against the TARGET PERSON'S members (rows that are already linked and therefore
// never appear in legislatorIds at all) while saying nothing whatever about whether two candidates
// are each other. When the explicit list is present it is AUTHORITATIVE and the cross-product is
// not applied — recording a candidate-x-candidate pair as a side effect of a decision about P
// would permanently block a merge Lance never ruled on.
export function buildKeepSeparatePairs(identityFlagsRows) {
  const pairs = new Map();
  const record = (flag, resolution, idA, idB) => {
    const key = pairKey(idA, idB);
    if (pairs.has(key)) return;
    pairs.set(key, {
      flagId: flag.id,
      clusterKey: flag.cluster_key ?? null,
      note: resolution.note ?? null,
      decidedAt: resolution.decidedAt ?? null,
      legislatorIdA: idA,
      legislatorIdB: idB,
    });
  };
  for (const flag of identityFlagsRows ?? []) {
    const resolutions = flag?.evidence?.resolutions;
    if (!Array.isArray(resolutions)) continue;
    for (const resolution of resolutions) {
      if (resolution?.action !== 'keep-separate') continue;
      if (Array.isArray(resolution.legislatorIdPairs)) {
        for (const pair of resolution.legislatorIdPairs) {
          if (!Array.isArray(pair) || pair.length !== 2 || pair[0] == null || pair[1] == null) continue;
          record(flag, resolution, pair[0], pair[1]);
        }
        continue;
      }
      const ids = Array.isArray(resolution.legislatorIds) ? resolution.legislatorIds : [];
      for (let a = 0; a < ids.length; a += 1) {
        for (let b = a + 1; b < ids.length; b += 1) {
          record(flag, resolution, ids[a], ids[b]);
        }
      }
    }
  }
  return pairs;
}

// findKeepSeparateConflict — the first member pair of a proposed cluster's memberIds that matches
// a keep-separate ruling, or null. Only the first is ever cited — a cluster hitting more than one
// conflicting pair is still exactly one downgrade decision (flag the whole cluster), never a
// per-pair one.
export function findKeepSeparateConflict(memberIds, keepSeparatePairs) {
  for (let a = 0; a < memberIds.length; a += 1) {
    for (let b = a + 1; b < memberIds.length; b += 1) {
      const key = pairKey(memberIds[a], memberIds[b]);
      if (keepSeparatePairs.has(key)) return keepSeparatePairs.get(key);
    }
  }
  return null;
}

// applyKeepSeparateRulings — runs BEFORE writeAutoCluster ever sees a cluster (runLink calls this
// immediately after clusterLegislators, ahead of both the dry-run report and the live write loop):
// partitions clusterLegislators' own `clusters` output into ones still safe to auto-write and ones
// a keep-separate ruling now vetoes. A vetoed cluster is downgraded to a flag — never silently
// dropped, never silently written — carrying the SAME per-member evidence clusterLegislators
// already built, reason 'conflicts_with_keep_separate_ruling', plus the specific ruling that
// blocked it (flagId/clusterKey/note/decidedAt/the exact pair): Lance's own prior words are cited
// directly in what Lance sees next, never just a bare reason code.
export function applyKeepSeparateRulings(clusters, keepSeparatePairs) {
  const cleanClusters = [];
  const downgradedFlags = [];
  for (const cluster of clusters) {
    const conflict = findKeepSeparateConflict(cluster.memberIds, keepSeparatePairs);
    if (conflict) {
      downgradedFlags.push({
        clusterKey: cluster.key,
        candidateIds: cluster.memberIds,
        evidence: cluster.evidence,
        reason: 'conflicts_with_keep_separate_ruling',
        keepSeparateRuling: conflict,
      });
    } else {
      cleanClusters.push(cluster);
    }
  }
  return { cleanClusters, downgradedFlags };
}

// ---- attach pass (Task 4, .superpowers/sdd/2026-07-29-profile-completeness/task-4-brief.md):
// the identity system's missing path. Every prior wave only ever compared UNLINKED rows against
// OTHER unlinked rows in the SAME batch (clusterLegislators, above) — a returning legislator whose
// new session/source row arrives ALONE (no sibling unlinked row to pair with in this run, which is
// the deadline scenario itself: the Jan 2027 session rollover mints one fresh row per returning
// legislator, each alone) never had anything to compare against and simply stayed a singleton
// forever, never rejoining the person they already belong to. This pass closes that gap: every
// SINGLETON unlinked row (clusterLegislators' own `singletons` output — deliberately scoped this
// narrowly, not every unlinked row; a row that already found a same-run cluster partner or landed
// in a matcher flag has its own resolution path already in flight, and folding it into attach too
// would risk presenting Lance two competing, confusing suggestions for the same row in the same
// run) is compared against every ALREADY-LINKED person's member rows, using finalPairStatus — the
// SAME pairwise matcher + evidence-compatibility rules clusterLegislators itself uses (Global
// Constraints: "reuse matcher primitives verbatim — no parallel matching logic"). NEVER
// auto-attaches: a qualifying match only ever emits an attach_candidate identity_flag; Lance's own
// 'attach' decision (src/review/server.js) is the sole place person_id is written for this path.

// groupAlreadyLinkedByPerson — pure re-shaping, zero matching: already-linked rows (buildEvidenceRows
// -shaped, each carrying its own `.evidence` array) bucketed by person_id.
export function groupAlreadyLinkedByPerson(alreadyLinkedRows) {
  const groups = new Map();
  for (const row of alreadyLinkedRows ?? []) {
    if (row.person_id == null) continue; // defensive — every row this function is ever called with is already-linked by construction
    if (!groups.has(row.person_id)) groups.set(row.person_id, []);
    groups.get(row.person_id).push(row);
  }
  return groups;
}

// buildAttachCandidates — the pure matcher core. surnameKey pre-filters exactly the way
// clusterLegislators' own grouping does (a broad, permissive gate — finalPairStatus is the real
// narrowing); a person P qualifies as an attach TARGET for singleton row X iff: (a) NO member of P
// returns 'contradiction' against X (a hard structural fact vetoes the whole person outright, never
// partially — the same doctrine as a cluster-internal contradiction flagging the whole group); (b)
// at least one member of P returns 'compatible' against X; and (c) no keep-separate ruling
// (buildKeepSeparatePairs) exists between X and ANY member of P — final-wave item 2's own binding,
// extended to gate this new path exactly as it already gates the auto-cluster path. A ruling
// against even ONE member vetoes the whole person, never just that member: every member of an
// already-linked person is, by construction, the SAME person, so "X is not Y" is transitively "X
// is not P" regardless of how X compares to P's OTHER members.
//
// FIX ROUND 1, CRITICAL 3 (reviewer execution-proven, "DYNASTY ATTACH TRAP" — executed with the
// real Bayh shape; the operator already mis-clicked this exact family once, in the live
// identity-merge adjudication this module's own ledger records): 'ambiguous' used to ALSO qualify
// as a matched edge here — but 'ambiguous' is finalPairStatus's own verdict for EXACTLY the
// same-seat, different-given-name dynasty shape (real comparable seat evidence, names do NOT
// match — see finalPairStatus's own doc comment) as well as the same-name-but-non-overlapping-era
// shape. Treating either as license for a person-TARGETED suggestion (pointing Lance at one
// specific family member's person) is the trap: a fresh dynasty singleton (a new "Evan Bayh" row)
// would get suggested as "attach to [Birch Bayh's person]" on nothing but a shared surname/seat,
// exactly the wrong-merge risk this module exists to prevent, just moved one layer up from
// auto-cluster into the suggestion itself. RULING (unambiguous): attach candidacy requires
// 'compatible' ONLY — never 'ambiguous'. Because 'compatible' is only ever reachable when
// finalPairStatus's own unconditional full-name-variant gate is satisfied (rowNameVariantMatch),
// this ALSO structurally closes the "new row id has no keep-separate ruling on file yet" gap for
// the dynasty class for free: a fresh row nobody has ever adjudicated before (so keepSeparatePairs
// has nothing to block on) still can never generate a targeted suggestion against a differently-
// given-named family member, because differing given names can never produce 'compatible' in the
// first place (they read 'ambiguous' or 'no-pair', both excluded here) — no reliance on a
// keep-separate ruling existing at all. 'ambiguous' and 'no-pair' both fall through silently below:
// neither blocks the person (unlike 'contradiction') nor contributes a qualifying edge (unlike
// 'compatible').
// MissingMemberRowError — ROUND 2, R2-3: a legislator id with no row in the caller's snapshot.
// Previously this degraded silently: `surnameKey(undefined)` returns '' (the function is defensively
// tolerant), so evaluateRowAgainstPerson's own no-derivable-name branch swallowed the miss and the
// row contributed neither a veto nor a match — on the ONE path in this module whose failure mode is
// a wrong merge. A snapshot that cannot produce a row for a cluster member it is currently
// clustering is a bug in the caller, not a data condition to tolerate; it fails loud.
export class MissingMemberRowError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'MissingMemberRowError';
    Object.assign(this, meta);
  }
}

// evaluateRowAgainstPerson — FINAL WHOLE-BRANCH REVIEW, findings 1 & 2 (.superpowers/sdd/
// 2026-07-29-profile-completeness/final-review-findings.md): the ONE shared (candidate row × one
// already-linked person's members) verdict. It was previously inlined here and NOT in
// applyAttachCrossCheck's own demotion path — which is exactly how the demotion path ended up
// qualifying a person on a single 'compatible' edge while never testing for 'contradiction'
// (finding 1) and never seeing keepSeparatePairs at all (finding 2). Both attach paths now call
// THIS function and nothing else, so "a contradiction against ANY member vetoes the whole person"
// and "a ruling against ANY member vetoes the whole person" can never again be true on one path
// and false on the other. Returns, for one candidate row against one person:
//   { ruling, contradicted, matchedMembers }
// where `ruling` is the specific keep-separate ruling that blocks this person (null if none),
// `contradicted` is true iff any same-surname-key member hard-contradicts the row, and
// `matchedMembers` are the 'compatible' edges (empty unless the row qualifies on its own).
// 'ambiguous'/'no-pair' fall through silently: neither blocks the person nor contributes an edge
// (fix round 1 CRITICAL 3's compatible-only doctrine, unchanged).
//
// ROUND 2, R2-2 (re-review, execution-proven with the real Mary Bono / Mary Bono Mack shape): the
// surname-key prefilter is now applied to MATCH QUALIFICATION ONLY. Both VETOES consult EVERY member
// of the person, unfiltered. The prefilter is a name-shaped heuristic, and a person's own members
// routinely do NOT share a surname key — a legislator whose printed name gained a second surname
// mid-career ('Mary Bono' + 'Mary Bono Mack') keys to 'bono' on one row and 'mack' on the other. The
// differently-surnamed row is still, by construction, the SAME PERSON, so a hard seat contradiction
// against it ('Mary Bono Mack' holds CA-44; the fresh row holds CA-45) is exactly as disqualifying
// as one against a same-keyed member, and a keep-separate ruling naming it is exactly as binding.
// Filtering those out was hiding recorded facts from the veto. Widening the veto set can only ever
// produce FEWER suggestions and FEWER demotions — it fails toward flags and duplicate persons, the
// safe direction. Match qualification keeps the prefilter because there it is a permissive gate on
// finding a reason to pair (the same role it plays in clusterLegislators' own grouping), not a gate
// on hearing a reason not to.
function evaluateRowAgainstPerson(row, members, keepSeparatePairs) {
  if (!row) {
    // R2-3: never silently degrade here — see MissingMemberRowError's own comment.
    throw new MissingMemberRowError(
      'evaluateRowAgainstPerson was handed no row — a legislator id with no row in the caller\'s '
        + 'snapshot cannot be compared against anything, and silently returning "no verdict" would '
        + 'drop both of this row\'s vetoes on a wrong-merge-adjacent path',
    );
  }

  // ---- vetoes: EVERY member, unfiltered (R2-2) ----
  for (const member of members) {
    const ruling = keepSeparatePairs.get(pairKey(row.id, member.id));
    if (ruling) return { ruling, contradicted: false, matchedMembers: [] };
  }

  // ---- one pass: contradiction vetoes on any member; compatible edges count only for
  // same-surname-key members (the retained match-qualification prefilter) ----
  const key = surnameKey(row);
  const matchedMembers = [];
  for (const member of members) {
    const status = finalPairStatus(row, member);
    if (status === 'contradiction') return { ruling: null, contradicted: true, matchedMembers: [] };
    // `key &&`: a row with no derivable name at all can never qualify as a candidate (same as
    // clusterLegislators' own singleton sweep) — but it can still be vetoed above, which is why the
    // name check no longer short-circuits the whole function.
    if (status === 'compatible' && key && surnameKey(member) === key) {
      matchedMembers.push({ legislatorId: member.id, fullName: member.full_name, status });
    }
  }
  return { ruling: null, contradicted: false, matchedMembers };
}

export function buildAttachCandidates(singletonRows, alreadyLinkedRows, keepSeparatePairs) {
  const personGroups = groupAlreadyLinkedByPerson(alreadyLinkedRows);
  const results = [];
  for (const singleton of singletonRows ?? []) {
    for (const [personId, members] of personGroups) {
      const { ruling, contradicted, matchedMembers } = evaluateRowAgainstPerson(singleton, members, keepSeparatePairs);
      if (ruling || contradicted || matchedMembers.length === 0) continue;
      results.push({ legislatorId: singleton.id, personId, matchedMembers });
    }
  }
  return results;
}

// buildAttachClusterKey — deterministic over (personId(s), candidate id SET), the same
// buildClusterKey-shaped convention used everywhere else in this file, prefixed 'attach:' so it can
// never collide with a normal surname-keyed cluster_key. Micro-round (re-review, information-gap
// finding): `personIdOrIds` accepts EITHER a single personId string (buildAttachFlags' own call
// shape — one flag always targets exactly one person there, by construction) OR an array of
// personIds (applyAttachCrossCheck's own call shape, below, when a demoted cluster matches MORE
// than one existing person) — sorted+joined either way, so a single-element array produces the
// IDENTICAL string a bare string would (`['p1'].sort().join('+')` === `'p1'`), a deliberate
// backward-compatible collapse, not a coincidence.
function buildAttachClusterKey(personIdOrIds, candidateIds) {
  const personPart = Array.isArray(personIdOrIds) ? [...personIdOrIds].sort().join('+') : personIdOrIds;
  return `attach:${personPart}:${[...candidateIds].sort().join(',')}`;
}

// buildExistingPersonRefs — pure shaping helper: personIds -> [{personId, displayName}, ...],
// display_name cited directly from loadPersons' own map, never re-derived. Shared by buildAttachFlags
// and applyAttachCrossCheck so the two paths can never drift on how this shape is built.
function buildExistingPersonRefs(personIds, personDisplayNameById) {
  return personIds.map((personId) => ({ personId, displayName: personDisplayNameById.get(personId) ?? null }));
}

// buildAttachFlags — groups buildAttachCandidates' own (singleton, person) pairs BY person (one
// attach_candidate flag per already-linked person with 1+ qualifying new candidates, not one flag
// per pair — mirrors 'link's own per-subset review shape: Lance sees every currently-qualifying
// candidate for a person side by side and picks which, if any, actually belong). Each candidate's
// evidence reuses buildMemberEvidence verbatim — the SAME shape every other flag's
// evidence.candidates already carries — plus its own matchedMembers detail (which of the person's
// existing rows it matched, and how strongly) for audit-trail completeness. `rowsById`: the
// caller's full unlinked-rows-by-id map (the singleton rows live in there); `personDisplayNameById`:
// loadPersons' own id->display_name map — "evidence carries the existing person_id + display_name"
// per the brief, cited directly rather than re-derived.
//
// Micro-round (re-review, information-gap finding — non-blocking, closing a gap the re-reviewer
// caught rather than a Critical): every flag here already targets exactly ONE person by
// construction (grouped by personId above) — existingPersons is therefore always a 1-element array
// here, added purely for SCHEMA UNIFORMITY with applyAttachCrossCheck's own (genuinely
// multi-element) flags, so src/review/server.js's 'attach' validation can check
// `person_id ∈ existingPersons' ids` the SAME way regardless of which path produced the flag —
// existingPerson (singular) stays too, as existingPersons[0], for any consumer still reading it.
export function buildAttachFlags(attachCandidates, rowsById, personDisplayNameById) {
  const byPerson = new Map();
  for (const c of attachCandidates ?? []) {
    if (!byPerson.has(c.personId)) byPerson.set(c.personId, []);
    byPerson.get(c.personId).push(c);
  }
  const flags = [];
  for (const [personId, entries] of byPerson) {
    const candidateIds = entries.map((e) => e.legislatorId);
    const evidence = entries.map((e) => {
      const row = rowsById.get(e.legislatorId);
      return { ...buildMemberEvidence(row, surnameKey(row)), matchedMembers: e.matchedMembers };
    });
    const existingPersons = buildExistingPersonRefs([personId], personDisplayNameById);
    flags.push({
      clusterKey: buildAttachClusterKey(personId, candidateIds),
      candidateIds,
      evidence,
      reason: 'attach_candidate',
      // origin (ROUND 2, R2-1): which producer made this flag. 'singleton' means every candidate
      // arrived ALONE — clusterLegislators found no same-run partner for any of them, so they were
      // deliberately never paired with each other, and a keep-separate resolution here must NOT
      // record candidate-x-candidate pairs. Contrast applyAttachCrossCheck's 'cross_check_demotion'
      // below, where the candidates DID form a coherent cluster. src/review/server.js reads this off
      // the stored row rather than re-deriving it.
      origin: 'singleton',
      existingPerson: existingPersons[0],
      existingPersons,
    });
  }
  return flags;
}

// findDemotionTargetPersons — the pure lookup applyAttachCrossCheck (below) reduces to: EVERY
// already-linked person (not just the first — micro-round, re-review information-gap finding: the
// operator can't weigh what he can't see; if a cluster genuinely cross-matches two or more
// existing persons, that is exactly the shape Lance most needs visibility into, not less) that
// SURVIVES both vetoes and still has at least one 'compatible' edge to some member of the cluster.
//
// FINAL WHOLE-BRANCH REVIEW, findings 1 & 2: every (cluster member × person) pair now goes through
// evaluateRowAgainstPerson — the SAME function buildAttachCandidates calls — so a person is
// disqualified outright by a seat contradiction against ANY member (finding 1) or by a
// keep-separate ruling against ANY member (finding 2), regardless of how many OTHER edges read
// 'compatible'. Every member row is evaluated before the verdict (no early break on the first
// veto) so `blockingRuling` reports the first ruling that actually blocked a person, not merely
// the first one encountered before some unrelated contradiction short-circuited the scan. Returns
// { personIds, blockingRuling }: personIds in personGroups' own iteration order (deterministic for
// a given input), blockingRuling the first keep-separate ruling that vetoed any person (null if
// none did) — carried onto the resulting flag exactly as applyKeepSeparateRulings carries its own.
function findDemotionTargetPersons(memberRows, personGroups, keepSeparatePairs) {
  const personIds = [];
  let blockingRuling = null;
  for (const [personId, existingMembers] of personGroups) {
    let vetoed = false;
    let matched = false;
    for (const memberRow of memberRows) {
      const { ruling, contradicted, matchedMembers } = evaluateRowAgainstPerson(memberRow, existingMembers, keepSeparatePairs);
      if (ruling) {
        vetoed = true;
        if (!blockingRuling) blockingRuling = ruling;
      }
      if (contradicted) vetoed = true;
      if (matchedMembers.length > 0) matched = true;
    }
    if (!vetoed && matched) personIds.push(personId);
  }
  return { personIds, blockingRuling };
}

// applyAttachCrossCheck — FIX ROUND 1, CRITICAL 2 (reviewer execution-proven, finding-5 class,
// executed with a real Onder shape): clusterLegislators' own clean clusters are compared ONLY
// against OTHER unlinked rows in the SAME batch — the attach pass (above) closes the gap for a
// LONE fresh row (a singleton), but TWO fresh same-person rows arriving in the same run (e.g. two
// new session/source rows for one returning legislator, ingested together) form a clean,
// name-coherent cluster on their OWN, with each other, and would sail straight through
// writeAutoCluster untouched by the attach pass at all (neither row is ever a singleton) —
// silently minting a SECOND persons row for someone already linked, with ZERO flag and ZERO
// review. This is the exact class the whole identity-merge system exists to prevent, just reached
// through a gap the singleton-only scoping left open.
//
// RULING (unambiguous): runLink calls this on EVERY clean cluster, immediately before any cluster
// is ever handed to writeAutoCluster (dry-run and live alike, same "computed in the shared
// planning phase" discipline as coherenceAudit/applyKeepSeparateRulings). Every member of the
// cluster is compared (finalPairStatus, the SAME verbatim primitive the attach pass and
// clusterLegislators itself use — no parallel matching logic) against EVERY member of EVERY
// already-linked person. A single 'compatible' edge ANYWHERE demotes the WHOLE cluster to an
// attach_candidate flag citing EVERY person it matched (micro-round: not just the first — see
// findDemotionTargetPersons' own comment) — never partially written, never auto-attached,
// Lance decides, exactly the SAME flag shape (and the SAME review-tab 'Attach' action)
// buildAttachFlags already produces. 'ambiguous' is deliberately NOT a demotion trigger here
// either (fix round 1, CRITICAL 3's own tightening, applied identically on this side too) — a
// same-seat, different-given-name pair (the dynasty shape) stays 'ambiguous', never treated as
// strong enough to demote a cluster onto a specific existing person any more than it is to SUGGEST
// one. Legitimately-distinct same-name people remain possible (the accepted residual, ledgered
// throughout this module) — which is exactly why this demotes to a human flag rather than
// hard-blocking the cluster outright: missed-merge (an extra review item) is benign, wrong-merge
// (a silent duplicate person) is not.
//
// FINAL WHOLE-BRANCH REVIEW, findings 1 & 2: this path used to qualify a person on a single
// 'compatible' edge and nothing else — no contradiction veto (finding 1: a fresh cluster whose
// member is seated at a district the person's member provably does NOT hold was still demoted onto
// that person, so one endorsed click merged two people the recorded data proves are different) and
// no keepSeparatePairs argument at all (finding 2: a row Lance had already ruled keep-separate from
// a member of person P was correctly suppressed when it arrived ALONE, but demoted onto P the
// moment it arrived with a same-name partner — re-proposing the exact merge Lance rejected). Both
// vetoes now run through the shared evaluateRowAgainstPerson, so this path and buildAttachCandidates
// enforce identical doctrine by construction. When EVERY matching person is vetoed the cluster is
// left safe to write as its own NEW person — fail-toward-duplicates, the module's asymmetric-cost
// rule (a duplicate person is a benign missed merge; a wrong merge is the unacceptable error class).
//
// `memberRowsById`: the SAME id->row map runLink already threads through to writeAutoCluster (the
// full unlinked-rows snapshot; every cluster member is guaranteed present). `alreadyLinkedRows`:
// buildEvidenceRows-shaped already-linked rows (the SAME snapshot the attach pass itself
// compares against). `personDisplayNameById`: loadPersons' own map, reused rather than re-fetched.
// `keepSeparatePairs`: buildKeepSeparatePairs' own map — REQUIRED, deliberately not defaulted, so a
// caller that forgets it throws loudly here rather than silently re-proposing rejected merges.
export function applyAttachCrossCheck(clusters, memberRowsById, alreadyLinkedRows, personDisplayNameById, keepSeparatePairs) {
  const personGroups = groupAlreadyLinkedByPerson(alreadyLinkedRows);
  const safeClusters = [];
  const demotedFlags = [];
  for (const cluster of clusters) {
    const memberRows = cluster.memberIds.map((id) => {
      const row = memberRowsById.get(id);
      // R2-3: fail loud, naming the id and the cluster — the shared helper backstops this too, but
      // only here are both known, and a caller debugging a snapshot gap needs both.
      if (!row) {
        throw new MissingMemberRowError(
          `cluster ${cluster.key} names legislator_id=${id}, which has no row in the caller's snapshot `
            + '— refusing to cross-check a cluster it cannot fully see',
          { legislatorId: id, clusterKey: cluster.key },
        );
      }
      return row;
    });
    const { personIds: matchedPersonIds, blockingRuling } = findDemotionTargetPersons(memberRows, personGroups, keepSeparatePairs);
    if (matchedPersonIds.length === 0) {
      safeClusters.push(cluster);
      continue;
    }
    // cluster.evidence is ALREADY buildMemberEvidence-shaped (clusterLegislators' own construction
    // — see buildMemberEvidence's call site there) — the SAME shape buildAttachFlags produces, so
    // this demoted flag renders identically in the review tab with zero reason-specific branching.
    const existingPersons = buildExistingPersonRefs(matchedPersonIds, personDisplayNameById);
    demotedFlags.push({
      clusterKey: buildAttachClusterKey(matchedPersonIds, cluster.memberIds),
      candidateIds: cluster.memberIds,
      evidence: cluster.evidence,
      reason: 'attach_candidate',
      // origin (ROUND 2, R2-1): these candidates ARE a real, coherent cluster with each other —
      // clusterLegislators built them into one group and only this cross-check pulled them back out.
      // That is precisely what makes Lance's "keep whole flag separate" ambiguous here: it could mean
      // "these are not P" or "these are all different people". src/review/server.js resolves that
      // ambiguity toward MORE blocking (recording the candidate-x-candidate pairs too), which keeps
      // the cluster in the flag queue for Lance instead of letting the next run auto-merge it —
      // missed-merge is the benign direction, a silent merge is the unacceptable one.
      origin: 'cross_check_demotion',
      existingPerson: existingPersons[0],
      existingPersons,
      // keepSeparateRuling: present only when a ruling vetoed some OTHER person while this
      // demotion still fired — the same citation applyKeepSeparateRulings attaches to its own
      // downgrades, so Lance sees his own earlier words rather than an unexplained absence.
      ...(blockingRuling ? { keepSeparateRuling: blockingRuling } : {}),
    });
  }
  return { safeClusters, demotedFlags };
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

// isUniqueViolation — exported (final wave, item 3) so src/review/server.js's own TOCTOU guard on
// the identity 'link' decision route can map a person_links 23505 (a concurrent writer won a race
// this route's own guarded legislators.update lost) onto the same 409 path, rather than reusing a
// second, drifting copy of this one-line check.
export function isUniqueViolation(error) {
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
      // keepSeparateRuling (final wave, item 2): present only on a flag applyKeepSeparateRulings
      // downgraded from a would-be auto-cluster — cites the specific PRIOR ruling (flagId/note/
      // decidedAt/the exact pair) that blocked it, so Lance sees his own earlier words directly
      // rather than a bare 'conflicts_with_keep_separate_ruling' reason code.
      evidence: {
        reason: flag.reason,
        candidates: flag.evidence,
        ...(flag.keepSeparateRuling ? { keepSeparateRuling: flag.keepSeparateRuling } : {}),
        // existingPerson (Task 4, attach-to-existing): present only on an attach_candidate flag
        // (buildAttachFlags/applyAttachCrossCheck) — the EXISTING person's own id + display_name,
        // cited directly rather than re-derived, so the review tab and the 'attach' decision route
        // both read the same fact off this one flag row. existingPersons (micro-round,
        // re-review): the FULL list of every existing person this flag's candidates matched — the
        // field src/review/server.js's 'attach' validation actually checks membership against;
        // existingPerson is existingPersons[0], kept for any consumer still reading the singular.
        ...(flag.existingPerson ? { existingPerson: flag.existingPerson } : {}),
        ...(flag.existingPersons ? { existingPersons: flag.existingPersons } : {}),
        // origin (ROUND 2, R2-1): which attach producer made this flag — 'singleton' or
        // 'cross_check_demotion'. src/review/server.js's keep-separate branch reads it to decide
        // whether the candidates' OWN internal pairs are part of what Lance just ruled on.
        ...(flag.origin ? { origin: flag.origin } : {}),
      },
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

// runLink — dry-run mode does ONLY the loads/pure-planning calls below and returns the full
// proposed clustering + honest counts; ZERO writes are even reachable from this branch (writeAutoCluster/
// writeIdentityFlag are never called). Live mode performs the writes and returns the same honest
// counts shape the plan's Global Constraints specify verbatim: {clusters, personsCreated, linked,
// flagged, alreadyLinked, singletons}. `coherenceAudit` (fix round 2): auditClusterCoherence run
// over the SURVIVING (post-keep-separate-downgrade — item 2) proposed clusters, on EVERY call
// (dry-run and live alike) — the permanent, visible mechanical double-check that every proposed
// cluster's member pairs share a full-name variant, independent of writeAutoCluster's own
// structural throw. Computed BEFORE any write, so a live run with coherenceAudit.ok === false would
// still hit writeAutoCluster's per-cluster throw on the offending cluster specifically — this audit
// is reported for every cluster at once, up front.
//
// Item 2 (final wave): keep-separate rulings bind the auto path. Immediately after
// clusterLegislators, EVERY proposed cluster is checked against every legislator-id pair Lance has
// ever ruled 'keep-separate' (buildKeepSeparatePairs/applyKeepSeparateRulings, both pure —
// src/lib/person-identity.js stays untouched, DB-shaped concerns like identity_flags.evidence stay
// here) — a hit downgrades that cluster to a flag BEFORE writeAutoCluster ever sees it, in BOTH
// dry-run and live mode, so the operator sees the downgrade in the dry-run report too, not just
// live behavior.
export async function runLink(client, { dryRun = false, runId = null } = {}) {
  const legislatorRows = await loadLegislators(client);
  const termRows = await loadTerms(client);
  const identityFlagRows = await loadIdentityFlags(client);
  const { unlinked, alreadyLinked } = partitionByLinkStatus(legislatorRows);
  const evidenceRows = buildEvidenceRows(unlinked, termRows);
  const { clusters: rawClusters, flagged: matcherFlagged, singletons } = clusterLegislators(evidenceRows);
  const keepSeparatePairs = buildKeepSeparatePairs(identityFlagRows);
  const { cleanClusters: keepSeparateCleanClusters, downgradedFlags } = applyKeepSeparateRulings(rawClusters, keepSeparatePairs);

  // Task 4 (attach-to-existing): the attach pass — scoped to clusterLegislators' own `singletons`
  // output (see buildAttachCandidates' own comment for why), compared against EVERY already-linked
  // person's member rows (buildEvidenceRows applied to the `alreadyLinked` bucket too, so those rows
  // carry the SAME evidence/nickname shape the matcher needs), gated by the same keepSeparatePairs
  // the auto-cluster path already binds to. Computed here, in the shared planning phase, before any
  // write — dry-run and live share this identical pass, exactly like coherenceAudit above.
  const rowsById = new Map(evidenceRows.map((r) => [r.id, r]));
  const alreadyLinkedEvidenceRows = buildEvidenceRows(alreadyLinked, termRows);
  const singletonRows = singletons.map((id) => rowsById.get(id)).filter(Boolean);
  const attachCandidates = buildAttachCandidates(singletonRows, alreadyLinkedEvidenceRows, keepSeparatePairs);
  const personDisplayNameById = await loadPersons(client);
  const attachFlags = buildAttachFlags(attachCandidates, rowsById, personDisplayNameById);

  // Fix round 1, CRITICAL 2: the cross-check — every clean cluster (post keep-separate downgrade)
  // is re-checked against every already-linked person BEFORE it is treated as safe to write at
  // all. `cleanClusters` from here on is the FINAL, cross-checked set writeAutoCluster ever sees.
  const { safeClusters: cleanClusters, demotedFlags: crossCheckFlags } = applyAttachCrossCheck(
    keepSeparateCleanClusters, rowsById, alreadyLinkedEvidenceRows, personDisplayNameById, keepSeparatePairs,
  );

  const flagged = [...matcherFlagged, ...downgradedFlags, ...attachFlags, ...crossCheckFlags];
  const coherenceAudit = auditClusterCoherence(cleanClusters);

  const counts = {
    clusters: cleanClusters.length,
    personsCreated: 0,
    linked: 0,
    flagged: flagged.length,
    alreadyLinked: alreadyLinked.length,
    singletons: singletons.length,
  };

  if (dryRun) {
    return {
      mode: 'dry-run', counts, clusters: cleanClusters, flagged, singletons, coherenceAudit,
    };
  }

  let flaggedWritten = 0;
  let flaggedDeduped = 0;
  for (const cluster of cleanClusters) {
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
      flagged: report.flagged.map((f) => ({
        clusterKey: f.clusterKey,
        candidateIds: f.candidateIds,
        reason: f.reason,
        // existingPerson(s) (Task 4 + micro-round): the attach pass's own target person(s),
        // surfaced to the operator right in the dry-run report — never dropped silently the way an
        // ad-hoc field would be. existingPersons is the FULL list (1+ entries).
        ...(f.existingPerson ? { existingPerson: f.existingPerson } : {}),
        ...(f.existingPersons ? { existingPersons: f.existingPersons } : {}),
        // origin (round 2, R2-1): surfaced in the dry-run report too — the two attach producers now
        // behave differently on resolution, so the operator can see which one proposed each flag.
        ...(f.origin ? { origin: f.origin } : {}),
      })),
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
