// Gate C smoke: deterministic reward caps + agent decision recording.
//
// Requires DATABASE_URL (local dev Postgres). Creates synthetic rows under
// a smoke prefix, exercises every cap, then removes them.
//
// Usage: DATABASE_URL=... node scripts/bm-caps-smoke.mjs

import assert from "node:assert/strict";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const { migrateDatabase } = await import("../server/db/migrate.js");
const { query, closePool } = await import("../server/db/pool.js");
const {
  boardForTask,
  computeRewardCap,
  pendingAgentDecision,
  recordBoardRewardSpend,
} = await import("../server/repositories/bm-decisions.js");
const { reviewTask } = await import("./bm/writes.mjs");

const BOARD = "board_pf_terminal";
const TASK = "task_bmsmoke_0000000000000001";
const ALLOC = "alloc_bmsmoke_1";
const ACCOUNT = "acct_bmsmoke";
const WALLET = "rBMSMOKEWALLET";

async function cleanup() {
  await query("DELETE FROM bm_agent_decisions WHERE task_id LIKE 'task_bmsmoke_%'");
  await query("DELETE FROM board_reward_spend WHERE task_id LIKE 'task_bmsmoke_%' OR account_id = $1", [ACCOUNT]);
  await query("DELETE FROM bm_audit_log WHERE args_json->>'taskId' LIKE 'task_bmsmoke_%'");
  await query("DELETE FROM network_task_allocations WHERE id = $1", [ALLOC]);
  await query("DELETE FROM task_projections WHERE task_id = $1", [TASK]);
}

try {
  await migrateDatabase();
  await cleanup();

  // Synthetic board-linked task lineage.
  await query(
    `INSERT INTO network_task_allocations (id, project_id, generated_task_id, candidate_account_id, candidate_wallet_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [ALLOC, BOARD, TASK, ACCOUNT, WALLET]
  );
  await query(
    `INSERT INTO task_projections (task_id, account_id, subject_wallet, status, title, reward_offer_pft)
     VALUES ($1, $2, $3, 'verification_response_submitted', 'BM caps smoke task', 999999)`,
    [TASK, ACCOUNT, WALLET]
  );

  assert.equal(await boardForTask(TASK), BOARD, "board lineage resolves");

  // 1. Per-task cap: 999,999 asked, 5,000 allowed.
  const cap1 = await computeRewardCap({ boardId: BOARD, accountId: ACCOUNT, walletAddress: WALLET, requestedPft: 999999 });
  assert.equal(cap1.allowedPft, 5000, "per-task cap clamps to 5000");
  assert.ok(cap1.capsApplied.some((cap) => cap.cap === "per_task_cap_pft"));

  // 2. Daily budget: burn 48,000 of 50,000 today, ask 5,000 -> 2,000.
  for (let i = 0; i < 12; i += 1) {
    await recordBoardRewardSpend({
      boardId: BOARD,
      taskId: `task_bmsmoke_burn_${i}`,
      accountId: `acct_bmsmoke_other_${i}`,
      walletAddress: `rOTHER${i}`,
      rewardPft: 4000,
      decidedBy: "caps_smoke",
    });
  }
  const cap2 = await computeRewardCap({ boardId: BOARD, accountId: ACCOUNT, walletAddress: WALLET, requestedPft: 5000 });
  assert.equal(cap2.allowedPft, 2000, "daily budget remaining clamps to 2000");
  assert.ok(cap2.capsApplied.some((cap) => cap.cap === "daily_budget_remaining_pft"));

  // 3. Per-user 7d cap: user already earned 59,500 this week -> 500 left,
  // even though 2,000 daily budget remains.
  await recordBoardRewardSpend({
    boardId: BOARD,
    taskId: "task_bmsmoke_userburn",
    accountId: ACCOUNT,
    walletAddress: WALLET,
    rewardPft: 59500,
    decidedBy: "caps_smoke",
  });
  // (user burn also consumed daily budget; reset today's other spend to isolate)
  await query(
    `UPDATE board_reward_spend SET created_at = now() - interval '2 days'
     WHERE task_id = 'task_bmsmoke_userburn'`
  );
  const cap3 = await computeRewardCap({ boardId: BOARD, accountId: ACCOUNT, walletAddress: WALLET, requestedPft: 2000 });
  assert.equal(cap3.allowedPft, 500, "per-user 7d cap clamps to 500");
  assert.ok(cap3.capsApplied.some((cap) => cap.cap === "per_user_7d_remaining_pft"));

  // 4. bm review records a clamped pending decision.
  const review = await reviewTask({
    taskId: TASK,
    decision: "reward",
    pft: 999999,
    reason: "caps smoke",
    feedback: "clamped",
  });
  assert.equal(review.clampedPft, 500, "review decision clamped by all caps");
  assert.equal(review.decision.status, "pending");
  const pending = await pendingAgentDecision({ taskId: TASK, kind: "review" });
  assert.equal(pending.id, review.decision.id, "decision is pending for the worker");
  assert.equal(Number(pending.reward_pft), 500);
  assert.equal(Number(pending.requested_reward_pft), 999999);

  // 5. A second review supersedes the first.
  const review2 = await reviewTask({ taskId: TASK, decision: "reject", pft: 0, reason: "superseded test" });
  const afterSupersede = await query("SELECT status FROM bm_agent_decisions WHERE id = $1", [review.decision.id]);
  assert.equal(afterSupersede.rows[0].status, "superseded");
  const pending2 = await pendingAgentDecision({ taskId: TASK, kind: "review" });
  assert.equal(pending2.id, review2.decision.id);
  assert.equal(pending2.decision, "reject");

  // 6. Exhausted user cap refuses instead of granting zero silently.
  await query("UPDATE board_reward_spend SET reward_pft = 60000 WHERE task_id = 'task_bmsmoke_userburn'");
  const refused = await reviewTask({ taskId: TASK, decision: "reward", pft: 100, reason: "refusal test" });
  assert.equal(refused.refused, true, "cap exhaustion refuses the decision");
  assert.equal(refused.decision.status, "refused");

  // 7. Audit rows exist for every mutating call.
  const audits = await query(
    "SELECT count(*)::int AS n FROM bm_audit_log WHERE command = 'review' AND args_json->>'taskId' = $1",
    [TASK]
  );
  assert.ok(audits.rows[0].n >= 3, "audit rows recorded");

  console.log("bm caps smoke passed: per-task, daily-budget, per-user-7d, clamp, supersede, refusal, audit");
} finally {
  await cleanup().catch(() => null);
  await closePool();
}
