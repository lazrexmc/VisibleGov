// build-drain-wave.mjs <wave-name> <batch-size>
//   node --env-file=.env scripts/build-drain-wave.mjs <wave-name> <batch-size>
//
// Emits wave args for the summary-wave reAuthor lane from the current DB draft pile: for each
// bill whose ONLY summary state is a draft, reconstructs the mechanical gates' objections and
// batches the smallest bills first, writing .superpowers/artifacts/wave3/wave-<name>-args.json.
//
// Two objection sources, tried in order:
//   1. On-disk envelope (records-*.json in the wave3 artifacts dir) — the fast path for drafts
//      written by waves this repo still has records files for.
//   2. THE DATABASE (the 2026-08-15 upgrade): drafts with no on-disk envelope carry the same
//      evidence in Supabase — the draft row's body_md (renderMarkdown output, parsed back to
//      {what_it_does, stated_purpose}) and its summary_verifications rows (kind='support' for
//      refuted verdicts, kind='completeness' for coverage misses). Bill text comes hash-checked
//      from bill_texts and is materialized to the artifacts bills/ dir for the wave agents.
//
// Both paths compute the SAME three objection kinds record's gates enforce: refuted verdicts,
// completeness coverage misses, and an ungrounded stated_purpose. Drafts with no computable
// objections are skipped (they need a re-verify or fresh lane, not re-authoring).
//
// Grew up in the 2026-08-10..14 drain campaign's scratchpad; promoted into scripts/ with the DB
// path so it survives scratchpad cleanup. History: CHATLOG 2026-08-14 drain-wave entries.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { getClient } from '../src/lib/db.js';
import { parseBodyMd, computeObjections } from '../src/lib/draft-objections.js';

const waveName = process.argv[2];
const batchSize = Number(process.argv[3] ?? 12);
if (!waveName) throw new Error('usage: node --env-file=.env scripts/build-drain-wave.mjs <wave-name> <batch-size>');

const DIR = new URL('../.superpowers/artifacts/wave3', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '');

// Bills parked out of the drain lane with documented reasons (structural failures / exhausted
// retries — see CHATLOG 2026-08-11..14). NOT retryable by this lane; human review.
const PARKED = new Set([
  // 2026-08-18: HB 606, HB 64, SB 626, HB 1607 UNPARKED — their park class (the fixed
  // MIN_KEY_PROVISIONS floor rejecting honest 1-2 provision yields on >=5k-char bills) is
  // repaired by the corroborated-honest-yield gate (spec 2026-08-18). Every 3-strike park stays.
  '4e279660-f955-4284-8ca6-5e56d997b44a', // HR 3944 MilCon/VA/Ag/LegBranch appropriation — 3 attempts exhausted 2026-08-18; shifting-demands class (HR 8646/HB 1633): the checker demanded Division C coverage (covered in DT), then Sec. 742 China-poultry (covered in DU), then a NEVER-BEFORE-REQUESTED Sec. 734 embryo-modification bar on the final attempt — a different provision of this 324k-char three-division omnibus each round; the appended Division-C compensation bullet also drew a heading-scope refutation; human review should confirm, 2026-08-18
  '02f8c815-1bb8-4d41-9c57-c958e18f2340', // HB 564 Fresh Start Act — 3 attempts exhausted 2026-08-18; rotating-refutation/cited-section-alone class: each round fixed the prior objections and deep verification found NEW ones — final attempt drew 3 refutations (324.1112 and 340.274 never NAME private investigators/veterinarians in the cited section's own text, only chapter context does; the 327.131 bullet — phrased from the checker's own demand — overclaimed beyond architects). A 368k-char 75-section repeal-and-replace defeats section-alone provability; human review should confirm, 2026-08-18
  '82bb1592-f087-4241-8dfb-a790f48636dd', // SRES 532 — 2-strikes Malformed via the corroboration gate 2026-08-18, checker-limitation class (SB 909/SB 655): an en-bloc 97-nomination list defeats stable provision citation — DR's run had primary yield 1 vs corroborator 2 (count rule), DS's run had the corroborator grounding in the "EXECUTIVE RESOLUTION" heading matching no primary section (overlap rule); both refusals fail-closed and correct, but the document class (a list, not sectioned legislation) cannot satisfy the checker contract; the DRAFT itself verified clean twice (9/9, 12/12); human review should confirm
  'c6b1fd1f-6d32-49cf-9fa3-841bca8fb2f3', // SJR 46 — 3 attempts exhausted 2026-08-18; rotating citation-target crossfire: the submission-to-voters bullet was refuted at Section A (DQ), the completeness checker TWICE independently grounded that provision in the resolving clause, the final attempt cited that same resolving clause and the verifier refuted THAT too (the substance lives in the unlabeled paragraph after it) — checker and verifier disagree about which citable string carries the provision; human review should confirm, 2026-08-18
  'b4f00aa2-9cc2-4323-b13e-b9a74f9b8399', // HR 8646 ag/FDA appropriation — 3 attempts exhausted 2026-08-18; shifting-demands class (HB 1633/HB 352): DP's two objections were both FIXED and HELD (58 verdicts, ZERO refutations on the final attempt) but the completeness gate demanded a NEW Sec. 726 SNAP-retailer-rule provision it never asked for in two prior rounds — the checker picks a different provision of this 175k-char omnibus each round; human review should confirm, 2026-08-18
  '0e3279bf-e7df-4374-b5a4-fb82f3db9c6a', // HB 569 — 3 attempts exhausted 2026-08-14 (emergency clause, then short title)
  '92ea0b8d-6383-47df-b7cd-1a8f46ece4e8', // HR 2683 — 3 attempts exhausted 2026-08-14 (amendment-mapping overstatements)
  '374bfa04-a3ef-4b1a-afe7-dbd6b74bde52', // SB 786 — 3 attempts exhausted 2026-08-14 (unbracketed civil-action redline language)
  '0df013ec-35f6-4166-9d64-3b00ca375e83', // SB 644 — 3 attempts exhausted 2026-08-14 (service-dog category definitions last)
  '05304e79-e520-4b3e-a833-db73e46d74e0', // HRES 1423 — 3 attempts exhausted 2026-08-15 (4-bill House rule: completeness checker demands per-bill Sec. 2/7/8 bullets the author keeps condensing)
  '27c2552e-b898-4be8-94f3-19dc5eab2f0d', // SB 655 — 3 attempts exhausted (waves L, N, U all flagged; 45-verdict 3rd attempt still missed), 2026-08-16
  '0236add8-d856-4f61-a808-656f55b1e207', // HB 589 — 3 attempts exhausted (578.012/578.030 omissions, then 578.005 omission in CN, then adds-vs-kept mischaracterization in CO at 44 verdicts), 2026-08-16
  'b2617af8-7d99-42ee-8554-bee87b0bb404', // HR 4776 SPEED Act — 3 attempts exhausted (short-title omission, then 3 omissions in CO, then 2 DIFFERENT omissions in CP: the blind checker's demands shift each round on this omnibus NEPA bill — HRES 1423 condensing class), 2026-08-16
  '2df6f9f8-ad30-4d19-b8ac-ffe511f83275', // HB 369 — 3 attempts exhausted; CHECKER-LIMITATION class: blind completeness checker twice (CP, CQ) demanded a bullet saying the bill "creates the Animal Health Fund," but that language is BRACKETED (repealed) in the printed text — the author correctly refuses to state it; human review should confirm, 2026-08-16
  '234b550c-8b68-4e2b-981f-3a639095aab7', // SB 794 — 3 attempts exhausted; checker-vs-verifier crossfire: completeness checker demanded a bracketed-'or' deletion bullet, author added it, verifier then refuted its citation (the EXPLANATION note is bill-wide boilerplate near Section A, not inside subdivision (19)) — cited-section-alone discipline makes the demanded bullet unwritable; human review should confirm, 2026-08-16
  '2315960f-ffa9-4eca-9b07-aab33be119dc', // HB 1466 — 3 attempts exhausted; shifting-demands class (HRES 1423): checker demanded written-report bullet (CR), draft added it plus the demanded "Department" definition, checker then demanded a "Certification" definition bullet (CS) — its defined-terms demands shift each round on this 20-definition section, 2026-08-16
  '315261e6-ad58-4f16-92af-cdf15fd2cb2f', // HB 1561 — 3 attempts exhausted (Section-A characterization, then refund-retention omission in CS, then a redistribution-formula logarithm precision refutation in CT at 37 verdicts) — each round fixed the prior flag and deep verification found a new precision error in this dense tax-formula bill, 2026-08-16
  '2b488318-4f14-41c1-8560-e7b9d93eb3b3', // HB 685 — 3 attempts exhausted (campaign wave-q flag, then b20 162.291 "school" refutation in CT, then b15 105.035 new-section attribution in CU at 37 verdicts) — a different single-bullet refutation each round; each re-author fixed the prior objection and deep verification found a new attribution-precision error, 2026-08-16
  '3300757f-390f-4dbe-8258-bcdcd23a3c5f', // SB 623 — 3 attempts exhausted; shifting-demands class (HRES 1423): checker demanded the 452.402 residency-ground bullet (wave-r), author added it and the verifier refuted the word "Adds" (CW, novelty unprovable — brackets mark deletions only), final attempt stated the provision correctly with ZERO verifier refutations at 26 verdicts and the checker then demanded a NEW 210.566 foster-parent-rights bullet (CX) — demands shift each round; human review should confirm, 2026-08-16
  '05728fea-4bb1-4e06-9e34-5370d532e3e4', // HB 1696 — 3 attempts exhausted; rotating single-refutation class (HB 685/HB 1561): campaign special-prosecutor attachment flag, then CX's subsection-1-only suspended-imposition scope, then CY's b10 dropped "while actually engaged in assisting" qualifier at 32 verdicts — each re-author fixed the prior refutation and deep verification found a new precision error in this dense weapons statute, 2026-08-16
  '0a7376ce-f3b6-4a68-8ff4-838ec7d65cce', // HB 3 FY2024 higher-ed appropriation — 3 attempts exhausted; rotating single-refutation class: campaign 3.005-flexibility scoping flag, then CZ's b59 "otherwise than" negation addition in 3.310, then DA's b31 mis-scoping the discrete-accounts/no-DWD proviso beyond the $8M DOL/TAA item in 3.130 at 64 verdicts — each re-author fixed the prior refutation and deep verification found a new proviso-scoping error in this dense appropriation, 2026-08-16
  '084a362c-f3f6-4c85-a690-bb14e2a73276', // HB 2057 concealed carry/use of force — 3 attempts exhausted; rotating single-refutation class: campaign stated_purpose verbatim gate, then DC's b59 Section B effective-date inference + demanded emergency-clause bullet, then DD fixed both and deep verification found b4 (deadly-force "only when" omitting the third independent private-property condition) and b13 (exemption stated as unqualified despite the chapeau's "except as otherwise provided" qualifier) at 60 verdicts — dense use-of-force statute; each re-author fixed the prior objections and new precision errors surfaced, 2026-08-16
  '25a7406c-11b4-40c6-bb16-6885f47339c9', // SB 909 trusts/digital assets — 3 attempts exhausted; shifting-demands/checker-limitation class (HRES 1423/SB 623): campaign wave-u flag, then DC's b11 added-vs-renumbered trust-protector refutation, then DD's re-author fixed it and passed 53 verdicts with ZERO refutations — but the completeness gate demanded 456.8-808/456.1-103 bullets that the draft ALREADY covers split across multiple bullets (powers list, fiduciary capacity, exoneration, and all three definitions each have their own bullet); the checker's compound items don't map one-to-one onto the draft's bullet granularity — human review should confirm, 2026-08-16
  '22aeb2e1-170c-4c84-88b8-8fa662ce9184', // SB 655 marriage-age/sex-offender-registry — 3 attempts exhausted; shifting-demands/checker-limitation class (SB 909/SB 623): campaign wave-u flag, then DE's completeness gate demanded 589.404's adjudicated-definition content (added in DF), then DF passed 61 verdicts with ZERO refutations and the gate demanded a DIFFERENT compound 589.400 bullet (adjudicated-basis + tier periods + clean-record reduction) whose content the draft already covers across separate bullets — the checker's compound items shift each round and don't map onto the draft's bullet granularity; human review should confirm, 2026-08-17
  '2f1f331f-8b87-435b-8ff2-5ff3546413a7', // HB 1633 criminal offenses — 3 attempts exhausted; shifting-demands class (SB 655/SB 909): campaign wave-x flag, then DL's gate demanded 577.010 DWI-penalty and 610.140 expungement bullets (both added in DM plus the demanded six-month/lifetime-caps bullet), then DM passed 35 verdicts with ZERO refutations and the gate demanded a NEW 577.010 LEO/emergency-personnel-victim felony-tier bullet — the checker picks a different provision of this 30-section omnibus each round; human review should confirm, 2026-08-17
  '16dc9151-2018-474e-ab5f-e5e94a0e0aec', // HB 352 corrections omnibus — 3 attempts exhausted; shifting-demands class (SB 655/SB 909): campaign wave-x flag, then DL's gate demanded 217.690 diploma-bar, 191.1165 MO HealthNet, and 217.692 eligibility bullets (all three added in DM), then DM passed 46 verdicts with ZERO refutations and the gate demanded a NEW 650.058 DNA-actual-innocence-restitution bullet — the checker picks a different provision of this 50-section omnibus each round; human review should confirm, 2026-08-17
  '119697c1-7f0d-44b7-8a76-2112bc19ab3e', // SB 6 controlled substances — 3 attempts exhausted; rotating single-refutation class (HB 685/HB 1561/HB 2057): campaign wave-x flag, then DN's 3 precision refutations (ID-alternative, throughout-the-sections scope, 450g MDMA branch — all three fixed and held in DO), then DO's 55 verdicts surfaced 2 NEW refutations (195.010's hemp definition has seed/commodity parts (b)-(c) beyond the nonseed clause; the 450g class A list also includes phenmetrazine and methylphenidate) — each re-author fixes the prior round and deep verification finds new precision errors in this dense drug statute; human review should confirm, 2026-08-17
  '045926b8-d3b4-4c2e-9d84-7dd9bcb91e04', // HB 814 financial institutions — 3 attempts exhausted; rotating single-refutation class (SB 6/HB 685): campaign flag, then DO's b10 municipality-parenthetical refutation (fixed and held in DP), then DP's 87 verdicts surfaced 2 NEW refutations (285.1025's not-involved proviso attaches only to the administration/investment item, not all listed protections; b81 attributed the once-per-twelve-months deferral-limit removal to 408.178 when that limit lived only in old 408.140) — each re-author fixes the prior round and deep verification finds new precision errors in this 48-section omnibus; human review should confirm, 2026-08-17
]);

async function selectAllPaged(client, table, columns, applyFilters) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = client.from(table).select(columns).range(from, from + 999);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} lookup failed: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const client = getClient();

// 1. live draft pile → draft-only bills (no published/approved row anywhere; rejected rows are
// fine — they're retired). Last draft row wins (planWork convention).
const summaryRows = await selectAllPaged(client, 'summaries', 'id,bill_id,bill_text_hash,status');
const byBill = new Map();
for (const s of summaryRows) {
  const list = byBill.get(s.bill_id) ?? [];
  list.push(s);
  byBill.set(s.bill_id, list);
}
const draftOnly = new Map();
for (const [billId, rows] of byBill) {
  if (rows.some((r) => r.status === 'published' || r.status === 'approved')) continue;
  const draftRows = rows.filter((r) => r.status === 'draft');
  if (draftRows.length === 0) continue;
  draftOnly.set(billId, draftRows[draftRows.length - 1]);
}
console.log('draft-only bills in DB:', draftOnly.size);

// 2. latest envelope per bill from records files (mtime ascending; later overwrite earlier)
const recordFiles = readdirSync(DIR).filter((f) => /^records-.*\.json$/.test(f))
  .map((f) => ({ f, mtime: statSync(`${DIR}/${f}`).mtimeMs }))
  .sort((a, b) => a.mtime - b.mtime);
const envByBill = new Map();
for (const { f } of recordFiles) {
  let payload;
  try { payload = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')); } catch { continue; }
  for (const r of (payload.results ?? [])) {
    if (r && r.bill_id && r.summary) envByBill.set(r.bill_id, r);
  }
}
console.log('envelopes on disk:', envByBill.size);

// 3. meta (title/text_length/text_file) from manifest + wave args files, for the envelope path
const meta = new Map();
for (const f of readdirSync(DIR).filter((x) => x === 'manifest.json' || /^wave-.*-args\.json$/.test(x))) {
  try {
    for (const b of JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'))) {
      if (b && b.bill_id && b.text_file) meta.set(b.bill_id, b);
    }
  } catch { /* reAuthor args files share the fields we read; unparseable files are skipped */ }
}

const candidates = [];
const skipped = { hashDrift: 0, noObjections: 0, noText: 0 };
const noEnvelope = [];
for (const [billId, draft] of draftOnly) {
  if (PARKED.has(billId)) continue;
  const env = envByBill.get(billId);
  if (!env) { noEnvelope.push({ billId, draft }); continue; }
  if (env.bill_text_hash !== draft.bill_text_hash) { skipped.hashDrift += 1; continue; }
  const m = meta.get(billId);
  const textFile = m?.text_file ?? `.superpowers/artifacts/wave3/bills/${billId}.txt`;
  if (!existsSync(`${DIR}/../../../${textFile}`) && !existsSync(textFile)) { skipped.noText += 1; continue; }
  const text = readFileSync(existsSync(textFile) ? textFile : `${DIR}/../../../${textFile}`, 'utf8');
  const objections = computeObjections({
    verdicts: env.verdicts,
    completeness: env.completeness,
    statedPurpose: env.summary?.stated_purpose ?? '',
    text,
  });
  if (objections.length === 0) { skipped.noObjections += 1; continue; }
  candidates.push({
    bill_id: billId,
    identifier: env.identifier ?? billId,
    title: m?.title ?? env.identifier ?? billId,
    bill_text_hash: env.bill_text_hash,
    text_length: m?.text_length ?? text.length,
    text_file: textFile,
    reAuthor: { prior_summary: env.summary, objections },
  });
}

// 4. THE DB PATH — no-envelope drafts. Everything the envelope carried lives in Supabase:
//    body_md (the draft's own rendered summary), summary_verifications (the gates' receipts),
//    bill_texts (the hash-pinned text), bills (identifier/title).
const dbSkipped = { noVerifications: 0, noObjections: 0, hashDrift: 0, noText: 0 };
let dbCandidates = 0;
if (noEnvelope.length > 0) {
  const draftIds = noEnvelope.map((x) => x.draft.id);
  const billIds = noEnvelope.map((x) => x.billId);

  const bodyById = new Map();
  for (const ids of chunk(draftIds, 50)) {
    const { data, error } = await client.from('summaries').select('id,body_md').in('id', ids);
    if (error) throw new Error(`summaries body_md lookup failed: ${error.message}`);
    for (const row of data) bodyById.set(row.id, row.body_md);
  }

  // Per summary+kind there is at most one verification row (record writes them once per new
  // summary row); keep the last seen defensively if that ever changes.
  const verBySummary = new Map();
  for (const ids of chunk(draftIds, 50)) {
    const { data, error } = await client.from('summary_verifications').select('summary_id,kind,verdicts').in('summary_id', ids);
    if (error) throw new Error(`summary_verifications lookup failed: ${error.message}`);
    for (const row of data) {
      const entry = verBySummary.get(row.summary_id) ?? {};
      entry[row.kind] = row.verdicts;
      verBySummary.set(row.summary_id, entry);
    }
  }

  const billMeta = new Map();
  for (const ids of chunk(billIds, 50)) {
    const { data, error } = await client.from('bills').select('id,identifier,title').in('id', ids);
    if (error) throw new Error(`bills lookup failed: ${error.message}`);
    for (const row of data) billMeta.set(row.id, row);
  }

  // Current text per bill = most recent retrieved_at (same reduction summary-queue.js applies).
  const textByBill = new Map();
  for (const ids of chunk(billIds, 25)) {
    const { data, error } = await client.from('bill_texts').select('bill_id,content,content_hash,retrieved_at').in('bill_id', ids);
    if (error) throw new Error(`bill_texts lookup failed: ${error.message}`);
    for (const row of data) {
      const existing = textByBill.get(row.bill_id);
      if (!existing || String(row.retrieved_at) > String(existing.retrieved_at)) textByBill.set(row.bill_id, row);
    }
  }

  for (const { billId, draft } of noEnvelope) {
    const textRow = textByBill.get(billId);
    if (!textRow) { dbSkipped.noText += 1; continue; }
    if (textRow.content_hash !== draft.bill_text_hash) { dbSkipped.hashDrift += 1; continue; }
    const vers = verBySummary.get(draft.id);
    if (!vers || (!vers.support && !vers.completeness)) { dbSkipped.noVerifications += 1; continue; }
    const priorSummary = parseBodyMd(bodyById.get(draft.id));
    const objections = computeObjections({
      verdicts: vers.support,
      completeness: vers.completeness,
      statedPurpose: priorSummary.stated_purpose,
      text: textRow.content,
    });
    if (objections.length === 0) { dbSkipped.noObjections += 1; continue; }
    const textFile = `.superpowers/artifacts/wave3/bills/${billId}.txt`;
    const absTextFile = `${DIR}/bills/${billId}.txt`;
    if (!existsSync(absTextFile)) writeFileSync(absTextFile, textRow.content, 'utf8');
    const b = billMeta.get(billId);
    candidates.push({
      bill_id: billId,
      identifier: b?.identifier ?? billId,
      title: b?.title ?? b?.identifier ?? billId,
      bill_text_hash: draft.bill_text_hash,
      text_length: textRow.content.length,
      text_file: textFile,
      reAuthor: { prior_summary: priorSummary, objections },
    });
    dbCandidates += 1;
  }
}

candidates.sort((a, b) => a.text_length - b.text_length);
console.log('re-authorable drafts:', candidates.length,
  `(disk-envelope ${candidates.length - dbCandidates}, db ${dbCandidates})`);
console.log('skipped (disk path):', JSON.stringify(skipped), '| skipped (db path):', JSON.stringify(dbSkipped));
const wave = candidates.slice(0, batchSize);
writeFileSync(`${DIR}/wave-${waveName}-args.json`, JSON.stringify(wave), 'utf8');
console.log(`wave ${waveName}:`, wave.length, '| sizes', wave[0]?.text_length, '-', wave[wave.length - 1]?.text_length);
console.log(wave.map((o) => `${o.identifier}(${o.reAuthor.objections.length})`).join(', '));
