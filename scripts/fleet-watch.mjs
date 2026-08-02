#!/usr/bin/env node
// Fleet watch: reads live Fly machine inventory and the system-status endpoint.
// It never mutates Fly. Dry-run suppresses webhook delivery.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FLEET_GROUPS = [
  "app",
  "board-secretary",
  "worker-pftl",
  "worker-taskgen",
  "worker-task-review",
  "worker-context-rewrite",
  "worker-hive",
  "worker-memory-profile",
  "worker-airdrop",
];

const DEFAULT_APP = "tasknodeofficial-dev";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_WEBHOOK_ENV = "TASKNODE_DISCORD_WEBHOOK_URL";
const STATUS_PATH = "/api/system/status";
const CROSS_PROCESS_HEARTBEATS = "unavailable_round1";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function hasArg(name) {
  return process.argv.includes(name);
}

function fly(args, { env } = {}) {
  return execFileSync("fly", args, {
    cwd: path.resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env,
  });
}

export function listMachines(app) {
  const raw = fly(["machines", "list", "-a", app, "--json"]);
  const result = JSON.parse(raw);
  if (!Array.isArray(result)) throw new Error("fly machines list returned an unexpected JSON shape");
  return result;
}

function processGroupOf(machine) {
  const metadata = machine?.config?.metadata?.fly_process_group;
  const envGroup = machine?.config?.env?.FLY_PROCESS_GROUP;
  return metadata || envGroup || "";
}

function restartPolicyOf(machine) {
  return machine?.config?.restart?.policy || "";
}

function isStandby(machine) {
  const standbys = machine?.config?.standbys;
  return Array.isArray(standbys) && standbys.length > 0;
}

function groupMachines(machines, group) {
  return machines.filter((machine) => processGroupOf(machine) === group);
}

export async function fetchStatus(app, statusBaseUrl, timeoutMs) {
  const base = statusBaseUrl || `https://${app}.fly.dev`;
  const url = `${base}${STATUS_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        workerHeartbeats: null,
        heartbeatSurfacePresent: false,
        workerHeartbeatScope: null,
        error: `http_${response.status}`,
      };
    }
    const body = await response.json();
    return {
      ok: true,
      httpStatus: response.status,
      workerHeartbeats: Array.isArray(body?.workerHeartbeats) ? body.workerHeartbeats : null,
      heartbeatSurfacePresent: Array.isArray(body?.workerHeartbeats),
      workerHeartbeatScope: body?.workerHeartbeatScope || null,
      error: null,
    };
  } catch {
    return {
      ok: false,
      httpStatus: null,
      workerHeartbeats: null,
      heartbeatSurfacePresent: false,
      workerHeartbeatScope: null,
      error: "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeHeartbeatMap(heartbeats) {
  const byGroup = new Map();
  if (!Array.isArray(heartbeats)) return byGroup;
  for (const entry of heartbeats) {
    if (!entry || typeof entry !== "object") continue;
    const group = String(entry.group || "").trim();
    if (!group) continue;
    byGroup.set(group, {
      availability: entry.availability === "available" ? "available" : "missing",
      coverage: entry.coverage === "self" ? "self" : "unobserved",
      stale: entry.stale === true,
      lastTickAt: entry.lastTickAt || null,
      storageSource: entry.storage?.source || "unknown",
    });
  }
  return byGroup;
}

function unknownHeartbeat() {
  return {
    availability: "unknown",
    coverage: "unknown",
    stale: null,
    lastTickAt: null,
    storageSource: "n/a",
  };
}

export function reportViolations({
  machines = [],
  heartbeatMap = new Map(),
  heartbeatSurfacePresent = false,
} = {}) {
  const violations = [];
  const inventory = [];

  for (const group of FLEET_GROUPS) {
    const groupList = groupMachines(machines, group);
    const primaries = groupList.filter((machine) => !isStandby(machine));
    const standbys = groupList.filter((machine) => isStandby(machine));
    const started = primaries.filter((machine) => machine.state === "started");
    const badRestart = primaries.filter((machine) => restartPolicyOf(machine) !== "always");
    const groupViolations = [];

    if (started.length === 0) groupViolations.push("missing_started_machine");
    if (badRestart.length) {
      groupViolations.push(`bad_restart_policy:${badRestart.map((machine) => machine.id).join(",")}`);
    }

    const entryPresent = heartbeatMap.has(group);
    const heartbeat = entryPresent ? heartbeatMap.get(group) : unknownHeartbeat();
    if (heartbeatSurfacePresent && !entryPresent) {
      groupViolations.push("heartbeat_entry_missing");
    } else if (heartbeat.coverage === "self") {
      if (heartbeat.availability !== "available") groupViolations.push("missing_heartbeat");
      else if (heartbeat.stale) groupViolations.push("stale_heartbeat");
    }

    inventory.push({
      group,
      machineCount: groupList.length,
      primaryCount: primaries.length,
      standbyCount: standbys.length,
      startedCount: started.length,
      badRestartCount: badRestart.length,
      badRestartMachines: badRestart.map((machine) => machine.id),
      standbyMachines: standbys.map((machine) => machine.id),
      standbyEnumerated: true,
      heartbeat,
      violations: groupViolations,
    });
    if (groupViolations.length) {
      violations.push({
        group,
        violations: groupViolations,
        machineCount: groupList.length,
        startedCount: started.length,
        machineIds: primaries.map((machine) => machine.id),
        heartbeat,
      });
    }
  }

  return {
    violations,
    inventory,
    crossProcessHeartbeats: CROSS_PROCESS_HEARTBEATS,
  };
}

function buildAlertMessage(violations) {
  const lines = [`[tasknode fleet watch] ${violations.length} group(s) with violations`, ""];
  for (const violation of violations) {
    lines.push(`- ${violation.group}: ${violation.violations.join(", ")}`);
  }
  return lines.join("\n");
}

async function sendDiscordAlert(webhookUrl, message, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: message }),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: null, error: String(error?.name || "network_error") };
  } finally {
    clearTimeout(timer);
  }
}

function usage() {
  return [
    "Usage: node scripts/fleet-watch.mjs [--app tasknodeofficial-dev] [--dry-run] [--status-url URL] [--webhook-url-env NAME] [--timeout-ms MS]",
    "",
    "Reads Fly machine inventory and this-process-only system-status heartbeats.",
    "Dry-run is read-only and never sends a webhook.",
  ].join("\n");
}

export async function main({
  app = argValue("--app") || process.env.TASKNODE_FLY_APP || DEFAULT_APP,
  dryRun = hasArg("--dry-run"),
  statusBaseUrl = argValue("--status-url") || process.env.TASKNODE_PUBLIC_URL || "",
  webhookEnvVar = argValue("--webhook-url-env") || DEFAULT_WEBHOOK_ENV,
  timeoutMs = Number(argValue("--timeout-ms") || DEFAULT_TIMEOUT_MS),
  listMachinesImpl = listMachines,
  fetchStatusImpl = fetchStatus,
  logger = console,
} = {}) {
  if (hasArg("--help") || hasArg("-h")) {
    logger.log(usage());
    return { violations: [], inventory: [], exitCode: 0 };
  }

  const machines = listMachinesImpl(app);
  const status = await fetchStatusImpl(app, statusBaseUrl, timeoutMs);
  const heartbeatMap = normalizeHeartbeatMap(status.workerHeartbeats);
  const heartbeatSurfacePresent = status.ok === true && status.heartbeatSurfacePresent === true;
  const report = reportViolations({ machines, heartbeatMap, heartbeatSurfacePresent });

  logger.log(`fleet watch app=${app} dryRun=${dryRun}`);
  logger.log(
    `system-status ok=${status.ok} heartbeatSurface=${heartbeatSurfacePresent ? "present" : "absent"} ` +
      `crossProcessHeartbeats="${report.crossProcessHeartbeats}"`
  );
  logger.log("");
  logger.log("GROUP REPORT");
  for (const row of report.inventory) {
    logger.log(
      `  [${row.group}] machines=${row.machineCount} primary=${row.primaryCount} standby=${row.standbyCount} ` +
        `started=${row.startedCount} badRestart=${row.badRestartCount}`
    );
    if (row.standbyMachines.length) logger.log(`    standbys=${row.standbyMachines.join(",")}`);
    logger.log(
      `    heartbeat coverage=${row.heartbeat.coverage} availability=${row.heartbeat.availability} ` +
        `stale=${row.heartbeat.stale} lastTickAt=${row.heartbeat.lastTickAt || "null"}`
    );
    if (row.violations.length) logger.log(`    VIOLATION: ${row.violations.join("; ")}`);
  }

  logger.log("");
  logger.log(`VIOLATIONS=${report.violations.length}`);
  for (const violation of report.violations) {
    logger.log(`  - ${violation.group}: ${violation.violations.join(", ")}`);
  }

  let alertDisposition = "none";
  let webhookSendCount = 0;
  if (dryRun) {
    alertDisposition = "suppressed_dry_run";
    logger.log("");
    logger.log("ALERT");
    logger.log(`  alertDisposition="${alertDisposition}" webhookSendCount=${webhookSendCount}`);
    if (report.violations.length) {
      logger.log(`  would-alert message:\n${buildAlertMessage(report.violations).split("\n").map((line) => `    ${line}`).join("\n")}`);
    }
  } else if (report.violations.length) {
    const webhookUrl = process.env[webhookEnvVar];
    if (!webhookUrl) {
      alertDisposition = "no_webhook_configured";
    } else {
      webhookSendCount = 1;
      const result = await sendDiscordAlert(webhookUrl, buildAlertMessage(report.violations), timeoutMs);
      alertDisposition = result.ok ? "posted" : `delivery_failed:${result.error || `http_${result.status}`}`;
    }
    logger.log("");
    logger.log("ALERT");
    logger.log(`  alertDisposition="${alertDisposition}" webhookSendCount=${webhookSendCount}`);
  }

  return {
    ...report,
    status,
    alertDisposition,
    webhookSendCount,
    exitCode: report.violations.length ? 1 : 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await main();
  process.exitCode = result.exitCode;
}
