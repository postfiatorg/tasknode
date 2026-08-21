import { migrateDatabase } from "../server/db/migrate.js";
import { closePool } from "../server/db/pool.js";
import { processIpfsReplicationJobsOnce } from "../server/ipfs-replication-worker.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function usage() {
  return [
    "IPFS replication worker",
    "",
    "Usage:",
    "  npm run ipfs-replication-worker -- --once",
    "  npm run ipfs-replication-worker -- --poll --interval-ms 60000",
    "  npm run ipfs-replication-worker -- --once --source-ref-prefix task_abc",
    "",
    "Required for real pinning:",
    "  TASKNODE_IPFS_REPLICATION_PIN_ENDPOINT or TASKNODE_IPFS_REPLICATION_PIN_COMMAND",
    "",
    "Options:",
    "  --once                 Process one batch and exit",
    "  --poll                 Process batches continuously",
    "  --limit <n>            Jobs per batch. Default: env or 10",
    "  --interval-ms <n>      Poll interval. Default: 60000",
    "  --source-ref-prefix <s> Restrict this run to source_ref values with the prefix",
  ].join("\n");
}

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(usage());
  process.exit(0);
}

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

await migrateDatabase();

const limit = argValue("--limit", process.env.TASKNODE_IPFS_REPLICATION_BATCH_LIMIT || "10");
const intervalMs = clampInteger(argValue("--interval-ms", "60000"), 60000, 5000, 24 * 60 * 60 * 1000);
const sourceRefPrefix = argValue("--source-ref-prefix", "");

async function runOnce() {
  const result = await processIpfsReplicationJobsOnce({
    limit,
    workerId: `ipfs_replication_cli_${process.pid}`,
    sourceRefPrefix,
  });
  console.log(JSON.stringify({ at: new Date().toISOString(), ...result }, null, hasFlag("--pretty") ? 2 : 0));
  return result;
}

if (hasFlag("--poll")) {
  while (true) {
    await runOnce();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

await runOnce();
await closePool();
