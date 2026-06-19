import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  anyChatProviderEnabled,
  chatExecutionStatus,
  chatModePrices,
  chatProviderConfigured,
  executeChat,
  isKnownChatMode,
  logChatProviderError,
  normalizedChatMode,
} from "./chat-router.js";
import { effectiveDefaultChatMode } from "./chat-mode-defaults.js";
import {
  contextEditMode,
  executeContextEditChat,
  isContextEditPayload,
} from "./context-edit-chat.js";
import { chatEstimate, chatEstimateForAccount } from "./chat-estimate.js";
export { chatEstimate, chatEstimateForAccount } from "./chat-estimate.js";
import {
  consumeWalletChallenge,
  consumeEmailChallenge,
  createWalletChallenge,
  createAccountSession,
  createDevSession,
  createEmailChallenge,
  delinkWalletFromAccount,
  findAccountByEmail,
  getEmailChallenge,
  getOrCreateEmailAccount,
  linkWalletToAccount,
  completeWalletInitiationGrant,
  failWalletInitiationGrant,
  recordAuthEvent,
  getLinkedWallet,
  reserveWalletInitiationGrant,
  resolveWalletInitiationGrantStatus,
  walletInitiationGrantStatus,
} from "./runtime-store.js";
import {
  authTelegramAuthorize,
  oauthAuthCallback,
  oauthAuthProviders,
  oauthAuthStart,
} from "./auth-connected-accounts.js";
export { authTelegramAuthorize } from "./auth-connected-accounts.js";
import {
  appendUsageCredit,
  chatBillingStatus,
  getChatMessages,
  usageSummary,
} from "./repositories/chat-billing.js";
import {
  recordChatFailureObservability,
  recordUserObservabilityEvent,
} from "./repositories/user-observability.js";
import { loadChatExecutionContext } from "./chat-context-load.js";
import { normalizeClientChatHistory } from "./chat-client-history.js";
import { validateChatAttachments } from "./chat-attachment-utils.js";
import { isHelpChatMode } from "./chat-help-mode.js";
import {
  getContextHistory,
  saveContextDocument,
} from "./repositories/context.js";
import { getActiveContextEditProposal } from "./repositories/context-edit.js";
import { fetchContextIpfsJson, normalizeContextCid } from "./context-ipfs.js";
import { contextPublishStatus } from "./context-publish.js";
export { contextManifestInk } from "./context-publish.js";
export { taskLifecycleAction } from "./task-actions.js";
export { taskRequestAction } from "./task-request.js";
import {
  ethereumDepositConfigStatus,
  getOrCreateVerifiedEthereumTopUpAccount,
  maybeClaimUsdcTopUpInitiationGift,
  syncEthereumTopUpAccount,
} from "./ethereum-deposits.js";
import {
  pftInitiationFaucetStatus,
  sendPftInitiationGift,
} from "./pftl-faucet.js";
import {
  bestEffortDeactivatePftlSyncWallet,
  bestEffortRegisterPftlSyncWallet,
} from "./pftl-cache-sync.js";
import { verifyWalletSignature } from "./wallet-proof.js";
export { taskRequestIntentStart } from "./task-request-intent.js";

function hasAll(keys) {
  return keys.every((key) => Boolean(process.env[key]));
}

function hasAny(keys) {
  return keys.some((key) => Boolean(process.env[key]));
}

function currentEnvironment() {
  return process.env.TASKNODE_ENV || process.env.NODE_ENV || "development";
}

function devAuthEnabled() {
  if (process.env.TASKNODE_DEV_AUTH_ENABLED === "true") return true;
  if (process.env.TASKNODE_DEV_AUTH_ENABLED === "false") return false;
  return !["prod", "production"].includes(currentEnvironment().toLowerCase());
}

function authSecret() {
  return (
    process.env.TASKNODE_AUTH_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.SESSION_SECRET ||
    ""
  );
}

function authSecretReady() {
  if (authSecret()) return true;
  return !["prod", "production"].includes(currentEnvironment().toLowerCase());
}

function authHmac(value) {
  const secret = authSecret() || "tasknodeofficial-local-email-dev-secret";
  return createHmac("sha256", secret).update(String(value || "")).digest("hex");
}

function safeEqualText(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function safeEventText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

async function recordUsageObservabilityEvent({
  eventType = "",
  accountId = "",
  action = "",
  resultStatus = "",
  reasonCode = "",
  depositAccount = null,
  creditedEntries = [],
  metadata = {},
  metrics = {},
  sourceRoute = "",
} = {}) {
  if (!accountId || !eventType) return;
  const entries = Array.isArray(creditedEntries) ? creditedEntries : [];
  await recordUserObservabilityEvent({
    eventType,
    accountId,
    sourceSurface: "billing",
    sourceRoute: sourceRoute || `server/product-contracts.js::${action || "usage"}`,
    resultStatus,
    reasonCode,
    metrics: {
      creditedEntryCount: entries.length,
      creditedAmountUsd: entries.reduce((sum, entry) => sum + Number(entry?.amountUsd || 0), 0),
      ...metrics,
    },
    metadata: {
      action: safeEventText(action, 120),
      depositAccountId: safeEventText(depositAccount?.id, 180),
      depositAddress: safeEventText(depositAccount?.address, 120),
      creditedLedgerEntryIds: entries.map((entry) => safeEventText(entry?.id, 180)).filter(Boolean),
      ...metadata,
    },
  }).catch(() => {});
}

function recordAuthObservabilityEvents({
  accountId = "",
  provider = "",
  providerUserId = "",
  sessionId = "",
  sourceRoute = "",
  resultStatus = "",
  reasonCode = "",
  includeProviderLinked = true,
  metadata = {},
} = {}) {
  if (!accountId || !provider) return;
  const common = {
    accountId,
    provider,
    providerUserId,
    sessionId,
    sourceSurface: "auth",
    sourceRoute: sourceRoute || "server/product-contracts.js::auth",
  };
  const events = [];
  if (includeProviderLinked) {
    events.push(recordUserObservabilityEvent({
      ...common,
      eventType: "user.provider.linked",
      resultStatus: resultStatus || "verified",
      reasonCode: reasonCode || provider,
      metadata,
    }));
  }
  events.push(recordUserObservabilityEvent({
    ...common,
    eventType: "user.session.started",
    resultStatus: "started",
    reasonCode: reasonCode || provider,
    metadata: {
      provider,
      ...metadata,
    },
  }));
  Promise.allSettled(events).catch(() => {});
}

const clientObservabilityEventTypes = new Set([
  "user.ui.blocker_shown",
  "user.ui.sync_warning_shown",
  "user.ui.action_disabled",
  "user.ui.action_recovered",
  "user.wallet.selected",
]);

function safeClientObject(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 24)) {
    const key = safeEventText(rawKey, 80).replace(/[^A-Za-z0-9_.:-]/g, "_");
    if (!key) continue;
    if (rawValue === null || rawValue === undefined) {
      result[key] = "";
    } else if (typeof rawValue === "boolean") {
      result[key] = rawValue;
    } else if (typeof rawValue === "number") {
      result[key] = Number.isFinite(rawValue) ? rawValue : 0;
    } else if (typeof rawValue === "string") {
      result[key] = safeEventText(rawValue, 240);
    } else if (Array.isArray(rawValue)) {
      result[key] = rawValue.slice(0, 12).map((item) => (
        typeof item === "number" && Number.isFinite(item)
          ? item
          : typeof item === "boolean"
            ? item
            : safeEventText(item, 120)
      ));
    } else if (depth < 1) {
      result[key] = safeClientObject(rawValue, depth + 1);
    }
  }
  return result;
}

function normalizeAgentChatOrigin(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.agent !== true && value.actorType !== "machine_agent") return null;
  return {
    agent: true,
    actorType: "machine_agent",
    source: safeEventText(value.source || "wallet_login", 80) || "wallet_login",
    sessionProvider: safeEventText(value.sessionProvider || "wallet", 80) || "wallet",
    accountId: safeEventText(value.accountId, 180),
    agentHandle: safeEventText(value.agentHandle || value.agent || value.handle, 80),
    walletAddress: safeEventText(value.walletAddress || value.address, 120),
    client: safeEventText(value.client || "TaskNodeAgentClient", 120) || "TaskNodeAgentClient",
  };
}

function chatUserMetadata(payload = {}, agentOrigin = null) {
  const metadata = safeClientObject(payload?.metadata || payload?.metadata_json);
  const normalizedAgentOrigin = normalizeAgentChatOrigin(agentOrigin);
  if (!normalizedAgentOrigin) {
    delete metadata.agentOrigin;
    if (metadata.senderType === "machine_agent" || metadata.senderType === "agent") {
      delete metadata.senderType;
    }
    return metadata;
  }
  return {
    ...metadata,
    senderType: "machine_agent",
    agentOrigin: normalizedAgentOrigin,
  };
}

function emailCodeHash({ challengeId, canonicalEmail, code }) {
  return authHmac(`email-code:${challengeId}:${canonicalEmail}:${String(code || "").trim()}`);
}

function emailDeliveryProvider() {
  return String(process.env.EMAIL_DELIVERY_PROVIDER || "").trim().toLowerCase();
}

function resendConfigured() {
  const key = process.env.RESEND_API_KEY || process.env.EMAIL_PROVIDER_API_KEY;
  return Boolean(
    (emailDeliveryProvider() === "resend" || (!emailDeliveryProvider() && key)) &&
      key &&
      process.env.EMAIL_FROM
  );
}

function emailDevDeliveryEnabled({ resendReady = resendConfigured() } = {}) {
  if (process.env.TASKNODE_EMAIL_DEV_DELIVERY === "true") return true;
  if (process.env.TASKNODE_EMAIL_DEV_DELIVERY === "false") return false;
  if (resendReady) return false;
  return (
    process.env.NODE_ENV !== "production" &&
    !["prod", "production"].includes(currentEnvironment().toLowerCase())
  );
}

function emailDeliveryStatus() {
  const resendReady = resendConfigured();
  const devDelivery = emailDevDeliveryEnabled({ resendReady });
  const configured = authSecretReady() && (devDelivery || resendReady);
  const mode = devDelivery ? "development" : resendReady ? "resend" : "unconfigured";

  return {
    configured,
    enabled: configured,
    mode,
    status: configured ? "ready" : authSecretReady() ? "missing_config" : "missing_auth_secret",
    startPath: "/api/auth/email/start",
    verifyPath: "/api/auth/email/verify",
    codeTtlSeconds: emailCodeTtlSeconds(),
    actionRequired: configured
      ? "Request an email code, then verify it before issuing a session."
      : authSecretReady()
        ? "Configure TASKNODE_EMAIL_DEV_DELIVERY=true for local/dev testing or configure EMAIL_DELIVERY_PROVIDER=resend, EMAIL_FROM, and RESEND_API_KEY."
        : "Configure TASKNODE_AUTH_SECRET before enabling production email login.",
  };
}

function emailCodeTtlSeconds() {
  const ttl = Number(process.env.TASKNODE_EMAIL_CODE_TTL_SECONDS || 600);
  if (!Number.isFinite(ttl)) return 600;
  return Math.min(Math.max(Math.floor(ttl), 120), 1800);
}

function normalizeEmailInput(value) {
  const original = String(value || "").trim();
  if (!original || original.length > 254 || /[\s<>()[\]\\,;:"]/.test(original)) {
    return { ok: false, error: "email_invalid" };
  }

  const atIndex = original.lastIndexOf("@");
  if (atIndex <= 0 || atIndex !== original.indexOf("@") || atIndex === original.length - 1) {
    return { ok: false, error: "email_invalid" };
  }

  const local = original.slice(0, atIndex);
  const domain = original.slice(atIndex + 1).toLowerCase();
  if (!local || !domain || domain.length > 253 || !domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) {
    return { ok: false, error: "email_invalid" };
  }

  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..")) {
    return { ok: false, error: "email_invalid" };
  }

  return {
    ok: true,
    email: original,
    canonicalEmail: `${local.toLowerCase()}@${domain}`,
  };
}

function maskEmail(email) {
  const normalized = normalizeEmailInput(email);
  if (!normalized.ok) return "that email";

  const [local, domain] = normalized.canonicalEmail.split("@");
  const localMask =
    local.length <= 1
      ? "*"
      : `${local.slice(0, 1)}${"*".repeat(Math.min(local.length - 1, 5))}`;
  return `${localMask}@${domain}`;
}

function generateEmailCode() {
  return String(randomInt(0, 100000000)).padStart(8, "0");
}

async function sendResendEmailCode({ email, code, expiresInMinutes }) {
  const apiKey = process.env.RESEND_API_KEY || process.env.EMAIL_PROVIDER_API_KEY;
  const from = process.env.EMAIL_FROM;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "Your Task Node sign-in code",
        text: `Your Task Node sign-in code is ${code}. It expires in ${expiresInMinutes} minutes. If you did not request this code, you can ignore this email.`,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`resend_http_${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverEmailCode({ email, code, expiresInSeconds }) {
  const status = emailDeliveryStatus();
  if (!status.enabled) {
    const error = new Error(status.actionRequired);
    error.code = status.status;
    throw error;
  }

  if (status.mode === "development") {
    return { mode: "development", devCode: code };
  }

  if (status.mode === "resend") {
    await sendResendEmailCode({
      email,
      code,
      expiresInMinutes: Math.ceil(expiresInSeconds / 60),
    });
    return { mode: "email" };
  }

  const error = new Error("Email delivery is not configured.");
  error.code = "email_delivery_not_configured";
  throw error;
}

function actionResponse({ status, error, action, message, actionRequired }) {
  return {
    status,
    body: {
      ok: false,
      error,
      action,
      message,
      actionRequired,
    },
  };
}

function emailProvider() {
  const status = emailDeliveryStatus();

  return {
    id: "email",
    label: "Email",
    kind: "email_code",
    configured: status.configured,
    enabled: status.enabled,
    status: status.status,
    startPath: status.startPath,
    verifyPath: status.verifyPath,
    codeTtlSeconds: status.codeTtlSeconds,
    deliveryMode: status.mode,
    actionRequired: status.actionRequired,
    note:
      "Email is a low-assurance account login and recovery path. It does not claim legacy wallet ownership by itself.",
  };
}

function walletAction({ id, label, path, requiredEnv = [], enabled = false, status, note, actionRequired }) {
  const configured = hasAll(requiredEnv);

  return {
    id,
    label,
    path,
    method: "POST",
    configured,
    enabled: configured && enabled,
    status: status || (configured ? (enabled ? "ready" : "disabled") : "missing_config"),
    actionRequired: configured ? actionRequired : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}

function contextAction({ id, label, path, method = "POST", requiredEnv = [], enabled = false, status, note, actionRequired }) {
  const configured = hasAll(requiredEnv);

  return {
    id,
    label,
    path,
    method,
    configured,
    enabled: configured && enabled,
    status: status || (configured ? (enabled ? "ready" : "disabled") : "missing_config"),
    actionRequired: configured ? actionRequired : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}

function usageAction({ id, label, path, requiredEnv = [], enabled = false, status, note, actionRequired }) {
  const configured = hasAll(requiredEnv);

  return {
    id,
    label,
    path,
    method: "POST",
    configured,
    enabled: configured && enabled,
    status: status || (configured ? (enabled ? "ready" : "disabled") : "missing_config"),
    actionRequired: configured ? actionRequired : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}

function chatPayload(payload, { source = "", providerTimeoutMs = 0, agentOrigin = null } = {}) {
  const accountId = typeof payload?.accountId === "string" ? payload.accountId.trim().slice(0, 160) : "";
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  const contextMode = isContextEditPayload(payload) ? contextEditMode : "";
  const requestedMode = typeof payload?.mode === "string" ? payload.mode.trim() : "";
  const mode = contextMode ? "Frontier Thinking" : requestedMode || effectiveDefaultChatMode();
  const conversationId =
    typeof payload?.conversationId === "string" && payload.conversationId.trim()
      ? payload.conversationId.trim().slice(0, 160)
      : "dev";
  const dryRun = payload?.dryRun === true;
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const clientHistory = normalizeClientChatHistory(payload?.clientHistory);
  return {
    accountId,
    message,
    mode: isKnownChatMode(mode) ? normalizedChatMode(mode) : "",
    requestedMode: mode,
    contextMode,
    conversationId,
    dryRun,
    attachments,
    clientHistory,
    userMetadata: chatUserMetadata(payload, agentOrigin),
    source: typeof source === "string" ? source.trim().slice(0, 80) : "",
    providerTimeoutMs: Number(providerTimeoutMs) > 0 ? Number(providerTimeoutMs) : 0,
  };
}

function chatAttachmentFailureBody(action, validation, estimate) {
  const tooLarge = validation.status === 413;
  return {
    ok: false,
    error: tooLarge ? "chat_attachment_too_large" : "chat_attachment_invalid",
    action,
    message: tooLarge
      ? "One or more attachments are too large."
      : "One or more attachments could not be accepted.",
    actionRequired: action === "chat_estimate"
      ? "Remove or replace the failed attachments before estimating chat."
      : "Remove or replace the failed attachments before sending.",
    attachmentErrors: validation.errors,
    estimate,
  };
}

function unknownChatModeBody(action = "chat_estimate") {
  return {
    ok: false,
    error: "unknown_chat_mode",
    action,
    message: "The requested chat mode is not available.",
    actionRequired: "Choose one of the configured chat modes before sending.",
  };
}

export async function chatEstimateStart(payload, accountId = "") {
  const attachmentValidation = validateChatAttachments(payload?.attachments);
  const estimatePayload = {
    ...payload,
    attachments: attachmentValidation.ok ? attachmentValidation.attachments : [],
  };

  let estimate;
  try {
    estimate = attachmentValidation.ok
      ? await chatEstimateForAccount(estimatePayload, accountId)
      : chatEstimate(estimatePayload);
  } catch (error) {
    if (error?.message === "unknown_chat_mode") {
      return { status: 400, body: unknownChatModeBody("chat_estimate") };
    }
    throw error;
  }

  if (!attachmentValidation.ok) {
    return {
      status: attachmentValidation.status,
      body: chatAttachmentFailureBody("chat_estimate", attachmentValidation, estimate),
    };
  }

  return { status: 200, body: estimate };
}

async function chatExecutionPreflight(payload, method, action = "chat_send", options = {}) {
  let chat = chatPayload(payload, options);
  let estimate = null;

  if (!chat.mode) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "unknown_chat_mode",
        action,
        message: "The requested chat mode is not available.",
        actionRequired: "Choose one of the configured chat modes before sending.",
      },
      chat,
      estimate,
    };
  }

  estimate = chatEstimate({ ...payload, mode: chat.mode, attachments: chat.attachments });

  if (method !== "POST") {
    return {
      ok: false,
      status: 405,
      body: {
        ok: false,
        error: `${action}_method_not_allowed`,
        action,
        message: action === "chat_stream" ? "Chat stream requires POST." : "Chat send requires POST.",
        actionRequired: "Send chat payloads with POST.",
      },
      chat,
      estimate,
    };
  }

  if (!chat.message && chat.attachments.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: "chat_message_required",
        action,
        message: action === "chat_stream"
          ? "Chat stream requires a non-empty message."
          : "Chat send requires a non-empty message.",
        actionRequired: "Send a message before requesting chat execution.",
      },
      chat,
      estimate,
    };
  }

  const signedOutHelp = !chat.accountId && isHelpChatMode(chat.mode) && !chat.contextMode;
  if (!chat.accountId && !signedOutHelp) {
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: "chat_login_required",
        action,
        message: "Sign in before sending billable chat requests.",
        actionRequired: "Use an account login before starting chat execution.",
        estimate,
      },
      chat,
      estimate,
    };
  }

  const attachmentValidation = validateChatAttachments(chat.attachments);
  if (!attachmentValidation.ok) {
    estimate = chatEstimate({ ...payload, mode: chat.mode, attachments: [] });
    return {
      ok: false,
      status: attachmentValidation.status,
      body: chatAttachmentFailureBody(action, attachmentValidation, estimate),
      chat,
      estimate,
    };
  }
  chat = { ...chat, attachments: attachmentValidation.attachments };
  const estimatePayload = { ...payload, mode: chat.mode, attachments: chat.attachments };
  estimate = chatEstimate(estimatePayload, signedOutHelp ? { historyMessages: chat.clientHistory } : undefined);

  if (chat.dryRun) {
    if (signedOutHelp) {
      return {
        ok: false,
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          action,
          conversationId: chat.conversationId,
          message: estimate.executionReady
            ? "Help chat is configured. Dry run skipped the provider call."
            : "Help chat is not configured in this environment. Dry run skipped the provider call.",
          estimate,
          contextStatus: null,
        },
        chat: {
          ...chat,
          contextDocument: null,
          memoryContext: null,
          taskContext: null,
          contextStatus: null,
        },
        estimate,
      };
    }

    const [executionContext, historyMessages, activeProposal] = await Promise.all([
      loadChatExecutionContext(chat.accountId),
      chat.accountId && chat.conversationId
        ? getChatMessages({ accountId: chat.accountId, conversationId: chat.conversationId, limit: 12 }).catch(() => [])
        : [],
      chat.accountId && chat.conversationId && chat.contextMode === contextEditMode
        ? getActiveContextEditProposal({ accountId: chat.accountId, conversationId: chat.conversationId }).catch(() => null)
        : null,
    ]);
    estimate = chatEstimate(estimatePayload, {
      contextDocument: executionContext.contextDocument,
      memoryContext: executionContext.memoryContext,
      taskContext: executionContext.taskContext,
      historyMessages,
      activeProposal,
    });
    return {
      ok: false,
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        action,
        conversationId: chat.conversationId,
        message: estimate.executionReady
          ? "Chat execution is configured. Dry run skipped the provider call."
          : "Chat execution is not configured for this mode. Dry run skipped the provider call.",
        estimate,
        contextStatus: executionContext.contextStatus,
      },
      chat: {
        ...chat,
        contextDocument: executionContext.contextDocument,
        memoryContext: executionContext.memoryContext,
        taskContext: executionContext.taskContext,
        contextStatus: executionContext.contextStatus,
      },
      estimate,
    };
  }

  if (!estimate.executionReady) {
    const configured = estimate.providerConfigured;
    return {
      ok: false,
      status: configured ? 503 : 409,
      body: {
        ok: false,
        error: configured ? "chat_provider_disabled" : "chat_provider_not_configured",
        action,
        message: `${chat.mode} is not enabled for chat execution in this environment.`,
        actionRequired: configured
          ? `Enable and verify the ${estimate.provider} route for this mode or choose a ready mode.`
          : `Configure the ${estimate.provider} provider for this mode or choose a ready mode.`,
        estimate,
      },
      chat,
      estimate,
    };
  }

  if (signedOutHelp) {
    return {
      ok: true,
      status: 200,
      chat: {
        ...chat,
        contextDocument: null,
        memoryContext: null,
        taskContext: null,
        contextStatus: null,
        clientHistory: chat.clientHistory,
        ephemeralHistoryMessages: chat.clientHistory,
      },
      estimate,
    };
  }

  const executionContext = await loadChatExecutionContext(chat.accountId);
  const [historyMessages, activeProposal] = await Promise.all([
    chat.accountId && chat.conversationId
      ? getChatMessages({ accountId: chat.accountId, conversationId: chat.conversationId, limit: 12 }).catch(() => [])
      : [],
    chat.accountId && chat.conversationId && chat.contextMode === contextEditMode
      ? getActiveContextEditProposal({ accountId: chat.accountId, conversationId: chat.conversationId }).catch(() => null)
      : null,
  ]);
  estimate = chatEstimate(estimatePayload, {
    contextDocument: executionContext.contextDocument,
    memoryContext: executionContext.memoryContext,
    taskContext: executionContext.taskContext,
    historyMessages,
    activeProposal,
  });

  const usage = await usageSummary({ accountId: chat.accountId, conversationId: chat.conversationId });
  if (Number(usage.availableCreditUsd || 0) < Number(estimate.estimatedUsd || 0)) {
    return {
      ok: false,
      status: 402,
      body: {
        ok: false,
        error: "chat_credit_required",
        action,
        message: "Available chat credit is too low for this request.",
        actionRequired: "Top up the account balance or use an account with available credit.",
        estimate,
        contextStatus: executionContext.contextStatus,
        usage: {
          billingModel: "usage_based",
          currency: "USD",
          currentSpendUsd: usage.currentSpendUsd,
          currentCreditUsd: usage.currentCreditUsd,
          availableCreditUsd: usage.availableCreditUsd,
          ledgerEntryCount: usage.ledgerEntryCount,
        },
      },
      chat,
      estimate,
    };
  }

  return {
    ok: true,
    status: 200,
    chat: {
      ...chat,
      contextDocument: executionContext.contextDocument,
      memoryContext: executionContext.memoryContext,
      taskContext: executionContext.taskContext,
      contextStatus: executionContext.contextStatus,
    },
    estimate,
  };
}

export async function chatSend(payload, method, options = {}) {
  const preflight = await chatExecutionPreflight(payload, method, "chat_send", options);
  const {
    accountId,
    message,
    mode,
    conversationId,
    attachments,
    contextDocument,
    memoryContext,
    taskContext,
    contextStatus,
    clientHistory,
    userMetadata,
  } = preflight.chat;
  const { estimate } = preflight;
  if (!preflight.ok) return { status: preflight.status, body: preflight.body };

  try {
    const result = preflight.chat.contextMode === contextEditMode
      ? await executeContextEditChat({
          accountId,
          message,
          conversationId,
          attachments,
          contextDocument,
          memoryContext,
          taskContext,
          contextStatus,
          userMetadata,
        })
      : await executeChat({
          accountId,
          mode,
          message,
          conversationId,
          attachments,
          contextDocument,
          memoryContext,
          taskContext,
          contextStatus,
          userMetadata,
          ephemeralHistoryMessages: clientHistory,
          source: preflight.chat.source,
          providerTimeoutMs: preflight.chat.providerTimeoutMs,
        });
    return {
      status: 200,
      body: {
        ok: true,
        action: "chat_send",
        message: "Chat response generated.",
        conversationId,
        mode,
        provider: result.provider,
        model: result.model,
        responseId: result.responseId,
        user: result.user,
        assistant: result.assistant,
        estimate,
        contextStatus: result.contextStatus || contextStatus,
        usage: {
          billingModel: "usage_based",
          currency: "USD",
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          webSearchCalls: result.usage.webSearchCalls || 0,
          toolCostUsd: result.usage.toolCostUsd || 0,
          costUsd: result.usage.costUsd,
        },
        ledgerEntry: result.ledgerEntry,
      },
    };
  } catch (error) {
    const status = error?.status || 502;
    logChatProviderError(error, {
      action: "chat_send",
      mode,
      provider: estimate?.provider,
      model: estimate?.model,
    });
    await recordChatFailureObservability({
      accountId,
      conversationId,
      mode,
      provider: estimate?.provider,
      model: estimate?.model,
      status,
      error,
      sourceRoute: "server/product-contracts.js::chatSend",
    }).catch(() => {});
    return {
      status,
      body: {
        ok: false,
        error: error?.message || "chat_provider_error",
        action: "chat_send",
        message:
          status === 504
            ? "The chat provider timed out before returning a response."
            : "The chat provider could not complete this response.",
        actionRequired:
          "Retry with a shorter prompt, choose another configured mode, or check provider health.",
        providerStatus: status,
        providerMessage: error?.providerMessage || "",
        estimate,
      },
    };
  }
}

export async function chatStreamStart(payload, method, options = {}) {
  const preflight = await chatExecutionPreflight(payload, method, "chat_stream", options);
  if (!preflight.ok) return { status: preflight.status, body: preflight.body };
  if (preflight.chat.contextMode === contextEditMode) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "context_edit_requires_send",
        action: "chat_stream",
        message: "Context Edit uses the non-streaming chat route so the structured proposal can be validated before display.",
        actionRequired: "Send Context Edit requests through /api/chat/send.",
        estimate: preflight.estimate,
      },
    };
  }

  return {
    status: 200,
    stream: true,
    chat: preflight.chat,
    estimate: preflight.estimate,
    body: {
      ok: true,
      action: "chat_stream",
      conversationId: preflight.chat.conversationId,
      mode: preflight.chat.mode,
      provider: preflight.estimate.provider,
      model: preflight.estimate.model,
      estimate: preflight.estimate,
      contextStatus: preflight.chat.contextStatus,
    },
  };
}

export function chatModes({ signedOut = false } = {}) {
  return Object.keys(chatModePrices).map((label) => {
    const status = chatExecutionStatus(label);
    const config = chatModePrices[label];
    const loginRequired = signedOut && !isHelpChatMode(label);
    return {
      label,
      provider: status.provider,
      providerLabel: status.providerLabel,
      model: status.model,
      configured: status.configured,
      enabled: loginRequired ? false : status.enabled,
      status: loginRequired ? "login_required" : status.status,
      actionRequired: loginRequired ? "Sign in to use billable chat modes." : undefined,
      privacy: status.provider === "openrouter"
        ? "Private provider route"
        : status.provider === "deepseek"
          ? "DeepSeek API Direct"
          : "Frontier provider route",
      latency: config.reasoningEffort ? "Deep" : "Fast",
    };
  });
}

export function authProviders() {
  return [
    ...oauthAuthProviders(),
    emailProvider(),
  ];
}

function authLaunchBlockers(providers, emailStatus) {
  const blockers = [];
  for (const provider of providers) {
    if (provider.id === "email") continue;
    if (!provider.configured) {
      blockers.push(`${provider.label} is missing required configuration.`);
      continue;
    }
    if (!provider.enabled) {
      blockers.push(`${provider.label} is configured but not enabled.`);
      continue;
    }
    if (provider.status && provider.status !== "ready") {
      blockers.push(`${provider.label} status is ${provider.status}.`);
    }
  }
  if (!emailStatus.enabled) blockers.push(emailStatus.actionRequired);
  return blockers;
}

export function devAuthStatus() {
  const enabled = devAuthEnabled();

  return {
    enabled,
    status: enabled ? "ready" : "disabled",
    startPath: "/api/auth/dev/start",
    logoutPath: "/api/auth/logout",
    note:
      "Development-only account session path for exercising the account-first product boundary before production OAuth is enabled.",
  };
}

export function walletActions() {
  return [
    walletAction({
      id: "create_start",
      label: "Create seed wallet",
      path: "/api/wallet/create/start",
      enabled: true,
      note:
        "Generates a new 24-word seed wallet in the browser, links it by proof, saves the local vault, and then attempts the one-time initiation grant.",
      actionRequired:
        "OAuth accounts can receive the grant after the encrypted local seed vault is saved. Email accounts can qualify after creating a wallet, saving the vault, and crediting more than $10 USDC.",
    }),
    walletAction({
      id: "link_start",
      label: "Link seed wallet",
      path: "/api/wallet/link/start",
      enabled: true,
      note:
        "Starts a browser-only seed wallet proof. The seed phrase never leaves the device.",
      actionRequired:
        "Enter a 24-word recovery phrase locally, derive the XRPL address in the browser, and sign the server challenge.",
    }),
    walletAction({
      id: "unlock_start",
      label: "Unlock wallet action",
      path: "/api/wallet/unlock/start",
      requiredEnv: ["PFTL_RPC_URL", "PFTL_RPC_API_KEY"],
      note:
        "Unlocks only wallet-bound actions such as sending PFT, signing verifications, or inking context manifests.",
      actionRequired:
        "Implement unlock transaction boundaries and signing confirmation screens before enabling wallet unlock.",
    }),
    walletAction({
      id: "send_pft",
      label: "Send PFT",
      path: "/api/wallet/send/prepare",
      enabled: true,
      note:
        "Prepares a native PFTL Payment for the linked wallet. The browser signs locally and submits the signed blob to /api/wallet/send/submit.",
      actionRequired:
        "Unlock the matching local seed vault, enter a destination and amount, review the payment, then sign locally.",
    }),
    walletAction({
      id: "delink",
      label: "Delink wallet",
      path: "/api/wallet/delink",
      enabled: true,
      note:
        "Detaches the active wallet from this app account without touching chain history or server-side audit history.",
      actionRequired:
        "Confirm delink in the wallet tab. The browser should also clear the local encrypted vault.",
    }),
    walletAction({
      id: "relink_start",
      label: "Relink wallet",
      path: "/api/wallet/relink/start",
      enabled: true,
      note:
        "Starts a fresh wallet ownership proof for linking a wallet after delink or replacing the current proof.",
      actionRequired:
        "Enter the recovery phrase locally and sign a fresh relink challenge.",
    }),
    walletAction({
      id: "initiation_retry",
      label: "Retry initiation gift",
      path: "/api/wallet/initiation/retry",
      enabled: true,
      note:
        "Retries the one-time PFT initiation gift for a linked wallet only after the matching local seed vault is confirmed in the browser.",
      actionRequired:
        "Requires a signed-in account, a linked wallet, a confirmed local seed vault, and configured PFTL faucet credentials.",
    }),
  ];
}

export function contextActions() {
  return [
    contextAction({
      id: "import_shared_url",
      label: "Import shared URL",
      path: "/api/context/import/start",
      requiredEnv: ["IPFS_API_URL"],
      note:
        "Imports Google Docs, Notion, Gist, or other shared document URLs into a cacheable context record.",
      actionRequired:
        "Implement URL evidence checks, document fetch adapters, cache storage, and user confirmation before enabling context import.",
    }),
    contextAction({
      id: "save_edit",
      label: "Save context edit",
      path: "/api/context/edit/save",
      enabled: true,
      note:
        "Saves native context edits without inking a PFTL transaction by default.",
      actionRequired:
        "Sign in with an account, edit the native context document, and save it without wallet unlock.",
    }),
    contextAction({
      id: "fetch_history_cid",
      label: "Fetch historical CID",
      path: "/api/context/history/ipfs/:cid",
      method: "GET",
      enabled: true,
      note:
        "Fetches encrypted JSON only for CIDs already present in the signed-in account's cached PFTL context projection.",
      actionRequired:
        "Unlock the local seed vault in the browser before decrypting fetched CID content.",
    }),
    contextAction({
      id: "ink_manifest",
      label: "Ink PFTL manifest",
      path: "/api/context/manifest/ink",
      enabled: true,
      note:
        "Encrypts the native context document, pins it to IPFS, and signs a portable pf.ptr/v4 CONTEXT pointer from the unlocked wallet.",
      actionRequired:
        "Unlock the local seed vault in the browser. The seed never leaves the device; the server only receives the encrypted payload and signed transaction blob.",
    }),
  ];
}

export function usageActions() {
  const ethDeposits = ethereumDepositConfigStatus();

  return [
    usageAction({
      id: "top_up_start",
      label: "Top up with ETH, USDC, or USDT",
      path: "/api/usage/top-up/start",
      enabled: ethDeposits.enabled,
      status: ethDeposits.status,
      note:
        "Allocates one account-scoped Ethereum mainnet deposit address. This is a custodial top-up rail, not a wallet-connect flow.",
      actionRequired: ethDeposits.actionRequired,
    }),
    usageAction({
      id: "top_up_sync",
      label: "Refresh Ethereum deposits",
      path: "/api/usage/top-up/sync",
      enabled: ethDeposits.enabled && ethDeposits.rpcConfigured,
      status: ethDeposits.enabled && ethDeposits.rpcConfigured ? "ready" : ethDeposits.status,
      note:
        "Reads the account deposit address on Ethereum mainnet, credits configured ETH, USDC, and USDT balance increases, and sends the one-time PFT grant after a qualifying USDC top-up for a newly created linked wallet.",
      actionRequired: ethDeposits.rpcConfigured
        ? ethDeposits.actionRequired
        : "Configure ETH_DEPOSIT_RPC_URL or ETHEREUM_RPC_URL for deposit balance sync.",
    }),
    usageAction({
      id: "admin_credit",
      label: "Admin credit",
      path: "/api/usage/credit/admin",
      requiredEnv: ["TASKNODE_ADMIN_CREDIT_TOKEN"],
      enabled: true,
      note:
        "Operator-only bootstrap path for crediting account balances while real crypto top-up rails are not implemented.",
      actionRequired:
        "Configure TASKNODE_ADMIN_CREDIT_TOKEN and send an authorized server-to-server credit request.",
    }),
  ];
}

export function contextActionByPath(pathname) {
  return contextActions().find((action) => action.path === pathname) || null;
}

export function contextActionStart(pathname, method) {
  const action = contextActionByPath(pathname);

  if (!action) {
    return actionResponse({
      status: 404,
      error: "unknown_context_action",
      action: pathname,
      message: "Unknown context action.",
    });
  }

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Call the context action with the declared method.",
    });
  }

  if (!action.configured) {
    return actionResponse({
      status: 409,
      error: "context_action_not_configured",
      action: action.id,
      message: `${action.label} is not configured for this environment.`,
      actionRequired: action.actionRequired,
    });
  }

  return actionResponse({
    status: 503,
    error: "context_action_disabled",
    action: action.id,
    message: `${action.label} is configured but disabled until its trust boundary is implemented.`,
    actionRequired: action.actionRequired,
  });
}

export async function contextEditSave(payload, method, session = null) {
  const action = contextActionByPath("/api/context/edit/save");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Save context edits with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "context_login_required",
      action: action.id,
      message: "Sign in before saving context.",
      actionRequired: "Use an account login, then save the native context document.",
    });
  }

  const result = await saveContextDocument({
    accountId: session.accountId,
    title: payload?.title,
    body: payload?.body,
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "context_save_failed",
      action: action.id,
      message: "Context could not be saved.",
      actionRequired: "Check the context payload and try again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      message: "Context saved.",
      document: result.document,
    },
  };
}

function contextHistoryCids(history) {
  const cids = new Set();
  const add = (value) => {
    const cid = normalizeContextCid(value);
    if (cid) cids.add(cid);
  };

  add(history?.latestContextPointer?.cid);
  for (const pointer of Array.isArray(history?.contextUpdates) ? history.contextUpdates : []) {
    add(pointer?.cid);
  }
  for (const pointer of Array.isArray(history?.taskEvents) ? history.taskEvents : []) {
    add(pointer?.cid);
  }
  return cids;
}

export async function contextHistoryIpfsFetch({ cid } = {}, method, session = null) {
  const action = contextActionByPath("/api/context/history/ipfs/:cid");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Fetch historical CIDs with GET.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "context_login_required",
      action: action.id,
      message: "Sign in before fetching historical context.",
      actionRequired: "Use an account login, then fetch cached context history CIDs.",
    });
  }

  const normalizedCid = normalizeContextCid(cid);
  const wallet = getLinkedWallet({ accountId: session.accountId });
  if (wallet.status !== "linked" || !wallet.address) {
    return actionResponse({
      status: 409,
      error: "context_wallet_required",
      action: action.id,
      message: "Link the wallet that owns this historical context before fetching the CID.",
      actionRequired:
        "Relink and unlock the wallet that owns the cached context pointer, then load the preview again.",
    });
  }

  const history = await getContextHistory({ accountId: session.accountId, walletAddress: wallet.address });
  if (!contextHistoryCids(history).has(normalizedCid)) {
    return actionResponse({
      status: 404,
      error: "context_cid_not_cached",
      action: action.id,
      message: "CID is not part of this account's cached context history.",
      actionRequired: "Wait for the PFTL cache reducer to project the wallet pointer, then refresh history.",
    });
  }

  const result = await fetchContextIpfsJson({ cid: normalizedCid });
  if (!result.ok) {
    return actionResponse({
      status: result.status || 502,
      error: result.error || "context_ipfs_fetch_failed",
      action: action.id,
      message: result.message || "Context CID could not be fetched.",
      actionRequired: "Check the CID gateway configuration and try again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      cid: result.cid,
      gateway: result.gateway,
      payload: result.payload,
    },
  };
}

export function walletActionByPath(pathname) {
  return walletActions().find((action) => action.path === pathname) || null;
}

export function walletLinkStart(method, session = null) {
  const action = walletActionByPath("/api/wallet/link/start");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Start wallet linking with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before linking a seed wallet.",
      actionRequired: "Use an account login, then link the local seed wallet.",
    });
  }

  const result = createWalletChallenge({
    accountId: session.accountId,
    purpose: "wallet_link",
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_challenge_failed",
      action: action.id,
      message: "Wallet link challenge could not be created.",
      actionRequired: "Sign in and try wallet linking again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_link_start",
      message: "Sign this challenge locally to link your wallet.",
      challenge: {
        id: result.challenge.id,
        purpose: result.challenge.purpose,
        message: result.challenge.message,
        expiresAt: result.challenge.expiresAt,
      },
      verifyPath: "/api/wallet/link/verify",
    },
  };
}

export async function walletCreateStart(method, session = null) {
  const action = walletActionByPath("/api/wallet/create/start");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Start wallet creation with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before creating a seed wallet.",
      actionRequired: "Use a non-email account login, then create the local seed wallet.",
    });
  }

  const result = createWalletChallenge({
    accountId: session.accountId,
    purpose: "wallet_create",
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_challenge_failed",
      action: action.id,
      message: "Wallet creation challenge could not be created.",
      actionRequired: "Sign in and try wallet creation again.",
    });
  }

  const gift = await resolveWalletInitiationGrantStatus({ accountId: session.accountId });

  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_create_start",
      message: "Sign this challenge locally to create and link your wallet.",
      challenge: {
        id: result.challenge.id,
        purpose: result.challenge.purpose,
        message: result.challenge.message,
        expiresAt: result.challenge.expiresAt,
      },
      verifyPath: "/api/wallet/link/verify",
      initiationGift: {
        eligible: Boolean(gift.eligible),
        reason: gift.reason || null,
        amountPft: gift.amountPft,
        amountDrops: gift.amountDrops,
        message: gift.message,
      },
    },
  };
}

async function claimWalletCreateInitiationGift({ accountId = "", walletAddress = "" } = {}) {
  const eligibility = await resolveWalletInitiationGrantStatus({ accountId, walletAddress });
  const linkedWallet = getLinkedWallet({ accountId });
  if (linkedWallet.proofPurpose !== "wallet_create") {
    return {
      ok: false,
      status: "not_eligible",
      reason: "wallet_create_proof_required",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: "The wallet initiation gift is only available for wallets created in this account, not linked or relinked wallets.",
      grant: eligibility.grant || null,
    };
  }

  if (!eligibility.eligible) {
    return {
      ok: false,
      status: "not_eligible",
      reason: eligibility.reason || "wallet_initiation_not_eligible",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: eligibility.message,
      grant: eligibility.grant || null,
    };
  }

  const faucet = pftInitiationFaucetStatus();
  if (!faucet.configured) {
    return {
      ok: false,
      status: "not_configured",
      reason: "faucet_not_configured",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: faucet.actionRequired,
    };
  }

  const reserved = await reserveWalletInitiationGrant({
    accountId,
    walletAddress,
    amountDrops: eligibility.amountDrops,
    amountPft: eligibility.amountPft,
  });
  if (!reserved.ok) {
    return {
      ok: false,
      status: "not_eligible",
      reason: reserved.error || reserved.eligibility?.reason || "wallet_initiation_not_eligible",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: reserved.eligibility?.message || "Wallet initiation gift is not eligible.",
      grant: reserved.eligibility?.grant || null,
    };
  }

  try {
    const sent = await sendPftInitiationGift({
      destination: walletAddress,
      amountDrops: eligibility.amountDrops,
      memo: `Task Node initiation gift for ${accountId}`,
    });
    const completed = await completeWalletInitiationGrant({
      grantId: reserved.internalGrant.id,
      txHash: sent.txHash,
      faucetAddress: sent.faucetAddress,
    });
    return {
      ok: true,
      status: "completed",
      amountPft: sent.amountPft,
      amountDrops: sent.amountDrops,
      txHash: sent.txHash,
      faucetAddress: sent.faucetAddress,
      message: `${sent.amountPft.toLocaleString("en-US")} PFT initiation gift sent.`,
      grant: completed.grant || reserved.grant,
    };
  } catch (error) {
    const failed = await failWalletInitiationGrant({
      grantId: reserved.internalGrant.id,
      error: error?.message || "wallet_initiation_failed",
      unknown: Boolean(error?.submitted),
    });
    return {
      ok: false,
      status: failed.grant?.status || "failed",
      reason: error?.message || "wallet_initiation_failed",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: "Wallet was created, but the PFT initiation gift could not be sent yet.",
      grant: failed.grant || reserved.grant,
    };
  }
}

function localVaultConfirmationRequired({ action }) {
  return actionResponse({
    status: 409,
    error: "local_vault_confirmation_required",
    action: action.id,
    message: "Unlock or save the matching local seed vault before sending the PFT initiation grant.",
    actionRequired: "Open Wallet, unlock the local vault for the linked address, then retry the PFT grant.",
  });
}

function walletCreateGrantPendingVault({ accountId = "", walletAddress = "" } = {}) {
  return resolveWalletInitiationGrantStatus({ accountId, walletAddress }).then((eligibility) => {
    if (!eligibility.eligible) {
      return {
        ok: false,
        status: "not_eligible",
        reason: eligibility.reason || "wallet_initiation_not_eligible",
        amountPft: eligibility.amountPft,
        amountDrops: eligibility.amountDrops,
        message: eligibility.message,
        grant: eligibility.grant || null,
      };
    }
    return {
      ok: false,
      status: "local_vault_required",
      reason: "local_vault_required",
      amountPft: eligibility.amountPft,
      amountDrops: eligibility.amountDrops,
      message: "Seed wallet linked. Save the encrypted local seed vault before sending the PFT initiation gift.",
      grant: null,
    };
  });
}

export async function walletInitiationRetry(method, session = null, payload = {}) {
  const action = walletActionByPath("/api/wallet/initiation/retry");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Retry the wallet initiation gift with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before retrying a wallet initiation gift.",
      actionRequired: "Use the account that owns the linked wallet.",
    });
  }

  if (payload?.localVaultConfirmed !== true) {
    return localVaultConfirmationRequired({ action });
  }

  const linkedWallet = getLinkedWallet({ accountId: session.accountId });
  if (linkedWallet.status !== "linked" || !linkedWallet.address) {
    return actionResponse({
      status: 409,
      error: "wallet_not_linked",
      action: action.id,
      message: "Link a wallet before retrying the initiation gift.",
      actionRequired: "Create or link a wallet first.",
    });
  }

  let initiationGift = await claimWalletCreateInitiationGift({
    accountId: session.accountId,
    walletAddress: linkedWallet.address,
  });
  if (!initiationGift.ok && linkedWallet.walletCreatedInAccount) {
    const usdcGift = await maybeClaimUsdcTopUpInitiationGift({ accountId: session.accountId });
    if (usdcGift) initiationGift = usdcGift;
  }

  return {
    status: initiationGift.ok ? 200 : initiationGift.status === "not_eligible" ? 409 : 502,
    body: {
      ok: Boolean(initiationGift.ok),
      action: action.id,
      message: initiationGift.message,
      initiationGift,
      wallet: linkedWallet,
    },
  };
}

export async function walletLinkVerify(payload, method, session = null) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: "wallet_link_verify",
      message: "Wallet link verification requires POST.",
      actionRequired: "Verify wallet linking with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: "wallet_link_verify",
      message: "Sign in before verifying a seed wallet.",
      actionRequired: "Use an account login, then verify the local wallet proof.",
    });
  }

  const challengeResult = consumeWalletChallenge({
    accountId: session.accountId,
    challengeId: payload?.challengeId,
    purpose: ["wallet_link", "wallet_relink", "wallet_create"],
  });

  if (!challengeResult.ok) {
    return actionResponse({
      status: challengeResult.status || 400,
      error: challengeResult.error || "wallet_challenge_invalid",
      action: "wallet_link_verify",
      message: "Wallet link challenge is invalid or expired.",
      actionRequired: "Start wallet linking again and sign the fresh challenge.",
    });
  }

  const address = String(payload?.address || "").trim();
  const publicKey = String(payload?.publicKey || "").trim();
  const tasknodeEncryptionPubkey = String(payload?.tasknodeEncryptionPubkey || payload?.tasknode_encryption_pubkey || "").trim();
  const signature = String(payload?.signature || "").trim();
  const verified = verifyWalletSignature({
    message: challengeResult.challenge.message,
    signature,
    publicKey,
    address,
  });

  if (!verified) {
    return actionResponse({
      status: 400,
      error: "wallet_signature_invalid",
      action: "wallet_link_verify",
      message: "Wallet signature did not verify.",
      actionRequired: "Confirm the recovery phrase and sign the latest challenge again.",
    });
  }

  const result = linkWalletToAccount({
    accountId: session.accountId,
    address,
    publicKey,
    tasknodeEncryptionPubkey,
    challengeId: challengeResult.challenge.id,
    signature,
    proofPurpose: challengeResult.challenge.purpose,
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_link_failed",
      action: "wallet_link_verify",
      message:
        result.error === "wallet_already_linked_to_account"
          ? "That wallet is already linked to a different account."
          : "Wallet link could not be saved.",
      actionRequired:
        result.error === "wallet_already_linked_to_account"
          ? "Sign in with the account that owns this wallet, or resolve the account conflict before relinking."
          : "Start wallet linking again and sign a fresh challenge.",
    });
  }

  await bestEffortRegisterPftlSyncWallet({
    accountId: session.accountId,
    walletAddress: result.wallet.address,
    reason: challengeResult.challenge.purpose,
  });
  await Promise.allSettled([
    recordUserObservabilityEvent({
      eventType: "user.wallet.linked",
      accountId: session.accountId,
      walletAddress: result.wallet.address,
      walletScope: "active",
      sourceSurface: "wallet",
      sourceRoute: "server/product-contracts.js::walletLinkVerify",
      resultStatus: "linked",
      reasonCode: challengeResult.challenge.purpose,
      metadata: {
        proofPurpose: challengeResult.challenge.purpose,
        reclaimedWalletCount: Number(result.reclaimedWalletCount || 0),
        publicKeyPresent: Boolean(publicKey),
        encryptionPublicKeyPresent: Boolean(tasknodeEncryptionPubkey),
      },
    }),
    recordUserObservabilityEvent({
      eventType: "user.wallet.selected",
      accountId: session.accountId,
      walletAddress: result.wallet.address,
      walletScope: "active",
      sourceSurface: "wallet",
      sourceRoute: "server/product-contracts.js::walletLinkVerify",
      resultStatus: "selected",
      reasonCode: challengeResult.challenge.purpose,
      metadata: {
        selectionSource: "wallet_link_verify",
      },
    }),
  ]);

  const reclaimedWalletCount = Number(result.reclaimedWalletCount || 0);
  const isCreate = challengeResult.challenge.purpose === "wallet_create";
  const initiationGift = isCreate
    ? await walletCreateGrantPendingVault({
        accountId: session.accountId,
        walletAddress: result.wallet.address,
      })
    : null;
  const message = isCreate
    ? "Seed wallet created. Save the local vault to send the PFT initiation gift."
    : reclaimedWalletCount
      ? "Seed wallet linked. Prior stale links for this wallet were detached."
      : "Seed wallet linked.";
  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_link_verify",
      message,
      reclaimedWalletCount,
      initiationGift,
      wallet: result.wallet,
    },
  };
}

export function walletRelinkStart(method, session = null) {
  const action = walletActionByPath("/api/wallet/relink/start");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Start wallet relinking with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before relinking a seed wallet.",
      actionRequired: "Use an account login, then prove control of the wallet.",
    });
  }

  const result = createWalletChallenge({
    accountId: session.accountId,
    purpose: "wallet_relink",
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_challenge_failed",
      action: action.id,
      message: "Wallet relink challenge could not be created.",
      actionRequired: "Sign in and try wallet relinking again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_relink_start",
      message: "Sign this challenge locally to relink your wallet.",
      challenge: {
        id: result.challenge.id,
        purpose: result.challenge.purpose,
        message: result.challenge.message,
        expiresAt: result.challenge.expiresAt,
      },
      verifyPath: "/api/wallet/link/verify",
    },
  };
}

export async function walletDelink(payload, method, session = null) {
  const action = walletActionByPath("/api/wallet/delink");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Delink wallet with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "wallet_login_required",
      action: action.id,
      message: "Sign in before delinking a wallet.",
      actionRequired: "Use an account login, then delink the wallet from the wallet tab.",
    });
  }

  const linkedWallet = getLinkedWallet({ accountId: session.accountId });
  if (linkedWallet.status !== "linked" || !linkedWallet.address) {
    return actionResponse({
      status: 409,
      error: "wallet_not_linked",
      action: action.id,
      message: "No active wallet is linked to this account.",
      actionRequired: "Link a wallet before attempting to delink.",
    });
  }

  const confirmAddress = String(payload?.confirmAddress || "").trim();
  if (confirmAddress && confirmAddress !== linkedWallet.address) {
    return actionResponse({
      status: 400,
      error: "wallet_delink_confirmation_mismatch",
      action: action.id,
      message: "Wallet delink confirmation did not match the linked wallet.",
      actionRequired: "Refresh the wallet tab and confirm the current linked wallet.",
    });
  }

  const result = delinkWalletFromAccount({
    accountId: session.accountId,
    actorSessionId: session.id,
    reason: payload?.reason || "user_requested",
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_delink_failed",
      action: action.id,
      message: "Wallet could not be delinked.",
      actionRequired: "Refresh the wallet tab and try again.",
    });
  }

  await bestEffortDeactivatePftlSyncWallet({
    walletAddress: result.wallet.address,
    reason: payload?.reason || "user_delinked",
  });
  await recordUserObservabilityEvent({
    eventType: "user.wallet.delinked",
    accountId: session.accountId,
    walletAddress: result.wallet.address,
    walletScope: "historical",
    sourceSurface: "wallet",
    sourceRoute: "server/product-contracts.js::walletDelink",
    resultStatus: "delinked",
    reasonCode: safeEventText(payload?.reason || "user_requested", 180),
    metadata: {
      delinkedAt: result.wallet.delinkedAt || "",
    },
  }).catch(() => {});

  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_delink",
      message: "Wallet delinked. Local vault data should be cleared from this browser.",
      wallet: {
        status: "delinked",
        address: result.wallet.address,
        delinkedAt: result.wallet.delinkedAt,
      },
    },
  };
}

export async function walletActionStart(pathname, method, session = null, payload = {}) {
  if (pathname === "/api/wallet/create/start") {
    return walletCreateStart(method, session);
  }
  if (pathname === "/api/wallet/initiation/retry") {
    return walletInitiationRetry(method, session, payload);
  }
  if (pathname === "/api/wallet/relink/start") {
    return walletRelinkStart(method, session);
  }
  if (pathname === "/api/wallet/delink") {
    return walletDelink(payload, method, session);
  }

  const action = walletActionByPath(pathname);

  if (!action) {
    return actionResponse({
      status: 404,
      error: "unknown_wallet_action",
      action: pathname,
      message: "Unknown wallet action.",
    });
  }

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Call the wallet action with the declared method.",
    });
  }

  if (!action.configured) {
    return actionResponse({
      status: 409,
      error: "wallet_action_not_configured",
      action: action.id,
      message: `${action.label} is not configured for this environment.`,
      actionRequired: action.actionRequired,
    });
  }

  return actionResponse({
    status: 503,
    error: "wallet_action_disabled",
    action: action.id,
    message: `${action.label} is configured but disabled until the wallet custody boundary is implemented.`,
    actionRequired: action.actionRequired,
  });
}

export function usageActionByPath(pathname) {
  return usageActions().find((action) => action.path === pathname) || null;
}

export function usageActionStart(pathname, method) {
  const action = usageActionByPath(pathname);

  if (!action) {
    return actionResponse({
      status: 404,
      error: "unknown_usage_action",
      action: pathname,
      message: "Unknown usage action.",
    });
  }

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "usage_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Call the usage action with the declared method.",
    });
  }

  return actionResponse({
    status: 503,
    error: "usage_action_disabled",
    action: action.id,
    message: `${action.label} is disabled until the funding rail is implemented.`,
    actionRequired: action.actionRequired,
  });
}

export async function usageTopUpStart(payload, method, session = null) {
  const action = usageActionByPath("/api/usage/top-up/start");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "usage_top_up_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Start top-up with POST.",
    });
  }

  const accountId = session?.accountId || "";
  if (!accountId) {
    return actionResponse({
      status: 401,
      error: "usage_top_up_login_required",
      action: action.id,
      message: "Sign in before creating a deposit address.",
      actionRequired: "Use a sign-in identity first. Deposit addresses are bound to app accounts, not PFT wallet links.",
    });
  }

  const result = await getOrCreateVerifiedEthereumTopUpAccount({ accountId });
  if (!result.ok) {
    await recordUsageObservabilityEvent({
      eventType: "user.billing.top_up_started",
      accountId,
      action: action.id,
      resultStatus: "failed",
      reasonCode: result.error || "usage_top_up_unavailable",
      sourceRoute: "server/product-contracts.js::usageTopUpStart",
    });
    return actionResponse({
      status: result.status || 409,
      error: result.error || "usage_top_up_unavailable",
      action: action.id,
      message: result.message || "Ethereum deposit addresses are not configured for this environment.",
      actionRequired: result.actionRequired || result.config?.actionRequired || action.actionRequired,
    });
  }

  await recordUsageObservabilityEvent({
    eventType: "user.billing.top_up_started",
    accountId,
    action: action.id,
    resultStatus: result.created ? "created" : "ready",
    depositAccount: result.depositAccount,
    sourceRoute: "server/product-contracts.js::usageTopUpStart",
    metadata: {
      network: result.config.network,
      chainId: result.config.chainId,
      blockTag: result.config.blockTag,
    },
  });

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      message: result.created ? "Ethereum deposit address created." : "Ethereum deposit address ready.",
      depositAccount: result.depositAccount,
      network: result.config.network,
      chainId: result.config.chainId,
      blockTag: result.config.blockTag,
      syncPath: "/api/usage/top-up/sync",
      instructions: [
        "Send only ETH, USDC, or USDT on Ethereum mainnet to this address.",
        "Deposits credit Task Node chat balance after the configured balance sync.",
        "This is a custodial top-up address controlled by Task Node. Users cannot withdraw from it.",
      ],
    },
  };
}

export async function usageTopUpSync(payload, method, session = null) {
  const action = usageActionByPath("/api/usage/top-up/sync");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "usage_top_up_sync_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Refresh top-ups with POST.",
    });
  }

  const accountId = session?.accountId || "";
  if (!accountId) {
    return actionResponse({
      status: 401,
      error: "usage_top_up_login_required",
      action: action.id,
      message: "Sign in before refreshing deposits.",
      actionRequired: "Use a sign-in identity first. Deposit balances are account-scoped.",
    });
  }

  const result = await syncEthereumTopUpAccount({ accountId });
  if (!result.ok) {
    await recordUsageObservabilityEvent({
      eventType: "user.billing.refill_sync_failed",
      accountId,
      action: action.id,
      resultStatus: "failed",
      reasonCode: result.error || "usage_top_up_sync_failed",
      sourceRoute: "server/product-contracts.js::usageTopUpSync",
    });
    return actionResponse({
      status: result.status || 502,
      error: result.error || "usage_top_up_sync_failed",
      action: action.id,
      message: result.message || "Ethereum deposit sync failed.",
      actionRequired:
        result.error === "eth_deposit_not_configured"
          ? "Configure ETH_DEPOSIT_XPUB before syncing deposits."
          : "Check Ethereum RPC health and retry.",
    });
  }

  if ((result.creditedEntries || []).length > 0) {
    await recordUsageObservabilityEvent({
      eventType: "user.billing.deposit_observed",
      accountId,
      action: action.id,
      resultStatus: "credited",
      depositAccount: result.depositAccount,
      creditedEntries: result.creditedEntries,
      sourceRoute: "server/product-contracts.js::usageTopUpSync",
      metadata: {
        pendingSymbols: result.pendingSymbols || [],
        syncErrorsPresent: (result.syncErrors || []).length > 0,
      },
    });
  }

  return {
    status: 200,
    body: result,
  };
}

export async function usageAdminCredit(payload, method, authorizationHeader = "") {
  const action = usageActionByPath("/api/usage/credit/admin");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "usage_credit_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Send admin credits with POST.",
    });
  }

  if (!action.configured) {
    return actionResponse({
      status: 409,
      error: "usage_credit_not_configured",
      action: action.id,
      message: `${action.label} is not configured for this environment.`,
      actionRequired: action.actionRequired,
    });
  }

  const expectedAuthorization = `Bearer ${process.env.TASKNODE_ADMIN_CREDIT_TOKEN || ""}`;
  if (!safeEqualText(authorizationHeader, expectedAuthorization)) {
    return actionResponse({
      status: 401,
      error: "usage_credit_unauthorized",
      action: action.id,
      message: "Admin credit requires an authorized server-to-server request.",
      actionRequired: "Send a valid bearer token from a trusted operator environment.",
    });
  }

  const amountUsd = Number(payload?.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 10000) {
    return actionResponse({
      status: 400,
      error: "usage_credit_invalid_amount",
      action: action.id,
      message: "Admin credit requires a positive amountUsd no larger than 10000.",
      actionRequired: "Send a bounded USD credit amount.",
    });
  }

  const accountId =
    typeof payload?.accountId === "string" && payload.accountId.trim()
      ? payload.accountId.trim().slice(0, 80)
      : "";
  if (!accountId) {
    return actionResponse({
      status: 400,
      error: "usage_credit_account_required",
      action: action.id,
      message: "Admin credit requires an explicit accountId.",
      actionRequired: "Send the exact accountId that should receive credit.",
    });
  }

  const idempotencyKey =
    typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
      ? payload.idempotencyKey.trim().slice(0, 180)
      : "";
  if (idempotencyKey.length < 12) {
    return actionResponse({
      status: 400,
      error: "usage_credit_idempotency_required",
      action: action.id,
      message: "Admin credit requires an idempotencyKey.",
      actionRequired: "Send a stable idempotencyKey for this operator credit event.",
    });
  }

  const note =
    typeof payload?.note === "string" && payload.note.trim()
      ? payload.note.trim().slice(0, 240)
      : "Manual admin credit";
  const actor =
    typeof payload?.actor === "string" && payload.actor.trim()
      ? payload.actor.trim().slice(0, 80)
      : "admin";
  const entry = await appendUsageCredit({
    accountId,
    amountUsd,
    source: "admin_credit",
    note,
    createdBy: actor,
    uniqueKey: `admin_credit:${idempotencyKey}`,
    metadata: {
      idempotencyKey,
      actor,
    },
  });
  const summary = await usageSummary({ accountId });

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      message: "Admin credit recorded.",
      ledgerEntry: entry,
      usage: {
        billingModel: "usage_based",
        currency: "USD",
        currentSpendUsd: summary.currentSpendUsd,
        currentCreditUsd: summary.currentCreditUsd,
        availableCreditUsd: summary.availableCreditUsd,
        ledgerEntryCount: summary.ledgerEntryCount,
      },
    },
  };
}

export async function userObservabilityClientEvent(payload, method, session = null) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "user_observability_event_method_not_allowed",
      action: "user_observability_event",
      message: "User observability events require POST.",
      actionRequired: "Submit client observability events with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "user_observability_login_required",
      action: "user_observability_event",
      message: "Sign in before recording user observability events.",
      actionRequired: "Use an authenticated app session.",
    });
  }

  const eventType = safeEventText(payload?.eventType || payload?.event_type, 160);
  if (!clientObservabilityEventTypes.has(eventType)) {
    return actionResponse({
      status: 400,
      error: "user_observability_event_type_not_allowed",
      action: "user_observability_event",
      message: "That client observability event type is not allowed.",
      actionRequired: "Use one of the documented user UI observability event types.",
    });
  }

  const linkedWallet = getLinkedWallet({ accountId: session.accountId });
  const result = await recordUserObservabilityEvent({
    eventType,
    accountId: session.accountId,
    walletAddress: safeEventText(payload?.walletAddress || payload?.wallet_address || linkedWallet?.address, 120),
    walletScope: safeEventText(payload?.walletScope || payload?.wallet_scope || (linkedWallet?.address ? "active" : ""), 80),
    sessionId: session.id,
    taskId: safeEventText(payload?.taskId || payload?.task_id, 180),
    conversationId: safeEventText(payload?.conversationId || payload?.conversation_id, 180),
    projectId: safeEventText(payload?.projectId || payload?.project_id, 180),
    sourceSurface: safeEventText(payload?.sourceSurface || payload?.source_surface || "client", 120),
    sourceRoute: safeEventText(payload?.sourceRoute || payload?.source_route || "client", 240),
    resultStatus: safeEventText(payload?.resultStatus || payload?.result_status || "observed", 120),
    reasonCode: safeEventText(payload?.reasonCode || payload?.reason_code, 180),
    decision: safeClientObject(payload?.decision || payload?.decision_json),
    metrics: safeClientObject(payload?.metrics || payload?.metrics_json),
    metadata: safeClientObject(payload?.metadata || payload?.metadata_json),
  });

  return {
    status: 202,
    body: {
      ok: true,
      action: "user_observability_event",
      recorded: result?.ok === true,
      skipped: Boolean(result?.skipped),
      eventType,
      eventId: result?.id || "",
      reason: result?.reason || result?.error || "",
    },
  };
}

export function authProviderById(providerId) {
  return authProviders().find((providerItem) => providerItem.id === providerId) || null;
}

export function authStart(providerId, requestMeta = {}) {
  return oauthAuthStart(providerId, requestMeta);
}

export async function authCallback(providerId, query = {}, requestMeta = {}) {
  return oauthAuthCallback(providerId, query, requestMeta);
}

export async function authEmailStart(payload, method, requestMeta = {}) {
  const status = emailDeliveryStatus();

  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "email_login_method_not_allowed",
      action: "email_login_start",
      message: "Email login requires POST.",
      actionRequired: "Send email login requests with POST.",
    });
  }

  if (!status.enabled) {
    return actionResponse({
      status: 503,
      error: "email_login_not_configured",
      action: "email_login_start",
      message: "Email login is not configured in this environment.",
      actionRequired: status.actionRequired,
    });
  }

  const normalized = normalizeEmailInput(payload?.email);
  if (!normalized.ok) {
    return actionResponse({
      status: 400,
      error: "email_invalid",
      action: "email_login_start",
      message: "Enter a valid email address.",
      actionRequired: "Use the email address that should receive the Task Node sign-in code.",
    });
  }

  const challengeId = randomUUID();
  const code = generateEmailCode();
  const expiresInSeconds = status.codeTtlSeconds;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  const maskedEmail = maskEmail(normalized.canonicalEmail);
  const codeHash = emailCodeHash({
    challengeId,
    canonicalEmail: normalized.canonicalEmail,
    code,
  });

  let delivery;
  try {
    delivery = await deliverEmailCode({
      email: normalized.email,
      code,
      expiresInSeconds,
    });
  } catch (error) {
    return actionResponse({
      status: 502,
      error: "email_delivery_failed",
      action: "email_login_start",
      message: "Task Node could not send a sign-in code right now.",
      actionRequired:
        error?.message || "Check transactional email provider configuration and retry.",
    });
  }

  createEmailChallenge({
    id: challengeId,
    email: normalized.email,
    canonicalEmail: normalized.canonicalEmail,
    maskedEmail,
    codeHash,
    expiresAt,
    deliveryMode: delivery.mode,
    requestIp: requestMeta.ip,
    userAgent: requestMeta.userAgent,
  });

  const existingAccount = findAccountByEmail(normalized.canonicalEmail);
  recordAuthEvent({
    accountId: existingAccount?.id || "",
    eventType: "email_challenge_started",
    provider: "email",
    email: maskedEmail,
    decision: "challenge_sent",
    metadata: {
      deliveryMode: delivery.mode,
      accountKnown: Boolean(existingAccount),
    },
  });

  const responseDelivery =
    delivery.mode === "development"
      ? {
          mode: "development",
          devCode: delivery.devCode,
          note: "Development delivery is enabled; this code is returned only for local/dev testing.",
        }
      : { mode: "email" };

  return {
    status: 200,
    body: {
      ok: true,
      action: "email_login_start",
      message:
        "If that email address can receive Task Node mail, we sent a sign-in code.",
      challengeId,
      maskedEmail,
      expiresAt,
      expiresInSeconds,
      delivery: responseDelivery,
    },
  };
}

export function authEmailVerify(payload, method) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "email_verify_method_not_allowed",
      action: "email_login_verify",
      message: "Email verification requires POST.",
      actionRequired: "Send email code verification requests with POST.",
    });
  }

  const challengeId = String(payload?.challengeId || "").trim();
  const code = String(payload?.code || "").trim().replace(/\s+/g, "");
  if (!challengeId || !/^[0-9A-Za-z]{6,12}$/.test(code)) {
    return actionResponse({
      status: 400,
      error: "email_code_invalid",
      action: "email_login_verify",
      message: "Enter the sign-in code from your email.",
      actionRequired: "Submit the current email challenge id and code.",
    });
  }

  const challenge = getEmailChallenge(challengeId);
  if (!challenge) {
    recordAuthEvent({
      eventType: "email_challenge_failed",
      provider: "email",
      decision: "missing_or_expired",
    });
    return actionResponse({
      status: 400,
      error: "email_code_invalid",
      action: "email_login_verify",
      message: "That sign-in code is invalid or expired.",
      actionRequired: "Request a new code and try again.",
    });
  }

  const codeHash = emailCodeHash({
    challengeId,
    canonicalEmail: challenge.canonicalEmail,
    code,
  });
  const consumed = consumeEmailChallenge({ challengeId, codeHash });

  if (!consumed.ok) {
    recordAuthEvent({
      eventType: "email_challenge_failed",
      provider: "email",
      email: challenge.maskedEmail,
      decision: consumed.error,
    });
    return actionResponse({
      status: consumed.error === "email_challenge_attempts_exceeded" ? 429 : 400,
      error: "email_code_invalid",
      action: "email_login_verify",
      message: "That sign-in code is invalid or expired.",
      actionRequired: "Check the code or request a new one.",
    });
  }

  const account = getOrCreateEmailAccount({
    email: consumed.challenge.email,
    canonicalEmail: consumed.challenge.canonicalEmail,
    maskedEmail: consumed.challenge.maskedEmail,
  });
  const created = createAccountSession(account, { provider: "email", assurance: "low" });

  recordAuthEvent({
    accountId: account.id,
    eventType: "email_challenge_verified",
    provider: "email",
    email: consumed.challenge.maskedEmail,
    decision: "session_issued",
  });
  recordAuthObservabilityEvents({
    accountId: account.id,
    provider: "email",
    sessionId: created.sessionId,
    sourceRoute: "server/product-contracts.js::authEmailVerify",
    resultStatus: "verified",
    reasonCode: "email_challenge_verified",
    metadata: {
      emailPresent: true,
      maskedEmailPresent: Boolean(consumed.challenge.maskedEmail),
      assurance: "low",
    },
  });

  return {
    status: 200,
    sessionId: created.sessionId,
    body: {
      ok: true,
      action: "email_login_verify",
      message: "Signed in.",
      session: created.session,
      account: {
        id: account.id,
        displayName: account.displayName,
        assurance: account.assurance,
      },
    },
  };
}

export function authDevStart(payload, method) {
  const status = devAuthStatus();

  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "dev_auth_method_not_allowed",
      action: "dev_auth_start",
      message: "Dev auth requires POST.",
      actionRequired: "Send dev auth requests with POST.",
    });
  }

  if (!status.enabled) {
    return actionResponse({
      status: 503,
      error: "dev_auth_disabled",
      action: "dev_auth_start",
      message: "Dev auth is disabled in this environment.",
      actionRequired:
        "Set TASKNODE_DEV_AUTH_ENABLED=true in a trusted development environment if dev sessions are needed.",
    });
  }

  const email = typeof payload?.email === "string" ? payload.email : "";
  const created = createDevSession({ email });
  recordAuthObservabilityEvents({
    accountId: created.session?.accountId || "",
    provider: "dev",
    sessionId: created.sessionId,
    sourceRoute: "server/product-contracts.js::authDevStart",
    reasonCode: "dev_auth_start",
    includeProviderLinked: false,
    metadata: {
      emailProvided: Boolean(email),
      assurance: "low",
    },
  });

  return {
    status: 200,
    sessionId: created.sessionId,
    body: {
      ok: true,
      action: "dev_auth_start",
      message: "Dev session started.",
      session: created.session,
    },
  };
}

export async function readiness() {
  const providers = authProviders();
  const ledger = await usageSummary();
  const chatBilling = chatBillingStatus();
  const chatExecutionReady = anyChatProviderEnabled();
  const emailStatus = emailDeliveryStatus();
  const authBlockers = authLaunchBlockers(providers, emailStatus);
  const ethDeposits = ethereumDepositConfigStatus();
  const publishStatus = await contextPublishStatus();
  return {
    generatedAt: new Date().toISOString(),
    auth: {
      configuredProviders: providers.filter((item) => item.configured).map((item) => item.id),
      devSessionReady: devAuthEnabled(),
      emailLoginReady: emailStatus.enabled,
      emailDeliveryMode: emailStatus.mode,
      launchReady: authBlockers.length === 0,
      blockers: authBlockers,
    },
    wallet: {
      pftlRpcConfigured: hasAny(["PFTL_RPC_URL", "PFTL_RPC_URL_FALLBACKS"]),
      pftlWssConfigured: hasAny(["PFTL_WSS_URL", "VITE_PFTL_WSS_URL", "PFTL_WSS_URL_FALLBACKS"]),
      pftlRpcAuthConfigured: hasAll(["PFTL_RPC_API_KEY"]),
      balanceReadReady: hasAny([
        "PFTL_WSS_URL",
        "VITE_PFTL_WSS_URL",
        "PFTL_WSS_URL_FALLBACKS",
        "PFTL_RPC_URL",
        "PFTL_RPC_URL_FALLBACKS",
      ]),
      challengeProofReady: true,
      seedStorageReady: true,
      lifecycleActionsReady: publishStatus.configured,
      blockers: [
        ...(publishStatus.configured ? [] : ["PFTL context publish dependencies are not fully configured"]),
        "Wallet-bound payout confirmation screens are not implemented",
      ],
    },
    context: {
      importReady: false,
      editReady: true,
      historyCacheReady: true,
      encryptedCidHydrationReady: true,
      manifestInkReady: publishStatus.configured,
      blockers: [
        "Historical context plaintext is local-session only and not yet summarized into durable chat context",
        "Shared URL fetch and cache adapters are not implemented",
        ...(publishStatus.configured ? [] : ["PFTL manifest publish dependencies are not fully configured"]),
      ],
    },
    billing: {
      model: "usage_based",
      ledgerReady: true,
      durableLedgerReady: ledger.durable,
      postgresConfigured: chatBilling.configured,
      postgresEnabled: chatBilling.enabled,
      adminCreditReady: hasAll(["TASKNODE_ADMIN_CREDIT_TOKEN"]),
      ethereumDepositReady: ethDeposits.enabled,
      ethereumDepositSyncReady: ethDeposits.enabled && ethDeposits.rpcConfigured,
      chatEstimateReady: true,
      chatExecutionReady,
      blockers: [
        ledger.durable ? "" : "Durable Postgres ledger tables are not enabled",
        ethDeposits.enabled
          ? ""
          : "ETH_DEPOSIT_XPUB is not configured for live Ethereum deposit addresses",
        ethDeposits.rpcConfigured
          ? ""
          : "ETH_DEPOSIT_RPC_URL is not configured for deposit balance sync",
        "Provider fallback policy is not implemented",
      ].filter(Boolean),
    },
    llm: {
      openaiConfigured: hasAll(["OPENAI_API_KEY"]),
      openrouterConfigured: chatProviderConfigured("openrouter"),
      aiGatewayConfigured: hasAll(["VERCEL_AI_GATEWAY_API_KEY"]),
    },
  };
}
