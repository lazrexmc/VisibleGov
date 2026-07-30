// site/js/summary-parse.js — the one shared parser for summarizer.js's renderMarkdown output.
// Browser-native ES module: pure functions only, zero imports, no Node APIs. Served as-is to
// browsers AND imported by src/cli/verify.js (Node imports across directories fine) — one copy,
// no drift, no lookalike client-side markdown parsing (task-4 brief).

// The renderer's inverse (summarizer.js's renderMarkdown): bullets render as
// `- <point> (<section>)`. Section strings can themselves contain parentheses (e.g. "Sec. 2(b)"),
// so the point/section split point is the LAST ' (' before the line end, not the first
// (controller ruling #2) — that's the one renderMarkdown itself always inserts as the wrapper.
export function parseBullets(bodyMd) {
  const lines = String(bodyMd || '').split('\n');
  const bullets = [];
  let index = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('- ') || !line.endsWith(')')) continue;
    const rest = line.slice(2);
    const splitAt = rest.lastIndexOf(' (');
    if (splitAt === -1) continue;
    bullets.push({ index, point: rest.slice(0, splitAt), section: rest.slice(splitAt + 2, -1) });
    index += 1;
  }
  return bullets;
}

// renderMarkdown's exact stated-purpose line: `**Stated purpose (from the bill):** <text>`.
// Matches that exact prefix, strips it, trims the remainder; null when the line is absent (the
// bill states no purpose — renderMarkdown omits the paragraph entirely in that case).
const STATED_PURPOSE_PREFIX = '**Stated purpose (from the bill):**';

export function extractStatedPurpose(bodyMd) {
  const lines = String(bodyMd || '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith(STATED_PURPOSE_PREFIX)) {
      return line.slice(STATED_PURPOSE_PREFIX.length).trim() || null;
    }
  }
  return null;
}

// spec §3's mechanical one-liner: stated purpose when present, else the first bullet point, else
// null (the caller renders title-only). No fallback to any other field, no fabrication.
export function extractOneLiner(bodyMd) {
  return extractStatedPurpose(bodyMd) ?? parseBullets(bodyMd)[0]?.point ?? null;
}
