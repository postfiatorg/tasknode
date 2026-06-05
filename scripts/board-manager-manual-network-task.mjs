import { closePool, databaseEnabled } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { executeBoardManagerDecision } from "../server/board-manager-actions.js";
import {
  buildBoardManagerSourcePacket,
  completeBoardManagerRun,
  startBoardManagerRun,
} from "../server/repositories/board-manager.js";

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

function numberArg(name, fallback) {
  const parsed = Number(argValue(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function usage() {
  return [
    "Usage: npm run board-manager:manual-network-task -- [options]",
    "",
    "Creates a Board Manager run with an operator-supplied initiate_network_task decision.",
    "The action still goes through the normal Board Manager action hook and Network Task generation worker.",
    "",
    "Options:",
    "  --project-id <id>          Network project id.",
    "  --account-id <id>          Candidate account id.",
    "  --wallet <address>         Candidate wallet address.",
    "  --need <text>              Project need summary for the generated task.",
    "  --reason <text>            Routing reason.",
    "  --task-class <class>       network or alpha. Default: network.",
    "  --reward-min <pft>         Default: 20000.",
    "  --reward-max <pft>         Default: 50000.",
    "  --accept-window-hours <n>  Default: 24.",
    "  --allow-over-capacity      Set action-hook over-capacity flag.",
    "  --execute                  Enqueue the allocation. Without this, records a dry run.",
  ].join("\n");
}

if (hasArg("--help") || hasArg("-h")) {
  console.log(usage());
  process.exit(0);
}

try {
  if (!databaseEnabled()) {
    console.error("board_manager_manual_network_task_requires_postgres");
    process.exit(1);
  }
  await migrateDatabase();

  const projectId = argValue("--project-id");
  const accountId = argValue("--account-id");
  const wallet = argValue("--wallet");
  const need = argValue("--need");
  const reason = argValue("--reason", "Operator routed a project-linked Network Task.");
  if (!projectId || !accountId || !wallet || !need) {
    console.error("board_manager_manual_network_task_missing_required_args");
    console.log(usage());
    process.exit(1);
  }

  const execute = hasArg("--execute");
  const trigger = argValue("--trigger", "manual_operator_network_task");
  const sourcePacket = await buildBoardManagerSourcePacket({ trigger, scope: "global_hive" });
  const decision = {
    action: "initiate_network_task",
    target_type: "network_project",
    target_id: projectId,
    reason,
    confidence: 1,
    payload: {
      summary: need,
      next_steps: ["Queue a project-linked Network Task through the standard task engine."],
      network_task: {
        task_class: argValue("--task-class", "network"),
        candidate_account_id: accountId,
        candidate_wallet_address: wallet,
        project_need_summary: need,
        routing_reason: reason,
        cadence_reason: argValue("--cadence-reason", "Manual operator routing after Hive Context request."),
        reward_min_pft: numberArg("--reward-min", 20000),
        reward_max_pft: numberArg("--reward-max", 50000),
        accept_window_hours: numberArg("--accept-window-hours", 24),
        allow_over_capacity: hasArg("--allow-over-capacity"),
      },
    },
  };

  const started = await startBoardManagerRun({
    scope: "global_hive",
    managerId: "operator_manual_network_task",
    trigger,
    sourcePacket,
    dryRun: !execute,
    model: "operator_manual",
    reasoningEffort: "none",
    sessionMode: "operator_manual_action_hook",
  });
  const runId = started.run?.id || "";
  await completeBoardManagerRun({
    runId,
    decision,
    outputText: JSON.stringify({ operator_supplied_decision: decision }, null, 2),
  });
  const actionResult = await executeBoardManagerDecision({
    runId,
    decision,
    sourcePacket,
    dryRun: !execute,
  });
  console.log(JSON.stringify({
    ok: true,
    dryRun: !execute,
    runId,
    sourcePacketDigest: sourcePacket.sourcePacketDigest,
    decision,
    actionResult,
  }, null, 2));
} finally {
  await closePool();
}
