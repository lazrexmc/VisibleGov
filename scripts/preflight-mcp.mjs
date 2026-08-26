// Preflight: are the MCP connections this project depends on installed and ready?
//
// WHY THIS EXISTS. On 2026-08-26 a session opened with a system notice that
// `plugin:supabase:supabase` required authentication. That notice was not surfaced to the operator.
// Instead the session ROUTED AROUND it: it added a `pg` dependency, wrote a ~400-line direct
// Postgres client, a verification script and tests, and asked the operator to rotate his database
// password — hours of work and a new long-lived credential, to reach a capability that was one
// click away. When the MCP was finally authorized it immediately found two real defects nothing
// else could reach (an unindexed bill_id on every bill-page query, and a security advisory), and
// made a 20-row retraction atomic instead of row-at-a-time.
//
// The rule that came out of it is in CLAUDE.md and is the load-bearing half: an unavailable MCP is
// a BLOCKER TO RAISE, never a fork in the road to quietly take. This script is the mechanical half
// — it cannot see OAuth state (that is per-session runtime), but it can prove the plugin is
// installed and tell the operator exactly how to check and fix the rest.
//
// Run by the SessionStart hook in .claude/settings.json; also runnable by hand:
//   node scripts/preflight-mcp.mjs
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// What this project actually needs, and what breaks without it. Keep this list honest: an entry
// here means work should STOP and ask, so a "nice to have" does not belong.
const REQUIRED = [
  {
    plugin: 'supabase@claude-plugins-official',
    server: 'plugin:supabase:supabase',
    why: 'Raw SQL (execute_sql), Supabase security/performance advisors, and atomic multi-statement '
      + 'writes. Without it, database work degrades to PostgREST: no aggregates, a silent 1,000-row '
      + 'cap on every read, and hundreds of round trips per audit sweep.',
    verify: 'Ask Claude to run a trivial MCP query, or check /mcp in an interactive session.',
    fix: 'In an interactive Claude Code session run /mcp, select supabase, and authorize. '
      + 'The OAuth flow cannot run in a headless or background session.',
  },
];

const PLUGINS_FILE = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

function installedPlugins() {
  if (!existsSync(PLUGINS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PLUGINS_FILE, 'utf8')).plugins ?? {};
  } catch {
    return null;
  }
}

const installed = installedPlugins();
const lines = [];
let missing = 0;

for (const req of REQUIRED) {
  if (installed === null) {
    lines.push(`  ?  ${req.server} — cannot read ${PLUGINS_FILE}; verify manually with /mcp`);
    continue;
  }
  // Each plugin maps to an ARRAY of install records (one per scope: user, project, local), not a
  // single object. Reading it as an object silently yields version "unknown" — a preflight that
  // misreports is worse than none, since it looks like it checked.
  const records = installed[req.plugin];
  const entry = Array.isArray(records) ? records[0] : records;
  if (!entry) {
    missing += 1;
    lines.push(`  MISSING  ${req.server}  (plugin ${req.plugin} is not installed)`);
    lines.push(`           why it matters: ${req.why}`);
    lines.push(`           fix: ${req.fix}`);
  } else {
    lines.push(`  installed  ${req.server}  (${req.plugin} v${entry.version ?? 'unknown'})`);
  }
}

console.log('MCP PREFLIGHT — connections this project depends on');
console.log(lines.join('\n'));
console.log('');
console.log('AUTHORIZATION IS NOT CHECKED HERE and cannot be: it is per-session runtime state.');
console.log('Claude: if a system notice says one of the servers above needs authentication, or an');
console.log('MCP tool call fails as unauthorized, STOP AND TELL THE OPERATOR. Help them authorize');
console.log('it. Do NOT build or use an alternative route to the same capability without saying so');
console.log('and getting agreement first — see the standing rule in CLAUDE.md.');

if (missing > 0) process.exitCode = 1;
