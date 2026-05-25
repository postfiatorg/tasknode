import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(tmpdir(), "tasknode-telegram-bot-"));
process.env.TASKNODE_STORE_PATH = path.join(tempDir, "runtime-store.json");
process.env.TASKNODE_ENV = "test";
process.env.TELEGRAM_AUTH_BOT_TOKEN = "123456:tasknode-telegram-secret";

try {
  const { getOrCreateProviderAccount } = await import("../server/runtime-store.js");
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
  const chatExecutor = async (payload, method) => {
    chatCalls.push({ payload, method });
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

  const linkedResult = await processTelegramBotUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "hello from telegram",
    },
  }, { chatExecutor, sendTelegramMessage });

  assert.equal(linkedResult.ok, true);
  assert.equal(linkedResult.action, "telegram_bot_chat");
  assert.equal(linkedResult.accountId, account.id);
  assert.match(linkedResult.conversationId, /^account_.+_telegram_12345$/);
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0].method, "POST");
  assert.equal(chatCalls[0].payload.accountId, account.id);
  assert.equal(chatCalls[0].payload.mode, "Private Instant");
  assert.equal(chatCalls[0].payload.message, "hello from telegram");
  assert.equal(sentMessages.at(-1).chatId, "12345");
  assert.equal(sentMessages.at(-1).text, "reply:hello from telegram");
  assert.ok(sentMessages.at(-1).replyMarkup?.inline_keyboard?.flat()?.some((button) => button.callback_data === "tn_mode:ft"));

  const duplicateResult = await processTelegramBotUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "hello from telegram",
    },
  }, { chatExecutor, sendTelegramMessage });

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
  }, { chatExecutor, sendTelegramMessage });

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
  }, { chatExecutor, sendTelegramMessage });

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
  }, { answerCallbackQuery, chatExecutor, sendTelegramMessage });

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
  }, { chatExecutor, sendTelegramMessage });

  assert.equal(selectedModeResult.action, "telegram_bot_chat");
  assert.equal(selectedModeResult.mode, "Frontier Thinking");
  assert.equal(chatCalls.length, 2);
  assert.equal(chatCalls[1].payload.mode, "Frontier Thinking");
  assert.equal(chatCalls[1].payload.message, "use selected mode");

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
  }, { answerCallbackQuery, chatExecutor, sendTelegramMessage });

  assert.equal(balanceResult.action, "telegram_bot_balance");
  assert.match(sentMessages.at(-1).text, /Available credit:/);
  assert.equal(chatCalls.length, 2);

  const bareModeResult = await processTelegramBotUpdate({
    update_id: 7,
    message: {
      message_id: 16,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "mode",
    },
  }, { chatExecutor, sendTelegramMessage });

  assert.equal(bareModeResult.action, "telegram_bot_help");
  assert.match(sentMessages.at(-1).text, /Current mode: Frontier Thinking/);
  assert.equal(chatCalls.length, 2);

  const bareBalanceResult = await processTelegramBotUpdate({
    update_id: 8,
    message: {
      message_id: 17,
      from: { id: 12345, is_bot: false, username: "linked_user" },
      chat: { id: 12345, type: "private" },
      text: "balance",
    },
  }, { chatExecutor, sendTelegramMessage });

  assert.equal(bareBalanceResult.action, "telegram_bot_balance");
  assert.match(sentMessages.at(-1).text, /Available credit:/);
  assert.equal(chatCalls.length, 2);

  console.log(JSON.stringify({
    ok: true,
    accountId: account.id,
    conversationId: linkedResult.conversationId,
    chatCalls: chatCalls.length,
    sentMessages: sentMessages.length,
    answeredCallbacks: answeredCallbacks.length,
  }));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
