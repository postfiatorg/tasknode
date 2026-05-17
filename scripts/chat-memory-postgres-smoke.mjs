import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import { appendChatTurn } from "../server/repositories/chat-billing.js";
import {
  chatMemoryJobSource,
  claimChatMemoryJobs,
  claimDeepMemoryJobs,
  completeChatMemoryJob,
  completeDeepMemoryJob,
  deepMemoryBlockSize,
  deepMemoryJobSource,
  enqueueChatMemoryJob,
  getChatMemoryContext,
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
const isolationAccountId = `${accountId}_isolation`;
const isolationConversationId = `account_${isolationAccountId}_memory`;

const isolationTurn = await appendChatTurn({
  accountId: isolationAccountId,
  conversationId: isolationConversationId,
  mode: "Private Instant",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  responseId: `or_${suffix}_isolation`,
  userMessage: "This belongs only to the isolation account.",
  assistantMessage: "Isolation response.",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    costUsd: 0,
  },
});

const mismatchedJobId = `memjob_mismatch_${suffix}`;
await query(
  `
    INSERT INTO chat_memory_jobs (
      id,
      account_id,
      conversation_id,
      user_message_id,
      assistant_message_id
    )
    VALUES ($1, $2, $3, $4, $5)
  `,
  [
    mismatchedJobId,
    accountId,
    conversationId,
    isolationTurn.user.id,
    isolationTurn.assistant.id,
  ]
);
const mismatchedSource = await chatMemoryJobSource({ id: mismatchedJobId });
assert.equal(mismatchedSource, null);
await query("DELETE FROM chat_memory_jobs WHERE id = $1", [mismatchedJobId]);

for (let index = 1; index <= deepMemoryBlockSize; index += 1) {
  const turn = await appendChatTurn({
    accountId,
    conversationId,
    mode: "Private Instant",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    responseId: `or_${suffix}_${index}`,
    userMessage: `Remember concise implementation plan preference ${index}.`,
    assistantMessage: `Acknowledged concise checkpoint preference ${index}.`,
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

  if (index === 1) {
    const replay = await enqueueChatMemoryJob({
      accountId,
      conversationId,
      userMessageId: turn.user.id,
      assistantMessageId: turn.assistant.id,
    });
    assert.equal(replay.queued, false);
  }

  const jobs = await claimChatMemoryJobs({ limit: 1 });
  assert.equal(jobs.length, 1);
  const source = await chatMemoryJobSource(jobs[0]);
  assert.match(source.user_body, /concise implementation plan preference/);

  const completed = await completeChatMemoryJob({
    job: source,
    summary: {
      conversationTitle: source.conversation_title,
      userRequestSummary: `The user asked the system to remember a concise implementation preference ${index}.`,
      systemResponseSummary: `The assistant acknowledged the preference and committed to concise checkpoints ${index}.`,
      memoryText: `Remember that this account prefers concise implementation plans with concrete checkpoints ${index}.`,
      sourceUserExcerpt: source.user_body,
      sourceAssistantExcerpt: source.assistant_body,
      provider: "smoke",
      model: "deterministic",
      promptVersion: "smoke",
      usage: {},
    },
  });
  assert.equal(completed.deepMemoryJob.queued, index === deepMemoryBlockSize);
}

const deepJobs = await claimDeepMemoryJobs({ limit: 1 });
assert.equal(deepJobs.length, 1);
assert.equal(deepJobs[0].block_index, 1);
const deepSource = await deepMemoryJobSource(deepJobs[0]);
assert.equal(deepSource.entries.length, deepMemoryBlockSize);

await completeDeepMemoryJob({
  job: deepSource,
  summary: {
    userRequestSummary: [
      "- The user repeatedly asked the system to remember concise implementation-plan preferences.",
      "- The user wants future implementation plans to stay concrete and checkpoint driven.",
    ].join("\n"),
    systemResponseSummary: [
      "- The assistant repeatedly acknowledged the concise-plan preference.",
      "- The assistant committed to using concrete checkpoints in future planning.",
    ].join("\n"),
    memoryText:
      "The user is exploring a concise planning style for implementation work. The system responded by acknowledging the recurring preference and framing it as durable memory. Future responses should keep plans concrete, short, and checkpoint oriented.",
    sourceUserExcerpt: "36 deterministic memory summaries.",
    sourceAssistantExcerpt: "Deep memory smoke synthesis.",
    provider: "smoke",
    model: "deterministic",
    promptVersion: "smoke_deep",
    usage: {},
  },
});

const memory = await listChatMemory({ accountId });
assert.equal(memory.entries.length, deepMemoryBlockSize + 1);
const deepEntries = memory.entries.filter((entry) => entry.kind === "deep_memory");
assert.equal(deepEntries.length, 1);
assert.match(deepEntries[0].memoryText, /concise planning style/);

const context = await getChatMemoryContext({ accountId, deepLimit: 3, turnLimit: 36 });
assert.equal(context.deepMemories.length, 1);
assert.equal(context.memories.length, deepMemoryBlockSize);
assert.match(context.deepMemories[0].userRequestSummary, /remember concise implementation-plan preferences/);
assert.match(context.deepMemories[0].systemResponseSummary, /acknowledged the concise-plan preference/);
assert.match(context.deepMemories[0].memoryText, /concise planning style/);
assert.match(context.memories[0].memoryText, /concrete checkpoints/);

console.log(`chat memory postgres smoke ok: ${accountId}`);
await closePool();
