import { createHash, randomUUID } from "node:crypto";
import {
  appendChatTurn as appendRuntimeChatTurn,
  appendUsageCredit as appendRuntimeUsageCredit,
  deleteChatConversation as deleteRuntimeChatConversation,
  getChatMessages as getRuntimeChatMessages,
  listChatConversations as listRuntimeChatConversations,
  renameChatConversation as renameRuntimeChatConversation,
  usageLedger as runtimeUsageLedger,
  usageSummary as runtimeUsageSummary,
} from "../runtime-store.js";
import {
  decodeTextDataUrl,
  normalizeChatAttachments,
} from "../chat-attachment-utils.js";
import { databaseEnabled, databaseStatus, query, transaction } from "../db/pool.js";

const creditKinds = new Set(["account_credit", "top_up_credit", "reward_credit", "refund_credit"]);
const maxLedgerLimit = 200;
const maxConversationLimit = 100;
const maxMessageLimit = 200;

function useDatabase() {
  return databaseEnabled();
}

export function chatBillingStatus() {
  return databaseStatus();
}

function safeAccountId(accountId = "") {
  return String(accountId || "").trim().slice(0, 160);
}

function safeConversationId(conversationId = "dev") {
  return String(conversationId || "dev").trim().slice(0, 180) || "dev";
}

function cleanTitle(title = "") {
  return String(title || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function titleFromPrompt(prompt = "") {
  return cleanTitle(prompt).slice(0, 64) || "New chat";
}

function messagePreview(message = "") {
  return String(message || "").trim().replace(/\s+/g, " ").slice(0, 140);
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
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

function publicMessage(row, attachments = []) {
  const message = {
    id: row.id,
    role: row.role,
    body: row.body,
    createdAt: toIso(row.created_at || row.createdAt),
    mode: row.mode || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    responseId: row.response_id || row.responseId || undefined,
  };
  if (attachments.length > 0) message.attachments = attachments;
  return message;
}

function publicAttachment(row) {
  const attachment = {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type || undefined,
    kind: row.kind || undefined,
    source: row.source || undefined,
    size: Number(row.size_bytes || 0),
    sha256: row.sha256 || undefined,
    textExcerpt: row.text_excerpt || undefined,
    storageUri: row.storage_uri || undefined,
    createdAt: toIso(row.created_at),
  };
  if (typeof row.text_content === "string" && row.text_content.length > 0) {
    attachment.textContent = row.text_content;
  }
  return attachment;
}

function publicConversation(row) {
  return {
    id: row.id,
    conversationId: row.id,
    title: row.title || "New chat",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    lastMessageAt: toIso(row.last_message_at || row.updated_at),
    lastMessagePreview: row.last_message_preview || "",
    messageCount: Number(row.message_count || 0),
  };
}

function publicLedgerEntry(row, extra = {}) {
  if (!row) return null;
  const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.account_id || "",
    conversationId: row.conversation_id || undefined,
    source: row.source || undefined,
    amountUsd: numeric(row.amount_usd),
    note: row.note || undefined,
    createdBy: row.created_by || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    mode: row.mode || undefined,
    responseId: row.response_id || undefined,
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
    webSearchCalls: Number(row.web_search_calls || 0),
    toolCostUsd: numeric(row.tool_cost_usd),
    uniqueKey: row.idempotency_key || undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    createdAt: toIso(row.created_at),
    ...extra,
  };
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
        output_tokens,
        total_tokens,
        web_search_calls,
        tool_cost_usd,
        idempotency_key,
        metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
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
  if (!useDatabase()) return appendRuntimeUsageCredit(options);

  const uniqueKey = typeof options.uniqueKey === "string" ? options.uniqueKey.trim().slice(0, 180) : "";
  try {
    return await transaction(async (client) => {
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
  } catch (error) {
    if (process.env.TASKNODE_POSTGRES_STRICT === "false") {
      return appendRuntimeUsageCredit(options);
    }
    throw error;
  }
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
  attachments = [],
  usage,
} = {}) {
  if (!useDatabase()) {
    return appendRuntimeChatTurn({
      accountId,
      conversationId,
      mode,
      provider,
      model,
      responseId,
      userMessage,
      assistantMessage,
      attachments,
      usage,
    });
  }

  const now = new Date();
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  const userId = `msg_${randomUUID()}_user`;
  const assistantId = `msg_${randomUUID()}_assistant`;
  const modelRunId = `run_${randomUUID()}`;
  const costUsd = numeric(usage?.costUsd || 0);
  const preview = messagePreview(assistantMessage) || messagePreview(userMessage);

  try {
    return await transaction(async (client) => {
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
          VALUES ($1, $2, $3, 'active', $4, $5, $5, $5, $6, 2)
          ON CONFLICT (id) DO UPDATE SET
            account_id = EXCLUDED.account_id,
            status = 'active',
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
            created_at
          )
          VALUES ($1, $2, $3, 'user', $4, $5, $6)
          RETURNING *
        `,
        [userId, normalizedConversationId, normalizedAccountId, String(userMessage || ""), mode || null, now]
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
            created_at
          )
          VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7, $8, $9)
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
            output_tokens,
            total_tokens,
            web_search_calls,
            tool_cost_usd,
            model_cost_usd,
            total_cost_usd,
            started_at,
            completed_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, 'completed',
            $10, $11, $12, $13, $14, $15, $16, $17, $17
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
          Math.max(0, Number(usage?.outputTokens || 0)),
          Math.max(0, Number(usage?.totalTokens || 0)),
          Math.max(0, Number(usage?.webSearchCalls || 0)),
          numeric(usage?.toolCostUsd || 0),
          costUsd,
          costUsd,
          now,
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
      };
    });
  } catch (error) {
    if (process.env.TASKNODE_POSTGRES_STRICT === "false") {
      return appendRuntimeChatTurn({
        accountId,
        conversationId,
        mode,
        provider,
        model,
        responseId,
        userMessage,
        assistantMessage,
        attachments,
        usage,
      });
    }
    throw error;
  }
}

export async function getChatMessages(conversationId = "dev", { limit = 30 } = {}) {
  if (!useDatabase()) return getRuntimeChatMessages(conversationId);

  const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), maxMessageLimit);
  try {
    const rows = await query(
      `
        SELECT *
        FROM chat_messages
        WHERE conversation_id = $1
        ORDER BY message_order DESC
        LIMIT $2
      `,
      [safeConversationId(conversationId), normalizedLimit]
    );
    const orderedMessages = rows.rows.reverse();
    const messageIds = orderedMessages.map((row) => row.id);
    const attachmentsByMessage = new Map();
    if (messageIds.length > 0) {
      const attachmentRows = await query(
        `
          SELECT *
          FROM chat_attachments
          WHERE message_id = ANY($1::text[])
          ORDER BY message_id ASC, ordinal ASC
        `,
        [messageIds]
      );
      for (const row of attachmentRows.rows) {
        const existing = attachmentsByMessage.get(row.message_id) || [];
        existing.push(publicAttachment(row));
        attachmentsByMessage.set(row.message_id, existing);
      }
    }
    return orderedMessages.map((row) => publicMessage(row, attachmentsByMessage.get(row.id) || []));
  } catch (error) {
    if (process.env.TASKNODE_POSTGRES_STRICT === "false") {
      return getRuntimeChatMessages(conversationId);
    }
    throw error;
  }
}

export async function listChatConversations({ accountId = "", limit = 30 } = {}) {
  if (!useDatabase()) return listRuntimeChatConversations({ accountId, limit });

  const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), maxConversationLimit);
  const normalizedAccountId = safeAccountId(accountId);
  try {
    const rows = await query(
      `
        SELECT *
        FROM chat_conversations
        WHERE account_id = $1
          AND status = 'active'
        ORDER BY updated_at DESC, id DESC
        LIMIT $2
      `,
      [normalizedAccountId, normalizedLimit]
    );
    return rows.rows.map(publicConversation);
  } catch (error) {
    if (process.env.TASKNODE_POSTGRES_STRICT === "false") {
      return listRuntimeChatConversations({ accountId, limit });
    }
    throw error;
  }
}

export async function renameChatConversation({ accountId = "", conversationId = "", title = "" } = {}) {
  if (!useDatabase()) return renameRuntimeChatConversation({ accountId, conversationId, title });

  const normalizedTitle = cleanTitle(title);
  if (!normalizedTitle) return { ok: false, status: 400, error: "chat_title_required" };

  const rows = await query(
    `
      UPDATE chat_conversations
      SET title = $3,
          updated_at = now()
      WHERE id = $1
        AND account_id = $2
        AND status = 'active'
      RETURNING *
    `,
    [safeConversationId(conversationId), safeAccountId(accountId), normalizedTitle]
  );
  if (!rows.rows[0]) return { ok: false, status: 404, error: "chat_conversation_not_found" };

  return {
    ok: true,
    conversation: publicConversation(rows.rows[0]),
  };
}

export async function deleteChatConversation({ accountId = "", conversationId = "" } = {}) {
  if (!useDatabase()) return deleteRuntimeChatConversation({ accountId, conversationId });

  const rows = await query(
    `
      UPDATE chat_conversations
      SET status = 'deleted',
          deleted_at = now(),
          updated_at = now()
      WHERE id = $1
        AND account_id = $2
        AND status = 'active'
      RETURNING *
    `,
    [safeConversationId(conversationId), safeAccountId(accountId)]
  );
  if (!rows.rows[0]) return { ok: false, status: 404, error: "chat_conversation_not_found" };

  return {
    ok: true,
    conversationId: rows.rows[0].id,
  };
}

async function aggregateUsage({ accountId = "", conversationId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = conversationId ? safeConversationId(conversationId) : "";
  let where = "";
  let params = [];

  if (normalizedAccountId) {
    where = "WHERE account_id = $1";
    params = [normalizedAccountId];
  } else if (normalizedConversationId) {
    where = "WHERE conversation_id = $1";
    params = [normalizedConversationId];
  }

  const result = await query(
    `
      SELECT
        COALESCE(SUM(CASE WHEN kind = 'chat_debit' THEN amount_usd ELSE 0 END), 0) AS spend,
        COALESCE(SUM(CASE
          WHEN kind IN ('account_credit', 'top_up_credit', 'reward_credit', 'refund_credit')
            THEN amount_usd
          WHEN kind = 'admin_adjustment' AND amount_usd > 0
            THEN amount_usd
          ELSE 0
        END), 0) AS credit,
        COUNT(*)::integer AS count
      FROM billing_ledger_entries
      ${where}
    `,
    params
  );
  const row = result.rows[0] || {};
  return {
    currentSpendUsd: numeric(row.spend),
    currentCreditUsd: numeric(row.credit),
    ledgerEntryCount: Number(row.count || 0),
  };
}

export async function usageSummary(scope = {}) {
  if (!useDatabase()) return runtimeUsageSummary(scope);

  const normalizedAccountId = safeAccountId(scope.accountId);
  if (normalizedAccountId) {
    const result = await query(
      "SELECT * FROM billing_accounts WHERE account_id = $1 LIMIT 1",
      [normalizedAccountId]
    );
    const row = result.rows[0];
    if (row) {
      const currentSpendUsd = numeric(row.current_spend_usd);
      const currentCreditUsd = numeric(row.current_credit_usd);
      return {
        currentSpendUsd,
        currentCreditUsd,
        availableCreditUsd: Number(Math.max(0, currentCreditUsd - currentSpendUsd).toFixed(6)),
        ledgerEntryCount: Number(row.ledger_entry_count || 0),
        durable: true,
        storePath: "postgres",
      };
    }
    return {
      currentSpendUsd: 0,
      currentCreditUsd: 0,
      availableCreditUsd: 0,
      ledgerEntryCount: 0,
      durable: true,
      storePath: "postgres",
    };
  }

  const aggregate = await aggregateUsage(scope);
  return {
    ...aggregate,
    availableCreditUsd: Number(Math.max(0, aggregate.currentCreditUsd - aggregate.currentSpendUsd).toFixed(6)),
    durable: true,
    storePath: "postgres",
  };
}

export async function usageLedger({ accountId, conversationId, limit = 50 } = {}) {
  if (!useDatabase()) return runtimeUsageLedger({ accountId, conversationId, limit });

  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), maxLedgerLimit);
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = conversationId ? safeConversationId(conversationId) : "";
  let where = "";
  let params = [];

  if (normalizedAccountId) {
    where = "WHERE account_id = $1";
    params = [normalizedAccountId, normalizedLimit];
  } else if (normalizedConversationId) {
    where = "WHERE conversation_id = $1";
    params = [normalizedConversationId, normalizedLimit];
  } else {
    params = [normalizedLimit];
  }

  const rows = await query(
    `
      SELECT *
      FROM billing_ledger_entries
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );
  const summary = await usageSummary({ accountId: normalizedAccountId, conversationId: normalizedConversationId });

  return {
    billingModel: "usage_based",
    currency: "USD",
    accountId: normalizedAccountId || null,
    conversationId: normalizedConversationId || null,
    currentSpendUsd: summary.currentSpendUsd,
    currentCreditUsd: summary.currentCreditUsd,
    availableCreditUsd: summary.availableCreditUsd,
    ledgerEntryCount: summary.ledgerEntryCount,
    durable: summary.durable,
    entries: rows.rows.map(publicLedgerEntry),
  };
}
