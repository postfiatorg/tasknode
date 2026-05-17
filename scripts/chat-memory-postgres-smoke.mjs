import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool } from "../server/db/pool.js";
import { appendChatTurn } from "../server/repositories/chat-billing.js";
import {
  chatMemoryJobSource,
  claimChatMemoryJobs,
  completeChatMemoryJob,
  enqueueChatMemoryJob,
  listChatMemory,
} from "../server/repositories/chat-memory.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for chat memory Postgres smoke.");
}
if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

await migrateDatabase();

const suffix = randomUUID().slice(0, 8);
const accountId = `acct_memory_pg_smoke_${suffix}`;
const conversationId = `account_${accountId}_memory`;

const turn = await appendChatTurn({
  accountId,
  conversationId,
  mode: "Private Instant",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  responseId: `or_${suffix}`,
  userMessage: "Remember that I prefer concise implementation plans.",
  assistantMessage: "I will keep future plans concise and focus on implementation checkpoints.",
  usage: {
    inputTokens: 20,
    outputTokens: 18,
    totalTokens: 38,
    costUsd: 0,
  },
});

const queued = await enqueueChatMemoryJob({
  accountId,
  conversationId,
  userMessageId: turn.user.id,
  assistantMessageId: turn.assistant.id,
});
assert.equal(queued.queued, true);

const replay = await enqueueChatMemoryJob({
  accountId,
  conversationId,
  userMessageId: turn.user.id,
  assistantMessageId: turn.assistant.id,
});
assert.equal(replay.queued, false);

const jobs = await claimChatMemoryJobs({ limit: 1 });
assert.equal(jobs.length, 1);
const source = await chatMemoryJobSource(jobs[0]);
assert.match(source.user_body, /concise implementation plans/);

await completeChatMemoryJob({
  job: source,
  summary: {
    conversationTitle: source.conversation_title,
    userRequestSummary: "The user asked the system to remember a preference for concise implementation plans.",
    systemResponseSummary: "The assistant acknowledged the preference and committed to concise checkpoints.",
    memoryText: "Remember that this account prefers concise implementation plans with concrete checkpoints.",
    sourceUserExcerpt: source.user_body,
    sourceAssistantExcerpt: source.assistant_body,
    provider: "smoke",
    model: "deterministic",
    promptVersion: "smoke",
    usage: {},
  },
});

const memory = await listChatMemory({ accountId });
assert.equal(memory.entries.length, 1);
assert.match(memory.entries[0].memoryText, /concise implementation plans/);

console.log(`chat memory postgres smoke ok: ${accountId}`);
await closePool();
