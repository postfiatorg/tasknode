import { closePool, databaseEnabled } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  enqueueBoardManagerJob,
  ensureBoardManagerScope,
  listBoardManagerSchedulerStatus,
  setBoardManagerScopeStatus,
} from "../server/repositories/board-manager-scheduler.js";

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

function usage() {
  return [
    "Usage: npm run board-manager:ops -- <command> [options]",
    "",
    "Commands:",
    "  status                  Show scope, lease, and recent jobs.",
    "  enqueue                 Enqueue a manual Board Manager job.",
    "  pause                   Pause a scope.",
    "  resume                  Resume a scope.",
    "  ensure-scope            Create/update the scope row.",
    "",
    "Options:",
    "  --scope <scope>         Default: global_hive",
    "  --trigger <name>        Trigger for enqueue. Default: manual_operator_trigger",
    "  --reason <text>         Human reason for enqueue/pause/resume.",
    "  --idempotency-key <key> Optional enqueue idempotency key.",
    "  --cadence-seconds <n>   Scope cadence for ensure-scope.",
    "  --max-actions-per-hour <n> Scope action budget for ensure-scope.",
  ].join("\n");
}

const command = process.argv.slice(2).find((item) => !item.startsWith("--")) || "status";
const scope = argValue("--scope", "global_hive");

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

if (!databaseEnabled()) {
  console.error("board_manager_ops_requires_postgres");
  process.exit(1);
}

try {
  await migrateDatabase();
  let result;
  switch (command) {
    case "status":
      result = await listBoardManagerSchedulerStatus({ scope });
      break;
    case "enqueue":
      result = await enqueueBoardManagerJob({
        scope,
        trigger: argValue("--trigger", "manual_operator_trigger"),
        reason: argValue("--reason", "Manual operator trigger."),
        idempotencyKey: argValue("--idempotency-key", `manual:${scope}:${Date.now()}`),
        metadata: { source: "board_manager_ops" },
      });
      break;
    case "pause":
      result = await setBoardManagerScopeStatus({
        scope,
        status: "paused",
        reason: argValue("--reason", "Paused by operator."),
      });
      break;
    case "resume":
      result = await setBoardManagerScopeStatus({
        scope,
        status: "enabled",
        reason: argValue("--reason", "Resumed by operator."),
      });
      break;
    case "ensure-scope":
      result = await ensureBoardManagerScope({
        scope,
        cadenceSeconds: Number(argValue("--cadence-seconds", process.env.TASKNODE_BOARD_MANAGER_CADENCE_SECONDS || "120")),
        maxActionsPerHour: Number(argValue("--max-actions-per-hour", process.env.TASKNODE_BOARD_MANAGER_MAX_ACTIONS_PER_HOUR || "60")),
        metadata: { source: "board_manager_ops" },
      });
      break;
    default:
      throw new Error(`unknown_board_manager_ops_command:${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closePool();
}
