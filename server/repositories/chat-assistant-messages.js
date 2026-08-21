import { randomUUID } from "node:crypto";
import { databaseEnabled, transaction } from "../db/pool.js";

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
  const normalizedConversationId = safeConversationId(conversationId);
  if (!normalizedConversationId.startsWith("account_")) return;

  const conversationAccountId = safeConversationAccountId(accountId);
  const accountPrefix = conversationAccountId ? `account_${conversationAccountId}_` : "";
  if (!accountPrefix || !normalizedConversationId.startsWith(accountPrefix)) {
    throw chatConversationNotFound();
  }
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function messagePreview(message = "") {
  return String(message || "").trim().replace(/\s+/g, " ").slice(0, 140);
}

function jsonValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function publicMessage(row = {}) {
  const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  const message = {
    id: row.id,
    role: row.role,
    body: row.body,
    createdAt: toIso(row.created_at),
    mode: row.mode || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    responseId: row.response_id || undefined,
  };
  if (Object.keys(metadata).length > 0) message.metadata = metadata;
  return message;
}

export async function appendAssistantMessage({
  accountId = "",
  conversationId = "dev",
  mode,
  provider,
  model,
  responseId,
  assistantMessage,
  assistantMessageId = "",
  assistantMetadata = {},
} = {}) {
  if (!databaseEnabled()) {
    const error = new Error("database_not_configured");
    error.status = 503;
    throw error;
  }

  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  assertConversationIdAccountBoundary({
    accountId: normalizedAccountId,
    conversationId: normalizedConversationId,
  });

  const now = new Date();
  const assistantId = typeof assistantMessageId === "string" && assistantMessageId.trim()
    ? assistantMessageId.trim().slice(0, 180)
    : `msg_${randomUUID()}_assistant`;

  return transaction(async (client) => {
    const existing = await client.query(
      "SELECT id, account_id, status FROM chat_conversations WHERE id = $1 FOR UPDATE",
      [normalizedConversationId]
    );
    const row = existing.rows[0];
    if (!row || row.status !== "active" || row.account_id !== normalizedAccountId) {
      throw chatConversationNotFound();
    }

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
        UPDATE chat_conversations
        SET updated_at = $2,
            last_message_at = $2,
            last_message_preview = $3,
            message_count = message_count + 1,
            deleted_at = NULL
        WHERE id = $1
      `,
      [normalizedConversationId, now, messagePreview(assistantMessage)]
    );

    return {
      assistant: publicMessage(assistantInsert.rows[0]),
    };
  });
}
