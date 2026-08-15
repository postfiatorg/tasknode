import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { startChatStreamHeartbeat } from "../server/chat-stream-heartbeat.js";

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

console.log("chat stream reliability smoke ok");
