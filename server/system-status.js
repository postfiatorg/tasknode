import { databaseEnabled, databaseStatus } from "./db/pool.js";
import {
  boolEnv,
  countValue,
  countsFromRows,
  day,
  endpointList,
  hour,
  intEnv,
  iso,
  item,
  mergeStatus,
  minute,
  oldestAgeMs,
  optionalQuery,
  runFreshness,
  summarizeCategories,
  tableMap,
} from "./system-status-base.js";

async function boardManagerItem(tables, nowMs) {
  const cadenceFallback = intEnv(process.env.TASKNODE_BOARD_MANAGER_CADENCE_SECONDS, 900, { min: 60, max: 86400 });
  const [scopeResult, runResult, jobResult, leaseResult] = await Promise.all([
    optionalQuery(
      tables,
      ["board_manager_scopes"],
      `SELECT scope, status, cadence_seconds, max_actions_per_hour, next_run_at, last_enqueued_at,
              last_run_id, metadata_json, updated_at
         FROM board_manager_scopes
        WHERE scope = 'global_hive'
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      ["board_manager_runs"],
      `SELECT id, status, selected_action, trigger, error, started_at, completed_at
         FROM board_manager_runs
        WHERE scope = 'global_hive'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      ["board_manager_jobs"],
      `SELECT status, count(*)::int AS count
         FROM board_manager_jobs
        WHERE scope = 'global_hive'
        GROUP BY status`
    ),
    optionalQuery(
      tables,
      ["board_manager_leases"],
      `SELECT status, manager_id, owner_instance, heartbeat_at, expires_at, updated_at
         FROM board_manager_leases
        WHERE scope = 'global_hive'
        ORDER BY updated_at DESC
        LIMIT 1`
    ),
  ]);
  const scope = scopeResult.rows[0] || null;
  const run = runResult.rows[0] || null;
  const lease = leaseResult.rows[0] || null;
  const counts = countsFromRows(jobResult.rows);
  const cadenceSeconds = Number(scope?.cadence_seconds || cadenceFallback);
  const lastSuccessAt = run?.status === "completed" ? run.completed_at : null;
  const freshness = runFreshness({
    enabled: true,
    lastSuccessAt,
    warningAfterMs: cadenceSeconds * 1000 + 5 * minute,
    staleAfterMs: cadenceSeconds * 2000 + 5 * minute,
    nowMs,
    missingStatus: "critical",
  });
  let status = freshness;
  if (!scope) status = { status: "critical", label: "Scope missing" };
  else if (scope.status !== "enabled") status = { status: "critical", label: scope.status === "paused" ? "Paused" : "Not enabled" };
  if (run?.status === "failed") status = { status: "critical", label: "Last run failed" };
  if (countValue(counts, ["failed"]) > 0) status = mergeStatus(status, { status: "warning", label: "Failed jobs" });
  return item({
    id: "board_manager",
    category: "hive",
    title: "Hive Mind Board Agent",
    description: "Leased Board Manager scheduler for Hive decisions and action hooks.",
    owner: "board-manager process",
    trigger: "periodic tick and post-action follow-up",
    cadence: scope ? `${cadenceSeconds}s` : `${cadenceFallback}s`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: run?.completed_at || run?.started_at || scope?.updated_at,
    lastSuccessAt,
    nextRunAt: scope?.next_run_at,
    staleAfterMs: cadenceSeconds * 2000 + 5 * minute,
    counts,
    lastError: run?.error || "",
    details: [
      scope && `scope=${scope.scope} ${scope.status}`,
      scope && `maxActionsPerHour=${scope.max_actions_per_hour}`,
      scope?.last_run_id && `lastRunId=${scope.last_run_id}`,
      run?.id && `latestRun=${run.id} ${run.status}${run.selected_action ? ` action=${run.selected_action}` : ""}`,
      lease && `lease=${lease.status}${lease.owner_instance ? ` owner=${lease.owner_instance}` : ""}`,
    ],
  });
}

async function boardManagerSecretaryPacketItem(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["board_manager_secretary_packets"],
    `SELECT id, status, packet_type, provider, model, created_at, superseded_at, last_error
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
  const freshness = runFreshness({
    lastSuccessAt: row?.status === "current" ? row.created_at : row?.created_at,
    warningAfterMs: 2 * hour,
    staleAfterMs: 6 * hour,
    nowMs,
  });
  const status = row?.status === "failed" ? { status: "critical", label: "Last packet failed" } : freshness;
  return item({
    id: "board_manager_secretary_packets",
    category: "hive",
    title: "Board Manager Secretary Packet",
    description: "DeepSeek compression packet used before Qwen Board Manager decisions.",
    owner: "board-manager process",
    trigger: "inside Board Manager run",
    cadence: "board-manager dependent",
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.created_at,
    lastSuccessAt: row?.status === "failed" ? null : row?.created_at,
    staleAfterMs: 6 * hour,
    counts: countsFromRows(counts.rows),
    lastError: row?.last_error || "",
    details: [
      row?.id && `packet=${row.id}`,
      row?.packet_type && `type=${row.packet_type}`,
      row?.provider && `provider=${row.provider}`,
      row?.model && `model=${row.model}`,
    ],
  });
}

async function hiveQueueItem({
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
      `SELECT status, count(*)::int AS count
         FROM ${jobTable}
        GROUP BY status`
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
  if (countValue(queueCounts, ["failed"]) > 0) status = { status: "warning", label: "Failed jobs" };
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

async function taskGenerationItem(tables, nowMs) {
  const [summary, counts] = await Promise.all([
    optionalQuery(
      tables,
      ["task_requests"],
      `SELECT max(worker_completed_at) AS last_completed_at,
              max(updated_at) AS last_seen_at,
              min(updated_at) FILTER (WHERE status IN ('published','queued','generating')) AS oldest_pending_at,
              max(last_error) FILTER (WHERE status = 'failed' AND last_error <> '') AS last_error
         FROM task_requests`
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
  if (countValue(queueCounts, ["failed"]) > 0) status = { status: "warning", label: "Failed requests" };
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

async function networkTaskGenerationItem(tables, nowMs) {
  const [summary, counts] = await Promise.all([
    optionalQuery(
      tables,
      ["network_task_generation_jobs"],
      `SELECT max(updated_at) FILTER (WHERE status IN ('generated','published')) AS last_completed_at,
              max(updated_at) AS last_seen_at,
              min(COALESCE(next_attempt_at, updated_at, created_at)) FILTER (WHERE status IN ('queued','running')) AS oldest_pending_at,
              max(last_error) FILTER (WHERE status IN ('failed','link_failed') AND last_error <> '') AS last_error
         FROM network_task_generation_jobs`
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
  if (countValue(queueCounts, ["failed", "link_failed"]) > 0) status = { status: "warning", label: "Failed jobs" };
  const oldest = iso(row.oldest_pending_at);
  if (oldest && oldestAgeMs(oldest, nowMs) > 10 * minute) status = { status: "critical", label: "Network generation stale" };
  return item({
    id: "network_task_generation",
    category: "task_engine",
    title: "Network Task Generation Worker",
    description: "Turns Board Manager allocations into normal task request bundles.",
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

async function taskReviewItem(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["task_projections"],
    `SELECT count(*) FILTER (WHERE status = 'submitted')::int AS submitted,
            count(*) FILTER (WHERE status = 'verification_response_submitted')::int AS verification_response_submitted,
            max(updated_at) FILTER (
              WHERE status IN ('verification_requested','reward_decided','rewarded')
            ) AS last_completed_at,
            max(updated_at) AS last_seen_at,
            min(updated_at) FILTER (
              WHERE status IN ('submitted','verification_response_submitted')
            ) AS oldest_pending_at
       FROM task_projections`
  );
  const row = result.rows[0] || {};
  const counts = {
    submitted: Number(row.submitted || 0),
    verification_response_submitted: Number(row.verification_response_submitted || 0),
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
    description: "Publishes verification requests, reward decisions, and reward payments.",
    owner: "worker process",
    trigger: "submitted task projections",
    cadence: `${intEnv(process.env.TASKNODE_TASK_REVIEW_WORKER_INTERVAL_MS, 20000, { min: 1000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row.last_completed_at || row.last_seen_at,
    lastSuccessAt: row.last_completed_at,
    counts,
    details: [oldest && `oldestPending=${oldest}`],
  });
}

async function pftlSyncItems(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["pftl_sync_wallets"],
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status <> 'active')::int AS inactive,
            count(*) FILTER (WHERE status = 'active' AND last_error IS NOT NULL AND last_error <> '')::int AS error_count,
            count(*) FILTER (
              WHERE status = 'active'
                AND (last_hot_sync_at IS NULL OR last_hot_sync_at < now() - ($1 * interval '1 millisecond'))
            )::int AS hot_stale,
            count(*) FILTER (
              WHERE status = 'active'
                AND COALESCE(archive_marker @> '{"complete": true}'::jsonb, false) = false
                AND (last_archive_sync_at IS NULL OR last_archive_sync_at < now() - ($2 * interval '1 millisecond'))
            )::int AS archive_stale,
            max(last_hot_sync_at) AS last_hot_sync_at,
            max(last_archive_sync_at) AS last_archive_sync_at,
            max(updated_at) AS last_seen_at,
            max(last_error) FILTER (WHERE last_error IS NOT NULL AND last_error <> '') AS last_error
       FROM pftl_sync_wallets`,
    [
      intEnv(process.env.PFTL_CACHE_HOT_STALE_MS, 120000, { min: 10000 }),
      intEnv(process.env.PFTL_CACHE_ARCHIVE_STALE_MS, 900000, { min: 60000 }),
    ]
  );
  const row = result.rows[0] || {};
  const hotStaleMs = intEnv(process.env.PFTL_CACHE_HOT_STALE_MS, 120000, { min: 10000 });
  const archiveStaleMs = intEnv(process.env.PFTL_CACHE_ARCHIVE_STALE_MS, 900000, { min: 60000 });
  const hotFreshness = runFreshness({
    enabled: boolEnv(process.env.PFTL_CACHE_WORKER_ENABLED),
    lastSuccessAt: row.last_hot_sync_at,
    warningAfterMs: hotStaleMs,
    staleAfterMs: hotStaleMs * 3,
    nowMs,
  });
  const archiveFreshness = runFreshness({
    enabled: boolEnv(process.env.PFTL_CACHE_ARCHIVE_WORKER_ENABLED),
    lastSuccessAt: row.last_archive_sync_at,
    warningAfterMs: archiveStaleMs,
    staleAfterMs: archiveStaleMs * 3,
    nowMs,
  });
  const hotStatus = Number(row.hot_stale || 0) > 0 ? mergeStatus(hotFreshness, { status: "warning", label: "Stale wallets" }) : hotFreshness;
  const archiveStatus = Number(row.archive_stale || 0) > 0 ? mergeStatus(archiveFreshness, { status: "warning", label: "Archive lag" }) : archiveFreshness;
  const counts = {
    active: Number(row.active || 0),
    inactive: Number(row.inactive || 0),
    errors: Number(row.error_count || 0),
  };
  return [
    item({
      id: "pftl_hot_sync",
      category: "pftl",
      title: "PFTL Hot Wallet Sync",
      description: "Polls current PFTL account transactions for active wallets.",
      owner: "worker process",
      trigger: "active wallet due list",
      cadence: `${intEnv(process.env.PFTL_CACHE_WORKER_INTERVAL_MS, 60000, { min: 1000 })}ms`,
      status: counts.errors > 0 ? mergeStatus(hotStatus, { status: "warning", label: "Wallet errors" }).status : hotStatus.status,
      statusLabel: counts.errors > 0 ? mergeStatus(hotStatus, { status: "warning", label: "Wallet errors" }).label : hotStatus.label,
      lastRunAt: row.last_hot_sync_at || row.last_seen_at,
      lastSuccessAt: row.last_hot_sync_at,
      staleAfterMs: hotStaleMs * 3,
      counts: { ...counts, hot_stale: Number(row.hot_stale || 0) },
      lastError: row.last_error || "",
    }),
    item({
      id: "pftl_archive_sync",
      category: "pftl",
      title: "PFTL Archive Wallet Sync",
      description: "Backfills historical account_tx pages through the archive-capable PFTL history path.",
      owner: "worker process",
      trigger: "archive-incomplete wallet due list",
      cadence: `${intEnv(process.env.PFTL_CACHE_ARCHIVE_WORKER_INTERVAL_MS, 300000, { min: 1000 })}ms`,
      status: archiveStatus.status,
      statusLabel: archiveStatus.label,
      lastRunAt: row.last_archive_sync_at || row.last_seen_at,
      lastSuccessAt: row.last_archive_sync_at,
      staleAfterMs: archiveStaleMs * 3,
      counts: { ...counts, archive_stale: Number(row.archive_stale || 0) },
      lastError: row.last_error || "",
    }),
  ];
}

async function pftlWatcherItem(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["pftl_cache_watcher_state"],
    `SELECT id, status, subscribed_wallet_count, last_ledger_index, last_event_at, last_error, updated_at
       FROM pftl_cache_watcher_state
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`
  );
  const row = result.rows[0] || null;
  let status = runFreshness({
    enabled: boolEnv(process.env.PFTL_CACHE_WSS_WATCHER_ENABLED),
    lastSuccessAt: row?.updated_at,
    warningAfterMs: 2 * minute,
    staleAfterMs: 5 * minute,
    nowMs,
  });
  if (row?.status && row.status !== "connected") status = { status: "warning", label: row.status };
  if (row?.last_error) status = { status: "critical", label: "Watcher error" };
  return item({
    id: "pftl_wss_watcher",
    category: "pftl",
    title: "PFTL WSS Watcher",
    description: "Subscribes to websocket ledger events and queues reducer work.",
    owner: "worker process",
    trigger: "PFTL websocket subscription",
    cadence: "continuous",
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.updated_at,
    lastSuccessAt: row?.status === "connected" ? row.updated_at : null,
    staleAfterMs: 5 * minute,
    counts: { subscribed_wallets: Number(row?.subscribed_wallet_count || 0) },
    lastError: row?.last_error || "",
    details: [
      row?.last_ledger_index && `lastLedger=${row.last_ledger_index}`,
      row?.last_event_at && `lastEventAt=${iso(row.last_event_at)}`,
    ],
  });
}

async function pftlReducerItem(tables, nowMs) {
  const [summary, counts] = await Promise.all([
    optionalQuery(
      tables,
      ["pftl_cache_reducer_events"],
      `SELECT max(processed_at) FILTER (WHERE status = 'completed') AS last_completed_at,
              max(updated_at) AS last_seen_at,
              min(available_at) FILTER (WHERE status IN ('pending','processing')) AS oldest_pending_at,
              max(last_error) FILTER (WHERE status = 'failed' AND last_error <> '') AS last_error
         FROM pftl_cache_reducer_events`
    ),
    optionalQuery(
      tables,
      ["pftl_cache_reducer_events"],
      `SELECT status, count(*)::int AS count
         FROM pftl_cache_reducer_events
        GROUP BY status`
    ),
  ]);
  const row = summary.rows[0] || {};
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({
    enabled: boolEnv(process.env.PFTL_CACHE_REDUCER_WORKER_ENABLED),
    lastSuccessAt: row.last_completed_at,
    nowMs,
  });
  if (countValue(queueCounts, ["failed"]) > 0) status = { status: "critical", label: "Reducer failures" };
  const oldest = iso(row.oldest_pending_at);
  if (oldest && oldestAgeMs(oldest, nowMs) > 10 * minute) status = { status: "critical", label: "Reducer queue stale" };
  return item({
    id: "pftl_cache_reducer",
    category: "pftl",
    title: "PFTL Cache Reducer",
    description: "Projects cached pointer events into context and task read models.",
    owner: "worker process",
    trigger: "pftl_cache_reducer_events",
    cadence: `${intEnv(process.env.PFTL_CACHE_REDUCER_WORKER_INTERVAL_MS, 10000, { min: 1000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row.last_completed_at || row.last_seen_at,
    lastSuccessAt: row.last_completed_at,
    counts: queueCounts,
    lastError: row.last_error || "",
    details: [oldest && `oldestPending=${oldest}`],
  });
}

async function pftlRetentionItem(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["pftl_cache_maintenance_runs"],
    `SELECT id, run_kind, status, last_error, started_at, completed_at
       FROM pftl_cache_maintenance_runs
      WHERE run_kind IN ('retention','retention_dry_run')
      ORDER BY started_at DESC, id DESC
      LIMIT 1`
  );
  const row = result.rows[0] || null;
  let status = runFreshness({
    enabled: boolEnv(process.env.PFTL_CACHE_RETENTION_WORKER_ENABLED),
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    warningAfterMs: 12 * hour,
    staleAfterMs: 24 * hour,
    nowMs,
  });
  if (row?.status === "failed") status = { status: "critical", label: "Retention failed" };
  return item({
    id: "pftl_cache_retention",
    category: "pftl",
    title: "PFTL Cache Retention",
    description: "Prunes completed reducer events and optional raw transaction rows.",
    owner: "worker process",
    trigger: "interval timer",
    cadence: `${intEnv(process.env.PFTL_CACHE_RETENTION_INTERVAL_MS, 6 * hour, { min: 300000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.started_at,
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    staleAfterMs: 24 * hour,
    lastError: row?.last_error || "",
    details: [row?.id && `run=${row.id}`, row?.run_kind && `kind=${row.run_kind}`],
  });
}

function rpcItems(syncItems = []) {
  const hot = syncItems.find((entry) => entry.id === "pftl_hot_sync") || {};
  const archive = syncItems.find((entry) => entry.id === "pftl_archive_sync") || {};
  const currentEndpoints = [
    ...endpointList(process.env.PFTL_WSS_URL || process.env.VITE_PFTL_WSS_URL),
    ...endpointList(process.env.PFTL_RPC_URL),
    ...endpointList(process.env.PFTL_RPC_URL_FALLBACKS),
  ];
  const historyEndpoints = [
    ...endpointList(process.env.PFTL_HISTORY_WSS_URL),
    ...endpointList(process.env.PFTL_HISTORY_RPC_URL),
    ...endpointList(process.env.PFTL_HISTORY_RPC_URL_FALLBACKS),
  ];
  const ethereumEndpoints = endpointList(process.env.ETH_DEPOSIT_RPC_URL || process.env.VITE_ETH_DEPOSIT_RPC_URL);
  const currentStatus = currentEndpoints.length
    ? { status: hot.status || "unknown", label: hot.statusLabel || "Configured" }
    : { status: "critical", label: "Missing endpoint" };
  const historyStatus = historyEndpoints.length
    ? { status: archive.status || "unknown", label: archive.statusLabel || "Configured" }
    : { status: "critical", label: "Missing endpoint" };
  return [
    item({
      id: "pftl_current_rpc",
      category: "pftl",
      title: "PFTL Current RPC And WSS",
      description: "Hot path for balance reads, transaction submission, and wallet sync polling.",
      owner: "app and worker processes",
      trigger: "request-time and hot sync",
      cadence: "request-time plus hot sync",
      status: currentStatus.status,
      statusLabel: currentStatus.label,
      lastRunAt: hot.lastRunAt || null,
      lastSuccessAt: hot.lastSuccessAt || null,
      details: currentEndpoints.map((endpoint) => `endpoint=${endpoint}`),
    }),
    item({
      id: "pftl_history_rpc",
      category: "pftl",
      title: "PFTL History RPC And Archive WSS",
      description: "Archive-capable path for context history and historical account_tx backfill.",
      owner: "app and worker processes",
      trigger: "context restore and archive sync",
      cadence: "request-time plus archive sync",
      status: historyStatus.status,
      statusLabel: historyStatus.label,
      lastRunAt: archive.lastRunAt || null,
      lastSuccessAt: archive.lastSuccessAt || null,
      details: historyEndpoints.map((endpoint) => `endpoint=${endpoint}`),
    }),
    item({
      id: "ethereum_deposit_rpc",
      category: "pftl",
      title: "Ethereum Deposit RPC",
      description: "Route-triggered top-up sync path, not a background scheduler.",
      owner: "app process",
      trigger: "top-up sync request",
      cadence: "request-time",
      status: ethereumEndpoints.length ? "ok" : "disabled",
      statusLabel: ethereumEndpoints.length ? "Configured" : "Not configured",
      details: ethereumEndpoints.map((endpoint) => `endpoint=${endpoint}`),
    }),
  ];
}

async function memoryQueueItem({
  tables,
  id,
  title,
  description,
  jobTable,
  entryKind = "",
  resultTable = "chat_memory_entries",
  owner = "worker process",
  enabled = true,
  trigger,
  cadence,
  nowMs,
}) {
  const [latest, counts, oldestDue] = await Promise.all([
    optionalQuery(
      tables,
      [resultTable],
      entryKind
        ? `SELECT id, created_at AS completed_at
             FROM ${resultTable}
            WHERE kind = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 1`
        : `SELECT id, completed_at, created_at
             FROM ${resultTable}
            WHERE status = 'completed'
            ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
            LIMIT 1`,
      entryKind ? [entryKind] : []
    ),
    optionalQuery(
      tables,
      [jobTable],
      `SELECT status, count(*)::int AS count
         FROM ${jobTable}
        GROUP BY status`
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
  let status = runFreshness({ enabled, lastSuccessAt: row?.completed_at || row?.created_at, nowMs });
  if (countValue(queueCounts, ["failed"]) > 0) status = { status: "warning", label: "Failed jobs" };
  const oldest = iso(oldestDue.rows[0]?.oldest_due);
  if (oldest && oldestAgeMs(oldest, nowMs) > 30 * minute) status = { status: "critical", label: "Queue stale" };
  return item({
    id,
    category: "memory",
    title,
    description,
    owner,
    trigger,
    cadence,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.created_at,
    lastSuccessAt: row?.completed_at || row?.created_at,
    counts: queueCounts,
    details: [row?.id && `latest=${row.id}`, oldest && `oldestDue=${oldest}`],
  });
}

async function dailyAirdropItem(tables, nowMs) {
  const [latest, runCounts, issuanceCounts] = await Promise.all([
    optionalQuery(
      tables,
      ["profile_daily_airdrop_runs"],
      `SELECT id, run_date, run_mode, status, completed_at, updated_at
         FROM profile_daily_airdrop_runs
        ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      ["profile_daily_airdrop_runs"],
      `SELECT status, count(*)::int AS count
         FROM profile_daily_airdrop_runs
        GROUP BY status`
    ),
    optionalQuery(
      tables,
      ["profile_daily_airdrop_issuances"],
      `SELECT status, count(*)::int AS count
         FROM profile_daily_airdrop_issuances
        GROUP BY status`
    ),
  ]);
  const row = latest.rows[0] || null;
  const counts = {
    ...Object.fromEntries(Object.entries(countsFromRows(runCounts.rows)).map(([key, value]) => [`runs_${key}`, value])),
    ...Object.fromEntries(Object.entries(countsFromRows(issuanceCounts.rows)).map(([key, value]) => [`issuances_${key}`, value])),
  };
  let status = runFreshness({
    enabled: boolEnv(process.env.TASKNODE_DAILY_AIRDROP_WORKER_ENABLED),
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    warningAfterMs: 26 * hour,
    staleAfterMs: 48 * hour,
    nowMs,
  });
  if (row?.status === "failed") status = { status: "critical", label: "Last run failed" };
  if (countValue(counts, ["issuances_failed", "runs_failed"]) > 0) status = mergeStatus(status, { status: "warning", label: "Failed records" });
  return item({
    id: "daily_airdrop_worker",
    category: "memory",
    title: "Daily Airdrop Worker",
    description: "Scores eligible accounts and optionally issues the daily PFT airdrop.",
    owner: "worker process",
    trigger: "daily interval timer",
    cadence: `${intEnv(process.env.TASKNODE_DAILY_AIRDROP_WORKER_INTERVAL_MS, hour, { min: minute })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.updated_at,
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    staleAfterMs: 48 * hour,
    counts,
    details: [row?.id && `latest=${row.id}`, row?.run_date && `runDate=${row.run_date}`, row?.run_mode && `mode=${row.run_mode}`],
  });
}

async function categoryItems(tables, nowMs) {
  const hiveItems = [
    await boardManagerItem(tables, nowMs),
    await boardManagerSecretaryPacketItem(tables, nowMs),
    await hiveQueueItem({
      tables,
      id: "hive_secretary",
      title: "Hive Secretary Worker",
      description: "Builds the network context report from validated Hive inputs.",
      owner: "worker process",
      jobTable: "hive_secretary_jobs",
      resultTable: "hive_secretary_reports",
      resultTimeColumn: "completed_at",
      enabled: process.env.TASKNODE_HIVE_SECRETARY_ENABLED !== "false",
      trigger: "validated Hive Context input",
      cadence: `${intEnv(process.env.TASKNODE_HIVE_SECRETARY_INTERVAL_MS, 15000, { min: 1000 })}ms`,
      nowMs,
    }),
    await hiveQueueItem({
      tables,
      id: "hive_active_projects",
      title: "Hive Active Projects Helper",
      description: "Refreshes the active project registry after Secretary reports.",
      owner: "worker process",
      jobTable: "hive_project_planning_jobs",
      resultTable: "hive_project_generations",
      resultTimeColumn: "completed_at",
      enabled: process.env.TASKNODE_HIVE_PROJECT_WORKER_ENABLED !== "false",
      trigger: "Hive Secretary completion",
      cadence: `${intEnv(process.env.TASKNODE_HIVE_PROJECT_INTERVAL_MS, 60000, { min: 15000 })}ms`,
      nowMs,
    }),
  ];

  const taskItems = [
    await networkTaskGenerationItem(tables, nowMs),
    await taskGenerationItem(tables, nowMs),
    await taskReviewItem(tables, nowMs),
  ];

  const syncItems = await pftlSyncItems(tables, nowMs);
  const pftlItems = [
    ...syncItems,
    await pftlWatcherItem(tables, nowMs),
    await pftlReducerItem(tables, nowMs),
    await pftlRetentionItem(tables, nowMs),
    ...rpcItems(syncItems),
  ];

  const memoryItems = [
    await memoryQueueItem({
      tables,
      id: "chat_turn_memory",
      title: "Turn Memory Worker",
      description: "Summarizes individual user/assistant chat turns.",
      jobTable: "chat_memory_jobs",
      entryKind: "turn_memory",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "assistant chat message",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await memoryQueueItem({
      tables,
      id: "deep_memory",
      title: "Deep Memory Worker",
      description: "Compresses batches of turn memory into account-level memory.",
      jobTable: "chat_deep_memory_jobs",
      entryKind: "deep_memory",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "turn memory block threshold",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await memoryQueueItem({
      tables,
      id: "network_task_profile",
      title: "Network Task Profile Worker",
      description: "Builds compact routing profiles for future Network Tasks.",
      jobTable: "network_task_profile_jobs",
      resultTable: "network_task_profiles",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "profile refresh request or prompt version change",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await dailyAirdropItem(tables, nowMs),
  ];

  return [
    {
      id: "hive",
      title: "Hive And Board Agents",
      summary: "Board Manager, Secretary, project planning, and board compression jobs.",
      items: hiveItems,
    },
    {
      id: "task_engine",
      title: "Task Systems",
      summary: "Network Task generation, task offer generation, and verification/reward review.",
      items: taskItems,
    },
    {
      id: "pftl",
      title: "PFTL And RPCs",
      summary: "Current and archive RPC paths, websocket watcher, wallet sync, reducer, and retention.",
      items: pftlItems,
    },
    {
      id: "memory",
      title: "Memory, Profiles, And Airdrops",
      summary: "Chat memory, routing profiles, and daily airdrop scoring/issuance.",
      items: memoryItems,
    },
  ];
}

export async function readSystemStatus() {
  const generatedAt = new Date();
  const nowMs = generatedAt.getTime();
  const database = databaseStatus();
  if (!databaseEnabled()) {
    const categories = await categoryItems(new Map(), nowMs);
    return {
      ok: true,
      generatedAt: generatedAt.toISOString(),
      database,
      summary: summarizeCategories(categories),
      categories,
    };
  }
  const tables = await tableMap();
  const categories = await categoryItems(tables, nowMs);
  return {
    ok: true,
    generatedAt: generatedAt.toISOString(),
    database,
    summary: summarizeCategories(categories),
    categories,
  };
}

export async function handleSystemStatusRoute({ json, res, url } = {}) {
  if (url.pathname !== "/api/system/status") return false;
  const status = await readSystemStatus();
  json(res, 200, status);
  return true;
}
