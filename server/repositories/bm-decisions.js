// Board Manager v2 agent decisions and deterministic reward caps (Gate C).
//
// The board manager agent records decisions here; the authority reward
// publisher consumes them. `computeRewardCap` is the single clamp used at
// decision time and re-run at publication time, so the model is never the
// enforcement boundary.

import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function jsonValue(value) {
  return JSON.stringify(value ?? {});
}

export async function boardBudget(boardId) {
  const result = await query(
    `SELECT board_id, daily_budget_pft, per_task_cap_pft, per_user_7d_cap_pft
     FROM board_reward_budgets WHERE board_id = $1`,
    [boardId]
  );
  return result.rows[0] || null;
}

export async function boardSpendToday(boardId) {
  const result = await query(
    `SELECT COALESCE(sum(reward_pft), 0) AS spent
     FROM board_reward_spend
     WHERE board_id = $1 AND created_at >= date_trunc('day', now())`,
    [boardId]
  );
  return safeNumber(result.rows[0]?.spent, 0);
}

export async function userSpend7d({ boardId, accountId = "", walletAddress = "" }) {
  if (!accountId && !walletAddress) return 0;
  const result = await query(
    `SELECT COALESCE(sum(reward_pft), 0) AS spent
     FROM board_reward_spend
     WHERE board_id = $1
       AND created_at >= now() - interval '7 days'
       AND (($2::text <> '' AND account_id = $2) OR ($3::text <> '' AND wallet_address = $3))`,
    [boardId, accountId, walletAddress]
  );
  return safeNumber(result.rows[0]?.spent, 0);
}

// Deterministic clamp. Returns the allowed amount plus every cap that bit.
export async function computeRewardCap({
  boardId,
  accountId = "",
  walletAddress = "",
  requestedPft = 0,
}) {
  const requested = Math.max(0, safeNumber(requestedPft, 0));
  const budget = await boardBudget(boardId);
  if (!budget) {
    return {
      ok: false,
      refused: true,
      reason: "board_budget_missing",
      boardId,
      requestedPft: requested,
      allowedPft: 0,
      capsApplied: [{ cap: "board_budget_missing", limit: 0 }],
    };
  }
  const [spentToday, userSpent] = await Promise.all([
    boardSpendToday(boardId),
    userSpend7d({ boardId, accountId, walletAddress }),
  ]);
  const remainingDaily = Math.max(0, safeNumber(budget.daily_budget_pft) - spentToday);
  const remainingUser = Math.max(0, safeNumber(budget.per_user_7d_cap_pft) - userSpent);
  const perTask = safeNumber(budget.per_task_cap_pft);

  const capsApplied = [];
  let allowed = requested;
  if (allowed > perTask) {
    capsApplied.push({ cap: "per_task_cap_pft", limit: perTask });
    allowed = perTask;
  }
  if (allowed > remainingDaily) {
    capsApplied.push({ cap: "daily_budget_remaining_pft", limit: remainingDaily });
    allowed = remainingDaily;
  }
  if (allowed > remainingUser) {
    capsApplied.push({ cap: "per_user_7d_remaining_pft", limit: remainingUser });
    allowed = remainingUser;
  }
  allowed = Math.max(0, Math.round(allowed * 100) / 100);
  return {
    ok: true,
    refused: requested > 0 && allowed <= 0,
    boardId,
    requestedPft: requested,
    allowedPft: allowed,
    capsApplied,
    budget: {
      daily_budget_pft: safeNumber(budget.daily_budget_pft),
      per_task_cap_pft: perTask,
      per_user_7d_cap_pft: safeNumber(budget.per_user_7d_cap_pft),
      spent_today_pft: spentToday,
      user_spent_7d_pft: userSpent,
    },
  };
}

// Resolve which board a task belongs to through its generation lineage.
export async function boardForTask(taskId) {
  const id = safeText(taskId, 180);
  if (!id) return "";
  const result = await query(
    `SELECT a.project_id
     FROM network_task_allocations a
     WHERE a.generated_task_id = $1
     ORDER BY a.updated_at DESC
     LIMIT 1`,
    [id]
  );
  return safeText(result.rows[0]?.project_id, 180);
}

export async function recordAgentDecision({
  kind,
  taskId,
  boardId = "",
  decision = "",
  requestedRewardPft = 0,
  rewardPft = 0,
  capsApplied = [],
  reason = "",
  userFeedback = "",
  verificationAsk = "",
  verificationType = "",
  status = "pending",
  createdBy = "bm_cli",
  metadata = {},
}) {
  if (!useDatabase()) throw new Error("database_not_configured");
  const id = `bmdec_${randomUUID()}`;
  await query(
    `UPDATE bm_agent_decisions
     SET status = 'superseded', updated_at = now()
     WHERE task_id = $1 AND kind = $2 AND status = 'pending'`,
    [safeText(taskId, 180), safeText(kind, 40)]
  );
  const result = await query(
    `INSERT INTO bm_agent_decisions (
       id, kind, board_id, task_id, decision, requested_reward_pft, reward_pft,
       caps_applied_json, reason, user_feedback, verification_ask,
       verification_type, status, created_by, metadata_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15::jsonb)
     RETURNING *`,
    [
      id,
      safeText(kind, 40),
      safeText(boardId, 180),
      safeText(taskId, 180),
      safeText(decision, 80),
      safeNumber(requestedRewardPft),
      safeNumber(rewardPft),
      jsonValue(capsApplied),
      safeText(reason, 2000),
      safeText(userFeedback, 2000),
      safeText(verificationAsk, 4000),
      safeText(verificationType, 80),
      safeText(status, 40),
      safeText(createdBy, 180),
      jsonValue(metadata),
    ]
  );
  return result.rows[0];
}

export async function pendingAgentDecision({ taskId, kind }) {
  const result = await query(
    `SELECT * FROM bm_agent_decisions
     WHERE task_id = $1 AND kind = $2 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [safeText(taskId, 180), safeText(kind, 40)]
  );
  return result.rows[0] || null;
}

export async function markAgentDecisionConsumed({ decisionId, ref = {} }) {
  await query(
    `UPDATE bm_agent_decisions
     SET status = 'consumed', consumed_at = now(), consumed_ref_json = $2::jsonb,
         updated_at = now()
     WHERE id = $1`,
    [safeText(decisionId, 180), jsonValue(ref)]
  );
}

export async function recordBoardRewardSpend({
  boardId,
  taskId,
  accountId = "",
  walletAddress = "",
  rewardPft = 0,
  decisionId = "",
  decidedBy = "board_manager_agent",
}) {
  if (safeNumber(rewardPft) <= 0) return null;
  const result = await query(
    `INSERT INTO board_reward_spend (
       id, board_id, task_id, account_id, wallet_address, reward_pft,
       decision_id, decided_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (task_id) DO NOTHING
     RETURNING *`,
    [
      `bmspend_${randomUUID()}`,
      safeText(boardId, 180),
      safeText(taskId, 180),
      safeText(accountId, 180),
      safeText(walletAddress, 180),
      safeNumber(rewardPft),
      safeText(decisionId, 180),
      safeText(decidedBy, 180),
    ]
  );
  return result.rows[0] || null;
}

export async function appendBmAudit({
  actor = "board_manager_agent",
  boardId = "",
  command = "",
  args = {},
  result = {},
}) {
  if (!useDatabase()) return null;
  const inserted = await query(
    `INSERT INTO bm_audit_log (id, actor, board_id, command, args_json, result_json)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     RETURNING id, created_at`,
    [
      `bmaudit_${randomUUID()}`,
      safeText(actor, 180),
      safeText(boardId, 180),
      safeText(command, 120),
      jsonValue(args),
      jsonValue(result),
    ]
  );
  return inserted.rows[0] || null;
}

export function agentDecisionsEnabled(env = process.env) {
  return env.TASKNODE_TASK_REVIEW_AGENT_DECISIONS === "true";
}
