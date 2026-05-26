import { randomUUID } from "node:crypto";

function preferenceKey({ accountId = "", chatId = "", safeId }) {
  return `${safeId(accountId, "account")}:${safeId(chatId, "chat")}`;
}

export function getTelegramBotPreferencesForState({ state, safeId, accountId = "", chatId = "" } = {}) {
  const value = state.telegramBotPreferences?.[preferenceKey({ accountId, chatId, safeId })] || {};
  return {
    mode: typeof value.mode === "string" ? value.mode : "",
    updatedAt: value.updatedAt || "",
  };
}

export function setTelegramBotModePreferenceForState({ state, saveState, safeId, accountId = "", chatId = "", mode = "" } = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedChatId = String(chatId || "").trim();
  const normalizedMode = String(mode || "").trim();
  if (!normalizedAccountId || !normalizedChatId || !normalizedMode) {
    return { ok: false, status: 400, error: "telegram_bot_preference_invalid" };
  }
  const key = preferenceKey({ accountId: normalizedAccountId, chatId: normalizedChatId, safeId });
  const preference = {
    accountId: normalizedAccountId,
    chatId: normalizedChatId,
    mode: normalizedMode,
    updatedAt: new Date().toISOString(),
  };
  state.telegramBotPreferences[key] = preference;
  saveState();
  return { ok: true, preference: structuredClone(preference) };
}

function eventPayload(event = {}) {
  return {
    id: String(event.id || `tgbe_${randomUUID()}`).slice(0, 120),
    eventType: String(event.eventType || event.event_type || "event").slice(0, 120),
    direction: ["inbound", "outbound", "internal"].includes(event.direction) ? event.direction : "internal",
    accountId: String(event.accountId || event.account_id || "").slice(0, 160),
    providerUserId: String(event.providerUserId || event.provider_user_id || "").slice(0, 160),
    chatId: String(event.chatId || event.chat_id || "").slice(0, 160),
    updateId: String(event.updateId || event.update_id || "").slice(0, 160),
    messageId: String(event.messageId || event.message_id || "").slice(0, 160),
    action: String(event.action || "").slice(0, 160),
    mode: String(event.mode || "").slice(0, 80),
    status: String(event.status || "").slice(0, 80),
    error: String(event.error || "").slice(0, 500),
    textPreview: String(event.textPreview || event.text_preview || "").replace(/\s+/g, " ").trim().slice(0, 500),
    metadata: event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
      ? structuredClone(event.metadata)
      : {},
    createdAt: event.createdAt || event.created_at || new Date().toISOString(),
  };
}

export function recordRuntimeTelegramBotEventForState({ state, saveState, event = {} } = {}) {
  const row = eventPayload(event);
  state.telegramBotEvents.push(row);
  state.telegramBotEvents = state.telegramBotEvents.slice(-1000);
  saveState();
  return { ok: true, event: structuredClone(row), durable: false };
}

export function listRuntimeTelegramBotEventsForState({ state, accountId = "", providerUserId = "", chatId = "", limit = 50 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const filters = {
    accountId: String(accountId || "").trim(),
    providerUserId: String(providerUserId || "").trim(),
    chatId: String(chatId || "").trim(),
  };
  const events = (state.telegramBotEvents || [])
    .filter((event) => Object.entries(filters).every(([key, value]) => !value || event[key] === value))
    .sort((left, right) => (Date.parse(right.createdAt || "") || 0) - (Date.parse(left.createdAt || "") || 0))
    .slice(0, normalizedLimit);
  return { ok: true, events: structuredClone(events), durable: false };
}
