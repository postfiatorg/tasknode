// One-step agent connect: device-code sign-in (RFC 8628) so agents on remote
// machines connect without a localhost callback or a copied token, the
// /activate approval page, per-device token management on /connect, and the
// identity every agent sees. Manual token commands stay under "Advanced".
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appearancePageHead } from "./appearance-page.js";
import { authStart } from "./product-contracts.js";
import { getLinkedProviderForAccount } from "./repositories/accounts.js";
import { getAccountIdentityProfile } from "./repositories/account-profiles.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";
import {
  completeTerminalAuthRequest,
  consumeTerminalAuthRequestSession,
  createTerminalAuthRequest,
  decideDeviceAuthRequest,
  getDeviceAuthRequest,
  getTerminalSessionByToken,
  listAgentDevices,
  revokeAgentDevice,
  revokeTerminalSessions,
} from "./repositories/terminal-auth.js";
import { enforceRateLimit, json, requestIp, securityHeaders } from "./server-http-boundary.js";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const AGENT_GUIDE_URL = "https://postfiat.org/agents/";
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "tasknode-cli");
const agentNames = { claude: "Claude Code", codex: "Codex", hermes: "Hermes", pi: "Pi", opencode: "OpenCode", kilo: "Kilo", cursor: "Cursor", gemini: "Gemini CLI" };

export const escapeHtml = (value = "") => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const safe = (value, max = 120) => [...String(value ?? "")].filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127).join("").trim().slice(0, max);

export function connectCommand(origin) {
  return process.env.TASKNODE_CLI_NPM_PUBLISHED === "true" ? "npx -y tasknode connect" : `curl -fsSL ${origin}/install | sh`;
}

// --- identity ---------------------------------------------------------------

const identityCache = new Map();
const shortWallet = (address = "") => (address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);

export async function agentAccountIdentity({ accountId = "", githubUsername = "" } = {}) {
  const cached = identityCache.get(accountId);
  if (cached && Date.now() - cached.at < 60_000) return cached.identity;
  const [profile, wallet, github] = await Promise.all([
    getAccountIdentityProfile({ accountId }).catch(() => null),
    getLinkedWallet({ accountId }).catch(() => ({})),
    getLinkedProviderForAccount({ accountId, provider: "github" }).catch(() => null),
  ]);
  const githubName = github?.username || githubUsername || "";
  const handle = safe(profile?.hiveHandle || "", 80);
  const identity = {
    accountId,
    handle,
    displayName: safe(profile?.publicDisplayName || (handle ? `@${handle}` : githubName), 80),
    github: githubName,
    walletShort: wallet?.status === "linked" ? shortWallet(String(wallet.address || "")) : "",
  };
  identityCache.set(accountId, { identity, at: Date.now() });
  if (identityCache.size > 2000) identityCache.delete(identityCache.keys().next().value);
  return identity;
}

export const identityName = (identity = {}) => identity.handle || identity.github || identity.displayName || "this Task Node account";

export function identitySentence(identity = {}) {
  const details = [identity.github && `GitHub ${identity.github}`, identity.walletShort && `wallet ${identity.walletShort}`].filter(Boolean).join(", ");
  return `Connected as ${identityName(identity)}${details ? ` (${details})` : ""}.`;
}

// --- device authorization (RFC 8628) -----------------------------------------

function deviceUserCode() {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeUserCode(value = "") {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw Object.assign(new Error("request_too_large"), { status: 413 });
  }
  if (String(req.headers["content-type"] || "").includes("json")) return JSON.parse(raw || "{}");
  return Object.fromEntries(new URLSearchParams(raw));
}

async function handleDeviceAuthorization({ req, res, origin }) {
  if (req.method !== "POST") return json(res, 405, { error: "invalid_request" }, { allow: "POST" });
  if (await enforceRateLimit(req, res, { route: "oauth_device_authorization", limit: 20, windowMs: 10 * 60_000 })) return;
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return json(res, error.status || 400, { error: "invalid_request" });
  }
  const agents = (Array.isArray(body.agents) ? body.agents : String(body.agents || "").split(","))
    .map((id) => agentNames[safe(id, 20).toLowerCase()] || "")
    .filter(Boolean)
    .slice(0, 8);
  const ip = safe(requestIp(req), 120);
  const device = {
    clientName: safe(body.client_name || body.client_id || "MCP client", 80),
    clientVersion: safe(body.client_version, 20),
    deviceName: safe(body.device_name, 80),
    platform: safe(body.platform, 20),
    agents,
    ip,
  };
  let request;
  for (let attempt = 0; attempt < 3 && !request; attempt += 1) {
    const userCode = deviceUserCode();
    if (await getDeviceAuthRequest({ userCode })) continue;
    request = await createTerminalAuthRequest({ provider: "github", origin, userAgent: safe(req.headers["user-agent"], 300), ip, device, userCode });
  }
  if (!request) return json(res, 503, { error: "temporarily_unavailable" });
  const expiresIn = Math.max(60, Math.round((Date.parse(request.expiresAt) - Date.now()) / 1000));
  json(res, 200, {
    device_code: `${request.requestId}.${request.pollToken}`,
    user_code: request.userCode,
    verification_uri: `${origin}/activate`,
    verification_uri_complete: `${origin}/activate?code=${encodeURIComponent(request.userCode)}`,
    expires_in: expiresIn,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  }, { "cache-control": "no-store" });
}

const lastDevicePoll = new Map();

export async function handleDeviceTokenGrant({ form, res }) {
  const [requestId = "", pollToken = ""] = String(form.device_code || "").split(".");
  if (!requestId || !pollToken) return json(res, 400, { error: "invalid_grant", error_description: "device_code is required." });
  const now = Date.now();
  const previous = lastDevicePoll.get(requestId) || 0;
  lastDevicePoll.set(requestId, now);
  if (lastDevicePoll.size > 5000) lastDevicePoll.delete(lastDevicePoll.keys().next().value);
  if (now - previous < (DEVICE_POLL_INTERVAL_SECONDS - 1) * 1000) {
    return json(res, 400, { error: "slow_down", error_description: "Poll no more than every 5 seconds." });
  }
  const result = await consumeTerminalAuthRequestSession({ requestId, pollToken });
  if (result.ok) {
    lastDevicePoll.delete(requestId);
    const identity = await agentAccountIdentity({ accountId: result.session.accountId, githubUsername: result.session.githubUsername });
    return json(res, 200, {
      access_token: result.terminalToken,
      token_type: "Bearer",
      scope: (result.session.scopes || []).join(" "),
      account: identity,
    }, { "cache-control": "no-store" });
  }
  if (result.status === 202) return json(res, 400, { error: "authorization_pending", error_description: "Waiting for approval at /activate." });
  if (result.status === 404) return json(res, 400, { error: "expired_token", error_description: "The code expired. Start again." });
  if (result.error === "access_denied") return json(res, 400, { error: "access_denied", error_description: "The sign-in was denied." });
  if (result.error === "github_not_linked") {
    return json(res, 400, { error: "access_denied", error_description: "Link GitHub to your Task Node account first, then start again." });
  }
  return json(res, 400, { error: "invalid_grant", error_description: "This device code is not valid." });
}

// --- pages ------------------------------------------------------------------

const pageStyle = `body{margin:0;padding:48px 20px;background:var(--tn-bg,#faf9f6);color:var(--tn-text,#0d0d0d);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:42rem;margin:0 auto}h1{margin:0 0 4px;font-size:15px;font-weight:500;color:var(--tn-text-muted,#66685d)}
.who{margin:0 0 4px;font-size:30px;font-weight:600;letter-spacing:-.015em;line-height:1.2}.who-sub{margin:0 0 28px;font-size:14px;color:var(--tn-text-muted,#66685d)}
h2{margin:32px 0 8px;font-size:15px;font-weight:600}p{margin:0 0 14px;color:var(--tn-text-secondary,#45463e)}.muted{color:var(--tn-text-muted,#66685d);font-size:13px}
a{color:var(--tn-link,#315bb5)}.copy{display:flex;gap:8px;align-items:stretch;margin:0 0 10px}
.copy code,pre{flex:1;display:block;white-space:pre-wrap;word-break:break-all;user-select:all;margin:0;padding:12px 14px;border:1px solid var(--tn-border,#e8e6df);border-radius:10px;background:var(--tn-surface,#fff);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.button{display:inline-block;margin:0 8px 12px 0;padding:9px 16px;border:0;border-radius:10px;background:var(--tn-primary-bg,#111);color:var(--tn-primary-text,#fff);font:inherit;font-size:14px;font-weight:500;cursor:pointer;text-decoration:none}
.button.secondary{border:1px solid var(--tn-border,#e8e6df);background:transparent;color:inherit}.copy .button{margin:0;white-space:nowrap}
.card{margin:0 0 20px;padding:16px;border:1px solid var(--tn-border,#e8e6df);border-radius:12px}.code{font:600 26px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}
.device{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid var(--tn-border,#e8e6df)}.device form{margin:0}.device .button{margin:0}
details{margin-top:32px}summary{cursor:pointer;color:var(--tn-text-secondary,#45463e)}
:root[data-theme="dark"] main{background:transparent}:root[data-theme="dark"] a{color:#a4c6ff}:root[data-theme="dark"] .card,:root[data-theme="dark"] .device{border-color:#3b3d35}
:root[data-theme="dark"] pre,:root[data-theme="dark"] .copy code{background:#22231f;border-color:#3b3d35}:root[data-theme="dark"] .who{color:#f2f0e9}:root[data-theme="dark"] .who-sub,:root[data-theme="dark"] h1{color:#a5a69a}
:root[data-theme="dark"] .button.secondary{border-color:#3b3d35;background:transparent;color:#f2f0e9}
@media (prefers-color-scheme:dark){:root:not([data-theme]) body{background:#171816;color:#f2f0e9}}`;

export function agentPage(res, title, body, status = 200) {
  res.writeHead(status, { ...securityHeaders(), "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Task Node</title>${appearancePageHead}<script src="/agent-connect.js" defer></script>
<style>${pageStyle}</style>
<main>${body}</main>`);
}

const copyBlock = (value) => `<div class="copy"><code>${escapeHtml(value)}</code><button class="button secondary" data-copy="${escapeHtml(value)}" type="button">Copy</button></div>`;

function whoBlock(identity, switchHref) {
  const sub = [identity.github && `GitHub ${escapeHtml(identity.github)}`, identity.walletShort && `wallet ${escapeHtml(identity.walletShort)}`].filter(Boolean).join(" · ");
  return `<div class="who">Signed in as ${escapeHtml(identityName(identity))}</div>
<div class="who-sub">${sub ? `${sub} · ` : ""}Not you? <a href="${switchHref}">Switch account</a></div>`;
}

function relative(iso = "") {
  const ms = Date.now() - Date.parse(iso || "");
  if (!Number.isFinite(ms)) return "never";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// --- /activate --------------------------------------------------------------

async function handleActivate({ req, res, url, session }) {
  const code = normalizeUserCode(url.searchParams.get("code") || "");
  if (!session?.accountId) {
    res.writeHead(302, { "cache-control": "no-store", location: code ? `/#activate/${encodeURIComponent(code)}` : "/#activate" });
    return res.end();
  }
  const identity = await agentAccountIdentity({ accountId: session.accountId });
  const header = `<h1>Connect an agent</h1>${whoBlock(identity, `/#activate/${encodeURIComponent(code)}/switch`)}`;
  const codeForm = `<form method="get" action="/activate"><p>Enter the code your terminal shows.</p><div class="copy"><input aria-label="Code" autocomplete="off" autofocus class="code" name="code" placeholder="XXXX-XXXX" style="flex:1;padding:10px 14px;border:1px solid var(--tn-border,#c9c7bd);border-radius:10px;background:transparent;color:inherit" value="${escapeHtml(code)}"><button class="button" type="submit">Continue</button></div></form>`;
  if (!code) return agentPage(res, "Connect an agent", `${header}${codeForm}`);

  if (req.method === "POST") {
    const approve = url.searchParams.get("decision") === "approve";
    const result = await decideDeviceAuthRequest({ userCode: code, accountId: session.accountId, approve });
    if (result.ok && result.approved) {
      return agentPage(res, "Agent connected", `${header}<div class="card"><p><strong>Connected.</strong> Go back to your terminal; it finishes on its own and tells you which agents it set up.</p><p class="muted">Manage connected devices on <a href="/connect">/connect</a>.</p></div>`);
    }
    if (result.ok) return agentPage(res, "Sign-in denied", `${header}<div class="card"><p>Denied. Nothing was connected.</p></div>`);
    const message = result.error === "github_not_linked"
      ? `Link GitHub to your Task Node account first, then run the connect command again. <a href="/#settings/security">Open Settings → Security</a>`
      : "That code has expired or was already used. Run the connect command again for a new one.";
    return agentPage(res, "Connect an agent", `${header}<div class="card"><p>${message}</p></div>${codeForm}`, 400);
  }

  const request = await getDeviceAuthRequest({ userCode: code });
  if (!request || request.status !== "pending") {
    return agentPage(res, "Connect an agent", `${header}<div class="card"><p>That code has expired or was already used. Run the connect command again for a new one.</p></div>${codeForm}`, 404);
  }
  const github = await getLinkedProviderForAccount({ accountId: session.accountId, provider: "github" });
  const device = request.device || {};
  const what = device.agents?.length ? device.agents.join(", ") : device.clientName || "An agent";
  const where = [device.deviceName && `on ${escapeHtml(device.deviceName)}`, device.platform && `(${escapeHtml(device.platform)})`, request.ip && `from ${escapeHtml(request.ip)}`].filter(Boolean).join(" ");
  const card = `<div class="card"><p><strong>${escapeHtml(what)}</strong> ${where}</p><p class="muted">Check that this code matches your terminal:</p><p class="code">${escapeHtml(code)}</p></div>`;
  if (!github) {
    return agentPage(res, "Connect an agent", `${header}${card}<p>Agents sign in through GitHub. Link GitHub to ${escapeHtml(identityName(identity))} first, then reload this page.</p><a class="button" href="/#settings/security">Link GitHub</a>`);
  }
  const action = (decision) => `/activate?code=${encodeURIComponent(code)}&amp;decision=${decision}`;
  return agentPage(res, "Connect an agent", `${header}${card}
<form method="post" action="${action("approve")}" style="display:inline"><button class="button" type="submit">Approve</button></form>
<form method="post" action="${action("deny")}" style="display:inline"><button class="button secondary" type="submit">Deny</button></form>
<p class="muted">Approving gives this device access to ${escapeHtml(identityName(identity))}'s tasks, context and chat. You can revoke it any time on <a href="/connect">/connect</a>.</p>`);
}

// --- /connect ---------------------------------------------------------------

export function agentConnectCommands(origin, token) {
  const url = `${origin}/mcp`;
  return {
    codex: `codex mcp remove tasknode >/dev/null 2>&1; (umask 077; printf '\\n[mcp_servers.tasknode]\\nurl = "${url}"\\nhttp_headers = { Authorization = "Bearer ${token}" }\\n' >> "\${CODEX_HOME:-$HOME/.codex}/config.toml")`,
    claude: `claude mcp remove --scope user tasknode >/dev/null 2>&1; claude mcp add --scope user --transport http tasknode ${url} --header "Authorization: Bearer ${token}"`,
    hermes: `hermes config set MCP_TASKNODE_API_KEY ${token} && hermes config set --force mcp_servers.tasknode.url ${url} && hermes config set --force mcp_servers.tasknode.headers.Authorization 'Bearer \${MCP_TASKNODE_API_KEY}'`,
    pi: `pi mcp add tasknode --url ${url} --header "Authorization=Bearer ${token}" --exposure direct`,
    opencode: `opencode mcp add tasknode --url ${url} --header "Authorization=Bearer ${token}"`,
  };
}

const connectClients = [["codex", "Codex"], ["claude", "Claude Code"], ["hermes", "Hermes"], ["pi", "Pi"], ["opencode", "OpenCode (for Kilo, replace opencode with kilo)"]];

async function mintAgentToken(accountId, origin) {
  const request = await createTerminalAuthRequest({ provider: "github", origin, device: { clientName: "manual token", agents: [], deviceName: "" } });
  if (!(await completeTerminalAuthRequest({ requestId: request.requestId, accountId, provider: "github" })).ok) return "";
  const issued = await consumeTerminalAuthRequestSession({ requestId: request.requestId, pollToken: request.pollToken });
  return issued.ok ? issued.terminalToken : "";
}

async function handleConnect({ req, res, url, origin, session }) {
  if (!session?.accountId) {
    return agentPage(res, "Connect an agent", `<h1>Connect an agent</h1><div class="who">Sign in to connect an agent</div><div class="who-sub">Agents act as your Task Node account.</div>
<a class="button" href="/#connect">Sign in to Task Node</a>`);
  }
  if (url.pathname === "/connect/signout") {
    const count = await revokeTerminalSessions({ accountId: session.accountId });
    return agentPage(res, "Connect an agent", `<h1>Connect an agent</h1><p>Signed out ${count} agent and terminal token${count === 1 ? "" : "s"}. Agents using them can no longer reach this account.</p><a class="button" href="/connect">Back</a>`);
  }
  if (url.pathname === "/connect/revoke") {
    await revokeAgentDevice({ accountId: session.accountId, sessionId: safe(url.searchParams.get("session"), 120) });
    res.writeHead(303, { "cache-control": "no-store", location: "/connect" });
    return res.end();
  }
  const identity = await agentAccountIdentity({ accountId: session.accountId });
  const header = `<h1>Connect an agent</h1>${whoBlock(identity, "/#connect/switch")}`;
  const github = await getLinkedProviderForAccount({ accountId: session.accountId, provider: "github" });
  if (!github) {
    return agentPage(res, "Connect an agent", `${header}<p>Agents sign in through GitHub. Link GitHub to this account, then reopen this page.</p><a class="button" href="/#settings/security">Link GitHub</a>`);
  }
  const command = connectCommand(origin);
  if (req.method === "POST") {
    const token = await mintAgentToken(session.accountId, origin);
    if (!token) return agentPage(res, "Connect an agent", `${header}<p>The token could not be created. Reload this page and try again.</p>`, 500);
    const commands = agentConnectCommands(origin, token);
    return agentPage(res, "Manual setup", `${header}<h2>Manual setup with a token</h2>
<p>Paste one command into the terminal where your agent runs. This token is shown only once; never paste it into a chat.</p>
${connectClients.map(([key, label]) => `<h2>${label}</h2><pre>${escapeHtml(commands[key])}</pre>`).join("\n")}
<h2>Other MCP clients</h2><pre>${escapeHtml(`URL: ${origin}/mcp\nHeader: Authorization: Bearer ${token}`)}</pre>
<p>Then restart the agent and ask: "What are my outstanding Task Node tasks?" <a href="/connect">Back</a></p>`);
  }
  const devices = await listAgentDevices({ accountId: session.accountId });
  const deviceRows = devices.length
    ? devices.map((device) => `<div class="device"><div><strong>${escapeHtml(device.label)}</strong><br><span class="muted">Last used ${device.lastUsedAt ? escapeHtml(relative(device.lastUsedAt)) : "not yet recorded"}${device.lastIp ? ` · ${escapeHtml(device.lastIp)}` : ""} · added ${escapeHtml(String(device.createdAt).slice(0, 10))}</span></div>
<form method="post" action="/connect/revoke?session=${encodeURIComponent(device.sessionId)}"><button class="button secondary" type="submit">Revoke</button></form></div>`).join("\n")
    : `<p class="muted">No agents connected yet.</p>`;
  return agentPage(res, "Connect an agent", `${header}
<h2>Paste this into your agent</h2>
${copyBlock(`Connect me to Task Node: run ${command} and follow the link it prints.`)}
<p class="muted">Or run it yourself in the terminal where your agent runs. It finds Claude Code, Codex, Hermes, Pi, OpenCode, Kilo, Cursor and Gemini CLI, shows a code to approve here, and never prints the token.</p>
${copyBlock(command)}
<p class="muted">Step-by-step help for every agent: <a href="${AGENT_GUIDE_URL}" rel="noopener" target="_blank">postfiat.org/agents</a></p>
<h2>Connected devices</h2>
${deviceRows}
${devices.length ? `<form method="post" action="/connect/signout" style="margin-top:12px"><button class="button secondary" type="submit">Sign out all agents</button></form>` : ""}
<details><summary>Advanced: manual setup with a token</summary>
<p style="margin-top:12px">Creates a token and shows a paste-ready command for each agent. Never paste a token into a chat.</p>
<form method="post" action="/connect"><button class="button secondary" type="submit">Show token commands</button></form></details>`);
}

async function handleConnectLogin({ req, res, origin, responseHeadersForAuthResult }) {
  const result = await authStart("github", { origin, redirectPath: "/connect" });
  if (result.status !== 200 || !result.body?.redirectUrl) return agentPage(res, "Connect an agent", `<p>GitHub sign-in is unavailable right now. Sign in at <a href="/">Task Node</a>, then reopen this page.</p>`, 503);
  res.writeHead(302, { "cache-control": "no-store", ...responseHeadersForAuthResult(req, result), location: result.body.redirectUrl });
  res.end();
}

// --- agent-facing text, installer and whoami ---------------------------------

function connectMarkdown(origin) {
  const command = connectCommand(origin);
  return `# Connect to Task Node

Run this in the terminal where you (the agent) run:

    ${command}

It prints a link and a code. Show both to the user and ask them to open the link and tap Approve. When it finishes it prints which account it connected and which agents it set up; tell the user, then reconnect your MCP session (\`/mcp\` in Claude Code) or ask them to restart you.

- Never ask the user to paste a Task Node token into the chat.
- If the machine is already connected to a different account, the installer asks before replacing it.
- Check the account any time with \`${command.replace(" connect", " status").replace("| sh", "| sh -s -- --status")}\`.

Manual setup for every agent: ${AGENT_GUIDE_URL}
`;
}

async function sendCliFile(res, name, contentType) {
  try {
    const body = await readFile(path.join(cliDir, name), "utf8");
    res.writeHead(200, { ...securityHeaders(), "content-type": contentType, "cache-control": "public, max-age=300" });
    res.end(body);
  } catch {
    json(res, 404, { error: "not_found" });
  }
}

async function handleWhoami({ req, res }) {
  const header = String(req.headers.authorization || "").trim();
  const token = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "") : "";
  const session = token ? await getTerminalSessionByToken(token, { ip: requestIp(req) }) : null;
  if (!session?.accountId) return json(res, 401, { ok: false, error: "invalid_token" });
  json(res, 200, { ok: true, account: await agentAccountIdentity({ accountId: session.accountId, githubUsername: session.githubUsername }) }, { "cache-control": "no-store" });
}

export async function handleAgentConnectRoute(params) {
  const { res, url, origin } = params;
  const pathname = url.pathname;
  if (pathname === "/oauth/device_authorization") await handleDeviceAuthorization(params);
  else if (pathname === "/activate") await handleActivate(params);
  else if (pathname === "/connect" || pathname === "/connect/signout" || pathname === "/connect/revoke") await handleConnect(params);
  else if (pathname === "/connect/login") await handleConnectLogin(params);
  else if (pathname === "/connect.md") {
    res.writeHead(200, { ...securityHeaders(), "content-type": "text/markdown; charset=utf-8", "cache-control": "public, max-age=300" });
    res.end(connectMarkdown(origin));
  } else if (pathname === "/install") await sendCliFile(res, "install.sh", "text/x-shellscript; charset=utf-8");
  else if (pathname === "/install/tasknode.mjs") await sendCliFile(res, "bin/tasknode.mjs", "text/javascript; charset=utf-8");
  else if (pathname === "/api/agent/whoami") await handleWhoami(params);
  else return false;
  return true;
}
