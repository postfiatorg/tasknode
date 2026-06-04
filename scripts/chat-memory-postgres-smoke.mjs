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
  clearChatMemoryEntriesByKind,
  deepMemoryBlockSize,
  deleteChatMemoryEntry,
  deepMemoryJobSource,
  enqueueChatMemoryJob,
  enqueueMissingDeepMemoryJobs,
  getChatMemoryContext,
  listChatMemory,
} from "../server/repositories/chat-memory.js";
import { resetNetworkTaskProfileMemory } from "../server/repositories/network-task-profile.js";

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
const sourceEntryIds = jsonArray(deepJobs[0].source_entry_ids);
assert.equal(sourceEntryIds.length, deepMemoryBlockSize);

const driftEntryId = `mem_drift_${suffix}`;
await query(
  `
    INSERT INTO chat_memory_entries (
      id,
      account_id,
      conversation_id,
      conversation_title,
      user_message_id,
      assistant_message_id,
      user_request_summary,
      system_response_summary,
      memory_text,
      kind,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'turn_memory', now() - interval '1 year')
  `,
  [
    driftEntryId,
    accountId,
    conversationId,
    "Drift entry",
    `msg_${suffix}_drift_user`,
    `msg_${suffix}_drift_assistant`,
    "This row is inserted after the deep job was created with an old timestamp.",
    "It would shift ordinal block membership if source rows were recomputed later.",
    "Deep-memory source snapshots must ignore this drift row.",
  ]
);

const deepSource = await deepMemoryJobSource(deepJobs[0]);
assert.equal(deepSource.entries.length, deepMemoryBlockSize);
assert.equal(deepSource.entries.some((entry) => entry.id === driftEntryId), false);
assert.deepEqual(deepSource.entries.map((entry) => entry.id), sourceEntryIds);

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

await query(
  "DELETE FROM chat_memory_entries WHERE account_id = $1 AND kind = 'deep_memory'",
  [accountId]
);
const repairedDeepMemory = await enqueueMissingDeepMemoryJobs({ accountId });
assert.equal(repairedDeepMemory.ok, true);
assert.equal(repairedDeepMemory.requeued, 1);
const repairedDeepJobs = await claimDeepMemoryJobs({ limit: 1 });
assert.equal(repairedDeepJobs.length, 1);
assert.equal(repairedDeepJobs[0].block_index, 1);
const repairedDeepSource = await deepMemoryJobSource(repairedDeepJobs[0]);
assert.deepEqual(repairedDeepSource.entries.map((entry) => entry.id), sourceEntryIds);
await completeDeepMemoryJob({
  job: repairedDeepSource,
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
      "Repair-stable concise planning style memory. A missing deep-memory row was regenerated from the stored 36-row source snapshot.",
    sourceUserExcerpt: "36 deterministic memory summaries.",
    sourceAssistantExcerpt: "Repaired deep memory smoke synthesis.",
    provider: "smoke",
    model: "deterministic",
    promptVersion: "smoke_deep",
    usage: {},
  },
});

await query("DELETE FROM chat_deep_memory_jobs WHERE id = $1", [deepJobs[0].id]);
const recreatedDeepJobId = `deepmemjob_recreated_${suffix}`;
await query(
  `
    INSERT INTO chat_deep_memory_jobs (
      id,
      account_id,
      block_index,
      status,
      source_entry_ids
    )
    VALUES ($1, $2, 1, 'processing', $3::jsonb)
  `,
  [recreatedDeepJobId, accountId, JSON.stringify(sourceEntryIds)]
);
const recreatedDeepSource = await deepMemoryJobSource({
  id: recreatedDeepJobId,
  account_id: accountId,
  block_index: 1,
  source_entry_ids: sourceEntryIds,
});
await completeDeepMemoryJob({
  job: recreatedDeepSource,
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
      "Retry-stable concise planning style memory. The user is exploring a concise planning style for implementation work. The system responded by acknowledging the recurring preference and framing it as durable memory.",
    sourceUserExcerpt: "36 deterministic memory summaries.",
    sourceAssistantExcerpt: "Recreated deep memory job smoke synthesis.",
    provider: "smoke",
    model: "deterministic",
    promptVersion: "smoke_deep",
    usage: {},
  },
});

const memory = await listChatMemory({ accountId });
assert.equal(memory.deepMemories.length, 1);
assert.equal(memory.memories.length, 36);
assert.equal(memory.entries.length, 37);
assert.equal(memory.counts.deepMemoryTotal, 1);
assert.equal(memory.counts.turnMemoryTotal, 37);
assert.equal(memory.counts.returnedDeepMemories, 1);
assert.equal(memory.counts.returnedMemories, 36);
assert.match(memory.deepMemories[0].memoryText, /Retry-stable concise planning style/);
assert.equal(memory.queue.turnJobs.total >= 0, true);

for (let overflowIndex = 0; overflowIndex < 80; overflowIndex += 1) {
  await query(
    `
      INSERT INTO chat_memory_entries (
        id,
        account_id,
        conversation_id,
        conversation_title,
        user_message_id,
        assistant_message_id,
        user_request_summary,
        system_response_summary,
        memory_text,
        kind,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'turn_memory', now() - ($10::int * interval '1 minute'))
    `,
    [
      `mem_overflow_${suffix}_${overflowIndex}`,
      accountId,
      conversationId,
      "Overflow turn",
      `msg_${suffix}_overflow_user_${overflowIndex}`,
      `msg_${suffix}_overflow_assistant_${overflowIndex}`,
      `Overflow user summary ${overflowIndex}.`,
      `Overflow assistant summary ${overflowIndex}.`,
      `Overflow memory text ${overflowIndex}.`,
      overflowIndex + 1,
    ]
  );
}

const overflowList = await listChatMemory({ accountId });
assert.equal(overflowList.deepMemories.length, 1);
assert.equal(overflowList.memories.length, 36);
assert.equal(overflowList.counts.deepMemoryTotal, 1);
assert.equal(overflowList.counts.turnMemoryTotal, 117);
assert.equal(overflowList.counts.returnedMemories, 36);
assert.match(overflowList.deepMemories[0].memoryText, /Retry-stable concise planning style/);

const context = await getChatMemoryContext({ accountId, deepLimit: 3, turnLimit: 36 });
assert.equal(context.deepMemories.length, 1);
assert.equal(context.memories.length, deepMemoryBlockSize);
assert.match(context.deepMemories[0].userRequestSummary, /remember concise implementation-plan preferences/);
assert.match(context.deepMemories[0].systemResponseSummary, /acknowledged the concise-plan preference/);
assert.match(context.deepMemories[0].memoryText, /concise planning style/);
assert.match(context.memories[0].memoryText, /concrete checkpoints/);

const deletedTurnMemory = await deleteChatMemoryEntry({ accountId, entryId: context.memories[0].id });
assert.equal(deletedTurnMemory.ok, true);
assert.equal(deletedTurnMemory.deleted, 1);
const deletedTurnLookup = await query("SELECT COUNT(*)::int AS count FROM chat_memory_entries WHERE id = $1", [context.memories[0].id]);
assert.equal(deletedTurnLookup.rows[0].count, 0);

const clearedDeepMemory = await clearChatMemoryEntriesByKind({ accountId, kind: "deep_memory" });
assert.equal(clearedDeepMemory.ok, true);
assert.equal(clearedDeepMemory.deleted, 1);
assert.equal(clearedDeepMemory.deletedJobs, 1);
const clearedDeepLookup = await query(
  "SELECT COUNT(*)::int AS count FROM chat_memory_entries WHERE account_id = $1 AND kind = 'deep_memory'",
  [accountId]
);
assert.equal(clearedDeepLookup.rows[0].count, 0);
const clearedDeepJobsLookup = await query(
  "SELECT COUNT(*)::int AS count FROM chat_deep_memory_jobs WHERE account_id = $1",
  [accountId]
);
assert.equal(clearedDeepJobsLookup.rows[0].count, 0);

await query(
  `
    INSERT INTO network_task_profile_jobs (
      id,
      account_id,
      status,
      reason,
      source_packet_digest,
      source_packet_json,
      source_packet_text
    )
    VALUES ($1, $2, 'pending', 'smoke', $3, '{}'::jsonb, 'smoke source')
  `,
  [`nettaskprofilejob_delete_${suffix}`, accountId, `digest_delete_${suffix}`]
);
await query(
  `
    INSERT INTO network_task_profiles (
      id,
      account_id,
      status,
      source_packet_digest,
      source_packet_json,
      source_packet_text,
      output_json,
      output_text,
      provider,
      model,
      prompt_version,
      completed_at
    )
    VALUES ($1, $2, 'completed', $3, '{}'::jsonb, 'smoke source', '{}'::jsonb, 'smoke output', 'smoke', 'smoke', 'network_task_profile_v2', now())
  `,
  [`nettaskprofile_delete_${suffix}`, accountId, `digest_delete_${suffix}`]
);
const resetProfile = await resetNetworkTaskProfileMemory({ accountId });
assert.equal(resetProfile.ok, true);
assert.equal(resetProfile.deleted.jobs, 1);
assert.equal(resetProfile.deleted.profiles, 1);
const resetProfileLookup = await query(
  `
    SELECT
      (SELECT COUNT(*)::int FROM network_task_profile_jobs WHERE account_id = $1) AS jobs,
      (SELECT COUNT(*)::int FROM network_task_profiles WHERE account_id = $1) AS profiles
  `,
  [accountId]
);
assert.deepEqual(resetProfileLookup.rows[0], { jobs: 0, profiles: 0 });

console.log(`chat memory postgres smoke ok: ${accountId}`);
await closePool();
