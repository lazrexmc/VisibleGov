#!/usr/bin/env node
// audit-evidence-quotes — are the per-bullet citations on the public site actually in the bills?
//
// WHY. On 2026-10-06 wave W30's verifier for HB 14 returned 63 verdicts, all supported:true, bullet
// indices complete - and four of its evidence quotes did not exist in the bill. bullet 30 matched 11
// of 60 characters, bullet 34 nine of 70, bullet 57 fifteen of 67. The record gate published it,
// because `evidence_quote` was described as verbatim in VERIFY_SCHEMA and in the verifier prompt and
// checked by nothing. Migration 0021 exposes those quotes publicly as per-bullet citations, so an
// invented quote is an invented receipt - against the project's one non-negotiable.
//
// checkEvidenceQuoteGrounding now gates new publishes. This answers the other half: what is already
// published under the hole, and is HB 14 one bad agent or a standing problem.
//
// IT IMPORTS THE GATE rather than reimplementing the comparison. A second copy of the rule would
// eventually disagree with the first, and then neither number would mean anything - the same reason
// src/lib/anon-lock.js exists as one predicate instead of two. If the gate's normalization changes,
// this audit changes with it, by construction.
//
// Costs nothing: local string matching over rows already in the database. No model, no API.
//
//   node --env-file=.env scripts/audit-evidence-quotes.mjs            # summary
//   node --env-file=.env scripts/audit-evidence-quotes.mjs --json     # machine-readable
//   node --env-file=.env scripts/audit-evidence-quotes.mjs --limit 200
//
// Only PUBLISHED summaries with a kind='support' verification are audited: those are the rows whose
// citations migration 0021 actually exposes. A flagged draft's quotes are not published, so a bad
// quote there is not a public claim.

import { checkEvidenceQuoteGrounding } from '../src/cli/summary-queue.js';

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const PAGE = 500;

function need(name, value) {
  if (!value) {
    console.error(`${name} is not set — run with --env-file=.env`);
    process.exit(2);
  }
}

async function getAll(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${URL_BASE}/rest/v1/${path}&limit=${PAGE}&offset=${offset}`, { headers: H });
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    // expectArray discipline (PLAYBOOK 51): a non-array here is an unreadable answer, not an empty
    // one. Throwing beats reporting a clean audit over rows that were never examined.
    if (!Array.isArray(rows)) throw new Error(`${path} did not return an array: ${JSON.stringify(rows).slice(0, 200)}`);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

function pct(n, d) { return d > 0 ? ((100 * n) / d).toFixed(1) : '-'; }

async function main() {
  need('SUPABASE_URL', URL_BASE);
  need('SUPABASE_SERVICE_ROLE_KEY', KEY);
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const limitArg = args.indexOf('--limit');
  const cap = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

  const published = await getAll('summaries?status=eq.published&select=id,bill_id,bill_text_hash,published_at&order=published_at.asc');
  const audited = Number.isFinite(cap) ? published.slice(0, cap) : published;

  const offenders = [];
  let checked = 0;
  let noVerdicts = 0;
  let noText = 0;
  let totalQuotes = 0;
  let badQuotes = 0;

  for (const s of audited) {
    const vrows = await getAll(`summary_verifications?summary_id=eq.${s.id}&kind=eq.support&select=verdicts&order=created_at.desc`);
    const verdicts = vrows.length ? vrows[0].verdicts : null;
    if (!Array.isArray(verdicts) || verdicts.length === 0) { noVerdicts += 1; continue; }

    // The text the summary was written against, pinned by hash — not merely the newest row for the
    // bill. A quote must be verbatim in the text the author actually read; checking it against a
    // later revision would both miss real fabrications and invent false ones.
    const trows = await getAll(`bill_texts?bill_id=eq.${s.bill_id}&content_hash=eq.${encodeURIComponent(s.bill_text_hash)}&select=content`);
    const content = trows.length ? trows[0].content : null;
    if (typeof content !== 'string' || content === '') { noText += 1; continue; }

    checked += 1;
    totalQuotes += verdicts.length;
    const reason = checkEvidenceQuoteGrounding(verdicts, content);
    if (reason) {
      const m = reason.match(/^(\d+) of (\d+)/);
      const bad = m ? Number(m[1]) : 1;
      badQuotes += bad;
      offenders.push({
        summary_id: s.id, bill_id: s.bill_id, published_at: s.published_at, bad, of: verdicts.length, reason,
      });
    }
  }

  const report = {
    publishedTotal: published.length,
    auditedTotal: audited.length,
    checked,
    skippedNoSupportVerdicts: noVerdicts,
    skippedNoHashPinnedText: noText,
    quotesChecked: totalQuotes,
    quotesNotVerbatim: badQuotes,
    summariesWithAtLeastOneBadQuote: offenders.length,
    offenders,
  };

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log('EVIDENCE-QUOTE AUDIT — published summaries only (the rows 0021 exposes publicly)\n');
  console.log(`  published summaries ................. ${report.publishedTotal}`);
  console.log(`  audited ............................. ${report.auditedTotal}`);
  console.log(`  fully checked ....................... ${checked}`);
  console.log(`  SKIPPED, no support verdicts ........ ${noVerdicts}  <- nothing to check, not a pass`);
  console.log(`  SKIPPED, no hash-pinned text ........ ${noText}  <- UNVERIFIABLE, not a pass`);
  console.log(`  individual quotes checked ........... ${report.quotesChecked}`);
  console.log(`  quotes NOT verbatim ................. ${report.quotesNotVerbatim}  (${pct(badQuotes, totalQuotes)}% of quotes)`);
  console.log(`  summaries with >=1 bad quote ........ ${offenders.length}  (${pct(offenders.length, checked)}% of checked)\n`);

  if (offenders.length) {
    const worst = [...offenders].sort((a, b) => (b.bad / b.of) - (a.bad / a.of)).slice(0, 15);
    console.log('  worst by proportion:');
    for (const o of worst) {
      console.log(`    ${o.bad}/${o.of}  bill ${o.bill_id}  published ${String(o.published_at).slice(0, 10)}`);
    }
    console.log('\n  Those citations are rendered to readers. Each needs a re-verify pass, not a delete:');
    console.log('  the bullet may be perfectly true and only its quote invented.');
  } else {
    console.log('  No published summary carries a non-verbatim quote.');
  }
  console.log('\n  The two SKIPPED rows above are deliberately not counted as clean. A summary whose');
  console.log('  pinned text is gone cannot be audited, and reporting it as passing would be the');
  console.log('  absence-as-health failure this repo keeps hitting.');
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
