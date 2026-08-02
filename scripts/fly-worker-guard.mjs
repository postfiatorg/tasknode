#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_APP = "tasknodeofficial-dev";
const DEFAULT_COUNT = 1;
const PROCESS_GROUPS = [
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

function usage() {
  return [
    "Usage: npm run fly:worker-guard -- [--app tasknodeofficial-dev] [--process GROUP] [--count 1] [--require-env NAME=value] [--dry-run|--fix]",
    "",
    "Reads live Fly Machine JSON and verifies every required process group has at least one",
    "started Machine with restart=always. Verification is read-only by default.",
    "--dry-run is strictly read-only reporting: it prints no mutation commands and plans none.",
    "--fix is the only mutating mode; it is required before scale, start, or restart-policy mutations.",
  ].join("\n");
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function argValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function accessToken() {
  if (process.env.FLY_API_TOKEN) return process.env.FLY_API_TOKEN;
  if (process.env.FLY_ACCESS_TOKEN) return process.env.FLY_ACCESS_TOKEN;
  const configPath = path.join(os.homedir(), ".fly", "config.yml");
  if (!existsSync(configPath)) {
    throw new Error("FLY_API_TOKEN is missing and ~/.fly/config.yml was not found.");
  }
  const match = readFileSync(configPath, "utf8").match(/^access_token:\s*(.+)$/m);
  if (!match) throw new Error("Could not read Fly access token from ~/.fly/config.yml.");
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function fly(args, { dryRun = false } = {}) {
  const printable = `fly ${args.join(" ")}`;
  if (dryRun) {
    console.log(`[dry-run] ${printable}`);
    return "";
  }
  const token = accessToken();
  return execFileSync("fly", args, {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      FLY_API_TOKEN: token,
      FLY_ACCESS_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listMachines(app) {
  // Machine inventory is always a live query, including --dry-run.
  const result = JSON.parse(fly(["machines", "list", "-a", app, "--json"]));
  if (!Array.isArray(result)) throw new Error("Fly machines list returned an unexpected JSON shape.");
  return result;
}

function processGroupOf(machine) {
  return machine?.config?.metadata?.fly_process_group || machine?.config?.env?.FLY_PROCESS_GROUP || "";
}

function restartPolicyOf(machine) {
  return machine?.config?.restart?.policy || "";
}

function isStandby(machine) {
  const standbys = machine?.config?.standbys;
  return Array.isArray(standbys) ? standbys.length > 0 : Boolean(standbys);
}

function shellQuote(value = "") {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseRequiredEnvSpec(spec = "") {
  const [name, ...valueParts] = String(spec || "").split("=");
  const expected = valueParts.length ? valueParts.join("=") : "true";
  const normalizedName = String(name || "").trim();
  if (!/^[A-Z0-9_]+$/.test(normalizedName)) throw new Error(`Invalid --require-env name: ${name}`);
  return { name: normalizedName, expected };
}

function defaultRequiredEnv(processGroup = "") {
  return {
    "worker-taskgen": [
      { name: "TASKNODE_TASK_GENERATION_WORKER_ENABLED", expected: "true" },
      { name: "TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED", expected: "true" },
    ],
    "worker-task-review": [
      { name: "TASKNODE_TASK_REVIEW_WORKER_ENABLED", expected: "true" },
    ],
    "worker-pftl": [
      { name: "PFTL_CACHE_WORKER_ENABLED", expected: "true" },
      { name: "PFTL_CACHE_WSS_WATCHER_ENABLED", expected: "true" },
    ],
    "worker-airdrop": [
      { name: "TASKNODE_DAILY_AIRDROP_WORKER_ENABLED", expected: "true" },
    ],
  }[processGroup] || [];
}

function verifyMachineEnv({ app, machineId, requiredEnv } = {}) {
  if (!requiredEnv.length) return;
  const checks = requiredEnv.map(({ name, expected }) => (
    `value=$(printenv ${shellQuote(name)} || true); ` +
    `if [ "$value" != ${shellQuote(expected)} ]; then ` +
    `echo "${name}=<mismatch>" >&2; missing=1; fi`
  ));
  const script = ["missing=0", ...checks, "exit $missing"].join("; ");
  fly(["ssh", "console", "-a", app, "--machine", machineId, "-C", `sh -lc ${shellQuote(script)}`]);
}

function machineSummary(machine) {
  return `${machine.id} state=${machine.state || "unknown"} restart=${restartPolicyOf(machine) || "unset"}`;
}

function sortCandidates(a, b) {
  const aStarted = a.state === "started" ? 0 : 1;
  const bStarted = b.state === "started" ? 0 : 1;
  if (aStarted !== bStarted) return aStarted - bStarted;
  const aAlways = restartPolicyOf(a) === "always" ? 0 : 1;
  const bAlways = restartPolicyOf(b) === "always" ? 0 : 1;
  if (aAlways !== bAlways) return aAlways - bAlways;
  return String(a.created_at || a.id).localeCompare(String(b.created_at || b.id));
}

function selectedGroups() {
  const requested = argValue("--process");
  if (!requested) return PROCESS_GROUPS;
  if (!PROCESS_GROUPS.includes(requested)) {
    throw new Error(`Unknown --process ${requested}; expected one of: ${PROCESS_GROUPS.join(", ")}`);
  }
  return [requested];
}

function requiredEnvFor(processGroup) {
  return [
    ...defaultRequiredEnv(processGroup),
    ...argValues("--require-env").map(parseRequiredEnvSpec),
  ];
}

function candidateMachines(groupMachines, count) {
  return groupMachines.filter((machine) => !isStandby(machine)).sort(sortCandidates).slice(0, count);
}

function groupReport({ processGroup, groupMachines, count }) {
  const candidates = candidateMachines(groupMachines, count);
  const started = candidates.filter((machine) => machine.state === "started");
  const badRestart = candidates.filter((machine) => restartPolicyOf(machine) !== "always");
  const violations = [];
  if (candidates.length < count || started.length < count) {
    violations.push(`started=${started.length} (minimum ${count})`);
  }
  if (badRestart.length) {
    violations.push(`restart!=always on ${badRestart.map(machineSummary).join(", ")}`);
  }

  console.log(
    `[${processGroup}] machines=${groupMachines.length} started=${started.length} minimum=${count}`
  );
  if (groupMachines.length) {
    const candidateIds = new Set(candidates.map((machine) => machine.id));
    for (const machine of groupMachines) {
      const role = isStandby(machine) ? "standby" : "active";
      const selection = candidateIds.has(machine.id) ? "selected" : "informational";
      console.log(`[${processGroup}] ${role} ${selection} ${machineSummary(machine)}`);
    }
  } else {
    console.log(`[${processGroup}] no machines found`);
  }

  if (violations.length) {
    console.log(`[${processGroup}] repair required (read-only verification)`);
  }

  return { candidates, started, badRestart, violations };
}

function applyFixes({ app, processGroup, groupMachines, count }) {
  const candidates = candidateMachines(groupMachines, count);
  const badRestart = candidates.filter((machine) => restartPolicyOf(machine) !== "always");
  for (const machine of badRestart) {
    fly(["machine", "update", machine.id, "-a", app, "--restart", "always", "--yes"]);
  }

  for (const machine of candidates.filter((candidate) => candidate.state !== "started")) {
    fly(["machine", "start", machine.id, "-a", app]);
  }

  if (candidates.length < count) {
    fly([
      "scale",
      "count",
      String(count),
      "--process-group",
      processGroup,
      "-a",
      app,
      "--yes",
    ]);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }

  const app = argValue("--app") || process.env.TASKNODE_FLY_APP || DEFAULT_APP;
  const count = Number(argValue("--count") || process.env.TASKNODE_FLY_WORKER_COUNT || DEFAULT_COUNT);
  const dryRun = hasArg("--dry-run");
  const fixRequested = hasArg("--fix");
  if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer.");
  if (fixRequested && dryRun) {
    console.warn("--dry-run takes precedence over --fix; no mutation will run.");
  }
  const fix = fixRequested && !dryRun;
  const groups = selectedGroups();
  const machines = listMachines(app);
  const reports = [];

  for (const processGroup of groups) {
    const groupMachines = machines.filter((machine) => processGroupOf(machine) === processGroup);
    const report = groupReport({ processGroup, groupMachines, count });
    reports.push({ processGroup, groupMachines, ...report });
  }

  if (fix) {
    const needsFix = reports.filter((report) => report.violations.length);
    for (const report of needsFix) {
      applyFixes({
        app,
        processGroup: report.processGroup,
        groupMachines: report.groupMachines,
        count,
      });
    }
    if (needsFix.length) await sleep(3000);
    const afterMachines = listMachines(app);
    reports.length = 0;
    for (const processGroup of groups) {
      const groupMachines = afterMachines.filter((machine) => processGroupOf(machine) === processGroup);
      const report = groupReport({ processGroup, groupMachines, count });
      reports.push({ processGroup, groupMachines, ...report });
    }
  }

  const requiredEnvChecks = [];
  if (fix) {
    for (const report of reports) {
      const requiredEnv = requiredEnvFor(report.processGroup);
      const started = report.candidates.filter((machine) => machine.state === "started");
      for (const machine of started) {
        if (requiredEnv.length) requiredEnvChecks.push({ app, machine, requiredEnv });
      }
    }
    for (const check of requiredEnvChecks) {
      verifyMachineEnv({
        app: check.app,
        machineId: check.machine.id,
        requiredEnv: check.requiredEnv,
      });
    }
  }

  const violations = reports.filter((report) => report.violations.length);
  if (violations.length) {
    for (const report of violations) {
      console.error(`[${report.processGroup}] VIOLATION: ${report.violations.join("; ")}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `fly-worker-guard ok for ${app}: ${groups.length} process groups verified` +
      (fix ? " (fix applied)" : " (read-only)")
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
