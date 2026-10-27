#!/usr/bin/env node
// `tasknode connect` installer (packages/tasknode-cli) against a fake Task
// Node: RFC 8628 device sign-in (pending, slow_down, approval), Claude Code
// and Codex config writes that keep every other key and table, replacement
// safety with and without --yes, --scope local, revocation of superseded
// tokens, --status, --disconnect, CLI-driven and JSONC agents, and that no
// token ever reaches stdout or stderr.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../packages/tasknode-cli/bin/tasknode.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../packages/tasknode-cli/package.json", import.meta.url), "utf8"));
const root = mkdtempSync(path.join(tmpdir(), "tasknode-cli-smoke-"));

// Tokens are generated per run so no token-shaped literal lives in the repo.
const fakeToken = () => `tns_${randomBytes(18).toString("base64url")}`;
const tokens = { a: fakeToken(), b: fakeToken(), a2: fakeToken(), a3: fakeToken(), c: fakeToken(), d: fakeToken() };
const corbanu = { accountId: "acct_corbanu", handle: "corbanuAI", displayName: "Corbanu", github: "corbanuAI", walletShort: "rCo1…AbCd" };
const alex = { accountId: "acct_alex", handle: "goodalexander", displayName: "Alex", github: "goodalexander", walletShort: "rPo8…HxNx" };
const owners = new Map([[tokens.a, corbanu], [tokens.b, alex], [tokens.a2, corbanu], [tokens.a3, corbanu], [tokens.c, alex], [tokens.d, alex]]);

// Fake Task Node. Each device authorization takes the next scripted grant:
// its poll errors in order, then the token.
const state = { authorizations: [], polls: [], revokeCalls: [], revoked: new Set(), grants: [] };
const devices = new Map();
const queueGrant = (token, steps = []) => state.grants.push({ token, steps: [...steps] });
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const { pathname } = new URL(req.url, "http://localhost");
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
  const send = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "POST" && pathname === "/oauth/device_authorization") {
    const grant = state.grants.shift();
    if (!grant) return send(503, { error: "temporarily_unavailable" });
    const deviceCode = `device_${state.authorizations.length}`;
    state.authorizations.push({ contentType: req.headers["content-type"], body: JSON.parse(body) });
    devices.set(deviceCode, grant);
    return send(200, {
      device_code: deviceCode, user_code: "WDJB-MJHT", verification_uri: `${origin}/activate`,
      verification_uri_complete: `${origin}/activate?code=WDJB-MJHT`, expires_in: 60, interval: 0.05,
    });
  }
  if (req.method === "POST" && pathname === "/oauth/token") {
    const form = new URLSearchParams(body);
    state.polls.push({ at: Date.now(), contentType: req.headers["content-type"], grantType: form.get("grant_type"), deviceCode: form.get("device_code") });
    const grant = devices.get(form.get("device_code"));
    if (!grant || form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:device_code") return send(400, { error: "invalid_grant" });
    const step = grant.steps.shift();
    if (step) return send(400, { error: step, error_description: `scripted ${step}` });
    devices.delete(form.get("device_code"));
    return send(200, { access_token: grant.token, token_type: "Bearer", scope: "tasknode", account: owners.get(grant.token) });
  }
  if (req.method === "GET" && pathname === "/api/agent/whoami") {
    const account = !state.revoked.has(bearer) && owners.get(bearer);
    return account ? send(200, { ok: true, account }) : send(401, { error: "unauthorized" });
  }
  if (req.method === "POST" && pathname === "/api/auth/terminal/revoke") {
    state.revokeCalls.push(bearer);
    if (!owners.has(bearer) || state.revoked.has(bearer)) return send(401, { error: "unauthorized" });
    state.revoked.add(bearer);
    return send(200, { ok: true });
  }
  return send(404, { error: "not_found" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const mcpUrl = `${origin}/mcp`;

function assertNoSecrets(output, label) {
  for (const token of Object.values(tokens)) assert.ok(!output.includes(token), `${label} printed a token`);
  assert.doesNotMatch(output, /tns_/, `${label} printed a token prefix`);
}

// The CLI runs in a child with a clean environment: a temp HOME and a PATH of
// stub executables only, so no real agent or config on this machine is touched.
function tasknode(args, { home, binDir, cwd = home }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { HOME: home, USERPROFILE: home, PATH: binDir, TASKNODE_URL: origin, TASKNODE_NO_BROWSER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      assertNoSecrets(stdout + stderr, `tasknode ${args.join(" ")}`);      resolve({ code, stdout, stderr });
    });
  });
}

function makeHome(name, stubs) {
  const home = path.join(root, name);
  const binDir = path.join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const [bin, script] of Object.entries(stubs)) writeFileSync(path.join(binDir, bin), script, { mode: 0o755 });
  return { home, binDir };
}

// Minimal JSONC reader for assertions (comments and trailing commas).
function readJsonc(file) {
  const text = readFileSync(file, "utf8");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const start = i;
      for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += text[i];
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const mode = (file) => statSync(file).mode & 0o777;
const read = (file) => readFileSync(file, "utf8");
const httpEntry = (token) => ({ type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } });
const noop = "#!/bin/sh\nexit 0\n";

try {
  const version = await tasknode(["--version"], makeHome("plain", {}));
  assert.equal(version.stdout.trim(), pkg.version, "bin VERSION matches package.json");
  const help = await tasknode(["--help"], makeHome("plain", {}));
  assert.equal(help.code, 0);
  assert.match(help.stdout, /tasknode connect \[--agent claude,codex\] \[--scope local\] \[--yes\] \[--server URL\]/);

  // No agent installed: say what is supported and never start a sign-in.
  const none = await tasknode(["connect"], makeHome("empty", {}));
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No supported agent found\. Supported: Claude Code, Codex, Hermes, Pi, OpenCode, Kilo, Cursor, Gemini CLI\./);
  assert.equal(state.authorizations.length, 0, "no device authorization without an agent");

  // A machine where Claude Code and Codex are on corbanuAI (token A).
  const box = makeHome("box", { claude: noop, codex: noop });
  const claudeJson = path.join(box.home, ".claude.json");
  const codexToml = path.join(box.home, ".codex", "config.toml");
  const claudeDoc = {
    numStartups: 7,
    theme: "dark",
    mcpServers: { other: { type: "stdio", command: "other-mcp", args: [] }, tasknode: httpEntry(tokens.a) },
    projects: { "/elsewhere": { allowedTools: ["Bash"], mcpServers: {} } },
    oauthAccount: { emailAddress: "someone@example.com" },
  };
  writeFileSync(claudeJson, JSON.stringify(claudeDoc, null, 2), { mode: 0o644 });
  const codexHead = `model = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "other-mcp"\nargs = ["--flag"]\n\n`;
  const codexTail = `# Profiles stay below.\n[profiles.fast]\nmodel = "gpt-5.5-mini"\n`;
  mkdirSync(path.dirname(codexToml), { recursive: true });
  writeFileSync(codexToml, `${codexHead}[mcp_servers.tasknode]\nurl = "${mcpUrl}"\n\n[mcp_servers.tasknode.http_headers]\nAuthorization = "Bearer ${tokens.a}"\n\n${codexTail}`, { mode: 0o644 });

  // Approve as goodalexander after two pending polls and one slow_down.
  queueGrant(tokens.b, ["authorization_pending", "authorization_pending", "slow_down"]);
  const connected = await tasknode(["connect", "--yes"], box);
  assert.equal(connected.code, 0, connected.stderr);
  assert.ok(connected.stdout.includes(`To connect, open  ${origin}/activate  and enter  WDJB-MJHT\n(or open ${origin}/activate?code=WDJB-MJHT)\nWaiting for approval…\n`));
  assert.ok(connected.stdout.includes("Claude Code and Codex are connected as corbanuAI. Replacing with goodalexander."));
  assert.ok(connected.stdout.includes("Connected as goodalexander (wallet rPo8…HxNx)\n  ✓ Claude Code   ✓ Codex\n"));
  assert.ok(connected.stdout.includes("Revoked 1 old token."));
  assert.ok(connected.stdout.includes("Restart running agents, or run /mcp in Claude Code, to pick it up."));
  assert.deepEqual(state.authorizations[0], {
    contentType: "application/json",
    body: { client_name: "tasknode-cli", client_version: pkg.version, device_name: hostname(), platform: process.platform, agents: ["claude", "codex"] },
  });
  const polls = state.polls.filter((poll) => poll.deviceCode === "device_0");
  assert.equal(polls.length, 4, "pending, pending, slow_down, approved");
  assert.ok(polls.every((poll) => poll.contentType === "application/x-www-form-urlencoded" && poll.grantType === "urn:ietf:params:oauth:grant-type:device_code"));
  assert.ok(polls[3].at - polls[2].at >= 4500, "slow_down adds 5 seconds to the interval");
  assert.deepEqual(state.revokeCalls, [tokens.a], "the replaced token is revoked once");

  // Claude: only tasknode changed, formatting kept byte for byte, mode 600.
  assert.equal(read(claudeJson), JSON.stringify({ ...claudeDoc, mcpServers: { ...claudeDoc.mcpServers, tasknode: httpEntry(tokens.b) } }, null, 2));
  assert.equal(mode(claudeJson), 0o600);
  // Codex: the table and its subtable become one table in place; the rest stays.
  const codexConnected = `${codexHead}[mcp_servers.tasknode]\nurl = "${mcpUrl}"\nhttp_headers = { Authorization = "Bearer ${tokens.b}" }\n\n${codexTail}`;
  assert.equal(read(codexToml), codexConnected);
  assert.equal(mode(codexToml), 0o600);

  const status = await tasknode(["status"], box);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /^Claude Code\s+goodalexander \(wallet rPo8…HxNx\)$/m);
  assert.match(status.stdout, /^Codex\s+goodalexander \(wallet rPo8…HxNx\)$/m);
  assert.deepEqual((await tasknode(["--status"], box)).stdout, status.stdout, "--status is an alias");

  // Another account with no terminal and no --yes: nothing is replaced and the
  // unused new token is revoked.
  queueGrant(tokens.a2);
  const kept = await tasknode(["connect"], box);
  assert.equal(kept.code, 1);
  assert.ok(kept.stdout.includes("Claude Code and Codex are connected as goodalexander. Left as is: no terminal to confirm. Re-run with --yes to replace, or with --scope local to use this folder only."));
  assert.ok(kept.stdout.includes("Signed in as corbanuAI (wallet rCo1…AbCd). No agent changed.\n  – Claude Code (kept goodalexander)   – Codex (kept goodalexander)\n"));
  assert.deepEqual(state.revokeCalls, [tokens.a, tokens.a2]);
  assert.equal(read(codexToml), codexConnected);
  assert.equal(JSON.parse(read(claudeJson)).mcpServers.tasknode.headers.Authorization, `Bearer ${tokens.b}`);

  // --scope local: corbanuAI for one folder; the user scope and Codex stay on goodalexander.
  const project = path.join(root, "project");
  mkdirSync(project);
  queueGrant(tokens.a3);
  const local = await tasknode(["connect", "--scope", "local", "--yes"], { ...box, cwd: project });
  assert.equal(local.code, 0, local.stderr);
  assert.ok(local.stdout.includes("Connected as corbanuAI (wallet rCo1…AbCd)\n  ✓ Claude Code (this folder)\n"));
  assert.deepEqual(state.authorizations.at(-1).body.agents, ["claude"]);
  const projectKey = realpathSync(project);
  const afterLocal = JSON.parse(read(claudeJson));
  assert.deepEqual(afterLocal.projects[projectKey], {
    allowedTools: [], mcpContextUris: [], mcpServers: { tasknode: httpEntry(tokens.a3) }, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
    hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
  });
  assert.deepEqual(afterLocal.projects["/elsewhere"], claudeDoc.projects["/elsewhere"]);
  assert.deepEqual(afterLocal.mcpServers.tasknode, httpEntry(tokens.b));
  assert.equal(read(codexToml), codexConnected);
  assert.deepEqual(state.revokeCalls, [tokens.a, tokens.a2], "nothing replaced, nothing revoked");

  const localStatus = await tasknode(["status"], { ...box, cwd: project });
  assert.match(localStatus.stdout, /^Claude Code\s+goodalexander \(wallet rPo8…HxNx\)$/m);
  assert.match(localStatus.stdout, /^Claude Code \(this folder\)\s+corbanuAI \(wallet rCo1…AbCd\)$/m);
  assert.match(localStatus.stdout, /^Codex\s+goodalexander/m);

  // Disconnect removes every entry it finds and revokes each distinct token once.
  const disconnected = await tasknode(["disconnect"], { ...box, cwd: project });
  assert.equal(disconnected.code, 0, disconnected.stderr);
  assert.ok(disconnected.stdout.includes("Disconnected Claude Code and Codex."));
  assert.ok(disconnected.stdout.includes("Revoked 2 tokens."));
  assert.deepEqual(state.revokeCalls, [tokens.a, tokens.a2, tokens.b, tokens.a3]);
  const afterDisconnect = JSON.parse(read(claudeJson));
  assert.deepEqual(afterDisconnect.mcpServers, { other: claudeDoc.mcpServers.other });
  assert.deepEqual(afterDisconnect.projects[projectKey].mcpServers, {});
  assert.equal(afterDisconnect.oauthAccount.emailAddress, "someone@example.com");
  assert.equal(read(codexToml), `${codexHead}${codexTail}`);
  const statusAfter = await tasknode(["status"], box);
  assert.match(statusAfter.stdout, /^Claude Code\s+not connected$/m);
  assert.match(statusAfter.stdout, /^Codex\s+not connected$/m);
  assert.equal((await tasknode(["disconnect"], box)).stdout.trim(), "Nothing to disconnect.");

  // CLI-driven (Pi) and JSONC (Cursor, Gemini CLI) agents.
  const piStub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const file = path.join(process.env.HOME, ".pi", "agent", "mcp.json");
fs.appendFileSync(path.join(process.env.HOME, "pi-calls.jsonl"), JSON.stringify(args) + "\\n");
const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { mcpServers: {} };
const option = (name) => args[args.indexOf(name) + 1];
if (args[1] === "add") {
  const [key, ...value] = option("--header").split("=");
  doc.mcpServers[args[2]] = { url: option("--url"), headers: { [key]: value.join("=") }, exposure: option("--exposure") };
} else if (args[1] === "remove" && doc.mcpServers[args[2]]) delete doc.mcpServers[args[2]];
else process.exit(1);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(doc, null, 2));
`;
  const laptop = makeHome("laptop", { pi: piStub });
  const cursorJson = path.join(laptop.home, ".cursor", "mcp.json");
  const geminiJson = path.join(laptop.home, ".gemini", "settings.json");
  mkdirSync(path.dirname(cursorJson));
  mkdirSync(path.dirname(geminiJson));
  writeFileSync(cursorJson, `{\n  // Cursor keeps comments.\n  "mcpServers": {\n    "docs": { "command": "docs-mcp" },\n  },\n}\n`);
  writeFileSync(geminiJson, `{\n  "theme": "Default",\n  "security": { "auth": { "selectedType": "oauth-personal" } }\n}\n`);
  queueGrant(tokens.c, ["authorization_pending"]);
  const many = await tasknode(["connect", "--agent", "pi,hermes,cursor,gemini"], laptop);
  assert.equal(many.code, 0, many.stderr);
  assert.ok(many.stdout.includes("Connected as goodalexander (wallet rPo8…HxNx)\n  ✓ Pi   ✓ Cursor   ✓ Gemini CLI   – Hermes (not installed)\nRestart running agents to pick it up.\n"));
  const piCalls = () => read(path.join(laptop.home, "pi-calls.jsonl")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(piCalls(), [["mcp", "add", "tasknode", "--url", mcpUrl, "--header", `Authorization=Bearer ${tokens.c}`, "--exposure", "direct"]]);
  const authHeader = { Authorization: `Bearer ${tokens.c}` };
  assert.ok(read(cursorJson).includes("// Cursor keeps comments."));  assert.deepEqual(readJsonc(cursorJson), { mcpServers: { docs: { command: "docs-mcp" }, tasknode: { url: mcpUrl, headers: authHeader } } });
  assert.deepEqual(JSON.parse(read(geminiJson)), {
    theme: "Default", security: { auth: { selectedType: "oauth-personal" } }, mcpServers: { tasknode: { httpUrl: mcpUrl, headers: authHeader } },
  });
  assert.ok(read(geminiJson).endsWith("}\n"));
  assert.equal(mode(cursorJson), 0o600);
  assert.equal(mode(geminiJson), 0o600);

  // Re-running for the same account refreshes quietly (no prompt) and revokes the superseded token.
  queueGrant(tokens.d);
  const refreshed = await tasknode(["connect", "--agent", "cursor,gemini"], laptop);
  assert.equal(refreshed.code, 0, refreshed.stderr);
  assert.ok(!refreshed.stdout.includes("Replace"), "same account needs no confirmation");
  assert.ok(refreshed.stdout.includes("  ✓ Cursor   ✓ Gemini CLI\n"));
  assert.deepEqual(readJsonc(cursorJson).mcpServers.tasknode.headers, { Authorization: `Bearer ${tokens.d}` });
  assert.ok(!state.revokeCalls.includes(tokens.c), "Pi still uses the old token, so it stays live");

  const laptopStatus = await tasknode(["status", "--agent", "pi,cursor,gemini"], laptop);
  assert.match(laptopStatus.stdout, /^Pi\s+goodalexander/m);
  assert.match(laptopStatus.stdout, /^Cursor\s+goodalexander/m);
  assert.match(laptopStatus.stdout, /^Gemini CLI\s+goodalexander/m);

  const laptopOff = await tasknode(["disconnect"], laptop);
  assert.equal(laptopOff.code, 0, laptopOff.stderr);
  assert.ok(laptopOff.stdout.includes("Disconnected Pi, Cursor and Gemini CLI.\nRevoked 2 tokens.\n"));
  assert.deepEqual(piCalls().at(-1), ["mcp", "remove", "tasknode"]);
  assert.deepEqual(state.revokeCalls.slice(-2).sort(), [tokens.c, tokens.d].sort());
  assert.deepEqual(readJsonc(cursorJson), { mcpServers: { docs: { command: "docs-mcp" } } });
  assert.ok(read(cursorJson).includes("// Cursor keeps comments."));
  assert.deepEqual(JSON.parse(read(geminiJson)).mcpServers, {});

  // A declined sign-in changes nothing.
  const cursorBefore = read(cursorJson);
  queueGrant(tokens.c, ["access_denied"]);
  const denied = await tasknode(["connect", "--agent", "cursor"], laptop);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Sign-in was declined\. Nothing changed\./);
  assert.equal(read(cursorJson), cursorBefore);

  console.log("tasknode cli smoke ok");
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
