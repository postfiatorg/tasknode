import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const defaultStorePath = path.join("/tmp", "tasknodeofficial-runtime-store.json");
const storePath = process.env.TASKNODE_STORE_PATH || defaultStorePath;
const defaultState = {
  version: 1,
  conversations: {
    dev: [],
  },
  ledgerEntries: [],
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

export function getChatMessages(conversationId = "dev") {
  return conversationMessages(conversationId).slice(-30);
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

export function usageSummary() {
  const currentSpendUsd = state.ledgerEntries.reduce((total, entry) => {
    if (entry.kind !== "chat_debit") return total;
    return total + Number(entry.amountUsd || 0);
  }, 0);

  return {
    currentSpendUsd: Number(currentSpendUsd.toFixed(6)),
    ledgerEntryCount: state.ledgerEntries.length,
    storePath,
    durable: !storePath.startsWith("/tmp/"),
  };
}
