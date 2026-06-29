import { hostname } from "node:os";
import { databaseEnabled } from "./db/pool.js";
import {
  claimBoardManagerLease,
  releaseBoardManagerLease,
} from "./repositories/board-manager.js";
import {
  applyTaskManagerGuardrails,
  buildHiveTaskManagerSourcePacket,
  completeHiveTaskManagerRun,
  executeTaskManagerSelection,
  failHiveTaskManagerRun,
  failStaleHiveTaskManagerRuns,
  startHiveTaskManagerRun,
} from "./repositories/hive-task-manager.js";
import {
  fetchHiveTaskManagerSelection,
  hiveTaskManagerModel,
  hiveTaskManagerProvider,
  hiveTaskManagerProviderConfigured,
  hiveTaskManagerReasoningEffort,
} from "./hive-task-manager-provider.js";
import { scheduleNetworkTaskGenerationQueue } from "./network-task-generation-worker.js";

let timer = null;
let running = false;
let scheduled = null;
let currentLease = null;

const workerScope = "hive_task_manager:global_hive";
const managerId = `hive_task_manager_${hostname()}_${process.pid}`;

function cadenceMs() {
  const seconds = Number(process.env.TASKNODE_HIVE_TASK_MANAGER_CADENCE_SECONDS || 300);
  return Math.min(Math.max(seconds, 60), 86400) * 1000;
}

function staleMinutes() {
  return Math.min(Math.max(Number(process.env.TASKNODE_HIVE_TASK_MANAGER_STALE_MINUTES || 8), 5), 1440);
}

export function hiveTaskManagerEnabled(env = process.env) {
  return env.TASKNODE_HIVE_TASK_MANAGER_ENABLED === "true";
}

export function hiveTaskManagerActive(env = process.env) {
  return hiveTaskManagerEnabled(env) && env.TASKNODE_HIVE_TASK_MANAGER_ACTIVE === "true";
}

function workerEnabled() {
  return hiveTaskManagerEnabled() && databaseEnabled() && hiveTaskManagerProviderConfigured();
}

export async function runHiveTaskManagerOnce({
  scope = "global_hive",
  trigger = "periodic_tick",
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  if (!hiveTaskManagerEnabled()) {
    return { ok: false, skipped: true, reason: "hive_task_manager_disabled" };
  }
  if (!databaseEnabled()) {
    return { ok: false, skipped: true, reason: "database_not_configured" };
  }
  if (!hiveTaskManagerProviderConfigured()) {
    return { ok: false, skipped: true, reason: "hive_task_manager_provider_not_configured" };
  }
  const active = hiveTaskManagerActive();
  const provider = hiveTaskManagerProvider();
  const model = hiveTaskManagerModel();
  const reasoningEffort = hiveTaskManagerReasoningEffort();
  const sourcePacket = await buildHiveTaskManagerSourcePacket({
    scope,
    trigger,
    now,
    phase: active ? "active" : "shadow",
  });
  const run = await startHiveTaskManagerRun({
    scope,
    trigger,
    sourcePacket,
    provider,
    model,
    reasoningEffort,
    shadow: !active,
  });
  try {
    const result = await fetchHiveTaskManagerSelection({
      sourcePacket,
      model,
      reasoningEffort,
      fetchImpl,
    });
    const guardrailResult = applyTaskManagerGuardrails({
      selection: result.selection,
      sourcePacket,
    });
    let executionResult = {
      executed: false,
      skipped: true,
      reason: active ? "task_manager_guardrail_or_no_task" : "task_manager_shadow",
    };
    if (active && guardrailResult.ok === true && guardrailResult.action === "create_task") {
      executionResult = await executeTaskManagerSelection({
        runId: run.id,
        selection: result.selection,
        sourcePacket,
      });
      scheduleNetworkTaskGenerationQueue({
        delayMs: 250,
        limit: 1,
        reason: "hive_task_manager_create_task",
      });
    }
    await completeHiveTaskManagerRun({
      runId: run.id,
      selection: result.selection,
      guardrailResult,
      executionResult,
      outputText: result.outputText,
      usage: result.usage,
      provider: result.provider,
      model: result.model,
    });
    return {
      ok: true,
      runId: run.id,
      action: result.selection.action,
      guardrailOk: guardrailResult.ok === true,
      guardrailReasons: guardrailResult.reasons || [],
      active,
      executed: executionResult.executed === true,
      executionResult,
    };
  } catch (error) {
    await failHiveTaskManagerRun({
      runId: run.id,
      error: error?.message || String(error),
      outputText: error?.outputText || "",
    }).catch(() => null);
    return {
      ok: false,
      runId: run.id,
      error: error?.message || String(error),
    };
  }
}

export function scheduleHiveTaskManagerQueue({ delayMs = 0 } = {}) {
  if (!workerEnabled()) return false;
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    processHiveTaskManagerQueue().catch((error) => {
      console.warn("[hive-task-manager] queue failed", error?.message || error);
    });
  }, Math.max(0, Number(delayMs) || 0));
  scheduled.unref?.();
  return true;
}

async function processHiveTaskManagerQueue() {
  if (running || !workerEnabled()) return;
  running = true;
  let lease = null;
  try {
    const ttlSeconds = Math.min(Math.max(Math.ceil(cadenceMs() / 1000) * 2, 600), 7200);
    lease = await claimBoardManagerLease({
      scope: workerScope,
      managerId,
      ttlSeconds,
      metadata: {
        worker: "hive_task_manager",
        cadenceMs: cadenceMs(),
        active: hiveTaskManagerActive(),
      },
    });
    if (!lease.ok) return;
    currentLease = lease;
    await failStaleHiveTaskManagerRuns({
      staleMinutes: staleMinutes(),
      limit: 10,
    }).catch((error) => {
      console.warn("[hive-task-manager] stale reclaim failed", error?.message || error);
    });
    const result = await runHiveTaskManagerOnce({
      trigger: hiveTaskManagerActive() ? "active_periodic_tick" : "shadow_periodic_tick",
    });
    if (!result.ok) {
      console.warn("[hive-task-manager] run failed", result.error || result.reason || result);
    }
  } finally {
    if (lease?.ok) {
      await releaseBoardManagerLease({ scope: workerScope, managerId }).catch(() => null);
    }
    if (currentLease?.managerId === lease?.managerId) currentLease = null;
    running = false;
  }
}

export function startHiveTaskManagerWorker() {
  if (!workerEnabled()) return false;
  if (timer) return true;
  timer = setInterval(() => {
    processHiveTaskManagerQueue().catch((error) => {
      console.warn("[hive-task-manager] interval failed", error?.message || error);
    });
  }, cadenceMs());
  timer.unref?.();
  scheduleHiveTaskManagerQueue({ delayMs: Math.min(5000, cadenceMs()) });
  return true;
}

export async function stopHiveTaskManagerWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (scheduled) {
    clearTimeout(scheduled);
    scheduled = null;
  }
  const lease = currentLease;
  currentLease = null;
  if (lease?.ok) {
    await releaseBoardManagerLease({ scope: workerScope, managerId }).catch(() => null);
  }
}
