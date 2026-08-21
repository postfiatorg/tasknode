import { closePool, databaseEnabled } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { failNetworkTaskGenerationChain } from "../server/repositories/network-tasks.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    "Usage: npm run network-task-allocation-repair -- fail [options]",
    "",
    "Commands:",
    "  fail                       Mark a bad generated Network Task allocation chain failed/stale.",
    "",
    "Options:",
    "  --allocation-id <id>       Target allocation id.",
    "  --job-id <id>              Target generation job id.",
    "  --request-id <id>          Target task request id.",
    "  --reason <text>            Operator audit reason.",
    "  --operator <name>          Operator label. Default: operator.",
    "  --force                    Allow failing a chain that already has a task id.",
    "  --execute                  Apply the repair. Without this, prints dry-run target only.",
  ].join("\n");
}

const command = process.argv.slice(2).find((item) => !item.startsWith("--")) || "help";

if (hasArg("--help") || hasArg("-h") || command === "help") {
  console.log(usage());
  process.exit(0);
}

if (command !== "fail") {
  console.error(`unknown_network_task_allocation_repair_command:${command}`);
  console.log(usage());
  process.exit(1);
}

try {
  if (!databaseEnabled()) {
    console.error("network_task_allocation_repair_requires_postgres");
    process.exit(1);
  }
  await migrateDatabase();
  const target = {
    allocationId: argValue("--allocation-id"),
    jobId: argValue("--job-id"),
    requestId: argValue("--request-id"),
    reason: argValue("--reason", "operator marked Network Task generation chain failed"),
    operator: argValue("--operator", "operator"),
    force: hasArg("--force"),
  };
  if (!hasArg("--execute")) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      action: "fail_network_task_generation_chain",
      target,
    }, null, 2));
    process.exit(0);
  }
  const result = await failNetworkTaskGenerationChain(target);
  console.log(JSON.stringify({ ok: true, dryRun: false, result }, null, 2));
} finally {
  await closePool();
}
