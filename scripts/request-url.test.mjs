import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseRequestUrl, normalizeRequestTarget } from "../server/request-url.js";

test("request targets cannot carry an authority or throw", () => {
  assert.equal(normalizeRequestTarget("//api/tasks"), "/api/tasks");
  assert.equal(normalizeRequestTarget("///api/health"), "/api/health");
  assert.equal(normalizeRequestTarget("http://proxy.example//api/health"), "/api/health");
  assert.equal(normalizeRequestTarget(""), "/");
  for (const raw of ["//[::1/x", "//a b/c", "//%/x", "//user:pw@evil.example/api/health"]) {
    const parsed = parseRequestUrl(raw);
    assert.equal(parsed.ok, true, raw);
    assert.equal(parsed.url.host, "tasknode.local", raw);
    assert.ok(parsed.url.pathname.startsWith("/"), raw);
  }
  assert.equal(parseRequestUrl("//user:pw@evil.example/api/health").url.pathname, "/user:pw@evil.example/api/health");
  assert.equal(parseRequestUrl("/api/health?x=1").url.search, "?x=1");
});

// Raw-socket requests: Node's http client would refuse to send some of these
// targets, and the point is what the server does when they arrive.
async function rawGet(port, target) {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error("timeout")); });
  });
}

test("a double-slash or malformed GET gets a controlled response and the server survives", async (t) => {
  const port = 18080 + Math.floor(Math.random() * 1000);
  const dir = mkdtempSync(join(tmpdir(), "request-url-"));
  const server = spawn(process.execPath, ["server/index.js"], {
    env: {
      ...process.env, PORT: String(port), NODE_ENV: "development", TASKNODE_ENV: "development", TASKNODE_BIND_HOST: "127.0.0.1",
      TASKNODE_PROCESS_ROLE: "web", TASKNODE_DATABASE_DISABLED: "true", TASKNODE_DATABASE_ENABLED: "false",
      TASKNODE_AUTH_SECRET: "request-url-test-secret", TASKNODE_STORE_PATH: join(dir, "runtime-store.json"), AMBIENT_API_KEY: "", VERCEL_AI_GATEWAY_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => { server.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/api/health`); if (res.ok) break; } catch { /* not yet */ }
    if (server.exitCode !== null) throw new Error("server exited during startup: " + output.slice(-800));
    await sleep(250);
  }
  const statusOf = (raw) => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]);
  const cases = [
    ["//api/health", 200],
    ["//api/tasks", null],
    ["///api/health", 200],
    ["//[::1/x", null],
    ["//a b/c", null],
    ["//user:pw@evil.example/api/health", null],
  ];
  for (const [target, expected] of cases) {
    const raw = await rawGet(port, target);
    const status = statusOf(raw);
    assert.ok(Number.isInteger(status) && status < 500, `${target} -> ${raw.slice(0, 120)}`);
    if (expected) assert.equal(status, expected, target);
    assert.equal(server.exitCode, null, `server died after ${target}: ${output.slice(-800)}`);
  }
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200, "server still healthy after malformed requests");
  assert.ok(!/ERR_INVALID_URL|TypeError: Invalid URL/.test(output), "no URL parse throw reached the log");
});
