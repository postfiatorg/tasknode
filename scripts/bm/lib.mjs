// Read-model queries for the `bm` board-manager CLI (Gate B).
//
// All queries are read-only. Write paths (task create, review, rewards)
// arrive in Gate C and go through server-side modules with cap enforcement.

import { createHash } from "node:crypto";
import { query } from "../../server/db/pool.js";
import { DETERMINISTIC_BOARD_IDS } from "../../server/board-config.js";

export const BOARD_ALIASES = Object.freeze({
  community: "board_community_promotion",
  promotion: "board_community_promotion",
  pfterminal: "board_pf_terminal",
  terminal: "board_pf_terminal",
  l1v2: "board_postfiat_l1v2",
  postfiatl1v2: "board_postfiat_l1v2",
  governance: "board_ai_l1_governance",
  ail1: "board_ai_l1_governance",
  tasknode: "board_tasknode_fixes",
  fixes: "board_tasknode_fixes",
  capital: "board_capital_markets",
  markets: "board_capital_markets",
});

export function resolveBoardId(input = "") {
  const text = String(input || "").trim().toLowerCase();
  if (!text) return "";
  if (DETERMINISTIC_BOARD_IDS.includes(text)) return text;
  return BOARD_ALIASES[text] || "";
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value), "utf8")
    .digest("hex");
}

async function boardRow(boardId) {
  const result = await query(
    `SELECT id, type, title, summary, objective, about, status, priority,
            phase_label, metadata_json, updated_at
     FROM network_projects WHERE id = $1`,
    [boardId]
  );
  return result.rows[0] || null;
}

async function allocationState(boardId) {
  const result = await query(
    `SELECT allocation_status, count(*)::int AS n, max(updated_at) AS last_updated
     FROM network_task_allocations
     WHERE project_id = $1
     GROUP BY allocation_status
     ORDER BY allocation_status`,
    [boardId]
  );
  return result.rows;
}

async function linkedTasks(boardId, { limit = 200 } = {}) {
  const result = await query(
    `SELECT tp.task_id, tp.status, tp.title, tp.account_id, tp.subject_wallet,
            tp.reward_offer_pft, tp.reward_actual_pft, tp.last_event_at, tp.updated_at,
            a.id AS allocation_id, a.allocation_status
     FROM network_task_allocations a
     JOIN task_projections tp ON tp.task_id = a.generated_task_id
     WHERE a.project_id = $1 AND a.generated_task_id <> ''
     ORDER BY tp.last_event_at DESC
     LIMIT $2`,
    [boardId, limit]
  );
  return result.rows;
}

async function latestSecretaryReport() {
  const result = await query(
    `SELECT id, output_text, created_at
     FROM hive_secretary_reports
     WHERE status = 'completed'
     ORDER BY created_at DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

export async function boardDigest(boardId) {
  const [board, allocations, tasks, secretary, decisions] = await Promise.all([
    boardRow(boardId),
    allocationState(boardId),
    linkedTasks(boardId, { limit: 500 }),
    latestSecretaryReport(),
    query(
      `SELECT id, status FROM bm_agent_decisions
       WHERE board_id = $1 AND status IN ('pending', 'superseded', 'refused')
       ORDER BY created_at DESC LIMIT 50`,
      [boardId]
    ).catch(() => ({ rows: [] })),
  ]);
  if (!board) return null;
  const source = {
    board_id: board.id,
    board_updated_at: String(board.updated_at),
    allocations: allocations.map((row) => ({
      status: row.allocation_status,
      n: row.n,
      last: String(row.last_updated),
    })),
    tasks: tasks.map((row) => ({ id: row.task_id, status: row.status, last: String(row.last_event_at) })),
    // Decision state is board state: a superseded or refused decision must
    // wake the manager through the normal whip channel.
    decisions: decisions.rows.map((row) => `${row.id}:${row.status}`),
    // Idle eligible capacity is board state: a badge-verified contributor
    // freeing their slot should wake the manager for a routing pass.
    idle_capacity: (await idleEligibleContributors()).map((c) => c.account_id).sort(),
    secretary_report_id: secretary?.id || "",
  };
  return { boardId: board.id, digest: sha256(source), source };
}

const awaitingReviewStates = new Set(["submitted", "verification_response_submitted"]);
const inVerificationStates = new Set(["verification_requested"]);
const openStates = new Set(["proposed", "accepted"]);
const terminalStates = new Set(["rewarded", "refused", "cancelled", "expired", "rejected"]);

export async function boardPacket(boardId) {
  const [board, allocations, tasks, secretary] = await Promise.all([
    boardRow(boardId),
    allocationState(boardId),
    linkedTasks(boardId, { limit: 200 }),
    latestSecretaryReport(),
  ]);
  if (!board) return null;
  const buckets = { awaiting_review: [], in_verification: [], open: [], recent_terminal: [] };
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const task of tasks) {
    if (awaitingReviewStates.has(task.status)) buckets.awaiting_review.push(task);
    else if (inVerificationStates.has(task.status)) buckets.in_verification.push(task);
    else if (openStates.has(task.status)) buckets.open.push(task);
    else if (terminalStates.has(task.status) && new Date(task.last_event_at).getTime() >= cutoff) {
      buckets.recent_terminal.push(task);
    }
  }
  return {
    board: {
      id: board.id,
      title: board.title,
      status: board.status,
      phase_label: board.phase_label,
      summary: board.summary,
      objective: board.objective,
      sources: board.metadata_json?.sources || {},
      evidence_norms: board.metadata_json?.evidence_norms || [],
      routing_constraints: board.metadata_json?.routing_constraints || {},
      updated_at: board.updated_at,
    },
    allocation_counts: allocations,
    tasks: buckets,
    hive_chat_digest: secretary
      ? { report_id: secretary.id, created_at: secretary.created_at, text: String(secretary.output_text || "").slice(0, 1500) }
      : null,
    budget: await boardBudgetStatus(boardId),
    pending_decisions: await pendingDecisions(boardId),
    idle_eligible_contributors: await idleEligibleContributors(),
  };
}

export async function boardBudgetStatus(boardId) {
  const budget = await query(
    `SELECT daily_budget_pft, per_task_cap_pft, per_user_7d_cap_pft
     FROM board_reward_budgets WHERE board_id = $1`,
    [boardId]
  );
  if (!budget.rows[0]) return { configured: false, note: "no board_reward_budgets row; run migrations" };
  const spent = await query(
    `SELECT COALESCE(sum(reward_pft), 0) AS today
     FROM board_reward_spend
     WHERE board_id = $1 AND created_at >= date_trunc('day', now())`,
    [boardId]
  );
  const row = budget.rows[0];
  const spentToday = Number(spent.rows[0]?.today || 0);
  return {
    configured: true,
    daily_budget_pft: Number(row.daily_budget_pft),
    per_task_cap_pft: Number(row.per_task_cap_pft),
    per_user_7d_cap_pft: Number(row.per_user_7d_cap_pft),
    spent_today_pft: spentToday,
    remaining_today_pft: Math.max(0, Number(row.daily_budget_pft) - spentToday),
  };
}

// Badge-verified contributors with free routing capacity and a real track
// record. This is the demand-side signal: idle eligible capacity is board
// state, so it appears in the packet and the digest, and freeing a slot
// wakes the manager.
export async function idleEligibleContributors() {
  const result = await query(
    `
    SELECT b.account_id,
           array_agg(DISTINCT b.badge_id ORDER BY b.badge_id) AS badges,
           COALESCE(hist.rewarded, 0) AS rewarded_tasks,
           hist.last_active
    FROM account_network_badges b
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE tp.status = 'rewarded')::int AS rewarded,
             max(tp.last_event_at) AS last_active
      FROM task_projections tp
      WHERE tp.account_id = b.account_id
    ) hist ON true
    WHERE b.status = 'verified'
      AND b.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM network_task_allocations a
        WHERE a.candidate_account_id = b.account_id
          AND a.allocation_status IN ('candidate', 'queued', 'proposed', 'accepted',
                                      'submitted', 'verification_requested',
                                      'verification_response_submitted')
      )
    GROUP BY b.account_id, hist.rewarded, hist.last_active
    ORDER BY COALESCE(hist.rewarded, 0) DESC
    LIMIT 12
    `
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({
    account_id: row.account_id,
    badges: row.badges || [],
    rewarded_tasks: Number(row.rewarded_tasks || 0),
    last_active: row.last_active,
  }));
}

async function pendingDecisions(boardId) {
  const result = await query(
    `SELECT id, kind, task_id, decision, reward_pft, status, created_at
     FROM bm_agent_decisions
     WHERE board_id = $1 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 50`,
    [boardId]
  ).catch(() => ({ rows: [] }));
  return result.rows;
}

export async function userPacket(accountOrWallet, { limit = 20 } = {}) {
  const needle = String(accountOrWallet || "").trim();
  if (!needle) return null;
  const summary = await query(
    `SELECT status, count(*)::int AS n,
            COALESCE(sum(reward_actual_pft), 0) AS reward_pft
     FROM task_projections
     WHERE account_id = $1 OR subject_wallet = $1
     GROUP BY status ORDER BY status`,
    [needle]
  );
  const recent = await query(
    `SELECT task_id, status, title, task_kind, reward_offer_pft, reward_actual_pft,
            account_id, subject_wallet, last_event_at
     FROM task_projections
     WHERE account_id = $1 OR subject_wallet = $1
     ORDER BY last_event_at DESC
     LIMIT $2`,
    [needle, limit]
  );
  const accountIds = [...new Set(recent.rows.map((row) => row.account_id).filter(Boolean))];
  if (!accountIds.length && needle) accountIds.push(needle);
  const badges = accountIds.length
    ? await query(
        `SELECT account_id, badge_id, status, verified_by_operator, expires_at, revoked_at
         FROM account_network_badges
         WHERE account_id = ANY($1)
         ORDER BY account_id, badge_id`,
        [accountIds]
      )
    : { rows: [] };
  const totals = summary.rows.reduce(
    (acc, row) => {
      acc.tasks += row.n;
      acc.reward_pft += Number(row.reward_pft || 0);
      return acc;
    },
    { tasks: 0, reward_pft: 0 }
  );
  return {
    query: needle,
    totals,
    by_status: summary.rows,
    recent_tasks: recent.rows,
    badges: badges.rows,
  };
}

export async function boardHistory(boardId, { limit = 30 } = {}) {
  const result = await query(
    `SELECT tp.task_id, tp.status, tp.title, tp.account_id, tp.subject_wallet,
            tp.reward_actual_pft, tp.last_event_at
     FROM network_task_allocations a
     JOIN task_projections tp ON tp.task_id = a.generated_task_id
     WHERE a.project_id = $1 AND a.generated_task_id <> ''
       AND tp.status IN ('rewarded', 'refused', 'cancelled', 'expired', 'rejected')
     ORDER BY tp.last_event_at DESC
     LIMIT $2`,
    [boardId, limit]
  );
  return { boardId, completions: result.rows };
}
