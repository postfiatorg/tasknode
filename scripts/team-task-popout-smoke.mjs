import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const cdpPort = Number(process.env.CDP_PORT || 9340);
const appOrigin = process.env.TASKNODE_APP_ORIGIN || "http://localhost:5175";
const screenshotPath = process.env.SCREENSHOT_PATH || "";
const viewportWidth = Number(process.env.VIEWPORT_WIDTH || 1440);
const viewportHeight = Number(process.env.VIEWPORT_HEIGHT || 900);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const member = {
  accountId: "account_report",
  identity: { displayName: "@teammate", hiveHandle: "teammate" },
  relationship: "direct_report",
  seesTheirs: true,
  theySeeYours: false,
  summary: { taskCount: 2, rewardPft: 4200 },
};
const task = {
  id: "task_demo_1",
  fullId: "task_demo_1_full",
  taskId: "task_demo_1_full",
  title: "Build a deterministic trading review checklist",
  description: "Document the review process and identify the highest-risk execution gap.",
  status: "Verification requested",
  statusKey: "verification_requested",
  pft: 4200,
  deadlineAt: "2026-08-20T17:00:00.000Z",
  updatedAt: "2026-08-13T10:00:00.000Z",
  steps: ["Review the current process.", "Publish the proposed checklist."],
  verification: { body: "Provide the final document and a short explanation of the changes." },
};
const appState = {
  session: {
    status: "signed_in",
    accountId: "account_viewer",
    displayName: "@viewer",
    hiveHandle: "viewer",
    identityProfile: { displayName: "@viewer", handleRequired: false },
    linkedProviders: [],
    accountLinks: [],
  },
  wallet: { pftWallet: { status: "linked", address: "rViewerWallet" } },
  chat: { recents: [] },
  tasks: { outstanding: [], verification: [], refused: [], rewarded: [], sync: { status: "ready" } },
  usage: { availableCreditUsd: 10 },
  context: {},
};
const runtimeConfig = { collaboration: { teamEnabled: true }, auth: { providers: [] } };
const teamContext = {
  ok: true,
  status: "current",
  includeInPersonalContext: false,
  overview: "The team has recently focused on making execution reviews more deterministic.",
  generatedAt: "2026-08-31T08:00:00.000Z",
  members: [{
    accountId: member.accountId,
    displayName: member.identity.displayName,
    hiveHandle: member.identity.hiveHandle,
    taskHistoryVisible: true,
    tasksPastDay: 1,
    tasksPastWeek: 4,
    recentWork: "Built and documented a deterministic trading review checklist.",
  }],
};
let teamContextPreferenceRequest = null;

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targets.find((entry) => entry.type === "page");
assert.ok(target?.webSocketDebuggerUrl, "No Chrome page target is available");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });

let nextId = 0;
const pending = new Map();
function command(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { reject, resolve }));
}
function responseBody(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
}
async function fulfill(requestId, body, contentType = "application/json") {
  await command("Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: "content-type", value: contentType }],
    body: responseBody(body),
  });
}

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (message.id && pending.has(message.id)) {
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message));
    else handlers.resolve(message.result);
    return;
  }
  if (message.method !== "Fetch.requestPaused") return;
  const { requestId, request } = message.params;
  const url = new URL(request.url);
  if (url.pathname === "/runtime-config.js") {
    fulfill(requestId, `window.__TASKNODE_CONFIG__ = ${JSON.stringify(runtimeConfig)};`, "application/javascript");
  } else if (url.pathname === "/runtime-config.json") {
    fulfill(requestId, runtimeConfig);
  } else if (url.pathname === "/api/app-state") {
    fulfill(requestId, appState);
  } else if (url.pathname === "/api/team") {
    fulfill(requestId, { ok: true, counts: { collaborators: 0, managers: 0, directReports: 1 }, invites: [], members: [member] });
  } else if (url.pathname === "/api/team/context" && request.method === "GET") {
    fulfill(requestId, teamContext);
  } else if (url.pathname === "/api/team/context/preference" && request.method === "PATCH") {
    teamContextPreferenceRequest = JSON.parse(request.postData || "{}");
    teamContext.includeInPersonalContext = teamContextPreferenceRequest.includeInPersonalContext === true;
    fulfill(requestId, { ok: true, includeInPersonalContext: teamContext.includeInPersonalContext });
  } else if (url.pathname === `/api/team/${member.accountId}/tasks`) {
    fulfill(requestId, { ok: true, tasks: { outstanding: [], verification: [task], refused: [], rewarded: [] } });
  } else if (url.pathname === `/api/team/${member.accountId}/tasks/${task.taskId}`) {
    fulfill(requestId, {
      ok: true,
      task,
      submission: { summaries: [{ label: "Evidence submitted", summary: "Draft checklist attached for review." }] },
      currentVerificationRequest: { body: "Clarify how the checklist changes position sizing after a loss." },
      rewardOutcome: null,
    });
  } else if (url.pathname.startsWith("/api/")) {
    fulfill(requestId, {});
  } else {
    command("Fetch.continueRequest", { requestId });
  }
});

await command("Page.enable");
await command("Runtime.enable");
await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
await command("Emulation.setDeviceMetricsOverride", {
  width: viewportWidth,
  height: viewportHeight,
  deviceScaleFactor: 1,
  mobile: viewportWidth <= 720,
});
await command("Page.navigate", { url: `${appOrigin}/?teamSmoke=${Date.now()}#team` });

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return result.result.value;
}
async function waitFor(expression, message, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(125);
  }
  throw new Error(message);
}

await waitFor(`document.querySelector('.team-card footer button')?.textContent.includes('View tasks')`, "Team member card did not render");
const contextRendered = await waitFor(`(() => {
  const report = document.querySelector('.team-context-report');
  if (!report || !report.textContent.includes('deterministic trading review checklist')) return null;
  return {
    pastDay: report.textContent.includes('24 hours') && report.textContent.includes('1'),
    pastWeek: report.textContent.includes('7 days') && report.textContent.includes('4'),
    toggleLabel: report.querySelector('.team-context-toggle')?.textContent,
    pressed: report.querySelector('.team-context-toggle')?.getAttribute('aria-pressed'),
  };
})()`, "Team Context report did not render");
assert.equal(contextRendered.pastDay, true);
assert.equal(contextRendered.pastWeek, true);
assert.match(contextRendered.toggleLabel, /Use in personal context/);
assert.equal(contextRendered.pressed, "false");
await evaluate(`document.querySelector('.team-context-toggle').click()`);
await waitFor(`document.querySelector('.team-context-toggle')?.getAttribute('aria-pressed') === 'true'`, "Team Context checkmark did not persist");
assert.deepEqual(teamContextPreferenceRequest, { includeInPersonalContext: true });
await evaluate(`document.querySelector('.team-card footer button').click()`);
await waitFor(`document.querySelector('.team-task-row')?.textContent.includes('trading review checklist')`, "Clickable task row did not render");
await evaluate(`(() => { const row = document.querySelector('.team-task-row'); row.focus(); row.click(); })()`);
const rendered = await waitFor(`(() => {
  const popout = document.querySelector('.team-task-popout');
  if (!popout || !popout.textContent.includes('Clarify how the checklist')) return null;
  return {
    title: popout.querySelector('h2')?.textContent,
    role: popout.getAttribute('role'),
    modal: popout.getAttribute('aria-modal'),
    brief: popout.textContent.includes('Document the review process'),
    evidence: popout.textContent.includes('Provide the final document'),
    taskId: popout.textContent.includes('task_demo_1_full'),
    rowIsButton: document.querySelector('.team-task-row')?.tagName,
  };
})()`, "Task detail popout did not load");
assert.equal(rendered.title, task.title);
assert.equal(rendered.role, "dialog");
assert.equal(rendered.modal, "true");
assert.equal(rendered.brief, true);
assert.equal(rendered.evidence, true);
assert.equal(rendered.taskId, true);
assert.equal(rendered.rowIsButton, "BUTTON");

if (screenshotPath) {
  await delay(300);
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
}

await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await waitFor(`!document.querySelector('.team-task-popout')`, "Escape did not close the task detail popout");
assert.equal(await evaluate(`document.activeElement?.classList.contains('team-task-row')`), true, "Task-row focus was not restored");

console.log(JSON.stringify({ ok: true, rendered }, null, 2));
socket.close();
