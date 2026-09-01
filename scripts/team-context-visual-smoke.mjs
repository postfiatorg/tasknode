import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const cdpPort = Number(process.env.CDP_PORT || 9342);
const appOrigin = process.env.TASKNODE_APP_ORIGIN || "http://localhost:5175";
const screenshotPath = process.env.SCREENSHOT_PATH || "";
const viewportWidth = Number(process.env.VIEWPORT_WIDTH || 1440);
const viewportHeight = Number(process.env.VIEWPORT_HEIGHT || 1100);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const summaries = [
  "NavStrategies quantitative strategy work and corbanu.com site upkeep. This spans migrating the fixed-clip equity strategy to z-score normalization, backtesting a universe expansion, building a read-only signal summary API, and documenting the Market Lens pipeline so new engineers can operate it without tribal knowledge. Migrated the strategy from percentile-rank transforms to population z-scores while preserving fixed hedges, position clips, one-session lag, and disabled order submission. Ran a controlled comparison between the original 19-name universe and an expanded 25-name universe using identical thresholds and execution timing. Built a protected API that reads stock, crypto relative-value, and macro signal files and reports healthy, stale, missing, partial, and error states without executing a strategy. Added asset categories to all 39 public instruments and replaced the flat instrument picker with a grouped accessible menu. The new runbook documents every script, service, environment variable, publish step, degradation policy, and sanitization rule needed to run a full refresh and diagnose stale output.",
  "No rewarded work is available yet for this member.",
  "PostFiat L1 Cobalt consensus verification, controlled-devnet storage deployment, and public-testnet planning. Fixed the non-uniform support boundary so authenticated messages from validators outside a peer's local view are ignored instead of poisoning local support, then reran the frozen 18-case oracle corpus to a full pass. Reproduced the original liveness failure on controlled infrastructure and proved the repaired implementation resolves it. Qualified the release candidate by replaying the exact 915-block devnet archive and rehearsing forward rollback before executing the controlled-testnet cutover. Built an independent second oracle and generated more than 10,000 deterministic trust graphs across 6–20 validators to compare production classification at adversarial boundaries. Completed the authorized six-validator storage rollout with fleet ground truth, rolling deployment, rollback binaries, storage health verification, and redaction-safe receipts. The resulting evidence makes the consensus boundary, activation state, storage rollout, and remaining operator decisions independently auditable.",
  "Restoring the NavStrategies signals surface after an accidental Flask cleanup and finalizing the plan for retiring the remaining production routes. Restored the GET /signals page and both signals API endpoints using the existing signal catalog, reinstating only the dedicated template, styles, and client behavior. Verified the route allowlist still contains exactly 53 rules, retired routes return 404, and the hotfix changed no trading methodology, timers, database state, positions, or order execution. Deployed the UI-only repair and verified the page and endpoints live. Finalized the production-surface deprecation plan with the retained-route manifest, scoped removal targets, archival inventory, regression design, and rollout and rollback steps. Operators now have the signals interface back and a precise plan for removing obsolete Flask surface area without guessing which routes production still depends on.",
  "Building the scoring-model governance round pipeline that freezes a round, draws judges, runs exams and grading, decides whether a challenger replaces the incumbent, and publishes verifiable records. Wired exam and grading into the orchestrator so triggered rounds now run end to end with identity-blinded grading and blocklisting for failed judges. Made judge selection reproducible from the on-chain announcement anchor and frozen package. Added deterministic decision rules for margin comparison, disqualification, no-survivor fallback, and ledger-randomness tie-breaking. Withheld results until the commit window closes, then pinned the full record to IPFS and emitted the round-close receipt on chain. Evaluated a new scoring model by replaying the ten latest completed testnet rounds and proving repeated inference was bit-identical. Added a three-branch operator playbook for distribution failures: wait, republish through the admin override, or trigger a fresh manual round.",
  "Repairing the daily 2,201-name Pre-Catalyst stock-scoring build, correcting overnight P&L reporting, and establishing a backward-compatible security policy domain. Added incremental coverage for 52 missing names and repaired 139 Bloomberg factor-data mapping gaps without changing factor or portfolio methodology. Fixed transcript error classification so temporary provider-capacity failures remain retryable, restoring 244 previously excluded names without deleting completed cells. Corrected overnight P&L reconciliation so corporate-action adjustments no longer appear as roughly $309.90 of adverse entry slippage when Friday closing-auction fills are compared with Monday ex-dividend prices. Added a stable security-level enum, deterministic authorization and revocation types, versioned persistence, and a tested Permissive compatibility baseline. The daily build now covers the intended universe, traders see a trustworthy execution-cost breakdown, and stricter permission levels can be added without breaking existing behavior.",
];

const identities = [
  ["@corbanuai", "corbanuai"],
  ["Task Node member", ""],
  ["@0xpostfiatchad", "0xpostfiatchad"],
  ["@secondfmaster", "secondfmaster"],
  ["@donravle", "donravle"],
  ["@jimricketts", "jimricketts"],
];
const members = identities.map(([displayName, hiveHandle], index) => ({
  accountId: `account_${index + 1}`,
  identity: { displayName, hiveHandle },
  relationship: "collaborator",
  seesTheirs: true,
  theySeeYours: true,
  summary: { taskCount: index === 1 ? 0 : index + 2, rewardPft: (index + 1) * 1200 },
}));
const contextMembers = identities.map(([displayName, hiveHandle], index) => ({
  accountId: `account_${index + 1}`,
  displayName,
  hiveHandle,
  taskHistoryVisible: true,
  tasksPastDay: [2, 0, 1, 2, 0, 0][index],
  tasksPastWeek: [3, 0, 9, 2, 0, 2][index],
  recentWork: summaries[index],
}));

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
  includeInPersonalContext: true,
  overview: "Recent rewarded work spans quantitative strategy research, blockchain consensus verification, production-surface repairs, model-governance operations, and market-data recovery.",
  generatedAt: "2026-09-01T01:19:25.925Z",
  members: contextMembers,
};

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targets.find((entry) => entry.type === "page");
assert.ok(target?.webSocketDebuggerUrl, "No Chrome page target is available");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

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
    fulfill(requestId, {
      ok: true,
      counts: { collaborators: members.length, managers: 0, directReports: 0 },
      invites: [],
      members,
    });
  } else if (url.pathname === "/api/team/context") {
    fulfill(requestId, teamContext);
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
await command("Page.navigate", { url: `${appOrigin}/?teamContextVisual=${Date.now()}#team` });

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return result.result.value;
}
async function waitFor(expression, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(125);
  }
  throw new Error(message);
}

await waitFor(
  `document.querySelectorAll('.team-context-members article').length === 6`,
  "Six Team Context members did not render",
);
await delay(300);
await evaluate("window.scrollTo(0, 0)");
const result = await evaluate(`(() => {
  const report = document.querySelector('.team-context-report');
  const firstUpdate = report?.querySelector('.team-context-member-update p');
  return {
    articles: report?.querySelectorAll('.team-context-members article').length || 0,
    width: Math.round(report?.getBoundingClientRect().width || 0),
    height: Math.round(report?.getBoundingClientRect().height || 0),
    bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    expandButtons: report?.querySelectorAll('[data-team-context-expand]').length || 0,
    firstUpdateLength: firstUpdate?.textContent.length || 0,
  };
})()`);
assert.equal(result.articles, 6);
assert.equal(result.expandButtons, 5);
assert.equal(result.bodyOverflow, false);
assert.ok(result.firstUpdateLength < summaries[0].length, "Long summaries must render as concise previews by default");

if (screenshotPath) {
  const screenshot = await command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
}

await evaluate("document.querySelector('[data-team-context-expand]').click()");
const expanded = await waitFor(`(() => {
  const button = document.querySelector('[data-team-context-expand]');
  const update = document.querySelector('.team-context-member-update p');
  if (button?.getAttribute('aria-expanded') !== 'true') return null;
  return { buttonLabel: button.textContent, updateLength: update?.textContent.length || 0 };
})()`, "The first contributor update did not expand");
assert.match(expanded.buttonLabel, /Show less/);
assert.equal(expanded.updateLength, summaries[0].length);

console.log(JSON.stringify({ ok: true, result, expanded, screenshotPath }, null, 2));
socket.close();
