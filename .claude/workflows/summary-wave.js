export const meta = {
  name: 'summary-wave-3',
  description: 'Author + adversarially verify plain-language summaries for 12 queued bills ($0 subagent path, trust model v3)',
  phases: [
    { title: 'Summarize', detail: 'per bill: opus author -> sonnet verify -> blind provisions -> coverage' },
  ],
}

// args = the wave manifest: [{bill_id, identifier, title, bill_text_hash, text_file, text_length}]
// The harness has been observed delivering args as a JSON-encoded STRING despite a JSON-array
// parameter — normalize both shapes before validating.
let BILLS = args
if (typeof BILLS === 'string') {
  try { BILLS = JSON.parse(BILLS) } catch (e) { throw new Error(`args string is not valid JSON: ${e.message}`) }
}
if (!Array.isArray(BILLS) || BILLS.length === 0) throw new Error('manifest args required (array of bills)')

const REPO = 'F:/VisibleGov'

const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['what_it_does', 'stated_purpose', 'classification', 'referenced_terms'],
  properties: {
    what_it_does: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['point', 'section'], properties: { point: { type: 'string' }, section: { type: 'string' } } } },
    stated_purpose: { type: 'string' },
    classification: { type: 'string', enum: ['amends_existing_law', 'new_program', 'appropriation', 'resolution', 'other'] },
    referenced_terms: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['term', 'kind', 'citation_raw'], properties: { term: { type: 'string' }, kind: { type: 'string', enum: ['statute', 'act', 'agency', 'program', 'public_law'] }, citation_raw: { type: 'string' } } } },
  },
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts', 'overall'],
  properties: {
    verdicts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['bullet_index', 'section', 'supported', 'reason', 'evidence_quote'], properties: { bullet_index: { type: 'integer' }, section: { type: 'string' }, supported: { type: 'boolean' }, reason: { type: 'string' }, evidence_quote: { type: 'string' } } } },
    overall: { type: 'string', enum: ['clean', 'flagged'] },
  },
}

// minItems 1, not 3: the gate's length-scaled floor (verifier.js minKeyProvisionsFor) is the real
// bound — a schema floor of 3 forced tiny-bill checkers to pad with boilerplate (wave-C catch-22).
const PROVISIONS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['key_provisions'],
  properties: { key_provisions: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'object', additionalProperties: false, required: ['section', 'provision'], properties: { section: { type: 'string' }, provision: { type: 'string' } } } } },
}

const COVERAGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['coverage'],
  properties: { coverage: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['provision_index', 'covered', 'bullet_index', 'note'], properties: { provision_index: { type: 'integer' }, covered: { type: 'boolean' }, bullet_index: { type: ['integer', 'null'] }, note: { type: 'string' } } } } },
}

const VERBATIM_RULE = 'MECHANICAL GROUNDING RULE (a code gate rejects violations whole): every `section` string you emit MUST appear VERBATIM as a substring of the bill text (e.g. "Sec. 2" only if the text prints "Sec. 2"; never invent dotted ranges like "233.295.2-3" or normalize the text\'s own spelling). Every quote field must be copied exactly from the text.'

phase('Summarize')

const results = await pipeline(
  BILLS,
  // Stage 1: author. A manifest item may carry `preAuthored` (a SUMMARY_SCHEMA object banked by
  // the API author-only mode's checkpoint — see docs/RUNBOOK_SUMMARY_WAVES.md); then the author
  // stage is a no-op and the wave spends its subscription tokens ONLY on the verification stages.
  // The item should also carry author_model/author_provenance for the record envelope.
  (bill) => (bill.preAuthored
    ? Promise.resolve({ summary: bill.preAuthored })
    : bill.checkpoint_file
      ? agent(
        `Read the JSON file at ${REPO}/${bill.checkpoint_file}. Return EXACTLY the object stored under its "summary" key — a verbatim transcription, no edits, no additions, no reformatting of any string. If the file or key is missing, return {"what_it_does":[],"stated_purpose":"","classification":"other","referenced_terms":[]}.`,
        { label: `bank-load:${bill.identifier}`, phase: 'Summarize', model: 'haiku', effort: 'low', schema: SUMMARY_SCHEMA }
      ).then((summary) => ({ summary }))
      : agent(
    `You are the AUTHOR stage of VisibleGov's trust-model-v3 summary chain. Read the system-prompt contract in ${REPO}/src/lib/summarizer.js (the SYSTEM_PROMPT constant, around line 68) and follow it EXACTLY — it is your authoring law (facts only, every point cites its section, no party framing, plain language, stated_purpose ONLY from the bill's own purpose/findings language else empty string, referenced_terms only what the text itself names).\n\nThen Read the bill text at ${REPO}/${bill.text_file} (bill ${bill.identifier} — ${JSON.stringify(bill.title)}). If that file is missing or empty, DO NOT summarize anything else — return an empty what_it_does (the gate will reject it, which is correct).\n\nADDITIONAL MECHANICAL RULES the code gates enforce:\n- stated_purpose, when non-empty, must be a VERBATIM substring of the bill text (whitespace may collapse; words/characters may not change). If the bill's purpose language cannot be quoted verbatim, return "".\n- Every field is SINGLE-LINE: no newline characters inside point/section/stated_purpose/term/citation_raw.\n- ${VERBATIM_RULE}\n\nProduce the summary per the schema.`,
    { label: `author:${bill.identifier}`, phase: 'Summarize', model: 'opus', schema: SUMMARY_SCHEMA }
    ).then((summary) => ({ summary }))),
  // Stage 2: sonnet adversarially verifies every bullet. A manifest item may carry `preVerified`
  // (a prior wave's sonnet verdicts for the SAME summary at the SAME hash — the re-check lane over
  // flagged drafts): the stage is then a code no-op reusing those verdicts verbatim; the record
  // gates re-derive overall from them mechanically either way, so nothing trusts a self-report.
  (acc, bill) => (acc && acc.summary && Array.isArray(acc.summary.what_it_does) && acc.summary.what_it_does.length > 0
    ? (bill.preVerified
      ? Promise.resolve({ ...acc, verify: { verdicts: bill.preVerified } })
      : agent(
      `You are the ADVERSARIAL VERIFIER stage of VisibleGov's trust-model-v3 chain. Read the verifier contract in ${REPO}/src/lib/verifier.js (its VERIFY system prompt + VERIFY_SCHEMA) and follow it exactly: for EVERY bullet, decide whether the cited section, read on its own in the bill text, FULLY supports the bullet. Your default posture is refutation — supported:true only when the text genuinely proves it.\n\nRead the bill text at ${REPO}/${bill.text_file} (bill ${bill.identifier}).\n\nThe summary's bullets (index: point (section)):\n${acc.summary.what_it_does.map((b, i) => `${i}: ${b.point} (${b.section})`).join('\n')}\n\nMECHANICAL RULES the code gates enforce:\n- Emit EXACTLY one verdict per bullet, bullet_index 0..${acc.summary.what_it_does.length - 1}, no gaps, no duplicates.\n- Each verdict's \`section\` must be COPIED CHARACTER-FOR-CHARACTER from that bullet's own (section) shown above — never re-derived from the text.\n- evidence_quote: an EXACT verbatim quote from the bill text.\n- overall: 'clean' only if every verdict is supported:true, else 'flagged'.`,
        { label: `verify:${bill.identifier}`, phase: 'Summarize', model: 'sonnet', schema: VERIFY_SCHEMA }
      ).then((verify) => ({ ...acc, verify })))
    : acc),
  // Stage 3: BLIND provisions list — bill text only, never sees the summary
  (acc, bill) => (acc && acc.summary
    ? agent(
      `You are PHASE 1 (key provisions) of VisibleGov's completeness checker. You have NOT been shown any summary; do not assume, guess, or reference one. Read the completeness contract in ${REPO}/src/lib/verifier.js (COMPLETENESS_SYSTEM_PROMPT, phase 1 rules) and follow it exactly.\n\nRead the bill text at ${REPO}/${bill.text_file} (bill ${bill.identifier}). List the provisions a reader must know to understand what this bill actually does — 3 to 7 for a full-size bill, but if this bill genuinely contains fewer than 3 substantive provisions (common in very short bills), list ONLY the real ones; NEVER pad with enactment/codification boilerplate ("Chapter X is amended by adding section Y" is the vehicle, not a provision). For each: the section it lives in (copied from the text) and a short factual statement. Facts only — no significance language beyond what the text supports.\n\n${VERBATIM_RULE}`,
      { label: `provisions:${bill.identifier}`, phase: 'Summarize', model: 'sonnet', schema: PROVISIONS_SCHEMA }
    ).then((prov) => ({ ...acc, provisions: prov.key_provisions }))
    : acc),
  // Stage 4: coverage — provisions + bullets ONLY (no bill text; the separation is the check)
  (acc, bill) => (acc && acc.provisions && acc.summary
    ? agent(
      `You are PHASE 2 (coverage) of VisibleGov's completeness checker. Earlier, in phase 1, you listed a bill's key provisions from the bill text alone; now decide which of those provisions the summary's bullets cover. Follow ${REPO}/src/lib/verifier.js's COMPLETENESS_SYSTEM_PROMPT phase-2 rules exactly: one coverage entry per provision (provision_index 0..${acc.provisions.length - 1}); covered:true only with a genuinely covering bullet_index; covered:false -> bullet_index null and a note naming what's missing; NEVER force a weak/partial match to count.\n\nBill ${bill.identifier}.\n\nYour phase-1 key_provisions:\n${acc.provisions.map((p, i) => `${i}: [${p.section}] ${p.provision}`).join('\n')}\n\nThe summary's bullets:\n${acc.summary.what_it_does.map((b, i) => `${i}: ${b.point} (${b.section})`).join('\n')}`,
      { label: `coverage:${bill.identifier}`, phase: 'Summarize', model: 'sonnet', schema: COVERAGE_SCHEMA }
    ).then((cov) => ({ ...acc, coverage: cov.coverage }))
    : acc),
  // Stage 5: assemble the record envelope (pure code)
  (acc, bill) => {
    if (!acc || !acc.summary) return { bill_id: bill.bill_id, identifier: bill.identifier, failed: 'author-stage produced nothing' }
    const envelope = {
      bill_id: bill.bill_id,
      identifier: bill.identifier,
      bill_text_hash: bill.bill_text_hash,
      summary: acc.summary,
      // A banked (preAuthored) bill carries its true author identity from the manifest item;
      // a wave-authored bill is the opus subagent. Verification is always this wave's subagents.
      author_model: bill.author_model ?? 'claude-opus-5',
      verifier_model: 'claude-sonnet-5',
    }
    if (bill.author_provenance) envelope.author_provenance = bill.author_provenance
    if (acc.verify) envelope.verdicts = acc.verify.verdicts
    if (acc.provisions && acc.coverage) envelope.completeness = { key_provisions: acc.provisions, coverage: acc.coverage }
    return envelope
  },
)

const envelopes = results.filter(Boolean)
log(`${envelopes.filter((e) => !e.failed).length}/${BILLS.length} bills produced full envelopes`)
return { envelopes }
