import { isValidClassicAddress } from "xrpl";
import {
  consumeWalletLoginChallenge,
  createAccountSession,
  createWalletLoginChallenge,
  recordAuthEvent,
  resolveOrCreateWalletLoginAccount,
} from "./runtime-store.js";
import { bestEffortRegisterPftlSyncWallet } from "./pftl-cache-sync.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import { verifyWalletSignature } from "./wallet-proof.js";

const walletLoginChallengeTtlSeconds = 5 * 60;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function actionResponse({ status, error, message, actionRequired }) {
  return {
    status,
    body: {
      ok: false,
      error,
      action: "wallet_login",
      message,
      actionRequired,
    },
  };
}

function allowlistEnvValue() {
  return Object.prototype.hasOwnProperty.call(process.env, "TASKNODE_AGENT_WALLET_ALLOWLIST")
    ? String(process.env.TASKNODE_AGENT_WALLET_ALLOWLIST || "")
    : null;
}

export function agentWalletAllowlist() {
  const raw = allowlistEnvValue();
  if (raw === null) return { configured: false, addresses: new Set() };
  return {
    configured: true,
    addresses: new Set(raw.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)),
  };
}

export function agentWalletAllowed(address = "") {
  const allowlist = agentWalletAllowlist();
  if (!allowlist.configured) return true;
  return allowlist.addresses.has(String(address || "").trim());
}

export function authWalletStart(payload = {}, method = "POST", { expiresInSeconds = walletLoginChallengeTtlSeconds } = {}) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "wallet_login_method_not_allowed",
      message: "Wallet login challenge requests require POST.",
      actionRequired: "Start wallet login with POST.",
    });
  }

  const address = safeText(payload?.address, 120);
  const publicKey = safeText(payload?.publicKey || payload?.public_key, 160);
  if (!address || !isValidClassicAddress(address)) {
    return actionResponse({
      status: 400,
      error: "wallet_address_invalid",
      message: "Wallet login requires a valid PFTL classic address.",
      actionRequired: "Send the agent wallet classic address.",
    });
  }

  const result = createWalletLoginChallenge({ address, publicKey, expiresInSeconds });
  if (!result.ok) {
    return actionResponse({
      status: result.status || 400,
      error: result.error || "wallet_login_challenge_failed",
      message: "Wallet login challenge could not be created.",
      actionRequired: "Start wallet login again.",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      challenge: {
        id: result.challenge.id,
        message: result.challenge.message,
        expiresAt: result.challenge.expiresAt,
      },
      verifyPath: "/api/auth/wallet/verify",
    },
  };
}

export async function authWalletVerify(payload = {}, method = "POST") {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "wallet_login_method_not_allowed",
      message: "Wallet login verification requires POST.",
      actionRequired: "Verify wallet login with POST.",
    });
  }

  const challengeId = safeText(payload?.challengeId || payload?.challenge_id, 180);
  const address = safeText(payload?.address, 120);
  const publicKey = safeText(payload?.publicKey || payload?.public_key, 180);
  const signature = safeText(payload?.signature, 500);

  if (!agentWalletAllowed(address)) {
    recordAuthEvent({
      eventType: "wallet_login_denied",
      provider: "wallet",
      decision: "allowlist_denied",
      metadata: { walletAddress: address || null },
    });
    return actionResponse({
      status: 403,
      error: "wallet_login_not_allowed",
      message: "Wallet login is not allowed for this wallet.",
      actionRequired: "Use an allowlisted agent wallet.",
    });
  }

  const consumed = consumeWalletLoginChallenge({ challengeId, address });
  if (!consumed.ok) {
    recordAuthEvent({
      eventType: "wallet_login_challenge_failed",
      provider: "wallet",
      decision: "invalid_or_expired_challenge",
      metadata: { walletAddress: address || null },
    });
    return actionResponse({
      status: 400,
      error: "invalid_or_expired_challenge",
      message: "Wallet login challenge is invalid or expired.",
      actionRequired: "Start wallet login again and sign the fresh challenge.",
    });
  }

  const verified = verifyWalletSignature({
    message: consumed.challenge.message,
    signature,
    publicKey,
    address,
  });
  if (!verified) {
    recordAuthEvent({
      eventType: "wallet_login_signature_failed",
      provider: "wallet",
      decision: "signature_invalid",
      metadata: {
        walletAddress: address || null,
        challengeId: consumed.challenge.id,
        publicKeyPresent: Boolean(publicKey),
      },
    });
    return actionResponse({
      status: 401,
      error: "wallet_signature_invalid",
      message: "Wallet signature did not verify.",
      actionRequired: "Start wallet login again and sign the fresh challenge with the agent wallet.",
    });
  }

  const resolved = resolveOrCreateWalletLoginAccount({
    address,
    publicKey,
    challengeId: consumed.challenge.id,
    signature,
  });
  if (!resolved.ok || !resolved.account?.id) {
    recordAuthEvent({
      eventType: "wallet_login_failed",
      provider: "wallet",
      decision: "account_resolution_failed",
      metadata: { walletAddress: address || null },
    });
    return actionResponse({
      status: resolved.status || 400,
      error: "wallet_login_failed",
      message: "Wallet login could not be completed.",
      actionRequired: "Start wallet login again.",
    });
  }

  await bestEffortRegisterPftlSyncWallet({
    accountId: resolved.account.id,
    walletAddress: address,
    reason: "wallet_login",
  });

  const created = createAccountSession(resolved.account, { provider: "wallet", assurance: "high" });
  recordAuthEvent({
    accountId: resolved.account.id,
    eventType: "wallet_login_verified",
    provider: "wallet",
    decision: "session_issued",
    metadata: {
      walletAddress: address,
      challengeId: consumed.challenge.id,
      createdAccount: Boolean(resolved.created),
      linkedWallet: Boolean(resolved.linked),
      reclaimedWalletCount: Number(resolved.reclaimedWalletCount || 0),
    },
  });
  await Promise.allSettled([
    recordUserObservabilityEvent({
      eventType: "user.provider.linked",
      accountId: resolved.account.id,
      walletAddress: address,
      walletScope: "active",
      provider: "wallet",
      providerUserId: address,
      sessionId: created.sessionId,
      sourceSurface: "auth",
      sourceRoute: "server/auth-wallet-login.js::authWalletVerify",
      resultStatus: "verified",
      reasonCode: "wallet_login",
      metadata: {
        createdAccount: Boolean(resolved.created),
        linkedWallet: Boolean(resolved.linked),
      },
    }),
    recordUserObservabilityEvent({
      eventType: "user.session.started",
      accountId: resolved.account.id,
      walletAddress: address,
      walletScope: "active",
      provider: "wallet",
      providerUserId: address,
      sessionId: created.sessionId,
      sourceSurface: "auth",
      sourceRoute: "server/auth-wallet-login.js::authWalletVerify",
      resultStatus: "started",
      reasonCode: "wallet_login",
      metadata: {
        assurance: "high",
      },
    }),
  ]);

  return {
    status: 200,
    sessionId: created.sessionId,
    body: {
      ok: true,
      accountId: resolved.account.id,
      address,
      session: created.session,
    },
  };
}
