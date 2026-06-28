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
    "Use npm run fly:worker-guard or npm run fly:board-guard for one process group.",
  ].join("\n");
}

function hasArg(name) {
  return process.argv.includes(name);
}

function runGuard(args) {
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

runGuard(["--process", "worker-pftl", ...sharedArgs]);
runGuard(["--process", "worker-taskgen", ...sharedArgs]);
runGuard(["--process", "worker-task-review", ...sharedArgs]);
runGuard(["--process", "worker-context-rewrite", ...sharedArgs]);
runGuard(["--process", "worker-hive", ...sharedArgs]);
runGuard(["--process", "worker-memory-profile", ...sharedArgs]);
runGuard(["--process", "worker-airdrop", ...sharedArgs]);
runGuard(["--process", "board-secretary", ...sharedArgs]);
