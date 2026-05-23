import assert from "node:assert/strict";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { syncNetworkTaskProjection } from "../server/repositories/network-tasks.js";
import { shouldSkipBoardManagerJobForRecentRun } from "../server/repositories/board-manager-scheduler.js";

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
  await query("DELETE FROM network_task_allocations WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_project_task_refs WHERE project_id = $1", [projectId]);
  await query("DELETE FROM network_projects WHERE id = $1", [projectId]);
  await query("DELETE FROM task_projections WHERE task_id IN ($1, $2)", [taskId, duplicateTaskId]);
}

async function insertProjectTask({ targetTaskId, txHash, eventAt }) {
  await query(
    `
      INSERT INTO network_projects (
        id, type, title, summary, objective, about, status, origin, proposed_by
      )
      VALUES (
        $1, 'protocol_development', 'Reward followup smoke', 'Smoke project',
        'Verify rewarded Network Tasks trigger Board Manager follow-up.',
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
    [targetTaskId, wallet, txHash, `cid_${targetTaskId}`, eventAt]
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
    await insertProjectTask({ targetTaskId: taskId, txHash: `tx_reward_followup_${suffix}`, eventAt });

    const synced = await syncNetworkTaskProjection({ taskId });
    assert.equal(synced.ok, true);
    assert.equal(synced.status, "rewarded");
    assert.equal(synced.boardManagerFollowup?.queued, true);
    assert.equal(synced.boardManagerFollowup?.job?.trigger, "network_task_rewarded_followup");

    const job = synced.boardManagerFollowup.job;
    const metadata = job.metadata_json || {};
    assert.equal(metadata.task_id, taskId);
    assert.equal(metadata.skip_if_completed_after, eventAt.toISOString());
    assert.deepEqual(metadata.project_ids, [projectId]);

    const runAfterMs = new Date(job.run_after).getTime();
    assert.equal(runAfterMs, eventAt.getTime() + 120_000);

    const duplicate = await syncNetworkTaskProjection({ taskId });
    assert.equal(duplicate.boardManagerFollowup?.queued, false);
    assert.equal(duplicate.boardManagerFollowup?.reason, "reward_followup_already_recorded");

    await query(
      `
        INSERT INTO board_manager_runs (
          id, scope, manager_id, trigger, status, selected_action, dry_run, completed_at
        )
        VALUES ($1, 'global_hive', 'reward_followup_smoke', 'reward_followup_smoke',
                'completed', 'do_nothing', false, $2)
      `,
      [`boardrun_reward_followup_${suffix}`, new Date(eventAt.getTime() + 60_000)]
    );

    const skip = await shouldSkipBoardManagerJobForRecentRun({ job });
    assert.equal(skip.skip, true);
    assert.equal(skip.reason, "recent_board_manager_run_after_trigger");

    await insertProjectTask({
      targetTaskId: duplicateTaskId,
      txHash: `tx_reward_followup_recent_${suffix}`,
      eventAt,
    });
    const recentRunSynced = await syncNetworkTaskProjection({ taskId: duplicateTaskId });
    assert.equal(recentRunSynced.boardManagerFollowup?.queued, false);
    assert.equal(recentRunSynced.boardManagerFollowup?.reason, "recent_board_manager_run_after_reward");

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
