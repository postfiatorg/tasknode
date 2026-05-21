import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { normalizeContextHistoryProjection } from "./context-history.js";

const defaultStorePath = path.join("/tmp", "tasknodeofficial-runtime-store.json");
export const sessionCookieName = "tasknode_session";
export const sessionTtlSeconds = 60 * 60 * 24 * 7;
const storePath = process.env.TASKNODE_STORE_PATH || defaultStorePath;
const defaultState = {
  version: 1,
  conversations: {
    dev: [],
  },
  conversationMeta: {},
  ledgerEntries: [],
  sessions: {},
  accounts: {},
  accountEmails: {},
  accountIdentities: {},
  accountWallets: {},
  walletInitiationGrants: [],
  ethereumDepositAccounts: {},
  ethereumDepositRetiredAccounts: [],
  ethereumDepositAddressIndex: {},
  ethereumDepositCursor: 0,
  walletChallenges: {},
  contextDocuments: {},
  contextHistorySnapshots: {},
  oauthStates: {},
  emailChallenges: {},
  authEvents: [],
};

let state = loadState();

export function runtimeStoreStatus() {
  return {
    path: storePath,
    defaultPath: defaultStorePath,
    explicit: Boolean(process.env.TASKNODE_STORE_PATH),
    ephemeralDefault: storePath === defaultStorePath || storePath.startsWith("/tmp/"),
  };
}

function loadState() {
  if (!existsSync(storePath)) return structuredClone(defaultState);

  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    return {
      ...structuredClone(defaultState),
      ...parsed,
      conversations: parsed.conversations || structuredClone(defaultState.conversations),
      conversationMeta:
        parsed.conversationMeta && typeof parsed.conversationMeta === "object" && !Array.isArray(parsed.conversationMeta)
          ? parsed.conversationMeta
          : {},
      ledgerEntries: Array.isArray(parsed.ledgerEntries) ? parsed.ledgerEntries : [],
      sessions:
        parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {},
      accounts:
        parsed.accounts && typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)
          ? parsed.accounts
          : {},
      accountEmails:
        parsed.accountEmails && typeof parsed.accountEmails === "object" && !Array.isArray(parsed.accountEmails)
          ? parsed.accountEmails
          : {},
      accountIdentities:
        parsed.accountIdentities && typeof parsed.accountIdentities === "object" && !Array.isArray(parsed.accountIdentities)
          ? parsed.accountIdentities
          : {},
      accountWallets:
        parsed.accountWallets && typeof parsed.accountWallets === "object" && !Array.isArray(parsed.accountWallets)
          ? parsed.accountWallets
          : {},
      walletInitiationGrants: Array.isArray(parsed.walletInitiationGrants)
        ? parsed.walletInitiationGrants
        : [],
      ethereumDepositAccounts:
        parsed.ethereumDepositAccounts && typeof parsed.ethereumDepositAccounts === "object" && !Array.isArray(parsed.ethereumDepositAccounts)
          ? parsed.ethereumDepositAccounts
          : {},
      ethereumDepositRetiredAccounts: Array.isArray(parsed.ethereumDepositRetiredAccounts)
        ? parsed.ethereumDepositRetiredAccounts
        : [],
      ethereumDepositAddressIndex:
        parsed.ethereumDepositAddressIndex && typeof parsed.ethereumDepositAddressIndex === "object" && !Array.isArray(parsed.ethereumDepositAddressIndex)
          ? parsed.ethereumDepositAddressIndex
          : {},
      ethereumDepositCursor: Number.isSafeInteger(parsed.ethereumDepositCursor)
        ? parsed.ethereumDepositCursor
        : 0,
      walletChallenges:
        parsed.walletChallenges && typeof parsed.walletChallenges === "object" && !Array.isArray(parsed.walletChallenges)
          ? parsed.walletChallenges
          : {},
      contextDocuments:
        parsed.contextDocuments && typeof parsed.contextDocuments === "object" && !Array.isArray(parsed.contextDocuments)
          ? parsed.contextDocuments
          : {},
      contextHistorySnapshots:
        parsed.contextHistorySnapshots && typeof parsed.contextHistorySnapshots === "object" && !Array.isArray(parsed.contextHistorySnapshots)
          ? parsed.contextHistorySnapshots
          : {},
      oauthStates:
        parsed.oauthStates && typeof parsed.oauthStates === "object" && !Array.isArray(parsed.oauthStates)
          ? parsed.oauthStates
          : {},
      emailChallenges:
        parsed.emailChallenges && typeof parsed.emailChallenges === "object" && !Array.isArray(parsed.emailChallenges)
          ? parsed.emailChallenges
          : {},
      authEvents: Array.isArray(parsed.authEvents) ? parsed.authEvents : [],
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function conversationMessages(conversationId) {
  if (!state.conversations[conversationId]) state.conversations[conversationId] = [];
  return state.conversations[conversationId];
}

function chatTitleFromPrompt(prompt) {
  const title = String(prompt || "").trim().replace(/\s+/g, " ").slice(0, 64);
  return title || "New chat";
}

function chatTitleFromUserInput(title) {
  return String(title || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function messagePreview(message) {
  return String(message?.body || message?.text || message?.content || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

function inferAccountIdFromConversationId(conversationId) {
  const text = String(conversationId || "");
  if (!text.startsWith("account_")) return "";

  const scopedId = text.slice("account_".length);
  return Object.keys(state.accounts || {})
    .sort((left, right) => right.length - left.length)
    .find((accountId) => scopedId.startsWith(`${safeId(accountId, "account")}_`)) || "";
}

function ensureConversationMeta(conversationId, accountId = "") {
  const messages = conversationMessages(conversationId);
  const existing = state.conversationMeta[conversationId] || {};
  const firstUser = messages.find((message) => message?.role === "user");
  const lastMessage = messages[messages.length - 1] || null;
  const createdAt = existing.createdAt || firstUser?.createdAt || lastMessage?.createdAt || new Date().toISOString();
  const updatedAt = existing.updatedAt || lastMessage?.createdAt || createdAt;
  const inferredAccountId = accountId || existing.accountId || inferAccountIdFromConversationId(conversationId);

  state.conversationMeta[conversationId] = {
    id: conversationId,
    conversationId,
    accountId: inferredAccountId,
    title: existing.title || chatTitleFromPrompt(firstUser?.body || ""),
    createdAt,
    updatedAt,
    lastMessageAt: existing.lastMessageAt || lastMessage?.createdAt || updatedAt,
    lastMessagePreview: existing.lastMessagePreview || messagePreview(lastMessage),
    messageCount: messages.length,
  };

  return state.conversationMeta[conversationId];
}

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

export function conversationIdForSession(session = null, requestedId = "") {
  const hasRequestedId = typeof requestedId === "string" && requestedId.trim().length > 0;
  const requested = safeId(requestedId, "default");
  if (!session?.accountId) {
    return hasRequestedId ? requested : "dev";
  }

  const accountId = safeId(session.accountId, "account");
  const accountPrefix = `account_${accountId}_`;
  if (hasRequestedId && requested.startsWith(accountPrefix)) {
    return requested.slice(0, 160);
  }

  return `account_${accountId}_${requested}`.slice(0, 160);
}

export function getChatMessages(conversationId = "dev") {
  return conversationMessages(conversationId).slice(-30);
}

export function listChatConversations({ accountId = "", limit = 30 } = {}) {
  const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
  const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const rows = Object.keys(state.conversations)
    .map((conversationId) => ensureConversationMeta(
      conversationId,
      normalizedAccountId && conversationId.startsWith(`account_${normalizedAccountId}_`)
        ? normalizedAccountId
        : ""
    ))
    .filter((meta) => {
      if (!meta.messageCount) return false;
      if (normalizedAccountId) return meta.accountId === normalizedAccountId;
      return !meta.accountId && !String(meta.conversationId || "").startsWith("account_");
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.lastMessageAt || "") || 0;
      const rightTime = Date.parse(right.updatedAt || right.lastMessageAt || "") || 0;
      return rightTime - leftTime;
    })
    .slice(0, normalizedLimit);

  return rows.map((meta) => ({
    id: meta.id,
    conversationId: meta.conversationId,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastMessageAt: meta.lastMessageAt,
    lastMessagePreview: meta.lastMessagePreview,
    messageCount: meta.messageCount,
  }));
}

function chatConversationMutationTarget({ accountId = "", conversationId = "" } = {}) {
  const id = String(conversationId || "").trim();
  if (!id || !state.conversations[id]) {
    return { ok: false, status: 404, error: "chat_conversation_not_found" };
  }

  const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
  const accountPrefix = normalizedAccountId ? `account_${normalizedAccountId}_` : "";
  const meta = ensureConversationMeta(
    id,
    normalizedAccountId && id.startsWith(accountPrefix) ? normalizedAccountId : ""
  );
  const ownerAccountId = meta.accountId || inferAccountIdFromConversationId(id) || "";

  if (normalizedAccountId) {
    if (ownerAccountId !== normalizedAccountId) {
      return { ok: false, status: 404, error: "chat_conversation_not_found" };
    }
  } else if (ownerAccountId || id.startsWith("account_")) {
    return { ok: false, status: 404, error: "chat_conversation_not_found" };
  }

  return { ok: true, id, meta };
}

export function renameChatConversation({ accountId = "", conversationId = "", title = "" } = {}) {
  const target = chatConversationMutationTarget({ accountId, conversationId });
  if (!target.ok) return target;

  const normalizedTitle = chatTitleFromUserInput(title);
  if (!normalizedTitle) {
    return { ok: false, status: 400, error: "chat_title_required" };
  }

  const now = new Date().toISOString();
  state.conversationMeta[target.id] = {
    ...target.meta,
    title: normalizedTitle,
    updatedAt: now,
  };
  saveState();

  return {
    ok: true,
    conversation: {
      id: target.id,
      conversationId: target.id,
      title: normalizedTitle,
      updatedAt: now,
    },
  };
}

export function deleteChatConversation({ accountId = "", conversationId = "" } = {}) {
  const target = chatConversationMutationTarget({ accountId, conversationId });
  if (!target.ok) return target;

  delete state.conversations[target.id];
  delete state.conversationMeta[target.id];
  saveState();

  return {
    ok: true,
    conversationId: target.id,
    deleted: true,
  };
}

function sessionPayload(session) {
  if (!session) return null;

  return {
    id: session.id,
    accountId: session.accountId,
    status: "signed_in",
    displayName: session.displayName,
    primaryProvider: session.primaryProvider,
    linkedProviders: session.linkedProviders || [],
    assurance: session.assurance || "low",
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function pruneExpiredSessions() {
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

function pruneExpiredEmailChallenges() {
  const now = Date.now();
  let changed = false;

  for (const [challengeId, challenge] of Object.entries(state.emailChallenges)) {
    const expiredLongAgo =
      challenge?.expiresAt && Date.parse(challenge.expiresAt) <= now - (60 * 60 * 1000);
    if (!challenge || challenge.consumedAt || challenge.replacedAt || expiredLongAgo) {
      delete state.emailChallenges[challengeId];
      changed = true;
    }
  }

  if (changed) saveState();
}

function pruneExpiredOAuthStates() {
  const now = Date.now();
  let changed = false;

  for (const [stateId, stateRow] of Object.entries(state.oauthStates)) {
    if (!stateRow?.expiresAt || Date.parse(stateRow.expiresAt) <= now) {
      delete state.oauthStates[stateId];
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

function accountPayload(account) {
  if (!account) return null;

  return {
    id: account.id,
    status: account.status || "active",
    displayName: account.displayName,
    primaryProvider: account.primaryProvider || "email",
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
  return "Provider";
}

function linkedProvider({
  provider,
  providerUserId,
  username,
  profileUrl,
  email,
  emailVerified = false,
}) {
  return {
    id: provider,
    label: providerLabel(provider),
    kind: "oauth",
    status: "linked",
    providerUserId,
    username: username || null,
    profileUrl: profileUrl || null,
    email: email || null,
    emailVerified: Boolean(emailVerified),
  };
}

function devProvider() {
  return {
    id: "dev",
    label: "Dev session",
    kind: "development",
    status: "linked",
  };
}

function mergeLinkedProvider(account, providerPayload) {
  const existing = Array.isArray(account.linkedProviders) ? account.linkedProviders : [];
  account.linkedProviders = existing
    .filter((item) => item?.id !== providerPayload.id)
    .concat(providerPayload);
}

function walletInitiationAmountPft() {
  const amount = Number(process.env.TASKNODE_WALLET_INITIATION_PFT || 12);
  if (!Number.isFinite(amount) || amount <= 0) return 12;
  return Math.min(amount, 100);
}

function walletInitiationAmountDrops() {
  return String(Math.round(walletInitiationAmountPft() * 1_000_000));
}

function walletInitiationIdentityHash(provider, providerUserId) {
  return stableId(`${String(provider || "").toLowerCase()}:${String(providerUserId || "")}`, "identity");
}

function walletInitiationIdentities(account) {
  const linked = Array.isArray(account?.linkedProviders) ? account.linkedProviders : [];
  return linked
    .filter((provider) => {
      const id = String(provider?.id || "").trim().toLowerCase();
      if (!id || id === "email" || id === "dev" || id === "wallet") return false;
      return provider?.kind === "oauth" && provider?.providerUserId;
    })
    .map((provider) => ({
      provider: String(provider.id || "").trim().toLowerCase(),
      providerUserId: String(provider.providerUserId || "").trim(),
      providerUserIdHash: walletInitiationIdentityHash(provider.id, provider.providerUserId),
      username: provider.username || null,
    }));
}

function activeWalletInitiationGrants() {
  return (state.walletInitiationGrants || []).filter((grant) => (
    grant && ["processing", "completed", "unknown"].includes(grant.status)
  ));
}

function latestWalletInitiationGrantForAccount(accountId) {
  const normalizedAccountId = safeId(accountId, "account");
  return (state.walletInitiationGrants || [])
    .filter((grant) => grant?.accountId === normalizedAccountId)
    .sort((left, right) => (Date.parse(right.updatedAt || right.createdAt || "") || 0) - (Date.parse(left.updatedAt || left.createdAt || "") || 0))[0] || null;
}

function publicWalletInitiationGrant(grant) {
  if (!grant) return null;
  return {
    id: grant.id,
    status: grant.status,
    accountId: grant.accountId,
    walletAddress: grant.walletAddress,
    amountPft: grant.amountPft,
    amountDrops: grant.amountDrops,
    txHash: grant.txHash || null,
    provider: grant.provider || null,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    error: grant.error || null,
  };
}

export function walletInitiationGrantStatus({ accountId = "", walletAddress = "" } = {}) {
  const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
  const normalizedWalletAddress = String(walletAddress || "").trim();
  const amountPft = walletInitiationAmountPft();
  const amountDrops = walletInitiationAmountDrops();

  if (!normalizedAccountId) {
    return {
      eligible: false,
      reason: "login_required",
      amountPft,
      amountDrops,
      message: "Sign in with GitHub, X, Telegram, or Discord before claiming the wallet initiation gift.",
    };
  }

  const account = state.accounts[normalizedAccountId];
  if (!account) {
    return {
      eligible: false,
      reason: "account_not_found",
      amountPft,
      amountDrops,
      message: "The signed-in account was not found.",
    };
  }

  const latestAccountGrant = latestWalletInitiationGrantForAccount(normalizedAccountId);
  if (latestAccountGrant && ["processing", "completed", "unknown"].includes(latestAccountGrant.status)) {
    return {
      eligible: false,
      reason: "account_registered",
      amountPft,
      amountDrops,
      grant: publicWalletInitiationGrant(latestAccountGrant),
      message: latestAccountGrant.status === "completed"
        ? "This account already received its wallet initiation gift."
        : "This account already has a wallet initiation gift in progress.",
    };
  }

  const identities = walletInitiationIdentities(account);
  if (identities.length === 0) {
    return {
      eligible: false,
      reason: account.primaryProvider === "email" ? "email_ineligible" : "provider_required",
      amountPft,
      amountDrops,
      message: "Email-only accounts do not receive the PFT wallet initiation gift.",
    };
  }

  const activeGrants = activeWalletInitiationGrants();
  if (normalizedWalletAddress) {
    const walletGrant = activeGrants.find((grant) => grant.walletAddress === normalizedWalletAddress);
    if (walletGrant) {
      return {
        eligible: false,
        reason: "wallet_registered",
        amountPft,
        amountDrops,
        grant: publicWalletInitiationGrant(walletGrant),
        message: "This wallet address is already registered for a wallet initiation gift.",
      };
    }
  }

  const identityHashSet = new Set(identities.map((identity) => identity.providerUserIdHash));
  const providerGrant = activeGrants.find((grant) => (
    Array.isArray(grant.providerUserIdHashes) &&
    grant.providerUserIdHashes.some((hash) => identityHashSet.has(hash))
  ));
  if (providerGrant) {
    return {
      eligible: false,
      reason: "provider_identity_registered",
      amountPft,
      amountDrops,
      grant: publicWalletInitiationGrant(providerGrant),
      message: "This sign-in identity already received a wallet initiation gift.",
    };
  }

  return {
    eligible: true,
    reason: null,
    amountPft,
    amountDrops,
    provider: identities[0].provider,
    identities,
    message: `${amountPft.toLocaleString("en-US")} PFT initiation gift available after creating a new wallet.`,
  };
}

export function reserveWalletInitiationGrant({
  accountId = "",
  walletAddress = "",
  amountDrops = walletInitiationAmountDrops(),
  amountPft = walletInitiationAmountPft(),
} = {}) {
  const normalizedAccountId = safeId(accountId, "account");
  const normalizedWalletAddress = String(walletAddress || "").trim();
  const eligibility = walletInitiationGrantStatus({
    accountId: normalizedAccountId,
    walletAddress: normalizedWalletAddress,
  });
  if (!eligibility.eligible) {
    return { ok: false, status: 409, error: eligibility.reason || "wallet_initiation_not_eligible", eligibility };
  }

  const now = new Date().toISOString();
  const identities = Array.isArray(eligibility.identities) ? eligibility.identities : [];
  const grant = {
    id: `wallet_init_${randomUUID()}`,
    status: "processing",
    accountId: normalizedAccountId,
    walletAddress: normalizedWalletAddress,
    amountDrops: String(amountDrops),
    amountPft: Number(Number(amountPft).toFixed(6)),
    provider: identities[0]?.provider || "",
    providerUserIdHashes: identities.map((identity) => identity.providerUserIdHash),
    providers: identities.map((identity) => ({
      provider: identity.provider,
      providerUserIdHash: identity.providerUserIdHash,
      username: identity.username || null,
    })),
    createdAt: now,
    updatedAt: now,
  };

  state.walletInitiationGrants.push(grant);
  saveState();

  return { ok: true, grant: publicWalletInitiationGrant(grant), internalGrant: structuredClone(grant) };
}

export function completeWalletInitiationGrant({ grantId = "", txHash = "", faucetAddress = "" } = {}) {
  const grant = (state.walletInitiationGrants || []).find((item) => item?.id === grantId);
  if (!grant) return { ok: false, status: 404, error: "wallet_initiation_grant_not_found" };

  const now = new Date().toISOString();
  grant.status = "completed";
  grant.txHash = txHash || grant.txHash || null;
  grant.faucetAddress = faucetAddress || grant.faucetAddress || null;
  grant.error = "";
  grant.updatedAt = now;
  saveState();

  return { ok: true, grant: publicWalletInitiationGrant(grant) };
}

export function failWalletInitiationGrant({ grantId = "", error = "", unknown = false } = {}) {
  const grant = (state.walletInitiationGrants || []).find((item) => item?.id === grantId);
  if (!grant) return { ok: false, status: 404, error: "wallet_initiation_grant_not_found" };

  const now = new Date().toISOString();
  grant.status = unknown ? "unknown" : "failed";
  grant.error = String(error || "wallet_initiation_failed").slice(0, 240);
  grant.updatedAt = now;
  saveState();

  return { ok: true, grant: publicWalletInitiationGrant(grant) };
}

export function getAccount(accountId) {
  return accountPayload(state.accounts[accountId] || null);
}

export function findAccountByEmail(canonicalEmail) {
  const accountId = state.accountEmails[String(canonicalEmail || "")];
  return accountPayload(accountId ? state.accounts[accountId] : null);
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
    profileUrl,
    email,
    emailVerified,
  });

  let accountId = state.accountIdentities[key];
  if (!accountId && emailCanonical) {
    accountId = state.accountEmails[emailCanonical] || "";
  }

  if (!accountId) {
    accountId = stableId(key, "acct_oauth");
  }

  let account = state.accounts[accountId];
  if (!account) {
    account = {
      id: accountId,
      status: "active",
      displayName: displayName || username || providerLabel(normalizedProvider),
      primaryProvider: normalizedProvider,
      assurance: "medium",
      linkedProviders: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  mergeLinkedProvider(account, providerPayload);
  account.status = account.status || "active";
  account.displayName = account.displayName || displayName || username || providerLabel(normalizedProvider);
  account.primaryProvider = account.primaryProvider || normalizedProvider;
  account.assurance = account.assurance === "high" ? "high" : "medium";
  account.updatedAt = now;
  account.lastProviderLoginAt = now;

  if (emailCanonical && (!account.primaryEmailCanonical || account.primaryEmailCanonical === emailCanonical)) {
    account.primaryEmailOriginal = email;
    account.primaryEmailCanonical = emailCanonical;
    account.primaryEmailVerified = true;
    account.emailProvider = normalizedProvider;
    account.emailLastSeenAt = now;
    if (!state.accountEmails[emailCanonical] || state.accountEmails[emailCanonical] === accountId) {
      state.accountEmails[emailCanonical] = accountId;
    }
  }

  state.accounts[accountId] = account;
  state.accountIdentities[key] = accountId;
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
      profileUrl,
      email,
      emailVerified,
    })
  );
  account.status = account.status || "active";
  account.displayName = account.displayName || displayName || username || providerLabel(normalizedProvider);
  account.primaryProvider = account.primaryProvider || normalizedProvider;
  account.assurance = account.assurance === "high" ? "high" : "medium";
  account.updatedAt = now;
  account.lastProviderLinkAt = now;

  if (emailCanonical && (!account.primaryEmailCanonical || account.primaryEmailCanonical === emailCanonical)) {
    account.primaryEmailOriginal = email;
    account.primaryEmailCanonical = emailCanonical;
    account.primaryEmailVerified = true;
    account.emailProvider = normalizedProvider;
    account.emailLastSeenAt = now;
    state.accountEmails[emailCanonical] = targetAccountId;
  }

  state.accounts[targetAccountId] = account;
  state.accountIdentities[key] = targetAccountId;
  saveState();

  return { ok: true, account: accountPayload(account) };
}

export function createAccountSession(account, { provider = "email", assurance = "low" } = {}) {
  pruneExpiredSessions();

  const now = new Date();
  const sessionId = randomUUID();
  const session = {
    id: sessionId,
    accountId: account.id,
    displayName: account.displayName,
    primaryProvider: provider,
    linkedProviders: account.linkedProviders || [],
    assurance,
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
    linkedProviders: [],
    createdAt: now.toISOString(),
  };
  mergeLinkedProvider(account, devProvider());
  account.updatedAt = now.toISOString();
  state.accounts[accountId] = account;

  const sessionId = randomUUID();
  const session = {
    id: sessionId,
    accountId,
    displayName: account.displayName,
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

export function createOAuthState({
  provider,
  redirectPath = "/",
  redirectUri = "",
  linkAccountId = "",
  expiresInSeconds = 600,
} = {}) {
  pruneExpiredOAuthStates();

  const stateId = randomUUID();
  const now = new Date();
  const stateRow = {
    id: stateId,
    provider: String(provider || "").trim().toLowerCase(),
    redirectPath: String(redirectPath || "/").startsWith("/") ? String(redirectPath || "/") : "/",
    redirectUri,
    linkAccountId: String(linkAccountId || "").trim(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
  };

  state.oauthStates[stateId] = stateRow;
  saveState();

  return stateRow;
}

export function consumeOAuthState({ provider, stateId }) {
  pruneExpiredOAuthStates();

  const row = state.oauthStates[String(stateId || "")];
  if (!row || row.provider !== String(provider || "").trim().toLowerCase()) {
    return null;
  }

  delete state.oauthStates[row.id];
  saveState();
  return row;
}

function hashEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createEmailChallenge({
  id = randomUUID(),
  email,
  canonicalEmail,
  maskedEmail,
  codeHash,
  expiresAt,
  deliveryMode,
  requestIp = "",
  userAgent = "",
}) {
  pruneExpiredEmailChallenges();

  const canonical = String(canonicalEmail || "").trim();
  const now = new Date().toISOString();

  for (const challenge of Object.values(state.emailChallenges)) {
    if (
      challenge?.canonicalEmail === canonical &&
      !challenge.consumedAt &&
      !challenge.replacedAt
    ) {
      challenge.replacedAt = now;
    }
  }

  const challenge = {
    id,
    email,
    canonicalEmail: canonical,
    maskedEmail,
    codeHash,
    attempts: 0,
    maxAttempts: 6,
    deliveryMode,
    requestIp: String(requestIp || "").slice(0, 80),
    userAgent: String(userAgent || "").slice(0, 240),
    createdAt: now,
    expiresAt,
    consumedAt: null,
    replacedAt: null,
  };

  state.emailChallenges[id] = challenge;
  saveState();

  return {
    id,
    maskedEmail,
    expiresAt,
    deliveryMode,
  };
}

export function getEmailChallenge(challengeId) {
  pruneExpiredEmailChallenges();

  const challenge = state.emailChallenges[String(challengeId || "")];
  if (!challenge) return null;

  return {
    id: challenge.id,
    canonicalEmail: challenge.canonicalEmail,
    email: challenge.email,
    maskedEmail: challenge.maskedEmail,
    expiresAt: challenge.expiresAt,
    attempts: challenge.attempts || 0,
    maxAttempts: challenge.maxAttempts || 6,
    consumedAt: challenge.consumedAt || null,
    replacedAt: challenge.replacedAt || null,
  };
}

export function consumeEmailChallenge({ challengeId, codeHash }) {
  pruneExpiredEmailChallenges();

  const challenge = state.emailChallenges[String(challengeId || "")];
  if (!challenge) {
    return { ok: false, error: "email_challenge_invalid" };
  }

  const now = new Date();
  if (challenge.consumedAt || challenge.replacedAt || Date.parse(challenge.expiresAt) <= now.getTime()) {
    return { ok: false, error: "email_challenge_invalid" };
  }

  if ((challenge.attempts || 0) >= (challenge.maxAttempts || 6)) {
    return { ok: false, error: "email_challenge_attempts_exceeded" };
  }

  if (!hashEquals(challenge.codeHash, codeHash)) {
    challenge.attempts = (challenge.attempts || 0) + 1;
    saveState();
    return { ok: false, error: "email_challenge_invalid" };
  }

  challenge.consumedAt = now.toISOString();
  saveState();

  return {
    ok: true,
    challenge: {
      id: challenge.id,
      email: challenge.email,
      canonicalEmail: challenge.canonicalEmail,
      maskedEmail: challenge.maskedEmail,
      consumedAt: challenge.consumedAt,
    },
  };
}

export function recordAuthEvent({
  accountId = "",
  eventType,
  provider = "",
  email = "",
  decision = "",
  metadata = {},
}) {
  const event = {
    id: randomUUID(),
    accountId: accountId || null,
    eventType,
    provider,
    email: email || null,
    decision,
    metadata,
    createdAt: new Date().toISOString(),
  };

  state.authEvents.push(event);
  if (state.authEvents.length > 1000) {
    state.authEvents = state.authEvents.slice(-1000);
  }
  saveState();
  return event;
}

export function destroySession(sessionId) {
  if (!sessionId || !state.sessions[sessionId]) return false;

  delete state.sessions[sessionId];
  saveState();
  return true;
}

export function appendChatTurn({
  accountId = "",
  conversationId = "dev",
  mode,
  provider,
  model,
  responseId,
  userMessage,
  assistantMessage,
  userMessageId = "",
  assistantMessageId = "",
  userMetadata = {},
  assistantMetadata = {},
  usage,
}) {
  const now = new Date().toISOString();
  const messages = conversationMessages(conversationId);
  const userId = typeof userMessageId === "string" && userMessageId.trim()
    ? userMessageId.trim().slice(0, 180)
    : `msg_${randomUUID()}_user`;
  const assistantId = typeof assistantMessageId === "string" && assistantMessageId.trim()
    ? assistantMessageId.trim().slice(0, 180)
    : `msg_${randomUUID()}_assistant`;
  const ledgerId = `ledger_${randomUUID()}`;
  const userMeta = userMetadata && typeof userMetadata === "object" && !Array.isArray(userMetadata);
  const assistantMeta = assistantMetadata && typeof assistantMetadata === "object" && !Array.isArray(assistantMetadata);

  messages.push(Object.assign(
    { id: userId, role: "user", body: userMessage, createdAt: now, mode },
    userMeta ? { metadata: userMetadata } : {}
  ));
  messages.push(Object.assign(
    { id: assistantId, role: "assistant", body: assistantMessage, createdAt: now, mode, provider, model, responseId },
    assistantMeta ? { metadata: assistantMetadata } : {}
  ));

  const existingMeta = ensureConversationMeta(conversationId, accountId);
  state.conversationMeta[conversationId] = {
    ...existingMeta,
    accountId,
    title:
      existingMeta.title && existingMeta.title !== "New chat"
        ? existingMeta.title
        : chatTitleFromPrompt(userMessage),
    updatedAt: now,
    lastMessageAt: now,
    lastMessagePreview: messagePreview(assistantMessage) || messagePreview(userMessage),
    messageCount: messages.length,
  };

  const costUsd = Number(usage?.costUsd || 0);
  if (costUsd > 0) {
    state.ledgerEntries.push({
      id: ledgerId,
      kind: "chat_debit",
      accountId,
      conversationId,
      provider,
      model,
      mode,
      responseId,
      amountUsd: Number(costUsd.toFixed(6)),
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      webSearchCalls: usage?.webSearchCalls || 0,
      toolCostUsd: usage?.toolCostUsd || 0,
      createdAt: now,
    });
  }

  saveState();

  return {
    user: messages[messages.length - 2],
    assistant: messages[messages.length - 1],
    ledgerEntry: costUsd > 0 ? state.ledgerEntries[state.ledgerEntries.length - 1] : null,
  };
}

export function appendUsageCredit({
  accountId = "dev",
  amountUsd,
  source = "admin_credit",
  note = "",
  createdBy = "system",
  uniqueKey = "",
  metadata = {},
}) {
  const now = new Date().toISOString();
  const normalizedUniqueKey = typeof uniqueKey === "string" ? uniqueKey.trim().slice(0, 180) : "";
  if (normalizedUniqueKey) {
    const existing = state.ledgerEntries.find((entry) => (
      entry.kind === "account_credit" && entry.uniqueKey === normalizedUniqueKey
    ));
    if (existing) return { ...existing, idempotentReplay: true };
  }

  const ledgerId = `ledger_${randomUUID()}_credit`;
  const entry = {
    id: ledgerId,
    kind: "account_credit",
    accountId,
    source,
    amountUsd: Number(Number(amountUsd).toFixed(6)),
    note,
    createdBy,
    createdAt: now,
  };
  if (normalizedUniqueKey) entry.uniqueKey = normalizedUniqueKey;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    entry.metadata = metadata;
  }

  state.ledgerEntries.push(entry);
  saveState();

  return entry;
}

export function getEthereumDepositAccount({ accountId = "" } = {}) {
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim().slice(0, 160) : "";
  if (!normalizedAccountId) return null;
  const account = state.ethereumDepositAccounts[normalizedAccountId] || null;
  return account ? structuredClone(account) : null;
}

export function getOrCreateEthereumDepositAccount({
  accountId = "",
  deriveAddress,
  assets = [],
  chainId = 1,
  network = "Ethereum mainnet",
  custody = "tasknode_deposit_only",
  startIndex = 1,
} = {}) {
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim().slice(0, 160) : "";
  if (!normalizedAccountId) {
    return { ok: false, status: 401, error: "deposit_login_required" };
  }
  if (typeof deriveAddress !== "function") {
    return { ok: false, status: 409, error: "deposit_deriver_unavailable" };
  }

  const normalizedStartIndex = Math.max(0, Number(startIndex) || 0);
  const existing = state.ethereumDepositAccounts[normalizedAccountId];
  const existingIndex = Number(existing?.derivationIndex);
  if (existing?.address && existingIndex >= normalizedStartIndex) {
    return { ok: true, account: structuredClone(existing), created: false };
  }

  const now = new Date().toISOString();
  if (existing?.address) {
    state.ethereumDepositRetiredAccounts.push({
      ...existing,
      status: "retired_reserved_index",
      retiredAt: now,
      retireReason: `derivation_index_below_start:${normalizedStartIndex}`,
    });
    delete state.ethereumDepositAddressIndex[String(existing.address || "").toLowerCase()];
    delete state.ethereumDepositAccounts[normalizedAccountId];
  }

  const allocationStartIndex = Math.max(normalizedStartIndex, Number(state.ethereumDepositCursor || 0));
  for (let offset = 0; offset < 1000; offset += 1) {
    const derivationIndex = allocationStartIndex + offset;
    let derived = null;
    try {
      derived = deriveAddress(derivationIndex);
    } catch {
      return { ok: false, status: 409, error: "deposit_address_derivation_failed" };
    }
    const address = String(derived?.address || "").trim();
    const addressKey = address.toLowerCase();
    if (!address || state.ethereumDepositAddressIndex[addressKey]) continue;

    const account = {
      id: `ethdep_${randomUUID()}`,
      accountId: normalizedAccountId,
      chainId,
      network,
      address,
      addressKey,
      derivationIndex,
      derivationPath: derived?.derivationPath || "",
      assets,
      status: "active",
      custody,
      withdrawalsEnabled: false,
      sweepStatus: "deferred",
      observedBalances: {},
      creditedBalances: {},
      createdAt: now,
      updatedAt: now,
    };

    state.ethereumDepositAccounts[normalizedAccountId] = account;
    state.ethereumDepositAddressIndex[addressKey] = normalizedAccountId;
    state.ethereumDepositCursor = derivationIndex + 1;
    saveState();
    return { ok: true, account: structuredClone(account), created: true };
  }

  return { ok: false, status: 500, error: "deposit_address_allocation_failed" };
}

export function updateEthereumDepositSync({
  accountId = "",
  observedBalances = {},
  pendingBalances = {},
  creditedBalances = {},
  syncStatus = "ready",
  syncError = "",
  blockTag = "",
  creditedEntries = [],
} = {}) {
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim().slice(0, 160) : "";
  const existing = normalizedAccountId ? state.ethereumDepositAccounts[normalizedAccountId] : null;
  if (!existing) return null;

  const now = new Date().toISOString();
  const next = {
    ...existing,
    observedBalances: {
      ...(existing.observedBalances || {}),
      ...observedBalances,
    },
    pendingBalances: {
      ...(existing.pendingBalances || {}),
      ...pendingBalances,
    },
    creditedBalances: {
      ...(existing.creditedBalances || {}),
      ...creditedBalances,
    },
    lastSyncAt: now,
    lastSyncStatus: syncStatus,
    lastSyncError: syncError || "",
    lastSyncBlockTag: blockTag || existing.lastSyncBlockTag || "",
    lastCreditedLedgerIds: creditedEntries.map((entry) => entry.id).filter(Boolean),
    updatedAt: now,
  };

  state.ethereumDepositAccounts[normalizedAccountId] = next;
  saveState();
  return structuredClone(next);
}

function ledgerEntriesForScope({ accountId, conversationId } = {}) {
  return state.ledgerEntries.filter((entry) => {
    if (accountId && entry.accountId === accountId) return true;
    if (conversationId && entry.conversationId === conversationId) return true;
    if (!accountId && !conversationId) return true;
    return false;
  });
}

export function usageSummary(scope = {}) {
  const entries = ledgerEntriesForScope(scope);
  const currentSpendUsd = entries.reduce((total, entry) => {
    if (entry.kind !== "chat_debit") return total;
    return total + Number(entry.amountUsd || 0);
  }, 0);
  const currentCreditUsd = entries.reduce((total, entry) => {
    if (!["account_credit", "reward_credit", "refund_credit"].includes(entry.kind)) return total;
    return total + Number(entry.amountUsd || 0);
  }, 0);
  const availableCreditUsd = Math.max(0, currentCreditUsd - currentSpendUsd);

  return {
    currentSpendUsd: Number(currentSpendUsd.toFixed(6)),
    currentCreditUsd: Number(currentCreditUsd.toFixed(6)),
    availableCreditUsd: Number(availableCreditUsd.toFixed(6)),
    ledgerEntryCount: entries.length,
    storePath,
    durable: !storePath.startsWith("/tmp/"),
  };
}

export function usageLedger({ accountId, conversationId, limit = 50 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const filteredEntries = ledgerEntriesForScope({ accountId, conversationId });
  const entries = filteredEntries.slice(-normalizedLimit).reverse();
  const summary = usageSummary({ accountId, conversationId });

  return {
    billingModel: "usage_based",
    currency: "USD",
    accountId: accountId || null,
    conversationId: conversationId || null,
    currentSpendUsd: summary.currentSpendUsd,
    currentCreditUsd: summary.currentCreditUsd,
    availableCreditUsd: summary.availableCreditUsd,
    ledgerEntryCount: filteredEntries.length,
    durable: summary.durable,
    entries,
  };
}

function defaultContextBody() {
  return [
    "# Task Node Context",
    "",
    "## Current Focus",
    "",
    "## Preferences",
    "",
    "## Active Projects",
    "",
    "## Notes",
  ].join("\n");
}

export function getContextDocument({ accountId = "" } = {}) {
  const normalizedAccountId = safeId(accountId, "account");
  const canEdit = Boolean(accountId);
  const key = canEdit ? normalizedAccountId : "signed_out";
  const existing = state.contextDocuments[key];

  if (existing) {
    return {
      ...existing,
      canEdit,
      savePath: "/api/context/edit/save",
    };
  }

  const now = new Date().toISOString();
  return {
    id: `ctx_${key}`,
    accountId: canEdit ? normalizedAccountId : null,
    title: "Task Node Context",
    body: defaultContextBody(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    canEdit,
    savePath: "/api/context/edit/save",
  };
}

export function saveContextDocument({ accountId = "", title = "", body = "" } = {}) {
  if (!accountId) {
    return { ok: false, status: 401, error: "context_login_required" };
  }

  const normalizedAccountId = safeId(accountId, "account");
  const existing = state.contextDocuments[normalizedAccountId];
  const now = new Date().toISOString();
  const document = {
    id: existing?.id || `ctx_${normalizedAccountId}`,
    accountId: normalizedAccountId,
    title: String(title || "Task Node Context").trim().replace(/\s+/g, " ").slice(0, 120) || "Task Node Context",
    body: String(body || "").slice(0, 50000),
    revision: Number(existing?.revision || 0) + 1,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  state.contextDocuments[normalizedAccountId] = document;
  saveState();

  return {
    ok: true,
    document: {
      ...document,
      canEdit: true,
      savePath: "/api/context/edit/save",
    },
  };
}

function emptyContextHistory({ accountId = "", walletAddress = "", canHydrate = false } = {}) {
  const normalizedAccountId = accountId ? safeId(accountId, "account") : null;
  const normalizedWalletAddress = walletAddress ? String(walletAddress).trim() : null;
  return {
    id: `ctx_history_${
      normalizedAccountId && normalizedWalletAddress
        ? contextHistorySnapshotKey({ accountId: normalizedAccountId, walletAddress: normalizedWalletAddress })
        : normalizedAccountId || "signed_out"
    }`,
    accountId: normalizedAccountId,
    source: "pftl_cache_context_projection",
    revision: 0,
    projectedAt: null,
    walletAddress: normalizedWalletAddress,
    pointerCount: 0,
    contextUpdateCount: 0,
    taskEventCount: 0,
    latestContextPointer: null,
    contextUpdates: [],
    taskEvents: [],
    hydration: {
      plaintextHydrated: false,
      requiresWalletUnlock: true,
      ipfsFetchReady: true,
      fetchPath: "/api/context/history/ipfs/:cid",
      note:
        "No cached PFTL context pointers are available for this wallet yet. Background sync projects context pointers from cached wallet transactions.",
    },
    sync: {
      source: "runtime_store",
      status: normalizedWalletAddress ? "syncing" : "ready",
      archiveComplete: false,
      lastHotSyncAt: null,
      lastArchiveSyncAt: null,
      lastError: null,
    },
    canHydrate: Boolean(canHydrate && normalizedWalletAddress),
  };
}

export function getContextHistory({ accountId = "", walletAddress = "" } = {}) {
  const hasAccount = Boolean(accountId);
  const normalizedAccountId = hasAccount ? safeId(accountId, "account") : "";
  const normalizedWalletAddress = walletAddress ? String(walletAddress).trim() : "";
  const snapshotKey =
    hasAccount && normalizedWalletAddress
      ? contextHistorySnapshotKey({ accountId: normalizedAccountId, walletAddress: normalizedWalletAddress })
      : "";
  const existing = snapshotKey ? state.contextHistorySnapshots[snapshotKey] : null;

  if (existing) {
    return {
      ...existing,
      walletAddress: existing.walletAddress || normalizedWalletAddress,
      canHydrate: true,
      sync: existing.sync || {
        source: "runtime_store",
        status: "ready",
        archiveComplete: false,
        lastHotSyncAt: null,
        lastArchiveSyncAt: null,
        lastError: null,
      },
    };
  }

  return emptyContextHistory({
    accountId: normalizedAccountId,
    walletAddress: normalizedWalletAddress,
    canHydrate: hasAccount && Boolean(normalizedWalletAddress),
  });
}

export function saveContextHistoryProjection({ accountId = "", projection = {}, snapshot = {} } = {}) {
  if (!accountId) {
    return { ok: false, status: 401, error: "context_login_required" };
  }

  const normalizedAccountId = safeId(accountId, "account");
  const normalized = normalizeContextHistoryProjection(
    projection && typeof projection === "object" && Object.keys(projection).length ? projection : snapshot
  );
  const normalizedWalletAddress = normalized.walletAddress ? String(normalized.walletAddress).trim() : "";
  if (!normalizedWalletAddress) {
    return {
      ok: false,
      status: 409,
      error: "context_history_wallet_required",
    };
  }

  const snapshotKey = contextHistorySnapshotKey({
    accountId: normalizedAccountId,
    walletAddress: normalizedWalletAddress,
  });
  const existing = state.contextHistorySnapshots[snapshotKey];
  const now = new Date().toISOString();
  const document = {
    id: existing?.id || `ctx_history_${snapshotKey}`,
    accountId: normalizedAccountId,
    source: normalized.source,
    revision: Number(existing?.revision || 0) + 1,
    projectedAt: now,
    normalizedAt: normalized.normalizedAt,
    walletAddress: normalizedWalletAddress,
    pointerCount: normalized.pointerCount,
    contextUpdateCount: normalized.contextUpdateCount,
    taskEventCount: normalized.taskEventCount,
    latestContextPointer: normalized.latestContextPointer,
    contextUpdates: normalized.contextUpdates.slice(0, 50),
    taskEvents: normalized.taskEvents.slice(0, 200),
    hydration: normalized.hydration,
    sync: {
      source: "runtime_store",
      status: "ready",
      archiveComplete: false,
      lastHotSyncAt: now,
      lastArchiveSyncAt: null,
      lastError: null,
    },
  };

  state.contextHistorySnapshots[snapshotKey] = document;
  if (state.contextHistorySnapshots[normalizedAccountId]?.walletAddress === normalizedWalletAddress) {
    delete state.contextHistorySnapshots[normalizedAccountId];
  }
  saveState();

  return {
    ok: true,
    history: {
      ...document,
      canHydrate: true,
    },
  };
}

function walletChallengeMessage({ accountId, challengeId, purpose, issuedAt, expiresAt }) {
  return [
    "Post Fiat Task Node wallet proof",
    `Purpose: ${purpose}`,
    `Account: ${accountId}`,
    `Challenge: ${challengeId}`,
    `Issued: ${issuedAt}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

export function createWalletChallenge({ accountId = "", purpose = "wallet_link" } = {}) {
  if (!accountId) {
    return { ok: false, status: 401, error: "wallet_login_required" };
  }

  const normalizedAccountId = safeId(accountId, "account");
  const challengeId = randomUUID();
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const challenge = {
    id: challengeId,
    accountId: normalizedAccountId,
    purpose,
    issuedAt,
    expiresAt,
    message: walletChallengeMessage({
      accountId: normalizedAccountId,
      challengeId,
      purpose,
      issuedAt,
      expiresAt,
    }),
  };

  state.walletChallenges[challengeId] = challenge;
  saveState();

  return { ok: true, challenge };
}

export function consumeWalletChallenge({ accountId = "", challengeId = "", purpose = "wallet_link" } = {}) {
  const normalizedAccountId = safeId(accountId, "account");
  const id = String(challengeId || "");
  const challenge = state.walletChallenges[id];

  if (!challenge) {
    return { ok: false, status: 400, error: "wallet_challenge_invalid" };
  }

  delete state.walletChallenges[id];
  saveState();

  const allowedPurposes = Array.isArray(purpose) ? purpose : [purpose];
  if (challenge.accountId !== normalizedAccountId || !allowedPurposes.includes(challenge.purpose)) {
    return { ok: false, status: 400, error: "wallet_challenge_mismatch" };
  }

  if ((Date.parse(challenge.expiresAt || "") || 0) <= Date.now()) {
    return { ok: false, status: 400, error: "wallet_challenge_expired" };
  }

  return { ok: true, challenge };
}

function activeWalletAccountsForAddress(address = "", exceptAccountId = "") {
  const normalizedAddress = String(address || "").trim();
  const normalizedExceptAccountId = exceptAccountId ? safeId(exceptAccountId, "account") : "";
  if (!normalizedAddress) return [];

  return Object.entries(state.accountWallets || {}).filter(([accountId, wallet]) => {
    if (!wallet || wallet.status !== "linked") return false;
    if (normalizedExceptAccountId && accountId === normalizedExceptAccountId) return false;
    return String(wallet.address || "").trim() === normalizedAddress;
  });
}

export function accountWalletCloudFacts({ accountId = "" } = {}) {
  const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
  return {
    accountId: normalizedAccountId, activeWallet: normalizedAccountId ? state.accountWallets[normalizedAccountId] || null : null, activeWallets: state.accountWallets || {},
    authEvents: (state.authEvents || []).filter((event) => event?.accountId === normalizedAccountId && String(event.eventType || "").startsWith("wallet_")),
  };
}

export function linkWalletToAccount({
  accountId = "",
  address = "",
  publicKey = "",
  challengeId = "",
  signature = "",
  proofPurpose = "wallet_link",
} = {}) {
  if (!accountId) {
    return { ok: false, status: 401, error: "wallet_login_required" };
  }

  const normalizedAccountId = safeId(accountId, "account");
  const normalizedAddress = String(address || "").trim();
  if (!normalizedAddress) {
    return { ok: false, status: 400, error: "wallet_address_required" };
  }
  const now = new Date().toISOString();
  const reclaimedOwners = activeWalletAccountsForAddress(normalizedAddress, normalizedAccountId);
  for (const [ownerAccountId, ownerWallet] of reclaimedOwners) {
    delete state.accountWallets[ownerAccountId];
    state.authEvents.push({
      id: randomUUID(),
      accountId: ownerAccountId,
      eventType: "wallet_reclaimed_from_account",
      provider: "wallet",
      email: null,
      decision: "superseded",
      metadata: {
        walletAddress: ownerWallet.address,
        publicKey: ownerWallet.publicKey || null,
        custody: ownerWallet.custody || "local_seed_required",
        linkedAt: ownerWallet.linkedAt || null,
        reclaimedByAccountId: normalizedAccountId,
        proofPurpose,
        challengeId,
      },
      createdAt: now,
    });
  }

  const previousWallet = state.accountWallets[normalizedAccountId] || null;
  const wallet = {
    accountId: normalizedAccountId,
    status: "linked",
    address: normalizedAddress,
    publicKey: String(publicKey || "").trim(),
    custody: "local_seed_required",
    linkedAt: previousWallet?.linkedAt || now,
    relinkedAt: previousWallet ? now : undefined,
    updatedAt: now,
    proof: {
      challengeId,
      purpose: proofPurpose,
      signatureHash: stableId(signature, "sig"),
    },
  };

  state.accountWallets[normalizedAccountId] = wallet;
  state.authEvents.push({
    id: randomUUID(),
    accountId: normalizedAccountId,
    eventType: previousWallet ? "wallet_relinked" : "wallet_linked",
    provider: "wallet",
    email: null,
    decision: "accepted",
    metadata: {
      walletAddress: wallet.address,
      previousWalletAddress: previousWallet?.address || null,
      proofPurpose,
      challengeId,
      signatureHash: wallet.proof.signatureHash,
      reclaimedWalletCount: reclaimedOwners.length,
    },
    createdAt: now,
  });
  if (state.authEvents.length > 1000) {
    state.authEvents = state.authEvents.slice(-1000);
  }
  saveState();

  return { ok: true, wallet, reclaimedWalletCount: reclaimedOwners.length };
}

export function delinkWalletFromAccount({
  accountId = "",
  reason = "user_requested",
  actorSessionId = "",
} = {}) {
  if (!accountId) {
    return { ok: false, status: 401, error: "wallet_login_required" };
  }

  const normalizedAccountId = safeId(accountId, "account");
  const wallet = state.accountWallets[normalizedAccountId];
  if (!wallet || wallet.status !== "linked" || !wallet.address) {
    return { ok: false, status: 409, error: "wallet_not_linked" };
  }

  const now = new Date().toISOString();
  const previousWallet = {
    ...wallet,
    status: "delinked",
    delinkedAt: now,
    updatedAt: now,
  };

  delete state.accountWallets[normalizedAccountId];
  state.authEvents.push({
    id: randomUUID(),
    accountId: normalizedAccountId,
    eventType: "wallet_delinked",
    provider: "wallet",
    email: null,
    decision: "accepted",
    metadata: {
      walletAddress: wallet.address,
      publicKey: wallet.publicKey || null,
      custody: wallet.custody || "local_seed_required",
      linkedAt: wallet.linkedAt || null,
      reason: String(reason || "user_requested").slice(0, 120),
      actorSessionId: actorSessionId || null,
    },
    createdAt: now,
  });
  if (state.authEvents.length > 1000) {
    state.authEvents = state.authEvents.slice(-1000);
  }
  saveState();

  return { ok: true, wallet: previousWallet };
}

export function getLinkedWallet({ accountId = "" } = {}) {
  if (!accountId) {
    return {
      status: "not_linked",
      address: null,
      publicKey: null,
      custody: "local_seed_required",
    };
  }

  const wallet = state.accountWallets[safeId(accountId, "account")];
  if (!wallet) {
    return {
      status: "not_linked",
      address: null,
      publicKey: null,
      custody: "local_seed_required",
    };
  }

  return {
    status: wallet.status || "linked",
    address: wallet.address,
    publicKey: wallet.publicKey,
    custody: wallet.custody || "local_seed_required",
    linkedAt: wallet.linkedAt,
    updatedAt: wallet.updatedAt,
  };
}
