import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://tasknode:tasknode@127.0.0.1:1/tasknode";
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.DATABASE_CONNECTION_TIMEOUT_MS = "500";
process.env.DATABASE_STATEMENT_TIMEOUT_MS = "500";

const { listTaskState } = await import("../server/repositories/tasks.js");
const { closePool } = await import("../server/db/pool.js");

try {
  const state = await listTaskState({
    accountId: "acct_task_read_resilience",
    walletAddress: "rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE",
  });

  assert.equal(state.sync.status, "database_error");
  assert.equal(state.sync.requiresRefresh, true);
  // A failing projection read must not invite forced sync/reduce write
  // passes; the client polls at the suggested 5s cadence with backoff.
  assert.equal(state.sync.forceProjectionRefresh, false);
  assert.equal(state.sync.nextPollMs, 5000);
  assert.equal(state.sync.refreshReason, "task_projection_read_failed");
  assert.deepEqual(state.outstanding, []);
  assert.ok(state.sync.error);

  console.log("task read resilience smoke ok");
} finally {
  await closePool().catch(() => {});
}
