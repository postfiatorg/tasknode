import {
  boolEnv,
  countsFromRows,
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
} from "./system-status-base.js";
import { ethereumDepositConfigStatus } from "./ethereum-deposits.js";
import { recentFailureWindowMs } from "./system-status-readers.js";

export async function pftlSyncItems(tables, nowMs) {
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
                AND (last_hot_sync_at IS NULL OR last_hot_sync_at < now() - ($3 * interval '1 millisecond'))
            )::int AS hot_severely_stale,
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
      intEnv(process.env.PFTL_CACHE_HOT_STALE_MS, 120000, { min: 10000 }) * 3,
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
  const archiveEnabled = boolEnv(process.env.PFTL_CACHE_ARCHIVE_WORKER_ENABLED);
  const archiveFreshness = archiveEnabled && Number(row.archive_stale || 0) === 0 && (Number(row.active || 0) > 0 || row.last_archive_sync_at)
    ? { status: "ok", label: "Archive complete" }
    : runFreshness({
      enabled: archiveEnabled,
      lastSuccessAt: row.last_archive_sync_at,
      warningAfterMs: archiveStaleMs,
      staleAfterMs: archiveStaleMs * 3,
      nowMs,
    });
  const hotStatus = Number(row.hot_severely_stale || 0) > 0 ? mergeStatus(hotFreshness, { status: "warning", label: "Stale wallets" }) : hotFreshness;
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
      counts: { ...counts, hot_stale: Number(row.hot_stale || 0), hot_severely_stale: Number(row.hot_severely_stale || 0) },
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

export async function pftlWatcherItem(tables, nowMs) {
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

export async function pftlReducerItem(tables, nowMs) {
  const [summary, counts] = await Promise.all([
    optionalQuery(
      tables,
      ["pftl_cache_reducer_events"],
      `SELECT max(processed_at) FILTER (WHERE status = 'completed') AS last_completed_at,
              max(updated_at) AS last_seen_at,
              min(available_at) FILTER (WHERE status IN ('pending','processing')) AS oldest_pending_at,
              count(*) FILTER (
                WHERE status IN ('failed', 'failed_permanent', 'retry_wait')
                  AND updated_at > now() - ($1 * interval '1 millisecond')
              )::int AS recent_failed,
              max(last_error) FILTER (WHERE status = 'failed' AND last_error <> '') AS last_error
         FROM pftl_cache_reducer_events`,
      [recentFailureWindowMs]
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
  if (Number(row.recent_failed || 0) > 0) status = { status: "critical", label: "Recent reducer failures" };
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

export async function pftlRetentionItem(tables, nowMs) {
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

export function rpcItems(syncItems = []) {
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
  const ethereumStatus = ethereumDepositConfigStatus();
  const ethereumEndpoints = endpointList(process.env.ETH_DEPOSIT_RPC_URL || process.env.VITE_ETH_DEPOSIT_RPC_URL || "https://ethereum.publicnode.com");
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
      status: ethereumStatus.enabled && ethereumStatus.rpcConfigured ? "ok" : "disabled",
      statusLabel: ethereumStatus.enabled && ethereumStatus.rpcConfigured ? "Configured" : "Not configured",
      details: [
        ...ethereumEndpoints.map((endpoint) => `endpoint=${endpoint}`),
        ethereumStatus.enabled && `chainId=${ethereumStatus.chainId}`,
      ],
    }),
  ];
}
