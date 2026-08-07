#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerGuardPath = path.join(__dirname, "fly-worker-guard.mjs");

function usage() {
  return [
    "Usage: npm run fly:background-guard -- [--app tasknodeofficial-dev] [--count 1] [--require-env NAME=value] [--dry-run]",
    "",
    "Runs the Fly worker guard for non-HTTP background process groups:",
    "  1. worker-pftl",
    "  2. worker-taskgen",
    "  3. worker-task-review",
    "  4. worker-context-rewrite",
    "  5. worker-hive",
    "  6. worker-memory-profile",
    "  7. worker-airdrop",
    "  8. board-secretary",
    "",
    "Every group is guarded at one active replica; worker-airdrop intentionally",
    "runs a single active machine plus a cold standby so airdrops are never",
    "processed by two live workers at once.",
    "An explicit --count overrides that default for all guarded process groups.",
    "",
    "Use npm run fly:worker-guard or npm run fly:board-guard for one process group.",
  ].join("\n");
}

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
}

function guardArgsForProcess(processGroup, sharedArgs) {
  // worker-airdrop deliberately runs one active machine plus a cold standby.
  // Guarding it at two active replicas would demand a second live worker and
  // risk double-processing airdrops, so every group is guarded at one.
  return ["--process", processGroup, ...sharedArgs];
}

function runGuard(args, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(
      `[dry-run] worker guard process=${argValue(args, "--process")} ` +
      `count=${argValue(args, "--count", "1")}`
    );
    return;
  }
  execFileSync(process.execPath, [workerGuardPath, ...args], {
    cwd: path.resolve("."),
    env: process.env,
    stdio: "inherit",
  });
}

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

if (hasArg("--process")) {
  console.error("fly:background-guard runs worker and board-manager; use fly:worker-guard for a custom --process.");
  process.exit(1);
}

const sharedArgs = process.argv.slice(2);
const dryRun = hasArg("--dry-run");

for (const processGroup of [
  "worker-pftl",
  "worker-taskgen",
  "worker-task-review",
  "worker-context-rewrite",
  "worker-hive",
  "worker-memory-profile",
  "worker-airdrop",
  "board-secretary",
]) {
  runGuard(guardArgsForProcess(processGroup, sharedArgs), { dryRun });
}
