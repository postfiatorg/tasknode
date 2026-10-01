#!/usr/bin/env node
// Remote MCP endpoint: OAuth discovery, loopback-only registration, PKCE-bound
// code exchange (not redeemable through the terminal poll route), and tool
// calls that re-enter the terminal API under its route policies.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const storeDir = mkdtempSync(path.join(tmpdir(), "tasknode-mcp-smoke-"));
process.env.TASKNODE_STORE_PATH = path.join(storeDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.GITHUB_CLIENT_ID ||= "mcp-smoke-client";
process.env.GITHUB_CLIENT_SECRET ||= "mcp-smoke-secret";

const runtime = await import("../server/runtime-store.js");
const { enforceRoutePolicy, json } = await import("../server/server-http-boundary.js");
const { handleTaskNodeMcpRoute } = await import("../server/tasknode-mcp.js");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  try {
    const session = req.headers["x-smoke-account"] ? { accountId: req.headers["x-smoke-account"] } : null;
    if (await enforceRoutePolicy(req, url, res, session)) return;
    if (!(await handleTaskNodeMcpRoute({ req, res, url, origin, session, responseHeadersForAuthResult: () => ({}) }))) json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const get = (pathname) => fetch(`${origin}${pathname}`, { redirect: "manual" });
const post = (pathname, body, headers = {}) => fetch(`${origin}${pathname}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

try {
  // Discovery.
  const unauthenticated = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("www-authenticate"), `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
  const resource = await (await get("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(resource.resource, `${origin}/mcp`);
  assert.deepEqual(resource.authorization_servers, [origin]);
  const authServer = await (await get("/.well-known/oauth-authorization-server")).json();
  assert.equal(authServer.token_endpoint, `${origin}/oauth/token`);
  assert.deepEqual(authServer.code_challenge_methods_supported, ["S256"]);
  assert.equal((await get("/mcp")).status, 405, "no server-initiated SSE stream");

  // Registration and authorization accept only local callbacks.
  assert.equal((await post("/oauth/register", { redirect_uris: ["https://attacker.example/cb"] })).status, 400);
  const redirectUri = "http://localhost:43123/callback";
  // Real client payloads carry OIDC/RFC 7591 extensions (Codex: application_type).
  const registered = await post("/oauth/register", {
    client_name: "smoke", redirect_uris: [redirectUri], application_type: "native", grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none", scope: "tasknode:read", future_extension: { any: true },
  });
  assert.equal(registered.status, 201);
  const clientId = (await registered.json()).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = (overrides = {}) => get(`/oauth/authorize?${new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, state: "st8",
    code_challenge: challenge, code_challenge_method: "S256", ...overrides,
  })}`);
  assert.equal((await authorize({ redirect_uri: "https://attacker.example/cb" })).status, 400);
  const noPkce = await authorize({ code_challenge_method: "plain" });
  assert.equal(new URL(noPkce.headers.get("location")).searchParams.get("error"), "invalid_request");
  const started = await authorize();
  assert.equal(started.status, 302);
  assert.equal(new URL(started.headers.get("location")).hostname, "github.com");

  // GitHub completes the bound terminal request.
  const [requestId, request] = Object.entries(runtime.legacyTerminalAuthSnapshotForMigration().requests)
    .find(([, item]) => item.oauth?.clientId === clientId);
  assert.equal(request.oauth.redirectUri, redirectUri);
  const account = runtime.getOrCreateProviderAccount({ provider: "github", providerUserId: `mcp_${Date.now()}`, username: "mcp-smoke" });
  assert.equal(runtime.completeTerminalAuthRequest({ requestId, accountId: account.id, provider: "github" }).ok, true);
  const callback = new URL((await get(`/oauth/callback?requestId=${encodeURIComponent(requestId)}`)).headers.get("location"));
  assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
  assert.equal(callback.searchParams.get("state"), "st8");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  // The code cannot be redeemed through the terminal poll route, a different
  // client, or a wrong verifier; the right PKCE exchange issues a bearer token.
  assert.equal(runtime.consumeTerminalAuthRequestSession({ requestId: code, pollToken: challenge }).status, 401);
  const exchange = (fields) => post("/oauth/token", new URLSearchParams({
    grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, ...fields,
  }).toString(), { "content-type": "application/x-www-form-urlencoded" });
  assert.equal((await (await exchange({ code_verifier: randomBytes(32).toString("base64url") })).json()).error, "invalid_grant");
  assert.equal((await exchange({ client_id: "other" })).status, 400);
  const tokenResponse = await exchange({});
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  assert.equal(token.token_type, "Bearer");
  assert.ok(token.access_token.startsWith("tns_"));
  assert.equal((await exchange({})).status, 400, "codes are single use");

  // MCP over the issued token.
  const auth = { authorization: `Bearer ${token.access_token}`, accept: "application/json, text/event-stream" };
  const rpc = async (method, params = {}) => (await post("/mcp", { jsonrpc: "2.0", id: method, method, params }, auth)).json();
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.instructions.includes("verification_response"));
  assert.equal((await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, auth)).status, 202);
  const listed = (await rpc("tools/list")).result.tools;
  assert.ok(listed.length >= 10);
  assert.equal(listed.find((tool) => tool.name === "tasknode_get_task").annotations.readOnlyHint, true);
  assert.equal(listed.find((tool) => tool.name === "tasknode_submit_evidence").annotations.readOnlyHint, false);

  const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const status = await call("tasknode_status");
  assert.equal(status.isError, false);
  assert.equal(JSON.parse(status.content[0].text).accountId, account.id);
  const chat = await call("tasknode_chat", { message: "Dry-run MCP chat.", dryRun: true });
  assert.equal(JSON.parse(chat.content[0].text).dryRun, true);
  assert.equal((await call("tasknode_get_task", {})).isError, true, "required arguments are enforced");
  const invalidBody = await call("tasknode_save_context", { body: "x", bogus: true });
  assert.equal(JSON.parse(invalidBody.content[0].text).error, "request_body_field_unknown", "inner body contracts apply");
  assert.equal((await rpc("tools/call", { name: "nope" })).error.code, -32602);
  assert.equal((await rpc("resources/list")).error.code, -32601);

  // /connect: signed-in browser mints a token and shows paste-ready commands.
  assert.ok((await (await get("/connect")).text()).includes("/connect/login"), "signed out: sign-in link");
  assert.equal(new URL((await get("/connect/login")).headers.get("location")).hostname, "github.com");
  const browser = { "x-smoke-account": account.id, origin };
  assert.ok((await (await fetch(`${origin}/connect`, { headers: browser })).text()).includes('method="post"'));
  assert.equal((await fetch(`${origin}/connect`, { method: "POST", headers: { ...browser, origin: "https://evil.example" } })).status, 403);
  const connectPage = await (await fetch(`${origin}/connect`, { method: "POST", headers: browser })).text();
  const pageToken = connectPage.match(/Bearer (tns_[A-Za-z0-9_-]+)/)[1];
  const { agentConnectCommands } = await import("../server/tasknode-mcp.js");
  const codexHome = mkdtempSync(path.join(storeDir, "codex-"));
  execFileSync("sh", ["-c", agentConnectCommands(origin, pageToken).codex], { env: { ...process.env, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin" } });
  const codexConfig = readFileSync(path.join(codexHome, "config.toml"), "utf8");
  assert.ok(codexConfig.includes(`[mcp_servers.tasknode]\nurl = "${origin}/mcp"\nhttp_headers = { Authorization = "Bearer ${pageToken}" }\n`), "codex command writes a valid server entry");
  const viaPage = await post("/mcp", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "tasknode_status", arguments: {} } }, { authorization: `Bearer ${pageToken}` });
  assert.equal(JSON.parse((await viaPage.json()).result.content[0].text).accountId, account.id);

  runtime.revokeTerminalSessionByToken(token.access_token);
  assert.equal((await post("/mcp", { jsonrpc: "2.0", id: 9, method: "ping" }, auth)).status, 401);
  console.log("tasknode mcp smoke ok");
} finally {
  server.close();
  rmSync(storeDir, { recursive: true, force: true });
}
