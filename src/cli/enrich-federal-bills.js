import {
  getClient, openRun, closeRun, insertIfAbsent, additivePatch, selectAll, isMissingRelationError,
} from '../lib/db.js';
import { SourceFetchError } from '../lib/errors.js';
import * as us from '../adapters/us-congress.js';
import {
  parseTextVersions, pickTextUrl, stripHtml, sha256, fetchBillTextVersions, fetchTextBody,
} from '../adapters/us-congress-text.js';
import { MAX_TEXT_CHARS, OversizeTextError } from '../lib/summarizer.js';
import { wrapTextFormatError } from './summarize.js';
import { isCurrentMember, upsertTerm } from './ingest.js';
import { stateAbbreviation } from '../adapters/us-senate.js';
import { loadSponsorIndex } from './backfill-mo-bill-meta.js';

// enrich-federal-bills — Task 3 of the profile-completeness plan
// (.superpowers/sdd/2026-07-29-profile-completeness/task-3-brief.md). ONE polite Congress.gov
// pass serving four needs against every already-ingested federal (us-congress) bill that has at
// least one recorded vote: sponsors (bioguide exact match), bills.status (additivePatch, fills
// null only), bill text (existing bill_texts conventions from summarize.js's ensureText, oversize
// gate honored), and current-member metadata (party fill + a House/Senate term row carrying
// district/state) for the full current House+Senate roster.
//
// PHOTO URL (settled in the task brief — Global Constraints, "the photo-URL decision is
// settled"): a bioguide photo URL is MECHANICALLY DERIVABLE from bioguide_id at render time
// (congress.gov serves member photos at a predictable path keyed by bioguide_id). This file does
// NOT write legislators.image_url and does NOT add any new column — the derivation belongs to the
// public-site render layer (Plan 3), not ingestion. Confirmed via this task's own live fixture
// capture that the derivation is NOT perfectly uniform (tests/fixtures/us-congress/members-mo.json:
// Onder's imageUrl is a non-bioguide-shaped asset id, while most other members' imageUrl IS exactly
// `{bioguide_id.toLowerCase()}_200.jpg`) — one more reason this stays a render-time best-effort
// concern, never a stored fact.
//
// DURABLE RESUMABLE PROGRESS: DB-keyed, not a separate progress-artifact file. Every run
// recomputes its own worklist from current DB state via selectAll (bulk, not per-row — the
// Task-2 130k-query lesson) and every write is additive (insertIfAbsent / additivePatch /
// fills-null-only UPDATE) — a bill or member already fully enriched costs zero fetches on the
// next invocation (see planBillWork below), so an interrupted run simply picks back up where DB
// state says it left off. This mirrors every other bulk CLI in this codebase (backfill-mo-bill-
// meta.js, ingest-legiscan.js's hash-gated re-processing) rather than inventing a parallel
// checkpoint-file mechanism.
//
// --dry-run makes ZERO live fetches (Global Constraints: "--dry-run zero fetches beyond nothing
// (plan from DB state only)") — stricter than us-senate's own dry-run precedent (which still
// fetches the senate.gov vote menu). Member-metadata ensure is therefore LIVE-ONLY and reported
// as "not evaluated" in dry-run mode, exactly like ensureSenateMembers's own documented
// LIVE-ONLY status in ingest.js's us-senate dry-run branch.
//
// GATING: bill_sponsors is migration 0014, draft-then-apply — loadSponsorIndex (reused verbatim
// from backfill-mo-bill-meta.js, the SAME table, no parallel matching logic) decides gating once,
// up front. bills.status writes are ungated (bills.status has existed since migration 0001).

const JURISDICTION = 'us-congress';
const SOURCE = 'enrich-federal-bills';

export function parseArgs(argv) {
  const out = { dryRun: false, limit: null, skipMembers: false };
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (key === '--dry-run') { out.dryRun = true; i += 1; continue; }
    // --skip-members (review fix round 1 MINOR 3): skips ensureFederalMemberMetadata's full
    // roster re-page entirely — see that function's own header comment for why a Task-6 operator
    // chunking bill work across many invocations wants this on every chunk after the first.
    if (key === '--skip-members') { out.skipMembers = true; i += 1; continue; }
    if (key === '--limit') { out.limit = Number(argv[i + 1]); i += 2; continue; }
    throw new Error(`unknown flag: ${key}`);
  }
  return out;
}

// ---- bulk index loaders (selectAll — Global Constraints: "selectAll for every multi-row read;
// ... votes 9,900+ — everything is past or near the 1,000 cap") ----

// loadVotedBillIds -> Set<bill_id> for every distinct bill a us-congress vote (House or Senate —
// both chambers persist under jurisdiction_id 'us-congress', per ingest.js's own persistUsCongress
// / persistUsSenate) references. This IS the worklist.
export async function loadVotedBillIds(client) {
  const { data, error } = await selectAll(client, 'votes', 'bill_id', {
    filter: (q) => q.eq('jurisdiction_id', JURISDICTION).not('bill_id', 'is', null),
  });
  if (error) throw new Error(`enrich-federal-bills: votes bulk load failed: ${error.message}`);
  return new Set(data.map((r) => r.bill_id));
}

// loadFederalBillIndex -> Map<bill_id, { id, identifier, status, congress }>. `congress` comes
// from the bill's own session's identifier (e.g. '119') — needed to build every congress.gov URL.
export async function loadFederalBillIndex(client) {
  const { data: sessions, error: sessErr } = await selectAll(client, 'sessions', 'id,identifier', {
    filter: (q) => q.eq('jurisdiction_id', JURISDICTION),
  });
  if (sessErr) throw new Error(`enrich-federal-bills: sessions bulk load failed: ${sessErr.message}`);
  const congressBySession = new Map(sessions.map((s) => [s.id, s.identifier]));
  if (congressBySession.size === 0) return new Map();

  const { data: bills, error: billsErr } = await selectAll(client, 'bills', 'id,session_id,identifier,status', {
    filter: (q) => q.in('session_id', [...congressBySession.keys()]),
  });
  if (billsErr) throw new Error(`enrich-federal-bills: bills bulk load failed: ${billsErr.message}`);

  const index = new Map();
  for (const b of bills) {
    index.set(b.id, {
      id: b.id, identifier: b.identifier, status: b.status, congress: congressBySession.get(b.session_id),
    });
  }
  return index;
}

// loadLegislatorIndexByBioguide -> Map<bioguide_id, { id, party }>. Exact key only (identity
// invariant: never fuzzy/name matching anywhere in this codebase).
export async function loadLegislatorIndexByBioguide(client) {
  const { data, error } = await selectAll(client, 'legislators', 'id,bioguide_id,party');
  if (error) throw new Error(`enrich-federal-bills: legislators bulk load failed: ${error.message}`);
  const index = new Map();
  for (const row of data) {
    if (row.bioguide_id != null) index.set(row.bioguide_id, { id: row.id, party: row.party });
  }
  return index;
}

// loadTextIndex -> Set<bill_id> for every bill that already has AT LEAST ONE bill_texts row.
// Coarser than summarize.js's own ensureText (which tracks per-version_type existence) —
// deliberate: this pass's job is "make sure a bill has SOME text on file", not to track every
// version_type over time; that finer-grained bookkeeping stays summarize.js's own concern.
export async function loadTextIndex(client) {
  const { data, error } = await selectAll(client, 'bill_texts', 'bill_id');
  if (error) throw new Error(`enrich-federal-bills: bill_texts bulk load failed: ${error.message}`);
  return new Set(data.map((r) => r.bill_id));
}

// ---- pure planning (no I/O) ----

// planBillWork -> { needsWork: [{billId, bill, needsSponsors, needsStatus, needsText, needsDetail}],
// skippedComplete, billRowNotFound }. A bill with all three already satisfied costs zero further
// I/O this run (the DB-keyed resumability this file relies on instead of a progress artifact).
//
// KNOWN TRADEOFF (review fix round 1, documented not silently accepted): `needsSponsors` is an
// "AT LEAST ONE sponsor recorded" gate, not an "ALL of this bill's sponsors recorded" gate — once
// a single sponsor write lands for a bill, `billsWithAnySponsorFrom` marks the bill done and no
// future run's `planBillWork` will ever re-fetch its detail for sponsors again. On a bill with
// MULTIPLE sponsors where some resolve/write and others don't in the same run (an unmatched
// bioguide, or the 0014-missing-relation gate tripping mid-list), the unwritten ones are
// permanently abandoned by this bill-level gate — never retried automatically. `processBillLive`
// below compensates by naming exactly which bioguide(s) were left unresolved in `failures[]`
// (counted `sponsorsUnresolved`) so an operator can find and manually re-run/investigate them;
// this does NOT make the gate retry them itself. Both real captured fixtures (HR 498, HR 845)
// carry exactly one sponsor — Congress.gov's `sponsors[]` is typically a single introducing
// sponsor — so this is believed rare in practice, not proven absent.
export function planBillWork(billIds, billIndex, billsWithAnySponsor, textIndex) {
  const needsWork = [];
  let skippedComplete = 0;
  let billRowNotFound = 0;
  for (const billId of billIds) {
    const bill = billIndex.get(billId);
    if (!bill) { billRowNotFound += 1; continue; }
    const needsSponsors = !billsWithAnySponsor.has(billId);
    const needsStatus = bill.status == null;
    const needsText = !textIndex.has(billId);
    if (!needsSponsors && !needsStatus && !needsText) { skippedComplete += 1; continue; }
    needsWork.push({
      billId, bill, needsSponsors, needsStatus, needsText, needsDetail: needsSponsors || needsStatus,
    });
  }
  return { needsWork, skippedComplete, billRowNotFound };
}

function billsWithAnySponsorFrom(sponsorLoad) {
  if (sponsorLoad.gated) return new Set();
  return new Set([...sponsorLoad.index.keys()].map((k) => k.slice(0, k.indexOf('|'))));
}

// ---- text fetch (reuses us-congress-text.js's already-tested pure functions verbatim — no
// parallel text-parsing logic; mirrors summarize.js's own ensureText convention) ----

export async function fetchAndStoreBillText(client, runId, bill, {
  fetchBillTextVersionsFn = fetchBillTextVersions, fetchTextBodyFn = fetchTextBody,
} = {}) {
  const slug = us.billTypeSlug(bill.identifier);
  const number = bill.identifier.split(' ')[1];
  const versionsJson = await fetchBillTextVersionsFn(bill.congress, slug, number);
  let picked;
  try {
    picked = pickTextUrl(parseTextVersions(versionsJson));
  } catch (err) {
    throw wrapTextFormatError(err);
  }
  const body = await fetchTextBodyFn(picked.url);
  const content = stripHtml(body);
  if (content.length > MAX_TEXT_CHARS) {
    throw new OversizeTextError(
      `bill text ${content.length} chars exceeds ${MAX_TEXT_CHARS}; refusing to store — never truncated silently`,
      { identifier: bill.identifier, length: content.length },
    );
  }
  const row = {
    bill_id: bill.id,
    version: picked.version_type,
    content,
    content_hash: sha256(content),
    source_url: picked.url,
    retrieved_at: new Date().toISOString(),
    run_id: runId,
  };
  await insertIfAbsent(client, 'bill_texts', [row], 'bill_id,version');
  return row;
}

// ---- per-bill live processing ----

function emptyBillCounts() {
  return {
    billDetailFetched: 0,
    billDetailFailed: 0,
    statusPatched: 0,
    statusAlreadySet: 0,
    statusMissingInSource: 0,
    sponsorsSeen: 0,
    sponsorInserted: 0,
    sponsorAlreadyExists: 0,
    sponsorLegislatorNotFound: 0,
    sponsorGated: 0,
    sponsorsUnresolved: 0,
    textFetched: 0,
    textOversizeRefused: 0,
    textFormatMissing: 0,
    textFetchFailed: 0,
  };
}

export async function processBillLive(client, runId, work, {
  legislatorIndex, sponsorIndex, sponsorGatedRef, counts, failures,
  fetchBillDetailFn = us.fetchBillDetail, fetchTextFn = fetchAndStoreBillText,
}) {
  const {
    billId, bill, needsSponsors, needsStatus, needsText, needsDetail,
  } = work;

  if (needsDetail) {
    let detail = null;
    try {
      const slug = us.billTypeSlug(bill.identifier);
      const number = bill.identifier.split(' ')[1];
      const json = await fetchBillDetailFn(bill.congress, slug, number);
      detail = us.parseBillDetail(json);
      counts.billDetailFetched += 1;
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      counts.billDetailFailed += 1;
      failures.push({ step: `bill detail ${bill.identifier}`, message: err.message });
    }

    if (detail) {
      if (needsStatus) {
        if (detail.status == null) {
          counts.statusMissingInSource += 1;
        } else {
          const patch = additivePatch(bill, { status: detail.status });
          if (Object.keys(patch).length === 0) {
            counts.statusAlreadySet += 1;
          } else {
            // eslint-disable-next-line no-await-in-loop
            const { error } = await client.from('bills').update({ status: patch.status, run_id: runId }).eq('id', billId);
            if (error) throw new Error(`enrich-federal-bills: status patch failed for bills.id=${billId}: ${error.message}`);
            bill.status = patch.status; // keep the in-memory index consistent for the rest of this run
            counts.statusPatched += 1;
          }
        }
      }

      if (needsSponsors) {
        // unresolvedBioguides — review fix round 1 (IMPORTANT finding): the bill-level
        // needsSponsors gate (planBillWork, see its KNOWN TRADEOFF comment) will never revisit
        // this bill once ANY sponsor exists for it, so a sponsor that fails to resolve/write HERE
        // is otherwise silently lost forever. Collected per-bill and reported as ONE named
        // failures[] entry below so an operator can find and manually investigate/re-run it —
        // this does not make the gate itself retry automatically.
        const unresolvedBioguides = [];
        for (const sponsor of detail.sponsors) {
          counts.sponsorsSeen += 1;
          const legislator = legislatorIndex.get(sponsor.bioguide_id);
          if (!legislator) {
            counts.sponsorLegislatorNotFound += 1;
            unresolvedBioguides.push(sponsor.bioguide_id);
            continue;
          }
          if (sponsorGatedRef.gated) {
            counts.sponsorGated += 1;
            unresolvedBioguides.push(sponsor.bioguide_id);
            continue;
          }
          const key = `${billId}|${legislator.id}`;
          if (sponsorIndex.has(key)) { counts.sponsorAlreadyExists += 1; continue; }
          // eslint-disable-next-line no-await-in-loop
          const { error } = await client.from('bill_sponsors').upsert(
            {
              bill_id: billId, legislator_id: legislator.id, sponsor_type: sponsor.sponsor_type, run_id: runId,
            },
            { onConflict: 'bill_id,legislator_id', ignoreDuplicates: true },
          );
          if (error) {
            if (isMissingRelationError(error, 'bill_sponsors')) {
              sponsorGatedRef.gated = true;
              counts.sponsorGated += 1;
              unresolvedBioguides.push(sponsor.bioguide_id);
              continue;
            }
            throw new Error(`enrich-federal-bills: sponsor insert failed for bill_id=${billId}: ${error.message}`);
          }
          sponsorIndex.set(key, { id: null }); // keep the in-memory index consistent for the rest of this run
          counts.sponsorInserted += 1;
        }
        if (unresolvedBioguides.length > 0) {
          counts.sponsorsUnresolved += unresolvedBioguides.length;
          failures.push({
            step: `sponsors ${bill.identifier}`,
            message: `${unresolvedBioguides.length} sponsor(s) unresolved/unwritten this run — the `
              + 'bill-level completion gate will NOT retry these automatically once any sponsor '
              + `exists for this bill: ${unresolvedBioguides.join(', ')}`,
          });
        }
      }
    }
  }

  if (needsText) {
    try {
      await fetchTextFn(client, runId, bill);
      counts.textFetched += 1;
    } catch (err) {
      if (err instanceof OversizeTextError) {
        counts.textOversizeRefused += 1;
        failures.push({ step: `text ${bill.identifier}`, message: err.message });
      } else if (err instanceof SourceFetchError) {
        if (/no fetchable text format/.test(err.message)) counts.textFormatMissing += 1;
        else counts.textFetchFailed += 1;
        failures.push({ step: `text ${bill.identifier}`, message: err.message });
      } else {
        throw err;
      }
    }
  }
}

// ---- member metadata: current House+Senate roster -> legislators.party fill + a terms row
// carrying district (House) or state abbreviation (Senate, same terms.district-as-state
// convention ensureSenateMembers already established). LIVE-ONLY — never called in --dry-run. ----

function emptyMemberCounts() {
  return {
    membersPaged: 0,
    membersWithoutTerms: 0,
    membersCurrent: 0,
    membersHistoricalFiltered: 0,
    legislatorCreated: 0,
    partyPatched: 0,
    partyAlreadySet: 0,
    partyMissingInSource: 0,
    termCreated: 0,
    termAlreadyExists: 0,
  };
}

// ensureFederalMemberMetadata re-pages the FULL current House+Senate roster (~2,694 members /
// 250 per page ~= 11 congress.gov requests, review fix round 1 MINOR 3) EVERY invocation,
// regardless of --limit — --limit only slices the bill worklist in runEnrichFederalBills below,
// never this pagination loop. A Task-6 operator chunking the bill worklist across many
// invocations would otherwise redundantly re-page the roster on every single chunk (~11 requests
// x N chunks, ~40s x N chunks against the shared 3.6s/request congressLimiter). Pass
// --skip-members on every chunk after the first to skip this step entirely — see parseArgs /
// runEnrichFederalBills.
export async function ensureFederalMemberMetadata(client, runId, {
  fetchMemberPageFn = us.fetchMemberPage,
  loadLegislatorIndexFn = loadLegislatorIndexByBioguide,
  upsertTermFn = upsertTerm,
} = {}) {
  const counts = emptyMemberCounts();
  const failures = [];
  const currentMembers = [];
  let offset = 0;
  for (;;) {
    let json;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential paging, same precedent as
      // ensureSenateMembers (ingest.js) which this loop mirrors for both chambers.
      json = await fetchMemberPageFn(offset, 250);
    } catch (err) {
      if (!(err instanceof SourceFetchError)) throw err;
      failures.push({ step: `member page offset=${offset}`, message: err.message });
      break;
    }
    const raw = json.members ?? [];
    counts.membersPaged += raw.length;
    // parseMemberList throws on ANY member with no terms at all — pre-filter so one odd
    // historical record can't kill the whole page (same brief ruling ensureSenateMembers follows).
    const withTerms = raw.filter((m) => (m.terms?.item ?? []).length > 0);
    counts.membersWithoutTerms += raw.length - withTerms.length;
    const current = withTerms.filter(isCurrentMember);
    counts.membersHistoricalFiltered += withTerms.length - current.length;
    let parsed = [];
    try {
      parsed = us.parseMemberList({ members: current });
    } catch (err) {
      failures.push({ step: `member page offset=${offset}`, message: err.message });
    }
    currentMembers.push(...parsed);
    counts.membersCurrent += parsed.length;
    if (raw.length < 250) break;
    offset += 250;
  }

  // Bulk load ONCE before writing (Task 2 scale lesson) — most current members already exist as
  // legislators rows (placeholder full_name=bioguide_id, from vote-cast ingestion); this is a
  // safety net for the rest, then a second bulk load resolves ids for the party/term steps below.
  const preIndex = await loadLegislatorIndexFn(client);
  const newMembers = currentMembers.filter((m) => !preIndex.has(m.bioguide_id));
  await insertIfAbsent(client, 'legislators',
    newMembers.map((m) => ({
      full_name: m.full_name, bioguide_id: m.bioguide_id, party: m.party, run_id: runId,
    })), 'bioguide_id');
  counts.legislatorCreated = newMembers.length;
  const legislatorIndex = newMembers.length > 0 ? await loadLegislatorIndexFn(client) : preIndex;

  for (const m of currentMembers) {
    const existing = legislatorIndex.get(m.bioguide_id);
    if (!existing) {
      failures.push({ step: `member ${m.bioguide_id}`, message: 'legislator row not found after insertIfAbsent (unexpected)' });
      continue;
    }

    // additivePatch (review fix round 1 MINOR 2 — mirrors the bills.status pattern above exactly,
    // same fills-null-only semantics): the prior hand-rolled `if/else if` silently dropped the
    // m.party==null && existing.party==null case out of every count entirely. Source-missing is
    // now its own honest bucket, distinct from already-set.
    if (m.party == null) {
      counts.partyMissingInSource += 1;
    } else {
      const partyPatch = additivePatch(existing, { party: m.party });
      if (Object.keys(partyPatch).length === 0) {
        counts.partyAlreadySet += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        const { error } = await client.from('legislators').update({ party: partyPatch.party, run_id: runId }).eq('id', existing.id);
        if (error) throw new Error(`enrich-federal-bills: party patch failed for legislators.id=${existing.id}: ${error.message}`);
        existing.party = partyPatch.party; // keep the in-memory index consistent for the rest of this run
        counts.partyPatched += 1;
      }
    }

    const district = m.chamber === 'senate' ? stateAbbreviation(m.state) : m.district;
    // eslint-disable-next-line no-await-in-loop
    const result = await upsertTermFn(client, runId, {
      legislatorId: existing.id,
      jurisdictionId: JURISDICTION,
      party: m.party,
      role: {
        chamber: m.chamber, district, start_date: null, end_date: null,
      },
    });
    if (result?.created) counts.termCreated += 1;
    else counts.termAlreadyExists += 1;
  }

  return { counts, failures };
}

// ---- orchestration: live ----

export async function runEnrichFederalBills(client, runId, { limit = null, skipMembers = false, deps = {} } = {}) {
  const {
    loadVotedBillIdsFn = loadVotedBillIds,
    loadFederalBillIndexFn = loadFederalBillIndex,
    loadLegislatorIndexFn = loadLegislatorIndexByBioguide,
    loadSponsorIndexFn = loadSponsorIndex,
    loadTextIndexFn = loadTextIndex,
    ensureFederalMemberMetadataFn = ensureFederalMemberMetadata,
    fetchBillDetailFn = us.fetchBillDetail,
    fetchTextFn = fetchAndStoreBillText,
  } = deps;

  // Member-metadata first: sponsor resolution below benefits from a freshly-ensured legislators
  // table (a current member who has never yet appeared in any ingested roll call would otherwise
  // be unresolvable as a sponsor this same run). skipMembers (review fix round 1 MINOR 3) lets a
  // Task-6 operator chunking the bill worklist across many invocations skip this ~11-request
  // roster re-page on every chunk after the first — see ensureFederalMemberMetadata's own header.
  const memberResult = skipMembers
    ? { counts: null, failures: [] }
    : await ensureFederalMemberMetadataFn(client, runId);

  const billIds = await loadVotedBillIdsFn(client);
  const billIndex = await loadFederalBillIndexFn(client);
  const legislatorIndex = await loadLegislatorIndexFn(client);
  const sponsorLoad = await loadSponsorIndexFn(client);
  const textIndex = await loadTextIndexFn(client);
  const billsWithAnySponsor = billsWithAnySponsorFrom(sponsorLoad);

  const { needsWork, skippedComplete, billRowNotFound } = planBillWork(billIds, billIndex, billsWithAnySponsor, textIndex);
  const toProcess = (typeof limit === 'number' && limit > 0) ? needsWork.slice(0, limit) : needsWork;

  const counts = emptyBillCounts();
  const failures = [];
  const sponsorGatedRef = { gated: sponsorLoad.gated };
  const sponsorIndex = sponsorLoad.gated ? new Map() : sponsorLoad.index;

  for (const work of toProcess) {
    // eslint-disable-next-line no-await-in-loop -- sequential, same "small/infrequent backlog"
    // precedent as every other batch CLI in this codebase.
    await processBillLive(client, runId, work, {
      legislatorIndex, sponsorIndex, sponsorGatedRef, counts, failures, fetchBillDetailFn, fetchTextFn,
    });
  }

  return {
    counts: {
      billsInWorklist: billIds.size,
      billRowNotFound,
      billsNeedingWork: needsWork.length,
      billsProcessed: toProcess.length,
      billsSkippedComplete: skippedComplete,
      sponsorTableGated: sponsorGatedRef.gated,
      ...counts,
      memberMetadataSkipped: skipMembers,
      memberMetadata: memberResult.counts,
    },
    failures: [...memberResult.failures, ...failures],
  };
}

// ---- orchestration: dry-run (DB state only, zero live fetches) ----

export async function dryRunFederalBillPlan(client, { limit = null, deps = {} } = {}) {
  const {
    loadVotedBillIdsFn = loadVotedBillIds,
    loadFederalBillIndexFn = loadFederalBillIndex,
    loadSponsorIndexFn = loadSponsorIndex,
    loadTextIndexFn = loadTextIndex,
  } = deps;

  const billIds = await loadVotedBillIdsFn(client);
  const billIndex = await loadFederalBillIndexFn(client);
  const sponsorLoad = await loadSponsorIndexFn(client);
  const textIndex = await loadTextIndexFn(client);
  const billsWithAnySponsor = billsWithAnySponsorFrom(sponsorLoad);

  const { needsWork, skippedComplete, billRowNotFound } = planBillWork(billIds, billIndex, billsWithAnySponsor, textIndex);
  const toProcess = (typeof limit === 'number' && limit > 0) ? needsWork.slice(0, limit) : needsWork;

  return {
    counts: {
      billsInWorklist: billIds.size,
      billRowNotFound,
      billsNeedingWork: needsWork.length,
      billsWouldProcess: toProcess.length,
      billsSkippedComplete: skippedComplete,
      needingSponsors: needsWork.filter((w) => w.needsSponsors).length,
      needingStatus: needsWork.filter((w) => w.needsStatus).length,
      needingText: needsWork.filter((w) => w.needsText).length,
      sponsorTableGated: sponsorLoad.gated,
    },
    sample: toProcess.slice(0, 10).map((w) => ({
      identifier: w.bill.identifier, needsSponsors: w.needsSponsors, needsStatus: w.needsStatus, needsText: w.needsText,
    })),
    notes: [
      'member-metadata ensure (party fill + district/state term for the current House+Senate '
        + 'roster) is LIVE-ONLY and was NOT evaluated this pass — it requires a live congress.gov '
        + 'member-roster fetch, which --dry-run never makes.',
      'this plan is computed from DB state only (selectAll reads) — zero congress.gov requests were made.',
    ],
  };
}

// ---- main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();

  if (args.dryRun) {
    if (!client) {
      console.log(JSON.stringify({
        mode: 'dry-run', source: SOURCE, note: 'no DB client configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset) — cannot report DB state; zero live queries made',
      }, null, 2));
      return;
    }
    const report = await dryRunFederalBillPlan(client, { limit: args.limit });
    console.log(JSON.stringify({ mode: 'dry-run', source: SOURCE, ...report }, null, 2));
    return;
  }

  if (!client) {
    console.log(JSON.stringify({ mode: 'blocked', reason: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set' }, null, 2));
    process.exitCode = 1;
    return;
  }

  const runId = await openRun(client, SOURCE);
  try {
    const result = await runEnrichFederalBills(client, runId, { limit: args.limit, skipMembers: args.skipMembers });
    const totalFailures = result.failures.length;
    const status = totalFailures === 0 ? 'succeeded' : 'partial';
    await closeRun(client, runId, status, { counts: result.counts, failures: result.failures });
    console.log(JSON.stringify({
      mode: 'live', run_id: runId, status, counts: result.counts,
    }, null, 2));
    if (totalFailures > 0) process.exitCode = 2;
  } catch (err) {
    await closeRun(client, runId, 'failed', { error: String(err) });
    throw err;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
