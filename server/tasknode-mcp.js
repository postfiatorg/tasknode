// Remote MCP server (Streamable HTTP, stateless JSON responses) so Claude Code,
// Codex and other MCP clients can use Task Node without Corbanu Terminal.
// Login is OAuth 2.1 (PKCE + dynamic registration) layered on the existing
// terminal GitHub flow; tools re-enter the /api/terminal/tasknode routes so
// route policy, rate limits and body contracts apply unchanged.
import { createHash, randomBytes } from "node:crypto";
import { appearancePageHead } from "./appearance-page.js";
import { authStart } from "./product-contracts.js";
import { getLinkedProviderForAccount } from "./repositories/accounts.js";
import {
  completeTerminalAuthRequest,
  consumeTerminalAuthRequestSession,
  createTerminalAuthRequest,
  getTerminalAuthRequest,
  getTerminalSessionByToken,
} from "./repositories/terminal-auth.js";
import { readValidatedJson as readJson } from "./request-validation.js";
import { enforceRateLimit, enforceRoutePolicy, json, securityHeaders } from "./server-http-boundary.js";
import { handleTaskNodeTerminalRoute } from "./tasknode-terminal-routes.js";

const protocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const scopes = ["tasknode:read", "tasknode:tasks:write", "tasknode:balance:read"];
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const instructions = `Task Node is the user's task ledger and context-aware second brain.
- Use tasknode_chat for user-specific judgment (priorities, project direction) instead of guessing; ask the user for irreversible or high-stakes choices.
- Lifecycle: request -> accept/refuse -> do the work -> initial evidence -> answer the verification request -> reward. Evidence receipts are not completion; only rewardOutcome or a rewarded status is.
- Before submitting evidence, read the task. Use mode initial_submission when actions.canSubmitInitialEvidence is true and verification_response when actions.canSubmitVerificationEvidence is true; answer currentVerificationRequest exactly.
- Cite durable artifacts only (PR/commit URLs, file paths, exact commands and results). Never cite localhost URLs and never send secrets.
- Context document: read it first, make the smallest durable edit, pass the revision you read, and show the user the diff.`;

const text = (description, extra = {}) => ({ type: "string", description, ...extra });
const taskId = text("Task ID from tasknode_list_tasks.");
const path = (...parts) => parts.map(encodeURIComponent).join("/");

const tools = [
  { name: "tasknode_status", description: "Account, linked wallet and task counts.", route: () => ["GET", "status"] },
  {
    name: "tasknode_list_tasks",
    description: "List tasks in one tab.",
    properties: { tab: text("Default outstanding.", { enum: ["outstanding", "verification", "refused", "rewarded"] }) },
    route: ({ tab = "outstanding" }) => ["GET", `tasks?tab=${encodeURIComponent(tab)}`],
  },
  {
    name: "tasknode_get_task",
    description: "Full task card: objective, steps, reward, verification criteria, current verification request and allowed actions.",
    properties: { taskId },
    required: ["taskId"],
    route: (args) => ["GET", path("tasks", args.taskId)],
  },
  {
    name: "tasknode_task_action",
    description: "Accept, refuse or cancel a task.",
    properties: { taskId, action: text("Lifecycle action.", { enum: ["accept", "refuse", "cancel"] }), reason: text("Why (required for refuse).") },
    required: ["taskId", "action"],
    write: true,
    route: ({ taskId: id, ...body }) => ["POST", path("tasks", id, "action"), body],
  },
  {
    name: "tasknode_submit_evidence",
    description: "Submit initial evidence or a verification response for a task.",
    properties: {
      taskId,
      mode: text("Which lifecycle write this is.", { enum: ["initial_submission", "verification_response"] }),
      summary: text("Complete evidence or verification answer."),
      evidence: {
        type: "array",
        description: "Optional durable artifacts (max 2).",
        items: {
          type: "object",
          properties: { type: text("Artifact type.", { enum: ["text", "url", "github_pr", "git_commit"] }), value: text("Artifact."), notes: text("Optional notes.") },
          required: ["type", "value"],
        },
      },
    },
    required: ["taskId", "mode", "summary"],
    write: true,
    route: ({ taskId: id, ...body }) => ["POST", path("tasks", id, "evidence"), body],
  },
  {
    name: "tasknode_request_task",
    description: "Ask Task Node to generate a personal task from a description of the work.",
    properties: { userDetailText: text("What the task should cover, with enough context to scope it."), sourceConversationTitle: text("Optional short label.") },
    required: ["userDetailText"],
    write: true,
    route: (body) => ["POST", "requests", body],
  },
  { name: "tasknode_list_requests", description: "Recent task requests and their generation status.", route: () => ["GET", "requests"] },
  { name: "tasknode_get_context", description: "Read the user's context document (operating manual).", route: () => ["GET", "context"] },
  {
    name: "tasknode_save_context",
    description: "Replace the context document body. Pass the revision you read to avoid overwriting newer edits.",
    properties: { body: text("Full new document body."), revision: { type: "integer", description: "Revision from tasknode_get_context." }, title: text("Optional title.") },
    required: ["body"],
    write: true,
    route: (body) => ["POST", "context", body],
  },
  {
    name: "tasknode_chat",
    description: "Ask Task Node chat, which knows the user's context, tasks and history. Billed to the user's Task Node credits.",
    properties: {
      message: text("The question, with the decision, options and constraints."),
      mode: text("Optional chat mode, e.g. Instant (fast) or Thinking (default)."),
      conversationId: text("Optional conversation to continue."),
    },
    required: ["message"],
    write: true,
    route: (body) => ["POST", "chat/send", body],
  },
  { name: "tasknode_balance", description: "PFT balance of the linked wallet.", route: () => ["GET", "balance"] },
  {
    name: "tasknode_rewards",
    description: "Recent task rewards.",
    properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
    route: ({ limit = 10 }) => ["GET", `rewards?limit=${Number(limit) || 10}`],
  },
];
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
const toolList = tools.map(({ name, description, properties = {}, required = [], write }) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: !write },
}));

function bearerToken(req) {
  const [scheme = "", token = ""] = String(req.headers.authorization || "").trim().split(" ").filter(Boolean);
  return scheme.toLowerCase() === "bearer" ? token : "";
}

function loopbackRedirect(value = "") {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && loopbackHosts.has(url.hostname);
  } catch {
    return false;
  }
}

const pkceChallenge = (verifier = "") => createHash("sha256").update(String(verifier)).digest("base64url");

function redirect(res, location, headers = {}) {
  res.writeHead(302, { "cache-control": "no-store", ...headers, location });
  res.end();
}

function withParams(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

async function readForm(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw Object.assign(new Error("request_too_large"), { status: 413 });
  }
  return String(req.headers["content-type"] || "").includes("json")
    ? JSON.parse(raw || "{}")
    : Object.fromEntries(new URLSearchParams(raw));
}

function metadata(origin, pathname) {
  if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: scopes, bearer_methods_supported: ["header"] };
  }
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: scopes,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

// Re-enter the terminal API in-process with a captured response.
async function callTool(tool, args, req, origin, session) {
  const missing = (tool.required || []).filter((key) => args[key] === undefined || args[key] === "");
  if (missing.length) return { status: 400, body: JSON.stringify({ ok: false, error: "missing_arguments", missing }) };
  const [method, route, body] = tool.route(args);
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const inner = {
    method,
    headers: { ...req.headers, "content-type": "application/json" },
    socket: req.socket,
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
  const out = { status: 200, body: "", writeHead(status) { this.status = status; }, setHeader() {}, end(chunk = "") { this.body += chunk; } };
  const url = new URL(`/api/terminal/tasknode/${route}`, origin);
  if (!(await enforceRoutePolicy(inner, url, out, session))) {
    await handleTaskNodeTerminalRoute({ json, readJson, req: inner, res: out, url, origin, responseHeadersForAuthResult: () => ({}) });
  }
  return out;
}

async function rpcResult(message, req, origin, session) {
  const { method, params = {} } = message;
  if (method === "initialize") {
    return {
      protocolVersion: protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[1],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "tasknode", title: "Task Node", version: "1.0.0" },
      instructions,
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: toolList };
  if (method === "tools/call") {
    const tool = toolsByName.get(params.name);
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
    const out = await callTool(tool, params.arguments || {}, req, origin, session);
    return { content: [{ type: "text", text: out.body }], isError: out.status >= 400 };
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

async function handleMcp({ req, res, origin }) {
  const token = bearerToken(req);
  const session = token ? await getTerminalSessionByToken(token) : null;
  if (!session?.accountId) {
    json(res, 401, { error: "invalid_token", error_description: "Sign in to Task Node with GitHub." }, {
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    });
    return;
  }
  const message = await readJson(req, 1024 * 1024);
  if (message.id === undefined || !message.method) {
    res.writeHead(202, { "cache-control": "no-store" });
    res.end();
    return;
  }
  try {
    json(res, 200, { jsonrpc: "2.0", id: message.id, result: await rpcResult(message, req, origin, session) });
  } catch (error) {
    json(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: error.code || -32603, message: error.message } });
  }
}

async function handleAuthorize({ req, res, url, origin, responseHeadersForAuthResult }) {
  const params = Object.fromEntries(url.searchParams);
  if (!loopbackRedirect(params.redirect_uri)) {
    json(res, 400, { error: "invalid_request", error_description: "redirect_uri must be a local http://localhost or 127.0.0.1 callback." });
    return;
  }
  const fail = (error, description) => redirect(res, withParams(params.redirect_uri, { error, error_description: description, state: params.state }));
  if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (params.code_challenge_method !== "S256" || String(params.code_challenge || "").length !== 43) return fail("invalid_request", "PKCE S256 is required.");
  if (!params.client_id) return fail("invalid_request", "client_id is required.");
  const request = await createTerminalAuthRequest({
    provider: "github",
    origin,
    userAgent: req.headers["user-agent"] || "",
    ip: req.socket?.remoteAddress || "",
    pollToken: params.code_challenge,
    oauth: { clientId: params.client_id.slice(0, 200), redirectUri: params.redirect_uri, state: String(params.state || "").slice(0, 500) },
  });
  const result = await authStart("github", {
    origin,
    redirectPath: `/oauth/callback?requestId=${encodeURIComponent(request.requestId)}`,
    terminalRequestId: request.requestId,
  });
  if (result.status !== 200 || !result.body?.redirectUrl) return fail("server_error", result.body?.message || "GitHub sign-in is unavailable.");
  redirect(res, result.body.redirectUrl, responseHeadersForAuthResult(req, result));
}

async function handleCallback({ res, url }) {
  const requestId = url.searchParams.get("requestId") || "";
  const request = requestId ? await getTerminalAuthRequest({ requestId }) : null;
  if (!request?.oauth) {
    json(res, 404, { error: "invalid_request", error_description: "Sign-in request expired. Start again from your MCP client." });
    return;
  }
  const linked = request.status === "linked";
  redirect(res, withParams(request.oauth.redirectUri, {
    code: linked ? requestId : "",
    error: linked ? "" : "access_denied",
    error_description: linked ? "" : request.error || "GitHub sign-in did not complete.",
    state: request.oauth.state,
  }));
}

async function handleToken({ req, res }) {
  if (req.method !== "POST") {
    json(res, 405, { error: "invalid_request" }, { allow: "POST" });
    return;
  }
  if (await enforceRateLimit(req, res, { route: "oauth_token", limit: 30, windowMs: 10 * 60_000 })) return;
  let form;
  try {
    form = await readForm(req);
  } catch (error) {
    json(res, error.status || 400, { error: "invalid_request" });
    return;
  }
  if (form.grant_type !== "authorization_code") {
    json(res, 400, { error: "unsupported_grant_type" });
    return;
  }
  const result = form.code && form.code_verifier
    ? await consumeTerminalAuthRequestSession({
        requestId: String(form.code),
        pollToken: pkceChallenge(form.code_verifier),
        oauthClient: { clientId: String(form.client_id || ""), redirectUri: String(form.redirect_uri || "") },
      })
    : { ok: false };
  if (!result.ok) {
    json(res, 400, { error: "invalid_grant", error_description: result.error || "code and code_verifier are required." });
    return;
  }
  json(res, 200, { access_token: result.terminalToken, token_type: "Bearer", scope: (result.session.scopes || scopes).join(" ") });
}

async function handleRegister({ req, res }) {
  const body = await readJson(req, 16_384);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirectUris.length || !redirectUris.every(loopbackRedirect)) {
    json(res, 400, { error: "invalid_redirect_uri", error_description: "Only local http://localhost or 127.0.0.1 callbacks are allowed." });
    return;
  }
  json(res, 201, {
    client_id: `tnmcp_${randomBytes(12).toString("base64url")}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: String(body.client_name || "MCP client").slice(0, 120),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

// /connect: browser-side token for agents on any machine, including over SSH
// where an OAuth loopback callback cannot reach the agent. The user copies one
// command out of the browser and pastes it into the terminal.
const escapeHtml = (value = "") => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function connectPage(res, body, status = 200) {
  res.writeHead(status, { ...securityHeaders(), "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Codex or Claude Code · Task Node</title>${appearancePageHead}
<style>body{font-family:system-ui,sans-serif;margin:0;padding:1.5rem;line-height:1.5}main{max-width:46rem;margin:0 auto}
pre{white-space:pre-wrap;word-break:break-all;user-select:all;cursor:copy;padding:.75rem;border:1px solid #d8d5ca;border-radius:6px;background:#f3f1ea;font-size:.85rem}
:root[data-theme="dark"] pre{background:#2a2b26;border-color:#3b3d35}
.button{display:inline-block;padding:.6rem 1rem;border:0;border-radius:6px;background:#22231f;color:#faf9f6;font:inherit;cursor:pointer;text-decoration:none}</style>
<main><h1>Connect Codex or Claude Code</h1>${body}</main>`);
}

export function agentConnectCommands(origin, token) {
  const url = `${origin}/mcp`;
  return {
    codex: `codex mcp remove tasknode >/dev/null 2>&1; printf '\\n[mcp_servers.tasknode]\\nurl = "${url}"\\nhttp_headers = { Authorization = "Bearer ${token}" }\\n' >> "\${CODEX_HOME:-$HOME/.codex}/config.toml"`,
    claude: `claude mcp add --scope user --transport http tasknode ${url} --header "Authorization: Bearer ${token}"`,
  };
}

async function mintAgentToken(accountId, origin) {
  const request = await createTerminalAuthRequest({ provider: "github", origin });
  if (!(await completeTerminalAuthRequest({ requestId: request.requestId, accountId, provider: "github" })).ok) return "";
  const issued = await consumeTerminalAuthRequestSession({ requestId: request.requestId, pollToken: request.pollToken });
  return issued.ok ? issued.terminalToken : "";
}

async function handleConnect({ req, res, origin, session }) {
  if (!session?.accountId) {
    return connectPage(res, `<p>Sign in with the GitHub account linked to your Task Node account.</p><a class="button" href="/connect/login">Sign in with GitHub</a>`);
  }
  const github = await getLinkedProviderForAccount({ accountId: session.accountId, provider: "github" });
  if (!github) {
    return connectPage(res, `<p>Agents sign in through GitHub. Link GitHub to this account, then reopen this page.</p><a class="button" href="/settings/accounts/github">Link GitHub</a>`);
  }
  if (req.method !== "POST") {
    return connectPage(res, `<p>Signed in as <b>${escapeHtml(github.username || session.accountId)}</b>. Create a token, then paste one command into the terminal where Codex or Claude Code runs. This works over SSH too.</p><form method="post"><button class="button" type="submit">Create token</button></form>`);
  }
  const token = await mintAgentToken(session.accountId, origin);
  if (!token) return connectPage(res, `<p>The token could not be created. Reload this page and try again.</p>`, 500);
  const commands = agentConnectCommands(origin, token);
  return connectPage(res, `<p>Click a command to select all of it, copy it, and paste it into your terminal. This token is shown only once.</p>
<h2>Codex</h2><pre>${escapeHtml(commands.codex)}</pre>
<h2>Claude Code</h2><pre>${escapeHtml(commands.claude)}</pre>
<p>Then start <code>codex</code> or <code>claude</code> and ask: "What are my outstanding Task Node tasks?"</p>
<p class="muted">Anyone with this token can act as you in Task Node, so don't share it.</p>`);
}

async function handleConnectLogin({ req, res, origin, responseHeadersForAuthResult }) {
  const result = await authStart("github", { origin, redirectPath: "/connect" });
  if (result.status !== 200 || !result.body?.redirectUrl) return connectPage(res, `<p>GitHub sign-in is unavailable right now. Sign in at <a href="/">Task Node</a>, then reopen this page.</p>`, 503);
  redirect(res, result.body.redirectUrl, responseHeadersForAuthResult(req, result));
}

export async function handleTaskNodeMcpRoute(params) {
  const { res, url, origin } = params;
  const pathname = url.pathname;
  if (pathname === "/mcp") await handleMcp(params);
  else if (pathname === "/oauth/authorize") await handleAuthorize(params);
  else if (pathname === "/oauth/callback") await handleCallback(params);
  else if (pathname === "/oauth/token") await handleToken(params);
  else if (pathname === "/oauth/register") await handleRegister(params);
  else if (pathname === "/connect") await handleConnect(params);
  else if (pathname === "/connect/login") await handleConnectLogin(params);
  else if (pathname.startsWith("/.well-known/oauth-")) json(res, 200, metadata(origin, pathname));
  else return false;
  return true;
}
