import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { Wallet } from "xrpl";

const targetPath = ".env.local-rewards";
const devPath = ".env.tasknodeofficial-dev";

const copiedKeys = [
  "AMBIENT_API_KEY",
  "AMBIENT_BASE_URL",
  "TASKNODE_TASKGEN_MODEL",
  "TASKNODE_TASK_REVIEW_MODEL",
  "PFTL_RPC_URL",
  "PFTL_RPC_URL_FALLBACKS",
  "PFTL_WSS_URL",
  "PFTL_WSS_URL_FALLBACKS",
  "PFTL_HISTORY_WSS_URL",
  "PFTL_HISTORY_RPC_URL",
  "PFTL_RPC_API_KEY",
];

function parseEnv(text = "") {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function serializeEnv(env) {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${String(value || "").replace(/\n/g, "")}`)
    .join("\n")}\n`;
}

async function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseEnv(await readFile(path, "utf8"));
}

function localNamespace() {
  return `local_${os.hostname().replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40) || "tasknode"}`;
}

const existing = await readEnvFile(targetPath);
const dev = await readEnvFile(devPath);
const next = { ...existing };

next.TASKNODE_LOCAL_NAMESPACE ||= localNamespace();
next.TASKNODE_LOCAL_SERVICE_SEED ||= Wallet.generate().seed;
next.TASKNODE_LOCAL_AUTHORITY_SEED ||= Wallet.generate().seed;
next.TASKNODE_LOCAL_REWARD_SEED ||= Wallet.generate().seed;
next.TASKNODE_LOCAL_FAUCET_SEED ||= "";

for (const key of copiedKeys) {
  next[key] ||= process.env[key] || dev[key] || "";
}

next.TASKNODE_TASKGEN_MODEL ||= "z-ai/glm-5.2";
next.TASKNODE_TASK_REVIEW_MODEL ||= "z-ai/glm-5.2";

await writeFile(targetPath, serializeEnv(next), { mode: 0o600 });
await chmod(targetPath, 0o600);

const missing = copiedKeys.filter((key) => !next[key] && key === "AMBIENT_API_KEY");
console.log(`wrote ${targetPath}`);
console.log(`namespace=${next.TASKNODE_LOCAL_NAMESPACE}`);
console.log("local_authority_seed=configured");
console.log("local_reward_seed=configured");
if (missing.length) {
  console.warn(`missing ${missing.join(", ")}; reward-test worker will not start until it is set`);
}
