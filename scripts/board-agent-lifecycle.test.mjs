import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import pg from "pg";

// Exercise the real authenticated route, dispatch and domain guard without a
// database connection or any production task/payment mutation.
process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.TASKNODE_DATABASE_DISABLED = "false";
process.env.TASKNODE_POSTGRES_DISABLED = "false";
const { handleBoardAgentRoute } = await import("../server/board-agent-routes.js");
const { closePool } = await import("../server/db/pool.js");
const taskId = "task_lifecycle_fixture";
const boardId = "board_tasknode_fixes";

async function command(t, argv, status, { outsideScope = false, databaseFailure = false } = {}) {
  const statements = [];
  const query = async (input) => {
    const sql = typeof input === "string" ? input : input.text;
    statements.push(sql);
    if (sql.includes("FROM board_agent_credentials")) {
      return { rows: [{ id: "credential_fixture", actor: "fixture", board_ids: [boardId] }] };
    }
    if (sql.includes("FROM network_task_allocations")) {
      if (databaseFailure) throw new Error("private database connection diagnostic");
      return { rows: [{ project_id: outsideScope ? "board_other" : boardId }] };
    }
    if (sql.includes("FROM task_projections")) {
      return { rows: [{ task_id: taskId, status, account_id: "account_fixture", reward_offer_pft: 100 }] };
    }
    if (sql.includes("INSERT INTO board_agent_commands")) return { rows: [{ request_key: "fixture" }] };
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.startsWith("SELECT set_config(") || sql.startsWith("SELECT pg_advisory_xact_lock(")) return { rows: [] };
    throw new Error("Unexpected fixture query: " + sql);
  };
  const client = { query, release() {} };
  t.mock.method(pg.Pool.prototype, "query", query);
  t.mock.method(pg.Pool.prototype, "connect", async () => client);
  const errors = t.mock.method(console, "error", () => {});
  let response;
  const handled = await handleBoardAgentRoute({
    req: { method: "POST", headers: { authorization: "Bearer " + "x".repeat(40) } },
    res: {},
    url: new URL("https://fixture.invalid/api/agent/board/command"),
    readJson: async () => ({ requestKey: "fixture", argv }),
    json: (_res, code, body) => { response = { code, body }; },
  });
  assert.equal(handled, true);
  assert.ok(statements.includes("ROLLBACK"), "rejected command must roll back its tentative receipt");
  assert.ok(!statements.includes("COMMIT"));
  assert.ok(!statements.some((sql) => sql.includes("INSERT INTO bm_agent_decisions")));
  return { ...response, errors };
}

for (const status of ["submitted", "accepted", "verification_requested", "rewarded"]) {
  test("review from " + status + " returns an actionable conflict, not a retryable failure", async (t) => {
    const result = await command(t, ["review", taskId, "--decision", "reward", "--pft", "100"], status);
    assert.equal(result.code, 409);
    assert.equal(result.body.ok, false);
    assert.ok(result.body.message.includes("lifecycle_violation"));
    assert.ok(result.body.message.includes("verification_response_submitted"));
    assert.ok(!result.body.message.includes("Retry with its saved request key"));
    if (status === "submitted") assert.ok(result.body.message.includes("bm verify request " + taskId));
    assert.equal(result.errors.mock.callCount(), 0);
  });
}
for (const status of ["accepted", "verification_response_submitted", "rewarded"]) {
  test("verify request from " + status + " returns an actionable conflict", async (t) => {
    const result = await command(t, ["verify", "request", taskId, "--ask", "Confirm the merged artifact."], status);
    assert.equal(result.code, 409);
    assert.ok(result.body.message.includes("lifecycle_violation"));
    assert.ok(result.body.message.includes("only for state 'submitted'"));
    assert.equal(result.errors.mock.callCount(), 0);
  });
}
test("scope denial stays forbidden before lifecycle information is exposed", async (t) => {
  const result = await command(t, ["review", taskId, "--decision", "reward"], "submitted", { outsideScope: true });
  assert.equal(result.code, 403);
  assert.equal(result.body.error, "board_agent_scope_denied");
});
test("unexpected database failures remain redacted and retryable", async (t) => {
  const result = await command(t, ["review", taskId, "--decision", "reward"], "submitted", { databaseFailure: true });
  assert.equal(result.code, 500);
  assert.equal(result.body.error, "board_agent_command_failed");
  assert.ok(result.body.message.includes("Retry with its saved request key"));
  assert.ok(!JSON.stringify(result.body).includes("private database"));
});
after(async () => { mock.restoreAll(); await closePool(); });
