#!/usr/bin/env node
// wave-cost — what a summary wave actually cost, read from the agent transcripts already on disk.
//
// WHY THIS EXISTS. On 2026-09-05 two optimizations were proposed for the wave chain and both were
// wrong, because both were reasoned from a handful of numbers in run notifications rather than
// measured. The first claimed each agent re-reading verifier.js cost ~8% of a wave; the second
// claimed batching bills per agent would save 50%. The transcripts said otherwise: 77% of input is
// CACHE READS, billed at roughly a tenth of fresh input, so re-reading a shared file is nearly free
// and agent count is not the expensive axis. The alarming "78k cache creation, 0 cache reads" that
// started it was the FIRST message of ONE agent, before any cache existed - a single line
// generalized into a system property.
//
// This script spends nothing. Every wave already writes per-agent transcripts with a `usage` block
// on each assistant message; this reads them. The point is that the next person deciding whether a
// stage is expensive gets a number instead of an intuition.
//
//   npm run wave:cost            # every wave found, newest last
//   npm run wave:cost -- --json  # machine-readable
//   npm run wave:cost -- wf_c40   # only waves whose id starts with this
//
// Cost weighting: cache reads are ~0.1x fresh input and cache writes ~1.25x, per Anthropic's
// published caching multipliers. `weighted` applies those so two waves with different cache hit
// rates can be compared honestly; `raw` is the plain sum and is what the run notification prints.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;
const OUTPUT_MULT = 5.0;

// Stage is recovered from the agent's own first prompt, NOT from the journal: journal keys are
// content hashes (`v2:<sha>`), which carry no label. Matching the prompt text means this keeps
// working if labels change, and fails loudly (as 'unclassified') rather than silently mislabelling.
export function classifyStage(promptText) {
  const t = String(promptText || '');
  if (/RE-AUTHORING a summary whose previous draft failed/i.test(t)) return 'reauthor';
  if (/You are the AUTHOR stage/i.test(t)) return 'author';
  if (/ADVERSARIAL VERIFIER/i.test(t)) return 'verify';
  if (/PHASE 2 \(coverage\)/i.test(t)) return 'coverage';
  if (/PHASE 1 \(key provisions\)/i.test(t)) return 'provisions';
  if (/transcribe/i.test(t) && /checkpoint/i.test(t)) return 'bank-load';
  return 'unclassified';
}

export function weightedTotal(u) {
  return Math.round(
    (u.input_tokens || 0)
    + (u.cache_read_input_tokens || 0) * CACHE_READ_MULT
    + (u.cache_creation_input_tokens || 0) * CACHE_WRITE_MULT
    + (u.output_tokens || 0) * OUTPUT_MULT,
  );
}

export function rawTotal(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
    + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
}

const EMPTY = () => ({
  input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
});

function addUsage(acc, u) {
  for (const k of Object.keys(acc)) acc[k] += u[k] || 0;
  return acc;
}

// One agent transcript -> its stage and its summed usage. Returns null for a file with no usage at
// all (an agent that errored before its first response), which is reported as a count rather than
// folded into the totals as a zero - a zero would understate the per-agent average.
export function readAgentFile(file) {
  const usage = EMPTY();
  let stage = null;
  let sawUsage = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.message;
    if (stage === null && m && m.role === 'user') {
      const c = m.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text || '').join(' ') : '';
      if (text) stage = classifyStage(text);
    }
    if (m && m.usage) { sawUsage = true; addUsage(usage, m.usage); }
  }
  return sawUsage ? { stage: stage || 'unclassified', usage } : null;
}

function readWave(dir) {
  const agents = readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
  const byStage = new Map();
  const total = EMPTY();
  let counted = 0;
  let noUsage = 0;
  for (const f of agents) {
    const r = readAgentFile(path.join(dir, f));
    if (!r) { noUsage += 1; continue; }
    counted += 1;
    addUsage(total, r.usage);
    if (!byStage.has(r.stage)) byStage.set(r.stage, { agents: 0, usage: EMPTY() });
    const s = byStage.get(r.stage);
    s.agents += 1;
    addUsage(s.usage, r.usage);
  }
  return {
    id: path.basename(dir), mtime: statSync(dir).mtimeMs, agents: counted, agentsWithoutUsage: noUsage, total, byStage,
  };
}

function findWaveDirs() {
  if (!existsSync(PROJECTS)) return [];
  const out = [];
  for (const proj of readdirSync(PROJECTS)) {
    if (!proj.toLowerCase().includes('visiblegov')) continue;
    const base = path.join(PROJECTS, proj);
    for (const sess of readdirSync(base)) {
      const wfRoot = path.join(base, sess, 'subagents', 'workflows');
      if (!existsSync(wfRoot)) continue;
      for (const wf of readdirSync(wfRoot)) {
        const d = path.join(wfRoot, wf);
        if (wf.startsWith('wf_') && statSync(d).isDirectory()) out.push(d);
      }
    }
  }
  return out;
}

const n = (x) => Number(x).toLocaleString('en-US');

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const filter = args.find((a) => !a.startsWith('--'));

  let waves = findWaveDirs().map(readWave).filter((w) => w.agents > 0);
  if (filter) waves = waves.filter((w) => w.id.startsWith(filter));
  waves.sort((a, b) => a.mtime - b.mtime);

  if (waves.length === 0) {
    console.log('No wave transcripts found. Waves write them under ~/.claude/projects/<project>/<session>/subagents/workflows/.');
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(waves.map((w) => ({
      id: w.id,
      agents: w.agents,
      agentsWithoutUsage: w.agentsWithoutUsage,
      raw: rawTotal(w.total),
      weighted: weightedTotal(w.total),
      usage: w.total,
      stages: Object.fromEntries([...w.byStage].map(([k, v]) => [k, {
        agents: v.agents, raw: rawTotal(v.usage), weighted: weightedTotal(v.usage),
      }])),
    })), null, 2));
    return;
  }

  console.log('WAVE COST — measured from agent transcripts, spends nothing to produce\n');
  for (const w of waves) {
    const raw = rawTotal(w.total);
    const wt = weightedTotal(w.total);
    const readShare = raw > 0 ? (100 * w.total.cache_read_input_tokens) / raw : 0;
    console.log(`${w.id}   ${w.agents} agents${w.agentsWithoutUsage ? ` (+${w.agentsWithoutUsage} with no usage recorded)` : ''}`);
    console.log(`  raw ${n(raw).padStart(12)}   weighted ${n(wt).padStart(11)}   cache reads ${readShare.toFixed(1)}% of raw`);
    console.log(`  fresh-in ${n(w.total.input_tokens)}  cache-write ${n(w.total.cache_creation_input_tokens)}  cache-read ${n(w.total.cache_read_input_tokens)}  out ${n(w.total.output_tokens)}`);
    const stages = [...w.byStage].sort((a, b) => weightedTotal(b[1].usage) - weightedTotal(a[1].usage));
    for (const [name, s] of stages) {
      const sw = weightedTotal(s.usage);
      const pct = wt > 0 ? (100 * sw) / wt : 0;
      console.log(`    ${name.padEnd(14)} ${String(s.agents).padStart(3)} agents  weighted ${n(sw).padStart(11)}  ${pct.toFixed(1).padStart(5)}%  (${n(Math.round(sw / Math.max(1, s.agents)))}/agent)`);
    }
    console.log('');
  }
  console.log('weighted = fresh-in + 0.1x cache-read + 1.25x cache-write + 5x output, so waves with');
  console.log('different cache hit rates compare honestly. raw is the plain sum the notification prints.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('wave-cost.mjs')) main();
