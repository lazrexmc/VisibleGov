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
