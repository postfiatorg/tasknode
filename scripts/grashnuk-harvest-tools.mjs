#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const pythonRoot = path.join(repoRoot, "reference_clients", "python");
const defaultBaseUrl = process.env.TASKNODE_BASE_URL || "https://tasknode.postfiat.org";
const defaultWalletAddress = process.env.TASKNODE_GRASHNUK_WALLET || "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW";
const defaultWalletFile = process.env.TASKNODE_AGENT_WALLET_FILE || "/home/pfrpc/repos/tasknode_agent_wallets.json";
const defaultSessionStore = process.env.TASKNODE_AGENT_SESSION_STORE || "/home/pfrpc/repos/tasknode_agent_sessions.json";
const defaultAgentHandle = process.env.TASKNODE_ORC_AGENT || "grashnuk";

function usage() {
  return [
    "Usage: node scripts/grashnuk-harvest-tools.mjs <command> [options]",
    "",
    "Commands:",
    "  active-checkouts",
    "  inspect --task-id <harvest_task_id>",
    "  checkout --task-id <harvest_task_id>",
    "  request-task --task-id <harvest_task_id> --detail-file <path>",
    "  wait-generated --request-id <request_id> [--timeout-ms 180000]",
    "  task-detail --task-id <personal_task_id>",
    "  run-personal-task --task-id <personal_task_id> --evidence-file <path> [--notes <text>]",
    "  wait-reward --task-id <personal_task_id> [--verification-response-file <path>] [--timeout-ms 900000]",
    "  resolve --task-id <harvest_task_id> --outcome <fixed|already_fixed|not_a_bug|duplicate> --note-file <path>",
    "",
    "The tool reads Grashnuk's local wallet/session files but redacts secrets from output.",
  ].join("\n");
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function loadWalletRecord(walletAddress = defaultWalletAddress) {
  const parsed = readJson(defaultWalletFile);
  const record = (parsed.wallets || []).find((wallet) =>
    safeText(wallet?.address, 120).toLowerCase() === safeText(walletAddress, 120).toLowerCase()
  );
  if (!record?.mnemonic) throw new Error(`grashnuk_wallet_not_found:${walletAddress}`);
  return record;
}

function secretValues() {
  const values = [];
  try {
    values.push(loadWalletRecord().mnemonic);
  } catch {
    // Keep redaction best-effort; command failures should surface normally.
  }
  try {
    const sessions = readJson(defaultSessionStore);
    for (const entry of Object.values(sessions || {})) {
      if (entry?.session_token) values.push(entry.session_token);
    }
  } catch {
    // Missing sessions are handled by login.
  }
  return values.filter((value) => typeof value === "string" && value.length > 8);
}

function redactString(value = "") {
  let output = String(value || "");
  for (const secret of secretValues()) output = output.split(secret).join("[REDACTED]");
  output = output.replace(/tasknode_session=([^;\s]+)/g, "tasknode_session=[REDACTED]");
  output = output.replace(/"session_token"\s*:\s*"[^"]+"/g, '"session_token":"[REDACTED]"');
  output = output.replace(/"mnemonic"\s*:\s*"[^"]+"/g, '"mnemonic":"[REDACTED]"');
  output = output.replace(/TASKNODE_AGENT_WALLET_SEED=([^\s]+)/g, "TASKNODE_AGENT_WALLET_SEED=[REDACTED]");
  return output;
}

function redact(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /seed|mnemonic|session_token|token/i.test(key) ? "[REDACTED]" : redact(item),
      ])
    );
  }
  return value;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(redact(value), null, 2)}\n`);
}

function agentEnv() {
  const wallet = loadWalletRecord();
  return {
    ...process.env,
    TASKNODE_AGENT_WALLET_SEED: wallet.mnemonic,
    TASKNODE_AGENT_WALLET_ADDRESS: defaultWalletAddress,
    TASKNODE_AGENT_SESSION_STORE: defaultSessionStore,
    TASKNODE_BASE_URL: defaultBaseUrl,
    TASKNODE_ORC_AGENT: defaultAgentHandle,
  };
}

function runCommand(command, args, { cwd = repoRoot, env = process.env, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout: redactString(stdout), stderr: redactString(stderr) };
      if (code !== 0) {
        const error = new Error(`${command}_failed:${code}`);
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function sessionExpiresSoon(expiresAt = "") {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return true;
  return parsed - Date.now() < 5 * 60 * 1000;
}

function readSessionEntry() {
  if (!existsSync(defaultSessionStore)) return null;
  const parsed = readJson(defaultSessionStore);
  const entry = parsed?.[defaultWalletAddress];
  if (!entry?.session_token || sessionExpiresSoon(entry.expires_at)) return null;
  return entry;
}

async function ensureSession() {
  const current = readSessionEntry();
  if (current) return current;
  const script = `
import json
import os
from orc_tooling.client import build_client

client = build_client(
    agent=os.environ.get("TASKNODE_ORC_AGENT", "grashnuk"),
    expected_wallet_address=os.environ.get("TASKNODE_AGENT_WALLET_ADDRESS", ""),
    base_url=os.environ.get("TASKNODE_BASE_URL", "https://tasknode.postfiat.org"),
    session_store_path=os.environ.get("TASKNODE_AGENT_SESSION_STORE", ""),
)
login = client.login(force=True)
print(json.dumps({
    "ok": True,
    "address": client.address,
    "accountId": login.get("accountId") or client.account_id,
    "cached": bool(login.get("cached")),
    "secretPrinted": False,
}, sort_keys=True))
`;
  await runCommand("uv", ["run", "python", "-c", script], { cwd: pythonRoot, env: agentEnv() });
  const refreshed = readSessionEntry();
  if (!refreshed) throw new Error("grashnuk_session_login_failed");
  return refreshed;
}

async function apiRequest(pathname, { method = "GET", body } = {}) {
  const session = await ensureSession();
  const response = await fetch(`${defaultBaseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `tasknode_session=${session.session_token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok || responseBody?.ok === false) {
    const error = new Error(responseBody?.message || responseBody?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = responseBody;
    throw error;
  }
  return responseBody;
}

function summarizeHarvest(row = {}) {
  return {
    taskId: row.taskId,
    title: row.title,
    contributor: row.contributor,
    walletAddress: row.walletAddress,
    requiresAction: row.requiresAction,
    actionCategory: row.actionCategory,
    taskProposal: row.taskProposal,
    submissionRequirement: row.submissionRequirement,
    assessmentSummary: row.assessmentSummary,
    suggestedAction: row.suggestedAction,
    rewardActualPft: row.rewardActualPft,
    rewardEventTxHash: row.rewardEventTxHash,
    rewardEventCid: row.rewardEventCid,
    checkedOut: row.checkedOut,
    checkout: row.checkout,
    resolved: row.resolved,
    resolvedAt: row.resolvedAt,
    resolutionOutcome: row.resolutionOutcome,
    resolutionNote: row.resolutionNote,
  };
}

async function findHarvest(taskId) {
  const pages = [
    "/api/hive/brain/harvests?includeResolved=true&limit=200",
    "/api/hive/brain/harvests?resolved=true&limit=200",
  ];
  for (const page of pages) {
    const body = await apiRequest(page);
    const row = (body.harvests || []).find((harvest) => harvest.taskId === taskId);
    if (row) return row;
  }
  throw new Error(`harvest_not_found:${taskId}`);
}

async function requestPersonalTask({ detailFile = "", harvestTaskId = "" } = {}) {
  if (!detailFile) throw new Error("detail_file_required");
  const script = `
import json
import os
import sys
from orc_tooling.client import request_personal_task

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    detail = handle.read()
payload = request_personal_task(
    detail,
    submit=True,
    agent=os.environ.get("TASKNODE_ORC_AGENT", "grashnuk"),
    expected_wallet_address=os.environ.get("TASKNODE_AGENT_WALLET_ADDRESS", ""),
    base_url=os.environ.get("TASKNODE_BASE_URL", "https://tasknode.postfiat.org"),
    session_store_path=os.environ.get("TASKNODE_AGENT_SESSION_STORE", ""),
    conversation_id=f"grashnuk-harvest-{sys.argv[2]}",
    requested_task_kind="personal",
)
print(json.dumps(payload, sort_keys=True))
`;
  const result = await runCommand("uv", ["run", "python", "-c", script, path.resolve(detailFile), harvestTaskId], {
    cwd: pythonRoot,
    env: agentEnv(),
  });
  return JSON.parse(result.stdout);
}

async function waitGenerated(requestId, timeoutMs = 180000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 180000));
  let last = null;
  while (Date.now() < deadline) {
    const body = await apiRequest("/api/tasks/requests");
    const row = (body.items || body.requests || []).find((item) => item.requestId === requestId);
    if (row) {
      last = row;
      const taskId = row.generatedTaskId || row.taskId || "";
      if (taskId) return { ok: true, request: row, generatedTaskId: taskId, secretPrinted: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { ok: false, error: "generated_task_timeout", requestId, last, secretPrinted: false };
}

function rewardFromTaskDetail(detail = {}) {
  const task = detail.task || {};
  const outcome = detail.rewardOutcome || {};
  const timeline = detail.forensics?.timeline || [];
  const rewardEvent = timeline.find((event) =>
    String(event.schema || "").includes("reward") || String(event.label || "").toLowerCase().includes("reward")
  ) || {};
  const raw = rewardEvent.rawPayload || {};
  return {
    status: task.status || "",
    statusKey: task.statusKey || "",
    pft: outcome.rewardPft || outcome.amountPft || raw.reward_pft || raw.amount_pft || raw.amount || task.rewardPft || task.reward || "",
    txHash: outcome.txHash || outcome.rewardTxHash || raw.tx_hash || raw.txHash || rewardEvent.txHash || "",
    cid: outcome.cid || outcome.rewardCid || raw.cid || rewardEvent.cid || "",
    comment: outcome.commentary || outcome.rewardDescription || raw.description || raw.reward_description || "",
  };
}

async function runOrcctl(args) {
  const result = await runCommand("uv", [
    "run",
    "orcctl",
    "--agent",
    defaultAgentHandle,
    "--wallet-address",
    defaultWalletAddress,
    "--base-url",
    defaultBaseUrl,
    "--session-store",
    defaultSessionStore,
    ...args,
  ], {
    cwd: pythonRoot,
    env: agentEnv(),
  });
  return JSON.parse(result.stdout);
}

async function waitReward({ taskId = "", timeoutMs = 900000, verificationResponseFile = "" } = {}) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 900000));
  let responded = false;
  let lastDetail = null;
  while (Date.now() < deadline) {
    const detail = await apiRequest(`/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`);
    lastDetail = detail;
    const status = safeText(detail?.task?.statusKey || detail?.task?.status, 80).toLowerCase().replace(/\s+/g, "_");
    if (status === "verification_requested") {
      if (!verificationResponseFile) {
        return { ok: false, error: "verification_requested", taskId, detail: { task: detail.task }, secretPrinted: false };
      }
      if (!responded) {
        await runOrcctl(["task", "respond", taskId, "--response-file", path.resolve(verificationResponseFile)]);
        responded = true;
      }
    }
    if (["rewarded", "paid", "reward_decided"].includes(status)) {
      return {
        ok: true,
        taskId,
        task: detail.task,
        reward: rewardFromTaskDetail(detail),
        secretPrinted: false,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  return {
    ok: false,
    error: "reward_timeout",
    taskId,
    lastStatus: lastDetail?.task?.status || "",
    secretPrinted: false,
  };
}

async function main() {
  const command = process.argv[2] || "";
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  const taskId = argValue("--task-id", "");
  if (command === "active-checkouts") {
    printJson(await apiRequest("/api/hive/brain/harvest-checkouts?limit=80"));
    return;
  }
  if (command === "inspect") {
    if (!taskId) throw new Error("task_id_required");
    printJson({ ok: true, harvest: summarizeHarvest(await findHarvest(taskId)), secretPrinted: false });
    return;
  }
  if (command === "checkout") {
    if (!taskId) throw new Error("task_id_required");
    printJson(await apiRequest(`/api/hive/brain/harvests/${encodeURIComponent(taskId)}/checkout`, { method: "POST" }));
    return;
  }
  if (command === "request-task") {
    if (!taskId) throw new Error("task_id_required");
    printJson(await requestPersonalTask({ detailFile: argValue("--detail-file", ""), harvestTaskId: taskId }));
    return;
  }
  if (command === "wait-generated") {
    printJson(await waitGenerated(argValue("--request-id", ""), Number(argValue("--timeout-ms", "180000"))));
    return;
  }
  if (command === "task-detail") {
    if (!taskId) throw new Error("task_id_required");
    const detail = await apiRequest(`/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`);
    printJson({ ok: true, task: detail.task, reward: rewardFromTaskDetail(detail), secretPrinted: false });
    return;
  }
  if (command === "run-personal-task") {
    if (!taskId) throw new Error("task_id_required");
    const evidenceFile = argValue("--evidence-file", "");
    if (!evidenceFile) throw new Error("evidence_file_required");
    const notes = argValue("--notes", "");
    const args = ["run-personal-task", taskId, "--evidence-file", path.resolve(evidenceFile)];
    if (notes) args.push("--notes", notes);
    printJson(await runOrcctl(args));
    return;
  }
  if (command === "wait-reward") {
    if (!taskId) throw new Error("task_id_required");
    printJson(await waitReward({
      taskId,
      verificationResponseFile: argValue("--verification-response-file", ""),
      timeoutMs: Number(argValue("--timeout-ms", "900000")),
    }));
    return;
  }
  if (command === "resolve") {
    if (!taskId) throw new Error("task_id_required");
    const noteFile = argValue("--note-file", "");
    if (!noteFile) throw new Error("note_file_required");
    printJson(await apiRequest(`/api/hive/brain/harvests/${encodeURIComponent(taskId)}/resolve`, {
      method: "POST",
      body: {
        outcome: argValue("--outcome", "fixed"),
        note: readFileSync(path.resolve(noteFile), "utf8"),
      },
    }));
    return;
  }
  throw new Error(`unknown_command:${command}`);
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: error.message || String(error),
    status: error.status || error.result?.code || 1,
    body: error.body,
    stderr: error.result?.stderr,
    stdout: error.result?.stdout,
    secretPrinted: false,
  };
  printJson(payload);
  process.exitCode = 1;
});
