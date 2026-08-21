import { agentOriginForWalletSession } from "./agent-origin.js";
import { query } from "./db/pool.js";
import {
  checkAgentRateLimitBucket,
  resetAgentRateLimitBucketsForTests,
} from "./repositories/agent-rate-limits.js";
import { recordAgentWorkJournal } from "./repositories/orc-work-journal.js";
import { getTaskAccountingCheckoutAccess } from "./repositories/task-accounting-harvester.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envSet(name = "") {
  return new Set(
    String(process.env[name] || "")
      .split(/[,\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function defaultRateLimitMax(action = "", { trusted = false } = {}) {
  if (trusted) {
    if (action === "task_request") return 20;
    if (action === "task_submission" || action === "task_verification_response") return 30;
    return 50;
  }
  if (action === "task_request") return 3;
  if (action === "task_submission" || action === "task_verification_response") return 6;
  return 12;
}

function explicitTrustedAgentMatch(agentOrigin = {}) {
  const wallet = safeText(agentOrigin.walletAddress, 120).toLowerCase();
  const accountId = safeText(agentOrigin.accountId, 180).toLowerCase();
  const handle = safeText(agentOrigin.agentHandle, 80).toLowerCase();
  return Boolean(
    (wallet && envSet("TASKNODE_TRUSTED_AGENT_WALLETS").has(wallet)) ||
      (accountId && envSet("TASKNODE_TRUSTED_AGENT_ACCOUNT_IDS").has(accountId)) ||
      (handle && envSet("TASKNODE_TRUSTED_AGENT_HANDLES").has(handle))
  );
}

async function trustedAgentRateLimitAccess(agentOrigin = {}) {
  if (!agentOrigin?.agent) return { trusted: false, reason: "not_machine_agent" };
  if (explicitTrustedAgentMatch(agentOrigin)) {
    return { trusted: true, reason: "trusted_agent_allowlist" };
  }
  const accountId = safeText(agentOrigin.accountId, 180);
  const walletAddress = safeText(agentOrigin.walletAddress, 120);
  if (!accountId) return { trusted: false, reason: "account_required" };
  try {
    const access = await getTaskAccountingCheckoutAccess({ accountId, walletAddress });
    return {
      trusted: Boolean(access.canCheckout),
      reason: access.hasCoreContributorBadge
        ? "core_contributor"
        : access.hasActiveOrcAgent
          ? "active_orc_agent"
          : "standard_machine_agent",
      access,
    };
  } catch (error) {
    return {
      trusted: false,
      reason: "trusted_agent_access_check_failed",
      error: safeText(error?.message || error, 240),
    };
  }
}

function rateLimitConfig(action = "", { trusted = false } = {}) {
  const key = safeText(action, 80).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const maxPrefix = trusted ? "TASKNODE_TRUSTED_AGENT" : "TASKNODE_AGENT";
  const trustedWindow = trusted ? numericEnv("TASKNODE_TRUSTED_AGENT_QUALITY_GATE_WINDOW_MS", 0) : 0;
  return {
    max: Math.min(
      Math.max(
        numericEnv(
          `${maxPrefix}_${key}_RATE_LIMIT_MAX`,
          defaultRateLimitMax(action, { trusted })
        ),
        1
      ),
      100
    ),
    windowMs: Math.min(
      Math.max(
        numericEnv(
          `${maxPrefix}_${key}_RATE_LIMIT_WINDOW_MS`,
          trustedWindow ||
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
  const trust = await trustedAgentRateLimitAccess(agentOrigin);
  const config = rateLimitConfig(normalizedAction, { trusted: trust.trusted });
  const agentKey = safeText(agentOrigin.walletAddress || agentOrigin.accountId || agentOrigin.agentHandle, 180);
  const result = await checkAgentRateLimitBucket({
    action: normalizedAction,
    agentKey,
    limit: config.max,
    windowMs: config.windowMs,
    now,
  });
  return {
    ...result,
    policy: {
      trusted: Boolean(trust.trusted),
      reason: trust.reason,
      tier: trust.trusted ? "trusted_agent" : "standard_agent",
      action: normalizedAction,
      limit: config.max,
      windowMs: config.windowMs,
    },
  };
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
        resetAt: rateLimit.resetAt ? new Date(rateLimit.resetAt).toISOString() : null,
        policy: rateLimit.policy || null,
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
      resetAt: rateLimit.resetAt ? new Date(rateLimit.resetAt).toISOString() : null,
      limit: rateLimit.limit,
      windowMs: rateLimit.windowMs,
      policy: rateLimit.policy || null,
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
  if (normalizedAction === "task_submission" || normalizedAction === "task_verification_response") {
    return {
      ok: true,
      skipped: false,
      reason: normalizedAction === "task_verification_response"
        ? "self_requested_verification_response_allowed_independent_reward_required"
        : "self_requested_submission_allowed_independent_review_required",
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
    message: "Agent self-dealing is blocked: an agent cannot perform this terminal or privileged action on a task it requested for itself.",
    actionRequired: "Use an independent reviewer or guarded operator path before any reward, enforcement, or accounting decision.",
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
