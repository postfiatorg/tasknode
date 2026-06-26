import { databaseEnabled } from "./db/pool.js";
import {
  claimTaskAccountingHarvests,
  completeTaskAccountingHarvest,
  enqueueRewardedNetworkTaskHarvests,
  failTaskAccountingHarvest,
  heartbeatTaskAccountingHarvest,
} from "./repositories/task-accounting-harvester.js";
import {
  runTaskAccountingHarvestCall,
  taskAccountingHarvesterProviderConfigured,
} from "./task-accounting-harvester-provider.js";

let timer = null;
let scheduled = null;
let running = false;

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function harvesterEnabled() {
  return (
    process.env.TASKNODE_TASK_ACCOUNTING_HARVESTER_ENABLED !== "false" &&
    databaseEnabled() &&
    taskAccountingHarvesterProviderConfigured()
  );
}

function workerIntervalMs() {
  return intEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_INTERVAL_MS", 60_000, {
    min: 5_000,
    max: 24 * 60 * 60 * 1000,
  });
}

function workerId() {
  return `task_accounting_harvester_${process.env.FLY_MACHINE_ID || process.pid || "local"}`;
}

async function mapConcurrent(items = [], concurrency = 1, mapper) {
  const results = [];
  const workers = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  for (let i = 0; i < workerCount; i += 1) {
    workers.push((async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

export async function runTaskAccountingHarvesterOnce({ fetchImpl = fetch } = {}) {
  if (!databaseEnabled()) {
    return { ok: false, skipped: true, reason: "database_not_configured", queued: 0, processed: [], errors: [] };
  }
  if (!taskAccountingHarvesterProviderConfigured()) {
    return { ok: false, skipped: true, reason: "provider_not_configured", queued: 0, processed: [], errors: [] };
  }
  const enqueueLimit = intEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_ENQUEUE_LIMIT", 1000, { min: 1, max: 5000 });
  const batchLimit = intEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_BATCH_LIMIT", 3, { min: 1, max: 250 });
  const concurrency = intEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_CONCURRENCY", 1, { min: 1, max: 200 });
  const maxAttempts = intEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_MAX_ATTEMPTS", 3, { min: 1, max: 20 });
  const staleSeconds = intEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_STALE_SECONDS", 900, { min: 60, max: 86_400 });
  const enqueueResult = await enqueueRewardedNetworkTaskHarvests({ limit: enqueueLimit });
  const claimed = await claimTaskAccountingHarvests({
    limit: batchLimit,
    workerId: workerId(),
    maxAttempts,
    staleSeconds,
  });
  const results = await mapConcurrent(claimed, concurrency, async (harvest) => {
    try {
      await heartbeatTaskAccountingHarvest({
        taskId: harvest.taskId,
        workerAttemptId: harvest.workerAttemptId,
        workerId: workerId(),
      });
      const call = await runTaskAccountingHarvestCall({
        sourcePacket: harvest.sourcePacket,
        fetchImpl,
      });
      const result = call.result || {};
      const completed = await completeTaskAccountingHarvest({
        taskId: harvest.taskId,
        workerAttemptId: harvest.workerAttemptId,
        workerId: workerId(),
        classification: result.classification,
        requiresAction: Boolean(result.requires_action),
        actionCategory: result.action_category,
        suggestedAction: result.suggested_action,
        assessmentSummary: result.assessment_summary,
        confidence: result.confidence,
        result,
        provider: call.provider,
        model: call.model,
        promptVersion: call.promptVersion,
        promptDigest: call.promptHash,
        responseId: call.providerRequestId,
        usage: {
          ...(call.usageJson || {}),
          durationMs: call.durationMs,
        },
      });
      return {
        ok: true,
        taskId: harvest.taskId,
        classification: completed.harvest?.classification || result.classification,
        requiresAction: Boolean(completed.harvest?.requiresAction ?? result.requires_action),
      };
    } catch (error) {
      await failTaskAccountingHarvest({
        taskId: harvest.taskId,
        workerAttemptId: harvest.workerAttemptId,
        workerId: workerId(),
        error: error?.message || String(error),
      }).catch(() => {});
      return {
        ok: false,
        taskId: harvest.taskId,
        error: error?.message || String(error),
      };
    }
  });
  const processed = results.filter((result) => result?.ok);
  const errors = results.filter((result) => result && !result.ok);
  return {
    ok: errors.length === 0,
    queued: enqueueResult.upserted || 0,
    claimed: claimed.length,
    concurrency: Math.min(concurrency, Math.max(1, claimed.length)),
    processed,
    errors,
  };
}

async function processTaskAccountingHarvesterQueue() {
  if (running || !harvesterEnabled()) return;
  running = true;
  try {
    const result = await runTaskAccountingHarvesterOnce();
    if (result.errors?.length) {
      console.warn("[task-accounting-harvester] errors", result.errors);
    }
  } finally {
    running = false;
  }
}

export function scheduleTaskAccountingHarvesterQueue({ delayMs = 0 } = {}) {
  if (!harvesterEnabled()) return false;
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    processTaskAccountingHarvesterQueue().catch((error) => {
      console.warn("[task-accounting-harvester] scheduled run failed", error?.message || error);
    });
  }, Math.max(0, Number(delayMs) || 0));
  scheduled.unref?.();
  return true;
}

export function startTaskAccountingHarvesterWorker() {
  if (!harvesterEnabled()) return false;
  if (timer) return true;
  timer = setInterval(() => {
    processTaskAccountingHarvesterQueue().catch((error) => {
      console.warn("[task-accounting-harvester] interval failed", error?.message || error);
    });
  }, workerIntervalMs());
  timer.unref?.();
  scheduleTaskAccountingHarvesterQueue({ delayMs: Math.min(2000, workerIntervalMs()) });
  return true;
}
