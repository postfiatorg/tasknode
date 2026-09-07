import { inferenceCallGraph } from "./inference-call-graph.mjs";
import assert from "node:assert/strict";
import { inferenceChatCompletion, inferenceChatCompletionStream, inferenceFetchCompatibility, inferenceModels, resolveInferenceModel, INFERENCE_MODELS } from "../server/inference.js";
import { normalizeInferenceRequest } from "../server/inference-protocol.js";

const graph = inferenceCallGraph(["server/inference.js", "server/hive-group-provider.js", "server/hive-group-worker.js"]);
assert.deepEqual(graph.violations, [], "Hive inference and its reachable helpers must remain free of regular expressions");

const env = { VERCEL_AI_GATEWAY_API_KEY: "vercel-fixture", AMBIENT_API_KEY: "ambient-fixture",
  VERCEL_AI_GATEWAY_BASE_URL: "https://vercel.invalid/v1", AMBIENT_BASE_URL: "https://ambient.invalid/v1" };
const body = { model: INFERENCE_MODELS.structured, messages: [{ role: "user", content: "Return a JSON object with ok true." }], response_format: { type: "json_object" } };
const answer = (model = body.model, text = '{"ok":true}') => new Response(JSON.stringify({ id: "response_1", model,
  choices: [{ message: { content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 10 } },
}), { status: 200 });
const failure = (status) => new Response(JSON.stringify({ error: { message: "Private provider detail must not be logged" } }), { status });
const stream = (chunks) => new Response(new ReadableStream({ start(controller) {
  for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  controller.close();
} }), { status: 200 });
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (content) => ({ id: "stream_1", model: body.model, choices: [{ delta: { content } }] });
const finish = { choices: [{ delta: {}, finish_reason: "stop" }] };
const codeIs = (code) => (error) => error.code === code;
let assertions = 0;

assert.equal(resolveInferenceModel({ model: "z-ai/glm-5.2", env: {} }), "zai/glm-5.3");
assert.equal(resolveInferenceModel({ capability: "instant_text", env: {} }), "zai/glm-5.3-flash");
assert.equal(resolveInferenceModel({ capability: "fast_text", env: {} }), INFERENCE_MODELS.fastText);
assert.equal(resolveInferenceModel({ model: body.model, hasImages: true, env: {} }), INFERENCE_MODELS.vision);
assert.equal(resolveInferenceModel({ model: INFERENCE_MODELS.instantText, hasImages: true, env: {} }), INFERENCE_MODELS.instantText);
assert.throws(() => resolveInferenceModel({ model: "invented/model", env: {} }), codeIs("inference_model_unsupported"));
assert.throws(() => resolveInferenceModel({ capability: "vision_text", env: { INFERENCE_MODEL_VISION: body.model } }), codeIs("inference_image_model_required"));
assertions += 7;

let calls = [];
const primary = await inferenceChatCompletion({ env, body, fetchImpl: async (url, init) => {
  calls.push(url);
  assert.equal(init.headers.authorization, "Bearer vercel-fixture");
  assert.equal(JSON.parse(init.body).model, "zai/glm-5.3");
  return answer();
} });
assert.equal(primary.provider, "vercel");
assert.equal(primary.body.tasknode_inference.provider, "vercel");
assert.equal(primary.usage.prompt_tokens_details.cached_tokens, 10);
assert.deepEqual(calls, ["https://vercel.invalid/v1/chat/completions"]);
assertions += 6;

for (const status of [401, 402, 403, 404, 408, 429, 500, 503]) {
  calls = [];
  const result = await inferenceChatCompletion({ env, body, fetchImpl: async (url, init) => {
    calls.push(url);
    if (url.startsWith("https://vercel.invalid")) return failure(status);
    assert.equal(init.headers.authorization, "Bearer ambient-fixture");
    assert.equal(JSON.parse(init.body).model, "z-ai/glm-5.2");
    return answer("z-ai/glm-5.2");
  } });
  assert.equal(result.provider, "ambient");
  assert.equal(result.model, "z-ai/glm-5.2");
  assert.equal(result.fallbackFrom, "vercel");
  assert.equal(result.fallbackReason, `inference_http_${status}`);
  assert.equal(calls.length, 2);
  assertions += 7;
}

for (const mode of ["network", "headers_timeout", "body_timeout"]) {
  const result = await inferenceChatCompletion({ env, body, timeoutMs: 15, fetchImpl: async (url) => {
    if (url.startsWith("https://ambient.invalid")) return answer("z-ai/glm-5.2");
    if (mode === "network") throw new TypeError("socket lost");
    if (mode === "headers_timeout") return new Promise(() => {});
    return { ok: true, status: 200, text: () => new Promise(() => {}) };
  } });
  assert.equal(result.provider, "ambient");
  assert.equal(result.attempts.length, 2);
  assertions += 2;
}

calls = [];
await assert.rejects(inferenceChatCompletion({ env, body, fetchImpl: async (url) => { calls.push(url); return failure(400); } }), codeIs("inference_http_400"));
assert.equal(calls.length, 1);
await assert.rejects(inferenceChatCompletion({ env: {}, body }), codeIs("inference_not_configured"));
await assert.rejects(inferenceChatCompletion({ env: { ...env, INFERENCE_AMBIENT_BACKUP_ENABLED: "false" }, body, fetchImpl: async () => failure(503) }), codeIs("inference_http_503"));
const backupOnly = await inferenceChatCompletion({ env: { AMBIENT_API_KEY: "backup", AMBIENT_BASE_URL: env.AMBIENT_BASE_URL }, body, fetchImpl: async () => answer("z-ai/glm-5.2") });
assert.equal(backupOnly.provider, "ambient");
assert.equal(backupOnly.fallbackReason, "primary_not_configured");
const cancelled = new AbortController();
cancelled.abort();
calls = [];
await assert.rejects(inferenceChatCompletion({ env, body, signal: cancelled.signal, fetchImpl: async (url) => { calls.push(url); return answer(); } }), codeIs("inference_aborted"));
assert.equal(calls.length, 0);
assertions += 8;

const bytes = new TextEncoder().encode(event(delta("A 🌍")) + event(finish) + event({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 3 } }) + "data: [DONE]\r\n\r\n");
let visible = "";
const streamed = await inferenceChatCompletionStream({ env, body, onDelta: (text) => { visible += text; }, fetchImpl: async () => stream([...bytes].map((byte) => new Uint8Array([byte]))) });
assert.equal(visible, "A 🌍");
assert.equal(streamed.text, visible);
assert.equal(streamed.usage.prompt_tokens, 21);
assert.equal(streamed.provider, "vercel");
assertions += 4;

calls = [];
visible = "";
const fallbackStream = await inferenceChatCompletionStream({ env, body, onDelta: (text) => { visible += text; }, fetchImpl: async (url) => {
  calls.push(url);
  return calls.length === 1 ? failure(503) : stream([event(delta("Backup answer")), event(finish)]);
} });
assert.equal(fallbackStream.provider, "ambient");
assert.equal(visible, "Backup answer");
assert.equal(calls.length, 2);
calls = [];
await assert.rejects(inferenceChatCompletionStream({ env, body, onDelta: () => {}, fetchImpl: async (url) => {
  calls.push(url);
  return stream([event(delta("Partial answer")), event({ error: { code: 503 } })]);
} }), codeIs("inference_http_503"));
assert.equal(calls.length, 1, "Never replay a stream after delivering content");
assertions += 5;

const searchBody = { ...body, messages: [{ role: "user", content: JSON.stringify({ query: "structured research query" }) }], tools: [{ type: "web_search", parameters: { engine: "exa", max_results: 3 } }] };
const search = normalizeInferenceRequest(searchBody, { env, capability: "research_text" });
assert.deepEqual(search.tools, [{ type: "vercel:exa_search", config: { query: "structured research query", num_results: 3 } }]);
assert.equal(search.tool_choice, "required");
assert.equal(Object.hasOwn(search, "enabled_tools"), false);
const backupSearch = normalizeInferenceRequest(searchBody, { provider: "ambient", env, capability: "research_text" });
assert.deepEqual(backupSearch.enabled_tools, ["websearch"]);
assert.equal(Object.hasOwn(backupSearch, "tools"), false);
const imageRequest = normalizeInferenceRequest({ ...body, messages: [{ role: "user", content: [{ type: "input_image", url: "https://images.invalid/example.png" }] }] }, { env });
assert.equal(imageRequest.model, INFERENCE_MODELS.vision);
assert.equal(imageRequest.messages[0].content[0].type, "image_url");
assertions += 7;

let round = 0;
const toolsResult = await inferenceChatCompletion({ env: { AMBIENT_API_KEY: "backup", AMBIENT_BASE_URL: env.AMBIENT_BASE_URL }, body: searchBody,
  capability: "research_text", fetchImpl: async (url) => {
    if (url.endsWith("/tools")) return new Response(JSON.stringify({ tool_calls: [{ id: "search_1", content: { success: true, results: [] } }] }));
    round += 1;
    if (round === 1) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "search_1", function: { name: "websearch", arguments: "{}" } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    return answer("z-ai/glm-5.2");
  } });
assert.equal(toolsResult.toolRounds, 1);
assert.equal(toolsResult.usage.prompt_tokens, 25);
assertions += 2;

const compat = await inferenceFetchCompatibility(async (url) => url.startsWith("https://vercel.invalid") ? failure(429) : answer("z-ai/glm-5.2"), "", { body: JSON.stringify(body) }, { env });
assert.equal((await compat.json()).tasknode_inference.provider, "ambient");
const concurrent = await Promise.all([0, 1].map((n) => inferenceChatCompletion({ env, body, fetchImpl: async (url) => n === 1 && url.startsWith("https://vercel.invalid") ? failure(503) : answer(n === 1 ? "z-ai/glm-5.2" : body.model) })));
assert.deepEqual(concurrent.map((result) => result.provider), ["vercel", "ambient"]);
const catalogue = await inferenceModels({ env: { ...env, VERCEL_AI_GATEWAY_BASE_URL: "https://catalogue.invalid" }, fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: body.model, pricing: { input: "0.0000014", output: "0.0000044" } }] })) });
assert.equal(catalogue._meta.provider, "vercel");
assert.equal(catalogue.data[0].id, body.model);
assertions += 4;
console.log(JSON.stringify({ ok: true, assertions, boundaries: ["routing", "models", "backup", "timeouts", "cancellation", "streaming", "search", "vision", "usage", "compatibility", "concurrency", "catalogue"] }));
