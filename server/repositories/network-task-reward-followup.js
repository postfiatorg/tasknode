import { query } from "../db/pool.js";
import {
  enqueueBoardManagerJob,
  findCompletedBoardManagerRunSince,
} from "./board-manager-scheduler.js";
import { safeText } from "./network-tasks-utils.js";

const networkTaskRewardFollowupDelayMs = 2 * 60 * 1000;

function dateOrNow(value = null) {
  if (!value) return new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

export async function enqueueNetworkTaskRewardFollowup({
  taskId = "",
  projectIds = [],
  projection = {},
  rewardPft = 0,
} = {}) {
  const normalizedTaskId = safeText(taskId, 180);
  const activeProjectIds = Array.from(new Set(projectIds.map((id) => safeText(id, 180)).filter(Boolean)));
  if (!normalizedTaskId || activeProjectIds.length === 0) {
    return { ok: true, queued: false, skipped: true, reason: "not_project_linked" };
  }

  const stateChangedAt = dateOrNow(projection.last_event_at || projection.updated_at);
  const stateChangedIso = stateChangedAt.toISOString();
  const recentRun = await findCompletedBoardManagerRunSince({
    scope: "global_hive",
    since: stateChangedIso,
  }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
  if (recentRun?.run) {
    return {
      ok: true,
      queued: false,
      skipped: true,
      reason: "recent_board_manager_run_after_reward",
      recentRunId: recentRun.run.id,
    };
  }

  const lastEventTxHash = safeText(projection.last_event_tx_hash, 180);
  const idempotencyKey = [
    "network_task_rewarded_followup",
    normalizedTaskId,
    lastEventTxHash || safeText(projection.last_event_cid, 180) || stateChangedIso,
  ].join(":");
  const existing = await query(
    `
      SELECT id, status, run_after, completed_at
      FROM board_manager_jobs
      WHERE scope = 'global_hive'
        AND idempotency_key = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    return {
      ok: true,
      queued: false,
      skipped: true,
      reason: "reward_followup_already_recorded",
      job: existing.rows[0],
    };
  }

  const runAfter = new Date(stateChangedAt.getTime() + networkTaskRewardFollowupDelayMs);
  return enqueueBoardManagerJob({
    scope: "global_hive",
    trigger: "network_task_rewarded_followup",
    reason: `Review Hive board after Network Task ${normalizedTaskId} reached rewarded state.`,
    idempotencyKey,
    runAfter,
    maxAttempts: 3,
    metadata: {
      source: "sync_network_task_projection",
      task_id: normalizedTaskId,
      project_ids: activeProjectIds,
      reward_pft: rewardPft,
      state_changed_at: stateChangedIso,
      skip_if_completed_after: stateChangedIso,
      last_event_tx_hash: lastEventTxHash,
      last_event_cid: safeText(projection.last_event_cid, 180),
      delay_seconds: Math.round(networkTaskRewardFollowupDelayMs / 1000),
    },
  });
}

export function rewardFollowupDelayMs() {
  return networkTaskRewardFollowupDelayMs;
}
