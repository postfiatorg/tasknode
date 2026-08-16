import { createHmac, randomInt, randomUUID } from "node:crypto";
export {
  chatEstimateStart,
  chatModes,
  chatSend,
  chatStreamStart,
} from "./product-chat-contracts.js";
export {
  walletActionByPath,
  walletActionStart,
  walletActions,
  walletCreateStart,
  walletDelink,
  walletInitiationRetry,
  walletLinkStart,
  walletLinkVerify,
  walletRelinkStart,
} from "./product-wallet-contracts.js";
export {
  contextActionByPath,
  contextActions,
  contextActionStart,
  contextEditSave,
  contextHistoryIpfsFetch,
} from "./product-context-contracts.js";
export {
  usageActionByPath,
  usageActions,
  usageActionStart,
  usageAdminCredit,
  usageTopUpStart,
  usageTopUpSync,
  userObservabilityClientEvent,
} from "./product-usage-contracts.js";
import {
  anyChatProviderEnabled,
  chatProviderConfigured,
} from "./chat-router.js";
export { chatEstimate, chatEstimateForAccount } from "./chat-estimate.js";
import { recordAuthEvent } from "./runtime-store.js";
import { findAccountByEmail, getOrCreateEmailAccount } from "./repositories/accounts.js";
import { createAccountSession, createDevSession } from "./repositories/auth-sessions.js";
import {
  consumeEmailChallenge,
  createEmailChallenge,
  getEmailChallenge,
} from "./repositories/auth-challenges.js";
import {
  oauthAuthCallback,
  oauthAuthProviders,
  oauthAuthStart,
} from "./auth-connected-accounts.js";
export { authTelegramAuthorize } from "./auth-connected-accounts.js";
import {
  chatBillingStatus,
} from "./repositories/chat-billing.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import { contextPublishStatus } from "./context-publish.js";
export { contextManifestInk } from "./context-publish.js";
export { taskLifecycleAction } from "./task-actions.js";
export { taskRequestAction } from "./task-request.js";
import {
  ethereumDepositConfigStatus,
} from "./ethereum-deposits.js";
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

export function authProviderById(providerId) {
  return authProviders().find((providerItem) => providerItem.id === providerId) || null;
}

export async function authStart(providerId, requestMeta = {}) {
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

  await createEmailChallenge({
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

  const existingAccount = await findAccountByEmail(normalized.canonicalEmail);
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

export async function authEmailVerify(payload, method) {
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

  const challenge = await getEmailChallenge(challengeId);
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
  const consumed = await consumeEmailChallenge({ challengeId, codeHash });

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

  const account = await getOrCreateEmailAccount({
    email: consumed.challenge.email,
    canonicalEmail: consumed.challenge.canonicalEmail,
    maskedEmail: consumed.challenge.maskedEmail,
  });
  const created = await createAccountSession(account, { provider: "email", assurance: "low" });

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

export async function authDevStart(payload, method) {
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
  const created = await createDevSession({ email });
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
      durableLedgerReady: chatBilling.durable,
      postgresConfigured: chatBilling.configured,
      postgresEnabled: chatBilling.enabled,
      adminCreditReady: hasAll(["TASKNODE_ADMIN_CREDIT_TOKEN"]),
      ethereumDepositReady: ethDeposits.enabled,
      ethereumDepositSyncReady: ethDeposits.enabled && ethDeposits.rpcConfigured,
      chatEstimateReady: true,
      chatExecutionReady,
      blockers: [
        chatBilling.durable ? "" : "Durable Postgres ledger tables are not enabled",
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
      ambientConfigured: chatProviderConfigured("ambient"),
      profileNftImageConfigured: process.env.TASKNODE_PROFILE_NFT_RENDERER_CONFIGURED === "true",
      // Compatibility field for older readiness consumers. Ambient is now the
      // inference gateway; the retired Vercel credential is no longer read.
      aiGatewayConfigured: chatProviderConfigured("ambient"),
    },
  };
}
