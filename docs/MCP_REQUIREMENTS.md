# MCP connections this project depends on

**The standing rule is in `CLAUDE.md`:** an unavailable or unauthorized MCP connection is a
**blocker to raise**, never a fork in the road to quietly take. If a session notice says a server
below needs authentication, or a tool call fails as unauthorized, stop and say so, help the
operator authorize it, and only then continue.

`scripts/preflight.mjs` runs automatically at session start (SessionStart hook in
`.claude/settings.json`) and prints what is installed. It **cannot** check authorization — OAuth
state is per-session runtime, not on disk — so the behavioural half above is what actually holds.

---

## Required

### `plugin:supabase:supabase` — `supabase@claude-plugins-official`

The single highest-leverage connection in this project.

| Capability | What it replaces | Why it matters here |
|---|---|---|
| `execute_sql` | PostgREST via supabase-js | Aggregates, joins, window functions. A cast-count sweep over 10k votes is one `GROUP BY` (~2s) instead of ~170 chunked round trips (~8 min). |
| `execute_sql` (multi-statement) | row-at-a-time script loops | Atomic transactions with `RAISE EXCEPTION` guards. The 20-row session-date retraction ran as one all-or-nothing transaction with 8 abort guards; the script equivalent was 20 separate non-atomic writes. |
| `get_advisors` | *nothing* | Supabase's own security and performance linters are **not reachable over REST at all**. They found the unindexed `votes.bill_id` behind every bill-page query (migration 0034) and let us dismiss a `SECURITY DEFINER` warning as a tested false positive. |
| `list_migrations` | reading `supabase/migrations/` and hoping | Applied-state truth. This repo has repeatedly had docs claiming a migration was drafted when it was applied, and vice versa — CLAUDE.md carries a standing caveat about that exact drift. |
| `list_tables`, `list_extensions` | hand-written introspection SQL | Schema reality without maintaining a second copy of the schema in scripts. |

**It also removes a whole class of measurement bug.** PostgREST silently caps every read at 1,000
rows regardless of `.limit()`. That trap produced a false catastrophe in the 2026-08-26 audit —
708 summaries reported "unverified" when the real answer was 0 — and it is why `selectAll` exists.
`count(*)` cannot truncate.

**Authorize with:** `/mcp` in an interactive session, select `supabase`. The OAuth flow cannot run
headless or in a background session.

**Write discipline still applies.** MCP has `apply_migration` and can execute DML. That does not
change draft-then-apply: migrations are still drafted into `supabase/migrations/` for Lance to
apply, and destructive DML still needs his explicit go. The MCP changes *how fast* a thing can be
read and *how atomically* an approved change lands — never *whether* it was approved.

---

## Fallback, deliberately kept

`src/lib/pg.js` is a direct-Postgres read path built during the detour described in CLAUDE.md's
standing rule. It is kept, on Lance's call (2026-08-26), because **MCP auth drops with some
frequency** and this is a working alternative when it does.

It is inert as it stands: `SUPABASE_DB_URL` is unset and **no database password has ever been
created for this project**, so the code cannot connect to anything. It is not an exposed
credential — it is a dormant path with setup instructions.

If it is ever enabled: read-only enforced by Postgres (`BEGIN TRANSACTION READ ONLY`), bypasses RLS
entirely, and must never appear in `site/`, a Pages Function, or any write path.

---

## Tooling prerequisites (a plugin can be installed and completely inert)

### `typescript-lsp` -> needs `typescript-language-server` on PATH

Installed 2026-08-26. The plugin is **only wiring**: it declares a language server, it does not
ship one. Without the binary the LSP answers nothing and reports no error — installed-but-inert
looks identical to working right up until you rely on it. That is why `scripts/preflight.mjs` now
checks binaries as well as plugins.

```
npm install -g typescript-language-server typescript
```

Live: typescript-language-server 6.0.0, typescript 7.0.2.

Covers `.ts .tsx .js .jsx .mts .cts .mjs .cjs` — this project is 177 `.js` + 12 `.mjs` and **zero
TypeScript**, so the `.js` coverage is the whole point. `jsconfig.json` at the repo root tells it
to resolve modules the way Node does (`"type": "module"` with explicit `.js` extensions); without
that the server reports phantom "cannot find module" errors on correct code. `checkJs` is off
deliberately — the correctness bar here is the 2,700-test suite, not a type checker retrofitted
onto 177 untyped files.

**Note:** `pyright-lsp` is also installed and this repo contains **zero Python files**. It is
carrying cost for nothing; removing it is a one-liner (`claude plugin uninstall pyright-lsp`) but
was left alone pending Lance's word, since it may serve his other projects.

---

## Not required, but present

`playwright@claude-plugins-official` — a real browser. Used for the deploy-night verification walk
that caught two live defects (`_redirects` needing extensionless targets, and the anon
`statement_timeout` fixed by migration 0031). Worth reaching for whenever a change touches what a
visitor sees, since this project's own history shows the browser catches things REST checks do not.

`github@claude-plugins-official` — PRs and issues. Unused so far; this repo commits straight to
`main`.
