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
    // Repo drift is board state: new commits or new TODO markers in the
    // board's sources are routing raw material and wake the manager.
    source_heads: repoSourceLeads(board.metadata_json?.sources?.repos || []).map(
      (lead) => `${lead.repo}:${lead.head}:${lead.todo_count}`
    ),
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
    source_leads: repoSourceLeads(board.metadata_json?.sources?.repos || []),
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
      AND (
        SELECT count(*)
        FROM network_task_allocations a
        WHERE a.candidate_account_id = b.account_id
          AND a.allocation_status IN ('candidate', 'queued', 'proposed', 'accepted',
                                      'submitted', 'verification_requested',
                                      'verification_response_submitted')
      ) < COALESCE(
        (SELECT l.max_live_allocations FROM network_task_capacity_limits l
         WHERE l.account_id = b.account_id),
        1
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

// Mechanical source-lead mining (demand-side raw material). The issue
// tracker is nearly empty for these repos; the real backlog lives in
// TODO/FIXME markers and recent bug-shaped commits. This gives the manager
// concrete file:line leads to judge — it generates leads, never tasks.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const REPO_ROOT = process.env.BM_REPO_ROOT || "/home/pfrpc/repos";

function safeExec(cmd, args, { cwd, timeout = 8000 } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, timeout, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  } catch {
    return "";
  }
}

export function repoSourceLeads(repoNames = []) {
  const leads = [];
  for (const name of repoNames.slice(0, 4)) {
    const dir = `${REPO_ROOT}/${String(name).replace(/[^A-Za-z0-9._-]/g, "")}`;
    if (!existsSync(dir)) continue;
    const head = safeExec("git", ["-C", dir, "rev-parse", "--short", "HEAD"]).trim();
    const commits = safeExec("git", ["-C", dir, "log", "--oneline", "-8"])
      .split("\n").filter(Boolean);
    const todoOut = safeExec("rg", [
      "-n", "TODO|FIXME|HACK\\b|XXX\\b",
      "--glob", "!node_modules", "--glob", "!dist", "--glob", "!target",
      "--glob", "!*.lock", "-m", "2", "--max-columns", "160",
      ".",
    ], { cwd: dir, timeout: 15000 });
    const todoLines = todoOut.split("\n").filter(Boolean);
    leads.push({
      repo: name,
      checkout: dir,
      head,
      recent_commits: commits,
      todo_count: todoLines.length,
      todo_sample: todoLines.slice(0, 20),
    });
  }
  return leads;
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

// Deterministic per-round duty computation (the whip's work order). Every
// duty is derived from durable state, so two runs against the same state
// produce the same list and the same digest.
export async function computeBoardDuties(boardIds = []) {
  const duties = [];
  const idle = await idleEligibleContributors();

  for (const boardId of boardIds) {
    const board = await query(
      `SELECT id, title, updated_at FROM network_projects WHERE id = $1`,
      [boardId]
    );
    const boardRowData = board.rows[0];
    if (!boardRowData) continue;

    const tasks = await query(
      `SELECT tp.task_id, tp.status, tp.title, tp.last_event_at, tp.created_at
       FROM network_task_allocations a
       JOIN task_projections tp ON tp.task_id = a.generated_task_id
       WHERE a.project_id = $1 AND a.generated_task_id <> ''
         AND tp.status IN ('proposed','accepted','submitted','verification_requested','verification_response_submitted')`,
      [boardId]
    );
    const pending = await query(
      `SELECT task_id, kind FROM bm_agent_decisions
       WHERE board_id = $1 AND status = 'pending'`,
      [boardId]
    );
    const pendingByTask = new Map(pending.rows.map((row) => [`${row.task_id}:${row.kind}`, true]));

    for (const task of tasks.rows) {
      if (task.status === "verification_response_submitted" && !pendingByTask.has(`${task.task_id}:review`)) {
        duties.push({
          priority: 1,
          type: "review_due",
          board_id: boardId,
          task_id: task.task_id,
          detail: `Verification response awaiting your reward review: ${task.title}`,
        });
      }
      if (task.status === "submitted" && !pendingByTask.has(`${task.task_id}:verification_request`)) {
        duties.push({
          priority: 2,
          type: "verification_due",
          board_id: boardId,
          task_id: task.task_id,
          detail: `Submission awaiting your verification request: ${task.title}`,
        });
      }
      if (task.status === "proposed" && Date.now() - new Date(task.created_at).getTime() > 7 * 24 * 3600 * 1000) {
        duties.push({
          priority: 4,
          type: "stale_proposal",
          board_id: boardId,
          task_id: task.task_id,
          detail: `Proposed ${Math.floor((Date.now() - new Date(task.created_at).getTime()) / 86400000)}d ago, unaccepted — apply the staleness policy (cancel or journal why not): ${task.title}`,
        });
      }
    }

    const openCount = tasks.rows.filter((task) => ["proposed", "accepted"].includes(task.status)).length;
    const freeSlots = Math.max(0, 3 - openCount);
    if (freeSlots > 0 && idle.length > 0) {
      duties.push({
        priority: 3,
        type: "routing_due",
        board_id: boardId,
        detail: `${freeSlots} open-task slot(s) free. An eligible contributor without a task is a DEFICIENCY you must resolve this round. The COMPLETE routing pool (every member is routable when their badges fit this board — including operator accounts; operator escalation-only applies to decisions, never to work): ${idle
          .map((c) => `${c.account_id}[${(c.badges || []).join("/")},${c.rewarded_tasks} rewarded]`)
          .join("; ")}. For each pool member whose badges fit this board: route grounded work from the sources, OR route them a small investigation task (250-1,000 PFT) that produces the grounding — dig a named repo area, reproduce a suspected defect, or report on a concrete question whose answer creates future tasks. "Nothing routable" is not an acceptable outcome; if you truly cannot even frame an investigation for a member, journal that member by name with the specific reason.`,
      });
    }

    if (Date.now() - new Date(boardRowData.updated_at).getTime() > 24 * 3600 * 1000) {
      duties.push({
        priority: 5,
        type: "board_info_stale",
        board_id: boardId,
        detail: `Board info last updated ${Math.floor((Date.now() - new Date(boardRowData.updated_at).getTime()) / 3600000)}h ago (>24h) — refresh summary/phase via board-update.`,
      });
    }
  }

  duties.sort((left, right) => left.priority - right.priority || String(left.task_id || "").localeCompare(String(right.task_id || "")));
  const digest = sha256(duties.map((duty) => `${duty.type}:${duty.board_id}:${duty.task_id || ""}`).join("|"));
  return { generated_at: new Date().toISOString(), board_ids: boardIds, duties, digest };
}

export function formatDuties(result) {
  const lines = [];
  if (!result.duties.length) {
    lines.push("No mandatory duties this round. All boards current.");
  } else {
    lines.push(`MANDATORY DUTIES this round (${result.duties.length}), in priority order:`);
    result.duties.forEach((duty, index) => {
      lines.push(`${index + 1}. [${duty.type}] [${duty.board_id}]${duty.task_id ? ` [${duty.task_id}]` : ""} ${duty.detail}`);
    });
  }
  return lines.join("\n");
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
