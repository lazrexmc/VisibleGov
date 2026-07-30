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
