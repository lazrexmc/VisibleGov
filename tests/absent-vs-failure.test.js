import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceFetchError, RateLimitedError, isAbsentRecordError } from '../src/lib/errors.js';
import { RollCallNotYetPublishedError } from '../src/adapters/us-senate.js';
import { recordMiss } from '../src/cli/ingest.js';

// 2026-08-26 system audit, defect D2 ("signal death on always-partial sources"). us-congress had
// closed 121 of 121 scheduled runs `partial` and us-senate 121 of 121, because a probe window that
// deliberately overshoots the last real roll call recorded every 404 past the edge as a FAILURE.
// The sources were healthy the whole time (verified live: roll283.xml -> 200, roll284.xml -> 404).
// The cost was signal, not data: a genuine outage would have produced the same word and the same
// message shape, so nothing could have told them apart.

// ---- isAbsentRecordError: the source answered "no such record" vs we got no answer ----

test('isAbsentRecordError: an HTTP 404 is the source affirmatively saying the record does not exist', () => {
  const err = new SourceFetchError('HTTP 404 from us-congress: https://clerk.house.gov/evs/2026/roll284.xml', {
    source: 'us-congress', url: 'https://clerk.house.gov/evs/2026/roll284.xml', status: 404,
  });
  assert.equal(isAbsentRecordError(err), true);
});

test('isAbsentRecordError: senate.gov’s not-yet-published stub is absence dressed as an HTTP 200', () => {
  // Matched by name rather than instanceof: RollCallNotYetPublishedError lives in an adapter that
  // imports errors.js, so an instanceof check inside errors.js would be an import cycle. This test
  // is what keeps that name-match honest if the class is ever renamed.
  const err = new RollCallNotYetPublishedError('no roll call at this vote number yet', { source: 'us-senate' });
  assert.equal(err.name, 'RollCallNotYetPublishedError');
  assert.equal(isAbsentRecordError(err), true);
});

test('isAbsentRecordError: a 5xx, a rate limit, and a network error are all REAL failures', () => {
  const url = 'https://clerk.house.gov/evs/2026/roll284.xml';
  assert.equal(isAbsentRecordError(new SourceFetchError('HTTP 500 from us-congress: ' + url, { status: 500, url })), false);
  assert.equal(isAbsentRecordError(new SourceFetchError('HTTP 503 from us-congress: ' + url, { status: 503, url })), false);
  assert.equal(isAbsentRecordError(new RateLimitedError('rate limited by us-congress', { status: 429, url })), false);
  // A network failure carries no status at all - unreachable is never "does not exist".
  assert.equal(isAbsentRecordError(new SourceFetchError('network failure fetching ' + url, { url })), false);
  // A 200 whose body could not be read is a failure too (http.js throws this with res.status).
  assert.equal(isAbsentRecordError(new SourceFetchError('failed reading response body (as=text)', { status: 200, url })), false);
});

test('isAbsentRecordError: a non-SourceFetchError is never absence — parse bugs must stay loud', () => {
  assert.equal(isAbsentRecordError(new Error('parseSenateRollCall: response has no <roll_call_vote> root')), false);
  assert.equal(isAbsentRecordError(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isAbsentRecordError(null), false);
  assert.equal(isAbsentRecordError(undefined), false);
});

// ---- recordMiss: the one filing point both us-congress and us-senate share ----

function lists() {
  return { failures: [], absent: [] };
}

test('recordMiss: files a 404 under absent, leaving failures empty — this is what closes the run succeeded', () => {
  const l = lists();
  recordMiss(new SourceFetchError('HTTP 404 from us-congress: https://x/roll284.xml', {
    source: 'us-congress', url: 'https://x/roll284.xml', status: 404,
  }), 'roll 284', l);
  assert.equal(l.failures.length, 0, 'a routine tail 404 must not degrade the run');
  assert.equal(l.absent.length, 1);
});

test('recordMiss: files a 500 under failures — a real break still shows as one', () => {
  const l = lists();
  recordMiss(new SourceFetchError('HTTP 500 from us-congress: https://x/roll284.xml', {
    source: 'us-congress', url: 'https://x/roll284.xml', status: 500,
  }), 'roll 284', l);
  assert.equal(l.absent.length, 0);
  assert.equal(l.failures.length, 1);
});

test('recordMiss: records status and url as their own fields, not just inside the message', () => {
  // The audit’s second half: `HTTP ${status} from ${source}: ${url}` renders a 404 and a 500
  // identically as a shape, so 121 runs of stored history could not be re-read to tell which had
  // happened. Structured fields make an old run row answerable.
  const l = lists();
  const url = 'https://clerk.house.gov/evs/2026/roll284.xml';
  recordMiss(new SourceFetchError('HTTP 404 from us-congress: ' + url, { source: 'us-congress', url, status: 404 }), 'roll 284', l);
  recordMiss(new SourceFetchError('HTTP 500 from us-congress: ' + url, { source: 'us-congress', url, status: 500 }), 'roll 285', l);
  assert.deepEqual(l.absent[0], { step: 'roll 284', message: 'HTTP 404 from us-congress: ' + url, status: 404, url });
  assert.equal(l.failures[0].status, 500);
  assert.equal(l.failures[0].url, url);
  assert.notEqual(l.absent[0].status, l.failures[0].status, 'a 404 and a 500 must be distinguishable from the stored row alone');
});

test('recordMiss: an error with no status/url still records null fields, never undefined keys', () => {
  const l = lists();
  recordMiss(new RollCallNotYetPublishedError('not yet published', { source: 'us-senate' }), 'vote 661', l);
  assert.deepEqual(l.absent[0], {
    step: 'vote 661', message: 'not yet published', status: null, url: null,
  });
});

test('recordMiss: keeps the step label the scheduler parses (`roll N` / `vote N`)', () => {
  // findRegressedAbsences and isExpectedTailProbeOutcome both regex these exact shapes; a reworded
  // step label would silently turn every absence into an unclassifiable one.
  const l = lists();
  recordMiss(new SourceFetchError('x', { status: 404 }), 'roll 284', l);
  recordMiss(new SourceFetchError('x', { status: 404 }), 'vote 661', l);
  assert.match(l.absent[0].step, /^roll \d+$/);
  assert.match(l.absent[1].step, /^vote \d+$/);
});
