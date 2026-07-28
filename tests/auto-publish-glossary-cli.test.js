import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, planAutoPublish, autoPublishOne, PublishCompletenessError,
  loadDraftTerms, loadLatestVerifications,
} from '../src/cli/auto-publish-glossary.js';

// ---- parseArgs: same --dry-run shape as the other CLIs ----

test('parseArgs defaults dryRun to false and accepts --dry-run', () => {
  assert.equal(parseArgs([]).dryRun, false);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown flag/);
});

// ---- planAutoPublish: eligibility derivation (trust model v3 mechanism 2) — flagged, unverified,
// and needs_mapping rows must NEVER be eligible; only a needs_mapping=false, has_gloss, latest-
// verification-clean row qualifies. Mirrors gloss-cli.test.js's planGlossing coverage style. ----

test('planAutoPublish: needs_mapping row never eligible, even with a gloss and a clean verification', () => {
  const terms = [{ id: 't1', needs_mapping: true, gloss_md: 'g', status: 'draft' }];
  const map = new Map([['t1', { overall: 'clean', verdicts: [], model: 'claude-sonnet-5' }]]);
  const plan = planAutoPublish(terms, map);
  assert.equal(plan.eligible.length, 0);
  assert.deepEqual(plan.needsMapping.map((t) => t.id), ['t1']);
});

test('planAutoPublish: row with no gloss_md never eligible', () => {
  const terms = [{ id: 't1', needs_mapping: false, gloss_md: null, status: 'draft' }];
  const plan = planAutoPublish(terms, new Map());
  assert.equal(plan.eligible.length, 0);
  assert.deepEqual(plan.noGloss.map((t) => t.id), ['t1']);
});

test('planAutoPublish: flagged latest verification never eligible', () => {
  const terms = [{ id: 't1', needs_mapping: false, gloss_md: 'g', status: 'draft' }];
  const map = new Map([['t1', { overall: 'flagged', verdicts: [{ supported: false }], model: 'claude-sonnet-5' }]]);
  const plan = planAutoPublish(terms, map);
  assert.equal(plan.eligible.length, 0);
  assert.deepEqual(plan.flaggedOrUnverified.map((t) => t.id), ['t1']);
});

test('planAutoPublish: unverified (no verification row at all) never eligible', () => {
  const terms = [{ id: 't1', needs_mapping: false, gloss_md: 'g', status: 'draft' }];
  const plan = planAutoPublish(terms, new Map());
  assert.equal(plan.eligible.length, 0);
  assert.deepEqual(plan.flaggedOrUnverified.map((t) => t.id), ['t1']);
});

test('planAutoPublish: clean-verified, glossed, non-mapping row is eligible and carries its verification along', () => {
  const terms = [{ id: 't1', needs_mapping: false, gloss_md: 'g', status: 'draft' }];
  const verification = { overall: 'clean', verdicts: [{ supported: true }], model: 'claude-sonnet-5' };
  const map = new Map([['t1', verification]]);
  const plan = planAutoPublish(terms, map);
  assert.equal(plan.eligible.length, 1);
  assert.equal(plan.eligible[0].term.id, 't1');
  assert.equal(plan.eligible[0].verification, verification);
});

test('planAutoPublish: mixed batch partitions exhaustively into eligible/needsMapping/noGloss/flaggedOrUnverified', () => {
  const terms = [
    { id: 'mapping', needs_mapping: true, gloss_md: null, status: 'draft' },
    { id: 'no-gloss', needs_mapping: false, gloss_md: null, status: 'draft' },
    { id: 'flagged', needs_mapping: false, gloss_md: 'g', status: 'draft' },
    { id: 'unverified', needs_mapping: false, gloss_md: 'g', status: 'draft' },
    { id: 'clean', needs_mapping: false, gloss_md: 'g', status: 'draft' },
  ];
  const map = new Map([
    ['flagged', { overall: 'flagged', verdicts: [], model: 'claude-sonnet-5' }],
    ['clean', { overall: 'clean', verdicts: [], model: 'claude-sonnet-5' }],
  ]);
  const plan = planAutoPublish(terms, map);
  assert.deepEqual(plan.needsMapping.map((t) => t.id), ['mapping']);
  assert.deepEqual(plan.noGloss.map((t) => t.id), ['no-gloss']);
  assert.deepEqual(plan.flaggedOrUnverified.map((t) => t.id).sort(), ['flagged', 'unverified']);
  assert.deepEqual(plan.eligible.map((e) => e.term.id), ['clean']);
});

test('planAutoPublish on an empty term list returns four empty buckets', () => {
  const plan = planAutoPublish([], new Map());
  assert.deepEqual(plan, { eligible: [], needsMapping: [], noGloss: [], flaggedOrUnverified: [] });
});

// ---- autoPublishOne: per-transition writes (draft -> approved -> published), each hop its own
// glossary_notes row. action stays inside the DB's existing CHECK ('approved'/'published' — see
// migration 0007); the "auto" distinction lives in the note TEXT, not a new action enum value. ----

function makeHappyClient() {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        update(patch) {
          return {
            eq(col, val) {
              calls.push({ op: 'update', table, patch, col, val });
              return Promise.resolve({ error: null });
            },
          };
        },
        insert(row) {
          calls.push({ op: 'insert', table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

test('autoPublishOne: happy path writes draft->approved->published, each hop its own glossary_notes row', async () => {
  const client = makeHappyClient();
  const term = { id: 't1', term: 'Some Term', status: 'draft' };
  await autoPublishOne(client, term, 'claude-sonnet-5');

  const updates = client.calls.filter((c) => c.op === 'update' && c.table === 'glossary_terms');
  assert.deepEqual(updates.map((u) => u.patch.status), ['approved', 'published']);
  assert.ok(updates[1].patch.published_at, 'publish hop must set published_at');
  assert.equal(updates[0].patch.published_at, undefined, 'approve hop must not set published_at');

  const notes = client.calls.filter((c) => c.op === 'insert' && c.table === 'glossary_notes');
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.row.action), ['approved', 'published']);
  assert.deepEqual(notes.map((n) => n.row.term_id), ['t1', 't1']);
  assert.match(notes[0].row.note, /trust-model v3/);
  assert.match(notes[0].row.note, /auto-approved/);
  assert.match(notes[0].row.note, /claude-sonnet-5/);
  assert.match(notes[1].row.note, /trust-model v3/);
  assert.match(notes[1].row.note, /auto-published/);
});

test('autoPublishOne: the write order is approve-update, approve-note, publish-update, publish-note', async () => {
  const client = makeHappyClient();
  await autoPublishOne(client, { id: 't1', term: 'X', status: 'draft' }, 'claude-sonnet-5');
  assert.deepEqual(
    client.calls.map((c) => `${c.op}:${c.table}:${c.op === 'update' ? c.patch.status : c.row.action}`),
    ['update:glossary_terms:approved', 'insert:glossary_notes:approved', 'update:glossary_terms:published', 'insert:glossary_notes:published'],
  );
});

// ---- 23514 (published-completeness CHECK) surfaces as a typed, per-item-recoverable failure —
// the DB CHECK is the final wall, never aborts the batch. The approve hop (and its note) already
// committed by the time the publish hop's CHECK fires — an honest partial state, not rolled back. ----

function makeCheckViolationClient() {
  const calls = [];
  let glossaryTermsUpdateCount = 0;
  return {
    calls,
    from(table) {
      if (table === 'glossary_terms') {
        return {
          update(patch) {
            return {
              eq(col, val) {
                glossaryTermsUpdateCount += 1;
                calls.push({ op: 'update', table, patch, col, val });
                if (glossaryTermsUpdateCount === 2) {
                  return Promise.resolve({
                    error: {
                      code: '23514',
                      message: 'new row for relation "glossary_terms" violates check constraint "glossary_terms_published_complete"',
                    },
                  });
                }
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      if (table === 'glossary_notes') {
        return {
          insert(row) {
            calls.push({ op: 'insert', table, row });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table in this test: ${table}`);
    },
  };
}

test('autoPublishOne: publish-step 23514 throws PublishCompletenessError; approve hop + its note already committed', async () => {
  const client = makeCheckViolationClient();
  const term = { id: 't1', term: 'Some Term', status: 'draft' };
  await assert.rejects(
    () => autoPublishOne(client, term, 'claude-sonnet-5'),
    (err) => err instanceof PublishCompletenessError && /t1/.test(err.message),
  );

  const updates = client.calls.filter((c) => c.op === 'update' && c.table === 'glossary_terms');
  assert.equal(updates.length, 2, 'both the approve and the (failing) publish update were attempted');
  assert.equal(updates[0].patch.status, 'approved');

  const notes = client.calls.filter((c) => c.op === 'insert' && c.table === 'glossary_notes');
  assert.equal(notes.length, 1, 'only the approve note was written — the publish note never happened');
  assert.equal(notes[0].row.action, 'approved');
});

// ---- idempotency: a second pass over the same DB state finds 0 eligible after the first pass
// already moved the term to 'published' — proven end-to-end with a stateful fake table, not just
// planAutoPublish alone, since the real guarantee comes from loadDraftTerms' own status='draft'
// filter no longer matching the row on the second read. ----

function makeStatefulClient(initialTerms, initialVerifications) {
  const state = {
    glossary_terms: initialTerms.map((t) => ({ ...t })),
    glossary_verifications: initialVerifications.map((v) => ({ ...v })),
    glossary_notes: [],
  };
  return {
    state,
    from(table) {
      if (table === 'glossary_terms') {
        const builder = {
          _filters: [],
          select() { return this; },
          eq(col, val) { this._filters = this._filters.concat([[col, val]]); return this; },
          order() { return this; },
          then(resolve) {
            let rows = state.glossary_terms;
            for (const [col, val] of this._filters) rows = rows.filter((r) => r[col] === val);
            resolve({ data: rows.map((r) => ({ ...r })), error: null });
          },
          update(patch) {
            return {
              eq: (col, val) => {
                const row = state.glossary_terms.find((r) => r[col] === val);
                if (row) Object.assign(row, patch);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
        return builder;
      }
      if (table === 'glossary_verifications') {
        return {
          select() { return this; },
          then(resolve) { resolve({ data: state.glossary_verifications.map((r) => ({ ...r })), error: null }); },
        };
      }
      if (table === 'glossary_notes') {
        return {
          insert(row) {
            state.glossary_notes.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table in this test: ${table}`);
    },
  };
}

test('idempotency: a second pass finds 0 eligible after the first pass published the clean term', async () => {
  const client = makeStatefulClient(
    [{ id: 't1', term: 'Term One', status: 'draft', gloss_md: 'A gloss.', needs_mapping: false, created_at: '2026-01-01T00:00:00Z' }],
    [{ term_id: 't1', overall: 'clean', verdicts: [{ supported: true }], model: 'claude-sonnet-5', created_at: '2026-01-02T00:00:00Z' }],
  );

  async function pass() {
    const { terms } = await loadDraftTerms(client, false);
    const { map } = await loadLatestVerifications(client, terms.map((t) => t.id), false);
    const { eligible } = planAutoPublish(terms, map);
    let published = 0;
    for (const { term, verification } of eligible) {
      await autoPublishOne(client, term, verification.model);
      published += 1;
    }
    return { eligibleCount: eligible.length, published };
  }

  const first = await pass();
  assert.equal(first.eligibleCount, 1);
  assert.equal(first.published, 1);
  assert.equal(client.state.glossary_terms[0].status, 'published');

  const second = await pass();
  assert.equal(second.eligibleCount, 0, 'the now-published term must no longer match the draft-status query');
  assert.equal(second.published, 0);

  // Exactly one approve note and one publish note total across both passes — the second pass did
  // nothing, so it wrote nothing.
  assert.equal(client.state.glossary_notes.length, 2);
});

test('idempotency: a flagged term stays untouched and stays eligible-zero across repeated passes', async () => {
  const client = makeStatefulClient(
    [{ id: 't1', term: 'Flagged Term', status: 'draft', gloss_md: 'A gloss.', needs_mapping: false, created_at: '2026-01-01T00:00:00Z' }],
    [{ term_id: 't1', overall: 'flagged', verdicts: [{ supported: false }], model: 'claude-sonnet-5', created_at: '2026-01-02T00:00:00Z' }],
  );

  async function pass() {
    const { terms } = await loadDraftTerms(client, false);
    const { map } = await loadLatestVerifications(client, terms.map((t) => t.id), false);
    return planAutoPublish(terms, map);
  }

  const first = await pass();
  assert.equal(first.eligible.length, 0);
  assert.deepEqual(first.flaggedOrUnverified.map((t) => t.id), ['t1']);
  assert.equal(client.state.glossary_terms[0].status, 'draft', 'a flagged term must never move — Lance still adjudicates it by hand');

  const second = await pass();
  assert.equal(second.eligible.length, 0);
  assert.equal(client.state.glossary_notes.length, 0, 'no notes are ever written for a term the CLI never touched');
});
