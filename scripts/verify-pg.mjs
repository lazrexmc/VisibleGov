// Verify the direct-Postgres analysis path: that it connects, that it is genuinely read-only, and
// that it is actually faster than the PostgREST path it exists to replace.
//
// Read-only in every sense — the write test below is EXPECTED to fail, and a failure is the pass.
//
// Usage: node --env-file=.env scripts/verify-pg.mjs
import { getPgPool, pgQuery, pgCount, closePgPool } from '../src/lib/pg.js';
import { getClient, selectAll } from '../src/lib/db.js';

if (!getPgPool()) {
  console.log(`
SUPABASE_DB_URL is not set — the direct-Postgres path is simply absent (nothing is broken).

To enable it:
  1. Supabase dashboard -> Project Settings -> Database -> Connection string -> URI
  2. Choose the SESSION POOLER entry (port 5432), not the transaction pooler (6543):
     transaction mode does not support prepared statements, which node-postgres uses.
  3. Substitute your database password for [YOUR-PASSWORD] in that URI. That password is NOT the
     service-role key and is not interchangeable with it. If you do not know it, the same page has
     "Reset database password".
  4. Add it to .env as a single line:

       SUPABASE_DB_URL=postgresql://postgres.<project>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

  5. Re-run: node --env-file=.env scripts/verify-pg.mjs

.env is already gitignored. Do not paste this string into a doc, a commit, or a chat message —
it grants full database access and bypasses RLS entirely.
`);
  process.exitCode = 1;
} else {
  await verify();
}

async function verify() {
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  console.log('=== connectivity ===');
  const [{ now, version }] = await pgQuery('select now() as now, version() as version');
  check('connects and runs SQL', Boolean(now), String(version).split(',')[0]);

  console.log('\n=== read-only is enforced by POSTGRES, not by string matching ===');
  let wroteAnyway = false;
  try {
    await pgQuery("create table if not exists __pg_readonly_probe (x int)");
    wroteAnyway = true;
  } catch (err) {
    check('DDL is rejected', /read-only|cannot execute/i.test(err.message), err.message.split('\n')[0].slice(0, 80));
  }
  if (wroteAnyway) check('DDL is rejected', false, 'A WRITE SUCCEEDED — the read-only transaction is not working');

  let updated = false;
  try {
    await pgQuery("update votes set question = question where false");
    updated = true;
  } catch (err) {
    check('UPDATE is rejected', /read-only|cannot execute/i.test(err.message), err.message.split('\n')[0].slice(0, 80));
  }
  if (updated) check('UPDATE is rejected', false, 'AN UPDATE SUCCEEDED — do not use this path');

  console.log('\n=== correctness: does SQL agree with the PostgREST path? ===');
  const sqlVotes = await pgCount('select count(*) from votes');
  const client = getClient();
  const { data: restVotes } = await selectAll(client, 'votes', 'id');
  check('votes count matches selectAll', sqlVotes === restVotes.length, `sql ${sqlVotes} vs rest ${restVotes.length}`);

  console.log('\n=== the trap this path removes ===');
  // A single unpaginated PostgREST read silently caps at 1,000 rows. count(*) cannot.
  const { data: naive } = await client.from('votes').select('id').limit(20000);
  console.log(`  PostgREST .limit(20000) returned ${naive.length} rows (the cap, not the truth)`);
  console.log(`  SQL count(*) returned          ${sqlVotes}`);
  check('SQL is immune to the 1,000-row cap', sqlVotes > naive.length);

  console.log('\n=== speed on a real analytical question ===');
  console.log('  Q: how many casts does each vote have, and how many votes have <= 4?');

  const t0 = Date.now();
  const [{ thin }] = await pgQuery(`
    select count(*)::int as thin from (
      select v.id, count(c.id) as n
      from votes v left join vote_casts c on c.vote_id = v.id
      group by v.id
    ) t where t.n <= 4`);
  const sqlMs = Date.now() - t0;
  console.log(`  SQL      : ${thin} votes, ${sqlMs} ms, 1 round trip`);

  // The REST equivalent, sampled: time 3 chunks of 60 and extrapolate rather than run all ~170.
  const ids = restVotes.slice(0, 180).map((r) => r.id);
  const t1 = Date.now();
  for (let i = 0; i < ids.length; i += 60) {
    // eslint-disable-next-line no-await-in-loop
    await selectAll(client, 'vote_casts', 'vote_id', { filter: (q) => q.in('vote_id', ids.slice(i, i + 60)), maxPages: 400 });
  }
  const restMs = Date.now() - t1;
  const chunks = Math.ceil(restVotes.length / 60);
  const projected = Math.round((restMs / 3) * chunks);
  console.log(`  PostgREST: ${restMs} ms for 3 of ${chunks} chunks -> ~${(projected / 1000).toFixed(0)}s projected`);
  console.log(`  speedup  : ~${Math.round(projected / Math.max(sqlMs, 1))}x`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures) process.exitCode = 1;
  await closePgPool();
}
