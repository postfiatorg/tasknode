import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { startChatStreamHeartbeat } from "../server/chat-stream-heartbeat.js";
import { completedChatTurnReplay } from "../server/chat-router.js";
import { requestEventStream } from "../src/api.js";

function sseResponse(blocks = []) {
  return new Response(blocks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

const originalFetch = globalThis.fetch;
try {
  const retryEvents = [];
  const waitDelays = [];
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new TypeError("network error");
    return sseResponse([
      'event: delta\ndata: {"delta":"Recovered"}\n\n',
      'event: done\ndata: {"ok":true,"assistant":{"body":"Recovered"}}\n\n',
    ]);
  };
  const recovered = await requestEventStream(
    "/api/chat/stream",
    { method: "POST" },
    ({ event }) => retryEvents.push(event),
    {
      retryDelaysMs: [750],
      onRetry: ({ retryCount, maxRetries }) => retryEvents.push(`retry:${retryCount}/${maxRetries}`),
      wait: async (delay) => { waitDelays.push(delay); },
    }
  );
  assert.equal(fetchCalls, 2, "a pre-response network interruption should retry automatically");
  assert.deepEqual(waitDelays, [750]);
  assert.deepEqual(retryEvents, ["retry:1/1", "delta", "done"]);
  assert.equal(recovered.ok, true);

  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return sseResponse(['event: progress\ndata: {"elapsedMs":15000}\n\n']);
    return sseResponse(['event: done\ndata: {"ok":true,"assistant":{"body":"Recovered after restart"}}\n\n']);
  };
  const recoveredPrematureEnd = await requestEventStream(
    "/api/chat/stream",
    { method: "POST" },
    () => {},
    { retryDelaysMs: [0], wait: async () => {} }
  );
  assert.equal(fetchCalls, 2, "a stream that closes without done/error should reconnect automatically");
  assert.equal(recoveredPrematureEnd.body.assistant.body, "Recovered after restart");

  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return sseResponse(['event: error\ndata: {"ok":false,"message":"Provider rejected the request"}\n\n']);
  };
  const providerFailure = await requestEventStream(
    "/api/chat/stream",
    { method: "POST" },
    () => {},
    { retryDelaysMs: [0, 0], wait: async () => {} }
  );
  assert.equal(fetchCalls, 1, "a completed provider error is not a network interruption and must not retry");
  assert.equal(providerFailure.ok, false);
  assert.equal(providerFailure.body.message, "Provider rejected the request");
} finally {
  globalThis.fetch = originalFetch;
}

const replay = completedChatTurnReplay({
  messages: [
    { id: "msg_request_user", role: "user", body: "Should I move?" },
    { id: "msg_request_assistant", role: "assistant", body: "Compare the decision carefully.", provider: "ambient", model: "reasoning" },
  ],
  userMessageId: "msg_request_user",
  assistantMessageId: "msg_request_assistant",
  persona: "jobs",
});
assert.equal(replay.replayed, true);
assert.equal(replay.assistant.body, "Compare the decision carefully.");
assert.equal(replay.usage.costSource, "idempotent_replay");
assert.equal(completedChatTurnReplay({ messages: [], userMessageId: "user", assistantMessageId: "assistant" }), null);

const writes = [];
let intervalTick = null;
let clearedTimer = null;
let clock = 1_000;
const timer = {
  unrefCalled: false,
  unref() {
    this.unrefCalled = true;
  },
};
const heartbeat = startChatStreamHeartbeat(
  { destroyed: false, writableEnded: false, write: (value) => writes.push(value) },
  {
    now: () => clock,
    setIntervalImpl: (tick, intervalMs) => {
      intervalTick = tick;
      assert.equal(intervalMs, 15_000);
      return timer;
    },
    clearIntervalImpl: (value) => {
      clearedTimer = value;
    },
  }
);
assert.equal(timer.unrefCalled, true);
clock = 16_000;
assert.equal(intervalTick(), true);
assert.equal(
  writes.join(""),
  'event: progress\ndata: {"ok":true,"phase":"thinking","elapsedMs":15000}\n\n'
);

const vite = await createServer({
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { entries: [], noDiscovery: true },
  server: { middlewareMode: true },
});
try {
  const {
    createPendingAssistantTurn,
    updatePendingAssistantProgress,
  } = await vite.ssrLoadModule("/src/features/chat/chat-turns.js");
  const { AssistantMessage } = await vite.ssrLoadModule("/src/features/chat/ChatMessages.jsx");
  const pending = createPendingAssistantTurn("pending", 1_000);
  const progressed = updatePendingAssistantProgress([pending], "pending", 15_000, 1_000)[0];
  assert.equal(progressed.thinking.state, "running");
  assert.equal(progressed.thinking.duration, "15s");
  const markup = renderToStaticMarkup(React.createElement(AssistantMessage, { message: progressed }));
  assert.match(markup, /Thinking for 15s/);
} finally {
  await vite.close();
}

heartbeat.stop();
heartbeat.stop();
assert.equal(clearedTimer, timer);
assert.equal(heartbeat.pulse(), false);

const indexSource = await readFile(new URL("../server/index.js", import.meta.url), "utf8");
const terminalSource = await readFile(new URL("../server/tasknode-terminal-routes.js", import.meta.url), "utf8");
const frontendSource = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(indexSource, /startChatStreamHeartbeat\(res\)/);
assert.match(terminalSource, /startChatStreamHeartbeat\(res\)/);
assert.match(frontendSource, /event === "progress"/);
assert.match(frontendSource, /Connection interrupted\. Reconnecting/);
assert.match(frontendSource, /setInput\(message\)/, "an exhausted recovery should restore the user's draft");
assert.match(frontendSource, /clientRequestId: chatRequestId/, "network retries must reuse a stable client request identity");

console.log("chat stream reliability smoke ok");
