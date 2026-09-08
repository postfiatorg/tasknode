import assert from "node:assert/strict";

process.env.VERCEL_AI_GATEWAY_API_KEY = process.env.VERCEL_AI_GATEWAY_API_KEY || "ambient-test-key";
delete process.env.AMBIENT_MODEL_FAST_TEXT;
delete process.env.AMBIENT_MODEL_REASONING;

const {
  chatModePrices,
  chatExecutionStatus,
  isKnownChatMode,
  modelForMode,
  normalizedChatMode,
} = await import("../server/chat-router.js");
const { chatEstimate } = await import("../server/chat-estimate.js");
const { chatModes } = await import("../server/product-contracts.js");

assert.deepEqual(Object.keys(chatModePrices), ["Instant", "Thinking", "GPT-6 Astra", "Kimi K3", "Help"]);
assert.deepEqual(chatModes().map((mode) => mode.label), ["Instant", "Thinking", "GPT-6 Astra", "Kimi K3", "Help"]);

assert.equal(modelForMode("Instant"), "zai/glm-5.3-flash");
assert.equal(modelForMode("Thinking"), "zai/glm-5.3");
assert.equal(modelForMode("Help"), "deepseek/deepseek-v4-flash-0731");
assert.equal(chatExecutionStatus("Instant").provider, "vercel");
assert.equal(chatExecutionStatus("Thinking").provider, "vercel");

for (const legacy of ["Private Instant", "Frontier Instant"]) {
  assert.equal(isKnownChatMode(legacy), true);
  assert.equal(normalizedChatMode(legacy), "Instant");
}
for (const legacy of ["Private Thinking", "Discount Thinking", "Frontier Thinking"]) {
  assert.equal(isKnownChatMode(legacy), true);
  assert.equal(normalizedChatMode(legacy), "Thinking");
}

const contextEditEstimate = chatEstimate(
  { message: "Refine this context", mode: "context_edit", contextMode: "context_edit" },
  { contextDocument: null, memoryContext: null, taskContext: null, historyMessages: [], activeProposal: null }
);
assert.equal(contextEditEstimate.mode, "Thinking");
assert.equal(contextEditEstimate.model, "zai/glm-5.3");
assert.equal(contextEditEstimate.estimatedWebSearchCalls, 0);

console.log("chat mode deprecation smoke ok");
