import { timingSafeEqual } from "node:crypto";
import { chatModes, chatSend } from "./product-contracts.js";
import { effectiveDefaultChatMode } from "./chat-mode-defaults.js";
import { usageSummary } from "./repositories/chat-billing.js";
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
  { code: "pi", label: "Private Instant" },
  { code: "pt", label: "Private Thinking" },
  { code: "fi", label: "Frontier Instant" },
  { code: "ft", label: "Frontier Thinking" },
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
    sent.push({ status: response.status, ok: response.ok && body?.ok !== false });
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
  const normalized = String(mode || "").trim();
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
    "Private Instant"
  );
}

function modeForTelegramChat({ accountId = "", chatId = "", preferenceReader = getTelegramBotPreferences } = {}) {
  const preference = preferenceReader({ accountId, chatId });
  return knownModeLabel(preference?.mode) || defaultTelegramMode();
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
    replyMarkup: modeKeyboard(currentMode),
  }, { fetchImpl });
}

async function sendChatAcknowledgement({ chatId = "", mode = "", sendTelegramMessage, fetchImpl = fetch } = {}) {
  const currentMode = knownModeLabel(mode) || defaultTelegramMode();
  const sent = await sendTelegramMessage({
    chatId,
    text: `Working in ${currentMode}. I will send the answer here when it is ready.`,
    replyMarkup: modeKeyboard(currentMode),
  }, { fetchImpl });
  if (sent?.ok === false) {
    console.warn(`telegram bot acknowledgement send failed: ${sent.error || "send_failed"}`);
  }
  return sent;
}

export async function processTelegramBotUpdate(update = {}, {
  accountResolver = findAccountByIdentity,
  answerCallbackQuery = defaultAnswerCallbackQuery,
  chatExecutor = chatSend,
  preferenceReader = getTelegramBotPreferences,
  preferenceWriter = setTelegramBotModePreference,
  sendTelegramMessage = defaultSendTelegramMessage,
  usageReader = usageSummary,
  fetchImpl = fetch,
} = {}) {
  const marker = markTelegramUpdate(update.update_id);
  if (marker.duplicate) return { ok: true, ignored: true, reason: "duplicate_update" };

  const callback = incomingCallback(update);
  if (callback) {
    if (callback.fromIsBot) return { ok: true, ignored: true, reason: "bot_sender" };
    if (!callback.callbackQueryId || !callback.chatId || !callback.fromId) return { ok: true, ignored: true, reason: "missing_callback_sender" };
    if (callback.chatType && callback.chatType !== "private") {
      await answerCallbackQuery({
        callbackQueryId: callback.callbackQueryId,
        text: "Use a private Telegram chat.",
        showAlert: true,
      }, { fetchImpl });
      return { ok: true, ignored: true, reason: "non_private_callback" };
    }

    const account = accountResolver("telegram", callback.fromId);
    const linked = account?.id && account.status !== "deleted";
    if (!linked) {
      await answerCallbackQuery({
        callbackQueryId: callback.callbackQueryId,
        text: "Link Telegram in Task Node first.",
        showAlert: true,
      }, { fetchImpl });
      await sendTelegramMessage({ chatId: callback.chatId, text: linkedInstructions() }, { fetchImpl });
      return { ok: true, action: "telegram_bot_link_required", linked: false };
    }

    const currentMode = modeForTelegramChat({ accountId: account.id, chatId: callback.chatId, preferenceReader });
    if (callback.data === "tn_balance") {
      await answerCallbackQuery({ callbackQueryId: callback.callbackQueryId, text: "Balance sent." }, { fetchImpl });
      await sendBalance({
        accountId: account.id,
        chatId: callback.chatId,
        mode: currentMode,
        sendTelegramMessage,
        usageReader,
        fetchImpl,
      });
      return { ok: true, action: "telegram_bot_balance", linked: true, accountId: account.id, mode: currentMode };
    }

    if (callback.data.startsWith("tn_mode:")) {
      const selected = modeByCode.get(callback.data.slice("tn_mode:".length)) || "";
      if (!selected) {
        await answerCallbackQuery({ callbackQueryId: callback.callbackQueryId, text: "Unknown mode.", showAlert: true }, { fetchImpl });
        return { ok: true, ignored: true, reason: "unknown_mode_callback" };
      }
      const saved = preferenceWriter({ accountId: account.id, chatId: callback.chatId, mode: selected });
      if (!saved?.ok) {
        await answerCallbackQuery({ callbackQueryId: callback.callbackQueryId, text: "Mode could not be saved.", showAlert: true }, { fetchImpl });
        return { ok: false, action: "telegram_bot_mode_failed", linked: true, accountId: account.id, error: saved?.error || "mode_save_failed" };
      }

      await answerCallbackQuery({ callbackQueryId: callback.callbackQueryId, text: `Mode set: ${selected}` }, { fetchImpl });
      await sendModeHelp({
        accountId: account.id,
        chatId: callback.chatId,
        mode: selected,
        sendTelegramMessage,
        usageReader,
        fetchImpl,
      });
      return { ok: true, action: "telegram_bot_mode_set", linked: true, accountId: account.id, mode: selected };
    }

    await answerCallbackQuery({ callbackQueryId: callback.callbackQueryId, text: "Unknown action.", showAlert: true }, { fetchImpl });
    return { ok: true, ignored: true, reason: "unknown_callback" };
  }

  const message = incomingMessage(update);
  if (!message) return { ok: true, ignored: true, reason: "no_message" };
  if (message.fromIsBot) return { ok: true, ignored: true, reason: "bot_sender" };
  if (!message.chatId || !message.fromId) return { ok: true, ignored: true, reason: "missing_sender" };

  if (message.chatType && message.chatType !== "private") {
    await sendTelegramMessage({
      chatId: message.chatId,
      text: "For account privacy, message this bot in a private Telegram chat.",
    }, { fetchImpl });
    return { ok: true, ignored: true, reason: "non_private_chat" };
  }

  const account = accountResolver("telegram", message.fromId);
  const linked = account?.id && account.status !== "deleted";

  if (!linked) {
    await sendTelegramMessage({ chatId: message.chatId, text: linkedInstructions() }, { fetchImpl });
    return { ok: true, action: "telegram_bot_link_required", linked: false };
  }

  const currentMode = modeForTelegramChat({ accountId: account.id, chatId: message.chatId, preferenceReader });

  const command = telegramCommand(message.body);

  if (!message.body || command === "mode") {
    await sendModeHelp({
      accountId: account.id,
      chatId: message.chatId,
      mode: currentMode,
      sendTelegramMessage,
      usageReader,
      fetchImpl,
    });
    return { ok: true, action: "telegram_bot_help", linked: true, accountId: account.id };
  }

  if (command === "balance") {
    await sendBalance({
      accountId: account.id,
      chatId: message.chatId,
      mode: currentMode,
      sendTelegramMessage,
      usageReader,
      fetchImpl,
    });
    return { ok: true, action: "telegram_bot_balance", linked: true, accountId: account.id, mode: currentMode };
  }

  if (command === "unknown") {
    await sendModeHelp({
      accountId: account.id,
      chatId: message.chatId,
      mode: currentMode,
      sendTelegramMessage,
      usageReader,
      fetchImpl,
    });
    return { ok: true, action: "telegram_bot_unknown_command", linked: true, accountId: account.id, mode: currentMode };
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

  await sendChatAcknowledgement({
    chatId: message.chatId,
    mode: currentMode,
    sendTelegramMessage,
    fetchImpl,
  });

  const result = await chatExecutor(payload, "POST");
  const replyText = result?.body?.ok ? assistantTextFromChatResult(result) : failureText(result);
  const sent = await sendTelegramMessage({
    chatId: message.chatId,
    text: replyText,
    replyMarkup: modeKeyboard(currentMode),
  }, { fetchImpl });
  if (sent?.ok === false) {
    console.warn(`telegram bot response send failed: ${sent.error || "send_failed"}`);
  }

  return {
    ok: result?.body?.ok === true && sent?.ok !== false,
    action: "telegram_bot_chat",
    linked: true,
    accountId: account.id,
    conversationId,
    mode: currentMode,
    chatStatus: result?.status || 0,
    sent,
  };
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
