import { contextRewriteWatchdogSnapshot } from "./repositories/context-rewrite.js";
import {
  boolEnv,
  countsFromRows,
  hour,
  intEnv,
  iso,
  item,
  minute,
  oldestAgeMs,
  optionalQuery,
  runFreshness,
} from "./system-status-base.js";
import {
  recentFailureStatus,
  recentFailureWindowMs,
} from "./system-status-readers.js";

export async function hiveBoardSecretaryMemoItem(tables, nowMs) {
  const cadenceSeconds = intEnv(process.env.TASKNODE_HIVE_BOARD_SECRETARY_CADENCE_SECONDS, 900, { min: 60, max: 86400 });
  const enabled = process.env.TASKNODE_HIVE_BOARD_SECRETARY_ENABLED !== "false";
  const [memoResult, countsResult, projectResult, failedResult] = await Promise.all([
    optionalQuery(
      tables,
      ["hive_board_secretary_memos"],
      `SELECT id, project_id, status, model, error, generated_at, created_at
         FROM hive_board_secretary_memos
        WHERE status = 'current'
          AND superseded_at IS NULL
        ORDER BY generated_at DESC, id DESC
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      ["hive_board_secretary_memos"],
      `SELECT status, count(*)::int AS count
         FROM hive_board_secretary_memos
        GROUP BY status`
    ),
    optionalQuery(
      tables,
      ["network_projects"],
      `SELECT count(*)::int AS count
         FROM network_projects
        WHERE status = 'active'`
    ),
    optionalQuery(
      tables,
      ["hive_board_secretary_memos"],
      `SELECT count(failed.*)::int AS count,
              max(failed.created_at) AS latest_failed_at
         FROM hive_board_secretary_memos failed
         LEFT JOIN hive_board_secretary_memos current
           ON current.project_id = failed.project_id
          AND current.status = 'current'
          AND current.superseded_at IS NULL
        WHERE failed.status = 'failed'
          AND failed.created_at > now() - ($1 * interval '1 millisecond')
          AND (
            current.generated_at IS NULL OR
            failed.created_at > current.generated_at
          )`,
      [recentFailureWindowMs]
    ),
  ]);
  const memo = memoResult.rows[0] || null;
  const activeProjects = Number(projectResult.rows[0]?.count || 0);
  const recentFailed = Number(failedResult.rows[0]?.count || 0);
  let status = runFreshness({
    enabled,
    lastSuccessAt: memo?.generated_at || null,
    warningAfterMs: cadenceSeconds * 1000 + 5 * minute,
    staleAfterMs: cadenceSeconds * 2000 + 5 * minute,
    nowMs,
    missingStatus: activeProjects > 0 ? "critical" : "unknown",
  });
  status = recentFailureStatus(status, recentFailed, "Recent failed memos");
  return item({
    id: "hive_board_secretary",
    category: "hive",
    title: "GLM Board Secretary",
    description: "Per-board GLM 5.3 Project Status memo writer. Advisory only; no task, message, reward, or board mutations.",
    owner: "board-secretary process",
    trigger: "periodic project status memo refresh",
    cadence: `${cadenceSeconds}s`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: memo?.generated_at || memo?.created_at,
    lastSuccessAt: memo?.generated_at || null,
    staleAfterMs: cadenceSeconds * 2000 + 5 * minute,
    counts: {
      ...countsFromRows(countsResult.rows),
      activeProjects,
    },
    lastError: memo?.error || "",
    details: [
      `model=${process.env.TASKNODE_HIVE_BOARD_SECRETARY_MODEL || "zai/glm-5.3"}`,
      memo?.id && `latestMemo=${memo.id}`,
      memo?.project_id && `latestProject=${memo.project_id}`,
      memo?.model && `latestModel=${memo.model}`,
      failedResult.rows[0]?.latest_failed_at && `latestUnresolvedFailure=${iso(failedResult.rows[0].latest_failed_at)}`,
    ],
  });
}

export async function contextRewriteItem(tables) {
  if (tables.get("context_rewrite_jobs") !== true) {
    return item({
      id: "context_rewrite",
      category: "task_engine",
      title: "Context Rewrite Worker",
      description: "Billed multi-call context rewrite pipeline with provider-call audit and stale-job recovery.",
      owner: "worker process",
      trigger: "Context Rewrite chat tool",
      cadence: `${intEnv(process.env.CONTEXT_REWRITE_WORKER_INTERVAL_MS, 15000, { min: 2000 })}ms`,
      status: "disabled",
      statusLabel: "Table missing",
    });
  }
  const snapshot = await contextRewriteWatchdogSnapshot({ limit: 5 }).catch((error) => ({
    ok: false,
    counts: {},
    providerCallCounts: {},
    staleJobs: [],
    staleCount: 0,
    runningProviderCallCount: 0,
    timedOutProviderCallCount: 0,
    error: error?.message || "context_rewrite_status_failed",
  }));
  const counts = snapshot.counts || {};
  const providerCounts = snapshot.providerCallCounts || {};
  const staleCount = Number(snapshot.staleCount || 0);
  const runningCount = Number(counts.running || 0);
  const failedCount = Number(counts.failed || 0);
  const timedOutProviderCallCount = Number(snapshot.timedOutProviderCallCount || providerCounts.timed_out || 0);
  const status = staleCount > 0 || timedOutProviderCallCount > 0
    ? { status: "critical", label: "Stalled jobs" }
    : failedCount > 0
      ? { status: "warning", label: "Failures present" }
      : runningCount > 0
        ? { status: "ok", label: "Running" }
        : { status: "ok", label: "Ready" };
  return item({
    id: "context_rewrite",
    category: "task_engine",
    title: "Context Rewrite Worker",
    description: "Billed multi-call context rewrite pipeline with provider-call audit and stale-job recovery.",
    owner: "worker process",
    trigger: "Context Rewrite chat tool",
    cadence: `${intEnv(process.env.CONTEXT_REWRITE_WORKER_INTERVAL_MS, 15000, { min: 2000 })}ms`,
    status: snapshot.ok === false ? "unknown" : status.status,
    statusLabel: snapshot.ok === false ? "Status query failed" : status.label,
    staleAfterMs: snapshot.staleAfterMs || null,
    counts: {
      ...counts,
      stale: staleCount,
      provider_running: Number(providerCounts.running || 0),
      provider_timed_out: timedOutProviderCallCount,
      provider_orphaned: Number(providerCounts.orphaned || 0),
    },
    lastError: snapshot.error || "",
    details: [
      `providerCalls=${JSON.stringify(providerCounts)}`,
      ...((snapshot.staleJobs || []).slice(0, 3).map((job) => `stale=${job.id} stage=${job.currentStage} retry=${job.retryCount}`)),
    ],
  });
}

export async function boardManagerSecretaryPacketItem(tables, _nowMs) {
  const result = await optionalQuery(
    tables,
    ["board_manager_secretary_packets"],
    `SELECT id, status, packet_type, provider, model, created_at, superseded_at, error
       FROM board_manager_secretary_packets
      WHERE scope = 'global_hive'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`
  );
  const counts = await optionalQuery(
    tables,
    ["board_manager_secretary_packets"],
    `SELECT status, count(*)::int AS count
       FROM board_manager_secretary_packets
      WHERE scope = 'global_hive'
      GROUP BY status`
  );
  const row = result.rows[0] || null;
  return item({
    id: "board_manager_secretary_packets",
    category: "hive",
    title: "Board Manager Secretary Packet",
    description: "Archived DeepSeek compression packets retained for historical audit.",
    owner: "board-manager process",
    trigger: "archived telemetry only",
    cadence: "archived",
    status: "ok",
    statusLabel: "Archived",
    lastRunAt: row?.created_at,
    lastSuccessAt: row?.status === "failed" ? null : row?.created_at,
    staleAfterMs: 6 * hour,
    counts: countsFromRows(counts.rows),
    lastError: row?.error || "",
    details: [
      row?.id && `packet=${row.id}`,
      row?.packet_type && `type=${row.packet_type}`,
      row?.provider && `provider=${row.provider}`,
      row?.model && `model=${row.model}`,
    ],
  });
}

export async function hiveQueueItem({
  tables,
  id,
  title,
  description,
  owner,
  enabled = true,
  jobTable,
  resultTable,
  resultTimeColumn,
  resultIdColumn = "id",
  trigger,
  cadence,
  staleQueueMs = 15 * minute,
  staleResultMs = null,
  nowMs,
}) {
  const [latest, counts, oldestDue] = await Promise.all([
    optionalQuery(
      tables,
      [resultTable],
      `SELECT ${resultIdColumn} AS id, status, ${resultTimeColumn} AS completed_at, created_at
         FROM ${resultTable}
        WHERE status = 'completed'
        ORDER BY ${resultTimeColumn} DESC NULLS LAST, created_at DESC, ${resultIdColumn} DESC
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      [jobTable],
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed
         FROM ${jobTable}
        GROUP BY status`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      [jobTable],
      `SELECT min(COALESCE(next_attempt_at, updated_at, created_at)) AS oldest_due
         FROM ${jobTable}
        WHERE status IN ('pending', 'processing')
          AND COALESCE(next_attempt_at, updated_at, created_at) <= now()`
    ),
  ]);
  const row = latest.rows[0] || null;
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({
    enabled,
    lastSuccessAt: row?.completed_at,
    warningAfterMs: staleResultMs ? staleResultMs / 2 : null,
    staleAfterMs: staleResultMs,
    nowMs,
  });
  const recentFailed = counts.rows.reduce((sum, row) => sum + Number(row.recent_failed || 0), 0);
  status = recentFailureStatus(status, recentFailed, "Recent failed jobs");
  const oldest = iso(oldestDue.rows[0]?.oldest_due);
  if (oldest && oldestAgeMs(oldest, nowMs) > staleQueueMs) status = { status: "critical", label: "Queue stale" };
  return item({
    id,
    category: "hive",
    title,
    description,
    owner,
    trigger,
    cadence,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.created_at,
    lastSuccessAt: row?.completed_at,
    staleAfterMs: staleResultMs,
    counts: queueCounts,
    details: [
      row?.id && `latest=${row.id}`,
      oldest && `oldestDue=${oldest}`,
    ],
  });
}

export async function taskGenerationItem(tables, nowMs) {
  const [summary, counts] = await Promise.all([
    optionalQuery(
      tables,
      ["task_requests"],
      `SELECT max(worker_completed_at) AS last_completed_at,
              max(updated_at) AS last_seen_at,
              min(updated_at) FILTER (WHERE status IN ('published','queued','generating')) AS oldest_pending_at,
              count(*) FILTER (
                WHERE status IN ('failed', 'failed_permanent', 'retry_wait')
                  AND updated_at > now() - ($1 * interval '1 millisecond')
              )::int AS recent_failed,
              max(last_error) FILTER (WHERE status = 'failed' AND last_error <> '') AS last_error
         FROM task_requests`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["task_requests"],
      `SELECT status, count(*)::int AS count
         FROM task_requests
        GROUP BY status`
    ),
  ]);
  const row = summary.rows[0] || {};
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({
    enabled: boolEnv(process.env.TASKNODE_TASK_GENERATION_WORKER_ENABLED),
    lastSuccessAt: row.last_completed_at,
    warningAfterMs: null,
    staleAfterMs: null,
    nowMs,
  });
  status = recentFailureStatus(status, row.recent_failed, "Recent failed requests");
  const oldest = iso(row.oldest_pending_at);
  if (oldest && oldestAgeMs(oldest, nowMs) > 10 * minute) status = { status: "critical", label: "Generation queue stale" };
  return item({
    id: "task_generation",
    category: "task_engine",
    title: "Task Generation Worker",
    description: "Turns signed task request rows into PFTL task offers.",
    owner: "worker process",
    trigger: "task request queue",
    cadence: `${intEnv(process.env.TASKNODE_TASK_GENERATION_WORKER_INTERVAL_MS, 5000, { min: 1000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row.last_completed_at || row.last_seen_at,
    lastSuccessAt: row.last_completed_at,
    counts: queueCounts,
    lastError: row.last_error || "",
    details: [oldest && `oldestPending=${oldest}`],
  });
}

export async function networkTaskGenerationItem(tables, nowMs) {
  const [summary, counts] = await Promise.all([
    optionalQuery(
      tables,
      ["network_task_generation_jobs"],
      `SELECT max(updated_at) FILTER (WHERE status IN ('generated','published')) AS last_completed_at,
              max(updated_at) AS last_seen_at,
              min(COALESCE(next_attempt_at, updated_at, created_at)) FILTER (WHERE status IN ('queued','running')) AS oldest_pending_at,
              count(*) FILTER (WHERE status IN ('failed','link_failed') AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed,
              max(last_error) FILTER (WHERE status IN ('failed','link_failed') AND last_error <> '') AS last_error
         FROM network_task_generation_jobs`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["network_task_generation_jobs"],
      `SELECT status, count(*)::int AS count
         FROM network_task_generation_jobs
        GROUP BY status`
    ),
  ]);
  const row = summary.rows[0] || {};
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({
    enabled: boolEnv(process.env.TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED),
    lastSuccessAt: row.last_completed_at,
    nowMs,
  });
  status = recentFailureStatus(status, row.recent_failed, "Recent failed jobs");
  const oldest = iso(row.oldest_pending_at);
  if (oldest && oldestAgeMs(oldest, nowMs) > 10 * minute) status = { status: "critical", label: "Network generation stale" };
  return item({
    id: "network_task_generation",
    category: "task_engine",
    title: "Network Task Generation Worker",
    description: "Turns network task allocations into normal task request bundles.",
    owner: "worker process",
    trigger: "network_task_generation_jobs",
    cadence: `${intEnv(process.env.TASKNODE_NETWORK_TASK_GENERATION_WORKER_INTERVAL_MS, 15000, { min: 1000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row.last_completed_at || row.last_seen_at,
    lastSuccessAt: row.last_completed_at,
    counts: queueCounts,
    lastError: row.last_error || "",
    details: [oldest && `oldestPending=${oldest}`],
  });
}

export async function taskReviewItem(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["task_projections", "task_review_publications", "task_events"],
    `WITH actionable AS (
       SELECT p.*
       FROM task_projections p
       WHERE (
           p.status = 'submitted'
           AND NOT EXISTS (
             SELECT 1
             FROM task_review_publications pub
             WHERE pub.task_id = p.task_id
               AND pub.worker_name = 'verification_request'
               AND pub.status = 'published'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM task_events existing
             WHERE existing.task_id = p.task_id
               AND existing.event_type = 'pf.task.update.v1'
               AND (
                 existing.payload_json->>'transition' = 'verification_requested'
                 OR existing.payload_json->>'status_after' = 'verification_requested'
                 OR existing.payload_json->>'status' = 'verification_requested'
               )
           )
         )
         OR (
           p.status = 'verification_response_submitted'
           AND NOT EXISTS (
             SELECT 1
             FROM task_review_publications pub
             WHERE pub.task_id = p.task_id
               AND pub.worker_name = 'reward_scoring'
               AND pub.status = 'published'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM task_events existing
             WHERE existing.task_id = p.task_id
               AND existing.event_type IN ('pf.reward.v1', 'pf.task.reward_decision.v1')
           )
         )
     )
     SELECT count(*) FILTER (WHERE actionable.status = 'submitted')::int AS submitted,
            count(*) FILTER (WHERE actionable.status = 'verification_response_submitted')::int AS verification_response_submitted,
            count(*) FILTER (
              WHERE actionable.metadata_json->'workers'->'verification_request'->>'last_error'
                = 'awaiting_agent_verification_request'
            )::int AS awaiting_agent_verification_request,
            count(*) FILTER (
              WHERE actionable.metadata_json->'workers'->'reward_scoring'->>'last_error'
                = 'awaiting_agent_review_decision'
            )::int AS awaiting_agent_review_decision,
            count(*) FILTER (
              WHERE COALESCE(
                NULLIF(
                  CASE actionable.status
                    WHEN 'submitted' THEN actionable.metadata_json->'workers'->'verification_request'->>'retry_after'
                    ELSE actionable.metadata_json->'workers'->'reward_scoring'->>'retry_after'
                  END,
                  ''
                )::timestamptz,
                '-infinity'::timestamptz
              ) > now()
            )::int AS retry_backoff,
            count(*) FILTER (
              WHERE actionable.metadata_json->'reward_payment_guard'->>'status' = 'submit_unknown'
            )::int AS reward_submit_unknown,
            count(*) FILTER (
              WHERE EXISTS (
                SELECT 1
                FROM task_review_publications stalled
                WHERE stalled.task_id = actionable.task_id
                  AND stalled.status IN ('reserved', 'error')
              )
            )::int AS publication_stalled,
            CASE
              WHEN count(*) FILTER (
                WHERE actionable.metadata_json->'reward_payment_guard'->>'status' = 'submit_unknown'
              ) > 0 THEN 'task_reward_submit_unknown'
              WHEN count(*) FILTER (
                WHERE EXISTS (
                  SELECT 1
                  FROM task_review_publications stalled
                  WHERE stalled.task_id = actionable.task_id
                    AND stalled.status IN ('reserved', 'error')
                )
              ) > 0 THEN 'task_review_publication_stalled'
              WHEN count(*) FILTER (
                WHERE actionable.metadata_json->'workers'->'verification_request'->>'last_error'
                  = 'awaiting_agent_verification_request'
              ) > 0 THEN 'awaiting_agent_verification_request'
              WHEN count(*) FILTER (
                WHERE actionable.metadata_json->'workers'->'reward_scoring'->>'last_error'
                  = 'awaiting_agent_review_decision'
              ) > 0 THEN 'awaiting_agent_review_decision'
              WHEN count(*) FILTER (
                WHERE COALESCE(
                  actionable.metadata_json->'workers'->'verification_request'->>'last_error',
                  actionable.metadata_json->'workers'->'reward_scoring'->>'last_error',
                  ''
                ) <> ''
              ) > 0 THEN 'task_review_retrying'
              ELSE ''
            END AS last_error_code,
            max(p.updated_at) FILTER (
              WHERE p.status IN ('verification_requested','reward_decided','rewarded')
            ) AS last_completed_at,
            max(p.updated_at) AS last_seen_at,
            min(COALESCE(actionable.last_event_at, actionable.created_at)) AS oldest_pending_at
       FROM task_projections p
       LEFT JOIN actionable ON actionable.task_id = p.task_id`
  );
  const row = result.rows[0] || {};
  const counts = {
    submitted: Number(row.submitted || 0),
    verification_response_submitted: Number(row.verification_response_submitted || 0),
    awaiting_agent_verification_request: Number(row.awaiting_agent_verification_request || 0),
    awaiting_agent_review_decision: Number(row.awaiting_agent_review_decision || 0),
    retry_backoff: Number(row.retry_backoff || 0),
    reward_submit_unknown: Number(row.reward_submit_unknown || 0),
    publication_stalled: Number(row.publication_stalled || 0),
  };
  let status = runFreshness({
    enabled: boolEnv(process.env.TASKNODE_TASK_REVIEW_WORKER_ENABLED),
    lastSuccessAt: row.last_completed_at,
    nowMs,
  });
  const oldest = iso(row.oldest_pending_at);
  if (oldest && oldestAgeMs(oldest, nowMs) > 15 * minute) status = { status: "critical", label: "Review queue stale" };
  return item({
    id: "task_review",
    category: "task_engine",
    title: "Task Review And Reward Worker",
    description: "Publishes verification requests and terminal reward outcomes.",
    owner: "worker process",
    trigger: "submitted task projections",
    cadence: `${intEnv(process.env.TASKNODE_TASK_REVIEW_WORKER_INTERVAL_MS, 20000, { min: 1000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row.last_completed_at || row.last_seen_at,
    lastSuccessAt: row.last_completed_at,
    counts,
    lastError: row.last_error_code || "",
    details: [
      oldest && `oldestPending=${oldest}`,
      counts.awaiting_agent_verification_request > 0
        && `awaitingAgentVerificationRequest=${counts.awaiting_agent_verification_request}`,
      counts.awaiting_agent_review_decision > 0
        && `awaitingAgentReviewDecision=${counts.awaiting_agent_review_decision}`,
      counts.retry_backoff > 0 && `retryBackoff=${counts.retry_backoff}`,
      counts.reward_submit_unknown > 0 && `rewardSubmitUnknown=${counts.reward_submit_unknown}`,
      counts.publication_stalled > 0 && `publicationStalled=${counts.publication_stalled}`,
    ],
  });
}
