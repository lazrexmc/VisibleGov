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

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — run with `node --env-file=.env`');
  process.exit(1);
}
const H = { apikey: key, Authorization: `Bearer ${key}` };
const asJson = process.argv.includes('--json');

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
    sumPublished, sumDraft, glossPublished, glossTotal,
    identityOpen, reconOpen,
  ] = await Promise.all([
    count('vote_casts?select=id'), count('votes?select=id'), count('bills?select=id'),
    count('bill_texts?select=id'), count('bill_sponsors?select=id'),
    count('legislators?select=id'), count('persons?select=id'), count('person_links?select=id'),
    count('terms?select=id'),
    count('summaries?status=eq.published&select=id'), count('summaries?status=neq.published&select=id'),
    count('glossary_terms?status=eq.published&select=id'), count('glossary_terms?select=id'),
    count('identity_flags?resolved=is.false&select=id'),
    count('vote_reconciliation_flags?resolved=is.false&select=id'),
  ]);

  // Glossary needs a breakdown, not just a total: the gap between published and total is dominated
  // by `needs_mapping` — terms the extractor could not confidently resolve to a citation. Those are
  // a curation backlog, NOT failures, and reporting only "116 published" hid 704 of them for weeks.
  const glossNeedsMapping = await count('glossary_terms?needs_mapping=is.true&select=id');
  const glossDraftMappable = glossTotal - glossPublished - glossNeedsMapping;

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
      summariesDraftOrFlagged: sumDraft,
    },
    coverage,
    castsByYear: years,
    operatorQueue: {
      identityFlagsOpen: identityOpen,
      reconciliationFlagsOpen: reconOpen,
      summariesAwaitingReview: sumDraft,
      glossaryAwaitingReview: glossDraftMappable,
      glossaryNeedsMappingBacklog: glossNeedsMapping,
    },
    freshness,
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
  console.log(`    ...draft, mappable .... ${n(glossDraftMappable)}  <- awaiting review/publish`);

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
  console.log(`  summaries draft/flagged .............. ${n(sumDraft)}  <- held back by the trust gate`);

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
  console.log(`  summaries awaiting review ..... ${sumDraft}`);
  console.log(`  glossary awaiting review ...... ${n(glossDraftMappable)}`);
  console.log(`  glossary needs_mapping ........ ${n(glossNeedsMapping)}  (curation backlog, not errors)`);

  console.log('\nINGESTION FRESHNESS');
  for (const f of freshness) {
    const q = f.quarantined_days > 0 ? `  (${f.quarantined_days} days quarantined)` : '';
    console.log(`  ${String(f.source).padEnd(24)} ${String(f.status).padEnd(10)} last finished ${f.finished_at ? String(f.finished_at).slice(0, 19) : '(none)'}${q}`);
  }
  console.log('\nStructure and meaning of these numbers: docs/DATA_INVENTORY.md');
}

main().catch((err) => {
  console.error('data-status failed:', err.message);
  process.exit(1);
});
