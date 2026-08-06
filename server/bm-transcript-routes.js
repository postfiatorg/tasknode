import { databaseEnabled, query } from "./db/pool.js";
import { DETERMINISTIC_BOARD_IDS, isDeterministicBoardId } from "./board-config.js";

function safeText(value = "", max = 600) {
  return String(value || "").trim().slice(0, max);
}

function publicAction(row = {}) {
  const args = row.args_json && typeof row.args_json === "object" ? row.args_json : {};
  const result = row.result_json && typeof row.result_json === "object" ? row.result_json : {};
  return {
    id: row.id,
    actor: row.actor,
    command: row.command,
    created_at: row.created_at,
    task_id: safeText(args.taskId, 120),
    decision: safeText(args.decision, 40),
    requested_pft: Number(args.requestedPft || 0) || null,
    clamped_pft: Number(result.clampedPft || 0) || null,
    reward_min: Number(args.rewardMin || 0) || null,
    reward_max: Number(args.rewardMax || 0) || null,
    need: safeText(args.need, 280),
    reason: safeText(args.reason, 280),
    caps_applied: Array.isArray(result.capsApplied) ? result.capsApplied.map((cap) => cap?.cap).filter(Boolean) : [],
    refused: result.refused === true,
    executed: result.executed === true,
    dry_run: args.execute === false,
  };
}

// Structured public feed for the Hive Brain control-room view (Gate F).
export async function handleBmFeedRoute({ json, req, res, url }) {
  if (url.pathname !== "/api/hive/bm-feed" || req.method !== "GET") return false;
  if (!databaseEnabled()) {
    json(res, 503, { ok: false, error: "database_not_configured" });
    return true;
  }
  const boardId = String(url.searchParams.get("board") || "").trim();
  if (!isDeterministicBoardId(boardId)) {
    json(res, 400, { ok: false, error: "unknown_board", boards: DETERMINISTIC_BOARD_IDS });
    return true;
  }
  const [boardRow, budgetRow, spendRow, actionRows, narrativeRow, liveness] = await Promise.all([
    query(`SELECT id, title, status, phase_label FROM network_projects WHERE id = $1`, [boardId]),
    query(
      `SELECT daily_budget_pft, per_task_cap_pft, per_user_7d_cap_pft
       FROM board_reward_budgets WHERE board_id = $1`,
      [boardId]
    ),
    query(
      `SELECT COALESCE(sum(reward_pft), 0) AS spent
       FROM board_reward_spend
       WHERE board_id = $1 AND created_at >= date_trunc('day', now())`,
      [boardId]
    ),
    query(
      `SELECT id, actor, command, args_json, result_json, created_at
       FROM bm_audit_log
       WHERE board_id = $1
       ORDER BY created_at DESC
       LIMIT 60`,
      [boardId]
    ),
    query(
      `SELECT summary, model, source, created_at
       FROM bm_activity_summaries
       WHERE board_id = $1
       ORDER BY created_at DESC LIMIT 3`,
      [boardId]
    ),
    query(
      `SELECT max(captured_at) AS last_seen FROM board_manager_transcripts WHERE board_id = $1`,
      [boardId]
    ),
  ]);
  const board = boardRow.rows[0] || null;
  if (!board) {
    json(res, 404, { ok: false, error: "board_not_found" });
    return true;
  }
  const budget = budgetRow.rows[0] || null;
  const spentToday = Number(spendRow.rows[0]?.spent || 0);
  const lastSeen = liveness.rows[0]?.last_seen || null;
  const online = lastSeen ? Date.now() - new Date(lastSeen).getTime() < 30 * 60 * 1000 : false;
  json(res, 200, {
    ok: true,
    board: { id: board.id, title: board.title, status: board.status, phase_label: board.phase_label },
    agent: { online, last_seen: lastSeen },
    budget: budget
      ? {
          daily_budget_pft: Number(budget.daily_budget_pft),
          per_task_cap_pft: Number(budget.per_task_cap_pft),
          per_user_7d_cap_pft: Number(budget.per_user_7d_cap_pft),
          spent_today_pft: spentToday,
        }
      : null,
    actions: actionRows.rows.map(publicAction),
    narratives: narrativeRow.rows,
  });
  return true;
}

// RETIRED from public serving (operator security ruling 2026-08-06): raw
// terminal output is a prompt-injection and secret-exposure surface. The
// mirror table remains for internal forensics; the public feed serves
// narrator summaries instead. Kept exported for potential admin tooling,
// but no longer registered as a route.
export async function handleBmTranscriptRoute({ json, req, res, url }) {
  if (url.pathname !== "/api/hive/bm-transcript" || req.method !== "GET") return false;
  if (!databaseEnabled()) {
    json(res, 503, { ok: false, error: "database_not_configured" });
    return true;
  }
  const boardId = String(url.searchParams.get("board") || "").trim();
  if (!isDeterministicBoardId(boardId)) {
    json(res, 400, { ok: false, error: "unknown_board", boards: DETERMINISTIC_BOARD_IDS });
    return true;
  }
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 1)));
  const result = await query(
    `SELECT id, board_id, session_name, seq, content, captured_at
     FROM board_manager_transcripts
     WHERE board_id = $1
     ORDER BY seq DESC
     LIMIT $2`,
    [boardId, limit]
  );
  json(res, 200, { ok: true, boardId, snapshots: result.rows });
  return true;
}
