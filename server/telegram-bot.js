import { timingSafeEqual } from "node:crypto";
import { chatModes, chatSend } from "./product-contracts.js";
import { effectiveDefaultChatMode } from "./chat-mode-defaults.js";
import { normalizedChatMode } from "./chat-router.js";
import { usageSummary } from "./repositories/chat-billing.js";
import { recordTelegramBotEvent } from "./repositories/telegram-bot-events.js";
import {
  conversationIdForSession,
  findAccountByIdentity,
  getTelegramBotPreferences,
  setTelegramBotModePreference,
} from "./runtime-store.js";

const webhookPath = "/api/integrations/telegram/webhook";
const statusPath = "/api/integrations/telegram/status";
const telegramTextLimit = 4096;
const recentUpdateTtlMs = 10 * 60_000;
const recentUpdateIds = new Map();
const modeOptions = [
  { code: "i", label: "Instant" },
  { code: "t", label: "Thinking" },
  { code: "h", label: "Help" },
];
const modeByCode = new Map(modeOptions.map((mode) => [mode.code, mode.label]));

function currentEnvironment() {
  return process.env.TASKNODE_ENV || process.env.NODE_ENV || "development";
}

function productionLike() {
  return ["prod", "production"].includes(currentEnvironment().toLowerCase());
}

function telegramBotToken() {
  return String(process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_AUTH_BOT_TOKEN || "").trim();
}

function telegramWebhookSecret() {
  return String(process.env.TELEGRAM_BOT_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
}

function taskNodePublicUrl() {
  return String(process.env.TASKNODE_PUBLIC_URL || process.env.VITE_SITE_ORIGIN || "").replace(/\/+$/, "");
}

function telegramChatMode() {
  return String(process.env.TELEGRAM_BOT_CHAT_MODE || "").trim();
}

function text(value = "", max = 3900) {
  return String(value || "").trim().replace(/\r\n/g, "\n").slice(0, max);
}

function equalSecret(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function headerValue(headers = {}, name = "") {
  if (!headers || !name) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const lowerName = name.toLowerCase();
  return headers[name] || headers[lowerName] || "";
}

function linkedInstructions() {
  const base = taskNodePublicUrl();
  const openTaskNode = base ? ` Open ${base} to manage your account.` : "";
  return `Link Telegram in Task Node Settings > Connected accounts, then message this bot again.${openTaskNode}`;
}

function telegramBotApiUrl(method) {
  return `https://api.telegram.org/bot${telegramBotToken()}/${method}`;
}

async function defaultSendTelegramMessage({ chatId, text: messageText, replyMarkup = null }, { fetchImpl = fetch } = {}) {
  const token = telegramBotToken();
  if (!token) return { ok: false, error: "telegram_bot_token_missing" };

  const chunks = chunkTelegramText(messageText);
  const sent = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const response = await fetchImpl(telegramBotApiUrl("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        reply_markup: index === chunks.length - 1 ? replyMarkup || undefined : undefined,
      }),
    });
    const body = await response.json().catch(() => ({}));
    sent.push({
      status: response.status,
      ok: response.ok && body?.ok !== false,
      messageId: body?.result?.message_id == null ? null : String(body.result.message_id),
    });
    if (!response.ok || body?.ok === false) {
      return {
        ok: false,
        error: body?.description || `telegram_send_http_${response.status}`,
        sent,
      };
    }
  }

  return { ok: true, sent };
}

async function defaultSendTelegramChatAction({ chatId, action = "typing" }, { fetchImpl = fetch } = {}) {
  const token = telegramBotToken();
  if (!token) return { ok: false, error: "telegram_bot_token_missing" };

  const response = await fetchImpl(telegramBotApiUrl("sendChatAction"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      action,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    return { ok: false, status: response.status, error: body?.description || `telegram_chat_action_http_${response.status}` };
  }
  return { ok: true, status: response.status };
}

async function defaultAnswerCallbackQuery({ callbackQueryId, text: messageText = "", showAlert = false }, { fetchImpl = fetch } = {}) {
  const token = telegramBotToken();
  if (!token || !callbackQueryId) return { ok: false, error: "telegram_callback_answer_unavailable" };

  const response = await fetchImpl(telegramBotApiUrl("answerCallbackQuery"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text(messageText, 180),
      show_alert: showAlert,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    return { ok: false, error: body?.description || `telegram_callback_http_${response.status}` };
  }
  return { ok: true };
}

function chunkTelegramText(messageText = "") {
  const normalized = text(messageText, 20000) || "Task Node did not return text.";
  if (normalized.length <= telegramTextLimit) return [normalized];

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, telegramTextLimit - 100));
    remaining = remaining.slice(telegramTextLimit - 100);
  }
  return chunks;
}

function telegramStatusBody() {
  const tokenConfigured = Boolean(telegramBotToken());
  const secretConfigured = Boolean(telegramWebhookSecret());
  const requiresSecret = productionLike();
  const publicUrl = taskNodePublicUrl();
  const webhookUrl = publicUrl ? `${publicUrl}${webhookPath}` : "";
  const enabled = tokenConfigured && (secretConfigured || !requiresSecret);

  return {
    ok: true,
    telegramBot: {
      configured: tokenConfigured,
      enabled,
      status: enabled ? "ready" : tokenConfigured ? "missing_webhook_secret" : "missing_bot_token",
      webhookPath,
      webhookUrl,
      botTokenEnv: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_AUTH_BOT_TOKEN"],
      webhookSecretEnv: ["TELEGRAM_BOT_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_SECRET"],
      chatModeEnv: "TELEGRAM_BOT_CHAT_MODE",
      modes: telegramModeStatus(),
      actionRequired: enabled
        ? "Set the Telegram webhook to this URL with the same secret token."
        : tokenConfigured
          ? "Set TELEGRAM_BOT_WEBHOOK_SECRET and register the Telegram webhook with that secret token."
          : "Set TELEGRAM_BOT_TOKEN or reuse TELEGRAM_AUTH_BOT_TOKEN for the linked Telegram bot.",
    },
  };
}

function knownModeLabel(mode = "") {
  const normalized = normalizedChatMode(mode);
  return modeOptions.find((option) => option.label === normalized)?.label || "";
}

function telegramModeStatus() {
  const modes = chatModes();
  return modeOptions.map((option) => {
    const status = modes.find((mode) => mode.label === option.label) || {};
    return {
      ...option,
      provider: status.provider || "",
      model: status.model || "",
      enabled: status.enabled === true,
      status: status.status || "unknown",
    };
  });
}

function defaultTelegramMode() {
  return (
    knownModeLabel(telegramChatMode()) ||
    knownModeLabel(effectiveDefaultChatMode()) ||
    "Instant"
  );
}

function modeForTelegramChat({ accountId = "", chatId = "", preferenceReader = getTelegramBotPreferences } = {}) {
  const preference = preferenceReader({ accountId, chatId });
  return knownModeLabel(preference?.mode) || defaultTelegramMode();
}

function fallbackTelegramMode(currentMode = "") {
  const explicit = knownModeLabel(process.env.TELEGRAM_BOT_FALLBACK_CHAT_MODE);
  const modes = chatModes();
  const enabled = (label) => {
    const status = modes.find((mode) => mode.label === label);
    return status?.enabled === true && label !== currentMode;
  };
  if (explicit && enabled(explicit)) return explicit;

  return ["Instant", "Thinking", "Help"].find(enabled) || "";
}

function shouldRetryTelegramChat({ mode = "", result = {} } = {}) {
  if (mode !== "Thinking" || result?.body?.ok === true) return false;
  if (result?.body?.estimate?.provider !== "ambient") return false;
  const error = result?.body?.error || "";
  const status = Number(result?.body?.providerStatus || result?.status || 0);
  return (
    error === "provider_request_failed" ||
    error === "provider_timeout" ||
    error === "chat_provider_empty_response" ||
    error === "provider_stream_unavailable" ||
    status === 402 ||
    status === 429 ||
    status >= 500
  );
}

function modeKeyboard(currentMode = "") {
  const current = knownModeLabel(currentMode) || defaultTelegramMode();
  return {
    inline_keyboard: [
      modeOptions.slice(0, 2).map((mode) => ({
        text: `${mode.label === current ? "[x] " : ""}${mode.label}`,
        callback_data: `tn_mode:${mode.code}`,
      })),
      modeOptions.slice(2).map((mode) => ({
        text: `${mode.label === current ? "[x] " : ""}${mode.label}`,
        callback_data: `tn_mode:${mode.code}`,
      })),
      [{ text: "Balance", callback_data: "tn_balance" }],
    ],
  };
}

function usd(value = 0) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return "$0.0000";
  return `$${amount.toFixed(4)}`;
}

function billingSummaryText(summary = {}) {
  return [
    `Available credit: ${usd(summary.availableCreditUsd)}`,
    `Credit: ${usd(summary.currentCreditUsd)}`,
    `Spent: ${usd(summary.currentSpendUsd)}`,
  ].join("\n");
}

async function safeUsageSummaryForBot({ accountId = "", usageReader = usageSummary } = {}) {
  try {
    return await usageReader({ accountId });
  } catch (error) {
    console.warn(`telegram bot billing summary failed: ${error?.message || error}`);
    return {
      currentSpendUsd: 0,
      currentCreditUsd: 0,
      availableCreditUsd: 0,
      ledgerEntryCount: 0,
      unavailable: true,
    };
  }
}

function telegramCommand(body = "") {
  const normalized = String(body || "").trim().toLowerCase();
  if (!normalized) return "";

  const firstToken = normalized.split(/\s+/)[0] || "";
  const commandToken = firstToken.startsWith("/") ? firstToken.slice(1).split("@")[0] : firstToken;
  if (["start", "help", "mode", "modes"].includes(commandToken)) return "mode";
  if (["balance", "bal", "credit"].includes(commandToken)) return "balance";
  if (firstToken.startsWith("/")) return "unknown";
  return "";
}

function webhookAuthorized(headers = {}) {
  const expected = telegramWebhookSecret();
  if (!expected) {
    return productionLike()
      ? { ok: false, status: 503, error: "telegram_webhook_secret_missing" }
      : { ok: true };
  }

  const actual = headerValue(headers, "x-telegram-bot-api-secret-token");
  if (!equalSecret(actual, expected)) {
    return { ok: false, status: 401, error: "telegram_webhook_secret_invalid" };
  }
  return { ok: true };
}

function incomingMessage(update = {}) {
  const message = update.message || null;
  if (!message) return null;
  const from = message.from || {};
  const chat = message.chat || {};
  const body = text(message.text || message.caption || "", 12000);
  return {
    updateId: update.update_id,
    messageId: message.message_id,
    fromId: from.id == null ? "" : String(from.id),
    fromIsBot: from.is_bot === true,
    username: from.username || "",
    chatId: chat.id == null ? "" : String(chat.id),
    chatType: chat.type || "",
    body,
  };
}

function incomingCallback(update = {}) {
  const callback = update.callback_query || null;
  if (!callback) return null;
  const from = callback.from || {};
  const chat = callback.message?.chat || {};
  return {
    updateId: update.update_id,
    callbackQueryId: callback.id || "",
    fromId: from.id == null ? "" : String(from.id),
    fromIsBot: from.is_bot === true,
    username: from.username || "",
    chatId: chat.id == null ? "" : String(chat.id),
    chatType: chat.type || "",
    data: String(callback.data || "").trim(),
  };
}

function markTelegramUpdate(updateId) {
  const id = String(updateId ?? "").trim();
  if (!id) return { duplicate: false };

  const now = Date.now();
  for (const [key, seenAt] of recentUpdateIds.entries()) {
    if (now - seenAt > recentUpdateTtlMs) recentUpdateIds.delete(key);
  }

  if (recentUpdateIds.has(id)) return { duplicate: true };
  recentUpdateIds.set(id, now);
  return { duplicate: false };
}

function assistantTextFromChatResult(result) {
  if (typeof result?.body?.assistant?.body === "string") return result.body.assistant.body;
  if (typeof result?.body?.assistant?.text === "string") return result.body.assistant.text;
  if (typeof result?.body?.message === "string") return result.body.message;
  return "";
}

function failureText(result) {
  const body = result?.body || {};
  if (body.error === "chat_credit_required") {
    const usage = body.usage || {};
    const estimate = body.estimate || {};
    return [
      "Your Task Node chat credit is too low for this request.",
      `Available: ${usd(usage.availableCreditUsd)}`,
      `Estimated request cost: ${usd(estimate.estimatedUsd)}`,
      "Top up in Task Node, then message this bot again.",
    ].join("\n");
  }
  if (body.error === "chat_provider_not_configured" || body.error === "chat_provider_disabled") {
    return "Task Node chat is not ready in this environment. Try again after the chat provider is enabled.";
  }
  return text([body.message, body.actionRequired].filter(Boolean).join("\n"), 1800) || "Task Node could not complete this chat request.";
}

async function auditTelegramBotEvent(event = {}) {
  try {
    await recordTelegramBotEvent(event);
  } catch (error) {
    console.warn(`telegram bot event audit failed: ${error?.message || error}`);
  }
}

function sendMetadata(result = {}) {
  return {
    sent: Array.isArray(result?.sent) ? result.sent : [],
    messageId: result?.messageId || null,
  };
}

function telegramEventContextForMessage(message = {}) {
  return {
    updateId: message.updateId == null ? "" : String(message.updateId),
    messageId: message.messageId == null ? "" : String(message.messageId),
    providerUserId: message.fromId || "",
    chatId: message.chatId || "",
    accountId: "",
    action: "",
    mode: "",
  };
}

function telegramEventContextForCallback(callback = {}) {
  return {
    updateId: callback.updateId == null ? "" : String(callback.updateId),
    messageId: "",
    providerUserId: callback.fromId || "",
    chatId: callback.chatId || "",
    accountId: "",
    action: "",
    mode: "",
  };
}

function auditedTelegramSender({ context, sendTelegramMessage, fetchImpl = fetch } = {}) {
  return async (message, options = {}) => {
    try {
      const result = await sendTelegramMessage(message, options || { fetchImpl });
      await auditTelegramBotEvent({
        eventType: "send_message",
        direction: "outbound",
        accountId: context.accountId,
        providerUserId: context.providerUserId,
        chatId: String(message?.chatId || context.chatId || ""),
        updateId: context.updateId,
        messageId: context.messageId,
        action: context.action,
        mode: context.mode,
        status: result?.ok === false ? "failed" : "sent",
        error: result?.ok === false ? result.error || "send_failed" : "",
        textPreview: message?.text || "",
        metadata: sendMetadata(result),
      });
      return result;
    } catch (error) {
      await auditTelegramBotEvent({
        eventType: "send_message",
        direction: "outbound",
        accountId: context.accountId,
        providerUserId: context.providerUserId,
        chatId: String(message?.chatId || context.chatId || ""),
        updateId: context.updateId,
        messageId: context.messageId,
        action: context.action,
        mode: context.mode,
        status: "threw",
        error: error?.message || String(error),
        textPreview: message?.text || "",
      });
      throw error;
    }
  };
}

function auditedTelegramChatActionSender({ context, sendTelegramChatAction, fetchImpl = fetch } = {}) {
  return async (action, options = {}) => {
    try {
      const result = await sendTelegramChatAction(action, options || { fetchImpl });
      await auditTelegramBotEvent({
        eventType: "send_chat_action",
        direction: "outbound",
        accountId: context.accountId,
        providerUserId: context.providerUserId,
        chatId: String(action?.chatId || context.chatId || ""),
        updateId: context.updateId,
        messageId: context.messageId,
        action: context.action,
        mode: context.mode,
        status: result?.ok === false ? "failed" : "sent",
        error: result?.ok === false ? result.error || "chat_action_failed" : "",
        textPreview: action?.action || "typing",
        metadata: { status: result?.status || null },
      });
      return result;
    } catch (error) {
      await auditTelegramBotEvent({
        eventType: "send_chat_action",
        direction: "outbound",
        accountId: context.accountId,
        providerUserId: context.providerUserId,
        chatId: String(action?.chatId || context.chatId || ""),
        updateId: context.updateId,
        messageId: context.messageId,
        action: context.action,
        mode: context.mode,
        status: "threw",
        error: error?.message || String(error),
        textPreview: action?.action || "typing",
      });
      throw error;
    }
  };
}

function auditedCallbackAnswerer({ context, answerCallbackQuery, fetchImpl = fetch } = {}) {
  return async (answer, options = {}) => {
    const result = await answerCallbackQuery(answer, options || { fetchImpl });
    await auditTelegramBotEvent({
      eventType: "answer_callback_query",
      direction: "outbound",
      accountId: context.accountId,
      providerUserId: context.providerUserId,
      chatId: context.chatId,
      updateId: context.updateId,
      messageId: context.messageId,
      action: context.action,
      mode: context.mode,
      status: result?.ok === false ? "failed" : "sent",
      error: result?.ok === false ? result.error || "callback_answer_failed" : "",
      textPreview: answer?.text || "",
      metadata: { callbackQueryId: answer?.callbackQueryId || "" },
    });
    return result;
  };
}

async function auditTelegramProcessResult(context = {}, result = {}) {
  await auditTelegramBotEvent({
    eventType: "process_result",
    direction: "internal",
    accountId: context.accountId,
    providerUserId: context.providerUserId,
    chatId: context.chatId,
    updateId: context.updateId,
    messageId: context.messageId,
    action: result.action || context.action,
    mode: result.mode || context.mode,
    status: result.ok === false ? "failed" : result.ignored ? "ignored" : "ok",
    error: result.error || result.reason || "",
    metadata: result,
  });
  return result;
}

async function sendModeHelp({ accountId = "", chatId = "", mode = "", sendTelegramMessage, usageReader = usageSummary, fetchImpl = fetch } = {}) {
  const summary = await safeUsageSummaryForBot({ accountId, usageReader });
  const currentMode = knownModeLabel(mode) || defaultTelegramMode();
  return sendTelegramMessage({
    chatId,
    text: [
      "Telegram is linked to your Task Node account.",
      `Current mode: ${currentMode}`,
      billingSummaryText(summary),
      "Send a message here to continue your Task Node chat, or choose a mode below.",
    ].join("\n"),
    replyMarkup: modeKeyboard(currentMode),
  }, { fetchImpl });
}

async function sendBalance({ accountId = "", chatId = "", mode = "", sendTelegramMessage, usageReader = usageSummary, fetchImpl = fetch } = {}) {
  const summary = await safeUsageSummaryForBot({ accountId, usageReader });
  const currentMode = knownModeLabel(mode) || defaultTelegramMode();
  return sendTelegramMessage({
    chatId,
    text: [
      billingSummaryText(summary),
      `Current mode: ${currentMode}`,
    ].join("\n"),
  }, { fetchImpl });
}

async function sendChatTyping({ chatId = "", sendTelegramChatAction, fetchImpl = fetch } = {}) {
  const sent = await sendTelegramChatAction({
    chatId,
    action: "typing",
  }, { fetchImpl });
  if (sent?.ok === false) {
    console.warn(`telegram bot typing action failed: ${sent.error || "send_failed"}`);
  }
  return sent;
}

export async function processTelegramBotUpdate(update = {}, {
  accountResolver = findAccountByIdentity,
  answerCallbackQuery = defaultAnswerCallbackQuery,
  chatExecutor = chatSend,
  preferenceReader = getTelegramBotPreferences,
  preferenceWriter = setTelegramBotModePreference,
  sendTelegramChatAction = defaultSendTelegramChatAction,
  sendTelegramMessage = defaultSendTelegramMessage,
  usageReader = usageSummary,
  fetchImpl = fetch,
} = {}) {
  const marker = markTelegramUpdate(update.update_id);
  if (marker.duplicate) {
    return auditTelegramProcessResult(
      { updateId: update.update_id == null ? "" : String(update.update_id) },
      { ok: true, ignored: true, reason: "duplicate_update" }
    );
  }

  const callback = incomingCallback(update);
  if (callback) {
    const auditContext = telegramEventContextForCallback(callback);
    const sendBotMessage = auditedTelegramSender({ context: auditContext, sendTelegramMessage, fetchImpl });
    const answerCallback = auditedCallbackAnswerer({ context: auditContext, answerCallbackQuery, fetchImpl });

    await auditTelegramBotEvent({
      eventType: "callback_query",
      direction: "inbound",
      providerUserId: callback.fromId,
      chatId: callback.chatId,
      updateId: auditContext.updateId,
      status: "received",
      textPreview: callback.data,
      metadata: {
        username: callback.username || "",
        chatType: callback.chatType || "",
        callbackQueryId: callback.callbackQueryId || "",
      },
    });

    if (callback.fromIsBot) return auditTelegramProcessResult(auditContext, { ok: true, ignored: true, reason: "bot_sender" });
    if (!callback.callbackQueryId || !callback.chatId || !callback.fromId) {
      return auditTelegramProcessResult(auditContext, { ok: true, ignored: true, reason: "missing_callback_sender" });
    }
    if (callback.chatType && callback.chatType !== "private") {
      auditContext.action = "telegram_bot_non_private_callback";
      await answerCallback({
        callbackQueryId: callback.callbackQueryId,
        text: "Use a private Telegram chat.",
        showAlert: true,
      }, { fetchImpl });
      return auditTelegramProcessResult(auditContext, { ok: true, ignored: true, reason: "non_private_callback" });
    }

    const account = accountResolver("telegram", callback.fromId);
    const linked = account?.id && account.status !== "deleted";
    if (!linked) {
      auditContext.action = "telegram_bot_link_required";
      await answerCallback({
        callbackQueryId: callback.callbackQueryId,
        text: "Link Telegram in Task Node first.",
        showAlert: true,
      }, { fetchImpl });
      await sendBotMessage({ chatId: callback.chatId, text: linkedInstructions() }, { fetchImpl });
      return auditTelegramProcessResult(auditContext, { ok: true, action: "telegram_bot_link_required", linked: false });
    }

    auditContext.accountId = account.id;
    const currentMode = modeForTelegramChat({ accountId: account.id, chatId: callback.chatId, preferenceReader });
    auditContext.mode = currentMode;
    if (callback.data === "tn_balance") {
      auditContext.action = "telegram_bot_balance";
      await answerCallback({ callbackQueryId: callback.callbackQueryId, text: "Balance sent." }, { fetchImpl });
      await sendBalance({
        accountId: account.id,
        chatId: callback.chatId,
        mode: currentMode,
        sendTelegramMessage: sendBotMessage,
        usageReader,
        fetchImpl,
      });
      return auditTelegramProcessResult(auditContext, { ok: true, action: "telegram_bot_balance", linked: true, accountId: account.id, mode: currentMode });
    }

    if (callback.data.startsWith("tn_mode:")) {
      const selected = modeByCode.get(callback.data.slice("tn_mode:".length)) || "";
      if (!selected) {
        auditContext.action = "telegram_bot_unknown_mode";
        await answerCallback({ callbackQueryId: callback.callbackQueryId, text: "Unknown mode.", showAlert: true }, { fetchImpl });
        return auditTelegramProcessResult(auditContext, { ok: true, ignored: true, reason: "unknown_mode_callback" });
      }
      auditContext.action = "telegram_bot_mode_set";
      auditContext.mode = selected;
      const saved = preferenceWriter({ accountId: account.id, chatId: callback.chatId, mode: selected });
      if (!saved?.ok) {
        await answerCallback({ callbackQueryId: callback.callbackQueryId, text: "Mode could not be saved.", showAlert: true }, { fetchImpl });
        return auditTelegramProcessResult(auditContext, { ok: false, action: "telegram_bot_mode_failed", linked: true, accountId: account.id, error: saved?.error || "mode_save_failed" });
      }

      await answerCallback({ callbackQueryId: callback.callbackQueryId, text: `Mode set: ${selected}` }, { fetchImpl });
      await sendModeHelp({
        accountId: account.id,
        chatId: callback.chatId,
        mode: selected,
        sendTelegramMessage: sendBotMessage,
        usageReader,
        fetchImpl,
      });
      return auditTelegramProcessResult(auditContext, { ok: true, action: "telegram_bot_mode_set", linked: true, accountId: account.id, mode: selected });
    }

    auditContext.action = "telegram_bot_unknown_callback";
    await answerCallback({ callbackQueryId: callback.callbackQueryId, text: "Unknown action.", showAlert: true }, { fetchImpl });
    return auditTelegramProcessResult(auditContext, { ok: true, ignored: true, reason: "unknown_callback" });
  }

  const message = incomingMessage(update);
  if (!message) {
    return auditTelegramProcessResult(
      { updateId: update.update_id == null ? "" : String(update.update_id) },
      { ok: true, ignored: true, reason: "no_message" }
    );
  }
  const auditContext = telegramEventContextForMessage(message);
  const sendBotMessage = auditedTelegramSender({ context: auditContext, sendTelegramMessage, fetchImpl });
  const sendBotChatAction = auditedTelegramChatActionSender({ context: auditContext, sendTelegramChatAction, fetchImpl });
  await auditTelegramBotEvent({
    eventType: "message",
    direction: "inbound",
    providerUserId: message.fromId,
    chatId: message.chatId,
    updateId: auditContext.updateId,
    messageId: auditContext.messageId,
    status: "received",
    textPreview: message.body,
    metadata: {
      username: message.username || "",
      chatType: message.chatType || "",
    },
  });

  if (message.fromIsBot) return auditTelegramProcessResult(auditContext, { ok: true, ignored: true, reason: "bot_sender" });
  if (!message.chatId || !message.fromId) return auditTelegramProcessResult(auditContext, { ok: true, ignored: true, reason: "missing_sender" });

  if (message.chatType && message.chatType !== "private") {
    auditContext.action = "telegram_bot_non_private_chat";
    await sendBotMessage({
      chatId: message.chatId,
      text: "For account privacy, message this bot in a private Telegram chat.",
    }, { fetchImpl });
    return auditTelegramProcessResult(auditContext, { ok: true, ignored: true, reason: "non_private_chat" });
  }

  const account = accountResolver("telegram", message.fromId);
  const linked = account?.id && account.status !== "deleted";

  if (!linked) {
    auditContext.action = "telegram_bot_link_required";
    await sendBotMessage({ chatId: message.chatId, text: linkedInstructions() }, { fetchImpl });
    return auditTelegramProcessResult(auditContext, { ok: true, action: "telegram_bot_link_required", linked: false });
  }

  auditContext.accountId = account.id;
  const currentMode = modeForTelegramChat({ accountId: account.id, chatId: message.chatId, preferenceReader });
  auditContext.mode = currentMode;

  const command = telegramCommand(message.body);

  if (!message.body || command === "mode") {
    auditContext.action = "telegram_bot_help";
    await sendModeHelp({
      accountId: account.id,
      chatId: message.chatId,
      mode: currentMode,
      sendTelegramMessage: sendBotMessage,
      usageReader,
      fetchImpl,
    });
    return auditTelegramProcessResult(auditContext, { ok: true, action: "telegram_bot_help", linked: true, accountId: account.id });
  }

  if (command === "balance") {
    auditContext.action = "telegram_bot_balance";
    await sendBalance({
      accountId: account.id,
      chatId: message.chatId,
      mode: currentMode,
      sendTelegramMessage: sendBotMessage,
      usageReader,
      fetchImpl,
    });
    return auditTelegramProcessResult(auditContext, { ok: true, action: "telegram_bot_balance", linked: true, accountId: account.id, mode: currentMode });
  }

  if (command === "unknown") {
    auditContext.action = "telegram_bot_unknown_command";
    await sendModeHelp({
      accountId: account.id,
      chatId: message.chatId,
      mode: currentMode,
      sendTelegramMessage: sendBotMessage,
      usageReader,
      fetchImpl,
    });
    return auditTelegramProcessResult(auditContext, { ok: true, action: "telegram_bot_unknown_command", linked: true, accountId: account.id, mode: currentMode });
  }

  const conversationId = conversationIdForSession(
    { accountId: account.id },
    `telegram_${message.chatId}`
  );
  const payload = {
    accountId: account.id,
    conversationId,
    mode: currentMode,
    message: message.body,
  };

  auditContext.action = "telegram_bot_chat";
  await sendChatTyping({
    chatId: message.chatId,
    sendTelegramChatAction: sendBotChatAction,
    fetchImpl,
  });

  let result = await chatExecutor(payload, "POST", { source: "telegram_bot" });
  let fallbackMode = "";
  let primaryChatStatus = result?.status || 0;
  if (shouldRetryTelegramChat({ mode: currentMode, result })) {
    fallbackMode = fallbackTelegramMode(currentMode);
    if (fallbackMode) {
      console.warn("telegram_bot_chat_provider_fallback", {
        accountId: account.id,
        fromMode: currentMode,
        toMode: fallbackMode,
        providerStatus: result?.body?.providerStatus || result?.status || 0,
        providerMessage: text(result?.body?.providerMessage || result?.body?.message || "", 180),
      });
      result = await chatExecutor({ ...payload, mode: fallbackMode }, "POST", { source: "telegram_bot" });
    }
  }
  const replyText = result?.body?.ok ? assistantTextFromChatResult(result) : failureText(result);
  const sent = await sendBotMessage({
    chatId: message.chatId,
    text: replyText,
  }, { fetchImpl });
  if (sent?.ok === false) {
    console.warn(`telegram bot response send failed: ${sent.error || "send_failed"}`);
  }

  return auditTelegramProcessResult(auditContext, {
    ok: result?.body?.ok === true && sent?.ok !== false,
    action: "telegram_bot_chat",
    linked: true,
    accountId: account.id,
    conversationId,
    mode: currentMode,
    effectiveMode: result?.body?.ok && fallbackMode ? fallbackMode : currentMode,
    fallbackMode,
    primaryChatStatus,
    chatStatus: result?.status || 0,
    sent,
  });
}

export async function handleTelegramBotRoute({ json, readJson, req, res, url } = {}) {
  if (url.pathname === statusPath) {
    json(res, 200, telegramStatusBody());
    return true;
  }

  if (url.pathname !== webhookPath) return false;

  const token = telegramBotToken();
  if (!token) {
    json(res, 503, {
      ok: false,
      error: "telegram_bot_token_missing",
      message: "Telegram bot webhook is not configured.",
      actionRequired: "Set TELEGRAM_BOT_TOKEN or TELEGRAM_AUTH_BOT_TOKEN.",
    });
    return true;
  }

  const authorization = webhookAuthorized(req.headers || {});
  if (!authorization.ok) {
    json(res, authorization.status, {
      ok: false,
      error: authorization.error,
      message: "Telegram webhook authorization failed.",
      actionRequired: "Register the Telegram webhook with the configured TELEGRAM_BOT_WEBHOOK_SECRET.",
    });
    return true;
  }

  const update = req.method === "POST" ? await readJson(req, 1024 * 1024) : {};
  processTelegramBotUpdate(update).catch((error) => {
    console.warn(`telegram bot update failed: ${error?.message || error}`);
  });
  json(res, 200, {
    ok: true,
    action: "telegram_bot_webhook",
    accepted: true,
  });
  return true;
}

export const telegramBotRoutes = {
  statusPath,
  webhookPath,
};
