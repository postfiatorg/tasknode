import { authEmailStart, consumeVerifiedEmailCode } from "./product-contracts.js";
import {
  findAccountByEmail,
  findAccountByHandle,
  getAccount,
} from "./repositories/accounts.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";
import { consumeWalletChallenge, createWalletChallenge } from "./repositories/auth-challenges.js";
import {
  disableAccountPassword,
  passwordCredentialStatus,
  setAccountPassword,
  validateAccountPassword,
  verifyAccountPassword,
} from "./repositories/account-passwords.js";
import {
  createAccountSession,
  revokeSessionsForAccount,
} from "./repositories/auth-sessions.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import { verifyWalletSignature } from "./wallet-proof.js";

function safeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function safeIdentifier(value = "") {
  return String(value || "").trim().toLowerCase();
}

function maskEmail(value = "") {
  const email = safeEmail(value);
  const index = email.lastIndexOf("@");
  if (index <= 0) return "";
  const local = email.slice(0, index);
  return `${local.slice(0, 1)}${"*".repeat(Math.min(Math.max(local.length - 1, 1), 5))}${email.slice(index)}`;
}

function response(status, body = {}, sessionId = "") {
  return { status, body: { ok: status < 400, ...body }, ...(sessionId ? { sessionId } : {}) };
}

async function accountPasswordProfile(accountId) {
  const account = await getAccount(accountId);
  const email = account?.primaryEmailVerified ? safeEmail(account.primaryEmailCanonical) : "";
  const [credential, wallet] = await Promise.all([
    passwordCredentialStatus({ accountId }),
    getLinkedWallet({ accountId }),
  ]);
  const walletLinked = wallet?.status === "linked" && Boolean(wallet.address);
  return {
    available: walletLinked,
    enabled: credential.enabled,
    maskedEmail: maskEmail(email),
    walletLinked,
    walletAddress: walletLinked ? wallet.address : "",
    updatedAt: credential.updatedAt,
  };
}

async function record(eventType, accountId, resultStatus, reasonCode = "") {
  await recordUserObservabilityEvent({
    eventType,
    accountId,
    sourceSurface: "settings_security",
    sourceRoute: "server/account-password-auth.js",
    resultStatus,
    reasonCode,
  }).catch(() => null);
}

export async function passwordStatus(session = null) {
  if (!session?.accountId) return response(401, { error: "password_login_required", message: "Sign in to manage an account password." });
  return response(200, { password: await accountPasswordProfile(session.accountId) });
}

export async function passwordEnableStart(_payload = {}, session = null) {
  if (!session?.accountId) return response(401, { error: "password_login_required", message: "Sign in to enable an account password." });
  const [wallet, credential] = await Promise.all([
    getLinkedWallet({ accountId: session.accountId }),
    passwordCredentialStatus({ accountId: session.accountId }),
  ]);
  if (credential.enabled) {
    return response(409, { error: "password_already_enabled", message: "Use Change password for an enabled credential." });
  }
  if (wallet?.status !== "linked" || !wallet.address) {
    return response(409, {
      error: "password_wallet_required",
      message: "Link a wallet to this account before enabling password login.",
    });
  }
  const created = await createWalletChallenge({
    accountId: session.accountId,
    purpose: "password_enable",
  });
  if (!created.ok) return response(created.status || 400, { error: created.error || "password_wallet_challenge_failed", message: "Wallet verification could not start." });
  return response(200, {
    message: "Sign this challenge with the unlocked linked wallet.",
    challenge: {
      id: created.challenge.id,
      accountId: created.challenge.accountId,
      purpose: created.challenge.purpose,
      message: created.challenge.message,
      expiresAt: created.challenge.expiresAt,
    },
  });
}

export async function passwordEnableVerify(payload = {}, session = null) {
  if (!session?.accountId) return response(401, { error: "password_login_required", message: "Sign in to enable an account password." });
  const credential = await passwordCredentialStatus({ accountId: session.accountId });
  if (credential.enabled) return response(409, { error: "password_already_enabled", message: "Use Change password for an enabled credential." });
  const validated = validateAccountPassword(payload?.password);
  if (!validated.ok) return response(400, { error: validated.error, message: "Use an account password between 12 characters and 1,024 UTF-8 bytes." });
  const consumed = await consumeWalletChallenge({
    accountId: session.accountId,
    challengeId: payload?.challengeId,
    purpose: "password_enable",
  });
  if (!consumed.ok) return response(400, { error: consumed.error || "password_wallet_challenge_invalid", message: "That wallet challenge is invalid or expired." });
  const wallet = await getLinkedWallet({ accountId: session.accountId });
  const address = String(payload?.address || "").trim();
  const publicKey = String(payload?.publicKey || "").trim();
  const signature = String(payload?.signature || "").trim();
  const walletMatches = wallet?.status === "linked" && wallet.address && wallet.address === address;
  const proofValid = walletMatches && verifyWalletSignature({
    message: consumed.challenge.message,
    address,
    publicKey,
    signature,
  });
  if (!proofValid) {
    await record("user.password.enable_failed", session.accountId, "rejected", walletMatches ? "wallet_signature_invalid" : "wallet_account_mismatch");
    return response(400, {
      error: walletMatches ? "password_wallet_signature_invalid" : "password_wallet_mismatch",
      message: walletMatches
        ? "The unlocked wallet signature did not verify."
        : "The unlocked wallet does not match the wallet linked to this account.",
    });
  }
  await setAccountPassword({ accountId: session.accountId, password: validated.password });
  await revokeSessionsForAccount({ accountId: session.accountId });
  const account = await getAccount(session.accountId);
  const created = await createAccountSession(account, { provider: "password", assurance: "medium" });
  await record("user.password.enabled", session.accountId, "enabled", "linked_wallet_signature");
  return response(200, { message: "Account password enabled.", password: await accountPasswordProfile(session.accountId), session: created.session }, created.sessionId);
}

export async function passwordLogin(payload = {}) {
  const identifier = safeIdentifier(payload?.identifier || payload?.email);
  const account = identifier
    ? identifier.indexOf("@") > 0
      ? await findAccountByEmail(identifier)
      : await findAccountByHandle(identifier)
    : null;
  const verified = await verifyAccountPassword({ accountId: account?.id || "", password: payload?.password });
  if (!account?.id || !verified.ok) {
    await record("user.password.login_failed", account?.id || "", "rejected", "password_login_invalid");
    return response(401, { error: "password_login_invalid", message: "Email, handle, or account password is incorrect." });
  }
  const created = await createAccountSession(account, { provider: "password", assurance: "medium" });
  await record("user.password.login_succeeded", account.id, "verified", "password");
  return response(200, { message: "Signed in.", session: created.session }, created.sessionId);
}

export async function passwordChange(payload = {}, session = null) {
  if (!session?.accountId) return response(401, { error: "password_login_required", message: "Sign in to change the account password." });
  const current = await verifyAccountPassword({ accountId: session.accountId, password: payload?.currentPassword });
  if (!current.ok) return response(401, { error: "password_reauth_required", message: "The current account password is incorrect." });
  const validated = validateAccountPassword(payload?.newPassword);
  if (!validated.ok) return response(400, { error: validated.error, message: "Use an account password between 12 characters and 1,024 UTF-8 bytes." });
  await setAccountPassword({ accountId: session.accountId, password: validated.password });
  await revokeSessionsForAccount({ accountId: session.accountId });
  const account = await getAccount(session.accountId);
  const created = await createAccountSession(account, { provider: "password", assurance: "medium" });
  await record("user.password.changed", session.accountId, "changed", "current_password");
  return response(200, { message: "Account password changed.", session: created.session }, created.sessionId);
}

export async function passwordDisable(payload = {}, session = null) {
  if (!session?.accountId) return response(401, { error: "password_login_required", message: "Sign in to disable the account password." });
  const current = await verifyAccountPassword({ accountId: session.accountId, password: payload?.currentPassword });
  if (!current.ok) return response(401, { error: "password_reauth_required", message: "The current account password is incorrect." });
  const account = await getAccount(session.accountId);
  const oauthMethods = (account?.linkedProviders || []).filter((item) => ["github", "telegram", "x", "discord"].includes(item?.id)).length;
  const emailSurvives = Boolean(account?.primaryEmailVerified && account?.primaryEmailCanonical);
  if (!emailSurvives && oauthMethods === 0) {
    return response(409, { error: "password_disable_last_login_method", message: "Add another login method before disabling the account password." });
  }
  const disabled = await disableAccountPassword({ accountId: session.accountId });
  if (!disabled.ok) return response(409, { error: disabled.error, message: "Account password is not enabled." });
  await revokeSessionsForAccount({ accountId: session.accountId });
  const fallbackProvider = emailSurvives
    ? "email"
    : (account?.linkedProviders || []).find((item) => ["github", "telegram", "x", "discord"].includes(item?.id))?.id || "email";
  const created = await createAccountSession(account, { provider: fallbackProvider, assurance: account?.assurance || "low" });
  await record("user.password.disabled", session.accountId, "disabled", "current_password");
  return response(200, {
    message: "Account password disabled.",
    password: await accountPasswordProfile(session.accountId),
    session: created.session,
  }, created.sessionId);
}

export async function passwordResetStart(payload = {}, requestMeta = {}) {
  return authEmailStart({ email: payload?.email }, "POST", {
    ...requestMeta,
    emailPurpose: "password_reset",
  });
}

export async function passwordResetVerify(payload = {}) {
  const validated = validateAccountPassword(payload?.password);
  if (!validated.ok) return response(400, { error: validated.error, message: "Use an account password between 12 characters and 1,024 UTF-8 bytes." });
  const consumed = await consumeVerifiedEmailCode({
    challengeId: payload?.challengeId,
    code: payload?.code,
    purpose: "password_reset",
  });
  if (!consumed.ok) return response(400, { error: "email_code_invalid", message: "That verification code is invalid or expired." });
  const account = await findAccountByEmail(consumed.challenge.canonicalEmail);
  const status = account?.id ? await passwordCredentialStatus({ accountId: account.id }) : { enabled: false };
  if (!account?.id || !status.enabled) return response(400, { error: "password_reset_invalid", message: "That password reset request is invalid or expired." });
  await setAccountPassword({ accountId: account.id, password: validated.password });
  await revokeSessionsForAccount({ accountId: account.id });
  const created = await createAccountSession(account, { provider: "password", assurance: "medium" });
  await record("user.password.reset", account.id, "reset", "verified_email");
  return response(200, { message: "Account password reset.", session: created.session }, created.sessionId);
}
