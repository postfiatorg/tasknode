import {
  pftlCacheHealthSummary,
  prunePftlCacheRetention,
  recordPftlCacheMaintenanceRun,
} from "./repositories/pftl-cache-operations.js";

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function splitList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function envFlag(value) {
  return String(value || "").toLowerCase() === "true";
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export function isPftlCacheOperator({ accountId = "", env = process.env } = {}) {
  const account = normalizeText(accountId);
  if (!account) return false;
  const operators = new Set([
    ...splitList(env.TASKNODE_OPERATOR_ACCOUNT_IDS),
    ...splitList(env.TASKNODE_ADMIN_ACCOUNT_IDS),
  ]);
  if (operators.has(account)) return true;
  return env.TASKNODE_ENV !== "production" && env.PFTL_CACHE_OPERATOR_ALLOW_LOCAL !== "false";
}

export async function readPftlCacheOperatorHealth({
  accountId = "",
  env = process.env,
  query = {},
} = {}) {
  if (!isPftlCacheOperator({ accountId, env })) {
    return {
      ok: false,
      status: 403,
      error: "pftl_cache_operator_required",
      message: "PFTL cache health is limited to configured Task Node operators.",
    };
  }
  return pftlCacheHealthSummary({
    hotStaleMs: query.hotStaleMs,
    archiveStaleMs: query.archiveStaleMs,
    recentLimit: query.recentLimit,
  });
}

export async function runPftlCacheRetention({
  completedReducerEventDays = process.env.PFTL_CACHE_RETENTION_COMPLETED_REDUCER_DAYS,
  rawTxDays = process.env.PFTL_CACHE_RETENTION_RAW_TX_DAYS,
  rawTxEnabled = envFlag(process.env.PFTL_CACHE_RETENTION_RAW_TX_ENABLED),
  dryRun = false,
} = {}) {
  try {
    const result = await prunePftlCacheRetention({
      completedReducerEventDays,
      rawTxDays,
      rawTxEnabled,
      dryRun,
    });
    await recordPftlCacheMaintenanceRun({
      runKind: dryRun ? "retention_dry_run" : "retention",
      status: "completed",
      metrics: result,
    });
    return result;
  } catch (error) {
    await recordPftlCacheMaintenanceRun({
      runKind: dryRun ? "retention_dry_run" : "retention",
      status: "failed",
      metrics: {},
      error: error?.message || String(error),
    }).catch(() => {});
    throw error;
  }
}

export function startPftlCacheRetentionWorker({
  enabled = envFlag(process.env.PFTL_CACHE_RETENTION_WORKER_ENABLED),
  intervalMs = Number(process.env.PFTL_CACHE_RETENTION_INTERVAL_MS || 6 * 3_600_000),
  initialDelayMs = Number(process.env.PFTL_CACHE_RETENTION_INITIAL_DELAY_MS || 60000),
  dryRun = envFlag(process.env.PFTL_CACHE_RETENTION_DRY_RUN),
  logger = console,
} = {}) {
  if (!enabled) return { started: false, reason: "disabled" };
  const safeInterval = clampInteger(intervalMs, 6 * 3_600_000, 300000, 7 * 86_400_000);
  const safeInitialDelay = clampInteger(initialDelayMs, 60000, 1000, safeInterval);
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      await runPftlCacheRetention({ dryRun });
    } catch (error) {
      logger.warn?.("pftl_cache_retention_failed", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(runOnce, safeInitialDelay);
  const timer = setInterval(runOnce, safeInterval);
  return {
    started: true,
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(timer);
    },
  };
}
