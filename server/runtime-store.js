import { createHash, randomUUID } from "node:crypto";
import {
  accountIdentityProfile as buildAccountIdentityProfile,
  applyAccountAliasVisibility,
  applyAccountHiveHandle,
  applyAccountProfileVisibility,
  checkHiveHandleAvailability as checkHiveHandleAvailabilityForAccounts,
  normalizeHiveHandle,
  providerAliasDefaults,
  suggestHiveHandles as suggestHiveHandlesForAccounts,
} from "./account-identity.js";
import { deleteRuntimeAccountDataForState } from "./account-deletion-state.js";
import { exportRuntimeAccountDataForState } from "./account-export-state.js";
import {
  getTelegramBotPreferencesForState,
  listRuntimeTelegramBotEventsForState,
  recordRuntimeTelegramBotEventForState,
  setTelegramBotModePreferenceForState,
} from "./runtime-store-telegram-bot.js";
import { accountDeletionAuditSnapshot } from "./account-deletion-audit.js";
import {
  getOrCreateRuntimeEthereumDepositAccount,
  getRuntimeEthereumDepositAccount,
  retireRuntimeEthereumDepositAccount,
  updateRuntimeEthereumDepositSync,
} from "./runtime-store-ethereum-deposits.js";
import { createRuntimeTerminalAuthStore } from "./runtime-store-terminal-auth.js";
import { createRuntimeChatContextStore } from "./runtime-store-chat-context.js";
import { createRuntimeWalletStore } from "./runtime-store-wallet.js";
import { createRuntimeAuthChallengeStore } from "./runtime-store-auth-challenges.js";
import { createRuntimeWalletGrantStore } from "./runtime-store-wallet-grants.js";
import { createRuntimeAccountLoginStore } from "./runtime-store-account-login.js";
import { runtimePasswordCredentialEnabled } from "./repositories/account-passwords.js";
import {
  normalizeAccountProfileVisibility,
  saveState,
  state,
  storePath,
} from "./runtime-store-state.js";
export {
  clearLegacyAuthStateAfterMigration,
  clearLegacyEthereumDepositsAfterMigration,
  clearLegacyTerminalAuthAfterMigration,
  legacyAccountStateSnapshotForMigration,
  legacyAccountWalletSnapshotForMigration,
  legacyAuthStateSnapshotForMigration,
  legacyEthereumDepositSnapshotForMigration,
  legacyTerminalAuthSnapshotForMigration,
  replaceRuntimeAccountStateFromDurable,
  runtimeStoreStatus,
} from "./runtime-store-state.js";
export const sessionCookieName = "tasknode_session";
export const sessionTtlSeconds = 60 * 60 * 24 * 7;
export { normalizeHiveHandle } from "./account-identity.js";
const configuredWalletLoginChallengeCap = Number(process.env.TASKNODE_WALLET_LOGIN_CHALLENGE_CAP || 3000);
const walletLoginChallengeMaxActive = Number.isSafeInteger(configuredWalletLoginChallengeCap) && configuredWalletLoginChallengeCap > 0 ? configuredWalletLoginChallengeCap : 3000;
const authChallengeStore = createRuntimeAuthChallengeStore({ state, saveState });
export const consumeEmailChallenge = authChallengeStore.consumeEmailChallenge;
export const attachRuntimeSessionToDeviceAccountSet = authChallengeStore.attachSessionToDeviceAccountSet;
export const consumeOAuthState = authChallengeStore.consumeOAuthState;
export const createEmailChallenge = authChallengeStore.createEmailChallenge;
export const createOAuthState = authChallengeStore.createOAuthState;
export const destroySession = authChallengeStore.destroySession;
export const getEmailChallenge = authChallengeStore.getEmailChallenge;
export const pruneExpiredEmailChallenges = authChallengeStore.pruneExpiredEmailChallenges;
export const pruneExpiredOAuthStates = authChallengeStore.pruneExpiredOAuthStates;
export const recordAuthEvent = authChallengeStore.recordAuthEvent;
export const revokeRuntimeSessionsForAccount = authChallengeStore.revokeSessionsForAccount;
export const revokeRuntimeSessionsForDeviceAccountSet = authChallengeStore.revokeSessionsForDeviceAccountSet;

function safeId(value, fallback) {
  const normalized =
    typeof value === "string"
      ? value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
      : "";
  return (normalized || fallback).slice(0, 80);
}

function stableId(value, prefix) {
  const digest = createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function contextHistorySnapshotKey({ accountId = "", walletAddress = "" } = {}) {
  const accountKey = safeId(accountId, "account");
  const walletKey = safeId(walletAddress, "wallet");
  return `${accountKey}:${walletKey}`;
}

function identityKey(provider, providerUserId) {
  return `${String(provider || "").toLowerCase()}:${String(providerUserId || "").trim()}`;
}

const chatContextStore = createRuntimeChatContextStore({ state, saveState, safeId, contextHistorySnapshotKey, storePath });
export const appendChatTurn = chatContextStore.appendChatTurn;
export const appendUsageCredit = chatContextStore.appendUsageCredit;
export const conversationIdForSession = chatContextStore.conversationIdForSession;
export const deleteChatConversation = chatContextStore.deleteChatConversation;
export const getChatMessages = chatContextStore.getChatMessages;
export const getContextDocument = chatContextStore.getContextDocument;
export const getContextHistory = chatContextStore.getContextHistory;
export const listChatConversations = chatContextStore.listChatConversations;
export const renameChatConversation = chatContextStore.renameChatConversation;
export const saveContextDocument = chatContextStore.saveContextDocument;
export const saveContextHistoryProjection = chatContextStore.saveContextHistoryProjection;
export const usageLedger = chatContextStore.usageLedger;
export const usageSummary = chatContextStore.usageSummary;

function accountIdentityProfile(account = null, options = {}) {
  return buildAccountIdentityProfile(account, {
    accounts: state.accounts || {},
    ...options,
  });
}

export function checkHiveHandleAvailability(params = {}) {
  return checkHiveHandleAvailabilityForAccounts({
    ...params,
    accounts: state.accounts || {},
  });
}

export function suggestHiveHandles(params = {}) {
  return suggestHiveHandlesForAccounts({
    ...params,
    accounts: state.accounts || {},
  });
}

function sessionPayload(session) {
  if (!session) return null;
  const account = state.accounts[session.accountId] || null;
  const identityProfile = accountIdentityProfile(account);

  return {
    id: session.id,
    accountId: session.accountId,
    status: "signed_in",
    displayName: identityProfile?.displayName || session.displayName,
    hiveHandle: identityProfile?.hiveHandle || session.hiveHandle || "",
    publicDisplayName: identityProfile?.publicDisplayName || session.publicDisplayName || "",
    profileVisibility: identityProfile?.profileVisibility || session.profileVisibility || "public",
    profileDiscoverable: identityProfile?.profileDiscoverable !== false,
    identityProfile,
    primaryProvider: session.primaryProvider,
    deviceAccountSetId: session.deviceAccountSetId || null,
    linkedProviders: session.linkedProviders || [],
    assurance: session.assurance || "low",
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

export function pruneExpiredSessions() {
  const now = Date.now();
  let changed = false;

  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (!session?.expiresAt || Date.parse(session.expiresAt) <= now) {
      delete state.sessions[sessionId];
      changed = true;
    }
  }

  if (changed) saveState();
}

function displayNameFromEmail(email) {
  const localPart = email.split("@")[0] || "dev";
  const words = localPart
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return "Task Node Dev";
  return words
    .slice(0, 2)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function displayNameFromWalletAddress(address = "") {
  const normalized = String(address || "").trim();
  if (!normalized) return "Task Node Wallet";
  if (normalized.length <= 16) return `Wallet ${normalized}`;
  return `Wallet ${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
}

function accountPayload(account) {
  if (!account) return null;
  const identityProfile = accountIdentityProfile(account, { includeSuggestions: false });

  return {
    id: account.id,
    status: account.status || "active",
    displayName: identityProfile?.displayName || account.displayName,
    hiveHandle: identityProfile?.hiveHandle || "",
    publicDisplayName: identityProfile?.publicDisplayName || "",
    profileVisibility: identityProfile?.profileVisibility || "public",
    profileDiscoverable: identityProfile?.profileDiscoverable !== false,
    primaryProvider: account.primaryProvider || "email",
    primaryEmailCanonical: account.primaryEmailCanonical || "",
    primaryEmailVerified: account.primaryEmailVerified === true,
    emailProvider: account.emailProvider || "",
    linkedProviders: account.linkedProviders || [],
    assurance: account.assurance || "low",
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function linkedEmailProvider({ maskedEmail, verified = true } = {}) {
  return {
    id: "email",
    label: "Email",
    kind: "email_code",
    status: verified ? "verified" : "linked",
    maskedEmail: maskedEmail || null,
  };
}

function providerLabel(provider) {
  if (provider === "github") return "GitHub";
  if (provider === "x") return "X";
  if (provider === "discord") return "Discord";
  if (provider === "telegram") return "Telegram";
  if (provider === "wallet") return "Wallet";
  return "Provider";
}

function linkedProvider({
  provider,
  providerUserId,
  username,
  displayName = "",
  profileUrl,
  email,
  emailVerified = false,
  metadata = {},
}) {
  const safeMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...metadata } : {};
  return providerAliasDefaults({
    id: provider,
    label: providerLabel(provider),
    kind: "oauth",
    status: "linked",
    providerUserId,
    username: username || null,
    displayName: displayName || null,
    profileUrl: profileUrl || null,
    email: email || null,
    emailVerified: Boolean(emailVerified),
    ...(Object.keys(safeMetadata).length ? { metadata: safeMetadata } : {}),
  });
}

function devProvider() {
  return {
    id: "dev",
    label: "Dev session",
    kind: "development",
    status: "linked",
  };
}

function linkedWalletProvider({ address = "", publicKey = "" } = {}) {
  const normalizedAddress = String(address || "").trim();
  return providerAliasDefaults({
    id: "wallet",
    label: "Wallet",
    kind: "wallet_signature",
    status: "verified",
    providerUserId: normalizedAddress,
    username: normalizedAddress,
    displayName: displayNameFromWalletAddress(normalizedAddress),
    profileUrl: null,
    publicKey: String(publicKey || "").trim() || null,
  });
}

function mergeLinkedProvider(account, providerPayload) {
  const existing = Array.isArray(account.linkedProviders) ? account.linkedProviders : [];
  const prior = existing.find((item) => item?.id === providerPayload.id) || {};
  const merged = providerAliasDefaults({
    ...prior,
    ...providerPayload,
    aliasVisibility: prior.aliasVisibility || providerPayload.aliasVisibility,
    discloseHandle: prior.discloseHandle === true || providerPayload.discloseHandle === true,
    discloseVerifiedBadge: prior.discloseVerifiedBadge === true || providerPayload.discloseVerifiedBadge === true,
    linkedAt: prior.linkedAt || new Date().toISOString(),
  });
  account.linkedProviders = existing
    .filter((item) => item?.id !== providerPayload.id)
    .concat(merged);
}

const walletStore = createRuntimeWalletStore({
  state,
  saveState,
  safeId,
  stableId,
  normalizeAccountProfileVisibility,
  accountPayload,
  mergeLinkedProvider,
  linkedWalletProvider,
  displayNameFromWalletAddress,
  syncAccountSessions,
  walletLoginChallengeMaxActive,
});
export const accountWalletCloudFacts = walletStore.accountWalletCloudFacts;
export const consumeWalletChallenge = walletStore.consumeWalletChallenge;
export const consumeWalletLoginChallenge = walletStore.consumeWalletLoginChallenge;
export const createWalletChallenge = walletStore.createWalletChallenge;
export const createWalletLoginChallenge = walletStore.createWalletLoginChallenge;
export const delinkWalletFromAccount = walletStore.delinkWalletFromAccount;
export const findAccountByLinkedWallet = walletStore.findAccountByLinkedWallet;
export const getLinkedWallet = walletStore.getLinkedWallet;
export const linkWalletToAccount = walletStore.linkWalletToAccount;
export const pruneExpiredWalletChallenges = walletStore.pruneExpiredWalletChallenges;
export const resolveOrCreateWalletLoginAccount = walletStore.resolveOrCreateWalletLoginAccount;
const walletCreatedInAccountForRecord = walletStore.walletCreatedInAccountForRecord;

const walletGrantStore = createRuntimeWalletGrantStore({ state, saveState, safeId, walletCreatedInAccountForRecord });
export const completeWalletInitiationGrant = walletGrantStore.completeWalletInitiationGrant;
export const failWalletInitiationGrant = walletGrantStore.failWalletInitiationGrant;
export const reserveWalletInitiationGrant = walletGrantStore.reserveWalletInitiationGrant;
export const resolveWalletInitiationGrantStatus = walletGrantStore.resolveWalletInitiationGrantStatus;
export const walletInitiationGrantStatus = walletGrantStore.walletInitiationGrantStatus;

export function getAccount(accountId) {
  return accountPayload(state.accounts[accountId] || null);
}

export function getLinkedProviderForAccount({ accountId = "", provider = "" } = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!normalizedAccountId || !normalizedProvider) return null;
  const account = state.accounts[normalizedAccountId] || null;
  const linked = Array.isArray(account?.linkedProviders) ? account.linkedProviders : [];
  return linked.find((item) => String(item?.id || "").trim().toLowerCase() === normalizedProvider) || null;
}

export function accountHasLinkedProvider({ accountId = "", provider = "" } = {}) {
  return Boolean(getLinkedProviderForAccount({ accountId, provider }));
}

export function getAccountDeletionAuditSnapshot({ accountId = "" } = {}) {
  const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
  return accountDeletionAuditSnapshot(state.accounts[normalizedAccountId] || null);
}

export function exportAccountRuntimeData({ accountId = "" } = {}) { return exportRuntimeAccountDataForState({ state, accountId, safeId }); }

function syncAccountSessions(account) {
  if (!account?.id) return;
  const identityProfile = accountIdentityProfile(account);
  for (const session of Object.values(state.sessions || {})) {
    if (session?.accountId !== account.id) continue;
    session.displayName = identityProfile?.displayName || account.displayName;
    session.hiveHandle = identityProfile?.hiveHandle || "";
    session.publicDisplayName = identityProfile?.publicDisplayName || "";
    session.profileVisibility = identityProfile?.profileVisibility || "public";
    session.primaryProvider = account.primaryProvider || session.primaryProvider;
    session.linkedProviders = account.linkedProviders || [];
  }
}

const accountLoginStore = createRuntimeAccountLoginStore({
  state,
  accountPayload,
  normalizeHiveHandle,
});
export const findAccountByEmail = accountLoginStore.findAccountByEmail;
export const findAccountByHandle = accountLoginStore.findAccountByHandle;
const UNLINKABLE_OAUTH_PROVIDERS = new Set(["github", "telegram", "x", "discord"]);

function hasVerifiedEmailLogin(account, canonicalEmail = "") {
  const canonical = String(canonicalEmail || "").trim().toLowerCase();
  return Boolean(
    account?.id
    && canonical
    && account.primaryEmailVerified
    && account.primaryEmailCanonical === canonical
    && state.accountEmails[canonical] === account.id
  );
}

export function unlinkProviderFromAccount({ accountId = "", provider = "" } = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!normalizedAccountId || !normalizedProvider) {
    return { ok: false, error: "provider_unlink_invalid" };
  }
  if (!UNLINKABLE_OAUTH_PROVIDERS.has(normalizedProvider)) {
    return { ok: false, error: "provider_unlink_unsupported" };
  }

  const account = state.accounts[normalizedAccountId];
  if (!account) return { ok: false, error: "account_not_found" };

  const linked = Array.isArray(account.linkedProviders) ? account.linkedProviders : [];
  const target = linked.find((item) => item?.id === normalizedProvider);
  if (!target) return { ok: false, error: "provider_not_linked" };

  const remainingProviders = linked.filter((item) => item?.id !== normalizedProvider);
  const remainingOauth = remainingProviders.filter((item) => UNLINKABLE_OAUTH_PROVIDERS.has(item?.id));

  // Email-code login is independent from provider provenance. If the account
  // still owns a verified email mapping, unlinking an OAuth provider must not
  // lock the user out just because that provider last verified the same email.
  const emailCanonical = account.primaryEmailCanonical || "";
  const emailOwnedByTarget = Boolean(emailCanonical) && account.emailProvider === normalizedProvider;
  const emailHeir = emailOwnedByTarget
    ? remainingProviders.find(
        (item) => item?.emailVerified && String(item?.email || "").trim().toLowerCase() === emailCanonical
      )
    : null;
  const emailSurvives = hasVerifiedEmailLogin(account, emailCanonical);
  const passwordSurvives = runtimePasswordCredentialEnabled(normalizedAccountId);

  // Lockout guard: the account must keep at least one way to sign back in.
  // Sign-in methods are a surviving verified email or another linked OAuth
  // provider; wallets are identity/custody, not login.
  if (!emailSurvives && !passwordSurvives && remainingOauth.length === 0) {
    return { ok: false, error: "provider_unlink_last_login_method" };
  }

  const now = new Date().toISOString();
  account.linkedProviders = remainingProviders;
  if (target.providerUserId) {
    const key = identityKey(normalizedProvider, target.providerUserId);
    if (state.accountIdentities[key] === normalizedAccountId) {
      delete state.accountIdentities[key];
    }
  }
  if (emailOwnedByTarget) {
    if (emailSurvives) {
      account.emailProvider = emailHeir?.id || "email";
    } else {
      if (state.accountEmails[emailCanonical] === normalizedAccountId) {
        delete state.accountEmails[emailCanonical];
      }
      delete account.primaryEmailOriginal;
      delete account.primaryEmailCanonical;
      delete account.primaryEmailVerified;
      delete account.emailProvider;
    }
  }
  if (account.primaryProvider === normalizedProvider) {
    // The lockout guard guarantees at least one of these exists.
    account.primaryProvider = remainingOauth[0]?.id || "email";
  }
  account.updatedAt = now;
  account.lastProviderUnlinkAt = now;
  syncAccountSessions(account);
  saveState();

  return {
    ok: true,
    provider: normalizedProvider,
    unlinkedUsername: target.username || null,
    remainingLoginMethods: (emailSurvives ? 1 : 0) + (passwordSurvives ? 1 : 0) + remainingOauth.length,
    account: accountPayload(account),
  };
}

export function getAccountIdentityProfile({ accountId = "" } = {}) {
  return accountIdentityProfile(state.accounts[String(accountId || "").trim()] || null);
}

function safeExpertText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeExpertNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeExpertStringArray(values = [], maxItems = 20, maxLength = 240) {
  return (Array.isArray(values) ? values : [])
    .map((value) => safeExpertText(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeExpertReview(review = {}) {
  const source = review && typeof review === "object" && !Array.isArray(review) ? review : {};
  if (!Object.keys(source).length) return {};
  return {
    status: safeExpertText(source.status, 80),
    topic: safeExpertText(source.topic, 160),
    score: Math.min(100, Math.max(0, Math.round(safeExpertNumber(source.score, 0)))),
    thresholdScore: Math.min(100, Math.max(0, Math.round(safeExpertNumber(source.thresholdScore, 80)))),
    personalTaskCount: Math.max(0, Math.round(safeExpertNumber(source.personalTaskCount, 0))),
    requiredPersonalTaskCount: Math.max(0, Math.round(safeExpertNumber(source.requiredPersonalTaskCount, 20))),
    reviewedTaskIds: safeExpertStringArray(source.reviewedTaskIds, 40, 180),
    reviewedAt: safeExpertText(source.reviewedAt, 80) || null,
    recommendedExpertLabel: safeExpertText(source.recommendedExpertLabel, 160),
    summary: safeExpertText(source.summary, 700),
    strengths: safeExpertStringArray(source.strengths, 8, 240),
    weaknesses: safeExpertStringArray(source.weaknesses, 8, 240),
    disqualifyingConcerns: safeExpertStringArray(source.disqualifyingConcerns, 8, 240),
    evidenceTaskIds: safeExpertStringArray(source.evidenceTaskIds, 40, 180),
    provider: safeExpertText(source.provider, 80),
    model: safeExpertText(source.model, 120),
    responseId: safeExpertText(source.responseId, 200),
    promptDigest: safeExpertText(source.promptDigest, 80),
    promptVersion: safeExpertText(source.promptVersion, 120),
    usage: source.usage && typeof source.usage === "object" && !Array.isArray(source.usage)
      ? {
          inputTokens: safeExpertNumber(source.usage.inputTokens, 0),
          outputTokens: safeExpertNumber(source.usage.outputTokens, 0),
          totalTokens: safeExpertNumber(source.usage.totalTokens, 0),
          reasoningTokens: safeExpertNumber(source.usage.reasoningTokens, 0),
          costUsd: safeExpertNumber(source.usage.costUsd, 0),
          latencyMs: safeExpertNumber(source.usage.latencyMs, 0),
        }
      : {},
  };
}

export function getAccountExpertReview({ accountId = "" } = {}) {
  const account = state.accounts[String(accountId || "").trim()] || null;
  return normalizeExpertReview(account?.expertReview || {});
}

export function setAccountExpertReview({ accountId = "", review = {} } = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const account = state.accounts[normalizedAccountId];
  if (!account) {
    return {
      ok: false,
      status: 404,
      error: "account_not_found",
    };
  }
  account.expertReview = normalizeExpertReview(review);
  account.updatedAt = new Date().toISOString();
  state.accounts[normalizedAccountId] = account;
  syncAccountSessions(account);
  saveState();
  return {
    ok: true,
    expertReview: normalizeExpertReview(account.expertReview),
  };
}

export function listAccountIdentityProfiles() {
  return Object.values(state.accounts || {})
    .map((account) => accountIdentityProfile(account, {
      accounts: state.accounts,
      includeSuggestions: false,
    }))
    .filter(Boolean);
}

export function getAccountProfileVisibility({ accountId = "" } = {}) {
  const identityProfile = getAccountIdentityProfile({ accountId });
  return {
    visibility: identityProfile?.profileVisibility === "private" ? "private" : "public",
    discoverable: identityProfile?.profileDiscoverable !== false,
  };
}

export function listPublicAccountWalletIdentities() {
  return Object.entries(state.accountWallets || {})
    .map(([accountId, wallet]) => {
      const normalizedAccountId = safeId(accountId, "account");
      const walletAddress = String(wallet?.address || "").trim();
      if (!walletAddress || wallet?.status !== "linked") return null;

      const identityProfile = accountIdentityProfile(state.accounts[normalizedAccountId] || null, {
        includeSuggestions: false,
      });
      if (!identityProfile) return null;

      const firstPublicAlias = (identityProfile.publicAliases || []).find((alias) => alias?.handle);
      const displayName = (
        identityProfile.publicDisplayName ||
        (identityProfile.hiveHandle ? `@${identityProfile.hiveHandle}` : "") ||
        (firstPublicAlias?.handle ? `@${String(firstPublicAlias.handle).replace(/^@+/, "")}` : "")
      ).trim();
      if (!displayName) return null;

      return {
        accountId: normalizedAccountId,
        walletAddress,
        displayName: displayName.slice(0, 80),
        hiveHandle: identityProfile.hiveHandle || "",
        publicDisplayName: identityProfile.publicDisplayName || "",
        publicAliases: identityProfile.publicAliases || [],
        publicTrustBadges: identityProfile.publicTrustBadges || [],
      };
    })
    .filter(Boolean);
}

export function listDiscoverableAccountWalletIdentities() {
  return listPublicAccountWalletIdentities()
    .filter((identity) => (
      getAccountProfileVisibility({ accountId: identity.accountId }).discoverable === true
    ));
}

export function deleteAccountRuntimeData({ accountId = "", reason = "user_requested_account_delete", actorSessionId = "", archiveId = "" } = {}) {
  const result = deleteRuntimeAccountDataForState({ state, accountId, reason, actorSessionId, archiveId, safeId });
  saveState();
  return result;
}

export function setAccountHiveHandle({ accountId = "", handle = "", displayName } = {}) {
  const result = applyAccountHiveHandle({ accounts: state.accounts, accountId, handle, displayName });
  if (!result.ok) return result;
  syncAccountSessions(result.account);
  saveState();
  return { ...result, account: accountPayload(result.account) };
}

export function setAccountAliasVisibility({
  accountId = "",
  provider = "",
  visibility = "private",
  discloseHandle = false,
  discloseVerifiedBadge = false,
} = {}) {
  const result = applyAccountAliasVisibility({
    accounts: state.accounts,
    accountId,
    provider,
    visibility,
    discloseHandle,
    discloseVerifiedBadge,
  });
  if (!result.ok) return result;
  syncAccountSessions(result.account);
  saveState();
  return { ...result, account: accountPayload(result.account) };
}

export function setAccountProfileVisibility({ accountId = "", visibility = "public" } = {}) {
  const result = applyAccountProfileVisibility({
    accounts: state.accounts,
    accountId,
    visibility,
  });
  if (!result.ok) return result;
  syncAccountSessions(result.account);
  saveState();
  return { ...result, account: accountPayload(result.account) };
}

export function getTelegramBotPreferences({ accountId = "", chatId = "" } = {}) {
  return getTelegramBotPreferencesForState({ state, safeId, accountId, chatId });
}

export function setTelegramBotModePreference({ accountId = "", chatId = "", mode = "" } = {}) {
  return setTelegramBotModePreferenceForState({ state, saveState, safeId, accountId, chatId, mode });
}

export function recordRuntimeTelegramBotEvent(event = {}) {
  return recordRuntimeTelegramBotEventForState({ state, saveState, event });
}

export function listRuntimeTelegramBotEvents(options = {}) {
  return listRuntimeTelegramBotEventsForState({ state, ...options });
}

export function findAccountByIdentity(provider, providerUserId) {
  const accountId = state.accountIdentities[identityKey(provider, providerUserId)];
  return accountPayload(accountId ? state.accounts[accountId] : null);
}

export function getOrCreateEmailAccount({ email, canonicalEmail, maskedEmail }) {
  const canonical = String(canonicalEmail || "").trim();
  if (!canonical) return null;

  const existingId = state.accountEmails[canonical];
  const now = new Date().toISOString();
  if (existingId && state.accounts[existingId]) {
    const account = state.accounts[existingId];
    normalizeAccountProfileVisibility(account);
    account.updatedAt = now;
    account.emailLastSeenAt = now;
    account.primaryEmailOriginal = email || account.primaryEmailOriginal;
    state.accounts[existingId] = account;
    saveState();
    return accountPayload(account);
  }

  const accountId = stableId(canonical, "acct_email");
  const account = {
    id: accountId,
    status: "active",
    displayName: displayNameFromEmail(canonical),
    primaryEmailOriginal: email,
    primaryEmailCanonical: canonical,
    primaryEmailVerified: true,
    primaryProvider: "email",
    assurance: "low",
    profileVisibility: "public",
    linkedProviders: [linkedEmailProvider({ maskedEmail })],
    createdAt: now,
    updatedAt: now,
    emailLastSeenAt: now,
  };

  state.accounts[accountId] = account;
  state.accountEmails[canonical] = accountId;
  saveState();

  return accountPayload(account);
}

export function getOrCreateProviderAccount({
  provider,
  providerUserId,
  username = "",
  displayName = "",
  profileUrl = "",
  emailInfo = null,
  metadata = {},
}) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedProviderUserId = String(providerUserId || "").trim();
  if (!normalizedProvider || !normalizedProviderUserId) return null;

  const key = identityKey(normalizedProvider, normalizedProviderUserId);
  const now = new Date().toISOString();
  const email = emailInfo?.email || "";
  const emailVerified = emailInfo?.verified === true;
  const emailCanonical = emailVerified ? String(email).trim().toLowerCase() : "";
  const providerPayload = linkedProvider({
    provider: normalizedProvider,
    providerUserId: normalizedProviderUserId,
    username,
    displayName,
    profileUrl,
    email,
    emailVerified,
    metadata,
  });

  let accountId = state.accountIdentities[key];
  if (!accountId && emailCanonical) {
    accountId = state.accountEmails[emailCanonical] || "";
  }

  if (!accountId) {
    const derivedId = stableId(key, "acct_oauth");
    // Account ids are derived from the founding identity. If that identity was
    // later unlinked, its mapping is gone but the derived account still
    // exists; a fresh login with the identity must found a NEW account, not
    // silently re-enter the old one.
    accountId = state.accounts[derivedId] ? stableId(`${key}:refound:${now}`, "acct_oauth") : derivedId;
  }

  let account = state.accounts[accountId];
  if (!account) {
    account = {
      id: accountId,
      status: "active",
      displayName: displayName || username || providerLabel(normalizedProvider),
      primaryProvider: normalizedProvider,
      assurance: "medium",
      profileVisibility: "public",
      linkedProviders: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  normalizeAccountProfileVisibility(account);
  mergeLinkedProvider(account, providerPayload);
  account.status = account.status || "active";
  account.displayName = account.displayName || displayName || username || providerLabel(normalizedProvider);
  account.primaryProvider = account.primaryProvider || normalizedProvider;
  account.assurance = account.assurance === "high" ? "high" : "medium";
  account.updatedAt = now;
  account.lastProviderLoginAt = now;

  if (emailCanonical && (!account.primaryEmailCanonical || account.primaryEmailCanonical === emailCanonical)) {
    const emailAlreadySignsIn = hasVerifiedEmailLogin(account, emailCanonical);
    account.primaryEmailOriginal = email;
    account.primaryEmailCanonical = emailCanonical;
    account.primaryEmailVerified = true;
    account.emailProvider = emailAlreadySignsIn ? account.emailProvider || "email" : normalizedProvider;
    account.emailLastSeenAt = now;
    if (!state.accountEmails[emailCanonical] || state.accountEmails[emailCanonical] === accountId) {
      state.accountEmails[emailCanonical] = accountId;
    }
  }

  state.accounts[accountId] = account;
  state.accountIdentities[key] = accountId;
  syncAccountSessions(account);
  saveState();

  return accountPayload(account);
}

export function linkProviderToAccount({
  accountId,
  provider,
  providerUserId,
  username = "",
  displayName = "",
  profileUrl = "",
  emailInfo = null,
  metadata = {},
}) {
  const targetAccountId = String(accountId || "").trim();
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedProviderUserId = String(providerUserId || "").trim();
  if (!targetAccountId || !normalizedProvider || !normalizedProviderUserId) {
    return { ok: false, error: "provider_link_invalid" };
  }

  const account = state.accounts[targetAccountId];
  if (!account) {
    return { ok: false, error: "account_not_found" };
  }

  const key = identityKey(normalizedProvider, normalizedProviderUserId);
  const existingIdentityAccountId = state.accountIdentities[key];
  if (existingIdentityAccountId && existingIdentityAccountId !== targetAccountId) {
    return { ok: false, error: "provider_identity_conflict" };
  }

  const now = new Date().toISOString();
  const email = emailInfo?.email || "";
  const emailVerified = emailInfo?.verified === true;
  const emailCanonical = emailVerified ? String(email).trim().toLowerCase() : "";
  if (emailCanonical) {
    const existingEmailAccountId = state.accountEmails[emailCanonical];
    if (existingEmailAccountId && existingEmailAccountId !== targetAccountId) {
      return { ok: false, error: "provider_email_conflict" };
    }
  }

  mergeLinkedProvider(
    account,
    linkedProvider({
      provider: normalizedProvider,
      providerUserId: normalizedProviderUserId,
      username,
      displayName,
      profileUrl,
      email,
      emailVerified,
      metadata,
    })
  );
  account.status = account.status || "active";
  account.displayName = account.displayName || displayName || username || providerLabel(normalizedProvider);
  account.primaryProvider = account.primaryProvider || normalizedProvider;
  account.assurance = account.assurance === "high" ? "high" : "medium";
  account.updatedAt = now;
  account.lastProviderLinkAt = now;

  if (emailCanonical && (!account.primaryEmailCanonical || account.primaryEmailCanonical === emailCanonical)) {
    const emailAlreadySignsIn = hasVerifiedEmailLogin(account, emailCanonical);
    account.primaryEmailOriginal = email;
    account.primaryEmailCanonical = emailCanonical;
    account.primaryEmailVerified = true;
    account.emailProvider = emailAlreadySignsIn ? account.emailProvider || "email" : normalizedProvider;
    account.emailLastSeenAt = now;
    state.accountEmails[emailCanonical] = targetAccountId;
  }

  state.accounts[targetAccountId] = account;
  state.accountIdentities[key] = targetAccountId;
  syncAccountSessions(account);
  saveState();

  return { ok: true, account: accountPayload(account) };
}

export function createAccountSession(account, { provider = "email", assurance = "low", deviceAccountSetId = "" } = {}) {
  pruneExpiredSessions();

  const now = new Date();
  const sessionId = randomUUID();
  const identityProfile = accountIdentityProfile(account);
  const session = {
    id: sessionId,
    accountId: account.id,
    displayName: identityProfile?.displayName || account.displayName,
    hiveHandle: identityProfile?.hiveHandle || "",
    publicDisplayName: identityProfile?.publicDisplayName || "",
    profileVisibility: identityProfile?.profileVisibility || "public",
    primaryProvider: provider,
    linkedProviders: account.linkedProviders || [],
    assurance,
    deviceAccountSetId: deviceAccountSetId || null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + sessionTtlSeconds * 1000).toISOString(),
  };

  state.sessions[sessionId] = session;
  saveState();

  return {
    sessionId,
    session: sessionPayload(session),
  };
}

export function getSession(sessionId) {
  if (!sessionId) return null;

  pruneExpiredSessions();
  return sessionPayload(state.sessions[sessionId] || null);
}

const terminalAuthStore = createRuntimeTerminalAuthStore({
  state,
  saveState,
  accountHasLinkedProvider,
  getLinkedProviderForAccount,
  accountPayload,
});
export const completeTerminalAuthRequest = terminalAuthStore.completeTerminalAuthRequest;
export const consumeTerminalAuthRequestSession = terminalAuthStore.consumeTerminalAuthRequestSession;
export const createTerminalAuthRequest = terminalAuthStore.createTerminalAuthRequest;
export const getTerminalAuthRequest = terminalAuthStore.getTerminalAuthRequest;
export const getTerminalSessionByToken = terminalAuthStore.getTerminalSessionByToken;
export const pruneExpiredTerminalAuthRequests = terminalAuthStore.pruneExpiredTerminalAuthRequests;
export const pruneExpiredTerminalSessions = terminalAuthStore.pruneExpiredTerminalSessions;
export const revokeTerminalSessionByToken = terminalAuthStore.revokeTerminalSessionByToken;

export function createDevSession({ email = "dev@tasknode.local" } = {}) {
  pruneExpiredSessions();

  const normalizedEmail =
    typeof email === "string" && email.trim()
      ? email.trim().toLowerCase().slice(0, 160)
      : "dev@tasknode.local";
  const now = new Date();
  const accountId = `acct_dev_${normalizedEmail.replace(/[^a-z0-9]+/g, "_").slice(0, 48)}`;
  const account = state.accounts[accountId] || {
    id: accountId,
    status: "active",
    displayName: displayNameFromEmail(normalizedEmail),
    primaryProvider: "dev",
    assurance: "low",
    profileVisibility: "public",
    linkedProviders: [],
    createdAt: now.toISOString(),
  };
  normalizeAccountProfileVisibility(account);
  mergeLinkedProvider(account, devProvider());
  account.updatedAt = now.toISOString();
  state.accounts[accountId] = account;

  const sessionId = randomUUID();
  const identityProfile = accountIdentityProfile(account);
  const session = {
    id: sessionId,
    accountId,
    displayName: identityProfile?.displayName || account.displayName,
    hiveHandle: identityProfile?.hiveHandle || "",
    publicDisplayName: identityProfile?.publicDisplayName || "",
    profileVisibility: identityProfile?.profileVisibility || "public",
    primaryProvider: "dev",
    linkedProviders: account.linkedProviders || [devProvider()],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + sessionTtlSeconds * 1000).toISOString(),
  };

  state.sessions[sessionId] = session;
  saveState();

  return {
    sessionId,
    session: sessionPayload(session),
  };
}

export function getEthereumDepositAccount({ accountId = "" } = {}) {
  return getRuntimeEthereumDepositAccount(state, { accountId });
}

export function retireEthereumDepositAccount(options = {}) {
  return retireRuntimeEthereumDepositAccount(state, saveState, options);
}

export function getOrCreateEthereumDepositAccount(options = {}) {
  return getOrCreateRuntimeEthereumDepositAccount(state, saveState, options);
}

export function updateEthereumDepositSync(options = {}) {
  return updateRuntimeEthereumDepositSync(state, saveState, options);
}
