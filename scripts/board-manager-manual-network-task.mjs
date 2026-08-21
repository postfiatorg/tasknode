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
    "  --task-work-type <type>    Audit work type used for generation.",
    "  --required-badge <id>      Required verified badge id for the lane.",
    "  --operating-badge <id>     Badge the candidate operates under. Defaults to required badge.",
    "  --badge-work-type <type>   Badge lane work type. Defaults to task work type.",
    "  --badge-reward-cap <pft>   Badge payout cap for this lane.",
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
  const taskWorkType = argValue("--task-work-type");
  const requiredBadgeId = argValue("--required-badge");
  const operatingBadgeId = argValue("--operating-badge", requiredBadgeId);
  const badgeWorkType = argValue("--badge-work-type", taskWorkType);
  const badgeRewardCapPft = numberArg("--badge-reward-cap", 0);
  if (!projectId || !accountId || !wallet || !need || !taskWorkType || !requiredBadgeId || !badgeWorkType || !badgeRewardCapPft) {
    console.error("board_manager_manual_network_task_missing_required_args");
    console.log(usage());
    process.exit(1);
  }

  const execute = hasArg("--execute");
  const rewardMinPft = Math.min(numberArg("--reward-min", Math.min(20000, badgeRewardCapPft || 20000)), badgeRewardCapPft);
  const rewardMaxPft = Math.min(numberArg("--reward-max", badgeRewardCapPft || 50000), badgeRewardCapPft);
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
        task_work_type: taskWorkType,
        required_badge_id: requiredBadgeId,
        operating_badge_id: operatingBadgeId,
        badge_work_type: badgeWorkType,
        badge_reason: argValue("--badge-reason", "Manual operator supplied badge routing metadata."),
        badge_reward_cap_pft: badgeRewardCapPft,
        badge_evidence_requirements: [argValue("--badge-evidence", "Submit badge-appropriate proof plus Discord announcement evidence.")],
        discord_evidence_required: true,
        task_class: argValue("--task-class", "network"),
        candidate_account_id: accountId,
        candidate_wallet_address: wallet,
        project_need_summary: need,
        routing_reason: reason,
        cadence_reason: argValue("--cadence-reason", "Manual operator routing after Hive Context request."),
        action_output: argValue("--action-output", "Badge-appropriate artifact submitted through the task evidence flow."),
        delivery_surface: argValue("--delivery-surface", "task_submission"),
        recipient_or_reviewer: argValue("--recipient-or-reviewer", "Task reviewer"),
        escalation_stage: argValue("--escalation-stage", "manual_operator_routing"),
        lineage_task_ids: [],
        referenced_outputs: [],
        deduped_against: [],
        why_not_duplicate: argValue("--why-not-duplicate", "Manual operator selected this as the current next action."),
        reward_min_pft: rewardMinPft,
        reward_max_pft: Math.max(rewardMinPft, rewardMaxPft),
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
