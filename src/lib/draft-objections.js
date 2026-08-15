// src/lib/draft-objections.js — the conversion lane's evidence: reconstructing a draft's own
// prior summary and the mechanical gates' objections against it, from either a rendered body_md
// string (envelope/disk path) or the DATABASE (spec: "Objections are read from the DATABASE, not
// wave artifacts"). Extracted VERBATIM from scripts/build-drain-wave.mjs (committed 306ee11,
// live-validated across two drain waves on all 103 DB-path drafts, 2026-08-15) so the drainer and
// any future re-author caller share one implementation. Never touches the network itself; the
// Supabase client is injected so tests can fake it.

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

// parseBodyMd — inverse of src/lib/summarizer.js renderMarkdown ("**What it does:**\n- point
// (section)\n...\n\n**Stated purpose (from the bill):** ..."). The trailing (section) is found by
// balanced-paren scan from the end, since both points and sections may contain parentheses.
export function parseBodyMd(md) {
  const whatItDoes = [];
  let statedPurpose = '';
  const PURPOSE_PREFIX = '**Stated purpose (from the bill):**';
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) {
      const item = line.slice(2).trim();
      let parsed = null;
      if (item.endsWith(')')) {
        let depth = 0;
        let i = item.length - 1;
        for (; i >= 0; i -= 1) {
          if (item[i] === ')') depth += 1;
          else if (item[i] === '(') { depth -= 1; if (depth === 0) break; }
        }
        if (i > 0 && item[i - 1] === ' ') {
          parsed = { point: item.slice(0, i - 1).trim(), section: item.slice(i + 1, -1) };
        }
      }
      whatItDoes.push(parsed ?? { point: item, section: '' });
    } else if (line.startsWith(PURPOSE_PREFIX)) {
      statedPurpose = line.slice(PURPOSE_PREFIX.length).trim();
    }
  }
  return { what_it_does: whatItDoes, stated_purpose: statedPurpose };
}

// computeObjections — the single objection derivation both sources feed. Mirrors the mechanical
// gates in src/cli/summary-queue.js: refuted support verdicts, completeness coverage misses, and
// a non-empty stated_purpose that is not a verbatim (whitespace-collapsed) substring of the text.
export function computeObjections({ verdicts, completeness, statedPurpose, text }) {
  const objections = [];
  for (const v of verdicts ?? []) {
    if (!v.supported) objections.push(`Bullet ${v.bullet_index} (cited ${v.section}) was REFUTED by the verifier: ${v.reason}`);
  }
  const kp = completeness?.key_provisions ?? [];
  for (const c of completeness?.coverage ?? []) {
    if (c.covered === false && kp[c.provision_index]) {
      const p = kp[c.provision_index];
      objections.push(`The summary OMITS a key provision the completeness checker found in the text — add a bullet covering it: [${p.section}] ${p.provision}`);
    }
  }
  if (statedPurpose && !collapse(text).includes(collapse(statedPurpose))) {
    objections.push('stated_purpose is NOT a verbatim substring of the bill text. Either quote the bill\'s own purpose language exactly (verbatim, whitespace may collapse) or return an empty string for stated_purpose.');
  }
  return objections;
}

// loadDraftObjections — the conversion lane's evidence reader (spec: "Objections are read from
// the DATABASE, not wave artifacts"). Sources: (a) the draft's own summary_verifications rows —
// kind='support' refuted verdicts, kind='completeness' coverage misses; (b) the draft's
// body_md-derived stated_purpose checked against the hash-pinned text; (c) any summary_notes
// gate-reason rows, appended verbatim but deduplicated (whitespace-collapsed) against the
// objections already computed from (a)+(b).
const GATE_NOTE_RE = /^(summary omits |stated_purpose |verdicts\[\d+\] cites section )/;

export async function loadDraftObjections(client, { draftId, text }) {
  const { data: srow, error: sErr } = await client.from('summaries').select('id,body_md').eq('id', draftId).single();
  if (sErr) throw new Error(`summaries body_md lookup failed for ${draftId}: ${sErr.message}`);
  const { data: vrows, error: vErr } = await client.from('summary_verifications').select('kind,verdicts').eq('summary_id', draftId);
  if (vErr) throw new Error(`summary_verifications lookup failed for ${draftId}: ${vErr.message}`);
  const { data: nrows, error: nErr } = await client.from('summary_notes').select('note,action').eq('summary_id', draftId);
  if (nErr) throw new Error(`summary_notes lookup failed for ${draftId}: ${nErr.message}`);

  const byKind = {};
  for (const r of vrows ?? []) byKind[r.kind] = r.verdicts;
  const priorSummary = parseBodyMd(srow.body_md);
  const objections = computeObjections({
    verdicts: byKind.support,
    completeness: byKind.completeness,
    statedPurpose: priorSummary.stated_purpose,
    text,
  });
  const seen = new Set(objections.map(collapse));
  for (const nrow of nrows ?? []) {
    const note = String(nrow?.note ?? '');
    if (GATE_NOTE_RE.test(note) && !seen.has(collapse(note))) {
      objections.push(note);
      seen.add(collapse(note));
    }
  }
  return { priorSummary, objections, hasVerifications: Boolean(byKind.support || byKind.completeness) };
}
