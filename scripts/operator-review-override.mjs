#!/usr/bin/env node
// Operator override for a network task whose Board Manager review is stuck.
//
// Use when the Board Manager recorded a pending review decision that cannot
// publish (for example a reject blocked by the merged-PR payment check) and the
// operator has adjudicated the outcome. It goes through the normal pipeline:
// recordAgentDecision supersedes the pending decision and wakes the
// reward_scoring worker, which applies caps, publishes and pays as usual.
//
//   node scripts/operator-review-override.mjs <taskId> --mode waive|hold \
//     --reason "..." [--feedback "..."] [--pft N] [--operator goodalexander] [--execute]
//
// --mode waive  Record an operator waiver of the merged-PR requirement on this
//               task (operator_waiver evidence, never reusable by another task),
//               then record a reward decision. Pays on the worker's next tick.
// --mode hold   Record a reward decision without a waiver. The merged-PR check
//               holds payment until the task's PR merges, then it pays.
// Without --execute the script only prints what it would do.

import { query } from "../server/db/pool.js";
import {
  appendBmAudit,
  boardForTask,
  computeRewardCap,
  pendingAgentDecision,
  recordAgentDecision,
} from "../server/repositories/bm-decisions.js";
import { MERGED_PR_POLICY_VERSION } from "../server/merged-pr-requirement.js";

function flag(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

export function waiverEvidence({ taskId, operator, reason, now = new Date() }) {
  return {
    policy: MERGED_PR_POLICY_VERSION,
    key: `operator_waiver:${taskId}`,
    waived: true,
    operator,
    reason,
    recorded_at: now.toISOString(),
  };
}

async function main() {
  const taskId = process.argv[2] || "";
  const mode = flag("--mode");
  const reason = flag("--reason");
  const feedback = flag("--feedback");
  const operator = flag("--operator", "goodalexander");
  const execute = process.argv.includes("--execute");
  if (!taskId.startsWith("task_") || !["waive", "hold"].includes(mode) || !reason) {
    console.error("Usage: operator-review-override.mjs <taskId> --mode waive|hold --reason \"...\" [--feedback ...] [--pft N] [--execute]");
    process.exit(2);
  }

  const task = (await query(
    `SELECT task_id, account_id, subject_wallet, status, reward_offer_pft,
            metadata_json->'merged_pr_evidence' AS merged_pr_evidence
       FROM task_projections WHERE task_id = $1`,
    [taskId]
  )).rows[0];
  if (!task) throw new Error(`task_not_found:${taskId}`);
  if (task.status !== "verification_response_submitted") {
    throw new Error(`task_not_awaiting_review:${task.status}`);
  }
  const boardId = await boardForTask(taskId);
  if (!boardId) throw new Error(`task_not_board_linked:${taskId}`);
  const pending = await pendingAgentDecision({ taskId, kind: "review" });

  const requested = Number(flag("--pft", task.reward_offer_pft)) || 0;
  const capCheck = await computeRewardCap({
    boardId,
    accountId: task.account_id,
    walletAddress: task.subject_wallet,
    requestedPft: requested,
  });
  const rewardPft = Math.min(requested, capCheck.allowedPft);
  const plan = {
    taskId,
    boardId,
    mode,
    supersedes: pending ? { id: pending.id, decision: pending.decision, reward_pft: pending.reward_pft } : null,
    new_decision: { decision: "reward", requested_pft: requested, reward_pft: rewardPft, caps_applied: capCheck.capsApplied, refused: capCheck.refused },
    waiver: mode === "waive" ? waiverEvidence({ taskId, operator, reason }) : null,
    existing_merged_pr_evidence: task.merged_pr_evidence || null,
  };
  if (!execute) {
    console.log(JSON.stringify({ dry_run: true, ...plan }, null, 2));
    return;
  }
  if (capCheck.refused || rewardPft <= 0) throw new Error(`reward_refused_by_caps:${JSON.stringify(capCheck.capsApplied)}`);

  if (mode === "waive") {
    await query(
      `UPDATE task_projections
          SET metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{merged_pr_evidence}', $2::jsonb, true),
              updated_at = now()
        WHERE task_id = $1`,
      [taskId, JSON.stringify(plan.waiver)]
    );
  }
  const decision = await recordAgentDecision({
    kind: "review",
    taskId,
    boardId,
    decision: "reward",
    requestedRewardPft: requested,
    rewardPft,
    capsApplied: capCheck.capsApplied,
    reason: `Operator override (${operator}): ${reason}`,
    userFeedback: feedback,
    createdBy: `operator:${operator}`,
    metadata: { operator_override: true, mode, superseded_decision_id: pending?.id || "", cap_check: capCheck },
  });
  await appendBmAudit({
    actor: `operator:${operator}`,
    boardId,
    command: "operator-review-override",
    args: { taskId, mode, reason, requested },
    result: { decision_id: decision.id, reward_pft: rewardPft, superseded: pending?.id || "" },
  });
  console.log(JSON.stringify({ executed: true, decision_id: decision.id, status: decision.status, ...plan }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
}
