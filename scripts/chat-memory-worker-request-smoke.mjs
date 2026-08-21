import assert from "node:assert/strict";

process.env.TASKNODE_MEMORY_MAX_TOKENS = "700";
process.env.TASKNODE_DEEP_MEMORY_MAX_TOKENS = "1200";
process.env.TASKNODE_NETWORK_TASK_PROFILE_MAX_TOKENS = "400";

const worker = await import("../server/chat-memory-worker.js");

const defaultBody = worker.memoryOpenRouterRequestBody({
  messages: [{ role: "system", content: "Return JSON." }],
  maxTokens: worker.turnMemoryMaxTokens(),
});

assert.equal(defaultBody.model, "deepseek/deepseek-v4-flash-0731");
assert.equal(defaultBody.max_tokens, 900);
assert.deepEqual(defaultBody.reasoning, { effort: "none", exclude: true });
assert.deepEqual(defaultBody.response_format, { type: "json_object" });

assert.equal(worker.deepMemoryMaxTokens(), 3500);
assert.equal(worker.networkTaskProfileMaxTokens(), 900);
assert.equal(worker.rewardedTaskMemoryMaxTokens(), 1200);

process.env.TASKNODE_MEMORY_MODEL = "custom/memory-model";
process.env.TASKNODE_MEMORY_MAX_TOKENS = "not-a-number";

const configuredBody = worker.memoryOpenRouterRequestBody({
  messages: [{ role: "user", content: "{}" }],
});

assert.equal(configuredBody.model, "custom/memory-model");
assert.equal(configuredBody.max_tokens, 1200);
assert.equal(configuredBody.provider, undefined);

console.log("chat memory worker request smoke ok");
