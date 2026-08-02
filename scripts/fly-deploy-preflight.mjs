#!/usr/bin/env node
import { readFileSync } from "node:fs";

const PRODUCTION_HOSTS = ["tasknode.postfiat.org"];
const REQUIRED_PROCESS_GROUPS = [
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

function flyTomlEnvValue(source, key) {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : "";
}

function restartBlocks(source) {
  const blocks = [];
  let current = null;
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "[[restart]]") {
      if (current) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    if (current && /^\s*\[/.test(line)) {
      blocks.push(current.join("\n"));
      current = null;
    }
    if (current) current.push(line);
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

function quotedValues(value) {
  return [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function validateRestartCoverage(source) {
  const covered = new Map();
  for (const block of restartBlocks(source)) {
    const policy = block.match(/^\s*policy\s*=\s*"([^"]+)"/m)?.[1] || "";
    const processValue = block.match(/^\s*processes\s*=\s*\[([^\]]*)\]/m)?.[1] || "";
    for (const processGroup of quotedValues(processValue)) {
      if (REQUIRED_PROCESS_GROUPS.includes(processGroup)) {
        const policies = covered.get(processGroup) || [];
        policies.push(policy);
        covered.set(processGroup, policies);
      }
    }
  }

  const errors = [];
  for (const processGroup of REQUIRED_PROCESS_GROUPS) {
    const policies = covered.get(processGroup) || [];
    if (!policies.length) {
      errors.push(`missing [[restart]] coverage for process group ${processGroup}`);
    } else if (policies.some((policy) => policy !== "always")) {
      errors.push(`process group ${processGroup} has restart policy ${policies.join(", ")}; expected always`);
    }
  }
  return errors;
}

let flyToml = "";
try {
  flyToml = readFileSync("fly.toml", "utf8");
} catch {
  console.error("fly-deploy-preflight: fly.toml not found; run from the repo root.");
  process.exit(1);
}

const restartErrors = validateRestartCoverage(flyToml);
if (restartErrors.length) {
  console.error(
    [
      "fly-deploy-preflight: fly.toml restart policy coverage is invalid.",
      ...restartErrors.map((error) => `  - ${error}`),
    ].join("\n")
  );
  process.exit(1);
}

const publicUrl = flyTomlEnvValue(flyToml, "TASKNODE_PUBLIC_URL");
let publicHost = "";
try {
  publicHost = publicUrl ? new URL(publicUrl).hostname.toLowerCase() : "";
} catch {
  publicHost = "";
}

const isProductionConfig = PRODUCTION_HOSTS.includes(publicHost);
if (!isProductionConfig) {
  console.log(`fly-deploy-preflight ok: ${publicHost || "no public host"} is not a production hostname.`);
  process.exit(0);
}

if (process.env.TASKNODE_CONFIRM_PRODUCTION_DEPLOY === "yes") {
  console.log(`fly-deploy-preflight ok: production deploy to ${publicHost} explicitly confirmed.`);
  process.exit(0);
}

console.error(
  [
    `fly-deploy-preflight: fly.toml targets the production hostname ${publicHost}.`,
    "Production deploys require explicit confirmation:",
    "  npm run fly:deploy:prod",
    "or set TASKNODE_CONFIRM_PRODUCTION_DEPLOY=yes for this invocation.",
  ].join("\n")
);
process.exit(1);
