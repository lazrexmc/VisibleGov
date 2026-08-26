export class SourceFetchError extends Error {
  constructor(message, { source, url, status, cause } = {}) {
    super(message, { cause });
    this.name = 'SourceFetchError';
    this.source = source;
    this.url = url;
    this.status = status;
  }
}

export class RateLimitedError extends SourceFetchError {
  constructor(message, meta = {}) {
    super(message, meta);
    this.name = 'RateLimitedError';
  }
}

// isAbsentRecordError - 2026-08-26 system audit, defect D2 ("signal death on always-partial
// sources"). The distinction that was missing everywhere: "the source answered, and its answer is
// that this record does not exist" is NOT "we failed to get an answer". Both arrive as a
// SourceFetchError through the same per-record catch, so until this existed both were recorded as
// `failures` - which is why us-congress closed 121 of 121 runs `partial` through a recess, and why
// a genuine outage would have looked exactly like a quiet week.
//
// ABSENT (a real, informative negative answer - the source is healthy and told us something):
//   - HTTP 404: clerk.house.gov affirmatively has no such roll call.
//   - RollCallNotYetPublishedError: senate.gov's "Roll Call Vote Unavailable" stub, which is the
//     same statement dressed as an HTTP 200 (see us-senate.js). Matched by NAME, not instanceof,
//     because that class lives in an adapter that imports this module - an instanceof check here
//     would be an import cycle.
//
// FAILURE (everything else): 5xx, 429/RateLimitedError, a network error (status undefined), a
// body-read failure, a parse error. Note that absence is only *expected* at the tail of a probe
// window; a 404 on a record we already hold is a regression, and catching that is the caller's job
// (scheduled-ingest.js's findRegressedAbsences) because only the caller knows where the edge is.
export function isAbsentRecordError(err) {
  if (!(err instanceof SourceFetchError)) return false;
  return err.status === 404 || err.name === 'RollCallNotYetPublishedError';
}

// InvalidFlagValueError — FINAL WHOLE-BRANCH REVIEW, finding 6 (.superpowers/sdd/
// 2026-07-29-profile-completeness/final-review-findings.md): a CLI flag whose VALUE is malformed.
// Lives here, shared, rather than being declared twice: enrich-federal-bills.js and
// summary-queue.js both parse --limit, and two copies of the same class would eventually drift
// into two different verdicts on the same input.
export class InvalidFlagValueError extends Error {
  constructor(message, { flag, value } = {}) {
    super(message);
    this.name = 'InvalidFlagValueError';
    this.flag = flag;
    this.value = value;
  }
}

// parsePositiveIntegerFlag — the one guard behind that error. `--limit 5O` (capital O for zero, the
// obvious typo) used to become NaN, and every run gate downstream reads NaN/0/negative as "no limit
// at all" — so the operator asking for a small chunk silently got the FULL live pass instead. The
// lone silent degradation in otherwise fail-loud parsers; a limit is a positive integer or it is
// not a limit. Rejects a missing value too: `--limit` with nothing after it is `Number(undefined)`,
// which is exactly the same NaN.
export function parsePositiveIntegerFlag(rawValue, flag) {
  const n = Number(rawValue);
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '' || !Number.isInteger(n) || n < 1) {
    throw new InvalidFlagValueError(
      `${flag} requires a positive integer; got ${JSON.stringify(rawValue ?? null)} — refusing to run, `
        + 'since an unparseable limit would silently mean "no limit" and process the entire worklist',
      { flag, value: rawValue },
    );
  }
  return n;
}

// RunNotApprovedError / assertRunApproved — task 1 (2026-07-31), the shared mechanical spend-gate
// primitive behind summarize.js's SUMMARIZE_RUN_APPROVED and verify.js's VERIFY_RUN_APPROVED.
// gloss.js's GLOSS_RUN_APPROVED (also reused by extract-terms.js) and golden.js's
// GOLDEN_CHECK_APPROVED predate this and stay untouched, inline, per-file — this shared pair only
// backs the two CLIs newly gated here, so their wording can't drift from each other the way two
// hand-copied message strings eventually would (same rationale as parsePositiveIntegerFlag/
// InvalidFlagValueError above).
export class RunNotApprovedError extends Error {
  constructor(message, { envVar, action } = {}) {
    super(message);
    this.name = 'RunNotApprovedError';
    this.envVar = envVar;
    this.action = action;
  }
}

// Throws unless envValue is exactly 'yes' — mirrors gloss.js's own `!== 'yes'` check, so
// 'true'/'1'/anything else is refused, not just an unset var. The message keeps gloss.js's voice:
// what makes the run cost money, that approval is the owner's per-run call, and the exact env var
// to set. Callers (see summarize.js/verify.js main()) catch RunNotApprovedError locally and print
// err.message via console.log — never console.error — so the CLI's output stays the same clean
// single line gloss.js itself prints, not a raw stack trace.
export function assertRunApproved(envValue, { envVar, action, detail } = {}) {
  if (envValue === 'yes') return;
  const detailSuffix = detail ? ` (${detail})` : '';
  throw new RunNotApprovedError(
    `BLOCKED: ${action} makes live, billed Anthropic API calls${detailSuffix}. Per the owner's `
      + `standing policy, each run requires his explicit per-run approval — set ${envVar}=yes to proceed.`,
    { envVar, action },
  );
}
