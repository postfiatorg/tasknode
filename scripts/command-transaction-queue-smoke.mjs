import assert from "node:assert/strict";
const url = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
assert.equal(url.pathname, "/tasknode_hive_audit_20260919");
process.env.DATABASE_STATEMENT_TIMEOUT_MS = "500";
const { query, transaction, transactionCommand, closePool } = await import("../server/db/pool.js");
try {
  const start = Date.now();
  const values = await transactionCommand(() => transaction(async client => {
    // The command lasts longer than one statement timeout; no individual SQL
    // statement does. Cover both repository query() and nested client.query().
    return Promise.all(Array.from({ length: 24 }, (_, index) =>
      (index % 2 ? query : client.query.bind(client))("SELECT pg_sleep(0.04),$1::int AS value", [index])));
  }));
  assert.deepEqual(values.map(result => result.rows[0].value), Array.from({ length: 24 }, (_, index) => index));
  assert.ok(Date.now() - start >= 900);
  await assert.rejects(transactionCommand(() => query("SELECT pg_sleep(0.8)")), error => error.code === "57014" || error.message.includes("timeout"));
  assert.equal((await transactionCommand(() => query("SELECT 1 AS value"))).rows[0].value, 1);
  console.log(JSON.stringify({ ok: true, concurrentReads: 24, statementTimeoutMs: 500, commandExceedsSingleStatementTimeout: true, slowStatementStillRejected: true, connectionReusableAfterRollback: true }));
} finally { await closePool(); }
