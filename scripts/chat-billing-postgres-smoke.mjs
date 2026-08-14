import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import {
  appendChatTurn,
  appendUsageCredit,
  deleteChatConversation,
  getChatMessages,
  getChatMessagesForWrite,
  hasUsageCreditForSource,
  listChatConversations,
  renameChatConversation,
  usageLedger,
  usageSummary,
} from "../server/repositories/chat-billing.js";
import {
  createContextEditProposal,
  markContextEditProposalApplied,
} from "../server/repositories/context-edit.js";
import { chatCacheEfficiencyStatus } from "../server/model-pricing-status.js";

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
const contextEditProposalId = `ctxedit_${suffix}`;

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

const unrelatedDepositCredit = await hasUsageCreditForSource({
  accountId,
  source: "ethereum_deposit",
  metadata: { depositAccountId: `ethdep_${suffix}` },
  uniqueKeyPrefix: `ethereum_deposit:ethdep_${suffix}:`,
});
if (unrelatedDepositCredit) {
  throw new Error("Admin credit must not satisfy Ethereum deposit credit lookup.");
}

await appendUsageCredit({
  accountId,
  amountUsd: 7,
  source: "ethereum_deposit",
  note: "Postgres smoke deposit",
  uniqueKey: `ethereum_deposit:ethdep_${suffix}:USDC:7000000`,
  metadata: { depositAccountId: `ethdep_${suffix}` },
});
const exactDepositCredit = await hasUsageCreditForSource({
  accountId,
  source: "ethereum_deposit",
  metadata: { depositAccountId: `ethdep_${suffix}` },
  uniqueKeyPrefix: `ethereum_deposit:ethdep_${suffix}:`,
});
const wrongDepositCredit = await hasUsageCreditForSource({
  accountId,
  source: "ethereum_deposit",
  metadata: { depositAccountId: `ethdep_wrong_${suffix}` },
  uniqueKeyPrefix: `ethereum_deposit:ethdep_wrong_${suffix}:`,
});
if (!exactDepositCredit || wrongDepositCredit) {
  throw new Error(`Deposit credit lookup failed: ${JSON.stringify({ exactDepositCredit, wrongDepositCredit })}`);
}

const chat = await appendChatTurn({
  accountId,
  conversationId,
  mode: "Thinking",
  provider: "ambient",
  model: "z-ai/glm-5.2",
  responseId: `resp_${suffix}`,
  userMessage: "Persist this smoke chat.",
  assistantMessage: "Persisted.",
  assistantMetadata: {
    kind: "context_edit",
    contextEdit: {
      state: "proposal",
      proposal: {
        id: contextEditProposalId,
        state: "pending",
        operation: "replace_block",
        targetBefore: "old",
        targetAfter: "new",
      },
    },
  },
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
    promptCacheHitTokens: 80,
    promptCacheMissTokens: 20,
    cacheUsageReported: true,
    cacheSavingsUsd: 0.000068,
    costSource: "provider_usage",
    outputTokens: 20,
    totalTokens: 120,
    costUsd: 0.0011,
  },
});

await createContextEditProposal({
  id: contextEditProposalId,
  accountId,
  conversationId,
  assistantMessageId: chat.assistant.id,
  baseContextRevision: 1,
  baseBodySha256: "hash-before",
  operation: "replace_block",
  anchorType: "excerpt",
  lineStart: 1,
  lineEnd: 1,
  targetBefore: "old",
  targetAfter: "new",
  rationale: "Smoke proposal.",
  risk: "low",
});
await markContextEditProposalApplied({
  accountId,
  proposalId: contextEditProposalId,
  savedContextRevision: 2,
  savedContextDocumentId: "ctxdoc_smoke",
  savedContextHash: "hash-after",
});

const messages = await getChatMessages({ accountId, conversationId });
const summary = await usageSummary({ accountId });
const ledger = await usageLedger({ accountId, limit: 10 });
const modelRunCache = await query(
  `
    SELECT
      prompt_cache_hit_tokens,
      prompt_cache_miss_tokens,
      cache_usage_reported,
      cache_savings_usd,
      cost_source
    FROM chat_model_runs
    WHERE response_id = $1
    LIMIT 1
  `,
  [`resp_${suffix}`]
);
const cacheEfficiency = await chatCacheEfficiencyStatus();
const thinkingCacheEfficiency = cacheEfficiency.modes.find((entry) => (
  entry.mode === "Thinking" && entry.model === "z-ai/glm-5.2"
));
const conversations = await listChatConversations({ accountId });
const renamed = await renameChatConversation({
  accountId,
  conversationId,
  title: "Postgres smoke renamed",
});
const deleted = await deleteChatConversation({ accountId, conversationId });
const afterDelete = await listChatConversations({ accountId });
let deletedReadRejected = false;
try {
  await getChatMessages({ accountId, conversationId });
} catch (error) {
  deletedReadRejected = error?.message === "chat_conversation_not_found";
}
const writeHistoryAfterDelete = await getChatMessagesForWrite({ accountId, conversationId });
const revived = await appendChatTurn({
  accountId,
  conversationId,
  mode: "Frontier Instant",
  provider: "openai",
  model: "chat-latest",
  responseId: `resp_revive_${suffix}`,
  userMessage: "Revive this deleted conversation for a new write.",
  assistantMessage: "Revived.",
  usage: {
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    costUsd: 0,
  },
});
const afterReviveMessages = await getChatMessages({ accountId, conversationId });
const afterRevive = await listChatConversations({ accountId });

if (
  !chat?.ledgerEntry ||
  chat.user?.attachments?.[0]?.textContent !== 'const ok = "persisted code";' ||
  messages.length !== 2 ||
  messages[1]?.metadata?.contextEdit?.proposal?.state !== "applied" ||
  messages[1]?.metadata?.contextEdit?.proposal?.savedContextRevision !== 2 ||
  messages[0]?.attachments?.[0]?.textContent !== 'const ok = "persisted code";' ||
  messages[0]?.attachments?.[0]?.source !== "paste" ||
  summary.currentCreditUsd !== 12 ||
  summary.currentSpendUsd !== 0.0011 ||
  summary.availableCreditUsd !== 11.9989 ||
  ledger.entries.length < 2 ||
  ledger.entries[0]?.promptCacheHitTokens !== 80 ||
  ledger.entries[0]?.promptCacheMissTokens !== 20 ||
  ledger.entries[0]?.cacheUsageReported !== true ||
  ledger.entries[0]?.cacheSavingsUsd !== 0.000068 ||
  ledger.entries[0]?.costSource !== "provider_usage" ||
  Number(modelRunCache.rows[0]?.prompt_cache_hit_tokens || 0) !== 80 ||
  Number(modelRunCache.rows[0]?.prompt_cache_miss_tokens || 0) !== 20 ||
  modelRunCache.rows[0]?.cache_usage_reported !== true ||
  Number(modelRunCache.rows[0]?.cache_savings_usd || 0) !== 0.000068 ||
  modelRunCache.rows[0]?.cost_source !== "provider_usage" ||
  cacheEfficiency.status !== "ok" ||
  Number(thinkingCacheEfficiency?.promptCacheHitTokens || 0) < 80 ||
  Number(thinkingCacheEfficiency?.cacheSavingsUsd || 0) < 0.000068 ||
  !conversations.some((item) => item.conversationId === conversationId) ||
  !renamed.ok ||
  !deleted.ok ||
  afterDelete.some((item) => item.conversationId === conversationId) ||
  !deletedReadRejected ||
  writeHistoryAfterDelete.length !== 0 ||
  revived.assistant?.body !== "Revived." ||
  afterReviveMessages.length < 2 ||
  !afterRevive.some((item) => item.conversationId === conversationId)
) {
  throw new Error(`Chat/billing Postgres smoke failed: ${JSON.stringify({
    chat,
    messages,
    summary,
    ledger,
    modelRunCache: modelRunCache.rows[0],
    cacheEfficiency,
    conversations,
    renamed,
    deleted,
    afterDelete,
    deletedReadRejected,
    writeHistoryAfterDelete,
    revived,
    afterReviveMessages,
    afterRevive,
  })}`);
}

console.log(`chat/billing postgres smoke ok: ${accountId}`);
await closePool();
