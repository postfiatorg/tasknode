#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_APP = "tasknodeofficial-dev";
const DEFAULT_PROCESS_GROUP = "worker";
const DEFAULT_COUNT = 1;

function usage() {
  return [
    "Usage: npm run fly:worker-guard -- [--app tasknodeofficial-dev] [--process worker] [--count 1] [--require-env NAME=value] [--dry-run]",
    "",
    "Ensures a Fly background process group has at least one running Machine and restart=always.",
    "This is intended to run immediately after fly deploy because non-HTTP process groups are not kept",
    "alive by the app http_service min_machines_running setting.",
    "For the worker process, it also verifies required task-generation worker flags are present.",
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
  return execFileSync("fly", args, {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      FLY_API_TOKEN: accessToken(),
      FLY_ACCESS_TOKEN: accessToken(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listMachines(app) {
  return JSON.parse(fly(["machines", "list", "-a", app, "--json"]));
}

function processGroupOf(machine) {
  return machine?.config?.metadata?.fly_process_group || machine?.config?.env?.FLY_PROCESS_GROUP || "";
}

function restartPolicyOf(machine) {
  return machine?.config?.restart?.policy || "";
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
  if (processGroup !== "worker") return [];
  return [
    { name: "TASKNODE_TASK_GENERATION_WORKER_ENABLED", expected: "true" },
    { name: "TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED", expected: "true" },
    { name: "TASKNODE_TASK_REVIEW_WORKER_ENABLED", expected: "true" },
  ];
}

function verifyMachineEnv({ app, machineId, requiredEnv, dryRun = false } = {}) {
  if (!requiredEnv.length) return;
  const checks = requiredEnv.map(({ name, expected }) => (
    `value=$(printenv ${shellQuote(name)} || true); ` +
    `if [ "$value" != ${shellQuote(expected)} ]; then ` +
    `echo "${name}=\${value:-<unset>} expected ${expected}" >&2; missing=1; fi`
  ));
  const script = ["missing=0", ...checks, "exit $missing"].join("; ");
  fly(["ssh", "console", "-a", app, "--machine", machineId, "-C", `sh -lc ${shellQuote(script)}`], { dryRun });
}

function machineSummary(machine) {
  return `${machine.id} state=${machine.state} restart=${restartPolicyOf(machine) || "unset"}`;
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }

  const app = argValue("--app") || process.env.TASKNODE_FLY_APP || DEFAULT_APP;
  const processGroup = argValue("--process") || process.env.TASKNODE_FLY_PROCESS_GROUP || DEFAULT_PROCESS_GROUP;
  const count = Number(argValue("--count") || process.env.TASKNODE_FLY_WORKER_COUNT || DEFAULT_COUNT);
  const dryRun = hasArg("--dry-run");
  const requiredEnv = [
    ...defaultRequiredEnv(processGroup),
    ...argValues("--require-env").map(parseRequiredEnvSpec),
  ];
  if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer.");

  let machines = listMachines(app);
  let groupMachines = machines.filter((machine) => processGroupOf(machine) === processGroup);

  if (groupMachines.length < count) {
    fly([
      "scale",
      "count",
      String(count),
      "--process-group",
      processGroup,
      "-a",
      app,
      "--yes",
    ], { dryRun });
    if (!dryRun) {
      machines = listMachines(app);
      groupMachines = machines.filter((machine) => processGroupOf(machine) === processGroup);
    }
  }

  if (groupMachines.length < count) {
    throw new Error(`Expected at least ${count} ${processGroup} machine(s); found ${groupMachines.length}.`);
  }

  const selected = [...groupMachines].sort(sortCandidates).slice(0, count);
  for (const machine of selected) {
    if (restartPolicyOf(machine) !== "always") {
      fly(["machine", "update", machine.id, "-a", app, "--restart", "always", "--yes"], { dryRun });
    }
    if (machine.state !== "started") {
      fly(["machine", "start", machine.id, "-a", app], { dryRun });
    }
  }

  if (!dryRun) await sleep(3000);

  const afterMachines = dryRun ? groupMachines : listMachines(app).filter((machine) => processGroupOf(machine) === processGroup);
  const started = afterMachines.filter((machine) => machine.state === "started");
  const guardedIds = new Set(selected.map((machine) => machine.id));
  const guardedAfter = afterMachines.filter((machine) => guardedIds.has(machine.id));
  const badRestart = guardedAfter.filter((machine) => restartPolicyOf(machine) !== "always");

  if (!dryRun && started.length < count) {
    throw new Error(
      `${processGroup} guard failed: expected ${count} started machine(s), got ${started.length}. ` +
        `Machines: ${afterMachines.map(machineSummary).join(", ")}`
    );
  }
  if (!dryRun && badRestart.length > 0) {
    throw new Error(
      `${processGroup} guard failed: restart policy is not always for ${badRestart.map(machineSummary).join(", ")}.`
    );
  }
  if (!dryRun && requiredEnv.length) {
    for (const machine of started.slice(0, count)) {
      verifyMachineEnv({ app, machineId: machine.id, requiredEnv, dryRun });
    }
  }

  if (started.length > count) {
    console.warn(
      `${processGroup} has ${started.length} started machines; expected ${count}. ` +
        "Leaving extra machines running because stopping them is an explicit operator action."
    );
  }

  console.log(
    `${processGroup} guard ok for ${app}: ` +
      `${afterMachines.map(machineSummary).join(", ")}`
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
