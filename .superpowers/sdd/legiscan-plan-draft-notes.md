# Open design questions — LegiScan bulk adapter plan

Companion to `docs/superpowers/plans/2026-07-29-legiscan-bulk-adapter.md`. Q2-Q7 were ruled by the
controller (2026-07-28) and folded directly into the plan body (Global Constraints + the relevant
task text, cited inline). This file now holds only the one item still pending at execution time.

## Q1 — ZIP-decode dependency (Task 3) — PENDING LANCE'S APPROVAL

LegiScan's `getDataset` returns a Base64-encoded ZIP archive. `node:zlib` handles raw DEFLATE
streams but not the ZIP container format (local file headers + central directory) itself — there
is no built-in Node API that turns "ZIP bytes" into "named file contents" without either a new
dependency or a hand-rolled central-directory parser.

- **Option A — minimal npm dependency** (e.g. `yauzl`, well-maintained, streaming-capable, no
  native bindings). Fast, low correctness risk, but this project's other adapter plans have
  leaned toward zero-new-deps where feasible (mo-senate plan: "NO new dependencies").
- **Option B — hand-rolled central-directory reader over `node:zlib.inflateRawSync`.** No new
  dependency, but real correctness surface (central directory offsets, data descriptors, Zip64 if
  a session ZIP is ever large enough) for production data, not a throwaway script.

**Controller ruling (2026-07-28):** RECOMMEND Option A (`yauzl`). This repo has already accepted
new runtime dependencies twice when the alternative was reimplementing a real format parser
(`pdfjs-dist` for PDF text extraction, `@anthropic-ai/sdk` for the Claude API) — ZIP-container
parsing is the same shape of decision, and getting it subtly wrong in a hand-rolled reader risks
silent data loss that's much harder to catch than a PDF text-extraction miss (which at least fails
the reconcile gate loudly).

**A new runtime dependency still requires Lance's explicit approval per project precedent — that
approval has not been given yet.** The plan's Task 3 is mechanically gated on it: capture/decode
code does not get written until Lance says yes or no. If declined, Task 3 falls back to Option B
per the plan's own documented fallback path (see the plan's Task 3 dependency-gate step).
