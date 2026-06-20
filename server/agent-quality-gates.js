import { agentOriginForWalletSession } from "./agent-origin.js";
import { query } from "./db/pool.js";
import {
  checkAgentRateLimitBucket,
  resetAgentRateLimitBucketsForTests,
} from "./repositories/agent-rate-limits.js";
import { recordAgentWorkJournal } from "./repositories/orc-work-journal.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function rateLimitConfig(action = "") {
  const key = safeText(action, 80).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    max: Math.min(
      Math.max(
        numericEnv(
          `TASKNODE_AGENT_${key}_RATE_LIMIT_MAX`,
          action === "task_request" ? 3 : action === "task_submission" || action === "task_verification_response" ? 6 : 12
        ),
        1
      ),
      100
    ),
    windowMs: Math.min(
      Math.max(
        numericEnv(
          `TASKNODE_AGENT_${key}_RATE_LIMIT_WINDOW_MS`,
          numericEnv("TASKNODE_AGENT_QUALITY_GATE_WINDOW_MS", 60 * 60 * 1000)
        ),
        1000
      ),
      24 * 60 * 60 * 1000
    ),
  };
}

export function resetAgentQualityGateRateLimitsForTests() {
  resetAgentRateLimitBucketsForTests();
}

export function agentOriginForTaskSession(session = null, payload = {}, walletAddress = "") {
  const origin = agentOriginForWalletSession(session, payload, walletAddress);
  if (!origin) return null;
  return {
    ...origin,
    walletAddress: safeText(origin.walletAddress || walletAddress, 120),
  };
}

export async function checkAgentActionRateLimit({ agentOrigin = null, action = "", now = Date.now() } = {}) {
  if (!agentOrigin?.agent) return { ok: true, skipped: true };
  const normalizedAction = safeText(action || "agent_action", 80) || "agent_action";
  const config = rateLimitConfig(normalizedAction);
  const agentKey = safeText(agentOrigin.walletAddress || agentOrigin.accountId || agentOrigin.agentHandle, 180);
  return checkAgentRateLimitBucket({
    action: normalizedAction,
    agentKey,
    limit: config.max,
    windowMs: config.windowMs,
    now,
  });
}

export async function recordAgentActionJournal({
  agentOrigin = null,
  action = "",
  status = "recorded",
  outcomeStatus = "",
  blocker = "",
  accountId = "",
  taskId = "",
  requestId = "",
  cid = "",
  txHash = "",
  conversationId = "",
  metadata = {},
  idempotencyKey = "",
} = {}) {
  return recordAgentWorkJournal({
    agentOrigin,
    taskAction: action,
    status,
    outcomeStatus,
    blocker,
    accountId,
    sourceTaskId: taskId,
    requestId,
    cid,
    txHash,
    conversationId,
    metadata: {
      kind: action,
      ...metadata,
    },
    idempotencyKey,
  }).catch((error) => ({ ok: false, error: error?.message || "orc_work_journal_failed" }));
}

export async function enforceAgentActionRateLimit({
  agentOrigin = null,
  action = "",
  accountId = "",
  taskId = "",
  requestId = "",
  metadata = {},
} = {}) {
  const rateLimit = await checkAgentActionRateLimit({ agentOrigin, action });
  if (rateLimit.ok) return { ok: true, rateLimit };
  const orcWorkJournal = await recordAgentActionJournal({
    agentOrigin,
    action,
    status: "blocked",
    outcomeStatus: "rate_limited",
    blocker: "agent_rate_limit_exceeded",
    accountId,
    taskId,
    requestId,
    metadata: {
      ...metadata,
      rateLimit: {
        limit: rateLimit.limit,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        windowMs: rateLimit.windowMs,
      },
    },
    idempotencyKey: `agent_rate_limit:${action}:${agentOrigin?.walletAddress || agentOrigin?.accountId || ""}:${taskId || requestId || ""}:${rateLimit.resetAt || ""}`,
  });
  return {
    ok: false,
    status: 429,
    body: {
      ok: false,
      action,
      error: "agent_action_rate_limited",
      message: "Agent action rate limit exceeded. Retry after the indicated window.",
      actionRequired: "Wait for the rate-limit window to reset before submitting more autonomous actions.",
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      orcWorkJournal,
    },
  };
}

export function agentSelfDealingDecision({
  agentOrigin = null,
  accountId = "",
  walletAddress = "",
  task = {},
  taskRequest = {},
  action = "task_submission",
} = {}) {
  if (!agentOrigin?.agent) return { ok: true, skipped: true };
  const requestId = safeText(task?.request_id || task?.requestId || taskRequest?.request_id || taskRequest?.requestId, 180);
  if (!requestId) return { ok: true, skipped: true, reason: "request_id_missing" };
  const requestAccount = safeText(taskRequest?.account_id || taskRequest?.accountId, 180);
  const requestWallet = safeText(taskRequest?.subject_wallet || taskRequest?.subjectWallet, 120);
  const source = safeText(taskRequest?.source, 120).toLowerCase();
  const selfRequested = (
    source === "agent_capability_client" &&
    requestAccount &&
    requestWallet &&
    requestAccount === safeText(accountId, 180) &&
    requestWallet === safeText(walletAddress, 120)
  );
  if (!selfRequested) return { ok: true, skipped: true, reason: "not_agent_self_requested" };
  const normalizedAction = safeText(action || "task_submission", 80).toLowerCase();
  if (normalizedAction !== "task_verification_response") {
    return {
      ok: true,
      skipped: false,
      reason: "self_requested_submission_allowed_independent_verification_required",
      action,
      requestId,
    };
  }
  return {
    ok: false,
    error: "agent_self_dealing_blocked",
    status: 409,
    action,
    requestId,
    message: "Agent self-verification is blocked: an agent cannot answer verification on a task it requested for itself.",
    actionRequired: "Use an independent verifier for the submitted evidence before any reward decision.",
  };
}

export async function guardAgentSelfDealing({
  agentOrigin = null,
  accountId = "",
  walletAddress = "",
  task = {},
  action = "task_submission",
} = {}) {
  if (!agentOrigin?.agent) return { ok: true, skipped: true };
  const requestId = safeText(task?.request_id || task?.requestId, 180);
  if (!requestId) return { ok: true, skipped: true, reason: "request_id_missing" };
  const result = await query(
    `
      SELECT request_id, account_id, subject_wallet, source, requested_task_kind, status
      FROM task_requests
      WHERE request_id = $1
      LIMIT 1
    `,
    [requestId]
  );
  const decision = agentSelfDealingDecision({
    agentOrigin,
    accountId,
    walletAddress,
    task,
    taskRequest: result.rows[0] || {},
    action,
  });
  if (decision.ok) return decision;
  const orcWorkJournal = await recordAgentActionJournal({
    agentOrigin,
    action,
    status: "blocked",
    outcomeStatus: "self_dealing_blocked",
    blocker: "agent_self_dealing_blocked",
    accountId,
    taskId: safeText(task?.task_id || task?.taskId, 180),
    requestId,
    metadata: {
      taskStatus: safeText(task?.status, 80),
      taskRequest: result.rows[0] || {},
    },
    idempotencyKey: `agent_self_dealing:${action}:${agentOrigin.walletAddress || accountId}:${requestId}`,
  });
  return {
    ...decision,
    body: {
      ok: false,
      error: decision.error,
      message: decision.message,
      actionRequired: decision.actionRequired,
      requestId,
      orcWorkJournal,
    },
  };
}

export function agentDisclosureMetadata(agentOrigin = null) {
  if (!agentOrigin?.agent) return {};
  return {
    senderType: "machine_agent",
    agentOrigin,
  };
}
