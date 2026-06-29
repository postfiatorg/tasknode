import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const storeDir = mkdtempSync(path.join(tmpdir(), "tasknode-terminal-chat-smoke-"));
process.env.TASKNODE_STORE_PATH = path.join(storeDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 16384) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) {
      const error = new Error("request_body_too_large");
      error.status = 413;
      throw error;
    }
  }
  return body ? JSON.parse(body) : {};
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

try {
  const {
    completeTerminalAuthRequest,
    consumeTerminalAuthRequestSession,
    createTerminalAuthRequest,
    getOrCreateProviderAccount,
  } = await import("../server/runtime-store.js");
  const { handleTaskNodeTerminalRoute } = await import("../server/tasknode-terminal-routes.js");
  const { routePolicyForPath } = await import("../server/route-policies.js");

  const sendPolicy = routePolicyForPath("/api/terminal/tasknode/chat/send");
  assert.equal(sendPolicy?.auth, "bearer");
  assert.deepEqual(sendPolicy?.methods, ["POST"]);
  assert.equal(sendPolicy?.rateLimit?.limit, 20);

  const streamPolicy = routePolicyForPath("/api/terminal/tasknode/chat/stream");
  assert.equal(streamPolicy?.auth, "bearer");
  assert.deepEqual(streamPolicy?.methods, ["POST"]);
  assert.equal(streamPolicy?.rateLimit?.limit, 20);

  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const account = getOrCreateProviderAccount({
    provider: "github",
    providerUserId: `terminal_chat_smoke_${suffix}`,
    username: `terminal-chat-smoke-${suffix}`,
    displayName: "Terminal Chat Smoke",
  });
  assert.ok(account?.id);

  const authRequest = createTerminalAuthRequest({ provider: "github", origin: "http://127.0.0.1" });
  assert.equal(completeTerminalAuthRequest({
    requestId: authRequest.requestId,
    accountId: account.id,
    provider: "github",
  }).ok, true);
  const terminal = consumeTerminalAuthRequestSession({
    requestId: authRequest.requestId,
    pollToken: authRequest.pollToken,
  });
  assert.equal(terminal.ok, true);
  assert.ok(terminal.terminalToken);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const handled = await handleTaskNodeTerminalRoute({
        json,
        readJson,
        req,
        res,
        url,
        origin: "http://127.0.0.1",
        responseHeadersForAuthResult: () => ({}),
      });
      if (!handled) json(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      json(res, error?.status || 500, {
        ok: false,
        error: error?.message || String(error),
      });
    }
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${terminal.terminalToken}`,
  };

  const conversations = await fetch(`${base}/api/terminal/tasknode/chat/conversations`, { headers });
  assert.equal(conversations.status, 200);
  assert.equal((await conversations.json()).ok, true);

  const send = await fetch(`${base}/api/terminal/tasknode/chat/send`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      conversationId: `chat_terminal_smoke_${suffix}`,
      message: "Dry-run terminal chat smoke.",
      dryRun: true,
    }),
  });
  assert.equal(send.status, 200);
  const sendBody = await send.json();
  assert.equal(sendBody.ok, true);
  assert.equal(sendBody.dryRun, true);
  assert.equal(sendBody.action, "chat_send");
  assert.match(sendBody.conversationId, /^account_.+_chat_terminal_smoke_/);

  const streamDryRun = await fetch(`${base}/api/terminal/tasknode/chat/stream`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      conversationId: `chat_terminal_stream_smoke_${suffix}`,
      message: "Dry-run terminal chat stream smoke.",
      dryRun: true,
    }),
  });
  assert.equal(streamDryRun.status, 200);
  assert.match(streamDryRun.headers.get("content-type") || "", /application\/json/);
  const streamBody = await streamDryRun.json();
  assert.equal(streamBody.ok, true);
  assert.equal(streamBody.dryRun, true);
  assert.equal(streamBody.action, "chat_stream");
  assert.match(streamBody.conversationId, /^account_.+_chat_terminal_stream_smoke_/);

  await new Promise((resolve) => server.close(resolve));
  console.log("terminal chat smoke ok");
} finally {
  rmSync(storeDir, { recursive: true, force: true });
}
