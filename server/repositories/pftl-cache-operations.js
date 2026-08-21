import { databaseEnabled, query } from "../db/pool.js";

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function safeJson(value, fallback = {}) {
  return value && typeof value === "object" ? value : fallback;
}

export async function recordPftlCacheMaintenanceRun({
  runKind = "",
  status = "completed",
  walletAddress = "",
  metrics = {},
  error = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  const result = await query(
    `
      INSERT INTO pftl_cache_maintenance_runs (
        run_kind,
        status,
        wallet_address,
        metrics_json,
        last_error,
        completed_at
      )
      VALUES ($1,$2,$3,$4,$5,CASE WHEN $2 IN ('completed','failed') THEN now() ELSE NULL END)
      RETURNING id
    `,
    [
      normalizeText(runKind) || "unknown",
      normalizeText(status) || "completed",
      normalizeText(walletAddress),
      safeJson(metrics),
      normalizeText(error),
    ]
  );
  return { ok: true, id: result.rows[0]?.id || null };
}

export async function pftlCacheHealthSummary({
  hotStaleMs = 120_000,
  archiveStaleMs = 24 * 3_600_000,
  recentLimit = 10,
} = {}) {
  if (!databaseEnabled()) {
    return {
      ok: false,
      status: 503,
      error: "pftl_cache_database_not_configured",
      message: "The PFTL transaction cache database is not configured.",
    };
  }
  const safeHotStaleMs = clampInteger(hotStaleMs, 120_000, 10_000, 7 * 86_400_000);
  const safeArchiveStaleMs = clampInteger(archiveStaleMs, 24 * 3_600_000, 60_000, 30 * 86_400_000);
  const safeRecentLimit = clampInteger(recentLimit, 10, 1, 50);

  const wallets = await query(
    `
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'active')::int AS active,
        count(*) FILTER (WHERE status <> 'active')::int AS inactive,
        count(*) FILTER (
          WHERE status = 'active'
            AND (
              last_hot_sync_at IS NULL
              OR last_hot_sync_at < now() - ($1 * INTERVAL '1 millisecond')
            )
        )::int AS hot_stale,
        count(*) FILTER (
          WHERE status = 'active'
            AND COALESCE(archive_marker @> '{"complete": true}'::jsonb, false) = true
        )::int AS archive_complete,
        count(*) FILTER (
          WHERE status = 'active'
            AND COALESCE(archive_marker @> '{"complete": true}'::jsonb, false) = false
        )::int AS archive_incomplete,
        count(*) FILTER (
          WHERE status = 'active'
            AND COALESCE(archive_marker @> '{"complete": true}'::jsonb, false) = false
            AND (
              last_archive_sync_at IS NULL
              OR last_archive_sync_at < now() - ($2 * INTERVAL '1 millisecond')
            )
        )::int AS archive_stale,
        count(*) FILTER (WHERE last_error IS NOT NULL AND last_error <> '')::int AS error_count
      FROM pftl_sync_wallets
    `,
    [safeHotStaleMs, safeArchiveStaleMs]
  );

  const reducer = await query(
    `
      SELECT status, count(*)::int AS count
      FROM pftl_cache_reducer_events
      GROUP BY status
    `
  );

  const watcher = await query(
    `
      SELECT
        id,
        endpoint_url,
        status,
        subscribed_wallet_count,
        last_ledger_index,
        last_event_tx_hash,
        last_event_at,
        last_error,
        updated_at
      FROM pftl_cache_watcher_state
      ORDER BY updated_at DESC, id ASC
      LIMIT $1
    `,
    [safeRecentLimit]
  );

  const recentErrors = await query(
    `
      SELECT
        wallet_address,
        account_id,
        role,
        last_error,
        last_hot_sync_at,
        last_archive_sync_at,
        updated_at
      FROM pftl_sync_wallets
      WHERE last_error IS NOT NULL
        AND last_error <> ''
      ORDER BY updated_at DESC
      LIMIT $1
    `,
    [safeRecentLimit]
  );

  const counts = await query(
    `
      SELECT
        (SELECT count(*)::int FROM pftl_transactions) AS transactions,
        (SELECT count(*)::int FROM pftl_wallet_transactions) AS wallet_transactions,
        (SELECT count(*)::int FROM pftl_pointer_memos) AS pointer_memos,
        (
          SELECT count(*)::int
          FROM pftl_pointer_memos
          WHERE pointer_kind = 'CONTEXT'
        ) AS context_pointers,
        (
          SELECT count(*)::int
          FROM pftl_pointer_memos
          WHERE pointer_kind IN ('TASK','TASK_UPDATE','TASK_SUBMISSION','REWARD')
        ) AS task_pointers
    `
  );

  const maintenance = await query(
    `
      SELECT id, run_kind, status, wallet_address, metrics_json, last_error, started_at, completed_at
      FROM pftl_cache_maintenance_runs
      ORDER BY started_at DESC, id DESC
      LIMIT $1
    `,
    [safeRecentLimit]
  );

  const reducerQueue = reducer.rows.reduce((memo, row) => {
    memo[row.status || "unknown"] = row.count;
    return memo;
  }, {});

  return {
    ok: true,
    status: 200,
    generatedAt: new Date().toISOString(),
    thresholds: {
      hotStaleMs: safeHotStaleMs,
      archiveStaleMs: safeArchiveStaleMs,
    },
    wallets: wallets.rows[0] || {},
    reducerQueue,
    counts: counts.rows[0] || {},
    watchers: watcher.rows,
    recentErrors: recentErrors.rows,
    maintenanceRuns: maintenance.rows,
  };
}

export async function prunePftlCacheRetention({
  completedReducerEventDays = 14,
  rawTxDays = 180,
  rawTxEnabled = false,
  dryRun = false,
  walletAddress = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  const safeCompletedDays = clampInteger(completedReducerEventDays, 14, 1, 365);
  const safeRawTxDays = clampInteger(rawTxDays, 180, 30, 3650);
  const scopedWallet = normalizeText(walletAddress);

  const reducerCandidates = await query(
    `
      SELECT count(*)::int AS count
      FROM pftl_cache_reducer_events
      WHERE status = 'completed'
        AND processed_at IS NOT NULL
        AND processed_at < now() - ($1 * INTERVAL '1 day')
        AND ($2 = '' OR wallet_address = $2)
    `,
    [safeCompletedDays, scopedWallet]
  );

  let reducerDeleted = 0;
  if (!dryRun) {
    const reducerDelete = await query(
      `
        DELETE FROM pftl_cache_reducer_events
        WHERE status = 'completed'
          AND processed_at IS NOT NULL
          AND processed_at < now() - ($1 * INTERVAL '1 day')
          AND ($2 = '' OR wallet_address = $2)
      `,
      [safeCompletedDays, scopedWallet]
    );
    reducerDeleted = reducerDelete.rowCount || 0;
  }

  const rawTxCandidates = scopedWallet
    ? { rows: [{ count: 0 }] }
    : await query(
      `
        SELECT count(*)::int AS count
        FROM pftl_transactions tx
        WHERE tx.first_seen_at < now() - ($1 * INTERVAL '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM pftl_wallet_transactions wt WHERE wt.tx_hash = tx.tx_hash
          )
          AND NOT EXISTS (
            SELECT 1 FROM pftl_pointer_memos pm WHERE pm.tx_hash = tx.tx_hash
          )
      `,
      [safeRawTxDays]
    );

  let rawTxDeleted = 0;
  if (!dryRun && rawTxEnabled && !scopedWallet) {
    const rawTxDelete = await query(
      `
        DELETE FROM pftl_transactions tx
        WHERE tx.first_seen_at < now() - ($1 * INTERVAL '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM pftl_wallet_transactions wt WHERE wt.tx_hash = tx.tx_hash
          )
          AND NOT EXISTS (
            SELECT 1 FROM pftl_pointer_memos pm WHERE pm.tx_hash = tx.tx_hash
          )
      `,
      [safeRawTxDays]
    );
    rawTxDeleted = rawTxDelete.rowCount || 0;
  }

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    policy: {
      completedReducerEventDays: safeCompletedDays,
      rawTxDays: safeRawTxDays,
      rawTxEnabled: Boolean(rawTxEnabled),
      walletAddress: scopedWallet,
    },
    candidates: {
      completedReducerEvents: reducerCandidates.rows[0]?.count || 0,
      orphanRawTransactions: rawTxCandidates.rows[0]?.count || 0,
    },
    deleted: {
      completedReducerEvents: reducerDeleted,
      orphanRawTransactions: rawTxDeleted,
    },
  };
}
