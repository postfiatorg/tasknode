import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(tmpdir(), "tasknode-telegram-bot-"));
process.env.TASKNODE_STORE_PATH = path.join(tempDir, "runtime-store.json");
process.env.TASKNODE_ENV = "test";
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.TELEGRAM_AUTH_BOT_TOKEN = "123456:tasknode-telegram-secret";
process.env.TELEGRAM_BOT_CHAT_MODE = "Private Instant";
process.env.CHAT_PROVIDER_TIMEOUT_MS = "45000";
process.env.TELEGRAM_BOT_DISCOUNT_THINKING_TIMEOUT_MS = "135000";

try {
  const { chatProviderTimeoutMs, deepSeekChatRequest } = await import("../server/chat-router.js");
  const { getOrCreateProviderAccount } = await import("../server/runtime-store.js");
  const { listTelegramBotEvents } = await import("../server/repositories/telegram-bot-events.js");
  const {
    processTelegramBotUpdate,
  } = await import("../server/telegram-bot.js");

  const account = getOrCreateProviderAccount({
    provider: "telegram",
    providerUserId: "12345",
    username: "linked_user",
    displayName: "Linked User",
  });

  const sentMessages = [];
  const sentChatActions = [];
  const answeredCallbacks = [];
  const chatCalls = [];
  const answerCallbackQuery = async (answer) => {
    answeredCallbacks.push(answer);
    return { ok: true };
  };
  const sendTelegramMessage = async (message) => {
    sentMessages.push(message);
    return { ok: true, messageId: sentMessages.length };
  };
  const sendTelegramChatAction = async (action) => {
    sentChatActions.push(action);
    return { ok: true, status: 200 };
  };
  const chatExecutor = async (payload, method, options = {}) => {
    chatCalls.push({ payload, method, options });
    return {
      status: 200,
      body: {
        ok: true,
        assistant: {
          body: `reply:${payload.message}`,
        },
      },
    };
  };

  assert.equal(
    chatProviderTimeoutMs({ mode: "Discount Thinking", source: "telegram_bot" }),
    135000
  );
  const telegramDiscountTimeout = process.env.TELEGRAM_BOT_DISCOUNT_THINKING_TIMEOUT_MS;
  delete process.env.TELEGRAM_BOT_DISCOUNT_THINKING_TIMEOUT_MS;
  assert.equal(
    chatProviderTimeoutMs({ mode: "Discount Thinking", source: "telegram_bot" }),
    120000
  );
  process.env.TELEGRAM_BOT_DISCOUNT_THINKING_TIMEOUT_MS = telegramDiscountTimeout;
  assert.equal(
    chatProviderTimeoutMs({ mode: "Discount Thinking", source: "web" }),
    45000
  );
  const telegramPromptRequest = deepSeekChatRequest({
    mode: "Discount Thinking",
    model: "deepseek-v4-pro",
    conversationId: "telegram-smoke",
    message: "What should I do next?",
    deliveryContext: { source: "telegram_bot" },
  });
  assert.match(telegramPromptRequest.messages[0].content, /Telegram Delivery Contract/);
  assert.match(telegramPromptRequest.messages[0].content, /reference one relevant fact/);
  assert.match(telegramPromptRequest.messages[0].content, /End with exactly one concrete next step/);

  const linkedResult = await processTelegramBotUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "hello from telegram",
    },
  }, { chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(linkedResult.ok, true);
  assert.equal(linkedResult.action, "telegram_bot_chat");
  assert.equal(linkedResult.accountId, account.id);
  assert.match(linkedResult.conversationId, /^account_.+_telegram_12345$/);
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0].method, "POST");
  assert.equal(chatCalls[0].options.source, "telegram_bot");
  assert.equal(chatCalls[0].payload.accountId, account.id);
  assert.equal(chatCalls[0].payload.mode, "Private Instant");
  assert.equal(chatCalls[0].payload.message, "hello from telegram");
  assert.equal(sentChatActions.length, 1);
  assert.deepEqual(sentChatActions.at(-1), { chatId: "12345", action: "typing" });
  assert.equal(sentMessages.at(-1).chatId, "12345");
  assert.equal(sentMessages.at(-1).text, "reply:hello from telegram");
  assert.equal(sentMessages.at(-1).replyMarkup, undefined);

  const duplicateResult = await processTelegramBotUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "hello from telegram",
    },
  }, { chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(duplicateResult.ignored, true);
  assert.equal(duplicateResult.reason, "duplicate_update");
  assert.equal(chatCalls.length, 1);

  const unlinkedResult = await processTelegramBotUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      from: { id: 67890, is_bot: false, username: "unlinked_user" },
      chat: { id: 67890, type: "private" },
      text: "hello",
    },
  }, { chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(unlinkedResult.action, "telegram_bot_link_required");
  assert.equal(chatCalls.length, 1);
  assert.match(sentMessages.at(-1).text, /Link Telegram/);

  const groupResult = await processTelegramBotUpdate({
    update_id: 3,
    message: {
      message_id: 12,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: -100, type: "group" },
      text: "should not leak account chat",
    },
  }, { chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(groupResult.ignored, true);
  assert.equal(groupResult.reason, "non_private_chat");
  assert.equal(chatCalls.length, 1);
  assert.match(sentMessages.at(-1).text, /private Telegram chat/);

  const modeSetResult = await processTelegramBotUpdate({
    update_id: 4,
    callback_query: {
      id: "callback_1",
      from: { id: 12345, is_bot: false, username: "linked_user" },
      message: {
        message_id: 13,
        chat: { id: 12345, type: "private" },
      },
      data: "tn_mode:ft",
    },
  }, { answerCallbackQuery, chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(modeSetResult.action, "telegram_bot_mode_set");
  assert.equal(modeSetResult.mode, "Frontier Thinking");
  assert.equal(answeredCallbacks.at(-1).callbackQueryId, "callback_1");
  assert.match(answeredCallbacks.at(-1).text, /Frontier Thinking/);
  assert.match(sentMessages.at(-1).text, /Current mode: Frontier Thinking/);
  assert.ok(sentMessages.at(-1).replyMarkup?.inline_keyboard?.flat()?.some((button) => button.text.includes("[x] Frontier Thinking")));
  assert.equal(chatCalls.length, 1);

  const selectedModeResult = await processTelegramBotUpdate({
    update_id: 5,
    message: {
      message_id: 14,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "use selected mode",
    },
  }, { chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(selectedModeResult.action, "telegram_bot_chat");
  assert.equal(selectedModeResult.mode, "Frontier Thinking");
  assert.equal(chatCalls.length, 2);
  assert.equal(chatCalls[1].payload.mode, "Frontier Thinking");
  assert.equal(chatCalls[1].payload.message, "use selected mode");
  assert.equal(sentChatActions.length, 2);
  assert.deepEqual(sentChatActions.at(-1), { chatId: "12345", action: "typing" });
  assert.equal(sentMessages.at(-1).text, "reply:use selected mode");
  assert.equal(sentMessages.at(-1).replyMarkup, undefined);

  const balanceResult = await processTelegramBotUpdate({
    update_id: 6,
    callback_query: {
      id: "callback_2",
      from: { id: 12345, is_bot: false, username: "linked_user" },
      message: {
        message_id: 15,
        chat: { id: 12345, type: "private" },
      },
      data: "tn_balance",
    },
  }, { answerCallbackQuery, chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(balanceResult.action, "telegram_bot_balance");
  assert.match(sentMessages.at(-1).text, /Available credit:/);
  assert.equal(sentMessages.at(-1).replyMarkup, undefined);
  assert.equal(chatCalls.length, 2);

  const bareModeResult = await processTelegramBotUpdate({
    update_id: 7,
    message: {
      message_id: 16,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "mode",
    },
  }, { chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(bareModeResult.action, "telegram_bot_help");
  assert.match(sentMessages.at(-1).text, /Current mode: Frontier Thinking/);
  assert.ok(sentMessages.at(-1).replyMarkup?.inline_keyboard?.flat()?.some((button) => (
    button.text === "Discount Thinking" &&
    button.callback_data === "tn_mode:dt"
  )));
  assert.equal(chatCalls.length, 2);

  const bareBalanceResult = await processTelegramBotUpdate({
    update_id: 8,
    message: {
      message_id: 17,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "balance",
    },
  }, { chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(bareBalanceResult.action, "telegram_bot_balance");
  assert.match(sentMessages.at(-1).text, /Available credit:/);
  assert.equal(sentMessages.at(-1).replyMarkup, undefined);
  assert.equal(chatCalls.length, 2);

  const discountModeSetResult = await processTelegramBotUpdate({
    update_id: 9,
    callback_query: {
      id: "callback_3",
      from: { id: 12345, is_bot: false, username: "linked_user" },
      message: {
        message_id: 18,
        chat: { id: 12345, type: "private" },
      },
      data: "tn_mode:dt",
    },
  }, { answerCallbackQuery, chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(discountModeSetResult.action, "telegram_bot_mode_set");
  assert.equal(discountModeSetResult.mode, "Discount Thinking");
  assert.equal(answeredCallbacks.at(-1).callbackQueryId, "callback_3");
  assert.match(answeredCallbacks.at(-1).text, /Discount Thinking/);
  assert.match(sentMessages.at(-1).text, /Current mode: Discount Thinking/);
  assert.ok(sentMessages.at(-1).replyMarkup?.inline_keyboard?.flat()?.some((button) => button.text.includes("[x] Discount Thinking")));
  assert.equal(chatCalls.length, 2);

  const selectedDiscountModeResult = await processTelegramBotUpdate({
    update_id: 10,
    message: {
      message_id: 19,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "use discount mode",
    },
  }, { chatExecutor, sendTelegramChatAction, sendTelegramMessage });

  assert.equal(selectedDiscountModeResult.action, "telegram_bot_chat");
  assert.equal(selectedDiscountModeResult.mode, "Discount Thinking");
  assert.equal(chatCalls.length, 3);
  assert.equal(chatCalls[2].payload.mode, "Discount Thinking");
  assert.equal(chatCalls[2].payload.message, "use discount mode");
  assert.equal(chatCalls[2].options.source, "telegram_bot");
  assert.equal(sentMessages.at(-1).text, "reply:use discount mode");
  assert.equal(sentMessages.at(-1).replyMarkup, undefined);

  const events = await listTelegramBotEvents({
    providerUserId: "12345",
    chatId: "12345",
    limit: 100,
  });
  assert.equal(events.ok, true);
  assert.ok(events.events.some((event) => (
    event.direction === "inbound" &&
    event.eventType === "message" &&
    event.textPreview === "hello from telegram"
  )));
  assert.ok(events.events.some((event) => (
    event.direction === "outbound" &&
    event.eventType === "send_chat_action" &&
    event.textPreview === "typing"
  )));
  assert.ok(events.events.some((event) => (
    event.direction === "outbound" &&
    event.eventType === "send_message" &&
    event.accountId === account.id &&
    event.textPreview === "reply:hello from telegram"
  )));
  assert.ok(events.events.some((event) => (
    event.direction === "internal" &&
    event.eventType === "process_result" &&
    event.action === "telegram_bot_help"
  )));

  console.log(JSON.stringify({
    ok: true,
    accountId: account.id,
    conversationId: linkedResult.conversationId,
    chatCalls: chatCalls.length,
    sentMessages: sentMessages.length,
    sentChatActions: sentChatActions.length,
    answeredCallbacks: answeredCallbacks.length,
    telegramBotEvents: events.events.length,
  }));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
