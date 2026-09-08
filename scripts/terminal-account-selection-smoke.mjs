import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = await mkdtemp(join(tmpdir(), "corbanu-account-selection-"));
Object.assign(process.env, {
  TASKNODE_STORE_PATH: join(temporary, "runtime-store.json"),
  TASKNODE_DATABASE_DISABLED: "true",
  TASKNODE_AUTH_SECRET: "local-account-selection-fixture",
  TASKNODE_PUBLIC_URL: "http://localhost:5174",
  GITHUB_CLIENT_ID: "local-fixture-client",
  GITHUB_CLIENT_SECRET: "local-fixture-secret",
});

try {
  const { authStart } = await import("../server/product-contracts.js");
  const { handleTaskNodeTerminalRoute } = await import("../server/tasknode-terminal-routes.js");
  for (const terminalRequestId of ["", "fixture-first-account", "fixture-second-account"]) {
    const result = await authStart("github", {
      origin: "http://localhost:5174",
      redirectPath: "/",
      terminalRequestId,
    });
    assert.equal(result.status, 200);
    const redirect = new URL(result.body.redirectUrl);
    assert.equal(redirect.origin, "https://github.com");
    assert.equal(redirect.searchParams.get("prompt"), terminalRequestId ? "select_account" : null);
    assert.equal(redirect.searchParams.get("scope"), "user:email");
    assert.ok(redirect.searchParams.get("state"));
  }
  for (const path of ["/api/auth/terminal/complete", "/api/terminal/tasknode/status"]) {
    let status;
    let body;
    const res = {
      writeHead(code) { status = code; },
      end(value) { body = value; },
    };
    assert.equal(await handleTaskNodeTerminalRoute({
      req: { method: "GET", headers: {} },
      res,
      url: new URL(path, "http://localhost:5174"),
      origin: "http://localhost:5174",
      json(_res, code, value) { status = code; body = JSON.stringify(value); },
    }), true);
    assert.equal(status, path.endsWith("/complete") ? 200 : 401);
    assert.ok(body.includes("Corbanu"));
    assert.ok(body.includes("/tasknode status"));
    assert.equal(body.toLowerCase().includes("pfterminal"), false);
  }
  console.log("PASS: terminal links request account selection, ordinary sign-in retains its flow, and auth guidance names Corbanu.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
