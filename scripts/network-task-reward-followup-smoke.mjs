import assert from "node:assert/strict";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { syncNetworkTaskProjection } from "../server/repositories/network-tasks.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const suffix = `${Date.now()}`;
const projectId = `net_reward_followup_project_${suffix}`;
const taskId = `task_reward_followup_${suffix}`;
const duplicateTaskId = `task_reward_followup_recent_${suffix}`;
const wallet = `rRewardFollowup${suffix}`.slice(0, 120);

async function cleanup() {
  await query("DELETE FROM board_manager_jobs WHERE idempotency_key LIKE $1", [`network_task_rewarded_followup:task_reward_followup_${suffix}%`]);
  await query("DELETE FROM board_manager_jobs WHERE idempotency_key LIKE $1", [`network_task_rewarded_followup:task_reward_followup_recent_${suffix}%`]);
  await query("DELETE FROM board_manager_runs WHERE id LIKE $1", [`boardrun_reward_followup_${suffix}%`]);
  await query("DELETE FROM task_events WHERE task_id IN ($1, $2)", [taskId, duplicateTaskId]);
  await query("DELETE FROM network_task_allocations WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_project_task_refs WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_projects WHERE id = $1", [projectId]);
  await query("DELETE FROM task_projections WHERE task_id IN ($1, $2)", [taskId, duplicateTaskId]);
}

async function insertProjectTask({ targetTaskId, txHash, eventAt, projectionLastEventAt = eventAt }) {
  await query(
    `
      INSERT INTO network_projects (
        id, type, title, summary, objective, about, status, origin, proposed_by
      )
      VALUES (
        $1, 'protocol_development', 'Reward followup smoke', 'Smoke project',
        'Verify reward projection without retired scheduler jobs.',
        'Smoke project for rewarded Network Task follow-up.', 'active', 'smoke', 'hive'
      )
      ON CONFLICT (id) DO NOTHING
    `,
    [projectId]
  );
  await query(
    `
      INSERT INTO network_project_task_refs (
        id, project_id, task_id, request_id, title, state, assignee_wallet, reward_pft, source
      )
      VALUES ($1, $2, $3, $4, 'Reward followup task', 'accepted', $5, 10000, 'smoke')
    `,
    [`netref_${targetTaskId}`, projectId, targetTaskId, `req_${targetTaskId}`, wallet]
  );
  await query(
    `
      INSERT INTO network_task_allocations (
        id, idempotency_key, project_id, task_class, allocation_status,
        task_request_id, generated_task_id, candidate_wallet_address
      )
      VALUES ($1, $2, $3, 'network', 'accepted', $4, $5, $6)
    `,
    [`netalloc_${targetTaskId}`, `netalloc_${targetTaskId}`, projectId, `req_${targetTaskId}`, targetTaskId, wallet]
  );
  await query(
    `
      INSERT INTO task_projections (
        task_id, account_id, subject_wallet, status, title, reward_offer_pft,
        reward_actual_pft, last_event_tx_hash, last_event_cid, last_event_at,
        updated_at, source
      )
      VALUES (
        $1, 'acct_reward_followup_smoke', $2, 'rewarded', 'Reward followup task',
        10000, 7500, $3, $4, $5, $5, 'smoke'
      )
    `,
    [targetTaskId, wallet, txHash, `cid_${targetTaskId}`, projectionLastEventAt]
  );
  await query(
    `
      INSERT INTO task_events (
        id, task_id, account_id, wallet_address, event_type,
        source_tx_hash, source_cid, payload_json, occurred_at, created_at
      )
      VALUES (
        $1, $2, 'acct_reward_followup_smoke', $3, 'pf.reward.v1',
        $4, $5, $6::jsonb, $7, $7
      )
    `,
    [
      `taskevt_reward_followup_${targetTaskId}`,
      targetTaskId,
      wallet,
      txHash,
      `cid_${targetTaskId}`,
      JSON.stringify({
        schema: "pf.reward.v1",
        task_id: targetTaskId,
        reward_pft: "7500",
      }),
      eventAt,
    ]
  );
}

async function main() {
  if (!databaseEnabled()) {
    console.log("network task reward followup smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  try {
    const eventAt = new Date(Date.now() - 30_000);
    const staleProjectionLastEventAt = new Date(eventAt.getTime() - 30 * 60_000);
    await insertProjectTask({
      targetTaskId: taskId,
      txHash: `tx_reward_followup_${suffix}`,
      eventAt,
      projectionLastEventAt: staleProjectionLastEventAt,
    });

    await insertProjectTask({
      targetTaskId: duplicateTaskId,
      txHash: `tx_reward_followup_recent_${suffix}`,
      eventAt,
    });
    for (const targetTaskId of [taskId, duplicateTaskId, taskId]) {
      const synced = await syncNetworkTaskProjection({ taskId: targetTaskId });
      assert.equal(synced.ok, true);
      assert.equal(synced.status, "rewarded");
      assert.equal(synced.taskRefsUpdated, 1);
      assert.equal(Object.hasOwn(synced, "boardManagerFollowup"), false);
      const refs = await query("SELECT state, reward_pft FROM network_project_task_refs WHERE task_id = $1", [targetTaskId]);
      assert.equal(refs.rows[0].state, "rewarded");
      assert.equal(Number(refs.rows[0].reward_pft), 7500);
    }
    const jobs = await query("SELECT count(*)::int AS count FROM board_manager_jobs WHERE idempotency_key LIKE $1 OR idempotency_key LIKE $2", [
      `network_task_rewarded_followup:${taskId}%`, `network_task_rewarded_followup:${duplicateTaskId}%`,
    ]);
    assert.equal(jobs.rows[0].count, 0, "Rewarded tasks and replay must never enqueue the retired scheduler");
    const project = await query("SELECT pft_routed FROM network_projects WHERE id = $1", [projectId]);
    assert.equal(Number(project.rows[0].pft_routed), 15000, "Shared project reward accounting remains intact");

    console.log("network task reward followup smoke ok");
  } finally {
    await cleanup();
  }
}

try {
  await main();
} finally {
  await closePool();
}
