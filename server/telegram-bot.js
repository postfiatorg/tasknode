import { timingSafeEqual } from "node:crypto";
import { chatSend } from "./product-contracts.js";
import {
  conversationIdForSession,
  findAccountByIdentity,
} from "./runtime-store.js";

const webhookPath = "/api/integrations/telegram/webhook";
const statusPath = "/api/integrations/telegram/status";
const telegramTextLimit = 4096;

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

async function defaultSendTelegramMessage({ chatId, text: messageText }, { fetchImpl = fetch } = {}) {
  const token = telegramBotToken();
  if (!token) return { ok: false, error: "telegram_bot_token_missing" };

  const chunks = chunkTelegramText(messageText);
  const sent = [];
  for (const chunk of chunks) {
    const response = await fetchImpl(telegramBotApiUrl("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
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
      actionRequired: enabled
        ? "Set the Telegram webhook to this URL with the same secret token."
        : tokenConfigured
          ? "Set TELEGRAM_BOT_WEBHOOK_SECRET and register the Telegram webhook with that secret token."
          : "Set TELEGRAM_BOT_TOKEN or reuse TELEGRAM_AUTH_BOT_TOKEN for the linked Telegram bot.",
    },
  };
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
  const message = update.message || update.edited_message || null;
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

function assistantTextFromChatResult(result) {
  if (typeof result?.body?.assistant?.body === "string") return result.body.assistant.body;
  if (typeof result?.body?.assistant?.text === "string") return result.body.assistant.text;
  if (typeof result?.body?.message === "string") return result.body.message;
  return "";
}

function failureText(result) {
  const body = result?.body || {};
  if (body.error === "chat_credit_required") {
    return "Your Task Node chat credit is too low for this request. Top up in Task Node, then message this bot again.";
  }
  if (body.error === "chat_provider_not_configured" || body.error === "chat_provider_disabled") {
    return "Task Node chat is not ready in this environment. Try again after the chat provider is enabled.";
  }
  return text([body.message, body.actionRequired].filter(Boolean).join("\n"), 1800) || "Task Node could not complete this chat request.";
}

export async function processTelegramBotUpdate(update = {}, {
  accountResolver = findAccountByIdentity,
  chatExecutor = chatSend,
  sendTelegramMessage = defaultSendTelegramMessage,
  fetchImpl = fetch,
} = {}) {
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

  if (!message.body || /^\/(start|help)(\s|$)/i.test(message.body)) {
    await sendTelegramMessage({
      chatId: message.chatId,
      text: "Telegram is linked to your Task Node account. Send a message here to continue your Task Node chat.",
    }, { fetchImpl });
    return { ok: true, action: "telegram_bot_help", linked: true, accountId: account.id };
  }

  const conversationId = conversationIdForSession(
    { accountId: account.id },
    `telegram_${message.chatId}`
  );
  const payload = {
    accountId: account.id,
    conversationId,
    message: message.body,
  };
  const mode = telegramChatMode();
  if (mode) payload.mode = mode;

  const result = await chatExecutor(payload, "POST");
  const replyText = result?.body?.ok ? assistantTextFromChatResult(result) : failureText(result);
  const sent = await sendTelegramMessage({ chatId: message.chatId, text: replyText }, { fetchImpl });

  return {
    ok: result?.body?.ok === true && sent?.ok !== false,
    action: "telegram_bot_chat",
    linked: true,
    accountId: account.id,
    conversationId,
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
  const result = await processTelegramBotUpdate(update);
  json(res, 200, result);
  return true;
}

export const telegramBotRoutes = {
  statusPath,
  webhookPath,
};
