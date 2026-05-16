import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";

const defaultStorePath = path.join("/tmp", "tasknodeofficial-runtime-store.json");
export const sessionCookieName = "tasknode_session";
export const sessionTtlSeconds = 60 * 60 * 24 * 7;
const storePath = process.env.TASKNODE_STORE_PATH || defaultStorePath;
const defaultState = {
  version: 1,
  conversations: {
    dev: [],
  },
  ledgerEntries: [],
  sessions: {},
  accounts: {},
  accountEmails: {},
  accountIdentities: {},
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
  const requested = safeId(requestedId, "default");
  if (!session?.accountId) {
    return requestedId ? requested : "dev";
  }

  const accountId = safeId(session.accountId, "account");
  return `account_${accountId}_${requested}`.slice(0, 160);
}

export function getChatMessages(conversationId = "dev") {
  return conversationMessages(conversationId).slice(-30);
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
  const sessionId = randomUUID();
  const session = {
    id: sessionId,
    accountId: `acct_dev_${normalizedEmail.replace(/[^a-z0-9]+/g, "_").slice(0, 48)}`,
    displayName: displayNameFromEmail(normalizedEmail),
    primaryProvider: "dev",
    linkedProviders: [
      {
        id: "dev",
        label: "Dev session",
        kind: "development",
        status: "linked",
      },
    ],
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
  const userId = `msg_${now.replace(/[^0-9]/g, "")}_user`;
  const assistantId = `msg_${now.replace(/[^0-9]/g, "")}_assistant`;
  const ledgerId = `ledger_${now.replace(/[^0-9]/g, "")}`;

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
}) {
  const now = new Date().toISOString();
  const ledgerId = `ledger_${now.replace(/[^0-9]/g, "")}_credit`;
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
