#!/usr/bin/env node
// Synthetic local-only browser + real stdio MCP + Postgres acceptance.
/* global document */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
const root = process.cwd();
const output = path.join(root, "artifacts/prompts/acceptance-" + Date.now());
mkdirSync(output, { recursive: true });
process.env.TMPDIR = path.join(root, ".tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });
process.env.TASKNODE_STORE_PATH = path.join(output, "fixture-runtime.json");
process.env.DATABASE_URL = "postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5438/tasknodeofficial";
process.env.TASKNODE_DATABASE_ENABLED = "true";
const { query, getPool } = await import("../server/db/pool.js");
const { linkWalletToAccount } = await import("../server/repositories/account-wallets.js");
const { linkProviderToAccount, getOrCreateEmailAccount } = await import("../server/repositories/accounts.js");
const { createAccountSession } = await import("../server/repositories/auth-sessions.js");
const { sessionCookieName } = await import("../server/runtime-store.js");
const req = createRequire(path.join(process.env.PFDOCS_ROOT || "/home/postfiat/repos/pftdocs", "package.json"));
const { chromium } = req("./artifacts/spike-browser/node_modules/playwright");
const origin = "http://localhost:3195";
let stage = "start";
let page;
let browser;
let installer;
let mcp;
const events = [];
const emit = (name, data = {}) => {
  stage = name;
  const event = { at: new Date().toISOString(), stage: name, ...data };
  events.push(event);
  console.log(JSON.stringify(event));
  writeFileSync(path.join(output, "acceptance.jsonl"), events.map((row) => JSON.stringify(row)).join("\n") + "\n");
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(200);
  }
  throw new Error(label);
}
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROMIUM_PATH || "/home/postfiat/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  const leaks = [];
  const assistantRequests = [];
  const browserErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      browserErrors.push(
        msg
          .text()
          .replace(/https?:\/\/[^\s]+/g, "[URL]")
          .replace(/[A-Za-z0-9+/_=-]{40,}/g, "[REDACTED]")
          .slice(0, 1200),
      );
      writeFileSync(path.join(output, "browser-errors.json"), JSON.stringify(browserErrors));
    }
  });
  page.on("pageerror", (error) => {
    browserErrors.push(
      error.name +
        ": " +
        error.message.replace(/https?:\/\/[^\s]+/g, "[URL]").replace(/[A-Za-z0-9+/_=-]{40,}/g, "[REDACTED]"),
    );
    writeFileSync(path.join(output, "browser-errors.json"), JSON.stringify(browserErrors));
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      writeFileSync(
        path.join(output, "last-http-error.json"),
        JSON.stringify({ path: new URL(response.url()).pathname, status: response.status() }),
      );
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) {
      if (/\/documents\/.+\/(assistant|odv)$/.test(url.pathname)) assistantRequests.push(url.pathname);
      if (request.postData()?.includes("SYNTHETIC_PROMPT_ACCEPTANCE")) leaks.push(url.pathname);
    }
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const email = `prompt-${randomUUID()}@example.invalid`;
  const account = await getOrCreateEmailAccount({ email, canonicalEmail: email });
  const identity = await createAccountSession(account);
  const accountId = identity.session.accountId;
  await context.addCookies([
    { name: sessionCookieName, value: identity.sessionId, url: origin, httpOnly: true, sameSite: "Lax" },
  ]);
  const fixture = await page.evaluate(
    async ({ accountId, password }) => {
      const core = await import("/src/wallet-core.js");
      const mnemonic = core.generateTaskNodeMnemonic();
      await core.saveEncryptedMnemonicVault({ accountId, mnemonic, password });
      return {
        ...core.deriveWalletSummary(mnemonic),
        encryptionPublicKey: await core.deriveTaskNodePublicKey(mnemonic),
      };
    },
    { accountId, password: "SyntheticLocalPassword-" + (globalThis.fixturePassword = randomBytes(16).toString("hex")) },
  );
  await linkWalletToAccount({
    accountId,
    address: fixture.address,
    publicKey: fixture.publicKey,
    encryptionPublicKey: fixture.encryptionPublicKey,
  });
  await linkProviderToAccount({
    accountId,
    provider: "github",
    providerUserId: "synthetic-" + randomUUID(),
    username: "prompt-acceptance",
    displayName: "Prompt acceptance",
  });
  emit("local_fixture_ready", { postgres: true, syntheticAccount: true });
  await page.goto(origin + "/#docs", { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Hive handle", { exact: true }).fill("promptacc" + randomBytes(5).toString("hex"));
  await page.getByRole("button", { name: "Save handle", exact: true }).click();
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByLabel("Wallet unlock password").fill("SyntheticLocalPassword-" + globalThis.fixturePassword);
  await page
    .getByRole("dialog", { name: "Unlock seed wallet" })
    .getByRole("button", { name: "Unlock", exact: true })
    .click();
  await page.getByRole("button", { name: "Create Docs library", exact: true }).click();
  await page.locator(".docs-new-menu summary").waitFor();
  emit("browser_docs_unlocked_and_initialized");
  await page.locator(".docs-new-menu summary").click();
  await page.getByRole("button", { name: "New prompt", exact: true }).click();
  let frame;
  await until(
    async () => {
      frame = page.frames().find((item) => item.url().includes("/code/inner.html"));
      return frame && frame.evaluate(() => Boolean(document.querySelector(".CodeMirror")?.CodeMirror));
    },
    "editor_ready",
    90000,
  );
  await page.getByRole("button", { name: "Save version", exact: true }).waitFor();
  await until(
    () => page.getByRole("button", { name: "Save version", exact: true }).isEnabled(),
    "editor_context_ready",
  );
  const initial = "# SYNTHETIC_PROMPT_ACCEPTANCE\nBrowser authored prompt.\n";
  await frame.evaluate((text) => {
    const cm = document.querySelector(".CodeMirror").CodeMirror;
    cm.focus();
    cm.replaceRange(text, { line: 0, ch: 0 }, undefined, "+input");
  }, initial);
  await delay(1200);
  await frame.evaluate(() => {
    const cm = document.querySelector(".CodeMirror").CodeMirror;
    cm.replaceRange("Second input second.\n", { line: cm.lastLine(), ch: 0 }, undefined, "+input");
  });
  const docs = await page.evaluate(() => fetch("/api/docs").then((r) => r.json()));
  const doc = docs.documents.find((doc) => doc.documentType === "prompt");
  assert.ok(doc);
  assert.equal(await page.getByLabel("Include full Task Node context").count(), 0);
  await page.screenshot({ path: path.join(output, "prompt-editor.png"), fullPage: true });
  emit("browser_prompt_created", { documentId: doc.documentId, markdownEditor: true, assistantControlsAbsent: true });
  // Actual installer, isolated config paths only. No HOME or CODEX_HOME overrides.
  const config = path.join(output, "cli");
  const claude = path.join(output, "claude");
  mkdirSync(config);
  mkdirSync(claude);
  writeFileSync(path.join(claude, ".claude.json"), "{}", { mode: 0o600 });
  let installOutput = "";
  installer = spawn(
    "sh",
    ["packages/tasknode-cli/install.sh", "--agent", "claude", "--server", origin, "--no-browser"],
    {
      cwd: root,
      env: {
        ...process.env,
        TASKNODE_URL: origin,
        CLAUDE_CONFIG_DIR: claude,
        TASKNODE_CONFIG_DIR: config,
        npm_config_cache: path.join(root, ".tmp/npm-cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  installer.stdout.on("data", (chunk) => {
    installOutput += chunk;
  });
  installer.stderr.on("data", (chunk) => {
    installOutput += chunk;
  });
  const installExit = new Promise((resolve) => installer.on("exit", resolve));
  await until(() => /\/activate\?code=([A-Z-]+)/.test(installOutput), "installer_activation");
  const code = /\/activate\?code=([A-Z-]+)/.exec(installOutput)[1];
  const approve = await context.newPage();
  await approve.goto(origin + "/activate?code=" + code);
  await approve.getByRole("button", { name: "Approve", exact: true }).click();
  assert.equal(await installExit, 0);
  const deviceFile = path.join(config, "devices", readdirSync(path.join(config, "devices"))[0]);
  const device = JSON.parse(readFileSync(deviceFile, "utf8"));
  assert.ok(installOutput.includes(device.fingerprint.replace(/(.{4})/g, "$1 ").trim()));
  assert.ok(!installOutput.includes(device.privateKey));
  assert.ok(!installOutput.includes(device.token));
  const agentConfig = JSON.parse(readFileSync(path.join(claude, ".claude.json"), "utf8"));
  assert.ok(agentConfig.mcpServers.tasknode);
  assert.ok(agentConfig.mcpServers["tasknode-prompts"]);
  const installedCli = agentConfig.mcpServers["tasknode-prompts"].args[0];
  const installedLock = path.resolve(path.dirname(installedCli), "../package-lock.json");
  assert.equal(readFileSync(installedLock, "utf8"), readFileSync("packages/tasknode-cli/package-lock.json", "utf8"));
  // Return to library to approve from the unlocked browser.
  await page.locator(".docs-editor-back").click();
  await page.getByRole("button", { name: "Agent access", exact: true }).click();
  await page.getByRole("button", { name: "Approve prompt access", exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "device-approval.png"), fullPage: true });
  assert.ok(
    (await page.getByRole("region", { name: "Prompt devices" }).innerText()).includes(
      device.fingerprint.replace(/(.{4})/g, "$1 ").trim(),
    ),
  );
  const denied = await fetch(origin + "/api/docs/prompts/documents", {
    headers: { authorization: `Bearer ${device.token}`, "x-prompt-device": device.deviceId },
  });
  assert.equal(denied.status, 403);
  await page.getByRole("button", { name: "Approve prompt access", exact: true }).click();
  await until(
    () =>
      page
        .getByRole("button", { name: "Approve prompt access", exact: true })
        .count()
        .then((count) => count === 0),
    "device_approved",
  );
  const pairingCode = await page.locator("[data-pairing-code]").getAttribute("data-pairing-code");
  const pairer = spawn(
    process.execPath,
    ["packages/tasknode-cli/bin/tasknode.mjs", "prompts-pair", "--device-file", deviceFile, "--code", pairingCode],
    { cwd: root, stdio: "ignore" },
  );
  assert.equal(await new Promise((resolve) => pairer.on("exit", resolve)), 0);
  await page.getByRole("button", { name: "Close agent access", exact: true }).click();
  emit("device_approved", {
    fingerprintMatched: true,
    outOfBandKeyPairing: true,
    unapprovedDenied: true,
    hostedAndLocalEntries: true,
  });
  await page.getByRole("button", { name: "Prompts", exact: true }).click();
  await page.locator(".docs-file-name").first().click();
  await until(
    async () => {
      frame = page.frames().find((item) => item.url().includes("/code/inner.html"));
      return (
        frame &&
        frame.evaluate(() =>
          document.querySelector(".CodeMirror")?.CodeMirror?.getValue().includes("SYNTHETIC_PROMPT_ACCEPTANCE"),
        )
      );
    },
    "reopen_prompt",
    90000,
  );
  mcp = spawn(
    process.execPath,
    ["packages/tasknode-cli/bin/tasknode.mjs", "prompts-mcp", "--device-file", deviceFile],
    { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "";
  let sequence = 0;
  const pending = new Map();
  mcp.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n");
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const result = JSON.parse(line);
        pending.get(result.id)?.(result);
        pending.delete(result.id);
      } catch {
        /* Tool responses still must arrive before the deadline. */
      }
    }
  });
  async function rpc(method, params = {}) {
    const id = ++sequence;
    const result = await Promise.race([
      new Promise((resolve) => {
        pending.set(id, resolve);
        mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
      delay(45000).then(() => {
        throw new Error("mcp_timeout");
      }),
    ]);
    assert.ok(!result.error);
    assert.ok(!result.result.isError);
    return result.result;
  }
  async function tool(name, args = {}) {
    return JSON.parse((await rpc("tools/call", { name, arguments: args })).content[0].text);
  }
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "local-acceptance", version: "1" },
  });
  assert.equal((await rpc("tools/list")).tools.length, 9);
  const listed = await tool("prompt_list");
  assert.ok(listed.some((row) => row.documentId === doc.documentId));
  const read = await tool("prompt_read", { documentId: doc.documentId });
  assert.match(read.text, /Browser authored prompt/);
  emit("local_mcp_read", { text: read.text });
  await tool("prompt_edit", {
    documentId: doc.documentId,
    patches: [{ oldText: "Browser authored prompt.", newText: "Agent edited live via local MCP." }],
  });
  await until(
    () =>
      frame.evaluate(() =>
        document.querySelector(".CodeMirror").CodeMirror.getValue().includes("Agent edited live via local MCP."),
      ),
    "agent_edit_live",
  );
  await page.screenshot({ path: path.join(output, "agent-edit-visible.png"), fullPage: true });
  emit("local_mcp_edit_visible_in_browser", { live: true });
  const version = await tool("prompt_save_version", { documentId: doc.documentId });
  assert.match(version.text, /Agent edited live/);
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await page.getByText("Version saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Prompt timeline", exact: true }).click();
  const timeline = page.getByRole("complementary", { name: "Prompt timeline" });
  await timeline.getByRole("button", { name: "Read", exact: true }).first().click();
  assert.match(
    await page.getByRole("region", { name: "Saved version text" }).innerText(),
    /Agent edited live via local MCP/,
  );
  await page.screenshot({ path: path.join(output, "version-timeline.png"), fullPage: true });
  await page.getByRole("button", { name: "Close timeline", exact: true }).click();
  emit("saved_version_read_in_editor", { timeline: true, savedTextVisible: true });
  // Synthetic score metadata only. Never execute the paid Text Improvement Harness.
  await tool("prompt_log_tih_run", { documentId: doc.documentId, before: 6, after: 8 });
  const created = await tool("prompt_create", {
    name: "Agent deliberate prompt",
    text: "# Synthetic agent-created prompt\n",
  });
  assert.ok(created.documentId);
  const history = await tool("prompt_history", { documentId: doc.documentId });
  assert.ok(history.some((event) => event.kind === "edit_session" && event.activeSeconds >= 2));
  assert.equal(history.filter((event) => event.kind === "version_saved").length, 2);
  const stats = await tool("prompt_stats", { days: 7 });
  assert.equal(stats.totals.created, 2);
  assert.equal(stats.totals.versions, 2);
  assert.ok(stats.totals.activeSeconds >= 2);
  emit("versions_history_tih_and_stats", {
    stats,
    historyKinds: history.map((event) => event.kind),
    agentCreate: true,
  });
  // No real prompt text is sent to either assistant route, even for the negative request.
  for (const route of ["assistant", "odv"]) {
    const response = await context.request.post(`${origin}/api/docs/documents/${doc.documentId}/${route}`, {
      data: { channelHash: doc.channelHash, prompt: "@ODV boundary test", documentContent: "boundary test" },
    });
    assert.equal(response.status(), 403);
  }
  assert.equal(leaks.length, 0);
  assert.equal(assistantRequests.length, 0);
  const dump = (
    await query(
      "SELECT event_id,account_id,document_id,created_at,ciphertext FROM prompt_history_events WHERE account_id=$1 ORDER BY created_at,event_id",
      [accountId],
    )
  ).rows;
  const raw = JSON.stringify(dump, null, 2);
  for (const canary of [
    "SYNTHETIC_PROMPT_ACCEPTANCE",
    "Browser authored",
    "Agent edited",
    "version_saved",
    "edit_session",
    "tih_run",
  ])
    assert.ok(!raw.includes(canary));
  writeFileSync(path.join(output, "history-rows.json"), raw + "\n");
  emit("database_ciphertext_only", {
    rows: dump.length,
    columns: Object.keys(dump[0]),
    plaintextCanariesAbsent: true,
    assistantRoutesDenied: true,
  });
  await page.locator(".docs-editor-back").click();
  await page.getByRole("button", { name: "Prompts", exact: true }).click();
  await page.getByRole("button", { name: "Refresh library", exact: true }).click();
  await until(
    () =>
      page
        .getByRole("region", { name: "Prompt statistics" })
        .innerText()
        .then((text) => text.includes("2 prompts created") && text.includes("2 versions saved")),
    "browser_stats",
  );
  await page.screenshot({ path: path.join(output, "prompts-library.png"), fullPage: true });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export recovery", exact: true }).click();
  const download = await downloadPromise;
  const backup = JSON.parse(readFileSync(await download.path(), "utf8"));
  assert.equal(backup.schema, "tasknode.docs.recovery.v2");
  // Load the local recovery code before taking the browser fully offline.
  await page.evaluate(async () => {
    globalThis.promptRecoveryModule = await import("/src/features/docs-library/prompt-recovery.js");
    globalThis.promptWalletModule = await import("/src/wallet-core.js");
  });
  await context.setOffline(true);
  const recovered = await page.evaluate(
    async ({ backup, accountId, password }) => {
      const wallet = await globalThis.promptWalletModule.unlockEncryptedMnemonicVault({ accountId, password });
      const root = JSON.parse(
        await globalThis.promptWalletModule.decryptTaskNodePayload({
          blob: backup.account.encryptedRootKeyEnvelope,
          mnemonic: wallet.mnemonic,
        }),
      );
      const recovered = await globalThis.promptRecoveryModule.recoverPromptLibrary(backup, root.rootKey);
      return {
        documents: recovered.documents.length,
        versions: recovered.events.filter((event) => event.kind === "version_saved").length,
        savedText: recovered.events.some((event) => event.text?.includes("Agent edited live via local MCP")),
      };
    },
    { backup, accountId, password: "SyntheticLocalPassword-" + globalThis.fixturePassword },
  );
  assert.deepEqual(recovered, { documents: 2, versions: 2, savedText: true });
  await context.setOffline(false);
  emit("encrypted_export_recovered_offline", { ...recovered, networkDisabled: true });
  await approve.goto(origin + "/connect");
  assert.ok((await approve.locator("body").innerText()).includes("Prompt library devices"));
  await approve.getByRole("button", { name: "Revoke prompt access", exact: true }).click();
  const revoked = await fetch(origin + "/api/docs/prompts/history", {
    headers: { authorization: `Bearer ${device.token}`, "x-prompt-device": device.deviceId },
  });
  assert.equal(revoked.status, 403);
  emit("revocation_enforced", { status: revoked.status });
  await page.route("**/api/docs/prompts/history*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "synthetic_history_outage" }),
    }),
  );
  await page.getByRole("button", { name: "Refresh library", exact: true }).click();
  await page
    .getByText("Prompt history could not be unlocked. Refresh to retry; other Docs remain available.", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".docs-file-row").count(), 2);
  assert.equal(await page.getByRole("region", { name: "Prompt statistics" }).count(), 0);
  await page.unroute("**/api/docs/prompts/history*");
  emit("history_outage_isolated", { faultInjection: true, libraryStillAvailable: true, incompleteStatsHidden: true });
  await page.getByRole("button", { name: "Refresh library", exact: true }).click();
  await page.getByRole("region", { name: "Prompt statistics" }).waitFor();
  let releaseHistory;
  let historyWaiting = false;
  const historyGate = new Promise((resolve) => {
    releaseHistory = resolve;
  });
  await page.route("**/api/docs/prompts/history*", async (route) => {
    historyWaiting = true;
    await historyGate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "synthetic_stalled_history" }),
    });
  });
  await page.getByRole("button", { name: "Refresh library", exact: true }).click();
  await until(() => historyWaiting, "stalled_history_started");
  await until(
    () => page.locator(".docs-file-name").first().isEnabled(),
    "library_visible_during_stalled_history",
    5000,
  );
  assert.equal(await page.locator(".docs-file-row").count(), 2);
  emit("stalled_history_isolated", { faultInjection: true, libraryUsableBeforeHistoryResponse: true });
  releaseHistory();
  await page
    .getByText("Prompt history could not be unlocked. Refresh to retry; other Docs remain available.", { exact: true })
    .waitFor();
  await page.unroute("**/api/docs/prompts/history*");
  await page.getByRole("button", { name: "Refresh library", exact: true }).click();
  await page.getByRole("region", { name: "Prompt statistics" }).waitFor();
  const storageState = await context.storageState({ indexedDB: true });
  writeFileSync(
    path.join(root, "artifacts/prompts/review-session.json"),
    JSON.stringify({
      origin,
      accountId,
      storageState,
      password: "SyntheticLocalPassword-" + globalThis.fixturePassword,
    }),
    { mode: 0o600 },
  );
  emit("PASS", {
    browserCreate: true,
    localStdioMcp: true,
    liveEdit: true,
    versions: 2,
    promptsCreated: 2,
    encryptedHistory: true,
    output: path.relative(root, output),
  });
  writeFileSync(path.join(root, "artifacts/prompts/latest-acceptance.txt"), output + "\n");
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
    writeFileSync(
      path.join(output, "browser-state.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable"),
    );
  }
  // Diagnostic file is local/ignored, and never includes serialized arguments or capabilities.
  writeFileSync(
    path.join(output, "failure.txt"),
    `${stage}\n${error.name}\n${String(error.message)
      .replace(/https?:\/\/[^\s]+/g, "[URL]")
      .slice(0, 20000)}\n`,
  );
  emit("FAIL", { failedAfter: stage, error: error.name, output: path.relative(root, output) });
  process.exitCode = 1;
} finally {
  installer?.kill();
  mcp?.kill();
  await browser?.close();
  await getPool().end();
  process.exit(process.exitCode || 0);
}
