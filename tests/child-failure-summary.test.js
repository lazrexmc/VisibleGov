import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeChildFailure } from '../scripts/scheduled-ingest.js';

// ---------------------------------------------------------------------------
// A failed child run must report the CAUSE, not our parse of its silence (2026-11-07).
//
// recordSchedulerAttemptFailure wrote `parseError` into the run row's detail with no field naming
// the actual failure. When a child CLI exits non-zero it prints nothing on stdout, so
// JSON.parse('') throws, and every such row reads:
//
//     parseError: "Unexpected end of JSON input"
//
// while the real cause - a clean HTTP 403 from senate.gov - sat at the top of a 2,000-character
// stderrTail blob. This is not hypothetical: on 2026-11-07 a peer session (RapidForge) read that
// field, correctly, and reported "an empty or cut-off body from the source" with "httpStatus null".
// The source was returning a perfectly consistent 403 that this repo has had DECLARED in
// docs/EXPECTED_FAILURES.md entry 3 for days. A careful reader was sent to the wrong system by the
// field we chose to put first.
//
// The rule these tests pin: when the child FAILED, the cause comes from stderr. `parseError` is
// demoted to what it actually is - a note about our own handling of an empty stdout. The one case
// where parseError IS the cause is a child that exited ZERO and still emitted unparseable output,
// because then the parse is the only thing that went wrong.
// ---------------------------------------------------------------------------

const SENATE_STDERR = `SourceFetchError: HTTP 403 from us-senate: https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml
    at fetchWithLimit (file:///F:/VisibleGov/src/lib/http.js:31:11)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async collectUsSenate (file:///F:/VisibleGov/src/cli/ingest.js:154:19) {
  source: 'us-senate',
  url: 'https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml',
  status: 403,
  [cause]: undefined
}
`;

test('summarizeChildFailure: the real 403 becomes the primary error, not our JSON parse', () => {
  const out = summarizeChildFailure({
    exitStatus: 1, stderr: SENATE_STDERR, parseError: 'Unexpected end of JSON input',
  });
  assert.match(out.primaryError, /403/, 'the cause must name the status the source actually returned');
  assert.match(out.primaryError, /us-senate/);
  assert.doesNotMatch(
    out.primaryError, /Unexpected end of JSON input/,
    'our parse of an empty stdout is not the cause and must not be presented as one',
  );
});

test('summarizeChildFailure: extracts the HTTP status into its own field - the one a reader asked for', () => {
  // "httpStatus null" was the other half of the misdiagnosis. It was null because nothing ever
  // parsed it out, not because the source withheld it.
  const out = summarizeChildFailure({
    exitStatus: 1, stderr: SENATE_STDERR, parseError: 'Unexpected end of JSON input',
  });
  assert.equal(out.httpStatus, 403);
});

test('summarizeChildFailure: marks parseError as SECONDARY when the child failed', () => {
  const out = summarizeChildFailure({
    exitStatus: 1, stderr: SENATE_STDERR, parseError: 'Unexpected end of JSON input',
  });
  assert.equal(out.parseErrorIsSecondary, true, 'an empty stdout is expected when a child exits non-zero');
});

test('summarizeChildFailure: a child that exited ZERO and emitted garbage - THEN the parse is the cause', () => {
  // The one case where parseError is genuinely primary: the child believed it succeeded, so the
  // only thing wrong is what it printed. Demoting it here would hide a real defect in a CLI.
  const out = summarizeChildFailure({
    exitStatus: 0, stderr: '', parseError: 'Unexpected token < in JSON at position 0',
  });
  assert.match(out.primaryError, /Unexpected token </);
  assert.equal(out.parseErrorIsSecondary, false);
  assert.equal(out.httpStatus, null);
});

test('summarizeChildFailure: a launch failure outranks everything', () => {
  // If the process never started, neither stderr nor a parse says anything useful.
  const out = summarizeChildFailure({
    exitStatus: null, stderr: '', parseError: 'Unexpected end of JSON input',
    launchError: 'could not launch src/cli/ingest.js: spawn ENOENT',
  });
  assert.match(out.primaryError, /spawn ENOENT/);
  assert.equal(out.parseErrorIsSecondary, true);
});

test('summarizeChildFailure: non-zero exit with NO stderr does not invent a cause', () => {
  // It says what it knows - the exit code - and claims nothing more. A fabricated cause is worse
  // than an honest "no diagnostic output", which is itself a finding about that CLI.
  const out = summarizeChildFailure({ exitStatus: 7, stderr: '', parseError: 'Unexpected end of JSON input' });
  assert.match(out.primaryError, /exit(ed)? 7|exit code 7/i);
  assert.match(out.primaryError, /no stderr|no diagnostic/i);
  assert.equal(out.httpStatus, null, 'never guess a status that was not printed');
});

test('summarizeChildFailure: picks the ERROR line out of stderr, not merely the first line', () => {
  // Node and npm print warnings before the real error. Taking line one would surface a deprecation
  // notice as the cause.
  const stderr = `(node:1234) ExperimentalWarning: something
npm warn config unknown option
TypeError: Cannot read properties of undefined (reading 'rows')
    at foo (file:///x.js:1:1)
`;
  const out = summarizeChildFailure({ exitStatus: 1, stderr, parseError: 'Unexpected end of JSON input' });
  assert.match(out.primaryError, /TypeError: Cannot read properties/);
  assert.doesNotMatch(out.primaryError, /ExperimentalWarning/);
});

test('summarizeChildFailure: stderr with no recognisable error line falls back to its first real line', () => {
  const out = summarizeChildFailure({ exitStatus: 1, stderr: '\n\n  something went sideways\nmore\n', parseError: null });
  assert.match(out.primaryError, /something went sideways/);
});

test('summarizeChildFailure: primaryError is BOUNDED - a run row is not a log sink', () => {
  const out = summarizeChildFailure({ exitStatus: 1, stderr: `Error: ${'x'.repeat(5000)}`, parseError: null });
  assert.ok(out.primaryError.length <= 500, `expected <=500 chars, got ${out.primaryError.length}`);
});

test('summarizeChildFailure: reads a bare "status: NNN" when there is no "HTTP NNN"', () => {
  const out = summarizeChildFailure({ exitStatus: 1, stderr: "Error: upstream said no\n  status: 429,\n", parseError: null });
  assert.equal(out.httpStatus, 429);
});

test('summarizeChildFailure: does not mistake a year or a line number for an HTTP status', () => {
  // "at file.js:404:11" and "2026" must not become a status. Only 3-digit codes in the 1xx-5xx
  // range, introduced by HTTP or status:, count.
  const out = summarizeChildFailure({
    exitStatus: 1, stderr: 'Error: boom in 2026\n    at thing (file:///x.js:404:11)\n', parseError: null,
  });
  assert.equal(out.httpStatus, null);
});

test('summarizeChildFailure: never throws on absent or junk input', () => {
  for (const bad of [undefined, {}, { exitStatus: undefined, stderr: null, parseError: undefined }]) {
    const out = summarizeChildFailure(bad);
    assert.equal(typeof out.primaryError, 'string');
    assert.ok(out.primaryError.length > 0, 'always says something, even if only that it knows nothing');
  }
});
