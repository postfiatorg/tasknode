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
import { boardBudgetStatus, boardPacket, sha256 } from "./lib.mjs";
import { boardTaskDetail, requireBoardEvidence } from "../../server/board-task-detail.js";

import { boardAgentActor, boardAgentIdentity, assertBoardAgentScope } from "../../server/board-agent-context.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

// Out-of-order lifecycle commands are permanent state conflicts, not transient
// failures. The error carries structured fields so the API and CLI can tell the
// agent exactly which state it is in and what to do next, and a durable count
// of prior identical rejections so repetition is visible in the message itself.
export async function lifecycleViolation({ taskId, boardId, taskStatus, command, requirement, nextAction = "" }) {
  let priorRejections = 0;
  try {
    const counted = await query(
      `SELECT count(*)::int AS count FROM bm_audit_log
       WHERE actor = $1 AND command = 'lifecycle_rejected'
         AND args_json->>'taskId' = $2 AND args_json->>'taskStatus' = $3 AND args_json->>'command' = $4
         AND created_at > now() - interval '24 hours'`,
      [boardAgentActor(), taskId, taskStatus, command]
    );
    priorRejections = Number(counted.rows[0]?.count) || 0;
  } catch {
    priorRejections = 0;
  }
  const repeated = priorRejections > 0
    ? ` This command has already been rejected ${priorRejections} time(s) while the task stayed in '${taskStatus}'; ` +
      `repeating it cannot succeed until the task status changes.`
    : "";
  const message = `lifecycle_violation: task is in '${taskStatus}'. ${requirement}` +
    (nextAction ? ` Next action: ${nextAction}` : ` No ${command} action is available from '${taskStatus}'.`) + repeated;
  return Object.assign(new Error(message), {
    status: 409,
    lifecycle: { taskId, boardId, taskStatus, command, nextAction, priorRejections },
  });
}

// Durable record of a rejected lifecycle command. Called by the API after the
// command transaction has rolled back, so it survives the rejection.
export async function recordLifecycleRejection({ actor, lifecycle, argv = [] }) {
  return appendBmAudit({
    actor,
    boardId: lifecycle.boardId || "",
    command: "lifecycle_rejected",
    args: { taskId: lifecycle.taskId, taskStatus: lifecycle.taskStatus, command: lifecycle.command, argv },
    result: { rejection: (lifecycle.priorRejections || 0) + 1, nextAction: lifecycle.nextAction || "" },
  });
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
  if (String(taskId).startsWith("task_reinstate_")) throw new Error("Use the reinstatement command for this unpaid task");
  const task = await taskContext(taskId);
  if (!task) throw new Error(`task_not_found:${taskId}`);
  const boardId = await boardForTask(taskId);
  assertBoardAgentScope(boardId);
  if (!boardId) throw new Error(`task_not_board_linked:${taskId} (bm review only covers network board tasks)`);
  // Lifecycle invariant (operator ruling): every task completes the full
  // cycle. A review decision is only recordable after the contributor has
  // answered a verification request. No skip paths.
  if (task.status !== "verification_response_submitted") {
    throw await lifecycleViolation({
      taskId,
      boardId,
      taskStatus: task.status,
      command: "review",
      requirement: `A review decision requires state 'verification_response_submitted'. The cycle is: ` +
        `submitted -> bm verify request -> contributor verification response -> bm review.`,
      nextAction: task.status === "submitted" ? `bm verify request ${taskId} --ask "..."` : "",
    });
  }
  const normalizedDecision = ["reward", "partial_reward", "reject"].includes(decision)
    ? decision
    : "";
  if (!normalizedDecision) {
    throw Object.assign(new Error(
      `review needs --decision reward|partial_reward|reject. Use: review ${taskId} --decision reward --pft <amount> --reason "<why>" --feedback "<note to contributor>"`
    ), { status: 400 });
  }
  await requireBoardEvidence(taskId, { review: true });
  if (normalizedDecision !== "reject") {
    // Operator policy: network tasks are paid only for a PR merged into the
    // default branch. Anything else must be rejected, not rewarded.
    const { assertMergedPrForPayment } = await import("../../server/merged-pr-requirement.js");
    try {
      await assertMergedPrForPayment({ taskId });
    } catch (error) {
      if (error?.code !== "merged_pr_required") throw error;
      throw Object.assign(new Error(
        `${error.message}. This task cannot be rewarded: record \`bm review ${taskId} reject\` citing the missing merged PR.`
      ), { status: 422, code: "merged_pr_required" });
    }
  }
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
    createdBy: boardAgentActor(),
    metadata: { cap_check: capCheck },
  });
  await appendBmAudit({
    actor: boardAgentActor(),
    boardId,
    command: "review",
    args: { taskId, decision: normalizedDecision, requestedPft: requested, reason },
    result: { decisionId: row.id, clampedPft, capsApplied: capCheck.capsApplied, refused },
  });
  // Value accountability: a reward or partial reward clears the case; only an
  // explicit rejection blacklists the account.
  let accountability = null;
  const { VALUE_ACCOUNTABILITY_BOARD_ID, recordAccountabilityVerdict } =
    await import("../../server/value-accountability.js");
  if (boardId === VALUE_ACCOUNTABILITY_BOARD_ID) {
    accountability = await recordAccountabilityVerdict({
      taskId,
      decision: normalizedDecision === "reject" ? "reject" : "accept",
      reason,
      decidedBy: boardAgentActor(),
    });
  }
  return { decision: row, capCheck, clampedPft, refused, accountability };
}

export async function verifyRequest({ taskId, ask, type = "evidence", reason = "" }) {
  if (String(taskId).startsWith("task_reinstate_")) throw new Error("Use the reinstatement command for this unpaid task");
  const task = await taskContext(taskId);
  if (!task) throw new Error(`task_not_found:${taskId}`);
  const boardId = await boardForTask(taskId);
  assertBoardAgentScope(boardId);
  if (!boardId) throw new Error(`task_not_board_linked:${taskId}`);
  if (task.status !== "submitted") {
    throw await lifecycleViolation({
      taskId,
      boardId,
      taskStatus: task.status,
      command: "verify request",
      requirement: `A verification request is issued only for state 'submitted' (after initial ` +
        `evidence, before the contributor's verification response).`,
      nextAction: task.status === "verification_response_submitted"
        ? `bm review ${taskId} --decision reward|partial_reward|reject --pft N --reason "..."`
        : "",
    });
  }
  if (!safeText(ask)) throw new Error("verification ask required (--ask)");
  await requireBoardEvidence(taskId);
  const row = await recordAgentDecision({
    kind: "verification_request",
    taskId,
    boardId,
    verificationAsk: ask,
    verificationType: type,
    reason,
    createdBy: boardAgentActor(),
  });
  await appendBmAudit({
    actor: boardAgentActor(),
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

// An item with a preferred owner goes to that owner whenever they can take it:
// a free slot and a verified badge for the work type (operator decision
// 2026-11-25; the manager offered the founder's governance items to others).
// Open items naming this account as preferred owner (any board).
async function openPreferredItemCount(accountId) {
  const result = await query(`SELECT board_id FROM board_wanted_items WHERE status='open' AND preferred_account_id=$1`, [accountId]);
  if (!result.rows.length) return 0;
  const { listWantedItems } = await import("../../server/board-wanted.js");
  const items = await listWantedItems([...new Set(result.rows.map((row) => row.board_id))]);
  return items.filter((item) => item.state === "open" && item.preferredAccountId === accountId).length;
}

async function assertPreferredOwnerServed({ item, accountId }) {
  const preferred = safeText(item?.preferredAccountId, 180);
  if (preferred !== accountId) {
    // Slots held for this account's own preferred items are not given away.
    const reserved = await openPreferredItemCount(accountId);
    if (reserved > 0) {
      const { getNetworkTaskCapacityState } = await import("../../server/repositories/network-task-capacity.js");
      const capacity = await getNetworkTaskCapacityState({ accountId }).catch(() => null);
      if (capacity && Number(capacity.freeSlots || 0) <= reserved) {
        throw Object.assign(new Error(
          `slots_reserved: ${accountId} has ${capacity.freeSlots} free slot(s) held for ${reserved} open Wanted item(s) that name them as preferred owner. Pick another contributor.`
        ), { status: 409 });
      }
    }
  }
  if (!preferred || preferred === accountId) return;
  const { getNetworkTaskCapacityState } = await import("../../server/repositories/network-task-capacity.js");
  const { explainNetworkTaskCandidateEligibility } = await import("../../server/repositories/network-tasks.js");
  const { networkBadgeProjectionForAccount } = await import("../../server/repositories/network-badges.js");
  const verdict = await explainNetworkTaskCandidateEligibility({ accountId: preferred }).catch(() => null);
  if (!verdict?.eligible) return;
  const capacity = await getNetworkTaskCapacityState({ accountId: preferred, walletAddress: verdict.walletAddress || "" }).catch(() => null);
  if (!(capacity?.freeSlots > 0)) return;
  const workType = item.workType || "code_task";
  const projection = await networkBadgeProjectionForAccount({ accountId: preferred, walletAddress: verdict.walletAddress || "" }).catch(() => null);
  if (!(projection?.verifiedBadges || []).some((badge) => (badge.allowedWorkTypes || []).includes(workType))) return;
  throw Object.assign(new Error(
    `wanted_item_reserved: ${item.id} is reserved for its preferred owner ${preferred} (wallet ${verdict.walletAddress}), who has a free slot and a fitting badge. Create it for them: --account ${preferred} --wallet ${verdict.walletAddress}`
  ), { status: 409 });
}

export async function taskCreate({
  boardId,
  accountId,
  wallet,
  need,
  reason = "Board manager routed a project-linked network task.",
  workType = "",
  wantedId = "",
  requiredBadge = "",
  badgeCap = 0,
  rewardMin = 0,
  rewardMax = 0,
  assigneeHandle = "",
  acceptWindowHours = 0,
  retryFailed = false,
  execute = false,
  // Operator referrals (merge and badge decisions) are duties, not contributor
  // work: they bypass the operator's own task capacity and keep their exact
  // band (0-1 PFT) instead of the contributor floor. Only refer-* set this.
  operatorDuty = false,
}) {
  if (!boardId || !accountId || !wallet) {
    throw Object.assign(new Error("taskCreate requires boardId, accountId, wallet"), { status: 400 });
  }
  assertBoardAgentScope(boardId);
  // Every contributor task comes from an open Wanted item (2026-11-25). The
  // item supplies the reason the task exists and its source link; one item has
  // one live task. Operator referrals (refer-merge, refer-badge) are duties.
  let wantedItem = null;
  // --retry-failed without --wanted only re-queues an existing failed job for
  // the same need (legacy jobs predate the Wanted list); it cannot create new
  // work: with no matching failed job the engine refuses it.
  if (!operatorDuty && !(retryFailed === true && !wantedId)) {
    const { assertWantedItemOpen, wantedTaskNeed } = await import("../../server/board-wanted.js");
    wantedItem = await assertWantedItemOpen({ wantedId, boardId });
    await assertPreferredOwnerServed({ item: wantedItem, accountId });
    need = wantedTaskNeed(wantedItem, need);
    workType = workType || wantedItem.workType || "code_task";
    if (!Number(rewardMax) && wantedItem.rewardPft > 0) rewardMax = wantedItem.rewardPft;
  }
  workType = workType || "code_task";
  if (!safeText(need)) throw Object.assign(new Error("taskCreate requires need"), { status: 400 });
  // Scope is checked before anything else so a dry run fails the same way.
  const { assertBoardAcceptsWork } = await import("../../server/board-work-policy.js");
  assertBoardAcceptsWork({ boardId, workType, operatorDuty });
  const constraints = await boardRoutingConstraints(boardId);
  const allowedHandles = Array.isArray(constraints.assignable_handles)
    ? constraints.assignable_handles.map((handle) => String(handle).toLowerCase())
    : [];
  if (allowedHandles.length) {
    const handle = safeText(assigneeHandle, 120).toLowerCase();
    if (!handle || !allowedHandles.includes(handle)) {
      throw Object.assign(new Error(
        `board_routing_constraint: this board is assignable only to ${allowedHandles.join(", ")} (pass --assignee-handle)`
      ), { status: 422 });
    }
  }
  // Pick the contributor's verified badge that allows this work type when the
  // manager did not name one, so a fitting assignment is not refused on
  // missing metadata.
  if (!requiredBadge && !operatorDuty) {
    const { networkBadgeProjectionForAccount } = await import("../../server/repositories/network-badges.js");
    const projection = await networkBadgeProjectionForAccount({ accountId, walletAddress: wallet });
    const fitting = (projection?.verifiedBadges || []).find((badge) => (badge.allowedWorkTypes || []).includes(workType));
    if (!fitting) {
      throw Object.assign(new Error(
        `no_badge_for_work_type: ${accountId} has no verified badge that allows ${workType} (has: ${(projection?.verifiedBadgeIds || []).join(", ") || "none"}). Pick another contributor or work type.`
      ), { status: 422 });
    }
    requiredBadge = fitting.badgeId;
  }
  const budget = await boardBudgetStatus(boardId);
  if (!budget.configured) throw new Error("board_budget_missing; run migrations");
  const perTask = budget.per_task_cap_pft;
  const cappedMax = Math.min(Number(rewardMax) || perTask, perTask, badgeCap > 0 ? badgeCap : perTask);
  const cappedMin = Math.min(Number(rewardMin) || 0, cappedMax);
  const { assertNetworkTaskRewardFloor, normalizeNetworkTaskRewardBand } =
    await import("../../server/repositories/network-tasks-utils.js");
  assertNetworkTaskRewardFloor({ min: cappedMin, max: cappedMax, operatorDuty });
  const effectiveBand = normalizeNetworkTaskRewardBand({ min: cappedMin, max: cappedMax, operatorDuty });

  const { startBoardManagerRun, completeBoardManagerRun } =
    await import("../../server/repositories/board-manager.js");
  const { executeBoardManagerDecision } = await import("../../server/board-manager-actions.js");

  const trigger = "board_manager_v2_task_create";
  // A targeted assignment needs this board, this candidate and this need, not
  // the global Hive planning packet. The global packet's task-ref join can
  // exceed the command's 15-second statement budget; a timed-out statement
  // aborts the transaction and every later step fails with "current
  // transaction is aborted". Kimi has already selected the work.
  const boardRow = (await query("SELECT id,title,status,metadata_json->'routing_constraints' AS routing_constraints FROM network_projects WHERE id=$1", [boardId])).rows[0] || { id: boardId };
  const sourcePacket = {
    schema: "pf.hive.board_manager.source.v0",
    trigger,
    scope: boardId,
    board: boardRow,
    budget,
    candidate: { account_id: accountId, wallet, assignee_handle: safeText(assigneeHandle, 120) },
    need: safeText(need, 8000),
    reward_band: { min: cappedMin, max: cappedMax },
    work_type: workType,
    required_badge_id: requiredBadge || "",
    retry_failed: retryFailed === true,
  };
  sourcePacket.sourcePacketDigest = sha256(sourcePacket);
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
        allow_over_capacity: operatorDuty === true,
        operator_duty: operatorDuty === true,
        retry_failed: retryFailed === true,
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
  if (execute && wantedItem && actionResult?.result?.executed) {
    const { attachWantedRun } = await import("../../server/board-wanted.js");
    await attachWantedRun({ wantedId: wantedItem.id, runId });
  }
  await appendBmAudit({
    actor: boardAgentActor(),
    boardId,
    command: "task_create",
    args: { accountId, wallet, wantedId: wantedItem?.id || "", need: safeText(need, 500), rewardMin: cappedMin, rewardMax: cappedMax, retryFailed, execute },
    result: { runId, executed: actionResult?.result?.executed ?? false, skipped: actionResult?.result?.skipped ?? false, reason: actionResult?.result?.reason || "", rewardBandClampedFrom: effectiveBand.clampedFrom || null },
  });
  // The command reports the band the offer will advertise and, when it differs
  // from the request, what was asked for.
  return {
    runId,
    dryRun: !execute,
    rewardMin: effectiveBand.min,
    rewardMax: effectiveBand.max,
    ...(effectiveBand.clampedFrom ? { rewardBandClampedFrom: effectiveBand.clampedFrom } : {}),
    actionResult,
  };
}

export async function cancelTask({ taskId, reason = "", execute = false, staleOnly = false }) {
  if (String(taskId).startsWith("task_reinstate_")) throw new Error("Use the reinstatement command for this unpaid task");
  if (!safeText(taskId)) throw new Error("taskId required");
  if (!safeText(reason)) throw new Error("--reason required: cancellations are public audit events");
  const task = await query(
    `SELECT task_id, status, title FROM task_projections WHERE task_id = $1`,
    [safeText(taskId, 180)]
  );
  const row = task.rows[0];
  if (!row) throw new Error(`task_not_found:${taskId}`);
  const boardId = await boardForTask(taskId);
  assertBoardAgentScope(boardId);

  const { startBoardManagerRun, completeBoardManagerRun } =
    await import("../../server/repositories/board-manager.js");
  const { executeBoardManagerDecision } = await import("../../server/board-manager-actions.js");

  const trigger = "board_manager_v2_task_cancel";
  // A targeted cancellation needs this task's evidence and activity, not a
  // global planning packet. Global corpus reads can time out the command's
  // transaction before the cancellation guard is even reached.
  const sourcePacket = {
    schema: "pf.hive.board_manager.source.v0",
    trigger,
    scope: boardId,
    taskDetail: await boardTaskDetail(taskId),
  };
  sourcePacket.sourcePacketDigest = sha256(sourcePacket);
  const decision = {
    action: "cancel_network_task",
    target_type: "network_task",
    target_id: safeText(taskId, 180),
    reason: safeText(reason, 1000),
    confidence: 1,
    payload: {
      summary: `Cancel stale/irrelevant network task ${taskId}`,
      cancel_target: { task_id: safeText(taskId, 180), reason: safeText(reason, 1000), stale_only: staleOnly === true },
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
    actor: boardAgentActor(),
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
  const executed = actionResult?.result?.executed === true;
  return {
    runId,
    phase: !execute ? "dry_run" : executed ? "cancelled" : "skipped",
    message: !execute
      ? `Dry run only: task remains ${row.status}. If eligible, repeat with --execute to cancel it.`
      : executed ? `Task cancelled: ${actionResult.result.status}.` : "Task was not cancelled; inspect the result reason.",
    dryRun: !execute,
    statusBefore: row.status,
    actionResult,
  };
}

export const OPERATOR_HANDLE = "goodalexander";

// The operator who receives merge and badge referrals. Explicit flags win,
// then environment, then the durable record: the account carrying the
// operator handle and its current linked wallet. The scoped API has no
// BM_OPERATOR_* environment, so the lookup is what production uses.
async function operatorTarget({ operatorAccount = "", operatorWallet = "" } = {}) {
  let accountId = safeText(operatorAccount, 180) || process.env.BM_OPERATOR_ACCOUNT_ID || "";
  let wallet = safeText(operatorWallet, 120) || process.env.BM_OPERATOR_WALLET || "";
  if (!accountId) {
    const found = await query("SELECT account_id AS id FROM app_accounts WHERE lower(hive_handle)=lower($1) AND status='active' ORDER BY updated_at DESC LIMIT 1", [OPERATOR_HANDLE]);
    accountId = found.rows[0]?.id || "";
  }
  if (accountId && !wallet) {
    const { getLinkedWallet } = await import("../../server/repositories/account-wallets.js");
    const linked = await getLinkedWallet({ accountId });
    wallet = linked?.status === "linked" ? linked.address || "" : "";
  }
  if (!accountId || !wallet) {
    throw Object.assign(new Error(
      `operator_target_unresolved: no active account with handle ${OPERATOR_HANDLE} and a linked wallet; pass --operator-account/--operator-wallet or set BM_OPERATOR_ACCOUNT_ID/BM_OPERATOR_WALLET`
    ), { status: 422 });
  }
  return { accountId, wallet };
}

export async function referBadge({ accountId, badgeId, evidence = "", boardId = "board_tasknode_fixes", execute = false, operatorAccount = "", operatorWallet = "" }) {
  const operator = await operatorTarget({ operatorAccount, operatorWallet });
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
    // Badge approvals are a project-leadership decision; the badge catalog has
    // no "badge_approval" work type, so the referral would fail the badge gate.
    workType: "project_management",
    requiredBadge: "project_leader",
    operatorDuty: true,
    assigneeHandle: "goodalexander",
    rewardMin: 0,
    rewardMax: 1,
    execute,
  });
}

export async function referMerge({ prUrl, summary = "", boardId, execute = false, operatorAccount = "", operatorWallet = "" }) {
  if (!safeText(prUrl)) throw Object.assign(new Error("--pr-url required"), { status: 400 });
  const operator = await operatorTarget({ operatorAccount, operatorWallet });
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
    // Merge review is code review by the core contributor who owns the repo.
    // "merge_review" is not in any badge's allowed work types.
    workType: "code_review",
    requiredBadge: "core_contributor",
    operatorDuty: true,
    assigneeHandle: "goodalexander",
    rewardMin: 0,
    rewardMax: 1,
    execute,
  });
}

export async function boardUpdate(payload = {}) {
  assertBoardAgentScope(payload.boardId);
  const normalized = normalizeBoardAdminUpdate(payload);
  if (!normalized.ok) throw new Error(`board_update_invalid: ${normalized.error}`);
  const row = await applyBoardAdminUpdate({ ...normalized, actor: boardAgentActor() });
  await appendBmAudit({
    actor: boardAgentActor(),
    boardId: normalized.boardId,
    command: "board_update",
    args: { fields: normalized.fields, metadataPatch: normalized.metadataPatch },
    result: { updated: Boolean(row) },
  });
  return row;
}

// Durable operator action items. A blocker only the operator can clear is
// recorded once with an owner and surfaced in every packet and runtime status
// until it is explicitly resolved. It replaces the same prose blocker being
// repeated in every round.
export async function operatorAction({ boardId, add = "", owner = "", resolve = "", resolution = "" }) {
  assertBoardAgentScope(boardId);
  const row = (await query("SELECT metadata_json FROM network_projects WHERE id=$1", [boardId])).rows[0];
  if (!row) throw Object.assign(new Error(`board_not_found:${boardId}`), { status: 404 });
  const { normalizeOperatorActions } = await import("../../server/board-sources.js");
  const actions = normalizeOperatorActions(row.metadata_json?.operator_actions);
  let entry;
  if (safeText(add)) {
    const description = safeText(add, 600);
    const duplicate = actions.find((item) => !item.resolved_at && item.description === description);
    if (duplicate) return { boardId, action: duplicate, duplicate: true, open: actions.filter((item) => !item.resolved_at) };
    entry = { id: `opact_${sha256(`${boardId}:${description}:${Date.now()}`).slice(0, 12)}`, description, owner: safeText(owner, 120) || "operator", since: new Date().toISOString(), resolved_at: null, resolution: "" };
    actions.push(entry);
  } else if (safeText(resolve)) {
    entry = actions.find((item) => item.id === safeText(resolve, 80));
    if (!entry) throw Object.assign(new Error(`operator_action_not_found:${resolve}`), { status: 404 });
    if (!safeText(resolution)) throw Object.assign(new Error("operator_action_resolution_required"), { status: 400 });
    entry.resolved_at = new Date().toISOString();
    entry.resolution = safeText(resolution, 600);
  } else {
    throw Object.assign(new Error("operator_action_requires_add_or_resolve"), { status: 400 });
  }
  await query("UPDATE network_projects SET metadata_json = COALESCE(metadata_json,'{}'::jsonb) || jsonb_build_object('operator_actions', $2::jsonb), updated_at=now() WHERE id=$1", [boardId, JSON.stringify(actions.slice(-50))]);
  await appendBmAudit({ actor: boardAgentActor(), boardId, command: "operator_action", args: { add: safeText(add, 600), owner, resolve, resolution: safeText(resolution, 600) }, result: { id: entry.id, resolved: Boolean(entry.resolved_at) } });
  return { boardId, action: entry, open: actions.filter((item) => !item.resolved_at) };
}

function journalRoot() {
  return process.env.BM_JOURNAL_DIR || path.join(process.cwd(), "journal");
}

export async function journalAppend({ boardId, text }) {
  assertBoardAgentScope(boardId);
  if (boardAgentIdentity()) {
    if (!safeText(text)) throw new Error("journal text required");
    await appendBmAudit({ actor: boardAgentActor(), boardId, command: "journal_append", args: { text: safeText(text, 16000) }, result: { durable: true } });
    return { boardId, text: safeText(text, 16000), durable: true };
  }
  if (!safeText(text)) throw new Error("journal text required");
  const dir = path.join(journalRoot(), boardId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "journal.md");
  const stamp = new Date().toISOString();
  await appendFile(file, `\n### ${stamp}\n\n${text.trim()}\n`);
  await appendBmAudit({
    actor: boardAgentActor(),
    boardId,
    command: "journal_append",
    args: { chars: text.length, reason: safeText(text, 280) },
    result: { file },
  });
  return { file };
}

export async function writeHandoff({ boardId }) {
  assertBoardAgentScope(boardId);
  const packet = await boardPacket(boardId, { lean: true });
  if (!packet) throw new Error(`board_not_found:${boardId}`);
  const dir = path.join(journalRoot(), boardId);
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
  // Scoped agents receive the markdown; only the local CLI writes files.
  if (boardAgentIdentity()) return { boardId, markdown: lines.join("\n"), durable: true };
  await mkdir(dir, { recursive: true });
  await appendFile(file, lines.join("\n"));
  await appendBmAudit({
    actor: boardAgentActor(),
    boardId,
    command: "handoff",
    args: {},
    result: { file },
  });
  return { file };
}

// Hands each open Wanted item with a preferred owner to that owner when they
// can take it: eligible, a free slot, a badge for the work type. Deterministic;
// runs when a manager round opens, so the founder's items do not depend on the
// manager's judgment (2026-11-25: the manager skipped them three rounds running).
// Routes at most one item per call: each call is its own command transaction,
// so one failing item cannot roll back or block the others.
export async function routePreferredWantedItems(boardIds = []) {
  const { listWantedItems } = await import("../../server/board-wanted.js");
  const { getNetworkTaskCapacityState } = await import("../../server/repositories/network-task-capacity.js");
  const { explainNetworkTaskCandidateEligibility } = await import("../../server/repositories/network-tasks.js");
  const { networkBadgeProjectionForAccount } = await import("../../server/repositories/network-badges.js");
  const { boardWorkPolicy } = await import("../../server/board-work-policy.js");
  const skipped = [];
  for (const item of await listWantedItems(boardIds)) {
    // Three automatic attempts at most; after that the manager rewrites it.
    if (item.state !== "open" || !item.preferredAccountId || item.attempts >= 3) continue;
    if (!boardWorkPolicy(item.boardId)?.open) continue;
    const verdict = await explainNetworkTaskCandidateEligibility({ accountId: item.preferredAccountId }).catch(() => null);
    if (!verdict?.eligible || !verdict.walletAddress) continue;
    const capacity = await getNetworkTaskCapacityState({ accountId: item.preferredAccountId, walletAddress: verdict.walletAddress }).catch(() => null);
    if (!(capacity?.freeSlots > 0)) continue;
    const projection = await networkBadgeProjectionForAccount({ accountId: item.preferredAccountId, walletAddress: verdict.walletAddress }).catch(() => null);
    if (!(projection?.verifiedBadges || []).some((badge) => (badge.allowedWorkTypes || []).includes(item.workType || "code_task"))) continue;
    let result;
    try {
      result = await taskCreate({
        boardId: item.boardId,
        accountId: item.preferredAccountId,
        wallet: verdict.walletAddress,
        wantedId: item.id,
        need: "",
        reason: "Wanted item routed to its preferred owner.",
        execute: true,
      });
    } catch (error) {
      // Validation refusals happen before any write; try the next item.
      skipped.push({ wantedId: item.id, error: error.message });
      continue;
    }
    return { routed: { wantedId: item.id, accountId: item.preferredAccountId, runId: result.runId, executed: Boolean(result.actionResult?.result?.executed) }, skipped };
  }
  return { routed: null, skipped };
}
