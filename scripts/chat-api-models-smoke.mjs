import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "chat-api-models-"));
process.env.TASKNODE_STORE_PATH = join(directory, "runtime.json");
process.env.TASKNODE_DATABASE_ENABLED = "false";
process.env.VERCEL_AI_GATEWAY_API_KEY = "fixture-key";
process.env.AMBIENT_API_KEY = "fixture-backup";
process.env.INFERENCE_MODEL_REASONING = "zai/glm-5.3";
process.env.INFERENCE_MODEL_VISION = "moonshotai/kimi-k2.7-code";
const { apiChatModels } = await import("../server/chat-api-models.js");
const { modelForMode, chatExecutionStatus, actualChatCost, chatProviderTimeoutMs } = await import("../server/chat-mode-runtime.js");
const { chatModes } = await import("../server/product-chat-contracts.js");
const { normalizeInferenceRequest, inferenceChatCompletion, inferenceChatCompletionStream } = await import("../server/inference.js");
const { openRouterUsage } = await import("../server/chat-provider-usage.js");
const { appendChatTurn, usageLedger } = await import("../server/repositories/chat-billing.js");
const { chatEstimate } = await import("../server/chat-estimate.js");
const expectedRates = [[10, 1, 50], [3, 0.3, 15]];
try {
  let index = 0;
  for (const [mode, config] of Object.entries(apiChatModels)) {
    assert.deepEqual([config.inputUsdPerMillion, config.inputCacheHitUsdPerMillion, config.outputUsdPerMillion], expectedRates[index++]);
    assert.equal(modelForMode(mode), config.defaultModel);
    assert.equal(chatProviderTimeoutMs({ mode }), 300000);
    const option = chatModes().find(item => item.label === mode);
    assert.equal(option.enabled, true);
    assert.equal(option.backupConfigured, false);
    assert.equal(option.billingPolicy, "provider_api_cost");
    assert.ok(option.description.includes("API rates"));
    assert.equal(chatModes({ signedOut: true }).find(item => item.label === mode).enabled, false);
    const body = { model: config.defaultModel, messages: [{ role: "user", content: "Reply with ready." }], max_tokens: 128 };
    const imageBody = { ...body, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] };
    assert.equal(normalizeInferenceRequest(imageBody, { capability: "selected_model" }).model, config.defaultModel);
    const estimate = chatEstimate({ mode, persona: "odv", message: "Reply with ready." });
    assert.equal(estimate.model, config.defaultModel);
    assert.equal(estimate.estimatedTokenUsd, actualChatCost(mode, { inputTokens: estimate.inputTokens, outputTokens: estimate.estimatedOutputTokens }));
    const reply = { id: "fixture", model: config.defaultModel, usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } }, choices: [{ message: { content: "ready", provider_metadata: { gateway: { cost: "0.012345" } } }, finish_reason: "stop" }] };
    const result = await inferenceChatCompletion({ body, capability: "selected_model", fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).model, config.defaultModel);
      return Response.json(reply);
    } });
    const usage = openRouterUsage(result.body, mode);
    assert.equal(usage.costUsd, 0.012345);
    assert.equal(usage.costSource, "provider_api_cost");
    const chunks = [
      { model: config.defaultModel, choices: [{ delta: { content: "ready" } }] },
      { choices: [{ delta: { provider_metadata: { gateway: { cost: "0.012345" } } }, finish_reason: "stop" }], usage: reply.usage },
    ];
    const stream = await inferenceChatCompletionStream({ body, capability: "selected_model", fetchImpl: async () => new Response(chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n") });
    assert.equal(stream.text, "ready");
    assert.equal(openRouterUsage(stream.body, mode).costUsd, usage.costUsd);
    assert.equal(openRouterUsage({ ...reply, choices: [], usage: { ...reply.usage, cost: 0 } }, mode).costUsd, 0);
    assert.throws(() => openRouterUsage({ usage: reply.usage }, mode), error => error.message === "chat_provider_cost_missing");
    let calls = 0;
    await assert.rejects(inferenceChatCompletion({ body, capability: "selected_model", fetchImpl: async () => { calls++; return Response.json({ error: { message: "unavailable" } }, { status: 503 }); } }));
    assert.equal(calls, 1, "selected models must never be replaced by the backup");
    const key = process.env.VERCEL_AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_API_KEY;
    assert.equal(chatExecutionStatus(mode).enabled, false);
    await assert.rejects(inferenceChatCompletion({ body, capability: "selected_model", fetchImpl: async () => { throw new Error("must not call backup"); } }), error => error.code === "inference_not_configured");
    process.env.VERCEL_AI_GATEWAY_API_KEY = key;
    await appendChatTurn({ accountId: "api_model_fixture", conversationId: "api-model-" + index, mode, provider: "vercel", model: config.defaultModel, userMessage: "Reply with ready.", assistantMessage: "ready", usage });
  }
  assert.ok(!chatModes().some(mode => mode.label.includes("Fable")));
  const dedicated = { VERCEL_ASTRA_API_KEY: "astra-only", VERCEL_KIMI_API_KEY: "kimi-only", INFERENCE_AMBIENT_BACKUP_ENABLED: "false" };
  for (const [mode, config] of Object.entries(apiChatModels)) {
    const expectedKey = mode === "GPT-6 Astra" ? "astra-only" : "kimi-only";
    await inferenceChatCompletion({ body: { model: config.defaultModel, messages: [{ role: "user", content: "ready" }] }, capability: "selected_model", env: dedicated, fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, "Bearer " + expectedKey);
      return Response.json({ model: config.defaultModel, choices: [{ message: { content: "ready" }, finish_reason: "stop" }] });
    } });
  }
  const generic = process.env.VERCEL_AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_AI_GATEWAY_API_KEY;
  Object.assign(process.env, dedicated);
  assert.equal(chatExecutionStatus("GPT-6 Astra").enabled, true);
  assert.equal(chatExecutionStatus("Kimi K3").enabled, true);
  delete process.env.VERCEL_ASTRA_API_KEY;
  assert.equal(chatExecutionStatus("GPT-6 Astra").enabled, false);
  assert.equal(chatExecutionStatus("Kimi K3").enabled, true);
  delete process.env.VERCEL_KIMI_API_KEY;
  process.env.VERCEL_AI_GATEWAY_API_KEY = generic;
  const ledger = await usageLedger({ accountId: "api_model_fixture" });
  assert.equal(ledger.entries.length, 2);
  for (const entry of ledger.entries) assert.equal(entry.amountUsd, 0.012345);
  assert.equal(actualChatCost("GPT-6 Astra", { inputTokens: 272001, outputTokens: 1000 }), 5.51502);
  const legacy = openRouterUsage({ usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 99 } }, "Thinking");
  assert.equal(legacy.costUsd, actualChatCost("Thinking", { inputTokens: 1000, outputTokens: 100 }));
  console.log("chat API models smoke passed: 2 exact models, images, estimates, streamed costs, ledger debits, missing-cost guard, no substitution");
} finally {
  await rm(directory, { recursive: true, force: true });
}
