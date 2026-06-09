#!/usr/bin/env node
import { readFileSync } from "node:fs";

const PRODUCTION_HOSTS = ["tasknode.postfiat.org"];

function flyTomlEnvValue(source, key) {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : "";
}

let flyToml = "";
try {
  flyToml = readFileSync("fly.toml", "utf8");
} catch {
  console.error("fly-deploy-preflight: fly.toml not found; run from the repo root.");
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
