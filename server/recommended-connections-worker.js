import { loadPrompt, promptDigest } from "./prompt-registry.js";
import {
  refreshDiscoverableRecommendedConnectionProfiles,
  refreshStaleRecommendedConnections,
} from "./repositories/recommended-connections.js";

const promptText = loadPrompt("profile/recommended_connections_v1.md");
const promptHash = promptDigest(promptText);
const defaultIntervalMs = 10 * 60 * 1000;
const defaultInitialDelayMs = 30 * 1000;

let timer = null;
let initialTimer = null;
let running = false;

function clampMs(value, fallback, { min, max } = {}) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(base, min), max);
}

export async function runRecommendedConnectionsWorkerOnce({
  env = process.env,
  logger = console,
} = {}) {
  const indexLimit = Math.min(Math.max(Number(env.TASKNODE_RECOMMENDED_CONNECTIONS_PROFILE_INDEX_LIMIT || 200), 1), 500);
  const rerankLimit = Math.min(Math.max(Number(env.TASKNODE_RECOMMENDED_CONNECTIONS_RERANK_LIMIT || 1), 1), 20);
  const indexResult = await refreshDiscoverableRecommendedConnectionProfiles({
    limit: indexLimit,
    force: false,
  });
  const refreshResult = await refreshStaleRecommendedConnections({
    limit: rerankLimit,
    prompt: promptText,
    promptDigest: promptHash,
  });
  const summary = {
    indexedCount: Number(indexResult.indexedCount || 0),
    indexFailedCount: Number(indexResult.failedCount || 0),
    scannedForRerank: Number(refreshResult.scanned || 0),
    refreshedCount: Number(refreshResult.refreshedCount || 0),
    failedCount: Number(refreshResult.failedCount || 0),
  };
  if (summary.indexFailedCount || summary.refreshedCount || summary.failedCount) {
    logger.info?.("[recommended-connections-worker]", summary);
  }
  return { ok: true, indexResult, refreshResult, summary };
}

export function startRecommendedConnectionsWorker({
  env = process.env,
  logger = console,
} = {}) {
  if (timer || initialTimer) return { started: false, reason: "already_started" };
  if (env.TASKNODE_RECOMMENDED_CONNECTIONS_WORKER_ENABLED === "false") {
    return { started: false, reason: "disabled" };
  }

  const intervalMs = clampMs(env.TASKNODE_RECOMMENDED_CONNECTIONS_WORKER_INTERVAL_MS, defaultIntervalMs, {
    min: 60_000,
    max: 24 * 60 * 60 * 1000,
  });
  const initialDelayMs = clampMs(env.TASKNODE_RECOMMENDED_CONNECTIONS_INITIAL_DELAY_MS, defaultInitialDelayMs, {
    min: 1000,
    max: intervalMs,
  });
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runRecommendedConnectionsWorkerOnce({ env, logger });
    } catch (error) {
      logger.warn?.("[recommended-connections-worker] tick failed", error?.stack || error?.message || error);
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
