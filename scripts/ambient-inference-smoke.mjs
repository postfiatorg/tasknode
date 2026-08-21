import assert from "node:assert/strict";
import {
  AMBIENT_MODELS,
  ambientChatCompletion,
  ambientChatCompletionStream,
  ambientModels,
  normalizeAmbientChatRequest,
  resolveAmbientModel,
} from "../server/ambient-inference.js";

const env = {
  AMBIENT_API_KEY: "ambient-test-key",
  AMBIENT_BASE_URL: "https://ambient.invalid/v1",
};

assert.equal(resolveAmbientModel({ model: "deepseek-v4-pro", capability: "strict_json", env }), AMBIENT_MODELS.structured);
assert.equal(resolveAmbientModel({ model: "deepseek/deepseek-v4-flash", capability: "fast_text", env }), AMBIENT_MODELS.fastText);

const normalized = normalizeAmbientChatRequest({
  model: "openai/gpt-5.4-mini",
  messages: [{ role: "developer", content: [{ type: "input_text", text: "hello" }] }],
  provider: { zdr: true, only: ["legacy"] },
  plugins: [{ id: "web" }],
  usage: { include: true },
  max_completion_tokens: 55,
}, { capability: "research_text", env });
assert.equal(normalized.model, AMBIENT_MODELS.research);
assert.equal(normalized.messages[0].role, "system");
assert.deepEqual(normalized.messages[0].content, [{ type: "text", text: "hello" }]);
assert.deepEqual(normalized.enabled_tools, ["websearch"]);
assert.equal(normalized.max_tokens, 55);
assert.equal("provider" in normalized, false);
assert.equal("plugins" in normalized, false);
assert.equal("usage" in normalized, false);

let captured = null;
const completion = await ambientChatCompletion({
  env,
  capability: "verification_vision",
  body: {
    model: "chat-latest",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What color?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    }],
    response_format: { type: "json_object" },
  },
  fetchImpl: async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      id: "ambient_1",
      model: AMBIENT_MODELS.vision,
      choices: [{ message: { content: "{\"color\":\"red\"}" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
assert.equal(captured.url, "https://ambient.invalid/v1/chat/completions");
assert.equal(captured.init.headers.authorization, "Bearer ambient-test-key");
assert.equal(captured.body.model, AMBIENT_MODELS.vision);
assert.equal(captured.body.messages[0].content[1].image_url.url, "data:image/png;base64,AAAA");
assert.equal(completion.text, "{\"color\":\"red\"}");

let toolRoundCalls = 0;
const researched = await ambientChatCompletion({
  env,
  capability: "research_text",
  body: {
    messages: [{ role: "user", content: "research this" }],
    enabled_tools: ["websearch"],
  },
  fetchImpl: async (url, init) => {
    toolRoundCalls += 1;
    const request = JSON.parse(init.body);
    if (url.endsWith("/tools")) {
      assert.equal(request.tool_calls[0].function.name, "websearch");
      if (toolRoundCalls === 2) {
        return new Response(JSON.stringify({ tool_calls: [{
          ...request.tool_calls[0],
          content: { success: false, error: "temporary search failure" },
        }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ tool_calls: [{
        ...request.tool_calls[0],
        content: { success: true, results: [{ title: "Ambient API", url: "https://docs.ambient.xyz/API" }] },
      }] }), { status: 200 });
    }
    if (toolRoundCalls === 1) {
      return new Response(JSON.stringify({ id: "research_1", choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: "", tool_calls: [{ id: "tool_1", type: "function", function: { name: "websearch", arguments: "{\"query\":\"ambient\"}" } }],
      } }] }), { status: 200 });
    }
    assert.equal(request.messages.at(-1).role, "tool");
    assert.match(request.messages.at(-1).content, /Ambient API/);
    return new Response(JSON.stringify({ id: "research_2", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Ambient API docs." } }] }), { status: 200 });
  },
});
assert.equal(researched.text, "Ambient API docs.");
assert.equal(researched.toolRounds, 1);
assert.equal(toolRoundCalls, 4);

const encoder = new TextEncoder();
const streamResult = await ambientChatCompletionStream({
  env,
  capability: "fast_text",
  body: { messages: [{ role: "user", content: "hello" }] },
  fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"id":"stream_1","model":"deepseek/deepseek-v4-flash-0731","choices":[{"delta":{"content":"hel"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } }),
});
assert.equal(streamResult.text, "hello");
assert.equal(streamResult.id, "stream_1");
assert.equal(streamResult.usage.total_tokens, 3);

await assert.rejects(
  () => ambientChatCompletionStream({
    env,
    timeoutMs: 20,
    body: { messages: [{ role: "user", content: "hang" }] },
    fetchImpl: async () => new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  }),
  (error) => error.code === "ambient_timeout" && error.status === 504
);

const externalAbort = new AbortController();
const externallyAbortedStream = ambientChatCompletionStream({
  env,
  signal: externalAbort.signal,
  timeoutMs: 5_000,
  body: { messages: [{ role: "user", content: "disconnect" }] },
  fetchImpl: async () => new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  }),
});
externalAbort.abort();
await assert.rejects(
  () => externallyAbortedStream,
  (error) => error.code === "ambient_stream_aborted" && error.status === 499
);

await assert.rejects(
  () => ambientChatCompletion({
    env,
    body: { messages: [{ role: "user", content: "hello" }] },
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "No workers are currently available" } }), { status: 429 }),
  }),
  (error) => error.code === "ambient_no_workers" && error.status === 429
);

let fallbackCalls = 0;
const fallback = await ambientChatCompletion({
  env,
  capability: "fast_text",
  body: { messages: [{ role: "user", content: "hello" }] },
  fetchImpl: async (_url, init) => {
    fallbackCalls += 1;
    const request = JSON.parse(init.body);
    if (fallbackCalls === 1) {
      assert.equal(request.model, AMBIENT_MODELS.fastText);
      return new Response(JSON.stringify({ error: { message: "No workers are currently available" } }), { status: 429 });
    }
    assert.equal(request.model, AMBIENT_MODELS.reasoningText);
    return new Response(JSON.stringify({ id: "fallback_1", model: request.model, choices: [{ message: { content: "fallback ok" } }] }), { status: 200 });
  },
});
assert.equal(fallback.text, "fallback ok");
assert.equal(fallback.fallbackFrom, AMBIENT_MODELS.fastText);

let strictFastTextCalls = 0;
await assert.rejects(
  () => ambientChatCompletion({
    env,
    capability: "fast_text",
    allowCapacityFallback: false,
    body: { messages: [{ role: "user", content: "persist this with DeepSeek Flash" }] },
    fetchImpl: async (_url, init) => {
      strictFastTextCalls += 1;
      assert.equal(JSON.parse(init.body).model, AMBIENT_MODELS.fastText);
      return new Response(
        JSON.stringify({ error: { message: "No workers are currently available" } }),
        { status: 429 }
      );
    },
  }),
  (error) => error.code === "ambient_no_workers" && error.status === 429
);
assert.equal(strictFastTextCalls, 1);

let catalogCalls = 0;
const catalogFetch = async () => {
  catalogCalls += 1;
  return new Response(JSON.stringify({ data: [{ id: AMBIENT_MODELS.structured }] }), { status: 200 });
};
assert.equal((await ambientModels({ env, fetchImpl: catalogFetch })).data[0].id, AMBIENT_MODELS.structured);
assert.equal((await ambientModels({ env, fetchImpl: catalogFetch })).data[0].id, AMBIENT_MODELS.structured);
assert.equal(catalogCalls, 1);

console.log("ambient inference smoke ok");
