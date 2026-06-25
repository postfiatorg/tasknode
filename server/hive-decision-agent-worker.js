import { hostname } from "node:os";
import { databaseEnabled } from "./db/pool.js";
import {
  claimBoardManagerLease,
  releaseBoardManagerLease,
} from "./repositories/board-manager.js";
import {
  applyHiveDecisionGuardrails,
  buildHiveDecisionSourcePacket,
  completeHiveDecisionRun,
  failHiveDecisionRun,
  failStaleHiveDecisionRuns,
  startHiveDecisionRun,
} from "./repositories/hive-decision-agent.js";
import {
  fetchHiveDecisionAgentDecision,
  hiveDecisionAgentModel,
  hiveDecisionAgentProvider,
  hiveDecisionAgentProviderConfigured,
  hiveDecisionAgentReasoningEffort,
} from "./hive-decision-agent-provider.js";

let timer = null;
let running = false;
let scheduled = null;

const workerScope = "hive_decision_agent:global_hive";
const managerId = `hive_decision_agent_${hostname()}_${process.pid}`;

function cadenceMs() {
  const seconds = Number(process.env.TASKNODE_HIVE_DECISION_AGENT_CADENCE_SECONDS || process.env.TASKNODE_BOARD_MANAGER_CADENCE_SECONDS || 300);
  return Math.min(Math.max(seconds, 60), 86400) * 1000;
}

function staleMinutes() {
  return Math.min(Math.max(Number(process.env.TASKNODE_HIVE_DECISION_AGENT_STALE_MINUTES || 30), 5), 1440);
}

function shadowEnabled() {
  return (
    process.env.TASKNODE_HIVE_DECISION_AGENT_ENABLED !== "false" &&
    databaseEnabled() &&
    hiveDecisionAgentProviderConfigured()
  );
}

export async function runHiveDecisionAgentOnce({
  scope = "global_hive",
  trigger = "shadow_tick",
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  if (!databaseEnabled()) {
    return { ok: false, skipped: true, reason: "database_not_configured" };
  }
  if (!hiveDecisionAgentProviderConfigured()) {
    return { ok: false, skipped: true, reason: "hive_decision_agent_provider_not_configured" };
  }
  const provider = hiveDecisionAgentProvider();
  const model = hiveDecisionAgentModel();
  const reasoningEffort = hiveDecisionAgentReasoningEffort();
  const sourcePacket = await buildHiveDecisionSourcePacket({ scope, trigger, now });
  const run = await startHiveDecisionRun({
    scope,
    trigger,
    sourcePacket,
    provider,
    model,
    reasoningEffort,
  });
  try {
    const result = await fetchHiveDecisionAgentDecision({
      sourcePacket,
      model,
      reasoningEffort,
      fetchImpl,
    });
    const guardrailResult = applyHiveDecisionGuardrails({
      decision: result.decision,
      sourcePacket,
    });
    const completed = await completeHiveDecisionRun({
      runId: run.id,
      decision: result.decision,
      guardrailResult,
      outputText: result.outputText,
      usage: result.usage,
      provider: result.provider,
      model: result.model,
    });
    return {
      ok: true,
      runId: completed.id,
      action: completed.selectedAction,
      guardrailOk: guardrailResult.ok === true,
      guardrailReasons: guardrailResult.reasons || [],
      shadow: true,
      reportIds: completed.inputReportIds,
    };
  } catch (error) {
    await failHiveDecisionRun({
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

export function scheduleHiveDecisionAgentQueue({ delayMs = 0 } = {}) {
  if (!shadowEnabled()) return false;
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    processHiveDecisionAgentQueue().catch((error) => {
      console.warn("[hive-decision-agent] queue failed", error?.message || error);
    });
  }, Math.max(0, Number(delayMs) || 0));
  scheduled.unref?.();
  return true;
}

async function processHiveDecisionAgentQueue() {
  if (running || !shadowEnabled()) return;
  running = true;
  let lease = null;
  try {
    const ttlSeconds = Math.min(Math.max(Math.ceil(cadenceMs() / 1000) * 2, 600), 7200);
    lease = await claimBoardManagerLease({
      scope: workerScope,
      managerId,
      ttlSeconds,
      metadata: {
        worker: "hive_decision_agent",
        phase: "shadow",
        cadenceMs: cadenceMs(),
      },
    });
    if (!lease.ok) {
      return;
    }
    await failStaleHiveDecisionRuns({
      staleMinutes: staleMinutes(),
      limit: 10,
    }).catch((error) => {
      console.warn("[hive-decision-agent] stale reclaim failed", error?.message || error);
    });
    const result = await runHiveDecisionAgentOnce({
      trigger: "shadow_periodic_tick",
    });
    if (!result.ok) {
      console.warn("[hive-decision-agent] shadow run failed", result.error || result.reason || result);
    }
  } finally {
    if (lease?.ok) {
      await releaseBoardManagerLease({ scope: workerScope, managerId }).catch(() => null);
    }
    running = false;
  }
}

export function startHiveDecisionAgentWorker() {
  if (!shadowEnabled()) return false;
  if (timer) return true;
  timer = setInterval(() => {
    processHiveDecisionAgentQueue().catch((error) => {
      console.warn("[hive-decision-agent] interval failed", error?.message || error);
    });
  }, cadenceMs());
  timer.unref?.();
  scheduleHiveDecisionAgentQueue({ delayMs: Math.min(5000, cadenceMs()) });
  return true;
}
