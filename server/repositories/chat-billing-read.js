import {
  getChatMessages as getRuntimeChatMessages,
  usageLedger as runtimeUsageLedger,
  usageSummary as runtimeUsageSummary,
} from "../runtime-store.js";
import { databaseEnabled, query } from "../db/pool.js";
import { hydrateContextEditProposalMetadata } from "./context-edit-chat-metadata.js";
import {
  publicBillingLedgerEntry,
  publicChatAttachment,
  publicChatMessage,
} from "./chat-billing-projections.js";
import {
  getLegacyChatMessages,
  legacyConversationReadable,
} from "./legacy-pftasks-history.js";

const maxLedgerLimit = 200;
const maxMessageLimit = 200;

const safeAccountId = (accountId = "") => String(accountId || "").trim().slice(0, 160);
const safeConversationId = (conversationId = "dev") =>
  String(conversationId || "dev").trim().slice(0, 180) || "dev";

function safeConversationAccountId(accountId = "") {
  return String(accountId || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function chatMessagesArgs(input = "dev", options = {}) {
  if (typeof input === "string") {
    return { accountId: options.accountId || "", conversationId: input, limit: options.limit };
  }
  return {
    accountId: input?.accountId || "",
    conversationId: input?.conversationId || "dev",
    limit: input?.limit,
  };
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

async function assertChatConversationReadable({ accountId = "", conversationId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  assertConversationIdAccountBoundary({ accountId: normalizedAccountId, conversationId: normalizedConversationId });
  const conversation = await query(
    "SELECT account_id, status FROM chat_conversations WHERE id = $1",
    [normalizedConversationId]
  );
  const row = conversation.rows[0];
  if (!row) {
    return (await legacyConversationReadable({
      accountId: normalizedAccountId,
      conversationId: normalizedConversationId,
    })) ? "legacy" : "new";
  }
  if (row.status !== "active" || (row.account_id || "") !== normalizedAccountId) {
    throw chatConversationNotFound();
  }
  return "current";
}

async function chatConversationHistoryReadableForWrite({ accountId = "", conversationId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  assertConversationIdAccountBoundary({ accountId: normalizedAccountId, conversationId: normalizedConversationId });
  const conversation = await query(
    "SELECT account_id, status FROM chat_conversations WHERE id = $1",
    [normalizedConversationId]
  );
  const row = conversation.rows[0];
  if (!row) {
    if (await legacyConversationReadable({
      accountId: normalizedAccountId,
      conversationId: normalizedConversationId,
    })) {
      const error = new Error("chat_conversation_read_only");
      error.status = 409;
      throw error;
    }
    return true;
  }
  if ((row.account_id || "") !== normalizedAccountId) throw chatConversationNotFound();
  return row.status === "active";
}

async function hydratedMessages({ normalizedAccountId, normalizedConversationId, normalizedLimit }) {
  const rows = await query(
    `SELECT * FROM chat_messages
      WHERE conversation_id = $1 AND account_id = $3
      ORDER BY message_order DESC LIMIT $2`,
    [normalizedConversationId, normalizedLimit, normalizedAccountId]
  );
  const orderedMessages = await hydrateContextEditProposalMetadata(rows.rows.reverse(), normalizedAccountId);
  const messageIds = orderedMessages.map((row) => row.id);
  const attachmentsByMessage = new Map();
  if (messageIds.length > 0) {
    const attachmentRows = await query(
      `SELECT * FROM chat_attachments
        WHERE message_id = ANY($1::text[])
        ORDER BY message_id ASC, ordinal ASC`,
      [messageIds]
    );
    for (const row of attachmentRows.rows) {
      const existing = attachmentsByMessage.get(row.message_id) || [];
      existing.push(publicChatAttachment(row));
      attachmentsByMessage.set(row.message_id, existing);
    }
  }
  return orderedMessages.map((row) => publicChatMessage(row, attachmentsByMessage.get(row.id) || []));
}

async function getMessages(input, options, { forWrite = false } = {}) {
  const { accountId, conversationId, limit = 30 } = chatMessagesArgs(input, options);
  const normalizedLimit = Math.min(Math.max(Number(limit) || 30, 1), maxMessageLimit);
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  assertConversationIdAccountBoundary({ accountId: normalizedAccountId, conversationId: normalizedConversationId });
  if (!databaseEnabled()) return getRuntimeChatMessages(normalizedConversationId).slice(-normalizedLimit);
  try {
    if (forWrite) {
      const readable = await chatConversationHistoryReadableForWrite({
        accountId: normalizedAccountId,
        conversationId: normalizedConversationId,
      });
      if (!readable) return [];
    } else {
      const source = await assertChatConversationReadable({
        accountId: normalizedAccountId,
        conversationId: normalizedConversationId,
      });
      if (source === "legacy") {
        return getLegacyChatMessages({
          accountId: normalizedAccountId,
          conversationId: normalizedConversationId,
          limit: normalizedLimit,
        });
      }
    }
    return await hydratedMessages({ normalizedAccountId, normalizedConversationId, normalizedLimit });
  } catch (error) {
    if (error?.message === "chat_conversation_not_found") throw error;
    if (process.env.TASKNODE_POSTGRES_STRICT === "false") {
      return getRuntimeChatMessages(normalizedConversationId).slice(-normalizedLimit);
    }
    throw error;
  }
}

export async function getChatMessages(input = "dev", options = {}) {
  return getMessages(input, options);
}

export async function getChatMessagesForWrite(input = "dev", options = {}) {
  return getMessages(input, options, { forWrite: true });
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
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
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'chat_debit' THEN amount_usd ELSE 0 END), 0) AS spend,
       COALESCE(SUM(CASE
         WHEN kind IN ('account_credit', 'top_up_credit', 'reward_credit', 'refund_credit') THEN amount_usd
         WHEN kind = 'admin_adjustment' AND amount_usd > 0 THEN amount_usd
         ELSE 0 END), 0) AS credit,
       COUNT(*)::integer AS count
     FROM billing_ledger_entries ${where}`,
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
  if (!databaseEnabled()) return runtimeUsageSummary(scope);
  const normalizedAccountId = safeAccountId(scope.accountId);
  if (normalizedAccountId) {
    const result = await query("SELECT * FROM billing_accounts WHERE account_id = $1 LIMIT 1", [normalizedAccountId]);
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
  if (!databaseEnabled()) return runtimeUsageLedger({ accountId, conversationId, limit });
  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), maxLedgerLimit);
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = conversationId ? safeConversationId(conversationId) : "";
  if (!normalizedAccountId && !normalizedConversationId) {
    return {
      billingModel: "usage_based",
      currency: "USD",
      accountId: null,
      conversationId: null,
      currentSpendUsd: 0,
      currentCreditUsd: 0,
      availableCreditUsd: 0,
      ledgerEntryCount: 0,
      durable: true,
      entries: [],
    };
  }
  const where = normalizedAccountId ? "WHERE account_id = $1" : "WHERE conversation_id = $1";
  const selector = normalizedAccountId || normalizedConversationId;
  const rows = await query(
    `SELECT * FROM billing_ledger_entries ${where}
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [selector, normalizedLimit]
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
    entries: rows.rows.map(publicBillingLedgerEntry),
  };
}
