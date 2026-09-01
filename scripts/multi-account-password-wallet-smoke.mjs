#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasknode-multi-account-auth-"));
process.env.TASKNODE_STORE_PATH = path.join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_AUTH_SECRET = "multi-account-password-wallet-smoke-secret";
process.env.TASKNODE_EMAIL_DEV_DELIVERY = "true";
process.env.TASKNODE_INITIAL_PROVIDER_CREDIT_USD = "0";
process.env.TASKNODE_PUBLIC_URL = "http://localhost:5174";
process.env.GITHUB_CLIENT_ID = "multi-account-github-client";
process.env.GITHUB_CLIENT_SECRET = "multi-account-github-secret";

const { authEmailStart, authEmailVerify, authStart, consumeVerifiedEmailCode } = await import("../server/product-contracts.js");
const {
  passwordDisable,
  passwordEnableStart,
  passwordEnableVerify,
  passwordLogin,
  passwordResetStart,
  passwordResetVerify,
  passwordStatus,
} = await import("../server/account-password-auth.js");
const {
  accountList,
  accountLogoutAll,
  accountRemove,
  accountSwitch,
  registerAuthenticatedAccountSet,
} = await import("../server/account-switching.js");
const { getSession } = await import("../server/repositories/auth-sessions.js");
const { consumeOAuthState } = await import("../server/repositories/auth-challenges.js");
const { getLinkedWallet, linkWalletToAccount } = await import("../server/repositories/account-wallets.js");
const { findAccountByEmail, findAccountByHandle, getOrCreateProviderAccount } = await import("../server/repositories/accounts.js");
const { setAccountHiveHandle } = await import("../server/repositories/account-profiles.js");
const { deriveWalletSummary, generateTaskNodeMnemonic, signWalletChallenge } = await import("../src/wallet-core.js");

async function linkTestWallet(accountId) {
  const mnemonic = generateTaskNodeMnemonic();
  const wallet = deriveWalletSummary(mnemonic);
  const linked = await linkWalletToAccount({
    accountId,
    address: wallet.address,
    publicKey: wallet.publicKey,
    proofPurpose: "wallet_link",
  });
  assert.equal(linked.ok, true);
  return { mnemonic, ...wallet };
}

function signedEnablePayload(started, wallet, password) {
  const proof = signWalletChallenge(wallet.mnemonic, started.body.challenge.message);
  return {
    challengeId: started.body.challenge.id,
    address: proof.address,
    publicKey: proof.publicKey,
    signature: proof.signature,
    password,
  };
}

async function emailLogin(email) {
  const started = await authEmailStart({ email }, "POST", { ip: "127.0.0.1", userAgent: "multi-account-smoke" });
  assert.equal(started.status, 200);
  const verified = await authEmailVerify({
    challengeId: started.body.challengeId,
    code: started.body.delivery.devCode,
  }, "POST");
  assert.equal(verified.status, 200);
  return verified;
}

try {
  const loginA = await emailLogin("multi-a@example.com");
  const accountA = loginA.body.session.accountId;
  const originalSessionA = loginA.sessionId;
  assert.equal("id" in loginA.body.session, false, "session bearer tokens must not be returned in JSON");

  const addOauth = await authStart("github", {
    origin: "http://localhost:5174",
    session: loginA.body.session,
    authIntent: "add_account",
  });
  const addOauthState = await consumeOAuthState({ provider: "github", stateId: addOauth.oauthState.value, peek: true });
  assert.equal(addOauthState.linkAccountId, "", "add-account OAuth must not link to the selected account");
  assert.equal(addOauthState.metadata.authIntent, "add_account");
  const linkOauth = await authStart("github", {
    origin: "http://localhost:5174",
    session: loginA.body.session,
  });
  const linkOauthState = await consumeOAuthState({ provider: "github", stateId: linkOauth.oauthState.value, peek: true });
  assert.equal(linkOauthState.linkAccountId, accountA, "Security OAuth must retain selected-account linking");
  assert.equal(linkOauthState.metadata.authIntent, "link_provider");

  const noWalletStart = await passwordEnableStart({}, loginA.body.session);
  assert.equal(noWalletStart.status, 409, "password enablement must require a linked wallet");
  const passwordWalletA = await linkTestWallet(accountA);
  const enableStarted = await passwordEnableStart({}, loginA.body.session);
  assert.equal(enableStarted.status, 200);
  assert.equal(enableStarted.body.challenge.accountId, accountA);
  const ordinaryLoginChallenge = await authEmailStart({ email: "multi-a@example.com" }, "POST");
  const wrongPurpose = await consumeVerifiedEmailCode({
    challengeId: ordinaryLoginChallenge.body.challengeId,
    code: ordinaryLoginChallenge.body.delivery.devCode,
    purpose: "password_reset",
  });
  assert.equal(wrongPurpose.ok, false, "a login challenge must not authorize a password reset");

  const enabled = await passwordEnableVerify(
    signedEnablePayload(enableStarted, passwordWalletA, "A-password-long-enough-1"),
    loginA.body.session
  );
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.session.accountId, accountA);
  assert.equal(await getSession(originalSessionA), null, "enabling a password must revoke the old session");
  assert.equal((await passwordEnableStart({}, enabled.body.session)).body.error, "password_already_enabled");

  const wrongKnown = await passwordLogin({ email: "multi-a@example.com", password: "wrong-password-value" });
  const wrongUnknown = await passwordLogin({ email: "unknown@example.com", password: "wrong-password-value" });
  assert.deepEqual(
    { status: wrongKnown.status, error: wrongKnown.body.error, message: wrongKnown.body.message },
    { status: wrongUnknown.status, error: wrongUnknown.body.error, message: wrongUnknown.body.message },
    "known and unknown password failures must be indistinguishable"
  );

  const passwordA = await passwordLogin({ email: "multi-a@example.com", password: "A-password-long-enough-1" });
  assert.equal(passwordA.status, 200);
  assert.equal(passwordA.body.session.accountId, accountA, "password login must resume the existing account");
  let accountSet = await registerAuthenticatedAccountSet({ accountId: accountA, sessionId: passwordA.sessionId });
  assert.ok(accountSet?.token);

  const oauthOnly = await getOrCreateProviderAccount({
    provider: "x",
    providerUserId: "multi-account-oauth-only",
    username: "oauth-only-user",
    displayName: "OAuth Only User",
  });
  assert.ok(oauthOnly?.id);
  const handleSet = await setAccountHiveHandle({ accountId: oauthOnly.id, handle: "oauth-only-handle" });
  assert.equal(handleSet.ok, true);
  const oauthSession = { ...oauthOnly, hiveHandle: handleSet.account.hiveHandle, accountId: oauthOnly.id };
  assert.equal((await passwordStatus(oauthSession)).body.password.available, false);
  assert.equal((await passwordEnableStart({}, oauthSession)).status, 409);
  const oauthWallet = await linkTestWallet(oauthOnly.id);
  const oauthStatus = await passwordStatus(oauthSession);
  assert.equal(oauthStatus.body.password.available, true);
  assert.equal(oauthStatus.body.password.maskedEmail, "", "verified email must not be required");
  const oauthEnableStarted = await passwordEnableStart({}, oauthSession);
  assert.equal(oauthEnableStarted.status, 200, "OAuth-only accounts with a linked wallet must be able to enable a password");
  const wrongWallet = { mnemonic: generateTaskNodeMnemonic() };
  const mismatch = await passwordEnableVerify(
    signedEnablePayload(oauthEnableStarted, wrongWallet, "OAuth-password-long-enough-3"),
    oauthSession
  );
  assert.equal(mismatch.body.error, "password_wallet_mismatch", "a different unlocked wallet must not authorize the account");
  const freshOauthEnable = await passwordEnableStart({}, oauthSession);
  const oauthEnabled = await passwordEnableVerify(
    signedEnablePayload(freshOauthEnable, oauthWallet, "OAuth-password-long-enough-3"),
    oauthSession
  );
  assert.equal(oauthEnabled.status, 200);
  assert.equal(oauthEnabled.body.session.accountId, oauthOnly.id, "wallet authorization must stay on the selected OAuth account");
  assert.equal(await findAccountByEmail("oauth-only@example.com"), null, "password enablement must not create an email identity");
  assert.equal((await findAccountByHandle("@oauth-only-handle")).id, oauthOnly.id);
  assert.equal((await passwordLogin({ identifier: "oauth-only@example.com", password: "OAuth-password-long-enough-3" })).status, 401);
  const handleLogin = await passwordLogin({ identifier: "@oauth-only-handle", password: "OAuth-password-long-enough-3" });
  assert.equal(handleLogin.status, 200);
  assert.equal(handleLogin.body.session.accountId, oauthOnly.id, "public-handle password login must resume the same account");
  const displayNameLogin = await passwordLogin({ identifier: "OAuth Only User", password: "OAuth-password-long-enough-3" });
  assert.equal(displayNameLogin.status, 401, "display names must not become ambiguous login identifiers");

  const loginB = await emailLogin("multi-b@example.com");
  const accountB = loginB.body.session.accountId;
  assert.notEqual(accountA, accountB);
  accountSet = await registerAuthenticatedAccountSet({
    accountId: accountB,
    accountSetToken: accountSet.token,
    sessionId: loginB.sessionId,
  });
  const listed = await accountList({
    accountSetToken: accountSet.token,
    session: loginB.body.session,
    sessionId: loginB.sessionId,
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(new Set(listed.body.accounts.map((entry) => entry.accountId)), new Set([accountA, accountB]));

  const switched = await accountSwitch({
    accountSetToken: listed.accountSetToken,
    payload: { targetAccountId: accountA },
    session: loginB.body.session,
    sessionId: loginB.sessionId,
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.session.accountId, accountA);
  assert.equal("id" in switched.body.session, false, "switch responses must not return session bearer tokens");
  assert.equal(await getSession(loginB.sessionId), null, "switching must revoke the prior selected session");

  const walletA = `rMultiAccountA${Date.now()}`;
  const walletB = `rMultiAccountB${Date.now()}`;
  assert.equal((await linkWalletToAccount({ accountId: accountA, address: walletA, publicKey: "PUB-A" })).ok, true);
  const conflict = await linkWalletToAccount({ accountId: accountB, address: walletA, publicKey: "PUB-B-CONFLICT" });
  assert.equal(conflict.error, "wallet_owned_by_other_account");
  assert.equal((await linkWalletToAccount({ accountId: accountB, address: walletB, publicKey: "PUB-B" })).ok, true);

  const removed = await accountRemove({
    accountSetToken: switched.accountSetToken,
    payload: { targetAccountId: accountB },
    session: switched.body.session,
  });
  assert.equal(removed.status, 200);
  assert.equal((await getLinkedWallet({ accountId: accountB })).address, walletB, "removing a retained account must not delete its wallet link");

  const resetStarted = await passwordResetStart({ email: "multi-a@example.com" });
  assert.equal(resetStarted.status, 200);
  const reset = await passwordResetVerify({
    challengeId: resetStarted.body.challengeId,
    code: resetStarted.body.delivery.devCode,
    password: "A-replacement-password-2",
  });
  assert.equal(reset.status, 200);
  const resetAccountSet = await registerAuthenticatedAccountSet({
    accountId: accountA,
    accountSetToken: switched.accountSetToken,
    sessionId: reset.sessionId,
  });
  assert.equal((await passwordLogin({ email: "multi-a@example.com", password: "A-password-long-enough-1" })).status, 401);
  assert.equal((await passwordLogin({ email: "multi-a@example.com", password: "A-replacement-password-2" })).status, 200);

  const disabled = await passwordDisable({ currentPassword: "A-replacement-password-2" }, reset.body.session);
  assert.equal(disabled.status, 200);
  assert.equal(await getSession(reset.sessionId), null, "disabling a password must rotate the selected session");
  const disabledAccountSet = await registerAuthenticatedAccountSet({
    accountId: accountA,
    accountSetToken: resetAccountSet.token,
    sessionId: disabled.sessionId,
  });
  const disabledFailure = await passwordLogin({ email: "multi-a@example.com", password: "A-replacement-password-2" });
  assert.deepEqual(
    { status: disabledFailure.status, error: disabledFailure.body.error, message: disabledFailure.body.message },
    { status: wrongUnknown.status, error: wrongUnknown.body.error, message: wrongUnknown.body.message },
    "disabled and unknown password failures must be indistinguishable"
  );

  const loggedOut = await accountLogoutAll({
    accountSetToken: disabledAccountSet.token,
    session: disabled.body.session,
    sessionId: disabled.sessionId,
  });
  assert.equal(loggedOut.status, 200);
  assert.equal(await getSession(disabled.sessionId), null);

  console.log("multi-account password wallet smoke ok: linked-wallet authorization, email-free handle login, isolated credentials, sessions, account set, and wallets");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
