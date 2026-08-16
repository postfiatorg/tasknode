import { createHash, randomUUID } from "node:crypto";
import {
  appendChatTurn as appendRuntimeChatTurn,
  appendUsageCredit as appendRuntimeUsageCredit,
  usageLedger as runtimeUsageLedger,
} from "../runtime-store.js";
import {
  decodeTextDataUrl,
  normalizeChatAttachments,
} from "../chat-attachment-utils.js";
import { databaseEnabled, databaseStatus, query, transaction } from "../db/pool.js";
import {
  publicBillingLedgerEntry as publicLedgerEntry,
  publicChatAttachment as publicAttachment,
  publicChatMessage as publicMessage,
} from "./chat-billing-projections.js";
import { getChatMessages } from "./chat-billing-read.js";
import {
  recordBillingCreditAppliedEvent,
  recordChatTurnObservability,
} from "./user-observability.js";
export {
  appendChatUserMessage,
  deleteChatConversation,
  enableHiveConversation,
  getHiveConversation,
  hiveConversationIdForAccount,
  listChatConversations,
  markHiveConversationRead,
  renameChatConversation,
  searchChatConversations,
} from "./chat-conversations.js";
export {
  getChatMessages,
  getChatMessagesForWrite,
  usageLedger,
  usageSummary,
} from "./chat-billing-read.js";

const creditKinds = new Set(["account_credit", "top_up_credit", "reward_credit", "refund_credit"]);
const maxLedgerLimit = 200;

function useDatabase() {
  return databaseEnabled();
}

export function chatBillingStatus() {
  return databaseStatus();
}

const safeAccountId = (accountId = "") => String(accountId || "").trim().slice(0, 160);
const safeConversationId = (conversationId = "dev") =>
  String(conversationId || "dev").trim().slice(0, 180) || "dev";

function safeConversationAccountId(accountId = "") {
  return String(accountId || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function chatConversationNotFound() {
  const error = new Error("chat_conversation_not_found");
  error.status = 404;
  return error;
}

function assertConversationIdAccountBoundary({ accountId = "", conversationId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  if (!normalizedConversationId.startsWith("account_")) return;

  const conversationAccountId = safeConversationAccountId(normalizedAccountId);
  const accountPrefix = conversationAccountId ? `account_${conversationAccountId}_` : "";
  if (!accountPrefix || !normalizedConversationId.startsWith(accountPrefix)) {
    throw chatConversationNotFound();
  }
}

const cleanTitle = (title = "") => String(title || "").trim().replace(/\s+/g, " ").slice(0, 80);
const titleFromPrompt = (prompt = "") => cleanTitle(prompt).slice(0, 64) || "New chat";
const messagePreview = (message = "") => String(message || "").trim().replace(/\s+/g, " ").slice(0, 140);
const conversationStatusForInsert = (status = "active") =>
  String(status || "active").trim().toLowerCase().slice(0, 40) === "task_request" ? "task_request" : "active";

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function cacheUsageFields(usage = {}) {
  const inputTokens = Math.max(0, Number(usage?.inputTokens || 0));
  const promptCacheHitTokens = Math.min(
    inputTokens,
    Math.max(0, Math.floor(Number(usage?.promptCacheHitTokens || 0)))
  );
  const promptCacheMissTokens = Math.min(
    inputTokens,
    Math.max(0, Math.floor(Number(usage?.promptCacheMissTokens || 0)))
  );
  return {
    promptCacheHitTokens,
    promptCacheMissTokens,
    cacheUsageReported: usage?.cacheUsageReported === true,
    cacheSavingsUsd: numeric(usage?.cacheSavingsUsd || 0),
    costSource: String(usage?.costSource || "").trim().slice(0, 80),
    providerCostUsd: usage?.providerCostUsd === null || usage?.providerCostUsd === undefined
      ? null
      : numeric(usage.providerCostUsd),
  };
}

function jsonValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function attachmentRowsForInsert({ attachments = [], accountId, conversationId, messageId, createdAt }) {
  return normalizeChatAttachments(attachments).map((attachment, index) => {
    const textContent = attachment.kind === "text" ? decodeTextDataUrl(attachment.dataUrl) : "";
    const hashInput = textContent || attachment.dataUrl;
    return {
      id: `att_${randomUUID()}`,
      accountId,
      conversationId,
      messageId,
      ordinal: index,
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      source: attachment.source,
      sizeBytes: Math.max(0, Number(attachment.size || 0)),
      sha256: sha256(hashInput),
      textContent: textContent || null,
      textExcerpt: textContent ? textContent.slice(0, 500) : null,
      storageUri: null,
      createdAt,
      metadata: {},
    };
  });
}

function ledgerDeltas(kind, amountUsd) {
  const amount = numeric(amountUsd);
  if (kind === "chat_debit") return { spend: amount, credit: 0 };
  if (creditKinds.has(kind)) return { spend: 0, credit: amount };
  if (kind === "admin_adjustment") {
    return amount >= 0 ? { spend: 0, credit: amount } : { spend: Math.abs(amount), credit: 0 };
  }
  return { spend: 0, credit: 0 };
}

async function applyBillingProjection(client, { accountId, kind, amountUsd }) {
  const normalizedAccountId = safeAccountId(accountId);
  const { spend, credit } = ledgerDeltas(kind, amountUsd);
  await client.query(
    `
      INSERT INTO billing_accounts (
        account_id,
        current_spend_usd,
        current_credit_usd,
        ledger_entry_count,
        updated_at
      )
      VALUES ($1, $2, $3, 1, now())
      ON CONFLICT (account_id) DO UPDATE SET
        current_spend_usd = billing_accounts.current_spend_usd + EXCLUDED.current_spend_usd,
        current_credit_usd = billing_accounts.current_credit_usd + EXCLUDED.current_credit_usd,
        ledger_entry_count = billing_accounts.ledger_entry_count + 1,
        updated_at = now()
    `,
    [normalizedAccountId, spend, credit]
  );
}

async function insertLedgerEntry(client, {
  id = `ledger_${randomUUID()}`,
  kind,
  accountId = "dev",
  amountUsd,
  source = "",
  note = "",
  createdBy = "system",
  conversationId = null,
  modelRunId = null,
  provider = "",
  model = "",
  mode = "",
  responseId = "",
  inputTokens = 0,
  promptCacheHitTokens = 0,
  promptCacheMissTokens = 0,
  cacheUsageReported = false,
  cacheSavingsUsd = 0,
  costSource = "",
  providerCostUsd = null,
  outputTokens = 0,
  totalTokens = 0,
  webSearchCalls = 0,
  toolCostUsd = 0,
  uniqueKey = "",
  metadata = {},
  onConflictUnique = false,
}) {
  const normalizedUniqueKey = typeof uniqueKey === "string" ? uniqueKey.trim().slice(0, 180) : "";
  const normalizedAccountId = safeAccountId(accountId || "dev") || "dev";
  const values = [
    id,
    normalizedAccountId,
    kind,
    numeric(amountUsd),
    String(source || "").slice(0, 80),
    String(note || "").slice(0, 240),
    String(createdBy || "system").slice(0, 80),
    conversationId ? safeConversationId(conversationId) : null,
    modelRunId || null,
    provider || null,
    model || null,
    mode || null,
    responseId || null,
    Math.max(0, Number(inputTokens || 0)),
    Math.max(0, Number(promptCacheHitTokens || 0)),
    Math.max(0, Number(promptCacheMissTokens || 0)),
    cacheUsageReported === true,
    numeric(cacheSavingsUsd),
    String(costSource || "").trim().slice(0, 80),
    providerCostUsd === null || providerCostUsd === undefined ? null : numeric(providerCostUsd),
    Math.max(0, Number(outputTokens || 0)),
    Math.max(0, Number(totalTokens || 0)),
    Math.max(0, Number(webSearchCalls || 0)),
    numeric(toolCostUsd),
    normalizedUniqueKey || null,
    jsonValue(metadata),
  ];

  const conflictSql = onConflictUnique
    ? `
      ON CONFLICT (idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING
    `
    : "";
  const inserted = await client.query(
    `
      INSERT INTO billing_ledger_entries (
        id,
        account_id,
        kind,
        amount_usd,
        source,
        note,
        created_by,
        conversation_id,
        model_run_id,
        provider,
        model,
        mode,
        response_id,
        input_tokens,
        prompt_cache_hit_tokens,
        prompt_cache_miss_tokens,
        cache_usage_reported,
        cache_savings_usd,
        cost_source,
        provider_cost_usd,
        output_tokens,
        total_tokens,
        web_search_calls,
        tool_cost_usd,
        idempotency_key,
        metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26
      )
      ${conflictSql}
      RETURNING *
    `,
    values
  );

  if (!inserted.rows[0]) return null;

  await applyBillingProjection(client, {
    accountId: normalizedAccountId,
    kind,
    amountUsd,
  });

  return inserted.rows[0];
}

async function insertChatAttachments(client, attachments = []) {
  if (attachments.length === 0) return [];

  const rows = [];
  for (const attachment of attachments) {
    const inserted = await client.query(
      `
        INSERT INTO chat_attachments (
          id,
          account_id,
          conversation_id,
          message_id,
          ordinal,
          name,
          mime_type,
          kind,
          source,
          size_bytes,
          sha256,
          text_content,
          text_excerpt,
          storage_uri,
          created_at,
          metadata_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16
        )
        RETURNING *
      `,
      [
        attachment.id,
        attachment.accountId,
        attachment.conversationId,
        attachment.messageId,
        attachment.ordinal,
        attachment.name,
        attachment.mimeType || "",
        attachment.kind || "file",
        attachment.source || "",
        attachment.sizeBytes,
        attachment.sha256,
        attachment.textContent,
        attachment.textExcerpt,
        attachment.storageUri,
        attachment.createdAt,
        jsonValue(attachment.metadata),
      ]
    );
    rows.push(inserted.rows[0]);
  }
  return rows;
}

export async function appendUsageCredit(options = {}) {
  if (!useDatabase()) {
    const entry = appendRuntimeUsageCredit(options);
    await recordBillingCreditAppliedEvent({ entry }).catch(() => {});
    return entry;
  }

  const uniqueKey = typeof options.uniqueKey === "string" ? options.uniqueKey.trim().slice(0, 180) : "";
  try {
    const entry = await transaction(async (client) => {
      const row = await insertLedgerEntry(client, {
        id: `ledger_${randomUUID()}_credit`,
        kind: options.kind || "account_credit",
        accountId: options.accountId || "dev",
        amountUsd: options.amountUsd,
        source: options.source || "admin_credit",
        note: options.note || "",
        createdBy: options.createdBy || "system",
        uniqueKey,
        metadata: options.metadata || {},
        onConflictUnique: Boolean(uniqueKey),
      });
      if (row) return publicLedgerEntry(row);
      if (uniqueKey) {
        const existing = await client.query(
          "SELECT * FROM billing_ledger_entries WHERE idempotency_key = $1 LIMIT 1",
          [uniqueKey]
        );
        if (!existing.rows[0]) {
          const error = new Error("billing_idempotency_replay_missing");
          error.status = 500;
          throw error;
        }
        return publicLedgerEntry(existing.rows[0], { idempotentReplay: true });
      }
      const error = new Error("billing_ledger_insert_failed");
      error.status = 500;
      throw error;
    });
    await recordBillingCreditAppliedEvent({ entry }).catch(() => {});
    return entry;
  } catch (error) {
    if (process.env.TASKNODE_POSTGRES_STRICT === "false") {
      const entry = appendRuntimeUsageCredit(options);
      await recordBillingCreditAppliedEvent({ entry }).catch(() => {});
      return entry;
    }
    throw error;
  }
}

export async function hasUsageCreditForSource({
  accountId = "",
  source = "",
  metadata = {},
  uniqueKeyPrefix = "",
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedSource = String(source || "").trim().slice(0, 80);
  const prefix = String(uniqueKeyPrefix || "").trim().slice(0, 180);
  const metadataEntries = Object.entries(metadata).filter(([, value]) => value);
  if (!normalizedAccountId || !normalizedSource) return false;

  if (!useDatabase()) {
    const ledger = runtimeUsageLedger({ accountId: normalizedAccountId, limit: maxLedgerLimit });
    return (ledger.entries || []).some((entry) => {
      if (entry.source !== normalizedSource) return false;
      if (prefix && String(entry.uniqueKey || "").startsWith(prefix)) return true;
      return metadataEntries.every(([key, value]) => String(entry.metadata?.[key] || "") === String(value));
    });
  }

  const clauses = ["account_id = $1", "source = $2", "kind = ANY($3)"];
  const params = [normalizedAccountId, normalizedSource, Array.from(creditKinds)];
  if (prefix || metadataEntries.length > 0) {
    const identityClauses = [];
    if (prefix) {
      params.push(`${prefix}%`);
      identityClauses.push(`idempotency_key LIKE $${params.length}`);
    }
    for (const [key, value] of metadataEntries) {
      params.push(key, String(value));
      identityClauses.push(`metadata_json ->> $${params.length - 1} = $${params.length}`);
    }
    clauses.push(`(${identityClauses.join(" OR ")})`);
  }

  const result = await query(
    `SELECT 1 FROM billing_ledger_entries WHERE ${clauses.join(" AND ")} LIMIT 1`,
    params
  );
  return Boolean(result.rows[0]);
}

export async function appendChatTurn({
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
  runMetadata = {},
  conversationStatus = "active",
  attachments = [],
  usage,
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  assertConversationIdAccountBoundary({
    accountId: normalizedAccountId,
    conversationId: normalizedConversationId,
  });

  if (!useDatabase()) {
    return appendRuntimeChatTurn({
      accountId: normalizedAccountId,
      conversationId: normalizedConversationId,
      mode,
      provider,
      model,
      responseId,
      userMessage,
      assistantMessage,
      userMessageId,
      assistantMessageId,
      userMetadata,
      assistantMetadata,
      runMetadata,
      attachments,
      usage,
    });
  }

  const now = new Date();
  const userId = typeof userMessageId === "string" && userMessageId.trim()
    ? userMessageId.trim().slice(0, 180)
    : `msg_${randomUUID()}_user`;
  const assistantId = typeof assistantMessageId === "string" && assistantMessageId.trim()
    ? assistantMessageId.trim().slice(0, 180)
    : `msg_${randomUUID()}_assistant`;
  const modelRunId = `run_${randomUUID()}`;
  const costUsd = numeric(usage?.costUsd || 0);
  const cacheUsage = cacheUsageFields(usage);
  const preview = messagePreview(assistantMessage) || messagePreview(userMessage);
  const status = conversationStatusForInsert(conversationStatus);

  try {
    const persisted = await transaction(async (client) => {
      const existing = await client.query(
        "SELECT id, account_id FROM chat_conversations WHERE id = $1 FOR UPDATE",
        [normalizedConversationId]
      );
      const owner = existing.rows[0]?.account_id || "";
      if (existing.rows[0] && owner !== normalizedAccountId) {
        const error = new Error("chat_conversation_not_found");
        error.status = 404;
        throw error;
      }

      await client.query(
        `
          INSERT INTO chat_conversations (
            id,
            account_id,
            title,
            status,
            mode,
            created_at,
            updated_at,
            last_message_at,
            last_message_preview,
            message_count
          )
          VALUES ($1, $2, $3, $7, $4, $5, $5, $5, $6, 2)
          ON CONFLICT (id) DO UPDATE SET
            account_id = EXCLUDED.account_id,
            status = EXCLUDED.status,
            title = CASE
              WHEN chat_conversations.title IS NULL
                OR chat_conversations.title = ''
                OR chat_conversations.title = 'New chat'
              THEN EXCLUDED.title
              ELSE chat_conversations.title
            END,
            mode = COALESCE(chat_conversations.mode, EXCLUDED.mode),
            updated_at = EXCLUDED.updated_at,
            last_message_at = EXCLUDED.last_message_at,
            last_message_preview = EXCLUDED.last_message_preview,
            message_count = chat_conversations.message_count + 2,
            deleted_at = NULL
        `,
        [
          normalizedConversationId,
          normalizedAccountId,
          titleFromPrompt(userMessage),
          mode || null,
          now,
          preview,
          status,
        ]
      );

      const userInsert = await client.query(
        `
          INSERT INTO chat_messages (
            id,
            conversation_id,
            account_id,
            role,
            body,
            mode,
            created_at,
            metadata_json
          )
          VALUES ($1, $2, $3, 'user', $4, $5, $6, $7)
          RETURNING *
        `,
        [
          userId,
          normalizedConversationId,
          normalizedAccountId,
          String(userMessage || ""),
          mode || null,
          now,
          jsonValue(userMetadata),
        ]
      );
      const attachmentRows = await insertChatAttachments(client, attachmentRowsForInsert({
        attachments,
        accountId: normalizedAccountId,
        conversationId: normalizedConversationId,
        messageId: userId,
        createdAt: now,
      }));
      const assistantInsert = await client.query(
        `
          INSERT INTO chat_messages (
            id,
            conversation_id,
            account_id,
            role,
            body,
            mode,
            provider,
            model,
            response_id,
            created_at,
            metadata_json
          )
          VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7, $8, $9, $10)
          RETURNING *
        `,
        [
          assistantId,
          normalizedConversationId,
          normalizedAccountId,
          String(assistantMessage || ""),
          mode || null,
          provider || null,
          model || null,
          responseId || null,
          now,
          jsonValue(assistantMetadata),
        ]
      );

      await client.query(
        `
          INSERT INTO chat_model_runs (
            id,
            conversation_id,
            account_id,
            request_message_id,
            response_message_id,
            provider,
            model,
            mode,
            response_id,
            status,
            input_tokens,
            prompt_cache_hit_tokens,
            prompt_cache_miss_tokens,
            cache_usage_reported,
            cache_savings_usd,
            cost_source,
            provider_cost_usd,
            output_tokens,
            total_tokens,
            web_search_calls,
            tool_cost_usd,
            model_cost_usd,
            total_cost_usd,
            started_at,
            completed_at,
            metadata_json
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, 'completed',
            $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
            $20, $21, $22, $23, $23, $24
          )
        `,
        [
          modelRunId,
          normalizedConversationId,
          normalizedAccountId,
          userId,
          assistantId,
          provider || "",
          model || "",
          mode || "",
          responseId || null,
          Math.max(0, Number(usage?.inputTokens || 0)),
          cacheUsage.promptCacheHitTokens,
          cacheUsage.promptCacheMissTokens,
          cacheUsage.cacheUsageReported,
          cacheUsage.cacheSavingsUsd,
          cacheUsage.costSource,
          cacheUsage.providerCostUsd,
          Math.max(0, Number(usage?.outputTokens || 0)),
          Math.max(0, Number(usage?.totalTokens || 0)),
          Math.max(0, Number(usage?.webSearchCalls || 0)),
          numeric(usage?.toolCostUsd || 0),
          costUsd,
          costUsd,
          now,
          jsonValue(runMetadata),
        ]
      );

      let ledgerEntry = null;
      if (costUsd > 0) {
        const row = await insertLedgerEntry(client, {
          id: `ledger_${randomUUID()}`,
          kind: "chat_debit",
          accountId: normalizedAccountId,
          amountUsd: costUsd,
          source: "chat_model_run",
          conversationId: normalizedConversationId,
          modelRunId,
          provider,
          model,
          mode,
          responseId,
          inputTokens: usage?.inputTokens || 0,
          ...cacheUsage,
          outputTokens: usage?.outputTokens || 0,
          totalTokens: usage?.totalTokens || 0,
          webSearchCalls: usage?.webSearchCalls || 0,
          toolCostUsd: usage?.toolCostUsd || 0,
        });
        ledgerEntry = publicLedgerEntry(row);
      }

      return {
        user: publicMessage(userInsert.rows[0], attachmentRows.map(publicAttachment)),
        assistant: publicMessage(assistantInsert.rows[0]),
        ledgerEntry,
        modelRunId,
      };
    });
    await recordChatTurnObservability({
      accountId: normalizedAccountId,
      conversationId: normalizedConversationId,
      mode,
      provider,
      model,
      responseId,
      modelRunId,
      user: persisted.user,
      assistant: persisted.assistant,
      usage,
      ledgerEntry: persisted.ledgerEntry,
    }).catch(() => {});
    return persisted;
  } catch (error) {
    if (error?.code === "23505" && userMessageId && assistantMessageId) {
      const existingMessages = await getChatMessages({
        accountId: normalizedAccountId,
        conversationId: normalizedConversationId,
        limit: 30,
      }).catch(() => []);
      const user = existingMessages.find((message) => message.id === userMessageId && message.role === "user");
      const assistant = existingMessages.find((message) => message.id === assistantMessageId && message.role === "assistant");
      if (user && assistant) {
        return {
          user,
          assistant,
          ledgerEntry: null,
          modelRunId: "",
          idempotentReplay: true,
        };
      }
    }
    if (process.env.TASKNODE_POSTGRES_STRICT === "false") {
      const persisted = appendRuntimeChatTurn({
        accountId,
        conversationId,
        mode,
        provider,
        model,
        responseId,
        userMessage,
        assistantMessage,
        userMessageId,
        assistantMessageId,
        userMetadata,
        assistantMetadata,
        runMetadata,
        attachments,
        usage,
      });
      await recordChatTurnObservability({
        accountId: normalizedAccountId,
        conversationId: normalizedConversationId,
        mode,
        provider,
        model,
        responseId,
        user: persisted.user,
        assistant: persisted.assistant,
        usage,
        ledgerEntry: persisted.ledgerEntry,
      }).catch(() => {});
      return persisted;
    }
    throw error;
  }
}

export async function recordBillableModelRun({
  accountId = "",
  conversationId = "dev",
  requestMessageId = "",
  responseMessageId = "",
  provider = "",
  model = "",
  mode = "",
  responseId = "",
  status = "completed",
  usage = {},
  source = "chat_model_run",
  note = "",
  metadata = {},
  error = "",
  uniqueKey = "",
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  assertConversationIdAccountBoundary({
    accountId: normalizedAccountId,
    conversationId: normalizedConversationId,
  });
  const modelRunId = `run_${randomUUID()}`;
  const startedAt = new Date();
  const completedAt = status === "completed" || status === "failed" ? new Date() : null;
  const costUsd = numeric(usage?.costUsd || 0);
  const cacheUsage = cacheUsageFields(usage);
  const inputTokens = Math.max(0, Number(usage?.inputTokens || 0));
  const outputTokens = Math.max(0, Number(usage?.outputTokens || 0));
  const totalTokens = Math.max(0, Number(usage?.totalTokens || inputTokens + outputTokens || 0));
  const webSearchCalls = Math.max(0, Number(usage?.webSearchCalls || 0));
  const toolCostUsd = numeric(usage?.toolCostUsd || 0);

  if (!useDatabase()) {
    return {
      modelRunId,
      ledgerEntry: null,
      skipped: true,
      reason: "database_not_configured",
    };
  }

  const persisted = await transaction(async (client) => {
    await client.query(
      `
        INSERT INTO chat_model_runs (
          id,
          conversation_id,
          account_id,
          request_message_id,
          response_message_id,
          provider,
          model,
          mode,
          response_id,
          status,
          input_tokens,
          prompt_cache_hit_tokens,
          prompt_cache_miss_tokens,
          cache_usage_reported,
          cache_savings_usd,
          cost_source,
          provider_cost_usd,
          output_tokens,
          total_tokens,
          web_search_calls,
          tool_cost_usd,
          model_cost_usd,
          total_cost_usd,
          started_at,
          completed_at,
          error,
          metadata_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27
        )
      `,
      [
        modelRunId,
        normalizedConversationId,
        normalizedAccountId,
        String(requestMessageId || "").slice(0, 180) || `context_rewrite_request_${modelRunId}`,
        String(responseMessageId || "").slice(0, 180) || `context_rewrite_response_${modelRunId}`,
        String(provider || "").slice(0, 80),
        String(model || "").slice(0, 180),
        String(mode || "").slice(0, 80),
        responseId || null,
        String(status || "completed").slice(0, 80),
        inputTokens,
        cacheUsage.promptCacheHitTokens,
        cacheUsage.promptCacheMissTokens,
        cacheUsage.cacheUsageReported,
        cacheUsage.cacheSavingsUsd,
        cacheUsage.costSource,
        cacheUsage.providerCostUsd,
        outputTokens,
        totalTokens,
        webSearchCalls,
        toolCostUsd,
        costUsd,
        costUsd + toolCostUsd,
        startedAt,
        completedAt,
        String(error || "").slice(0, 1000) || null,
        jsonValue(metadata),
      ]
    );

    let ledgerEntry = null;
    if (costUsd + toolCostUsd > 0 && String(status || "completed") === "completed") {
      const row = await insertLedgerEntry(client, {
        id: `ledger_${randomUUID()}`,
        kind: "chat_debit",
        accountId: normalizedAccountId,
        amountUsd: costUsd + toolCostUsd,
        source,
        note,
        conversationId: normalizedConversationId,
        modelRunId,
        provider,
        model,
        mode,
        responseId,
        inputTokens,
        ...cacheUsage,
        outputTokens,
        totalTokens,
        webSearchCalls,
        toolCostUsd,
        uniqueKey,
        metadata,
        onConflictUnique: Boolean(uniqueKey),
      });
      ledgerEntry = publicLedgerEntry(row);
    }

    return {
      modelRunId,
      ledgerEntry,
    };
  });

  return persisted;
}
