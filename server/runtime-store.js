import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { normalizeIndexedContextHistory } from "./context-history.js";

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
  walletChallenges: {},
  contextDocuments: {},
  contextHistorySnapshots: {},
  oauthStates: {},
  emailChallenges: {},
  authEvents: [],
};

let state = loadState();

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
  usage,
}) {
  const now = new Date().toISOString();
  const messages = conversationMessages(conversationId);
  const userId = `msg_${randomUUID()}_user`;
  const assistantId = `msg_${randomUUID()}_assistant`;
  const ledgerId = `ledger_${randomUUID()}`;

  messages.push({
    id: userId,
    role: "user",
    body: userMessage,
    createdAt: now,
    mode,
  });
  messages.push({
    id: assistantId,
    role: "assistant",
    body: assistantMessage,
    createdAt: now,
    mode,
    provider,
    model,
    responseId,
  });

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

  state.ledgerEntries.push(entry);
  saveState();

  return entry;
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

function emptyContextHistory({ accountId = "", canHydrate = false } = {}) {
  return {
    id: `ctx_history_${canHydrate ? safeId(accountId, "account") : "signed_out"}`,
    accountId: canHydrate ? safeId(accountId, "account") : null,
    source: "pftasks_indexed_snapshot",
    revision: 0,
    importedAt: null,
    walletAddress: null,
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
        "Historical PFT context has not been imported yet. Indexed PFTasks rows are the preferred source.",
    },
    canHydrate,
    importPath: "/api/context/history/indexed",
  };
}

export function getContextHistory({ accountId = "" } = {}) {
  const canHydrate = Boolean(accountId);
  const normalizedAccountId = canHydrate ? safeId(accountId, "account") : "";
  const existing = canHydrate ? state.contextHistorySnapshots[normalizedAccountId] : null;

  if (existing) {
    return {
      ...existing,
      canHydrate,
      importPath: "/api/context/history/indexed",
    };
  }

  return emptyContextHistory({ accountId: normalizedAccountId, canHydrate });
}

export function saveIndexedContextHistory({ accountId = "", snapshot = {} } = {}) {
  if (!accountId) {
    return { ok: false, status: 401, error: "context_login_required" };
  }

  const normalizedAccountId = safeId(accountId, "account");
  const existing = state.contextHistorySnapshots[normalizedAccountId];
  const normalized = normalizeIndexedContextHistory(snapshot);
  const now = new Date().toISOString();
  const document = {
    id: existing?.id || `ctx_history_${normalizedAccountId}`,
    accountId: normalizedAccountId,
    source: normalized.source,
    revision: Number(existing?.revision || 0) + 1,
    importedAt: now,
    normalizedAt: normalized.normalizedAt,
    walletAddress: normalized.walletAddress,
    pointerCount: normalized.pointerCount,
    contextUpdateCount: normalized.contextUpdateCount,
    taskEventCount: normalized.taskEventCount,
    latestContextPointer: normalized.latestContextPointer,
    contextUpdates: normalized.contextUpdates.slice(0, 50),
    taskEvents: normalized.taskEvents.slice(0, 200),
    hydration: normalized.hydration,
  };

  state.contextHistorySnapshots[normalizedAccountId] = document;
  saveState();

  return {
    ok: true,
    history: {
      ...document,
      canHydrate: true,
      importPath: "/api/context/history/indexed",
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

  if (challenge.accountId !== normalizedAccountId || challenge.purpose !== purpose) {
    return { ok: false, status: 400, error: "wallet_challenge_mismatch" };
  }

  if ((Date.parse(challenge.expiresAt || "") || 0) <= Date.now()) {
    return { ok: false, status: 400, error: "wallet_challenge_expired" };
  }

  return { ok: true, challenge };
}

export function linkWalletToAccount({
  accountId = "",
  address = "",
  publicKey = "",
  challengeId = "",
  signature = "",
} = {}) {
  if (!accountId) {
    return { ok: false, status: 401, error: "wallet_login_required" };
  }

  const normalizedAccountId = safeId(accountId, "account");
  const now = new Date().toISOString();
  const wallet = {
    accountId: normalizedAccountId,
    status: "linked",
    address: String(address || "").trim(),
    publicKey: String(publicKey || "").trim(),
    custody: "local_seed_required",
    linkedAt: now,
    updatedAt: now,
    proof: {
      challengeId,
      signatureHash: stableId(signature, "sig"),
    },
  };

  state.accountWallets[normalizedAccountId] = wallet;
  saveState();

  return { ok: true, wallet };
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
