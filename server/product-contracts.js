import { createHmac, randomInt, randomUUID } from "node:crypto";
import {
  actualChatCost,
  anyChatProviderEnabled,
  chatExecutionStatus,
  chatModeConfig,
  chatModePrices,
  executeChat,
  normalizedChatMode,
} from "./chat-router.js";
import {
  appendUsageCredit,
  consumeWalletChallenge,
  consumeEmailChallenge,
  consumeOAuthState,
  createWalletChallenge,
  createAccountSession,
  createDevSession,
  createEmailChallenge,
  createOAuthState,
  delinkWalletFromAccount,
  findAccountByEmail,
  getEmailChallenge,
  getOrCreateEmailAccount,
  getOrCreateProviderAccount,
  linkProviderToAccount,
  linkWalletToAccount,
  recordAuthEvent,
  getContextHistory,
  getLinkedWallet,
  saveContextDocument,
  saveIndexedContextHistory,
  usageSummary,
} from "./runtime-store.js";
import { fetchContextIpfsJson, normalizeContextCid } from "./context-ipfs.js";
import { discoverContextHistoryFromRpc } from "./context-history-rpc.js";
import { verifyWalletSignature } from "./wallet-proof.js";

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

function emailCodeHash({ challengeId, canonicalEmail, code }) {
  return authHmac(`email-code:${challengeId}:${canonicalEmail}:${String(code || "").trim()}`);
}

function emailDevDeliveryEnabled() {
  if (process.env.TASKNODE_EMAIL_DEV_DELIVERY === "true") return true;
  if (process.env.TASKNODE_EMAIL_DEV_DELIVERY === "false") return false;
  return (
    process.env.NODE_ENV !== "production" &&
    !["prod", "production"].includes(currentEnvironment().toLowerCase())
  );
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

function emailDeliveryStatus() {
  const devDelivery = emailDevDeliveryEnabled();
  const resendReady = resendConfigured();
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

function provider({ id, label, kind, requiredEnv, note, enabled = false, status, actionRequired }) {
  const configured = hasAll(requiredEnv);
  const startPath = `/api/auth/start/${id}`;
  const callbackPath = `/api/auth/callback/${id}`;

  return {
    id,
    label,
    kind,
    configured,
    enabled: configured && enabled,
    status: status || (configured ? (enabled ? "ready" : "configured") : "missing_config"),
    startPath,
    callbackPath,
    actionRequired: configured
      ? (actionRequired || "Implement callback handling, account merge rules, and launch review before enabling this provider")
      : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}

function publicOrigin(requestMeta = {}) {
  const explicit = process.env.TASKNODE_PUBLIC_URL || process.env.VITE_SITE_ORIGIN || "";
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {}
  }

  if (requestMeta.origin) {
    try {
      return new URL(requestMeta.origin).origin;
    } catch {}
  }

  return "";
}

function githubRedirectUri(requestMeta = {}) {
  const origin = publicOrigin(requestMeta);
  if (!origin) return "";
  return new URL("/api/auth/callback/github", origin).toString();
}

function safeRedirectPath(value) {
  const raw = String(value || "/").trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw.slice(0, 200);
}

function selectGithubEmail(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const sorted = [...emails]
    .filter((item) => item?.email)
    .sort((left, right) => {
      const leftScore = (left.verified ? 2 : 0) + (left.primary ? 1 : 0);
      const rightScore = (right.verified ? 2 : 0) + (right.primary ? 1 : 0);
      return rightScore - leftScore;
    });
  const best = sorted[0];
  if (!best?.email) return null;
  return {
    email: best.email,
    verified: best.verified === true,
    primary: best.primary === true,
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGithubToken({ code, state, redirectUri }) {
  const { response, body } = await fetchJsonWithTimeout(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        state,
        redirect_uri: redirectUri,
      }),
    }
  );

  if (!response.ok || body?.error || !body?.access_token) {
    const error = new Error(body?.error_description || "GitHub token exchange failed.");
    error.status = 502;
    throw error;
  }

  return body.access_token;
}

async function fetchGithubUser(accessToken) {
  const { response, body } = await fetchJsonWithTimeout(
    "https://api.github.com/user",
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "tasknodeofficial",
      },
    }
  );

  if (!response.ok || !body?.id) {
    const error = new Error("GitHub user fetch failed.");
    error.status = 502;
    throw error;
  }

  return body;
}

async function fetchGithubEmails(accessToken) {
  const { response, body } = await fetchJsonWithTimeout(
    "https://api.github.com/user/emails",
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "tasknodeofficial",
      },
    }
  );

  if (!response.ok || !Array.isArray(body)) return [];
  return body;
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

function chatPayload(payload) {
  const accountId = typeof payload?.accountId === "string" ? payload.accountId.trim().slice(0, 160) : "";
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  const mode = typeof payload?.mode === "string" ? payload.mode : "Private Instant";
  const conversationId =
    typeof payload?.conversationId === "string" && payload.conversationId.trim()
      ? payload.conversationId.trim().slice(0, 160)
      : "dev";
  const dryRun = payload?.dryRun === true;
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments.slice(0, 4) : [];
  return { accountId, message, mode: normalizedChatMode(mode), conversationId, dryRun, attachments };
}

function chatExecutionPreflight(payload, method, action = "chat_send") {
  const chat = chatPayload(payload);
  const estimate = chatEstimate(payload);

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

  if (chat.dryRun) {
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
      },
      chat,
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

  return {
    ok: true,
    status: 200,
    chat,
    estimate,
  };
}

export function chatEstimate(payload) {
  const { message, mode } = chatPayload(payload);
  const inputTokens = Math.max(1, Math.ceil(message.length / 4));
  const estimatedOutputTokens = mode.includes("Thinking") ? 1800 : 700;
  const estimatedUsd = actualChatCost(mode, {
    inputTokens,
    outputTokens: estimatedOutputTokens,
  });
  const execution = chatExecutionStatus(mode);

  return {
    ok: true,
    mode,
    provider: execution.provider,
    model: execution.model,
    providerConfigured: execution.configured,
    providerStatus: execution.status,
    executionReady: execution.enabled,
    inputTokens,
    estimatedOutputTokens,
    estimatedUsd: Number(Math.max(0.0001, estimatedUsd).toFixed(6)),
    currency: "USD",
    billingModel: "usage_based",
    requiresConfirmation: estimatedUsd >= 0.05,
    policy: "This is an estimate only. Final billing is based on provider usage returned after execution.",
  };
}

export async function chatSend(payload, method) {
  const preflight = chatExecutionPreflight(payload, method, "chat_send");
  const { accountId, message, mode, conversationId, attachments } = preflight.chat;
  const { estimate } = preflight;
  if (!preflight.ok) return { status: preflight.status, body: preflight.body };

  try {
    const result = await executeChat({ accountId, mode, message, conversationId, attachments });
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
        estimate,
      },
    };
  }
}

export function chatStreamStart(payload, method) {
  const preflight = chatExecutionPreflight(payload, method, "chat_stream");
  if (!preflight.ok) return { status: preflight.status, body: preflight.body };

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
    },
  };
}

export function chatModes() {
  return Object.keys(chatModePrices).map((label) => {
    const status = chatExecutionStatus(label);
    return {
      label,
      provider: status.provider,
      model: status.model,
      configured: status.configured,
      enabled: status.enabled,
      status: status.status,
      privacy: status.provider === "openrouter" ? "Private provider route" : "Frontier provider route",
      latency: label.includes("Thinking") ? "Deep" : "Fast",
    };
  });
}

export function authProviders() {
  return [
    provider({
      id: "telegram",
      label: "Telegram",
      kind: "bot_account_link",
      requiredEnv: ["TELEGRAM_AUTH_BOT_TOKEN"],
      note:
        "Preferred mobile account-link path. The bot token is enough for readiness, but the account callback is not wired yet.",
    }),
    provider({
      id: "discord",
      label: "Discord",
      kind: "oauth",
      requiredEnv: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI"],
      note:
        "Required for Discord chat continuity and bot consolidation. OAuth callback wiring is the next implementation step.",
    }),
    provider({
      id: "x",
      label: "X",
      kind: "oauth",
      requiredEnv: ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_REDIRECT_URI"],
      note:
        "Useful for pseudonymous identity and public profile continuity. OAuth callback wiring is not active yet.",
    }),
    provider({
      id: "github",
      label: "GitHub",
      kind: "oauth",
      requiredEnv: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      enabled: true,
      actionRequired:
        "Configure the GitHub OAuth App callback URL to /api/auth/callback/github for this Task Node deployment.",
      note:
        "Required for legacy PFTasks account continuity. Exact GitHub identity resumes the same Task Node account.",
    }),
    emailProvider(),
  ];
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
      id: "hydrate_rpc_history",
      label: "Find historical PFT context",
      path: "/api/context/history/rpc/import",
      enabled: true,
      note:
        "Scans full-history PFTL account_tx for pf.ptr/v4 CONTEXT memo pointers owned by the linked wallet and stores CID metadata only.",
      actionRequired:
        "Sign in, link the wallet, import historical CID metadata, then unlock the local seed vault before decrypting a selected CID.",
    }),
    contextAction({
      id: "hydrate_indexed_history",
      label: "Import indexed PFTasks history",
      path: "/api/context/history/indexed",
      enabled: true,
      note:
        "Normalizes PFTasks indexed context/task rows into PFDocs-compatible pointer metadata without fetching or decrypting CID plaintext.",
      actionRequired:
        "Sign in with an account and import indexed PFTasks snapshot rows. Wallet unlock is required later for encrypted CID hydration.",
    }),
    contextAction({
      id: "fetch_history_cid",
      label: "Fetch historical CID",
      path: "/api/context/history/ipfs/:cid",
      method: "GET",
      enabled: true,
      note:
        "Fetches encrypted JSON only for CIDs already present in the signed-in account's imported PFTasks history.",
      actionRequired:
        "Unlock the local seed vault in the browser before decrypting fetched CID content.",
    }),
    contextAction({
      id: "ink_manifest",
      label: "Ink PFTL manifest",
      path: "/api/context/manifest/ink",
      requiredEnv: ["PFTL_RPC_URL", "PFTL_RPC_API_KEY"],
      note:
        "Explicitly writes a portable context manifest pointer to PFTL after wallet unlock.",
      actionRequired:
        "Implement manifest schema, wallet unlock confirmation, pointer transaction creation, and index verification before enabling manifest ink.",
    }),
  ];
}

export function usageActions() {
  return [
    usageAction({
      id: "top_up_start",
      label: "Top up with crypto",
      path: "/api/usage/top-up/start",
      enabled: false,
      status: "research",
      note:
        "Placeholder for crypto top-up rails such as USDC or USDT deposit addresses, MetaMask, or Phantom.",
      actionRequired:
        "Choose the safest funding rail and settlement/reconciliation model before enabling user top-ups.",
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

export function contextEditSave(payload, method, session = null) {
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

  const result = saveContextDocument({
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

export function contextIndexedHistoryImport(payload, method, session = null) {
  const action = contextActionByPath("/api/context/history/indexed");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Import indexed context history with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "context_login_required",
      action: action.id,
      message: "Sign in before importing context history.",
      actionRequired: "Use an account login, then import indexed PFTasks snapshot rows.",
    });
  }

  const wallet = getLinkedWallet({ accountId: session.accountId });
  if (wallet.status !== "linked" || !wallet.address) {
    return actionResponse({
      status: 409,
      error: "context_wallet_required",
      action: action.id,
      message: "Link a seed wallet before importing indexed PFT context history.",
      actionRequired:
        "Link the wallet that owns the indexed context pointers, then import the snapshot again.",
    });
  }

  const snapshot = payload?.snapshot || payload || {};
  const snapshotWalletAddress =
    snapshot?.walletAddress ||
    snapshot?.wallet_address ||
    snapshot?.indexedData?.walletAddress ||
    snapshot?.indexedData?.wallet_address ||
    snapshot?.indexedData?.wallet?.walletAddress ||
    snapshot?.indexedData?.wallet?.wallet_address ||
    snapshot?.indexedData?.wallet?.address ||
    "";
  if (snapshotWalletAddress && String(snapshotWalletAddress).trim() !== wallet.address) {
    return actionResponse({
      status: 409,
      error: "context_history_wallet_mismatch",
      action: action.id,
      message: "Indexed context history belongs to a different wallet.",
      actionRequired:
        "Relink the wallet that owns this history, or import a snapshot for the current linked wallet.",
    });
  }

  const result = saveIndexedContextHistory({
    accountId: session.accountId,
    snapshot: {
      ...snapshot,
      walletAddress: wallet.address,
    },
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "context_history_import_failed",
      action: action.id,
      message: "Context history could not be imported.",
      actionRequired: "Check the indexed PFTasks snapshot shape and try again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      message: "Indexed context history imported.",
      history: result.history,
    },
  };
}

export async function contextHistoryRpcImport(payload, method, session = null) {
  const action = contextActionByPath("/api/context/history/rpc/import");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Import historical PFT context with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "context_login_required",
      action: action.id,
      message: "Sign in before importing historical context.",
      actionRequired: "Use an account login, then import historical PFT context for the linked wallet.",
    });
  }

  const wallet = getLinkedWallet({ accountId: session.accountId });
  if (wallet.status !== "linked" || !wallet.address) {
    return actionResponse({
      status: 409,
      error: "context_wallet_required",
      action: action.id,
      message: "Link a seed wallet before discovering historical PFT context.",
      actionRequired:
        "Link the wallet that owns the historical context pointers, then run historical context discovery again.",
    });
  }

  let discovery;
  try {
    discovery = await discoverContextHistoryFromRpc({
      walletAddress: wallet.address,
      limit: payload?.limit,
      maxPages: payload?.maxPages,
    });
  } catch (error) {
    const errorCode = String(error?.code || error?.message || "context_history_rpc_failed")
      .replace(/[^a-zA-Z0-9_.-]+/g, "_")
      .slice(0, 100);
    return actionResponse({
      status: error?.status || 502,
      error: errorCode || "context_history_rpc_failed",
      action: action.id,
      message: "Historical PFT context could not be discovered from account history.",
      actionRequired:
        "Check the full-history PFTL RPC configuration and retry. The local rapid balance node is not sufficient for archive context discovery.",
    });
  }

  const summary = {
    walletAddress: discovery.walletAddress,
    scannedTransactions: discovery.scannedTransactions,
    accountTxPages: discovery.accountTxPages,
    accountTxComplete: discovery.accountTxComplete,
    contextUpdateCount: discovery.contextUpdateCount,
  };

  if (discovery.contextUpdateCount === 0) {
    return {
      status: 200,
      body: {
        ok: true,
        action: action.id,
        message: "No historical PFT context pointers were found for the linked wallet.",
        discovery: summary,
        history: getContextHistory({ accountId: session.accountId, walletAddress: wallet.address }),
      },
    };
  }

  const existingHistory = getContextHistory({ accountId: session.accountId, walletAddress: wallet.address });
  const mergedSnapshot = {
    ...discovery.snapshot,
    contextRevisions: [
      ...discovery.snapshot.contextRevisions,
      ...(
        Array.isArray(existingHistory.contextUpdates)
          ? existingHistory.contextUpdates
          : []
      ),
    ],
    taskEvents: Array.isArray(existingHistory.taskEvents) ? existingHistory.taskEvents : [],
  };

  const result = saveIndexedContextHistory({
    accountId: session.accountId,
    snapshot: {
      ...mergedSnapshot,
      walletAddress: wallet.address,
    },
  });

  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "context_history_import_failed",
      action: action.id,
      message: "Discovered context history could not be saved.",
      actionRequired: "Retry historical context discovery after checking local runtime storage.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      message: `Imported ${discovery.contextUpdateCount} historical context pointer${discovery.contextUpdateCount === 1 ? "" : "s"}.`,
      discovery: summary,
      history: result.history,
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
      actionRequired: "Use an account login, then fetch imported history CIDs.",
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
        "Relink and unlock the wallet that owns the imported history, then load the preview again.",
    });
  }

  const history = getContextHistory({ accountId: session.accountId, walletAddress: wallet.address });
  if (!contextHistoryCids(history).has(normalizedCid)) {
    return actionResponse({
      status: 404,
      error: "context_cid_not_imported",
      action: action.id,
      message: "CID is not part of this account's imported context history.",
      actionRequired: "Import indexed PFTasks history before hydrating its encrypted CIDs.",
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

export function walletLinkVerify(payload, method, session = null) {
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
    purpose: ["wallet_link", "wallet_relink"],
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

  const reclaimedWalletCount = Number(result.reclaimedWalletCount || 0);
  return {
    status: 200,
    body: {
      ok: true,
      action: "wallet_link_verify",
      message: reclaimedWalletCount
        ? "Seed wallet linked. Prior stale links for this wallet were detached."
        : "Seed wallet linked.",
      reclaimedWalletCount,
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

export function walletDelink(payload, method, session = null) {
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

export function walletActionStart(pathname, method, session = null, payload = {}) {
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

export function usageAdminCredit(payload, method, authorizationHeader = "") {
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

  if (authorizationHeader !== `Bearer ${process.env.TASKNODE_ADMIN_CREDIT_TOKEN}`) {
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
      : "dev";
  const note =
    typeof payload?.note === "string" && payload.note.trim()
      ? payload.note.trim().slice(0, 240)
      : "Manual admin credit";
  const entry = appendUsageCredit({
    accountId,
    amountUsd,
    note,
    createdBy: "admin",
  });
  const summary = usageSummary({ accountId });

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

const initialProviderCreditProviders = new Set(["github", "x", "telegram", "discord"]);

function initialProviderCreditUsd() {
  const amount = Number(process.env.TASKNODE_INITIAL_PROVIDER_CREDIT_USD || 5);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number(Math.min(amount, 100).toFixed(2));
}

function grantInitialProviderCredit(account, provider) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!account?.id || !initialProviderCreditProviders.has(normalizedProvider)) return null;

  const amountUsd = initialProviderCreditUsd();
  if (amountUsd <= 0) return null;

  return appendUsageCredit({
    accountId: account.id,
    amountUsd,
    source: "initial_provider_credit",
    note: `Initial Task Node chat credit for ${normalizedProvider} account login.`,
    createdBy: "system",
    uniqueKey: `initial_provider_credit:${account.id}`,
  });
}

export function authProviderById(providerId) {
  return authProviders().find((providerItem) => providerItem.id === providerId) || null;
}

export function authStart(providerId, requestMeta = {}) {
  const providerItem = authProviderById(providerId);

  if (!providerItem) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "unknown_auth_provider",
        provider: providerId,
        message: "Unknown auth provider.",
      },
    };
  }

  if (!providerItem.configured) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "auth_provider_not_configured",
        provider: providerItem.id,
        message: `${providerItem.label} is not configured for this environment.`,
        actionRequired: providerItem.actionRequired,
      },
    };
  }

  if (providerItem.id === "github") {
    const redirectUri = githubRedirectUri(requestMeta);
    if (!redirectUri) {
      return actionResponse({
        status: 409,
        error: "auth_redirect_origin_missing",
        action: "github_auth_start",
        message: "GitHub login needs a public Task Node origin.",
        actionRequired:
          "Configure TASKNODE_PUBLIC_URL or call the start route from the deployed app origin.",
      });
    }

    const stateRow = createOAuthState({
      provider: "github",
      redirectPath: safeRedirectPath(requestMeta.redirectPath),
      redirectUri,
      linkAccountId: requestMeta.session?.accountId || "",
      expiresInSeconds: 600,
    });
    const linkingAccount = Boolean(requestMeta.session?.accountId);
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "user:email");
    authorizeUrl.searchParams.set("state", stateRow.id);
    authorizeUrl.searchParams.set("allow_signup", "true");

    return {
      status: 200,
      oauthState: {
        provider: "github",
        value: stateRow.id,
        maxAgeSeconds: 600,
      },
      body: {
        ok: true,
        action: linkingAccount ? "github_account_link_start" : "github_auth_start",
        provider: "github",
        mode: linkingAccount ? "account_link" : "sign_in",
        redirectUrl: authorizeUrl.toString(),
        redirectUri,
        expiresAt: stateRow.expiresAt,
      },
    };
  }

  return {
    status: 503,
    body: {
      ok: false,
      error: "auth_provider_disabled",
      provider: providerItem.id,
      message: `${providerItem.label} auth is configured but disabled until callback handling and account merge rules are implemented.`,
      actionRequired: providerItem.actionRequired,
    },
  };
}

export async function authCallback(providerId, query = {}, requestMeta = {}) {
  const providerItem = authProviderById(providerId);

  if (!providerItem) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "unknown_auth_provider",
        provider: providerId,
        message: "Unknown auth provider.",
      },
    };
  }

  if (providerItem.id === "github") {
    const code = String(query?.code || "").trim();
    const stateId = String(query?.state || "").trim();
    const callbackCookieState = String(requestMeta.oauthState || "").trim();

    if (query?.error) {
      return actionResponse({
        status: 400,
        error: "github_auth_denied",
        action: "github_auth_callback",
        message: String(query.error_description || query.error || "GitHub authorization failed."),
        actionRequired: "Start GitHub login again if you intended to authorize Task Node.",
      });
    }

    if (!code || !stateId || !callbackCookieState || stateId !== callbackCookieState) {
      return actionResponse({
        status: 400,
        error: "oauth_state_invalid",
        action: "github_auth_callback",
        message: "GitHub login state is invalid or expired.",
        actionRequired: "Start GitHub login again from the Task Node login modal.",
      });
    }

    const stateRow = consumeOAuthState({ provider: "github", stateId });
    if (!stateRow) {
      return actionResponse({
        status: 400,
        error: "oauth_state_invalid",
        action: "github_auth_callback",
        message: "GitHub login state is invalid or expired.",
        actionRequired: "Start GitHub login again from the Task Node login modal.",
      });
    }

    try {
      const accessToken = await fetchGithubToken({
        code,
        state: stateId,
        redirectUri: stateRow.redirectUri,
      });
      const [profile, emails] = await Promise.all([
        fetchGithubUser(accessToken),
        fetchGithubEmails(accessToken),
      ]);
      const emailInfo = selectGithubEmail(emails);
      const linkedResult = stateRow.linkAccountId
        ? linkProviderToAccount({
            accountId: stateRow.linkAccountId,
            provider: "github",
            providerUserId: String(profile.id),
            username: profile.login || "",
            displayName: profile.name || profile.login || "GitHub",
            profileUrl: profile.html_url || "",
            emailInfo,
          })
        : null;

      if (linkedResult && !linkedResult.ok) {
        const conflict = linkedResult.error === "provider_identity_conflict" || linkedResult.error === "provider_email_conflict";
        recordAuthEvent({
          accountId: stateRow.linkAccountId,
          eventType: "github_oauth_link_failed",
          provider: "github",
          email: emailInfo?.email ? maskEmail(emailInfo.email) : "",
          decision: linkedResult.error,
          metadata: {
            username: profile.login || "",
            providerUserId: String(profile.id),
          },
        });
        return actionResponse({
          status: conflict ? 409 : 400,
          error: linkedResult.error,
          action: "github_account_link",
          message: conflict
            ? "That GitHub identity is already linked to another Task Node account."
            : "GitHub could not be linked to this Task Node account.",
          actionRequired: conflict
            ? "Sign in with the existing linked account or contact support before attempting an account merge."
            : "Start GitHub linking again from Settings.",
        });
      }

      const account = linkedResult?.account || getOrCreateProviderAccount({
        provider: "github",
        providerUserId: String(profile.id),
        username: profile.login || "",
        displayName: profile.name || profile.login || "GitHub",
        profileUrl: profile.html_url || "",
        emailInfo,
      });
      const initialCredit = grantInitialProviderCredit(account, "github");
      const created = createAccountSession(account, { provider: "github", assurance: "medium" });

      recordAuthEvent({
        accountId: account.id,
        eventType: stateRow.linkAccountId ? "github_oauth_linked" : "github_oauth_verified",
        provider: "github",
        email: emailInfo?.email ? maskEmail(emailInfo.email) : "",
        decision: "session_issued",
        metadata: {
          username: profile.login || "",
          providerUserId: String(profile.id),
          emailVerified: emailInfo?.verified === true,
          initialCreditUsd: initialCredit?.idempotentReplay ? 0 : Number(initialCredit?.amountUsd || 0),
          initialCreditIdempotentReplay: Boolean(initialCredit?.idempotentReplay),
        },
      });

      return {
        status: 302,
        sessionId: created.sessionId,
        clearOAuthState: {
          provider: "github",
        },
        redirectLocation: safeRedirectPath(stateRow.redirectPath || "/"),
        body: {
          ok: true,
          action: "github_auth_callback",
          message: stateRow.linkAccountId ? "GitHub linked." : "Signed in with GitHub.",
          session: created.session,
          initialCredit: initialCredit
            ? {
                amountUsd: Number(initialCredit.amountUsd || 0),
                alreadyRecorded: Boolean(initialCredit.idempotentReplay),
              }
            : null,
        },
      };
    } catch (error) {
      recordAuthEvent({
        eventType: "github_oauth_failed",
        provider: "github",
        decision: error?.message || "github_callback_failed",
      });
      return actionResponse({
        status: error?.status || 502,
        error: "github_callback_failed",
        action: "github_auth_callback",
        message: "GitHub login could not be completed.",
        actionRequired:
          error?.message || "Check GitHub OAuth app callback configuration and retry.",
      });
    }
  }

  return {
    status: 501,
    body: {
      ok: false,
      error: "auth_callback_not_implemented",
      provider: providerItem.id,
      message: `${providerItem.label} callback handling is not implemented yet.`,
      actionRequired:
        "Implement callback verification, account merge rules, and session issuance before enabling login.",
    },
  };
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

export function readiness() {
  const providers = authProviders();
  const ledger = usageSummary();
  const chatExecutionReady = anyChatProviderEnabled();
  const emailStatus = emailDeliveryStatus();
  return {
    generatedAt: new Date().toISOString(),
    auth: {
      configuredProviders: providers.filter((item) => item.configured).map((item) => item.id),
      devSessionReady: devAuthEnabled(),
      emailLoginReady: emailStatus.enabled,
      emailDeliveryMode: emailStatus.mode,
      launchReady: false,
      blockers: [
        "Telegram, Discord, X, and bot callback handlers are not implemented",
        "Canonical account merge rules are not implemented",
        ...(emailStatus.enabled ? [] : [emailStatus.actionRequired]),
      ],
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
      lifecycleActionsReady: false,
      blockers: [
        "PFTL transaction signing boundary is not implemented",
        "Wallet-bound payout and manifest signing confirmation screens are not implemented",
      ],
    },
    context: {
      importReady: false,
      editReady: true,
      indexedHistoryReady: true,
      historyRpcReady: true,
      encryptedCidHydrationReady: true,
      manifestInkReady: false,
      blockers: [
        "Historical context plaintext is local-session only and not yet summarized into durable chat context",
        "Shared URL fetch and cache adapters are not implemented",
        "PFTL manifest pointer creation is not implemented",
      ],
    },
    billing: {
      model: "usage_based",
      ledgerReady: true,
      durableLedgerReady: ledger.durable,
      adminCreditReady: hasAll(["TASKNODE_ADMIN_CREDIT_TOKEN"]),
      chatEstimateReady: true,
      chatExecutionReady,
      blockers: [
        "Durable Postgres ledger tables are not implemented",
        "Top-up rail decision is not made",
        "Provider fallback policy is not implemented",
      ],
    },
    llm: {
      openaiConfigured: hasAll(["OPENAI_API_KEY"]),
      openrouterConfigured: hasAll(["OPENROUTER_API_KEY"]),
      aiGatewayConfigured: hasAll(["VERCEL_AI_GATEWAY_API_KEY"]),
    },
  };
}
