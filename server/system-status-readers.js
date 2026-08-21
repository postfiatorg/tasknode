import { databaseEnabled, query } from "./db/pool.js";
import { canonicalRewardedTaskProjectionSql } from "./repositories/task-projection-integrity.js";
import { hour, iso, mergeStatus } from "./system-status-base.js";

export const DEFAULT_NETWORK_TASK_SPEND_DAYS = 30;
export const MAX_NETWORK_TASK_SPEND_DAYS = 90;
export const DEFAULT_BOARD_MANAGER_COST_DAYS = 30;
export const MAX_BOARD_MANAGER_COST_DAYS = 90;
export const recentFailureWindowMs = 24 * hour;
export const BOARD_MANAGER_MODEL_PRICING = Object.freeze({
  "z-ai/glm-5.2": { inputUsdPerMillion: 1.2, outputUsdPerMillion: 4.1 },
  "qwen/qwen3.7-max": { inputUsdPerMillion: 2.5, outputUsdPerMillion: 7.5 },
  "deepseek-v4-pro": { inputUsdPerMillion: 0.435, outputUsdPerMillion: 0.87 },
  "deepseek/deepseek-v4-pro": { inputUsdPerMillion: 0.435, outputUsdPerMillion: 0.87 },
  "gpt-5.5-pro": { inputUsdPerMillion: 15, outputUsdPerMillion: 120 },
});

export const recentFailureStatus = (status, count, label = "Recent failures") => (
  Number(count || 0) > 0 ? mergeStatus(status, { status: "warning", label }) : status
);

export function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export async function safeStatusRead(promise, fallback) {
  try {
    return await promise;
  } catch (error) {
    return typeof fallback === "function" ? fallback(error) : fallback;
  }
}

export function networkTaskSpendWindowDays(value = DEFAULT_NETWORK_TASK_SPEND_DAYS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_NETWORK_TASK_SPEND_DAYS;
  return Math.min(MAX_NETWORK_TASK_SPEND_DAYS, Math.max(1, Math.round(parsed)));
}

export function boardManagerCostWindowDays(value = DEFAULT_BOARD_MANAGER_COST_DAYS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BOARD_MANAGER_COST_DAYS;
  return Math.min(MAX_BOARD_MANAGER_COST_DAYS, Math.max(1, Math.round(parsed)));
}

export function normalizeNetworkTaskSpendRows(rows = []) {
  return rows.map((row) => ({
    date: String(row.date || "").slice(0, 10),
    totalPft: Number(row.total_pft || row.totalPft || 0),
    taskCount: Number(row.task_count || row.taskCount || 0),
  })).filter((row) => row.date);
}

export function networkTaskSpendUnavailable({ days = DEFAULT_NETWORK_TASK_SPEND_DAYS, reason = "query_failed" } = {}) {
  return {
    ok: false,
    enabled: false,
    reason,
    windowDays: networkTaskSpendWindowDays(days),
    rows: [],
    totals: { totalPft: 0, taskCount: 0 },
  };
}

export async function readNetworkTaskSpendByDay({
  tables = new Map(),
  days = DEFAULT_NETWORK_TASK_SPEND_DAYS,
  databaseReady = databaseEnabled(),
  queryImpl = query,
} = {}) {
  const windowDays = networkTaskSpendWindowDays(days);
  if (!databaseReady || tables.get("task_projections") !== true) {
    return {
      ok: true,
      enabled: false,
      windowDays,
      rows: [],
      totals: { totalPft: 0, taskCount: 0 },
    };
  }

  const result = await queryImpl(
    `WITH rewarded_network_tasks AS (
       SELECT
         (COALESCE(p.last_event_at, p.updated_at) AT TIME ZONE 'UTC')::date AS reward_day,
         p.reward_actual_pft::numeric AS reward_actual_pft
       FROM task_projections p
       WHERE p.status = 'rewarded'
         AND lower(COALESCE(NULLIF(p.task_kind, ''), p.metadata_json->'generatedTask'->>'task_kind', '')) = 'network'
         AND ${canonicalRewardedTaskProjectionSql("p")}
         AND (COALESCE(p.last_event_at, p.updated_at) AT TIME ZONE 'UTC')::date >=
             (timezone('UTC', now())::date - ($1::integer - 1))
     )
     SELECT
       reward_day::text AS date,
       COALESCE(sum(reward_actual_pft), 0)::text AS total_pft,
       count(*)::int AS task_count
     FROM rewarded_network_tasks
     GROUP BY reward_day
     ORDER BY reward_day DESC`,
    [windowDays]
  );
  const rows = normalizeNetworkTaskSpendRows(result.rows);
  return {
    ok: true,
    enabled: true,
    windowDays,
    rows,
    totals: {
      totalPft: rows.reduce((sum, row) => sum + row.totalPft, 0),
      taskCount: rows.reduce((sum, row) => sum + row.taskCount, 0),
    },
  };
}

export function boardManagerDailyCostUnavailable({ days = DEFAULT_BOARD_MANAGER_COST_DAYS, reason = "query_failed" } = {}) {
  return {
    ok: false,
    enabled: false,
    reason,
    windowDays: boardManagerCostWindowDays(days),
    rows: [],
    totals: { runs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  };
}

export function agentActivityUnavailable({ enabled = false, reason = "database_unavailable" } = {}) {
  return {
    ok: true,
    enabled,
    reason,
    summary: {
      agentCount: 0,
      activeAgentCount: 0,
      currentTaskCount: 0,
      recentActionCount: 0,
      rewardedTaskCount: 0,
      rewardActualPft: 0,
    },
    agents: [],
  };
}

export function normalizeAgentActivityRows({
  agents = [],
  tasks = [],
  actions = [],
} = {}) {
  const tasksByAgent = new Map();
  for (const row of tasks) {
    const agentId = safeText(row.agent_id, 180);
    if (!agentId) continue;
    const list = tasksByAgent.get(agentId) || [];
    list.push({
      taskId: safeText(row.task_id, 180),
      title: safeText(row.title, 220),
      status: safeText(row.status, 80),
      taskKind: safeText(row.task_kind, 80),
      rewardOfferPft: Number(row.reward_offer_pft || 0),
      rewardActualPft: Number(row.reward_actual_pft || 0),
      updatedAt: iso(row.updated_at),
    });
    tasksByAgent.set(agentId, list);
  }

  const actionsByAgent = new Map();
  for (const row of actions) {
    const agentId = safeText(row.agent_id, 180);
    if (!agentId) continue;
    const list = actionsByAgent.get(agentId) || [];
    list.push({
      action: safeText(row.task_action, 120),
      status: safeText(row.status, 80),
      outcomeStatus: safeText(row.outcome_status, 120),
      blocker: safeText(row.blocker, 160),
      taskId: safeText(row.source_task_id, 180),
      followupTaskId: safeText(row.followup_task_id, 180),
      txHash: safeText(row.tx_hash, 240),
      cid: safeText(row.event_cid, 240),
      createdAt: iso(row.created_at),
    });
    actionsByAgent.set(agentId, list);
  }

  const normalizedAgents = agents.map((row) => {
    const agentId = safeText(row.id, 180);
    const currentTasks = (tasksByAgent.get(agentId) || []).filter((task) => task.status !== "rewarded").slice(0, 5);
    const recentRewards = (tasksByAgent.get(agentId) || []).filter((task) => task.status === "rewarded").slice(0, 3);
    return {
      id: agentId,
      handle: safeText(row.handle, 120),
      agentId: safeText(row.agent_id, 180),
      role: safeText(row.role || "operator", 80) || "operator",
      status: safeText(row.status || "active", 80) || "active",
      active: row.active !== false,
      currentTask: currentTasks[0] || null,
      currentTasks,
      recentActions: (actionsByAgent.get(agentId) || []).slice(0, 5),
      rewards: {
        taskCount: Number(row.rewarded_task_count || 0),
        totalPft: Number(row.reward_actual_pft || 0),
        recent: recentRewards,
      },
      updatedAt: iso(row.updated_at),
    };
  });

  return {
    ok: true,
    enabled: true,
    reason: "available",
    summary: {
      agentCount: normalizedAgents.length,
      activeAgentCount: normalizedAgents.filter((agent) => agent.active).length,
      currentTaskCount: normalizedAgents.reduce((sum, agent) => sum + agent.currentTasks.length, 0),
      recentActionCount: normalizedAgents.reduce((sum, agent) => sum + agent.recentActions.length, 0),
      rewardedTaskCount: normalizedAgents.reduce((sum, agent) => sum + agent.rewards.taskCount, 0),
      rewardActualPft: normalizedAgents.reduce((sum, agent) => sum + agent.rewards.totalPft, 0),
    },
    agents: normalizedAgents,
  };
}

export async function readAgentActivity({
  tables = new Map(),
  databaseReady = databaseEnabled(),
  queryImpl = query,
  limit = 24,
} = {}) {
  const cappedLimit = Math.min(48, Math.max(1, Math.round(Number(limit) || 24)));
  if (!databaseReady) return agentActivityUnavailable({ reason: "database_disabled" });
  if (tables.get("orc_agents") !== true) return agentActivityUnavailable({ reason: "orc_agents_missing" });
  if (tables.get("task_projections") !== true) {
    return agentActivityUnavailable({ enabled: true, reason: "task_projections_missing" });
  }

  const agentsResult = await queryImpl(
    `SELECT
       agents.id,
       agents.handle,
       agents.agent_id,
       agents.role,
       agents.status,
       agents.active,
       agents.updated_at,
       count(p.task_id) FILTER (WHERE p.status = 'rewarded')::int AS rewarded_task_count,
       COALESCE(sum(p.reward_actual_pft) FILTER (WHERE p.status = 'rewarded'), 0)::text AS reward_actual_pft
     FROM (
       SELECT id, handle, agent_id, account_id, wallet_address, role, status, active, updated_at, created_at
       FROM orc_agents
       ORDER BY
         COALESCE(active, true) DESC,
         CASE WHEN lower(COALESCE(status, '')) IN ('active', 'idle', 'available') THEN 0 ELSE 1 END,
         COALESCE(updated_at, created_at) DESC,
         handle ASC
       LIMIT $1
     ) agents
     LEFT JOIN task_projections p
       ON (
         (agents.account_id <> '' AND p.account_id = agents.account_id) OR
         (agents.wallet_address <> '' AND p.subject_wallet = agents.wallet_address)
       )
       AND COALESCE(p.source, '') <> 'directory_polish_local_fixture'
       AND COALESCE(p.metadata_json->>'directoryPolishFixture', 'false') <> 'true'
     GROUP BY agents.id, agents.handle, agents.agent_id, agents.role, agents.status, agents.active, agents.updated_at, agents.created_at
     ORDER BY
       COALESCE(agents.active, true) DESC,
       CASE WHEN lower(COALESCE(agents.status, '')) IN ('active', 'idle', 'available') THEN 0 ELSE 1 END,
       COALESCE(agents.updated_at, agents.created_at) DESC,
       agents.handle ASC`,
    [cappedLimit]
  );

  const agents = agentsResult.rows;
  if (!agents.length) {
    return normalizeAgentActivityRows({ agents: [], tasks: [], actions: [] });
  }

  const [tasksResult, actionsResult] = await Promise.all([
    queryImpl(
      `WITH agents AS (
         SELECT id, account_id, wallet_address
         FROM orc_agents
         ORDER BY
           COALESCE(active, true) DESC,
           CASE WHEN lower(COALESCE(status, '')) IN ('active', 'idle', 'available') THEN 0 ELSE 1 END,
           COALESCE(updated_at, created_at) DESC,
           handle ASC
         LIMIT $1
       ),
       matched AS (
         SELECT
           agents.id AS agent_id,
           p.task_id,
           p.title,
           p.status,
           p.task_kind,
           p.reward_offer_pft::text AS reward_offer_pft,
           p.reward_actual_pft::text AS reward_actual_pft,
           p.updated_at,
           row_number() OVER (
             PARTITION BY agents.id, p.status = 'rewarded'
             ORDER BY p.updated_at DESC, p.task_id DESC
           ) AS rank
         FROM agents
         JOIN task_projections p
           ON (
             (agents.account_id <> '' AND p.account_id = agents.account_id) OR
             (agents.wallet_address <> '' AND p.subject_wallet = agents.wallet_address)
           )
          AND p.status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'reward_decided', 'rewarded')
          AND COALESCE(p.source, '') <> 'directory_polish_local_fixture'
          AND COALESCE(p.metadata_json->>'directoryPolishFixture', 'false') <> 'true'
       )
       SELECT *
       FROM matched
       WHERE rank <= CASE WHEN status = 'rewarded' THEN 3 ELSE 5 END
       ORDER BY agent_id ASC, status = 'rewarded' ASC, updated_at DESC`,
      [cappedLimit]
    ),
    tables.get("orc_work_journal") === true
      ? queryImpl(
        `WITH agents AS (
           SELECT id, handle, agent_id, account_id, wallet_address
           FROM orc_agents
           ORDER BY
             COALESCE(active, true) DESC,
             CASE WHEN lower(COALESCE(status, '')) IN ('active', 'idle', 'available') THEN 0 ELSE 1 END,
             COALESCE(updated_at, created_at) DESC,
             handle ASC
           LIMIT $1
         ),
         matched AS (
           SELECT
             agents.id AS agent_id,
             journal.task_action,
             journal.status,
             journal.outcome_status,
             journal.blocker,
             journal.source_task_id,
             journal.followup_task_id,
             journal.tx_hash,
             journal.event_cid,
             journal.created_at,
             row_number() OVER (
               PARTITION BY agents.id
               ORDER BY journal.created_at DESC, journal.id DESC
             ) AS rank
           FROM agents
           JOIN orc_work_journal journal
             ON lower(journal.operator_handle) = lower(agents.handle)
             OR lower(journal.operator_handle) = lower(agents.agent_id)
             OR lower(journal.operator_handle) = lower(agents.account_id)
             OR lower(journal.operator_handle) = lower(agents.wallet_address)
         )
         SELECT *
         FROM matched
         WHERE rank <= 5
         ORDER BY agent_id ASC, created_at DESC`,
        [cappedLimit]
      )
      : { rows: [] },
  ]);

  return normalizeAgentActivityRows({
    agents,
    tasks: tasksResult.rows,
    actions: actionsResult.rows,
  });
}

export function usageNumber(usage = {}, keys = []) {
  for (const key of keys) {
    const value = Number(usage?.[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

export function boardManagerUsageCostUsd({ usage = {}, model = "" } = {}) {
  const providerCost = usageNumber(usage, ["costUsd", "cost_usd", "cost"]);
  if (providerCost > 0) return providerCost;
  const pricing = BOARD_MANAGER_MODEL_PRICING[String(model || "").trim()];
  if (!pricing) return 0;
  const inputTokens = usageNumber(usage, ["inputTokens", "input_tokens", "prompt_tokens"]);
  const outputTokens = usageNumber(usage, ["outputTokens", "output_tokens", "completion_tokens"]);
  return (
    (inputTokens / 1_000_000) * pricing.inputUsdPerMillion
    + (outputTokens / 1_000_000) * pricing.outputUsdPerMillion
  );
}

export function roundCostUsd(value = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

export function normalizeBoardManagerCostRows(rows = []) {
  const byDate = new Map();
  for (const row of rows) {
    const occurredAt = row.occurred_at || row.created_at || row.completed_at;
    const parsedDate = occurredAt instanceof Date ? occurredAt : new Date(occurredAt || "");
    if (!Number.isFinite(parsedDate.getTime())) continue;
    const date = parsedDate.toISOString().slice(0, 10);
    const usage = row.usage_json && typeof row.usage_json === "object" ? row.usage_json : {};
    const inputTokens = usageNumber(usage, ["inputTokens", "input_tokens", "prompt_tokens"]);
    const outputTokens = usageNumber(usage, ["outputTokens", "output_tokens", "completion_tokens"]);
    const totalTokens = usageNumber(usage, ["totalTokens", "total_tokens", "total"]);
    const effectiveTotalTokens = totalTokens || inputTokens + outputTokens;
    const costUsd = boardManagerUsageCostUsd({ usage, model: row.model });
    if (inputTokens <= 0 && outputTokens <= 0 && effectiveTotalTokens <= 0 && costUsd <= 0) continue;
    const current = byDate.get(date) || {
      date,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    current.runs += 1;
    current.inputTokens += inputTokens;
    current.outputTokens += outputTokens;
    current.totalTokens += effectiveTotalTokens;
    current.costUsd += costUsd;
    byDate.set(date, current);
  }
  return [...byDate.values()]
    .map((row) => ({ ...row, costUsd: roundCostUsd(row.costUsd) }))
    .sort((left, right) => right.date.localeCompare(left.date));
}

export async function readBoardManagerDailyCost({
  tables = new Map(),
  days = DEFAULT_BOARD_MANAGER_COST_DAYS,
  databaseReady = databaseEnabled(),
  queryImpl = query,
} = {}) {
  const windowDays = boardManagerCostWindowDays(days);
  const hasRuns = tables.get("board_manager_runs") === true;
  const hasSecretaryPackets = tables.get("board_manager_secretary_packets") === true;
  if (!databaseReady || (!hasRuns && !hasSecretaryPackets)) {
    return {
      ok: true,
      enabled: false,
      windowDays,
      rows: [],
      totals: { runs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    };
  }

  const selects = [];
  if (hasRuns) {
    selects.push(
      `SELECT 'board_manager_run' AS source,
              COALESCE(completed_at, started_at, created_at) AS occurred_at,
              provider,
              model,
              usage_json
         FROM board_manager_runs
        WHERE status = 'completed'
          AND COALESCE(completed_at, started_at, created_at) >= now() - ($1::integer * interval '1 day')`
    );
  }
  if (hasSecretaryPackets) {
    selects.push(
      `SELECT 'board_manager_secretary_packet' AS source,
              created_at AS occurred_at,
              provider,
              model,
              usage_json
         FROM board_manager_secretary_packets
        WHERE status <> 'failed'
          AND created_at >= now() - ($1::integer * interval '1 day')`
    );
  }
  const result = await queryImpl(`${selects.join("\nUNION ALL\n")}\nORDER BY occurred_at DESC`, [windowDays]);
  const rows = normalizeBoardManagerCostRows(result.rows);
  return {
    ok: true,
    enabled: true,
    windowDays,
    rows,
    totals: {
      runs: rows.reduce((sum, row) => sum + row.runs, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
      costUsd: roundCostUsd(rows.reduce((sum, row) => sum + row.costUsd, 0)),
    },
  };
}
