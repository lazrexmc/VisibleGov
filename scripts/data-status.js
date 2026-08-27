#!/usr/bin/env node
// data-status — print what VisibleGov actually holds, right now, from the live database.
//
// WHY THIS EXISTS: data counts quoted in prose go stale the moment anything ingests, and this
// project had accumulated numbers across README/TODO/CHATLOG/ledgers that were individually true
// at different moments and collectively confusing (Lance, 2026-07-31: "I'm baffled"). The fix is a
// division of labour: docs/DATA_INVENTORY.md explains STRUCTURE and MEANING (what each number is,
// and how they relate); this script is the source of truth for the NUMBERS. Never hand-copy a
// count from here into prose without dating it.
//
// Read-only. No writes, ever. Safe to run any time.
//   node --env-file=.env scripts/data-status.js
//   node --env-file=.env scripts/data-status.js --json    (machine-readable)

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentWeekKey, summarizeWeekSpend, envCapUsd, WEEKLY_CAP_USD, PER_TICK_CAP_USD,
} from './scheduled-summaries.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — run with `node --env-file=.env`');
  process.exit(1);
}
const H = { apikey: key, Authorization: `Bearer ${key}` };
const asJson = process.argv.includes('--json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const PARKED_PATH = path.join(REPO_ROOT, '.superpowers', 'artifacts', 'scheduled-summaries', 'parked.json');

// Exact count via content-range. PostgREST caps returned ROWS at 1000, but a count=exact HEAD-style
// request returns the true total in the header regardless — this is the only counting method in
// this repo that cannot silently undercount (a lesson learned the hard way, more than once).
async function count(path) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  });
  const cr = r.headers.get('content-range');
  if (!cr) throw new Error(`count failed for ${path}: HTTP ${r.status}`);
  return Number(cr.split('/')[1]);
}

async function rows(path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`query failed for ${path}: HTTP ${r.status}`);
  return r.json();
}

// Paginated fetch — required for any list we actually enumerate rather than count.
async function allRows(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${url}/rest/v1/${path}`, {
      headers: { ...H, Range: `${from}-${from + 999}` },
    });
    if (!r.ok) throw new Error(`paged query failed for ${path}: HTTP ${r.status}`);
    const chunk = await r.json();
    out.push(...chunk);
    if (chunk.length < 1000) return out;
  }
}

const n = (v) => Number(v).toLocaleString();

async function main() {
  // ---- core tables ----
  const [
    voteCasts, votes, bills, billTexts, billSponsors,
    legislators, persons, personLinks, terms,
    sumPublished, sumDraft, sumStale, sumRejected, sumNotPublished, glossPublished, glossTotal,
    identityOpen, reconOpen,
    voteDuplicates, retractedVotes,
  ] = await Promise.all([
    count('vote_casts?select=id'), count('votes?select=id'), count('bills?select=id'),
    count('bill_texts?select=id'), count('bill_sponsors?select=id'),
    count('legislators?select=id'), count('persons?select=id'), count('person_links?select=id'),
    count('terms?select=id'),
    count('summaries?status=eq.published&select=id'), count('summaries?status=eq.draft&select=id'), count('summaries?status=eq.stale&select=id'), count('summaries?status=eq.rejected&select=id'), count('summaries?status=neq.published&select=id'),
    count('glossary_terms?status=eq.published&select=id'), count('glossary_terms?select=id'),
    count('identity_flags?resolved=is.false&select=id'),
    count('vote_reconciliation_flags?resolved=is.false&select=id'),
    count('vote_duplicates?select=id'), count('retracted_votes?select=id'),
  ]);

  // Glossary needs a breakdown, not just a total: the gap between published and total is dominated
  // by `needs_mapping` — terms the extractor could not confidently resolve to a citation. Those are
  // a curation backlog, NOT failures, and reporting only "116 published" hid 704 of them for weeks.
  const glossNeedsMapping = await count('glossary_terms?needs_mapping=is.true&select=id');

  // COUNT this, never derive it. It used to be `glossTotal - glossPublished - glossNeedsMapping`,
  // which silently swept in every status that is neither draft nor published — 47 REJECTED terms
  // were being reported to the operator as work awaiting his review (2026-08-27).
  //
  // And a mappable draft is TWO different queues wearing one number. Splitting on gloss_md:
  //   - no gloss text  -> never authored. Needs a GLOSS RUN, not a human. (396 on 2026-08-27)
  //   - has gloss text -> authored AND verified AND flagged. This is the human queue. (427)
  // Reporting the sum told Lance his review queue was 870 when it was 427.
  const glossDraftMappable = await count('glossary_terms?status=eq.draft&needs_mapping=is.false&select=id');
  const glossUnauthored = await count('glossary_terms?status=eq.draft&needs_mapping=is.false&gloss_md=is.null&select=id');
  const glossFlagged = glossDraftMappable - glossUnauthored;

  // ---- identity: rows vs unified people ----
  const linkedRows = await count('legislators?person_id=not.is.null&select=id');
  const unlinkedRows = legislators - linkedRows;

  // ---- the bill funnel (the thing that confuses people) ----
  // Enumerated, not counted, because it needs set intersection.
  const [textRows, summaryRows, voteRows] = await Promise.all([
    allRows('bill_texts?select=bill_id'),
    allRows('summaries?select=bill_id,status'),
    allRows('votes?select=bill_id,question'),
  ]);
  const withText = new Set(textRows.map((t) => t.bill_id));
  const summarized = new Set(summaryRows.map((s) => s.bill_id));
  const publishedSet = new Set(summaryRows.filter((s) => s.status === 'published').map((s) => s.bill_id));
  const withAnyVote = new Set(voteRows.filter((v) => v.bill_id).map((v) => v.bill_id));
  // Passage-priority regex mirrors src/cli/summary-queue.js — keep in sync if that changes.
  const withPassageVote = new Set(
    voteRows.filter((v) => v.bill_id && /passage|third\s*read|3rd\s*read/i.test(v.question || ''))
      .map((v) => v.bill_id),
  );
  const inter = (a, b) => [...a].filter((x) => b.has(x)).length;
  const passageWithText = inter(withPassageVote, withText);
  const passagePublished = inter(withPassageVote, publishedSet);
  const readyToSummarize = [...withPassageVote].filter((id) => withText.has(id) && !summarized.has(id)).length;

  // ---- date coverage per jurisdiction ----
  const coverage = {};
  for (const j of ['us-congress', 'mo-legislature']) {
    const oldest = await rows(`votes?jurisdiction_id=eq.${j}&select=vote_date&order=vote_date.asc&limit=1`);
    const newest = await rows(`votes?jurisdiction_id=eq.${j}&select=vote_date&order=vote_date.desc&limit=1`);
    const casts = await count(`public_vote_feed?jurisdiction_id=eq.${j}&select=cast_id`);
    coverage[j] = {
      casts,
      earliest: oldest[0]?.vote_date?.slice(0, 10) ?? null,
      latest: newest[0]?.vote_date?.slice(0, 10) ?? null,
    };
  }

  // ---- per-year MO + federal (surfaces gap years) ----
  const years = {};
  const thisYear = new Date().getUTCFullYear();
  for (let y = 2015; y <= thisYear; y += 1) {
    const [mo, fed] = await Promise.all([
      count(`public_vote_feed?jurisdiction_id=eq.mo-legislature&vote_date=gte.${y}-01-01&vote_date=lt.${y + 1}-01-01&select=cast_id`),
      count(`public_vote_feed?jurisdiction_id=eq.us-congress&vote_date=gte.${y}-01-01&vote_date=lt.${y + 1}-01-01&select=cast_id`),
    ]);
    years[y] = { mo, federal: fed };
  }

  // ---- freshness (per ingestion source) ----
  const freshness = await rows('public_freshness?select=*&order=source');

  // ---- summary scheduler (freshness and spend tracking) ----
  // Fix-in-passing (final whole-branch review): matches scheduled-summaries.js's own ledger read
  // (selectRecentRunsReal) — a 10-day window, not just "the last 20 rows" (a daily scheduler
  // produces ~1 row/day, so 20 rows already covers ~3 weeks; the window is the honest bound, the
  // limit is just a safety cap on top of it).
  const tenDaysAgoIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const schedulerRuns = await rows(`ingestion_runs?source=eq.scheduled-summaries&started_at=gte.${tenDaysAgoIso}&order=started_at.desc&limit=20`);
  let scheduler = { status: 'never_ran' };
  if (schedulerRuns.length > 0) {
    const lastRun = schedulerRuns[0];
    const weekKey = currentWeekKey();
    // Fix-in-passing: envCapUsd (downward-only override), not the raw defaults — if Lance has
    // SUMMARY_TICK_CAP_USD/SUMMARY_WEEKLY_CAP_USD set lower in his environment, this block should
    // report the REAL effective caps the scheduler itself is using, not the code defaults.
    const perTickCapUsd = envCapUsd('SUMMARY_TICK_CAP_USD', PER_TICK_CAP_USD);
    const weeklyCapUsd = envCapUsd('SUMMARY_WEEKLY_CAP_USD', WEEKLY_CAP_USD);
    const { spentUsd: weeklySpentUsd } = summarizeWeekSpend(schedulerRuns, weekKey, perTickCapUsd);
    const thisWeekRuns = schedulerRuns.filter((r) => r.detail?.week_key === weekKey);
    const publishedThisWeek = thisWeekRuns.reduce((sum, r) => sum + (Number(r.detail?.published) || 0), 0);
    let parkedCount = 0;
    if (existsSync(PARKED_PATH)) {
      try {
        const parked = JSON.parse(readFileSync(PARKED_PATH, 'utf8'));
        parkedCount = Object.keys(parked).length;
      } catch {
        // ignore corrupt parked.json
      }
    }
    scheduler = {
      status: 'running',
      lastTickStarted: lastRun.started_at,
      lastTickRunStatus: lastRun.status,
      weekKey,
      weeklySpentUsd: Number(weeklySpentUsd.toFixed(2)),
      weeklyCapUsd,
      publishedThisWeek,
      parkedCount,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scale: {
      voteCasts, votes, bills, billTexts, billSponsors, terms,
      glossaryPublished: glossPublished, glossaryTotal: glossTotal,
      glossaryNeedsMapping: glossNeedsMapping, glossaryDraftMappable: glossDraftMappable,
    },
    people: {
      legislatorRows: legislators,
      unifiedPersons: persons,
      personLinks,
      rowsLinkedToAPerson: linkedRows,
      rowsNotLinked: unlinkedRows,
      note: 'Every legislator row is identified and carries its own votes. A `person` unifies ONE human who appears as multiple rows across sources; a row that appears in only one source needs no person record.',
    },
    billFunnel: {
      allBills: bills,
      withAnyRecordedVote: withAnyVote.size,
      withPassageVote: withPassageVote.size,
      passageVoteAndText: passageWithText,
      passageVoteAndPublishedSummary: passagePublished,
      readyToSummarize,
      summariesPublished: sumPublished,
      summariesAwaitingReview: sumDraft + sumStale,
      summariesDraft: sumDraft,
      summariesStale: sumStale,
      summariesRetired: sumRejected,
      reconciliationCheck: { draft: sumDraft, stale: sumStale, rejected: sumRejected, total: sumDraft + sumStale + sumRejected, oldLens_neq_published: sumNotPublished },
    },
    coverage,
    castsByYear: years,
    operatorQueue: {
      identityFlagsOpen: identityOpen,
      reconciliationFlagsOpen: reconOpen,
      summariesAwaitingReview: sumDraft + sumStale,
      summariesDraft: sumDraft,
      summariesStale: sumStale,
      summariesRetired: sumRejected,
      glossaryAwaitingReview: glossDraftMappable,
      glossaryNeedsMappingBacklog: glossNeedsMapping,
    },
    freshness,
    scheduler,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`VisibleGov data status — ${report.generatedAt}`);
  console.log('='.repeat(64));
  console.log('\nSCALE');
  console.log(`  vote casts .............. ${n(voteCasts)}   (individual legislator positions)`);
  console.log(`  roll calls .............. ${n(votes)}`);
  console.log(`  bills ................... ${n(bills)}`);
  console.log(`  bill texts stored ....... ${n(billTexts)}`);
  console.log(`  sponsorships ............ ${n(billSponsors)}`);
  console.log(`  terms (seats held) ...... ${n(terms)}`);
  console.log(`  glossary published ...... ${n(glossPublished)} of ${n(glossTotal)}`);
  console.log(`    ...needs_mapping ...... ${n(glossNeedsMapping)}  <- extractor couldn't resolve a citation (curation backlog)`);
  console.log(`    ...flagged, awaiting Lance ${n(glossFlagged)}  <- authored + verified, verifier raised an objection`);
  console.log(`    ...not yet authored ... ${n(glossUnauthored)}  <- citation resolved, no gloss written yet (needs a gloss run)`);

  console.log('\nPEOPLE  (rows vs unified people — these are different things)');
  console.log(`  legislator rows ......... ${n(legislators)}  <- every one identified, with its own votes`);
  console.log(`  unified persons ......... ${n(persons)}  <- one human who appeared as several rows`);
  console.log(`  rows linked to a person . ${n(linkedRows)}`);
  console.log(`  rows not linked ......... ${n(unlinkedRows)}  <- appear in ONE source only; nothing to unify`);

  console.log('\nBILL FUNNEL  (why "bills" and "summaries" are so far apart)');
  console.log(`  all bills ............................ ${n(bills)}`);
  console.log(`  ...with any recorded vote ............ ${n(withAnyVote.size)}`);
  console.log(`  ...with a passage/3rd-reading vote ... ${n(withPassageVote.size)}  <- the accountability set`);
  console.log(`  ...of those, text on hand ............ ${n(passageWithText)}`);
  console.log(`  ...of those, published summary ....... ${n(passagePublished)}`);
  console.log(`  READY to summarize (text, no summary)  ${n(readyToSummarize)}`);
  console.log(`  summaries published .................. ${n(sumPublished)}`);
  console.log(`  summaries awaiting review ............ ${n(sumDraft + sumStale)}  <- held back by the trust gate${sumStale > 0 ? ` (of which stale: ${n(sumStale)})` : ''}`);
  console.log(`  summaries retired (superseded) ....... ${n(sumRejected)}  <- replaced by later attempts, audit trail`);

  console.log('\nCOVERAGE');
  for (const [j, v] of Object.entries(coverage)) {
    console.log(`  ${j.padEnd(16)} ${n(v.casts).padStart(10)} casts   ${v.earliest} -> ${v.latest}`);
  }
  console.log('\n  casts by year (MO / federal):');
  for (const [y, v] of Object.entries(years)) {
    const flag = v.mo === 0 && v.federal === 0 ? '   <- no data' : (v.mo === 0 ? '   <- no MO data' : '');
    console.log(`    ${y}  ${n(v.mo).padStart(9)} / ${n(v.federal).padStart(9)}${flag}`);
  }

  console.log('\nOPERATOR QUEUE  (needs a human decision — not errors)');
  console.log(`  identity flags open ........... ${identityOpen}`);
  console.log(`  reconciliation flags open ..... ${reconOpen}`);
  console.log(`  summaries awaiting review ..... ${sumDraft + sumStale}${sumStale > 0 ? ` (draft: ${sumDraft}, stale: ${sumStale})` : ''}`);
  console.log(`  summaries retired ............ ${sumRejected}`);
  console.log(`  glossary awaiting review ...... ${n(glossFlagged)}  (flagged only; ${n(glossUnauthored)} more need a gloss run, not a human)`);
  console.log(`  glossary needs_mapping ........ ${n(glossNeedsMapping)}  (curation backlog, not errors)`);

  // REPAIR LEDGER (added 2026-08-26). `votes` alone stopped telling the whole truth the day rows
  // began being hidden and removed: 714 vote rows were RETRACTED as misattributed (attached to
  // bills that never held them) and 213 are SUPERSEDED (a redundant copy of a real vote, hidden but
  // never deleted). Without these two lines a fresh session reads `votes` and has no idea either
  // number exists. The two are NOT interchangeable and the distinction is the whole point:
  // superseded = right bill, redundant row, recoverable by deleting a marking row.
  // retracted   = WRONG bill, row deleted, recoverable only from the tombstone's preserved casts.
  console.log('\nREPAIR LEDGER  (what has been hidden or removed, and why it is recoverable)');
  console.log(`  superseded (hidden, not deleted) ${n(voteDuplicates)}  <- vote_duplicates; public views exclude them`);
  console.log(`  retracted (deleted, tombstoned) . ${n(retractedVotes)}  <- retracted_votes; full cast list preserved`);

  console.log('\nINGESTION FRESHNESS');
  for (const f of freshness) {
    const q = f.quarantined_days > 0 ? `  (${f.quarantined_days} days quarantined)` : '';
    console.log(`  ${String(f.source).padEnd(24)} ${String(f.status).padEnd(10)} last finished ${f.finished_at ? String(f.finished_at).slice(0, 19) : '(none)'}${q}`);
  }

  console.log('\nSUMMARY SCHEDULER');
  if (scheduler.status === 'never_ran') {
    console.log('  (never ran)');
  } else {
    const lastStarted = scheduler.lastTickStarted ? String(scheduler.lastTickStarted).slice(0, 19) : '(none)';
    console.log(`  last tick ........................ ${lastStarted} status=${scheduler.lastTickRunStatus}`);
    console.log(`  spent this week ................. $${scheduler.weeklySpentUsd.toFixed(2)} of $${scheduler.weeklyCapUsd.toFixed(2)}`);
    console.log(`  published this week ............ ${scheduler.publishedThisWeek}`);
    if (scheduler.parkedCount > 0) {
      console.log(`  parked (structural failures) .... ${scheduler.parkedCount}`);
    }
  }

  console.log('\nStructure and meaning of these numbers: docs/DATA_INVENTORY.md');
}

main().catch((err) => {
  console.error('data-status failed:', err.message);
  process.exit(1);
});
