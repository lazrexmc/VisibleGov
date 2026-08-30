# MCP connections this project depends on

**The standing rule is in `CLAUDE.md`:** an unavailable or unauthorized MCP connection is a
**blocker to raise**, never a fork in the road to quietly take. If a session notice says a server
below needs authentication, or a tool call fails as unauthorized, stop and say so, help the
operator authorize it, and only then continue.

`scripts/preflight.mjs` runs automatically at session start (SessionStart hook in
`.claude/settings.json`) and prints what is installed. It **cannot** check authorization - OAuth
state is per-session runtime, not on disk - so the behavioural half above is what actually holds.

---

## Required

### `plugin:supabase:supabase` - `supabase@claude-plugins-official`

The single highest-leverage connection in this project.

| Capability | What it replaces | Why it matters here |
|---|---|---|
| `execute_sql` | PostgREST via supabase-js | Aggregates, joins, window functions. A cast-count sweep over 10k votes is one `GROUP BY` (~2s) instead of ~170 chunked round trips (~8 min). |
| `execute_sql` (multi-statement) | row-at-a-time script loops | Atomic transactions with `RAISE EXCEPTION` guards. The 20-row session-date retraction ran as one all-or-nothing transaction with 8 abort guards; the script equivalent was 20 separate non-atomic writes. |
| `get_advisors` | *nothing* | Supabase's own security and performance linters are **not reachable over REST at all**. They found the unindexed `votes.bill_id` behind every bill-page query (migration 0034) and let us dismiss a `SECURITY DEFINER` warning as a tested false positive. |
| `list_migrations` | reading `supabase/migrations/` and hoping | Applied-state truth. This repo has repeatedly had docs claiming a migration was drafted when it was applied, and vice versa - CLAUDE.md carries a standing caveat about that exact drift. |
| `list_tables`, `list_extensions` | hand-written introspection SQL | Schema reality without maintaining a second copy of the schema in scripts. |

**It also removes a whole class of measurement bug.** PostgREST silently caps every read at 1,000
rows regardless of `.limit()`. That trap produced a false catastrophe in the 2026-08-26 audit -
708 summaries reported "unverified" when the real answer was 0 - and it is why `selectAll` exists.
`count(*)` cannot truncate.

**Authorize with:** `/mcp` in an interactive session, select `supabase`. The OAuth flow cannot run
headless or in a background session.

**Write discipline still applies.** MCP has `apply_migration` and can execute DML. That does not
change draft-then-apply: migrations are still drafted into `supabase/migrations/` for Lance to
apply, and destructive DML still needs his explicit go. The MCP changes *how fast* a thing can be
read and *how atomically* an approved change lands - never *whether* it was approved.

---

## Fallback, deliberately kept

`src/lib/pg.js` is a direct-Postgres read path built during the detour described in CLAUDE.md's
standing rule. It is kept, on Lance's call (2026-08-26), because **MCP auth drops with some
frequency** and this is a working alternative when it does.

It is inert as it stands: `SUPABASE_DB_URL` is unset and **no database password has ever been
created for this project**, so the code cannot connect to anything. It is not an exposed
credential - it is a dormant path with setup instructions.

If it is ever enabled: read-only enforced by Postgres (`BEGIN TRANSACTION READ ONLY`), bypasses RLS
entirely, and must never appear in `site/`, a Pages Function, or any write path.

---

## Tooling prerequisites (a plugin can be installed and completely inert)

### `typescript-lsp` -> needs `typescript-language-server` on PATH

Installed 2026-08-26. The plugin is **only wiring**: it declares a language server, it does not
ship one. Without the binary the LSP answers nothing and reports no error - installed-but-inert
looks identical to working right up until you rely on it. That is why `scripts/preflight.mjs` now
checks binaries as well as plugins.

```
npm install -g typescript-language-server     # the server binary, global
npm install --save-dev typescript@5           # the compiler, IN THE WORKSPACE
```

**Both halves are load-bearing and the obvious command gets one of them wrong.**

`npm install -g typescript` today installs **TypeScript 7**, the Go rewrite, whose `lib/` ships
`tsc.js` and **no `tsserver.js`**. `typescript-language-server` needs `tsserver.js`, so the LSP
starts and then dies with *"Could not find a valid TypeScript installation."* Pin `typescript@5`
(5.9.3 at time of writing) - the last line that ships it.

It also has to be resolvable **from the workspace**, not globally: the server looks for `typescript`
in the project's `node_modules` first. Hence `--save-dev` rather than `-g`. As a devDependency it
also survives a fresh clone, which matters for `docs/DISASTER_RECOVERY.md`.

Live: `typescript-language-server` 6.0.0 (global), `typescript` 5.9.3 (workspace devDependency).

### Caveat: `findReferences` under-reports on a cold index

tsserver only searches files it has loaded. The first `findReferences` on `assessSharedUrl`
returned **1** result - the declaration alone. After a `goToDefinition` from one caller warmed the
project, the same query returned **13 across 4 files**.

This is the same failure shape as everything else that has bitten this project: **a silent partial
answer that looks exactly like a complete one.** An under-reported reference list reads as "nothing
else calls this", which is precisely the false confidence that makes a rename break something.
Before trusting a reference count for a refactor, warm the index (open a known caller, or
`goToDefinition` from one) - or cross-check with `grep`, which does not care what is loaded.

Covers `.ts .tsx .js .jsx .mts .cts .mjs .cjs` - this project is 177 `.js` + 12 `.mjs` and **zero
TypeScript**, so the `.js` coverage is the whole point. `jsconfig.json` at the repo root tells it
to resolve modules the way Node does (`"type": "module"` with explicit `.js` extensions); without
that the server reports phantom "cannot find module" errors on correct code. `checkJs` is off
deliberately - the correctness bar here is the 2,700-test suite, not a type checker retrofitted
onto 177 untyped files.

**Note:** `pyright-lsp` is also installed and this repo contains **zero Python files**. It is
carrying cost for nothing; removing it is a one-liner (`claude plugin uninstall pyright-lsp`) but
was left alone pending Lance's word, since it may serve his other projects.

---

## Not required, but present

`playwright@claude-plugins-official` - a real browser. Used for the deploy-night verification walk
that caught two live defects (`_redirects` needing extensionless targets, and the anon
`statement_timeout` fixed by migration 0031). Worth reaching for whenever a change touches what a
visitor sees, since this project's own history shows the browser catches things REST checks do not.

`github@claude-plugins-official` - PRs and issues. Unused so far; this repo commits straight to
`main`.
