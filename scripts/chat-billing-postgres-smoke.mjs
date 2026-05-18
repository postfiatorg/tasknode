import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool } from "../server/db/pool.js";
import {
  appendChatTurn,
  appendUsageCredit,
  deleteChatConversation,
  getChatMessages,
  listChatConversations,
  renameChatConversation,
  usageLedger,
  usageSummary,
} from "../server/repositories/chat-billing.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for chat/billing Postgres smoke.");
}
if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

await migrateDatabase();

const suffix = randomUUID().slice(0, 8);
const accountId = `acct_pg_smoke_${suffix}`;
const conversationId = `account_${accountId}_default`;

const credit = await appendUsageCredit({
  accountId,
  amountUsd: 5,
  source: "postgres_smoke",
  note: "Postgres smoke credit",
  uniqueKey: `postgres_smoke_credit:${accountId}`,
});
const replay = await appendUsageCredit({
  accountId,
  amountUsd: 5,
  source: "postgres_smoke",
  note: "Postgres smoke credit replay",
  uniqueKey: `postgres_smoke_credit:${accountId}`,
});

if (!credit?.id || replay?.id !== credit.id || replay?.idempotentReplay !== true) {
  throw new Error(`Credit idempotency failed: ${JSON.stringify({ credit, replay })}`);
}

const chat = await appendChatTurn({
  accountId,
  conversationId,
  mode: "Frontier Instant",
  provider: "openai",
  model: "chat-latest",
  responseId: `resp_${suffix}`,
  userMessage: "Persist this smoke chat.",
  assistantMessage: "Persisted.",
  attachments: [
    {
      name: "smoke-code.jsx",
      mimeType: "text/plain",
      source: "paste",
      size: 31,
      dataUrl: "data:text/plain;charset=utf-8,const%20ok%20%3D%20%22persisted%20code%22%3B",
    },
  ],
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    costUsd: 0.0011,
  },
});

const messages = await getChatMessages({ accountId, conversationId });
const summary = await usageSummary({ accountId });
const ledger = await usageLedger({ accountId, limit: 10 });
const conversations = await listChatConversations({ accountId });
const renamed = await renameChatConversation({
  accountId,
  conversationId,
  title: "Postgres smoke renamed",
});
const deleted = await deleteChatConversation({ accountId, conversationId });
const afterDelete = await listChatConversations({ accountId });

if (
  !chat?.ledgerEntry ||
  chat.user?.attachments?.[0]?.textContent !== 'const ok = "persisted code";' ||
  messages.length !== 2 ||
  messages[0]?.attachments?.[0]?.textContent !== 'const ok = "persisted code";' ||
  messages[0]?.attachments?.[0]?.source !== "paste" ||
  summary.currentCreditUsd !== 5 ||
  summary.currentSpendUsd !== 0.0011 ||
  summary.availableCreditUsd !== 4.9989 ||
  ledger.entries.length < 2 ||
  !conversations.some((item) => item.conversationId === conversationId) ||
  !renamed.ok ||
  !deleted.ok ||
  afterDelete.some((item) => item.conversationId === conversationId)
) {
  throw new Error(`Chat/billing Postgres smoke failed: ${JSON.stringify({
    chat,
    messages,
    summary,
    ledger,
    conversations,
    renamed,
    deleted,
    afterDelete,
  })}`);
}

console.log(`chat/billing postgres smoke ok: ${accountId}`);
await closePool();
