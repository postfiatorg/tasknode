// Write commands for the `bm` board-manager CLI (Gate C).
//
// Every mutating call is deterministically capped (computeRewardCap) and
// audited (bm_audit_log). Reward decisions recorded here are re-clamped by
// the authority reward publisher at publication time; this module is not
// the last line of defense, only the first.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { query } from "../../server/db/pool.js";
import {
  appendBmAudit,
  boardForTask,
  computeRewardCap,
  recordAgentDecision,
} from "../../server/repositories/bm-decisions.js";
import {
  applyBoardAdminUpdate,
  normalizeBoardAdminUpdate,
} from "../../server/board-admin-routes.js";
import { boardBudgetStatus, boardPacket } from "./lib.mjs";

const ACTOR = process.env.BM_ACTOR || "board_manager_agent";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

async function taskContext(taskId) {
  const result = await query(
    `SELECT task_id, account_id, subject_wallet, status, title, reward_offer_pft
     FROM task_projections WHERE task_id = $1`,
    [taskId]
  );
  return result.rows[0] || null;
}

export async function reviewTask({ taskId, decision, pft = 0, reason = "", feedback = "" }) {
  const task = await taskContext(taskId);
  if (!task) throw new Error(`task_not_found:${taskId}`);
  const boardId = await boardForTask(taskId);
  if (!boardId) throw new Error(`task_not_board_linked:${taskId} (bm review only covers network board tasks)`);
  const normalizedDecision = ["reward", "partial_reward", "reject"].includes(decision)
    ? decision
    : "";
  if (!normalizedDecision) throw new Error("decision must be reward|partial_reward|reject");
  const requested = normalizedDecision === "reject" ? 0 : Math.max(0, Number(pft) || 0);
  const capCheck = await computeRewardCap({
    boardId,
    accountId: task.account_id,
    walletAddress: task.subject_wallet,
    requestedPft: requested,
  });
  const clampedPft = Math.min(requested, capCheck.allowedPft);
  const refused = normalizedDecision !== "reject" && requested > 0 && capCheck.refused;
  const row = await recordAgentDecision({
    kind: "review",
    taskId,
    boardId,
    decision: normalizedDecision,
    requestedRewardPft: requested,
    rewardPft: clampedPft,
    capsApplied: capCheck.capsApplied,
    reason,
    userFeedback: feedback,
    status: refused ? "refused" : "pending",
    createdBy: ACTOR,
    metadata: { cap_check: capCheck },
  });
  await appendBmAudit({
    actor: ACTOR,
    boardId,
    command: "review",
    args: { taskId, decision: normalizedDecision, requestedPft: requested, reason },
    result: { decisionId: row.id, clampedPft, capsApplied: capCheck.capsApplied, refused },
  });
  return { decision: row, capCheck, clampedPft, refused };
}

export async function verifyRequest({ taskId, ask, type = "evidence", reason = "" }) {
  const task = await taskContext(taskId);
  if (!task) throw new Error(`task_not_found:${taskId}`);
  const boardId = await boardForTask(taskId);
  if (!boardId) throw new Error(`task_not_board_linked:${taskId}`);
  if (!safeText(ask)) throw new Error("verification ask required (--ask)");
  const row = await recordAgentDecision({
    kind: "verification_request",
    taskId,
    boardId,
    verificationAsk: ask,
    verificationType: type,
    reason,
    createdBy: ACTOR,
  });
  await appendBmAudit({
    actor: ACTOR,
    boardId,
    command: "verify_request",
    args: { taskId, type },
    result: { decisionId: row.id },
  });
  return { decision: row };
}

async function boardRoutingConstraints(boardId) {
  const result = await query(
    `SELECT metadata_json FROM network_projects WHERE id = $1`,
    [boardId]
  );
  return result.rows[0]?.metadata_json?.routing_constraints || {};
}

export async function taskCreate({
  boardId,
  accountId,
  wallet,
  need,
  reason = "Board manager routed a project-linked network task.",
  workType = "code_task",
  requiredBadge = "",
  badgeCap = 0,
  rewardMin = 0,
  rewardMax = 0,
  assigneeHandle = "",
  acceptWindowHours = 0,
  execute = false,
}) {
  if (!boardId || !accountId || !wallet || !safeText(need)) {
    throw new Error("taskCreate requires boardId, accountId, wallet, need");
  }
  const constraints = await boardRoutingConstraints(boardId);
  const allowedHandles = Array.isArray(constraints.assignable_handles)
    ? constraints.assignable_handles.map((handle) => String(handle).toLowerCase())
    : [];
  if (allowedHandles.length) {
    const handle = safeText(assigneeHandle, 120).toLowerCase();
    if (!handle || !allowedHandles.includes(handle)) {
      throw new Error(
        `board_routing_constraint: this board is assignable only to ${allowedHandles.join(", ")} (pass --assignee-handle)`
      );
    }
  }
  const budget = await boardBudgetStatus(boardId);
  if (!budget.configured) throw new Error("board_budget_missing; run migrations");
  const perTask = budget.per_task_cap_pft;
  const cappedMax = Math.min(Number(rewardMax) || perTask, perTask, badgeCap > 0 ? badgeCap : perTask);
  const cappedMin = Math.min(Number(rewardMin) || 0, cappedMax);

  const { buildBoardManagerSourcePacket, startBoardManagerRun, completeBoardManagerRun } =
    await import("../../server/repositories/board-manager.js");
  const { executeBoardManagerDecision } = await import("../../server/board-manager-actions.js");

  const trigger = "board_manager_v2_task_create";
  const sourcePacket = await buildBoardManagerSourcePacket({ trigger, scope: "global_hive" });
  const decision = {
    action: "initiate_network_task",
    target_type: "network_project",
    target_id: boardId,
    reason,
    confidence: 1,
    payload: {
      summary: need,
      next_steps: ["Queue a project-linked Network Task through the standard task engine."],
      network_task: {
        task_work_type: workType,
        required_badge_id: requiredBadge,
        operating_badge_id: requiredBadge,
        badge_work_type: workType,
        badge_reason: "Board Manager v2 routing.",
        badge_reward_cap_pft: badgeCap > 0 ? badgeCap : perTask,
        badge_evidence_requirements: ["Submit the evidence named in the task body."],
        discord_evidence_required: false,
        task_class: "network",
        candidate_account_id: accountId,
        candidate_wallet_address: wallet,
        project_need_summary: need,
        routing_reason: reason,
        cadence_reason: "Board Manager v2 agent routing.",
        action_output: "Concrete artifact named in the task body.",
        delivery_surface: "task_submission",
        recipient_or_reviewer: "Board Manager",
        escalation_stage: "board_manager_v2",
        lineage_task_ids: [],
        referenced_outputs: [],
        deduped_against: [],
        why_not_duplicate: "Board Manager v2 generated this against live board state.",
        reward_min_pft: cappedMin,
        reward_max_pft: cappedMax,
        accept_window_hours: acceptWindowHours > 0 ? acceptWindowHours : 0,
        allow_over_capacity: false,
      },
    },
  };
  const started = await startBoardManagerRun({
    scope: "global_hive",
    managerId: "board_manager_v2",
    trigger,
    sourcePacket,
    dryRun: !execute,
    model: "board_manager_v2_cli",
    reasoningEffort: "none",
    sessionMode: "board_manager_v2_cli",
  });
  const runId = started.run?.id || "";
  await completeBoardManagerRun({
    runId,
    decision,
    outputText: JSON.stringify({ board_manager_v2_decision: decision }, null, 2),
  });
  const actionResult = await executeBoardManagerDecision({
    runId,
    decision,
    sourcePacket,
    dryRun: !execute,
  });
  await appendBmAudit({
    actor: ACTOR,
    boardId,
    command: "task_create",
    args: { accountId, wallet, need: safeText(need, 500), rewardMin: cappedMin, rewardMax: cappedMax, execute },
    result: { runId, executed: actionResult?.result?.executed ?? false, skipped: actionResult?.result?.skipped ?? false, reason: actionResult?.result?.reason || "" },
  });
  return { runId, dryRun: !execute, rewardMin: cappedMin, rewardMax: cappedMax, actionResult };
}

export async function cancelTask({ taskId, reason = "", execute = false }) {
  if (!safeText(taskId)) throw new Error("taskId required");
  if (!safeText(reason)) throw new Error("--reason required: cancellations are public audit events");
  const task = await query(
    `SELECT task_id, status, title FROM task_projections WHERE task_id = $1`,
    [safeText(taskId, 180)]
  );
  const row = task.rows[0];
  if (!row) throw new Error(`task_not_found:${taskId}`);
  const boardId = await boardForTask(taskId);

  const { buildBoardManagerSourcePacket, startBoardManagerRun, completeBoardManagerRun } =
    await import("../../server/repositories/board-manager.js");
  const { executeBoardManagerDecision } = await import("../../server/board-manager-actions.js");

  const trigger = "board_manager_v2_task_cancel";
  const sourcePacket = await buildBoardManagerSourcePacket({ trigger, scope: "global_hive" });
  const decision = {
    action: "cancel_network_task",
    target_type: "network_task",
    target_id: safeText(taskId, 180),
    reason: safeText(reason, 1000),
    confidence: 1,
    payload: {
      summary: `Cancel stale/irrelevant network task ${taskId}`,
      cancel_target: { task_id: safeText(taskId, 180), reason: safeText(reason, 1000) },
    },
  };
  const started = await startBoardManagerRun({
    scope: "global_hive",
    managerId: "board_manager_v2",
    trigger,
    sourcePacket,
    dryRun: !execute,
    model: "board_manager_v2_cli",
    reasoningEffort: "none",
    sessionMode: "board_manager_v2_cli",
  });
  const runId = started.run?.id || "";
  await completeBoardManagerRun({
    runId,
    decision,
    outputText: JSON.stringify({ board_manager_v2_decision: decision }, null, 2),
  });
  const actionResult = await executeBoardManagerDecision({
    runId,
    decision,
    sourcePacket,
    dryRun: !execute,
  });
  await appendBmAudit({
    actor: ACTOR,
    boardId,
    command: "task_cancel",
    args: { taskId, reason: safeText(reason, 280), status_before: row.status, execute },
    result: {
      runId,
      executed: actionResult?.result?.executed ?? false,
      skipped: actionResult?.result?.skipped ?? false,
      reason: actionResult?.result?.reason || "",
    },
  });
  return { runId, dryRun: !execute, statusBefore: row.status, actionResult };
}

function operatorTarget({ operatorAccount = "", operatorWallet = "" } = {}) {
  const accountId = operatorAccount || process.env.BM_OPERATOR_ACCOUNT_ID || "";
  const wallet = operatorWallet || process.env.BM_OPERATOR_WALLET || "";
  if (!accountId || !wallet) {
    throw new Error(
      "operator target missing: set BM_OPERATOR_ACCOUNT_ID and BM_OPERATOR_WALLET or pass --operator-account/--operator-wallet"
    );
  }
  return { accountId, wallet };
}

export async function referBadge({ accountId, badgeId, evidence = "", boardId = "board_tasknode_fixes", execute = false, operatorAccount = "", operatorWallet = "" }) {
  const operator = operatorTarget({ operatorAccount, operatorWallet });
  const need = [
    `Badge approval request: grant badge \`${badgeId}\` to account \`${accountId}\`.`,
    `Screened by the board manager as worth approving. Evidence: ${safeText(evidence, 1500) || "see attached task history"}.`,
    "Approve via the network badge admin route, or reject with reason.",
  ].join(" ");
  return taskCreate({
    boardId,
    accountId: operator.accountId,
    wallet: operator.wallet,
    need,
    reason: `Badge referral for ${accountId}:${badgeId}`,
    workType: "badge_approval",
    assigneeHandle: "goodalexander",
    rewardMin: 0,
    rewardMax: 1,
    execute,
  });
}

export async function referMerge({ prUrl, summary = "", boardId, execute = false, operatorAccount = "", operatorWallet = "" }) {
  if (!safeText(prUrl)) throw new Error("--pr-url required");
  const operator = operatorTarget({ operatorAccount, operatorWallet });
  const need = [
    `PR merge review: ${prUrl}.`,
    `Board manager initial review passed. ${safeText(summary, 1500)}`,
    "Review and merge if acceptable; otherwise comment with required changes.",
  ].join(" ");
  return taskCreate({
    boardId: boardId || "board_tasknode_fixes",
    accountId: operator.accountId,
    wallet: operator.wallet,
    need,
    reason: `Merge referral for ${prUrl}`,
    workType: "merge_review",
    assigneeHandle: "goodalexander",
    rewardMin: 0,
    rewardMax: 1,
    execute,
  });
}

export async function boardUpdate(payload = {}) {
  const normalized = normalizeBoardAdminUpdate(payload);
  if (!normalized.ok) throw new Error(`board_update_invalid: ${normalized.error}`);
  const row = await applyBoardAdminUpdate({ ...normalized, actor: ACTOR });
  await appendBmAudit({
    actor: ACTOR,
    boardId: normalized.boardId,
    command: "board_update",
    args: { fields: normalized.fields, metadataPatch: normalized.metadataPatch },
    result: { updated: Boolean(row) },
  });
  return row;
}

function journalRoot() {
  return process.env.BM_JOURNAL_DIR || path.join(process.cwd(), "journal");
}

export async function journalAppend({ boardId, text }) {
  if (!safeText(text)) throw new Error("journal text required");
  const dir = path.join(journalRoot(), boardId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "journal.md");
  const stamp = new Date().toISOString();
  await appendFile(file, `\n### ${stamp}\n\n${text.trim()}\n`);
  await appendBmAudit({
    actor: ACTOR,
    boardId,
    command: "journal_append",
    args: { chars: text.length, reason: safeText(text, 280) },
    result: { file },
  });
  return { file };
}

export async function writeHandoff({ boardId }) {
  const packet = await boardPacket(boardId);
  if (!packet) throw new Error(`board_not_found:${boardId}`);
  const dir = path.join(journalRoot(), boardId);
  await mkdir(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `handoff-${day}.md`);
  const lines = [
    `# ${packet.board.title} handoff ${day}`,
    "",
    `Budget: ${JSON.stringify(packet.budget)}`,
    "",
    `## Awaiting review (${packet.tasks.awaiting_review.length})`,
    ...packet.tasks.awaiting_review.map((task) => `- ${task.task_id} [${task.status}] ${task.title}`),
    "",
    `## In verification (${packet.tasks.in_verification.length})`,
    ...packet.tasks.in_verification.map((task) => `- ${task.task_id} ${task.title}`),
    "",
    `## Open (${packet.tasks.open.length})`,
    ...packet.tasks.open.map((task) => `- ${task.task_id} [${task.status}] ${task.title}`),
    "",
    `## Pending decisions (${packet.pending_decisions.length})`,
    ...packet.pending_decisions.map((decisionRow) => `- ${decisionRow.id} ${decisionRow.kind} ${decisionRow.task_id} ${decisionRow.decision}`),
    "",
    "## Notes for next session",
    "",
    "(agent: annotate threads in flight, then commit this file)",
    "",
  ];
  await appendFile(file, lines.join("\n"));
  await appendBmAudit({
    actor: ACTOR,
    boardId,
    command: "handoff",
    args: {},
    result: { file },
  });
  return { file };
}
