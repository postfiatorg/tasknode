// Gate A smoke: deterministic boards.
//
// Always: validates board-config + board admin route normalization/auth and
// the model-mutation guards without a database.
// With DATABASE_URL: runs migrations twice (idempotence) and asserts the six
// boards are the only active network projects.
//
// Usage: node scripts/deterministic-boards-smoke.mjs

import assert from "node:assert/strict";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const {
  DETERMINISTIC_BOARD_IDS,
  deterministicBoardsEnabled,
  isDeterministicBoardId,
} = await import("../server/board-config.js");
const { boardAdminAuthorized, normalizeBoardAdminUpdate } = await import(
  "../server/board-admin-routes.js"
);

// --- board-config ---
assert.equal(DETERMINISTIC_BOARD_IDS.length, 6, "exactly six boards");
assert.ok(isDeterministicBoardId("board_pf_terminal"));
assert.ok(!isDeterministicBoardId("pft_distribution_v3"));
assert.ok(deterministicBoardsEnabled({}), "deterministic boards default on");
assert.ok(!deterministicBoardsEnabled({ TASKNODE_DETERMINISTIC_BOARDS: "false" }));

// --- admin route auth ---
const noToken = boardAdminAuthorized({ headers: {} }, {});
assert.equal(noToken.ok, false);
assert.equal(noToken.status, 409, "unconfigured token is 409");
const badToken = boardAdminAuthorized(
  { headers: { authorization: "Bearer wrong" } },
  { TASKNODE_BOARD_ADMIN_TOKEN: "right" }
);
assert.equal(badToken.status, 401, "wrong token is 401");
const goodToken = boardAdminAuthorized(
  { headers: { authorization: "Bearer right" } },
  { TASKNODE_BOARD_ADMIN_TOKEN: "right" }
);
assert.equal(goodToken.ok, true);

// --- admin route normalization ---
assert.equal(normalizeBoardAdminUpdate({ boardId: "not_a_board", title: "x" }).ok, false);
assert.equal(normalizeBoardAdminUpdate({ boardId: "board_pf_terminal" }).ok, false, "no fields rejected");
assert.equal(
  normalizeBoardAdminUpdate({ boardId: "board_pf_terminal", status: "bogus" }).ok,
  false,
  "invalid status rejected"
);
const good = normalizeBoardAdminUpdate({
  boardId: "board_pf_terminal",
  title: "PF Terminal",
  priority: "25",
  metadataPatch: { note: "smoke" },
});
assert.equal(good.ok, true);
assert.equal(good.fields.priority, 25);
assert.equal(good.fields.title, "PF Terminal");

// Immutable fields are ignored, not applied.
const sneaky = normalizeBoardAdminUpdate({
  boardId: "board_pf_terminal",
  id: "board_pf_terminal",
  origin: "hive",
  type: "alpha_generation",
  title: "ok",
});
assert.equal(sneaky.ok, true);
assert.ok(!("origin" in sneaky.fields) && !("type" in sneaky.fields), "immutable fields dropped");

// --- model-mutation guard (no DB needed: guard fires before queries) ---
{
  const { executeBoardManagerDecision } = await import("../server/board-manager-actions.js");
  if (process.env.TASKNODE_DATABASE_ENABLED === "true") {
    const { migrateDatabase } = await import("../server/db/migrate.js");
    await migrateDatabase();
    const { startBoardManagerRun } = await import("../server/repositories/board-manager.js");
    const run = await startBoardManagerRun({
      scope: "global_hive",
      trigger: "deterministic_boards_smoke",
      sourcePacket: { sourcePacketDigest: "smoke" },
    });
    const guarded = await executeBoardManagerDecision({
      runId: run?.id || "",
      dryRun: false,
      decision: {
        action: "create_project",
        target_type: "project",
        target_id: "smoke_project",
        reason: "smoke",
        confidence: 1,
        decision_basis: { source_facts: [], tradeoffs: [], rejected_actions: [], risk_notes: [], next_check: "" },
        payload: { project: { title: "Smoke" } },
      },
    });
    assert.equal(guarded.result?.skipped, true, "create_project skipped");
    assert.equal(guarded.result?.reason, "deterministic_boards_enabled");
    console.log("model-mutation guard: create_project blocked (deterministic_boards_enabled)");
  } else {
    console.log("model-mutation guard: skipped (no database; guard is after DB check)");
  }
}

console.log("deterministic-boards unit checks passed");

// --- database part ---
if (process.env.DATABASE_URL) {
  const { migrateDatabase } = await import("../server/db/migrate.js");
  const { query, closePool } = await import("../server/db/pool.js");
  await migrateDatabase();
  await migrateDatabase(); // idempotence
  const active = await query(
    "SELECT id FROM network_projects WHERE status = 'active' ORDER BY priority"
  );
  const activeIds = active.rows.map((row) => row.id);
  assert.deepEqual(activeIds, [...DETERMINISTIC_BOARD_IDS], "active projects are exactly the six boards");
  const locked = await query(
    `SELECT count(*)::int AS n FROM network_projects
     WHERE status = 'archived' AND (metadata_json->>'operator_archived') = 'true'`
  );
  console.log(`db checks passed: 6 active boards, ${locked.rows[0].n} archived+locked legacy projects`);
  await closePool();
} else {
  console.log("db checks skipped: set DATABASE_URL to run migration idempotence checks");
}
