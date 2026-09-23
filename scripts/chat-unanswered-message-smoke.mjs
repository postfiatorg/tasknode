#!/usr/bin/env node
// A chat reply that is abandoned, fails, or is retried must never lose the
// user's message, double-count it, or send it to the model twice.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("chat_unanswered_smoke_database_url_required");
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.VERCEL_AI_GATEWAY_API_KEY = "fixture";
delete process.env.AMBIENT_API_KEY;

const { closePool, query } = await import("../server/db/pool.js");
const { executeChatStream } = await import("../server/chat-router.js");
const { appendChatUserMessage } = await import("../server/repositories/chat-conversations.js");

const suffix = randomUUID().slice(0, 8);
const accountId = `acct_unanswered_${suffix}`;
const conversationId = `account_${accountId}_chat_${suffix}`;
const userMessageId = `msg_${suffix}_user`;
const message = "do you realize chad is an ai agent or not";
const originalFetch = globalThis.fetch;
const sentBodies = [];

function turn(extra = {}) {
  return executeChatStream({
    accountId, conversationId, mode: "Kimi K3", message, userMessageId,
    assistantMessageId: `msg_${suffix}_assistant`,
    contextDocument: null, memoryContext: null, taskContext: null, jobsEssence: "",
    onDelta: () => {}, ...extra,
  });
}
const userRow = async () => (await query("SELECT metadata_json FROM chat_messages WHERE id = $1", [userMessageId])).rows;
const messageCount = async () => Number((await query("SELECT message_count FROM chat_conversations WHERE id = $1", [conversationId])).rows[0]?.message_count || 0);

try {
  // 1. The user gives up while the model is still thinking.
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(turn({ signal: controller.signal }), { status: 499 });
  let rows = await userRow();
  assert.equal(rows.length, 1, "abandoned message is kept");
  assert.equal(rows[0].metadata_json.reply.state, "abandoned");
  assert.equal(await messageCount(), 1);

  // 2. Retrying the same message against a failing provider keeps one row and one count.
  globalThis.fetch = async () => new Response("upstream down", { status: 500 });
  await assert.rejects(turn());
  rows = await userRow();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metadata_json.reply.state, "failed");
  assert.equal(await messageCount(), 1, "a repeated failure is not double counted");

  // 3. A successful retry answers the kept message and sends it to the model once.
  globalThis.fetch = async (_url, init) => {
    sentBodies.push(String(init.body));
    const usage = { prompt_tokens: 10, completion_tokens: 3, cost: 0.001 };
    return new Response(`data: ${JSON.stringify({ model: "moonshotai/kimi-k3", choices: [{ delta: { content: "Yes." } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  const result = await turn();
  assert.equal(result.assistant.body, "Yes.");
  rows = await userRow();
  assert.equal(rows[0].metadata_json.reply, undefined, "a successful retry clears the unanswered mark");
  assert.equal(await messageCount(), 2);
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0].split(message).length - 1, 1, "the kept message is not replayed as history");

  // 4. Another account cannot overwrite a message by reusing its id.
  const otherAccount = `acct_other_${suffix}`;
  await assert.rejects(appendChatUserMessage({
    accountId: otherAccount, conversationId: `account_${otherAccount}_chat_${suffix}`,
    userMessage: "overwrite", userMessageId,
  }), { status: 409 });
  assert.equal((await query("SELECT body FROM chat_messages WHERE id = $1", [userMessageId])).rows[0].body, message);

  console.log("chat unanswered message smoke ok: abandoned, failed, retried, and cross-account reuse");
} finally {
  globalThis.fetch = originalFetch;
  await query("DELETE FROM chat_conversations WHERE id LIKE $1", [`%_chat_${suffix}`]).catch(() => {});
  await query("DELETE FROM chat_messages WHERE conversation_id LIKE $1", [`%_chat_${suffix}`]).catch(() => {});
  await closePool();
}
