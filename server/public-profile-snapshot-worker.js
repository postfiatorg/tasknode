import { databaseEnabled, query } from "./db/pool.js";
import { runPublicProfileSnapshot } from "./profile-public-snapshot.js";

const defaultIntervalMs = 10 * 60 * 1000;
const defaultInitialDelayMs = 45 * 1000;

let timer = null;
let initialTimer = null;
let running = false;

function clampMs(value, fallback, { min, max } = {}) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(base, min), max);
}

function openRouterKey(env = process.env) {
  return String(env.OPENROUTER_API_KEY || env.OPENROUTER || "").trim();
}

export async function listPublicProfileSnapshotCandidates({
  limit = 2,
  failedRetryMinutes = 360,
} = {}) {
  if (!databaseEnabled()) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 2, 1), 25);
  const safeRetryMinutes = Math.min(Math.max(Number(failedRetryMinutes) || 360, 5), 7 * 24 * 60);
  const result = await query(
    `
      WITH activity AS (
        SELECT projection.account_id,
               max(projection.updated_at) AS last_activity_at,
               count(*)::int AS network_task_count,
               0::int AS nft_count
        FROM task_projections projection
        WHERE projection.task_kind = 'network'
          AND projection.account_id <> ''
        GROUP BY projection.account_id
        UNION ALL
        SELECT nft.account_id,
               max(nft.updated_at) AS last_activity_at,
               0::int AS network_task_count,
               count(*)::int AS nft_count
        FROM profile_nfts nft
        WHERE nft.account_id <> ''
          AND lower(nft.status) IN ('generated', 'prepared', 'minted')
        GROUP BY nft.account_id
      ),
      rolled AS (
        SELECT account_id,
               max(last_activity_at) AS last_activity_at,
               sum(network_task_count)::int AS network_task_count,
               sum(nft_count)::int AS nft_count
        FROM activity
        GROUP BY account_id
      )
      SELECT rolled.account_id,
             rolled.last_activity_at,
             rolled.network_task_count,
             rolled.nft_count,
             completed.completed_at AS completed_at,
             failed.updated_at AS failed_at
      FROM rolled
      LEFT JOIN LATERAL (
        SELECT snapshot.completed_at
        FROM profile_public_snapshots snapshot
        WHERE snapshot.account_id = rolled.account_id
          AND snapshot.status = 'completed'
        ORDER BY snapshot.completed_at DESC NULLS LAST, snapshot.updated_at DESC
        LIMIT 1
      ) completed ON true
      LEFT JOIN LATERAL (
        SELECT snapshot.updated_at
        FROM profile_public_snapshots snapshot
        WHERE snapshot.account_id = rolled.account_id
          AND snapshot.status = 'running'
          AND snapshot.updated_at > now() - interval '30 minutes'
        ORDER BY snapshot.updated_at DESC
        LIMIT 1
      ) running ON true
      LEFT JOIN LATERAL (
        SELECT snapshot.updated_at
        FROM profile_public_snapshots snapshot
        WHERE snapshot.account_id = rolled.account_id
          AND snapshot.status = 'failed'
        ORDER BY snapshot.updated_at DESC
        LIMIT 1
      ) failed ON true
      WHERE running.updated_at IS NULL
        AND (
          completed.completed_at IS NULL
          OR rolled.last_activity_at > completed.completed_at
        )
        AND (
          failed.updated_at IS NULL
          OR failed.updated_at < now() - ($2::int * interval '1 minute')
        )
      ORDER BY
        (completed.completed_at IS NULL) DESC,
        rolled.last_activity_at DESC NULLS LAST,
        rolled.account_id ASC
      LIMIT $1
    `,
    [safeLimit, safeRetryMinutes]
  );
  return result.rows || [];
}

export async function runPublicProfileSnapshotWorkerOnce({
  dryRun = false,
  env = process.env,
  logger = console,
} = {}) {
  if (!databaseEnabled()) {
    return { ok: true, skipped: true, reason: "database_not_enabled", summary: {} };
  }
  if (!dryRun && !openRouterKey(env)) {
    return { ok: true, skipped: true, reason: "openrouter_key_missing", summary: {} };
  }
  const limit = Math.min(Math.max(Number(env.TASKNODE_PUBLIC_PROFILE_SNAPSHOT_WORKER_LIMIT || 2), 1), 25);
  const failedRetryMinutes = Math.min(
    Math.max(Number(env.TASKNODE_PUBLIC_PROFILE_SNAPSHOT_FAILED_RETRY_MINUTES || 360), 5),
    7 * 24 * 60
  );
  const candidates = await listPublicProfileSnapshotCandidates({ limit, failedRetryMinutes });
  const summary = {
    scanned: candidates.length,
    completed: 0,
    skippedCurrent: 0,
    failed: 0,
    dryRun: dryRun === true,
  };
  const results = [];
  for (const candidate of candidates) {
    if (dryRun) {
      results.push({ accountId: candidate.account_id, dryRun: true });
      continue;
    }
    try {
      const result = await runPublicProfileSnapshot({
        accountId: candidate.account_id,
        env,
      });
      if (result.skipped) summary.skippedCurrent += 1;
      else summary.completed += 1;
      results.push({
        accountId: candidate.account_id,
        skipped: result.skipped === true,
        snapshotId: result.snapshot?.snapshotId || "",
      });
    } catch (error) {
      summary.failed += 1;
      results.push({
        accountId: candidate.account_id,
        error: error?.message || String(error),
      });
      logger.warn?.("[public-profile-snapshot-worker] account failed", {
        accountId: candidate.account_id,
        error: error?.message || String(error),
      });
    }
  }
  if (summary.completed || summary.failed || summary.skippedCurrent || summary.scanned) {
    logger.info?.("[public-profile-snapshot-worker]", summary);
  }
  return { ok: true, candidates, results, summary };
}

export function startPublicProfileSnapshotWorker({
  env = process.env,
  logger = console,
} = {}) {
  if (timer || initialTimer) return { started: false, reason: "already_started" };
  if (env.TASKNODE_PUBLIC_PROFILE_SNAPSHOT_WORKER_ENABLED === "false") {
    return { started: false, reason: "disabled" };
  }

  const intervalMs = clampMs(env.TASKNODE_PUBLIC_PROFILE_SNAPSHOT_WORKER_INTERVAL_MS, defaultIntervalMs, {
    min: 60_000,
    max: 24 * 60 * 60 * 1000,
  });
  const initialDelayMs = clampMs(env.TASKNODE_PUBLIC_PROFILE_SNAPSHOT_INITIAL_DELAY_MS, defaultInitialDelayMs, {
    min: 1000,
    max: intervalMs,
  });
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runPublicProfileSnapshotWorkerOnce({ env, logger });
    } catch (error) {
      logger.warn?.("[public-profile-snapshot-worker] tick failed", error?.stack || error?.message || error);
    } finally {
      running = false;
    }
  };

  initialTimer = setTimeout(() => {
    initialTimer = null;
    tick();
  }, initialDelayMs);
  initialTimer.unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { started: true, intervalMs, initialDelayMs };
}
