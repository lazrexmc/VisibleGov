// Missouri Revised Statutes (revisor.mo.gov) adapter — spec:
// docs/superpowers/specs/2026-08-19-mo-statute-glossary-source-design.md
// BINDING ACCESS CONSTRAINTS in spec §4: sequential, >=5s spacing, gloss-time fetches only,
// bot page = typed hard stop. Read the spec before changing any fetch behavior.
import { fetchWithLimit } from '../lib/http.js';
import { createLimiter } from '../lib/rate-limiter.js';
import { OversizeExcerptError, MAX_EXCERPT_CHARS, sha256 } from './uscode.js';

export { sha256 };
export const SOURCE = 'mo-statutes';

// Their bot page (captured 2026-08-19) states the enforced threshold: accesses tracked over 30s
// windows, faster than 1s repeatedly -> blocked, cumulative per-IP tracking. 5s = 5x inside it.
export const moStatutesLimiter = createLimiter({ minIntervalMs: 5000 });

// A federal marker anywhere means this can never be an RSMo cite — refuse outright so the MO
// parser can never claim a federal citation (spec §3).
const FEDERAL_MARKER_RE = /U\.?\s*S\.?\s*C\.?|C\.?F\.?R\.?|public law|united states code|\bstat\.|P\.L\./i;
// Ranges and lists have no single official text (spec §3) — belt over the anchored regexes below.
const MULTI_RE = /\b(?:to|through|and)\b/i;
// RSMo's dotted \d{1,3}\.\d{3,4} section shape is its signature; USC sections are never dotted.
// A trailing subdivision (".2", "(1)") parses but normalizes to the parent section (spec §3).
const MO_SECTION_RE = /^(?:RSMo\.?\s+)?(?:§+\s*)?(?:sections?\s+)?(\d{1,3}\.\d{3,4})(?:\.\d+)?(?:\([\w()]+\))?(?:,?\s*RSMo\.?)?$/i;
const MO_CHAPTER_RE = /^(?:RSMo\.?\s+)?chapter\s+(\d{1,3})(?:,?\s*RSMo\.?)?$/i;

export function parseMoCitation(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const t = raw.trim();
  if (FEDERAL_MARKER_RE.test(t) || MULTI_RE.test(t)) return null;
  const sec = t.match(MO_SECTION_RE);
  if (sec) return { kind: 'section', section: sec[1] };
  const ch = t.match(MO_CHAPTER_RE);
  if (ch) return { kind: 'chapter', chapter: ch[1] };
  return null;
}

export function normalizeMoCitation(parsed) {
  return parsed.kind === 'chapter' ? `RSMo chapter ${parsed.chapter}` : `RSMo ${parsed.section}`;
}

export function isMoCitation(citation) {
  return typeof citation === 'string' && citation.startsWith('RSMo ');
}
