#!/usr/bin/env node

import assert from "node:assert/strict";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}
process.env.TASKNODE_TASK_ACCOUNTING_HARVESTER_PROVIDER_MOCK = "true";
process.env.TASKNODE_TASK_ACCOUNTING_HARVESTER_BATCH_LIMIT = "10";

const { closePool, databaseEnabled, query } = await import("../server/db/pool.js");
const { migrateDatabase } = await import("../server/db/migrate.js");
const { runTaskAccountingHarvesterOnce } = await import("../server/task-accounting-harvester-worker.js");
const {
  listTaskAccountingHarvests,
  resolveTaskAccountingHarvest,
} = await import("../server/repositories/task-accounting-harvester.js");

const suffix = `${Date.now()}`;
const actionableTaskId = `task_accounting_action_${suffix}`;
const noActionTaskId = `task_accounting_done_${suffix}`;
const accountId = `acct_task_accounting_${suffix}`;
const wallet = `rTaskAccounting${suffix}`.slice(0, 120);

async function cleanup() {
  await query("DELETE FROM task_accounting_harvests WHERE task_id IN ($1, $2)", [actionableTaskId, noActionTaskId]);
  await query("DELETE FROM task_events WHERE task_id IN ($1, $2)", [actionableTaskId, noActionTaskId]);
  await query("DELETE FROM task_projections WHERE task_id IN ($1, $2)", [actionableTaskId, noActionTaskId]);
}

async function insertRewardedTask({ taskId, title, description, requirement, reward }) {
  const occurredAt = taskId === actionableTaskId
    ? new Date("2000-01-01T00:00:00.000Z")
    : new Date("2000-01-02T00:00:00.000Z");
  await query(
    `
      INSERT INTO task_projections (
        task_id, account_id, subject_wallet, request_id, status, title, description,
        task_kind, reward_offer_pft, reward_actual_pft, submission_requirement_text,
        event_count, last_event_tx_hash, last_event_cid, last_event_at, source, updated_at
      )
      VALUES (
        $1, $2, $3, $4, 'rewarded', $5, $6, 'Network', $7, $7, $8,
        1, $9, $10, $11, 'task_accounting_harvester_smoke', $11
      )
    `,
    [
      taskId,
      accountId,
      wallet,
      `req_${taskId}`,
      title,
      description,
      reward,
      requirement,
      `tx_${taskId}`,
      `cid_${taskId}`,
      occurredAt,
    ]
  );
  await query(
    `
      INSERT INTO task_events (
        id, task_id, account_id, wallet_address, event_type,
        source_tx_hash, source_cid, payload_json, occurred_at, created_at
      )
      VALUES ($1, $2, $3, $4, 'pf.reward.v1', $5, $6, $7::jsonb, $8, $8)
    `,
    [
      `evt_${taskId}`,
      taskId,
      accountId,
      wallet,
      `tx_${taskId}`,
      `cid_${taskId}`,
      JSON.stringify({ schema: "pf.reward.v1", task_id: taskId, reward_pft: reward }),
      occurredAt,
    ]
  );
}

async function main() {
  if (!databaseEnabled()) {
    console.log("task-accounting-harvester-smoke skipped: database not configured");
    return;
  }
  await migrateDatabase();
  await cleanup();
  try {
    await insertRewardedTask({
      taskId: actionableTaskId,
      title: "Reward routing bug report",
      description: "The task identified a bug where reward accounting totals could display stale values after payment.",
      requirement: "Submit the reproduction details and recommended owner for follow-up.",
      reward: 30000,
    });
    await insertRewardedTask({
      taskId: noActionTaskId,
      title: "Standalone contributor profile completion",
      description: "The task output was a self-contained profile packet and the reward closed the work.",
      requirement: "Submit the finished packet.",
      reward: 100,
    });

    const run = await runTaskAccountingHarvesterOnce();
    assert.equal(run.ok, true, JSON.stringify(run.errors || []));
    assert.ok(run.queued >= 2, "rewarded Network tasks were queued");
    assert.equal(run.processed.length, 2, "two harvest rows processed");

    const listed = await listTaskAccountingHarvests({ limit: 20 });
    const rows = listed.harvests.filter((row) => [actionableTaskId, noActionTaskId].includes(row.taskId));
    assert.equal(rows.length, 2, "both harvest rows are listable");
    const actionable = rows.find((row) => row.taskId === actionableTaskId);
    const noAction = rows.find((row) => row.taskId === noActionTaskId);
    assert.equal(actionable.classification, "requires_action");
    assert.equal(actionable.requiresAction, true);
    assert.ok(actionable.suggestedAction, "actionable row stores suggested action");
    assert.equal(noAction.classification, "no_action");
    assert.equal(noAction.requiresAction, false);
    assert.equal(listed.summary.harvested >= 2, true, "summary includes harvested count");

    const resolutionNote = "Closed by smoke test after filing TASKNODE-SMOKE-1.";
    const resolved = await resolveTaskAccountingHarvest({
      taskId: actionableTaskId,
      resolvedByAccountId: accountId,
      note: resolutionNote,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.harvest.resolved, true);
    assert.equal(resolved.harvest.resolutionNote, resolutionNote);

    const unresolvedList = await listTaskAccountingHarvests({ limit: 20 });
    assert.equal(
      unresolvedList.harvests.some((row) => row.taskId === actionableTaskId),
      false,
      "default harvest list hides resolved rows"
    );
    const resolvedList = await listTaskAccountingHarvests({ resolved: "true", limit: 20 });
    const resolvedRow = resolvedList.harvests.find((row) => row.taskId === actionableTaskId);
    assert.ok(resolvedRow, "resolved=true lists resolved rows");
    assert.equal(resolvedRow.resolutionNote, resolutionNote);

    console.log("task-accounting-harvester-smoke ok");
  } finally {
    await cleanup();
    await closePool();
  }
}

main().catch(async (error) => {
  await closePool().catch(() => null);
  console.error(error);
  process.exitCode = 1;
});
