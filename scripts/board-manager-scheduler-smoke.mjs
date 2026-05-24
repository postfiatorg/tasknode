import assert from "node:assert/strict";
import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  claimBoardManagerJob,
  completeBoardManagerJob,
  deferOrFailBoardManagerJob,
  enqueueBoardManagerJob,
  enqueueDueBoardManagerTicks,
  ensureBoardManagerScope,
  listBoardManagerSchedulerStatus,
  recoverStaleBoardManagerJobs,
  setBoardManagerScopeStatus,
} from "../server/repositories/board-manager-scheduler.js";
import { shouldStartBackgroundWorkers, shouldStartHttpServer, tasknodeProcessRole } from "../server/process-role.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

assert.equal(tasknodeProcessRole({}), "all");
assert.equal(tasknodeProcessRole({ TASKNODE_PROCESS_ROLE: "web" }), "web");
assert.equal(shouldStartHttpServer("web"), true);
assert.equal(shouldStartBackgroundWorkers("web"), false);
assert.equal(shouldStartHttpServer("worker"), false);
assert.equal(shouldStartBackgroundWorkers("worker"), true);
assert.equal(shouldStartHttpServer("all"), true);
assert.equal(shouldStartBackgroundWorkers("all"), true);

const suffix = `${Date.now()}`;
const scope = `board_scheduler_smoke_${suffix}`;
const idempotencyKey = `board_scheduler_idem_${suffix}`;

async function cleanup() {
  await query("DELETE FROM board_manager_jobs WHERE scope = $1", [scope]);
  await query("DELETE FROM board_manager_leases WHERE scope = $1", [scope]);
  await query("DELETE FROM board_manager_scopes WHERE scope = $1", [scope]);
}

async function main() {
  if (!databaseEnabled()) {
    console.log("board manager scheduler smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  try {
    const ensured = await ensureBoardManagerScope({
      scope,
      cadenceSeconds: 60,
      maxActionsPerHour: 2,
      nextRunAt: new Date(Date.now() - 1000),
    });
    assert.equal(ensured.scope.scope, scope);
    assert.equal(ensured.scope.status, "enabled");

    const tick = await enqueueDueBoardManagerTicks({ scope, limit: 10 });
    assert.equal(tick.enqueued, 1);

    const first = await enqueueBoardManagerJob({
      scope,
      trigger: "manual_smoke",
      reason: "Verify idempotent enqueue.",
      idempotencyKey,
    });
    assert.equal(first.queued, true);
    const duplicate = await enqueueBoardManagerJob({
      scope,
      trigger: "manual_smoke",
      reason: "Duplicate should not create another active job.",
      idempotencyKey,
    });
    assert.equal(duplicate.queued, false);
    assert.equal(duplicate.job.id, first.job.id);

    const claimed = await claimBoardManagerJob({ scope, managerId: "worker_a" });
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.job.status, "running");
    const claimedAgain = await claimBoardManagerJob({ scope, managerId: "worker_b" });
    assert.equal(claimedAgain.claimed, true);
    assert.notEqual(claimedAgain.job.id, claimed.job.id);
    const noThirdJob = await claimBoardManagerJob({ scope, managerId: "worker_c" });
    assert.equal(noThirdJob.claimed, false);

    const completed = await completeBoardManagerJob({
      jobId: claimed.job.id,
      runId: "boardrun_scheduler_smoke",
      result: { action: "do_nothing" },
    });
    assert.equal(completed.job.status, "completed");

    const deferred = await deferOrFailBoardManagerJob({
      jobId: claimedAgain.job.id,
      error: "smoke_retry",
      retryDelaySeconds: 5,
    });
    assert.equal(deferred.job.status, "deferred");

    const paused = await setBoardManagerScopeStatus({ scope, status: "paused", reason: "smoke" });
    assert.equal(paused.scope.status, "paused");

    const status = await listBoardManagerSchedulerStatus({ scope });
    assert.equal(status.scope.scope, scope);
    assert.ok(status.jobs.length >= 2);

    await ensureBoardManagerScope({
      scope,
      status: "enabled",
      maxActionsPerHour: 1,
    });
    await query(
      `INSERT INTO board_manager_runs (
         id, scope, status, selected_action, dry_run, completed_at
       )
       VALUES ($1, $2, 'completed', 'daily_airdrop', false, now())`,
      [`boardrun_scheduler_daily_airdrop_${suffix}`, scope]
    );
    await enqueueBoardManagerJob({
      scope,
      trigger: "rate_limit_exclusion_smoke",
      reason: "Verify internal daily airdrop audit cards do not consume Board Manager action budget.",
      idempotencyKey: `board_scheduler_rate_limit_exclusion_${suffix}`,
    });
    const excluded = await claimBoardManagerJob({ scope, managerId: "worker_daily_airdrop_excluded" });
    assert.equal(excluded.claimed, true);
    const excludedCompleted = await completeBoardManagerJob({
      jobId: excluded.job.id,
      runId: "boardrun_scheduler_daily_airdrop_excluded_claim",
      result: { action: "do_nothing" },
    });
    assert.equal(excludedCompleted.job.status, "completed");

    await enqueueBoardManagerJob({
      scope,
      trigger: "stale_recovery_smoke",
      reason: "Verify stale running jobs are returned to the queue.",
      idempotencyKey: `board_scheduler_stale_recovery_${suffix}`,
    });
    const staleClaim = await claimBoardManagerJob({ scope, managerId: "worker_stale_recovery" });
    assert.equal(staleClaim.claimed, true);
    await query(
      `UPDATE board_manager_jobs
       SET claimed_at = now() - interval '120 seconds',
           updated_at = now() - interval '120 seconds'
       WHERE id = $1`,
      [staleClaim.job.id]
    );
    const recovered = await recoverStaleBoardManagerJobs({ scope, staleSeconds: 60 });
    assert.equal(recovered.recovered, 1);
    assert.equal(recovered.jobs[0].status, "deferred");

    await ensureBoardManagerScope({
      scope,
      status: "enabled",
      maxActionsPerHour: 0,
    });
    await enqueueBoardManagerJob({
      scope,
      trigger: "rate_limit_smoke",
      reason: "Verify action cap blocks job claiming.",
      idempotencyKey: `board_scheduler_rate_limit_${suffix}`,
    });
    const capped = await claimBoardManagerJob({ scope, managerId: "worker_rate_limited" });
    assert.equal(capped.claimed, false);
    assert.equal(capped.reason, "action_rate_limited");

    console.log("board manager scheduler smoke ok");
  } finally {
    await cleanup();
  }
}

try {
  await main();
} finally {
  await closePool();
}
