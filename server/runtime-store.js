import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

export function destroySession(sessionId) {
  if (!sessionId || !state.sessions[sessionId]) return false;

  delete state.sessions[sessionId];
  saveState();
  return true;
}

export function appendChatTurn({
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

export function usageSummary() {
  const currentSpendUsd = state.ledgerEntries.reduce((total, entry) => {
    if (entry.kind !== "chat_debit") return total;
    return total + Number(entry.amountUsd || 0);
  }, 0);
  const currentCreditUsd = state.ledgerEntries.reduce((total, entry) => {
    if (!["account_credit", "reward_credit", "refund_credit"].includes(entry.kind)) return total;
    return total + Number(entry.amountUsd || 0);
  }, 0);
  const availableCreditUsd = Math.max(0, currentCreditUsd - currentSpendUsd);

  return {
    currentSpendUsd: Number(currentSpendUsd.toFixed(6)),
    currentCreditUsd: Number(currentCreditUsd.toFixed(6)),
    availableCreditUsd: Number(availableCreditUsd.toFixed(6)),
    ledgerEntryCount: state.ledgerEntries.length,
    storePath,
    durable: !storePath.startsWith("/tmp/"),
  };
}

export function usageLedger({ conversationId, limit = 50 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const filteredEntries = state.ledgerEntries.filter((entry) => {
    if (!conversationId) return true;
    return entry.conversationId === conversationId;
  });
  const entries = filteredEntries.slice(-normalizedLimit).reverse();
  const summary = usageSummary();

  return {
    billingModel: "usage_based",
    currency: "USD",
    conversationId: conversationId || null,
    currentSpendUsd: summary.currentSpendUsd,
    currentCreditUsd: summary.currentCreditUsd,
    availableCreditUsd: summary.availableCreditUsd,
    ledgerEntryCount: filteredEntries.length,
    durable: summary.durable,
    entries,
  };
}
