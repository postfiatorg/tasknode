#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suite = String(process.argv[2] || "").trim();

function run(command, args = []) {
  execFileSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
}

function runNode(script, args = []) {
  run(process.execPath, [path.join(root, script), ...args]);
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("public_suite_requires_npm_execpath");
  run(process.execPath, [npmCli, ...args]);
}

function unit() {
  for (const script of [
    "scripts/route-auth-policy-smoke.mjs",
    "scripts/request-validation-smoke.mjs",
    "scripts/durable-identity-boundary-smoke.mjs",
    "scripts/app-state-cache-gate-smoke.mjs",
    "scripts/nostr-messages-smoke.mjs",
    "scripts/wallet-state-regression.mjs",
    "scripts/container-entrypoint-smoke.mjs",
    "scripts/runtime-role-boundary-smoke.mjs",
    "scripts/extension-registry-smoke.mjs",
  ]) runNode(script);
}

function integration() {
  for (const script of [
    "scripts/runtime-store-smoke.mjs",
    "scripts/chat-attachment-smoke.mjs",
    "scripts/pftl-cache-smoke.mjs",
    "scripts/pftl-cache-watcher-smoke.mjs",
    "scripts/security-smoke.mjs",
  ]) runNode(script);
}

function security() {
  runNpm(["audit", "--audit-level=high"]);
  for (const script of [
    "scripts/public-help-boundary.mjs",
    "scripts/route-auth-policy-smoke.mjs",
    "scripts/trusted-proxy-rate-limit-smoke.mjs",
    "scripts/account-data-lifecycle-smoke.mjs",
    "scripts/data-retention-smoke.mjs",
    "scripts/data-recovery-safety-smoke.mjs",
    "scripts/asset-provenance-check.mjs",
    "scripts/dependency-license-check.mjs",
  ]) runNode(script);
}

function fast() {
  runNode("scripts/check-file-size.mjs");
  runNode("scripts/format-check.mjs");
  run(path.join(root, "node_modules/.bin/eslint"), ["src", "server", "scripts", "shared"]);
  runNode("scripts/generate-api-reference.mjs");
  security();
}

function all() {
  fast();
  unit();
  integration();
  run(path.join(root, "node_modules/.bin/vite"), ["build"]);
  runNode("scripts/bundle-budget-check.mjs");
  runNode("scripts/route-smoke.mjs");
}

const suites = { all, fast, integration, security, unit };
if (!suites[suite]) throw new Error(`unknown_public_suite:${suite || "missing"}`);
suites[suite]();
