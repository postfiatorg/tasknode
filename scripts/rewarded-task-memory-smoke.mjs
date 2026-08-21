import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.DATABASE_URL = "";

const {
  buildRewardedTaskMemoryPacket,
  enqueueRewardedTaskMemory,
} = await import("../server/repositories/task-reward-memory.js");

const implementationPacket = buildRewardedTaskMemoryPacket({
  projection: {
    accountId: "account_reward_memory_smoke",
    taskId: "task_reward_memory_implementation",
    status: "rewarded",
    title: "Ship cache-aware inference billing",
    description: "Implement cache accounting, regression coverage, and operational status output.",
    taskKind: "development",
    rewardOffer: 250,
    rewardActual: 225,
    updatedAt: "2026-08-12T12:00:00.000Z",
  },
  events: [
    {
      schema: "pf.task.submission.v1",
      observedAt: "2026-08-12T11:00:00.000Z",
      payload: { evidence: "Added cache hit/miss accounting and smoke coverage." },
    },
    {
      schema: "pf.reward.v1",
      observedAt: "2026-08-12T12:00:00.000Z",
      payload: { reward_score: { user_feedback: "Verified across the billing path." } },
    },
  ],
});

assert.equal(implementationPacket.sourceJson.schema, "pf.memory.rewarded_task_source.v1");
assert.equal(implementationPacket.sourceJson.task.reward_actual_pft, 225);
assert.equal(implementationPacket.sourceJson.events.length, 2);
assert.match(implementationPacket.sourceText, /cache hit\/miss accounting/);
assert.equal(implementationPacket.sourcePacketDigest.length, 64);

const adjacentResearchPacket = buildRewardedTaskMemoryPacket({
  projection: {
    account_id: "account_reward_memory_smoke",
    task_id: "task_reward_memory_research",
    status: "paid",
    title: "Compare inference providers",
    description: "Document capability, privacy, and reliability tradeoffs.",
    task_kind: "research",
    reward_actual_pft: "80",
  },
  events: [{ event_type: "pf.reward.v1", payload_json: { reason: "Clear evidence-backed comparison." } }],
});
assert.notEqual(adjacentResearchPacket.sourcePacketDigest, implementationPacket.sourcePacketDigest);
assert.match(adjacentResearchPacket.sourceText, /research/);

const noDatabase = await enqueueRewardedTaskMemory({
  projection: {
    accountId: "account_reward_memory_smoke",
    taskId: "task_no_database",
    status: "rewarded",
    rewardActual: 10,
  },
});
assert.deepEqual(noDatabase, { queued: false, reason: "database_not_configured" });

const [migration, repository, worker, prompt] = await Promise.all([
  readFile(new URL("../server/db/migrations/108_rewarded_task_memory.sql", import.meta.url), "utf8"),
  readFile(new URL("../server/repositories/task-reward-memory.js", import.meta.url), "utf8"),
  readFile(new URL("../server/chat-memory-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../prompts/memory/rewarded_task_memory_v1.md", import.meta.url), "utf8"),
]);

assert.match(migration, /UNIQUE INDEX[\s\S]*task_id/);
assert.match(repository, /ON CONFLICT \(task_id\)/);
assert.match(repository, /kind, deep_memory_block_index[\s\S]*'rewarded_task_memory'/);
assert.match(worker, /fetchRewardedTaskMemorySummary[\s\S]*capability: "fast_text"[\s\S]*allowCapacityFallback: false/);
assert.match(worker, /enqueueMissingRewardedTaskMemoryJobs/);
assert.match(prompt, /durable user memory/i);
assert.match(prompt, /Do not copy secrets/i);

console.log("rewarded task memory smoke ok");
