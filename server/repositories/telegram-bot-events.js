import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";
import {
  listRuntimeTelegramBotEvents,
  recordRuntimeTelegramBotEvent,
} from "../runtime-store.js";

const directions = new Set(["inbound", "outbound", "internal"]);

function safeText(value = "", max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeJsonObject(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeEvent(event = {}) {
  return {
    id: safeText(event.id || `tgbe_${randomUUID()}`, 120),
    eventType: safeText(event.eventType || event.event_type || "event", 120),
    direction: directions.has(event.direction) ? event.direction : "internal",
    accountId: safeText(event.accountId || event.account_id || "", 160),
    providerUserId: safeText(event.providerUserId || event.provider_user_id || "", 160),
    chatId: safeText(event.chatId || event.chat_id || "", 160),
    updateId: safeText(event.updateId || event.update_id || "", 160),
    messageId: safeText(event.messageId || event.message_id || "", 160),
    action: safeText(event.action || "", 160),
    mode: safeText(event.mode || "", 80),
    status: safeText(event.status || "", 80),
    error: safeText(event.error || "", 500),
    textPreview: safeText(event.textPreview || event.text_preview || "", 500),
    metadata: safeJsonObject(event.metadata),
    createdAt: event.createdAt || event.created_at || new Date().toISOString(),
  };
}

function rowToEvent(row = {}) {
  return {
    id: row.id,
    eventType: row.event_type,
    direction: row.direction,
    accountId: row.account_id,
    providerUserId: row.provider_user_id,
    chatId: row.chat_id,
    updateId: row.update_id,
    messageId: row.message_id,
    action: row.action,
    mode: row.mode,
    status: row.status,
    error: row.error,
    textPreview: row.text_preview,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

export async function recordTelegramBotEvent(event = {}) {
  const normalized = normalizeEvent(event);
  if (databaseEnabled()) {
    try {
      await query(
        `INSERT INTO telegram_bot_events (
           id, event_type, direction, account_id, provider_user_id, chat_id,
           update_id, message_id, action, mode, status, error, text_preview,
           metadata, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12, $13,
           $14::jsonb, $15
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          normalized.id,
          normalized.eventType,
          normalized.direction,
          normalized.accountId,
          normalized.providerUserId,
          normalized.chatId,
          normalized.updateId,
          normalized.messageId,
          normalized.action,
          normalized.mode,
          normalized.status,
          normalized.error,
          normalized.textPreview,
          JSON.stringify(normalized.metadata),
          normalized.createdAt,
        ]
      );
      return { ok: true, event: normalized, durable: true };
    } catch (error) {
      console.warn(`telegram bot event database write failed: ${error?.message || error}`);
    }
  }

  return recordRuntimeTelegramBotEvent(normalized);
}

export async function listTelegramBotEvents({
  accountId = "",
  providerUserId = "",
  chatId = "",
  limit = 50,
} = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const normalizedAccountId = safeText(accountId, 160);
  const normalizedProviderUserId = safeText(providerUserId, 160);
  const normalizedChatId = safeText(chatId, 160);

  if (databaseEnabled()) {
    const rows = await query(
      `SELECT *
         FROM telegram_bot_events
        WHERE ($1 = '' OR account_id = $1)
          AND ($2 = '' OR provider_user_id = $2)
          AND ($3 = '' OR chat_id = $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [normalizedAccountId, normalizedProviderUserId, normalizedChatId, boundedLimit]
    );
    return { ok: true, events: rows.rows.map(rowToEvent), durable: true };
  }

  return listRuntimeTelegramBotEvents({
    accountId: normalizedAccountId,
    providerUserId: normalizedProviderUserId,
    chatId: normalizedChatId,
    limit: boundedLimit,
  });
}
