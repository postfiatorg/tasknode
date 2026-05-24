import { closePool, databaseEnabled } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  formatNetworkTaskRecoveryLogs,
  recoverNetworkTasksOnce,
} from "../server/network-task-recovery.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function numberArg(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(argValue(name, fallback));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

if (hasArg("--help") || hasArg("-h")) {
  console.log([
    "Usage: npm run network-task-recovery -- [options]",
    "",
    "Options:",
    "  --limit <n>          Active Network Tasks to inspect. Default: 50",
    "  --project-id <id>    Optional project scope.",
    "  --execute-review     Run the task review queue after recovery classification.",
    "  --json               Print JSON instead of operator logs.",
  ].join("\n"));
  process.exit(0);
}

try {
  if (!databaseEnabled()) {
    console.log("network task recovery skipped: database not configured");
    process.exit(0);
  }
  await migrateDatabase();
  const result = await recoverNetworkTasksOnce({
    limit: numberArg("--limit", 50, { min: 1, max: 250 }),
    projectId: argValue("--project-id", ""),
    executeReviewQueue: hasArg("--execute-review"),
    logger: { info() {}, warn: console.warn, error: console.error },
  });
  if (hasArg("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatNetworkTaskRecoveryLogs(result));
  }
} finally {
  await closePool();
}
