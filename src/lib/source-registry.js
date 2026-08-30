// src/lib/source-registry.js — what each ingestion source IS, declared rather than inferred.
//
// THE PROBLEM THIS SOLVES. `public_freshness` is derived from `ingestion_runs` with no allowlist,
// which is the right shape for a freshness table — a source cannot vanish from it by being
// forgotten. But a ledger-derived list never EXPIRES a label: a source that was retired on purpose
// and one that silently died look identical forever, both sitting there with an ageing timestamp.
// `verify` last ran 2026-07-28 and `gloss` 2026-07-29, and nothing in the repo recorded that both
// are simply on-demand CLIs rather than dead feeds. An operator reading that table had no way to
// tell "should be running, is not" from "was never supposed to be running".
//
// Credit: the shape is league's (tools/watchdog.py's manifest, WATCHDOG_SPEC.md), adopted after
// they solved the same problem from the other end. Their rule that a declared set is the only way
// to distinguish retired from dead is right, and it does not come for free on a ledger-derived
// list — this file IS the declaration layer that was missing.
//
// TWO RULES BORROWED VERBATIM, both of which I would have got wrong:
//
//   1. UNDECLARED IS VISIBLE, NEVER FILTERED. A source in the ledger but not in this file prints
//      as `undeclared`. My instinct was to hide unknowns, which is exactly how a typo'd or
//      forgotten source disappears silently — the failure the declaration is meant to prevent.
//   2. RETIRED IS ITS OWN STATE, not a synonym for unchecked. A retired source prints its reason,
//      so the answer to "why is this month-dead?" lives beside the evidence rather than in
//      somebody's memory.
//
// DECLARE INTENT, DERIVE MECHANISM. This file holds only what code cannot determine: whether a
// source is SUPPOSED to be running. It deliberately does not declare thresholds, signals or
// endpoints — those are properties of the source that code can find out, and a hand-edited file
// that can misdeclare them is a new way to be silently wrong (league, on why signal kind stays out
// of their manifest; the same argument applies here).
//
// EVERY CLASSIFICATION BELOW WAS VERIFIED, not assumed:
//   scheduled  — named in scheduled-ingest.js SOURCE_KEYS, or run by a registered task/pg_cron.
//   on-demand  — a CLI still on disk that a human invokes. Silence is NORMAL and never an alarm.
//   retired    — the code that wrote these rows is gone, or nothing invokes it any more. Checked
//                per source; `mo-legislature` is the subtle one (its ADAPTER still exists, but no
//                entry point invokes it as a source — the file surviving is not the source living).

export const SOURCE_STATES = Object.freeze(['scheduled', 'on-demand', 'retired']);

export const SOURCE_REGISTRY = Object.freeze({
  // --- scheduled: silence IS a signal, because something is supposed to be running them ---------
  'mo-senate-web': { state: 'scheduled', note: 'scheduled-ingest SOURCE_KEYS' },
  'mo-house-xml': { state: 'scheduled', note: 'scheduled-ingest SOURCE_KEYS' },
  'us-congress': { state: 'scheduled', note: 'scheduled-ingest SOURCE_KEYS' },
  'us-senate': { state: 'scheduled', note: 'scheduled-ingest SOURCE_KEYS' },
  legiscan: { state: 'scheduled', note: 'scheduled-ingest SOURCE_KEYS; own 24h interval' },
  'refresh-aggregates': { state: 'scheduled', note: 'pg_cron + every scheduler tick' },
  'scheduled-summaries': { state: 'scheduled', note: 'Windows task, daily 06:00, billed under its ledger' },
  'summary-queue-record': { state: 'scheduled', note: 'written by the summary record path' },

  // --- on-demand: a human runs these. A month of silence is normal, not a fault -----------------
  verify: { state: 'on-demand', note: 'src/cli/verify.js — run against a fixture set when asked' },
  gloss: { state: 'on-demand', note: 'src/cli/gloss.js — superseded in practice by the batch runners' },
  summarize: { state: 'on-demand', note: 'src/cli/summarize.js — the pre-trust-model-v3 path' },
  'correct-data': { state: 'on-demand', note: 'src/cli/correct-data.js' },
  'gloss-batch-mo': { state: 'on-demand', note: 'billed batch runner, needs per-run approval' },
  'gloss-batch-usc': { state: 'on-demand', note: 'billed batch runner, needs per-run approval' },
  'auto-publish-glossary': { state: 'on-demand', note: 'src/cli/auto-publish-glossary.js — zero model calls' },
  'sync-session-dates': { state: 'on-demand', note: 'run whenever a new session is minted' },
  'link-persons': { state: 'on-demand', note: 'src/cli/link-persons.js' },
  'extract-terms': { state: 'on-demand', note: 'src/cli/extract-terms.js' },
  'enrich-federal-bills': { state: 'on-demand', note: 'src/cli/enrich-federal-bills.js' },
  'backfill-mo-glossary-citations': { state: 'on-demand', note: 'normaliser, re-runnable; last pass 2026-08-27' },

  // --- retired: will not run again. The reason is the point of the row -------------------------
  'mo-legislature': {
    state: 'retired',
    note: 'the OpenStates ingest path. src/adapters/mo-legislature.js still exists, but no entry '
      + 'point invokes it as a source — LegiScan and the MO House/Senate adapters cover this '
      + 'ground. A surviving adapter file is not a living source.',
  },
  'title-backfill': { state: 'retired', note: 'one-shot; no file on disk' },
  'debug-timeout-check': { state: 'retired', note: 'one-shot diagnostic for the 2026-08-04 refresh timeout; no file on disk' },
  'backfill-federal-names': { state: 'retired', note: 'one-shot backfill, completed 2026-07-30' },
  'backfill-mo-bill-meta': { state: 'retired', note: 'one-shot backfill, completed 2026-07-30' },
  'backfill-mo-term-dates': { state: 'retired', note: 'one-shot backfill, completed 2026-08-06' },
  'backfill-mo-term-dates-overrides': { state: 'retired', note: 'one-shot backfill, completed 2026-08-06' },
  'backfill-mo-terms': { state: 'retired', note: 'one-shot backfill, completed 2026-07-30' },
  'backfill-nicknames': { state: 'retired', note: 'one-shot backfill, completed 2026-07-29' },
  'backfill-term-states': { state: 'retired', note: 'one-shot backfill, completed 2026-07-30' },
});

// Returns the declared state, or `undeclared` for anything the ledger knows and this file does not.
// `undeclared` is a real answer, never an omission: it is how a source added without a declaration
// stays visible instead of quietly dropping out of the operator's view.
export function sourceState(source) {
  const row = SOURCE_REGISTRY[source];
  if (!row) {
    return {
      state: 'undeclared',
      note: 'not declared in src/lib/source-registry.js — add it, or its silence means nothing',
    };
  }
  return row;
}

// Is a stale timestamp for this source worth an operator's attention? Only `scheduled` sources can
// be "overdue": an on-demand CLI that has not run in a month is not a fault, and a retired one
// never will be. Undeclared counts as noteworthy — an unknown source going quiet is exactly the
// case nobody can reason about, and treating it as fine would be assuming the answer.
export function silenceIsMeaningful(source) {
  const { state } = sourceState(source);
  return state === 'scheduled' || state === 'undeclared';
}

// One-line label for the freshness table, so a reader never has to infer intent from a date.
export function stateLabel(source) {
  const { state, note } = sourceState(source);
  if (state === 'retired') return `RETIRED — ${note}`;
  if (state === 'on-demand') return 'on-demand (silence is normal)';
  if (state === 'undeclared') return 'UNDECLARED — no entry in source-registry.js';
  return 'scheduled';
}
