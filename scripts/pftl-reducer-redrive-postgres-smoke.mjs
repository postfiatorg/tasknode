import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { claimPftlReducerEvents } from "../server/pftl-cache-reducer.js";

const url = process.env.TASKNODE_TEST_DATABASE_URL;
assert.ok(url, "TASKNODE_TEST_DATABASE_URL must point to a disposable test database");
const schema = `reducer_redrive_${process.pid}_${Date.now()}`;
const pool = new pg.Pool({ connectionString: url, max: 4 });
const client = await pool.connect();
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(readFileSync(new URL("../server/db/migrations/008_pftl_cache_watcher.sql", import.meta.url), "utf8"));
  await client.query("BEGIN");
  // PostgreSQL now() is transaction-stable: strict equality needs no timing race.
  const fixtures = [
    ["elapsed", "failed", 2, 121, "target"],
    ["unelapsed", "failed", 2, 119, "target"],
    ["boundary", "failed", 2, 120, "target"],
    ["minimum", "failed", 0, 61, "target"],
    ["minimum_boundary", "failed", 0, 60, "target"],
    ["final", "failed", 49, 2941, "target"],
    ["final_boundary", "failed", 49, 2940, "target"],
    ["capped", "failed", 50, 7201, "target"],
    ["stale", "processing", 5, 601, "target"],
    ["fresh", "processing", 5, 599, "target"],
    ["completed", "completed", 3, 3601, "target"],
    ["other", "failed", 2, 121, "other_task"],
  ];
  for (const [name, status, attempts, age, task] of fixtures) {
    await client.query(`INSERT INTO pftl_cache_reducer_events
      (dedupe_key,wallet_address,tx_hash,reducer_kind,task_id,status,attempts,updated_at)
      VALUES ($1,'fixture_wallet',$1,'task',$2,$3,$4,now()-($5*interval '1 second'))`,
    [name, task, status, attempts, age]);
  }
  const before = (await client.query("SELECT * FROM pftl_cache_reducer_events WHERE dedupe_key='completed'")).rows[0];
  const options = { limit: 100, taskId: "target", databaseEnabledImpl: () => true, transactionImpl: work => work(client) };
  const claimed = await claimPftlReducerEvents(options);
  assert.deepEqual(claimed.map(row => row.dedupe_key).sort(), ["elapsed", "final", "minimum", "stale"]);
  const rows = (await client.query("SELECT * FROM pftl_cache_reducer_events")).rows;
  const state = Object.fromEntries(rows.map(row => [row.dedupe_key, row]));
  assert.equal(state.final.attempts, 50, "49 receives its final claim");
  assert.equal(state.minimum.attempts, 1);
  assert.equal(state.capped.status, "failed", "50 must not be re-driven");
  assert.equal(state.capped.attempts, 50);
  for (const name of ["unelapsed", "boundary", "minimum_boundary", "final_boundary"]) assert.equal(state[name].status, "failed", name);
  assert.equal(state.stale.attempts, 6);
  assert.equal(state.fresh.status, "processing");
  assert.equal(state.fresh.attempts, 5);
  assert.equal(state.other.status, "pending", "retry scheduling is global; claiming remains task-filtered");
  assert.equal(state.other.attempts, 2);
  assert.deepEqual(state.completed, before, "completed row must remain unchanged");
  assert.deepEqual(await claimPftlReducerEvents(options), [], "no immediate duplicate claim");
  const other = await claimPftlReducerEvents({ ...options, taskId: "", txHash: "other" });
  assert.deepEqual(other.map(row => row.dedupe_key), ["other"], "transaction filter selects only its pending row");
  await client.query("UPDATE pftl_cache_reducer_events SET status='failed',updated_at=now()-interval '2 hours' WHERE dedupe_key='final'");
  assert.deepEqual(await claimPftlReducerEvents({ ...options, txHash: "final" }), [], "final claim must not renew after reaching 50");
  await client.query("ROLLBACK");
  console.log("ok: elapsed/unelapsed/equality, minimum delay, 49->50, hard cap, stale processing, task/tx filters, completed unchanged, no duplicate");

  // Commit fixtures so independent PostgreSQL connections can contend for them.
  await client.query(`INSERT INTO pftl_cache_reducer_events
    (dedupe_key,wallet_address,tx_hash,reducer_kind,status,attempts,updated_at)
    VALUES ('race_a','fixture_wallet','race_a','task','failed',2,now()-interval '121 seconds'),
           ('race_b','fixture_wallet','race_b','task','failed',2,now()-interval '121 seconds')`);
  let begun = 0;
  let release;
  let rejectBarrier;
  const bothBegun = new Promise((resolve, reject) => { release = resolve; rejectBarrier = reject; });
  // Setup may fail before either worker awaits the barrier. The original error
  // is propagated by allSettled below while this handler prevents an orphan.
  bothBegun.catch(() => {});
  const transactionImpl = async work => {
    let worker;
    try {
      worker = await pool.connect();
      await worker.query("BEGIN");
      await worker.query(`SET LOCAL search_path TO ${schema}`);
      await worker.query("SET LOCAL statement_timeout TO '5s'");
      begun += 1;
      if (begun === 2) release();
      await bothBegun;
      const result = await work(worker);
      await worker.query("COMMIT");
      return result;
    } catch (error) {
      rejectBarrier(error);
      if (worker) await worker.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      worker?.release();
    }
  };
  const outcomes = await Promise.allSettled([1, 2].map(() => claimPftlReducerEvents({ limit: 1, databaseEnabledImpl: () => true, transactionImpl })));
  const failure = outcomes.find(outcome => outcome.status === "rejected");
  if (failure) throw failure.reason;
  const races = outcomes.map(outcome => outcome.value);
  assert.deepEqual(races.map(batch => batch.length), [1, 1]);
  assert.deepEqual(races.flat().map(row => row.dedupe_key).sort(), ["race_a", "race_b"]);
  assert.ok(races.flat().every(row => row.attempts === 3), "each failed row gets exactly one new attempt");
  console.log("ok: two overlapping transactions claim disjoint failed rows with one increment each");

  await client.query("TRUNCATE pftl_cache_reducer_events");
  await client.query(`INSERT INTO pftl_cache_reducer_events (dedupe_key,wallet_address,tx_hash,reducer_kind)
    VALUES ('locked','fixture_wallet','locked','task'), ('unlocked','fixture_wallet','unlocked','task')`);
  const locker = await pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query(`SET LOCAL search_path TO ${schema}`);
    await locker.query("SELECT id FROM pftl_cache_reducer_events WHERE dedupe_key='locked' FOR UPDATE");
    // The barrier is already released; this transaction must skip the held row.
    const skipped = await claimPftlReducerEvents({ limit: 1, databaseEnabledImpl: () => true, transactionImpl });
    assert.deepEqual(skipped.map(row => row.dedupe_key), ["unlocked"]);
  } finally {
    await locker.query("ROLLBACK");
    locker.release();
  }
  console.log("ok: pending row locked by another transaction is skipped");
  console.log("pftl reducer redrive postgres smoke ok");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  client.release();
  await pool.end();
}
