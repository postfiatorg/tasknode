import { databaseEnabled, databaseStatus, query } from "./db/pool.js";
import { ethereumDepositConfigStatus } from "./ethereum-deposits.js";
import {
  jobsEffectiveEmbeddingModel,
  jobsEmbeddingDimensions,
  jobsEmbeddingModel,
  jobsEmbeddingProvider,
} from "./embedding-provider.js";
import { canonicalRewardedTaskProjectionSql } from "./repositories/task-projection-integrity.js";
import {
  boolEnv,
  countsFromRows,
  endpointList,
  hour,
  intEnv,
  iso,
  item,
  mergeStatus,
  minute,
  oldestAgeMs,
  optionalQuery,
  runFreshness,
  summarizeCategories,
  tableMap,
} from "./system-status-base.js";
import { chatPricingStatus } from "./model-pricing-status.js";

const recentFailureWindowMs = 24 * hour;
const DEFAULT_NETWORK_TASK_SPEND_DAYS = 30;
const MAX_NETWORK_TASK_SPEND_DAYS = 90;
const DEFAULT_BOARD_MANAGER_COST_DAYS = 30;
const MAX_BOARD_MANAGER_COST_DAYS = 90;
const BOARD_MANAGER_MODEL_PRICING = Object.freeze({
  "z-ai/glm-5.2": { inputUsdPerMillion: 1.2, outputUsdPerMillion: 4.1 },
  "qwen/qwen3.7-max": { inputUsdPerMillion: 2.5, outputUsdPerMillion: 7.5 },
  "deepseek-v4-pro": { inputUsdPerMillion: 0.435, outputUsdPerMillion: 0.87 },
  "deepseek/deepseek-v4-pro": { inputUsdPerMillion: 0.435, outputUsdPerMillion: 0.87 },
  "gpt-5.5-pro": { inputUsdPerMillion: 15, outputUsdPerMillion: 120 },
});

const recentFailureStatus = (status, count, label = "Recent failures") => (
  Number(count || 0) > 0 ? mergeStatus(status, { status: "warning", label }) : status
);

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
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

function normalizeNetworkTaskSpendRows(rows = []) {
  return rows.map((row) => ({
    date: String(row.date || "").slice(0, 10),
    totalPft: Number(row.total_pft || row.totalPft || 0),
    taskCount: Number(row.task_count || row.taskCount || 0),
  })).filter((row) => row.date);
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

function agentActivityUnavailable({ enabled = false, reason = "database_unavailable" } = {}) {
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

function normalizeAgentActivityRows({
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
           SELECT id, handle, agent_id
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

function usageNumber(usage = {}, keys = []) {
  for (const key of keys) {
    const value = Number(usage?.[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function boardManagerUsageCostUsd({ usage = {}, model = "" } = {}) {
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

function roundCostUsd(value = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

function normalizeBoardManagerCostRows(rows = []) {
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

async function boardManagerItem(tables, nowMs) {
  const cadenceFallback = intEnv(process.env.TASKNODE_BOARD_MANAGER_CADENCE_SECONDS, 300, { min: 60, max: 86400 });
  const [scopeResult, runResult, successResult, jobResult, leaseResult] = await Promise.all([
    optionalQuery(
      tables,
      ["board_manager_scopes"],
      `SELECT scope, status, cadence_seconds, max_actions_per_hour, next_run_at, last_enqueued_at,
              last_run_id, metadata_json, updated_at
         FROM board_manager_scopes
        WHERE scope = 'global_hive'
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      ["board_manager_runs"],
      `SELECT id, status, selected_action, trigger, error, started_at, completed_at
         FROM board_manager_runs
        WHERE scope = 'global_hive'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      ["board_manager_runs"],
      `SELECT id, status, selected_action, trigger, error, started_at, completed_at
         FROM board_manager_runs
        WHERE scope = 'global_hive'
          AND status = 'completed'
        ORDER BY completed_at DESC NULLS LAST, started_at DESC, id DESC
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      ["board_manager_jobs"],
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed
         FROM board_manager_jobs
        WHERE scope = 'global_hive'
        GROUP BY status`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["board_manager_leases"],
      `SELECT status, manager_id, owner_instance, heartbeat_at, expires_at, updated_at
         FROM board_manager_leases
        WHERE scope = 'global_hive'
        ORDER BY updated_at DESC
        LIMIT 1`
    ),
  ]);
  const scope = scopeResult.rows[0] || null;
  const run = runResult.rows[0] || null;
  const successRun = successResult.rows[0] || null;
  const lease = leaseResult.rows[0] || null;
  const counts = countsFromRows(jobResult.rows);
  const cadenceSeconds = Number(scope?.cadence_seconds || cadenceFallback);
  const lastSuccessAt = successRun?.completed_at || null;
  const freshness = runFreshness({
    enabled: true,
    lastSuccessAt,
    warningAfterMs: cadenceSeconds * 1000 + 5 * minute,
    staleAfterMs: cadenceSeconds * 2000 + 5 * minute,
    nowMs,
    missingStatus: "critical",
  });
  let status = freshness;
  if (!scope) status = { status: "critical", label: "Scope missing" };
  else if (scope.status !== "enabled") status = { status: "critical", label: scope.status === "paused" ? "Paused" : "Not enabled" };
  if (run?.status === "running") {
    const runningMs = oldestAgeMs(run.started_at, nowMs);
    status = runningMs > cadenceSeconds * 2000 + 5 * minute
      ? { status: "critical", label: "Run stale" }
      : { status: "ok", label: "Running" };
  }
  if (run?.status === "failed") status = { status: "critical", label: "Last run failed" };
  const recentFailed = jobResult.rows.reduce((sum, row) => sum + Number(row.recent_failed || 0), 0);
  status = recentFailureStatus(status, recentFailed, "Recent failed jobs");
  return item({
    id: "board_manager",
    category: "hive",
    title: "Hive Mind Board Agent",
    description: "Leased Board Manager scheduler for Hive decisions and action hooks.",
    owner: "board-manager process",
    trigger: "periodic tick and post-action follow-up",
    cadence: scope ? `${cadenceSeconds}s` : `${cadenceFallback}s`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: run?.completed_at || run?.started_at || scope?.updated_at,
    lastSuccessAt,
    nextRunAt: scope?.next_run_at,
    staleAfterMs: cadenceSeconds * 2000 + 5 * minute,
    counts,
    lastError: run?.error || "",
    details: [
      scope && `scope=${scope.scope} ${scope.status}`,
      scope && `maxActionsPerHour=${scope.max_actions_per_hour}`,
      scope?.last_run_id && `lastRunId=${scope.last_run_id}`,
      run?.id && `latestRun=${run.id} ${run.status}${run.selected_action ? ` action=${run.selected_action}` : ""}`,
      lease && `lease=${lease.status}${lease.owner_instance ? ` owner=${lease.owner_instance}` : ""}`,
    ],
  });
}

async function boardManagerSecretaryPacketItem(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["board_manager_secretary_packets"],
    `SELECT id, status, packet_type, provider, model, created_at, superseded_at, error
       FROM board_manager_secretary_packets
      WHERE scope = 'global_hive'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`
  );
  const counts = await optionalQuery(
    tables,
    ["board_manager_secretary_packets"],
    `SELECT status, count(*)::int AS count
       FROM board_manager_secretary_packets
      WHERE scope = 'global_hive'
      GROUP BY status`
  );
  const row = result.rows[0] || null;
  const status = !row
    ? { status: "unknown", label: "No packet data" }
    : row.status === "failed"
      ? { status: "critical", label: "Last packet failed" }
      : { status: "ok", label: "Current packet" };
  return item({
    id: "board_manager_secretary_packets",
    category: "hive",
    title: "Board Manager Secretary Packet",
    description: "DeepSeek compression packet used before GLM 5.2 Board Manager decisions.",
    owner: "board-manager process",
    trigger: "inside Board Manager run",
    cadence: "board-manager dependent",
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.created_at,
    lastSuccessAt: row?.status === "failed" ? null : row?.created_at,
    staleAfterMs: 6 * hour,
    counts: countsFromRows(counts.rows),
    lastError: row?.error || "",
    details: [
      row?.id && `packet=${row.id}`,
      row?.packet_type && `type=${row.packet_type}`,
      row?.provider && `provider=${row.provider}`,
      row?.model && `model=${row.model}`,
    ],
  });
}

async function hiveQueueItem({
  tables,
  id,
  title,
  description,
  owner,
  enabled = true,
  jobTable,
  resultTable,
  resultTimeColumn,
  resultIdColumn = "id",
  trigger,
  cadence,
  staleQueueMs = 15 * minute,
  staleResultMs = null,
  nowMs,
}) {
  const [latest, counts, oldestDue] = await Promise.all([
    optionalQuery(
      tables,
      [resultTable],
      `SELECT ${resultIdColumn} AS id, status, ${resultTimeColumn} AS completed_at, created_at
         FROM ${resultTable}
        WHERE status = 'completed'
        ORDER BY ${resultTimeColumn} DESC NULLS LAST, created_at DESC, ${resultIdColumn} DESC
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      [jobTable],
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed
         FROM ${jobTable}
        GROUP BY status`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      [jobTable],
      `SELECT min(COALESCE(next_attempt_at, updated_at, created_at)) AS oldest_due
         FROM ${jobTable}
        WHERE status IN ('pending', 'processing')
          AND COALESCE(next_attempt_at, updated_at, created_at) <= now()`
    ),
  ]);
  const row = latest.rows[0] || null;
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({
    enabled,
    lastSuccessAt: row?.completed_at,
    warningAfterMs: staleResultMs ? staleResultMs / 2 : null,
    staleAfterMs: staleResultMs,
    nowMs,
  });
  const recentFailed = counts.rows.reduce((sum, row) => sum + Number(row.recent_failed || 0), 0);
  status = recentFailureStatus(status, recentFailed, "Recent failed jobs");
  const oldest = iso(oldestDue.rows[0]?.oldest_due);
  if (oldest && oldestAgeMs(oldest, nowMs) > staleQueueMs) status = { status: "critical", label: "Queue stale" };
  return item({
    id,
    category: "hive",
    title,
    description,
    owner,
    trigger,
    cadence,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.created_at,
    lastSuccessAt: row?.completed_at,
    staleAfterMs: staleResultMs,
    counts: queueCounts,
    details: [
      row?.id && `latest=${row.id}`,
      oldest && `oldestDue=${oldest}`,
    ],
  });
}

async function taskGenerationItem(tables, nowMs) {
  const [summary, counts] = await Promise.all([
    optionalQuery(
      tables,
      ["task_requests"],
      `SELECT max(worker_completed_at) AS last_completed_at,
              max(updated_at) AS last_seen_at,
              min(updated_at) FILTER (WHERE status IN ('published','queued','generating')) AS oldest_pending_at,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed,
              max(last_error) FILTER (WHERE status = 'failed' AND last_error <> '') AS last_error
         FROM task_requests`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["task_requests"],
      `SELECT status, count(*)::int AS count
         FROM task_requests
        GROUP BY status`
    ),
  ]);
  const row = summary.rows[0] || {};
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({
    enabled: boolEnv(process.env.TASKNODE_TASK_GENERATION_WORKER_ENABLED),
    lastSuccessAt: row.last_completed_at,
    warningAfterMs: null,
    staleAfterMs: null,
    nowMs,
  });
  status = recentFailureStatus(status, row.recent_failed, "Recent failed requests");
  const oldest = iso(row.oldest_pending_at);
  if (oldest && oldestAgeMs(oldest, nowMs) > 10 * minute) status = { status: "critical", label: "Generation queue stale" };
  return item({
    id: "task_generation",
    category: "task_engine",
    title: "Task Generation Worker",
    description: "Turns signed task request rows into PFTL task offers.",
    owner: "worker process",
    trigger: "task request queue",
    cadence: `${intEnv(process.env.TASKNODE_TASK_GENERATION_WORKER_INTERVAL_MS, 5000, { min: 1000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row.last_completed_at || row.last_seen_at,
    lastSuccessAt: row.last_completed_at,
    counts: queueCounts,
    lastError: row.last_error || "",
    details: [oldest && `oldestPending=${oldest}`],
  });
}

async function networkTaskGenerationItem(tables, nowMs) {
  const [summary, counts] = await Promise.all([
    optionalQuery(
      tables,
      ["network_task_generation_jobs"],
      `SELECT max(updated_at) FILTER (WHERE status IN ('generated','published')) AS last_completed_at,
              max(updated_at) AS last_seen_at,
              min(COALESCE(next_attempt_at, updated_at, created_at)) FILTER (WHERE status IN ('queued','running')) AS oldest_pending_at,
              count(*) FILTER (WHERE status IN ('failed','link_failed') AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed,
              max(last_error) FILTER (WHERE status IN ('failed','link_failed') AND last_error <> '') AS last_error
         FROM network_task_generation_jobs`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["network_task_generation_jobs"],
      `SELECT status, count(*)::int AS count
         FROM network_task_generation_jobs
        GROUP BY status`
    ),
  ]);
  const row = summary.rows[0] || {};
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({
    enabled: boolEnv(process.env.TASKNODE_NETWORK_TASK_GENERATION_WORKER_ENABLED),
    lastSuccessAt: row.last_completed_at,
    nowMs,
  });
  status = recentFailureStatus(status, row.recent_failed, "Recent failed jobs");
  const oldest = iso(row.oldest_pending_at);
  if (oldest && oldestAgeMs(oldest, nowMs) > 10 * minute) status = { status: "critical", label: "Network generation stale" };
  return item({
    id: "network_task_generation",
    category: "task_engine",
    title: "Network Task Generation Worker",
    description: "Turns Board Manager allocations into normal task request bundles.",
    owner: "worker process",
    trigger: "network_task_generation_jobs",
    cadence: `${intEnv(process.env.TASKNODE_NETWORK_TASK_GENERATION_WORKER_INTERVAL_MS, 15000, { min: 1000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row.last_completed_at || row.last_seen_at,
    lastSuccessAt: row.last_completed_at,
    counts: queueCounts,
    lastError: row.last_error || "",
    details: [oldest && `oldestPending=${oldest}`],
  });
}

async function taskReviewItem(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["task_projections"],
    `SELECT count(*) FILTER (WHERE status = 'submitted')::int AS submitted,
            count(*) FILTER (WHERE status = 'verification_response_submitted')::int AS verification_response_submitted,
            max(updated_at) FILTER (
              WHERE status IN ('verification_requested','reward_decided','rewarded')
            ) AS last_completed_at,
            max(updated_at) AS last_seen_at,
            min(updated_at) FILTER (
              WHERE status IN ('submitted','verification_response_submitted')
            ) AS oldest_pending_at
       FROM task_projections`
  );
  const row = result.rows[0] || {};
  const counts = {
    submitted: Number(row.submitted || 0),
    verification_response_submitted: Number(row.verification_response_submitted || 0),
  };
  let status = runFreshness({
    enabled: boolEnv(process.env.TASKNODE_TASK_REVIEW_WORKER_ENABLED),
    lastSuccessAt: row.last_completed_at,
    nowMs,
  });
  const oldest = iso(row.oldest_pending_at);
  if (oldest && oldestAgeMs(oldest, nowMs) > 15 * minute) status = { status: "critical", label: "Review queue stale" };
  return item({
    id: "task_review",
    category: "task_engine",
    title: "Task Review And Reward Worker",
    description: "Publishes verification requests and terminal reward outcomes.",
    owner: "worker process",
    trigger: "submitted task projections",
    cadence: `${intEnv(process.env.TASKNODE_TASK_REVIEW_WORKER_INTERVAL_MS, 20000, { min: 1000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row.last_completed_at || row.last_seen_at,
    lastSuccessAt: row.last_completed_at,
    counts,
    details: [oldest && `oldestPending=${oldest}`],
  });
}

async function pftlSyncItems(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["pftl_sync_wallets"],
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status <> 'active')::int AS inactive,
            count(*) FILTER (WHERE status = 'active' AND last_error IS NOT NULL AND last_error <> '')::int AS error_count,
            count(*) FILTER (
              WHERE status = 'active'
                AND (last_hot_sync_at IS NULL OR last_hot_sync_at < now() - ($1 * interval '1 millisecond'))
            )::int AS hot_stale,
            count(*) FILTER (
              WHERE status = 'active'
                AND (last_hot_sync_at IS NULL OR last_hot_sync_at < now() - ($3 * interval '1 millisecond'))
            )::int AS hot_severely_stale,
            count(*) FILTER (
              WHERE status = 'active'
                AND COALESCE(archive_marker @> '{"complete": true}'::jsonb, false) = false
                AND (last_archive_sync_at IS NULL OR last_archive_sync_at < now() - ($2 * interval '1 millisecond'))
            )::int AS archive_stale,
            max(last_hot_sync_at) AS last_hot_sync_at,
            max(last_archive_sync_at) AS last_archive_sync_at,
            max(updated_at) AS last_seen_at,
            max(last_error) FILTER (WHERE last_error IS NOT NULL AND last_error <> '') AS last_error
       FROM pftl_sync_wallets`,
    [
      intEnv(process.env.PFTL_CACHE_HOT_STALE_MS, 120000, { min: 10000 }),
      intEnv(process.env.PFTL_CACHE_ARCHIVE_STALE_MS, 900000, { min: 60000 }),
      intEnv(process.env.PFTL_CACHE_HOT_STALE_MS, 120000, { min: 10000 }) * 3,
    ]
  );
  const row = result.rows[0] || {};
  const hotStaleMs = intEnv(process.env.PFTL_CACHE_HOT_STALE_MS, 120000, { min: 10000 });
  const archiveStaleMs = intEnv(process.env.PFTL_CACHE_ARCHIVE_STALE_MS, 900000, { min: 60000 });
  const hotFreshness = runFreshness({
    enabled: boolEnv(process.env.PFTL_CACHE_WORKER_ENABLED),
    lastSuccessAt: row.last_hot_sync_at,
    warningAfterMs: hotStaleMs,
    staleAfterMs: hotStaleMs * 3,
    nowMs,
  });
  const archiveEnabled = boolEnv(process.env.PFTL_CACHE_ARCHIVE_WORKER_ENABLED);
  const archiveFreshness = archiveEnabled && Number(row.archive_stale || 0) === 0 && (Number(row.active || 0) > 0 || row.last_archive_sync_at)
    ? { status: "ok", label: "Archive complete" }
    : runFreshness({
      enabled: archiveEnabled,
      lastSuccessAt: row.last_archive_sync_at,
      warningAfterMs: archiveStaleMs,
      staleAfterMs: archiveStaleMs * 3,
      nowMs,
    });
  const hotStatus = Number(row.hot_severely_stale || 0) > 0 ? mergeStatus(hotFreshness, { status: "warning", label: "Stale wallets" }) : hotFreshness;
  const archiveStatus = Number(row.archive_stale || 0) > 0 ? mergeStatus(archiveFreshness, { status: "warning", label: "Archive lag" }) : archiveFreshness;
  const counts = {
    active: Number(row.active || 0),
    inactive: Number(row.inactive || 0),
    errors: Number(row.error_count || 0),
  };
  return [
    item({
      id: "pftl_hot_sync",
      category: "pftl",
      title: "PFTL Hot Wallet Sync",
      description: "Polls current PFTL account transactions for active wallets.",
      owner: "worker process",
      trigger: "active wallet due list",
      cadence: `${intEnv(process.env.PFTL_CACHE_WORKER_INTERVAL_MS, 60000, { min: 1000 })}ms`,
      status: counts.errors > 0 ? mergeStatus(hotStatus, { status: "warning", label: "Wallet errors" }).status : hotStatus.status,
      statusLabel: counts.errors > 0 ? mergeStatus(hotStatus, { status: "warning", label: "Wallet errors" }).label : hotStatus.label,
      lastRunAt: row.last_hot_sync_at || row.last_seen_at,
      lastSuccessAt: row.last_hot_sync_at,
      staleAfterMs: hotStaleMs * 3,
      counts: { ...counts, hot_stale: Number(row.hot_stale || 0), hot_severely_stale: Number(row.hot_severely_stale || 0) },
      lastError: row.last_error || "",
    }),
    item({
      id: "pftl_archive_sync",
      category: "pftl",
      title: "PFTL Archive Wallet Sync",
      description: "Backfills historical account_tx pages through the archive-capable PFTL history path.",
      owner: "worker process",
      trigger: "archive-incomplete wallet due list",
      cadence: `${intEnv(process.env.PFTL_CACHE_ARCHIVE_WORKER_INTERVAL_MS, 300000, { min: 1000 })}ms`,
      status: archiveStatus.status,
      statusLabel: archiveStatus.label,
      lastRunAt: row.last_archive_sync_at || row.last_seen_at,
      lastSuccessAt: row.last_archive_sync_at,
      staleAfterMs: archiveStaleMs * 3,
      counts: { ...counts, archive_stale: Number(row.archive_stale || 0) },
      lastError: row.last_error || "",
    }),
  ];
}

async function pftlWatcherItem(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["pftl_cache_watcher_state"],
    `SELECT id, status, subscribed_wallet_count, last_ledger_index, last_event_at, last_error, updated_at
       FROM pftl_cache_watcher_state
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`
  );
  const row = result.rows[0] || null;
  let status = runFreshness({
    enabled: boolEnv(process.env.PFTL_CACHE_WSS_WATCHER_ENABLED),
    lastSuccessAt: row?.updated_at,
    warningAfterMs: 2 * minute,
    staleAfterMs: 5 * minute,
    nowMs,
  });
  if (row?.status && row.status !== "connected") status = { status: "warning", label: row.status };
  if (row?.last_error) status = { status: "critical", label: "Watcher error" };
  return item({
    id: "pftl_wss_watcher",
    category: "pftl",
    title: "PFTL WSS Watcher",
    description: "Subscribes to websocket ledger events and queues reducer work.",
    owner: "worker process",
    trigger: "PFTL websocket subscription",
    cadence: "continuous",
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.updated_at,
    lastSuccessAt: row?.status === "connected" ? row.updated_at : null,
    staleAfterMs: 5 * minute,
    counts: { subscribed_wallets: Number(row?.subscribed_wallet_count || 0) },
    lastError: row?.last_error || "",
    details: [
      row?.last_ledger_index && `lastLedger=${row.last_ledger_index}`,
      row?.last_event_at && `lastEventAt=${iso(row.last_event_at)}`,
    ],
  });
}

async function pftlReducerItem(tables, nowMs) {
  const [summary, counts] = await Promise.all([
    optionalQuery(
      tables,
      ["pftl_cache_reducer_events"],
      `SELECT max(processed_at) FILTER (WHERE status = 'completed') AS last_completed_at,
              max(updated_at) AS last_seen_at,
              min(available_at) FILTER (WHERE status IN ('pending','processing')) AS oldest_pending_at,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed,
              max(last_error) FILTER (WHERE status = 'failed' AND last_error <> '') AS last_error
         FROM pftl_cache_reducer_events`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["pftl_cache_reducer_events"],
      `SELECT status, count(*)::int AS count
         FROM pftl_cache_reducer_events
        GROUP BY status`
    ),
  ]);
  const row = summary.rows[0] || {};
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({
    enabled: boolEnv(process.env.PFTL_CACHE_REDUCER_WORKER_ENABLED),
    lastSuccessAt: row.last_completed_at,
    nowMs,
  });
  if (Number(row.recent_failed || 0) > 0) status = { status: "critical", label: "Recent reducer failures" };
  const oldest = iso(row.oldest_pending_at);
  if (oldest && oldestAgeMs(oldest, nowMs) > 10 * minute) status = { status: "critical", label: "Reducer queue stale" };
  return item({
    id: "pftl_cache_reducer",
    category: "pftl",
    title: "PFTL Cache Reducer",
    description: "Projects cached pointer events into context and task read models.",
    owner: "worker process",
    trigger: "pftl_cache_reducer_events",
    cadence: `${intEnv(process.env.PFTL_CACHE_REDUCER_WORKER_INTERVAL_MS, 10000, { min: 1000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row.last_completed_at || row.last_seen_at,
    lastSuccessAt: row.last_completed_at,
    counts: queueCounts,
    lastError: row.last_error || "",
    details: [oldest && `oldestPending=${oldest}`],
  });
}

async function pftlRetentionItem(tables, nowMs) {
  const result = await optionalQuery(
    tables,
    ["pftl_cache_maintenance_runs"],
    `SELECT id, run_kind, status, last_error, started_at, completed_at
       FROM pftl_cache_maintenance_runs
      WHERE run_kind IN ('retention','retention_dry_run')
      ORDER BY started_at DESC, id DESC
      LIMIT 1`
  );
  const row = result.rows[0] || null;
  let status = runFreshness({
    enabled: boolEnv(process.env.PFTL_CACHE_RETENTION_WORKER_ENABLED),
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    warningAfterMs: 12 * hour,
    staleAfterMs: 24 * hour,
    nowMs,
  });
  if (row?.status === "failed") status = { status: "critical", label: "Retention failed" };
  return item({
    id: "pftl_cache_retention",
    category: "pftl",
    title: "PFTL Cache Retention",
    description: "Prunes completed reducer events and optional raw transaction rows.",
    owner: "worker process",
    trigger: "interval timer",
    cadence: `${intEnv(process.env.PFTL_CACHE_RETENTION_INTERVAL_MS, 6 * hour, { min: 300000 })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.started_at,
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    staleAfterMs: 24 * hour,
    lastError: row?.last_error || "",
    details: [row?.id && `run=${row.id}`, row?.run_kind && `kind=${row.run_kind}`],
  });
}

function rpcItems(syncItems = []) {
  const hot = syncItems.find((entry) => entry.id === "pftl_hot_sync") || {};
  const archive = syncItems.find((entry) => entry.id === "pftl_archive_sync") || {};
  const currentEndpoints = [
    ...endpointList(process.env.PFTL_WSS_URL || process.env.VITE_PFTL_WSS_URL),
    ...endpointList(process.env.PFTL_RPC_URL),
    ...endpointList(process.env.PFTL_RPC_URL_FALLBACKS),
  ];
  const historyEndpoints = [
    ...endpointList(process.env.PFTL_HISTORY_WSS_URL),
    ...endpointList(process.env.PFTL_HISTORY_RPC_URL),
    ...endpointList(process.env.PFTL_HISTORY_RPC_URL_FALLBACKS),
  ];
  const ethereumStatus = ethereumDepositConfigStatus();
  const ethereumEndpoints = endpointList(process.env.ETH_DEPOSIT_RPC_URL || process.env.VITE_ETH_DEPOSIT_RPC_URL || "https://ethereum.publicnode.com");
  const currentStatus = currentEndpoints.length
    ? { status: hot.status || "unknown", label: hot.statusLabel || "Configured" }
    : { status: "critical", label: "Missing endpoint" };
  const historyStatus = historyEndpoints.length
    ? { status: archive.status || "unknown", label: archive.statusLabel || "Configured" }
    : { status: "critical", label: "Missing endpoint" };
  return [
    item({
      id: "pftl_current_rpc",
      category: "pftl",
      title: "PFTL Current RPC And WSS",
      description: "Hot path for balance reads, transaction submission, and wallet sync polling.",
      owner: "app and worker processes",
      trigger: "request-time and hot sync",
      cadence: "request-time plus hot sync",
      status: currentStatus.status,
      statusLabel: currentStatus.label,
      lastRunAt: hot.lastRunAt || null,
      lastSuccessAt: hot.lastSuccessAt || null,
      details: currentEndpoints.map((endpoint) => `endpoint=${endpoint}`),
    }),
    item({
      id: "pftl_history_rpc",
      category: "pftl",
      title: "PFTL History RPC And Archive WSS",
      description: "Archive-capable path for context history and historical account_tx backfill.",
      owner: "app and worker processes",
      trigger: "context restore and archive sync",
      cadence: "request-time plus archive sync",
      status: historyStatus.status,
      statusLabel: historyStatus.label,
      lastRunAt: archive.lastRunAt || null,
      lastSuccessAt: archive.lastSuccessAt || null,
      details: historyEndpoints.map((endpoint) => `endpoint=${endpoint}`),
    }),
    item({
      id: "ethereum_deposit_rpc",
      category: "pftl",
      title: "Ethereum Deposit RPC",
      description: "Route-triggered top-up sync path, not a background scheduler.",
      owner: "app process",
      trigger: "top-up sync request",
      cadence: "request-time",
      status: ethereumStatus.enabled && ethereumStatus.rpcConfigured ? "ok" : "disabled",
      statusLabel: ethereumStatus.enabled && ethereumStatus.rpcConfigured ? "Configured" : "Not configured",
      details: [
        ...ethereumEndpoints.map((endpoint) => `endpoint=${endpoint}`),
        ethereumStatus.enabled && `chainId=${ethereumStatus.chainId}`,
      ],
    }),
  ];
}

async function memoryQueueItem({
  tables,
  id,
  title,
  description,
  jobTable,
  entryKind = "",
  resultTable = "chat_memory_entries",
  owner = "worker process",
  enabled = true,
  trigger,
  cadence,
  nowMs,
}) {
  const [latest, counts, oldestDue] = await Promise.all([
    optionalQuery(
      tables,
      [resultTable],
      entryKind
        ? `SELECT id, created_at AS completed_at
             FROM ${resultTable}
            WHERE kind = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 1`
        : `SELECT id, completed_at, created_at
             FROM ${resultTable}
            WHERE status = 'completed'
            ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
            LIMIT 1`,
      entryKind ? [entryKind] : []
    ),
    optionalQuery(
      tables,
      [jobTable],
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed
         FROM ${jobTable}
        GROUP BY status`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      [jobTable],
      `SELECT min(COALESCE(next_attempt_at, updated_at, created_at)) AS oldest_due
         FROM ${jobTable}
        WHERE status IN ('pending', 'processing')
          AND COALESCE(next_attempt_at, updated_at, created_at) <= now()`
    ),
  ]);
  const row = latest.rows[0] || null;
  const queueCounts = countsFromRows(counts.rows);
  let status = runFreshness({ enabled, lastSuccessAt: row?.completed_at || row?.created_at, nowMs });
  const recentFailed = counts.rows.reduce((sum, row) => sum + Number(row.recent_failed || 0), 0);
  status = recentFailureStatus(status, recentFailed, "Recent failed jobs");
  const oldest = iso(oldestDue.rows[0]?.oldest_due);
  if (oldest && oldestAgeMs(oldest, nowMs) > 30 * minute) status = { status: "critical", label: "Queue stale" };
  return item({
    id,
    category: "memory",
    title,
    description,
    owner,
    trigger,
    cadence,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.created_at,
    lastSuccessAt: row?.completed_at || row?.created_at,
    counts: queueCounts,
    details: [row?.id && `latest=${row.id}`, oldest && `oldestDue=${oldest}`],
  });
}

async function jobsPgvectorCorpusItem(tables) {
  const retrievalEnabled = process.env.TASKNODE_JOBS_RETRIEVAL_ENABLED !== "false" &&
    process.env.TASKNODE_CHAT_SPIRIT_ENABLED !== "false";
  const expectedProvider = jobsEmbeddingProvider();
  const expectedModel = jobsEffectiveEmbeddingModel({
    provider: expectedProvider,
    model: jobsEmbeddingModel(),
  });
  const expectedDimensions = jobsEmbeddingDimensions();
  const tableReady = tables.get("jobs_corpus_sources") === true && tables.get("jobs_corpus_chunks") === true;
  const extensionResult = databaseEnabled()
    ? await query("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_installed")
    : { rows: [] };
  const [sourceResult, chunkResult] = await Promise.all([
    optionalQuery(
      tables,
      ["jobs_corpus_sources"],
      `SELECT count(*)::int AS sources,
              max(updated_at) AS last_source_at,
              max(raw_size_bytes)::int AS raw_size_bytes
         FROM jobs_corpus_sources`
    ),
    optionalQuery(
      tables,
      ["jobs_corpus_chunks"],
      `SELECT count(*)::int AS chunks,
              count(*) FILTER (
                WHERE embedding_model = $1
                  AND embedding_dimensions = $2
              )::int AS expected_chunks,
              count(DISTINCT embedding_model)::int AS embedding_models,
              max(updated_at) AS last_chunk_at,
              string_agg(DISTINCT embedding_model, ', ' ORDER BY embedding_model) AS models
         FROM jobs_corpus_chunks`,
      [expectedModel, expectedDimensions]
    ),
  ]);
  const source = sourceResult.rows[0] || {};
  const chunks = chunkResult.rows[0] || {};
  const vectorInstalled = extensionResult.rows[0]?.vector_installed === true;
  const sourceCount = Number(source.sources || 0);
  const chunkCount = Number(chunks.chunks || 0);
  const expectedChunkCount = Number(chunks.expected_chunks || 0);
  let status = { status: "unknown", label: "No corpus status" };
  if (!retrievalEnabled) status = { status: "disabled", label: "Disabled" };
  else if (!databaseEnabled()) status = { status: "unknown", label: "Database disabled" };
  else if (!vectorInstalled) status = { status: "critical", label: "PGVector missing" };
  else if (!tableReady) status = { status: "critical", label: "Corpus tables missing" };
  else if (sourceCount === 0 || chunkCount === 0) status = { status: "warning", label: "Corpus empty" };
  else if (expectedChunkCount === 0) status = { status: "warning", label: "Embedding model mismatch" };
  else status = { status: "ok", label: "Corpus ready" };
  const lastUpdated = chunks.last_chunk_at || source.last_source_at || null;
  return item({
    id: "jobs_pgvector_corpus",
    category: "memory",
    title: "Jobs PGVector Corpus",
    description: "Postgres pgvector corpus used for Jobs-style chat retrieval context.",
    owner: "app process and Postgres",
    trigger: "chat request retrieval and operator ingestion",
    cadence: "request-time plus operator ingest",
    status: status.status,
    statusLabel: status.label,
    lastRunAt: lastUpdated,
    lastSuccessAt: status.status === "ok" ? lastUpdated : null,
    counts: {
      sources: sourceCount,
      chunks: chunkCount,
      expected_model_chunks: expectedChunkCount,
      embedding_models: Number(chunks.embedding_models || 0),
    },
    details: [
      `pgvector=${vectorInstalled ? "installed" : "missing"}`,
      `expectedModel=${expectedModel}`,
      `expectedDimensions=${expectedDimensions}`,
      `provider=${expectedProvider}`,
      chunks.models && `models=${chunks.models}`,
      source.raw_size_bytes && `rawSizeBytes=${source.raw_size_bytes}`,
    ],
  });
}

export function dailyAirdropDebtStaleThresholds(env = process.env) {
  // Mirror the daily airdrop worker's own stale thresholds: fresh in-flight rows
  // (running scoring, processing_pre_submit issuance) are normal payout-tick state,
  // not debt; only rows older than the worker would itself reclaim count as debt.
  return {
    scoringStaleMinutes: intEnv(env.TASKNODE_DAILY_AIRDROP_SCORE_STALE_MINUTES, 45, { min: 1 }),
    preSubmitStaleMinutes: intEnv(env.TASKNODE_DAILY_AIRDROP_PRE_SUBMIT_STALE_MINUTES, 30, { min: 1 }),
  };
}

// Parameters: $1 scoring stale minutes, $2 pre-submit stale minutes.
// Exported so smokes can assert the same predicate the status row uses.
export const DAILY_AIRDROP_DEBT_SUMMARY_SQL = `WITH issuance_debt AS (
         SELECT 'issuance' AS kind,
                i.account_id,
                i.run_date,
                i.run_id,
                i.id AS issuance_id,
                i.amount_pft::numeric AS amount_pft,
                i.recipient_wallet,
                CASE
                  WHEN i.status = 'failed'
                   AND COALESCE(i.tx_hash, '') = ''
                   AND i.submitted_at IS NULL THEN 'failed_before_submit'
                  WHEN i.status = 'processing'
                   AND i.submission_attempted_at IS NULL THEN 'processing_pre_submit'
                  WHEN i.status = 'processing' THEN 'submit_unknown'
                  ELSE i.status
                END AS status,
                i.error_message,
                i.updated_at
           FROM profile_daily_airdrop_issuances i
          WHERE i.status IN ('pending', 'failed', 'failed_before_submit', 'submitting', 'submit_unknown')
             OR (
               i.status IN ('processing', 'processing_pre_submit')
               AND (
                 i.submission_attempted_at IS NOT NULL
                 OR i.updated_at < now() - ($2::integer * interval '1 minute')
               )
             )
             OR (
               i.status = 'submitted'
               AND (COALESCE(i.tx_hash, '') = '' OR i.submitted_at IS NULL)
             )
       ),
       scoring_debt AS (
         SELECT 'scoring' AS kind,
                r.account_id,
                r.run_date,
                r.id AS run_id,
                '' AS issuance_id,
                r.daily_airdrop_pft::numeric AS amount_pft,
                COALESCE(r.input_snapshot->'airdrop_recipient'->>'wallet_address', '') AS recipient_wallet,
                r.status,
                r.error_message,
                r.updated_at
           FROM profile_daily_airdrop_runs r
          WHERE r.run_mode = 'production'
            AND (
              r.status = 'failed'
              OR (
                r.status = 'running'
                AND r.updated_at < now() - ($1::integer * interval '1 minute')
              )
            )
            AND NOT EXISTS (
              SELECT 1
                FROM profile_daily_airdrop_runs complete
               WHERE complete.account_id = r.account_id
                 AND complete.run_date = r.run_date
                 AND complete.run_mode = 'production'
                 AND complete.status = 'completed'
            )
       ),
       missing_issuance_debt AS (
         SELECT 'issuance_missing' AS kind,
                r.account_id,
                r.run_date,
                r.id AS run_id,
                '' AS issuance_id,
                r.daily_airdrop_pft::numeric AS amount_pft,
                COALESCE(r.input_snapshot->'airdrop_recipient'->>'wallet_address', '') AS recipient_wallet,
                'missing_issuance' AS status,
                r.error_message,
                r.updated_at
           FROM profile_daily_airdrop_runs r
          WHERE r.run_mode = 'production'
            AND r.status = 'completed'
            AND r.daily_airdrop_pft > 0
            AND NOT EXISTS (
              SELECT 1
                FROM profile_daily_airdrop_issuances i
               WHERE i.run_id = r.id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM profile_daily_airdrop_issuances submitted
               WHERE submitted.account_id = r.account_id
                 AND submitted.run_date = r.run_date
                 AND submitted.status = 'submitted'
            )
       ),
       debt AS (
         SELECT *,
                CASE
                  WHEN kind = 'issuance' AND status IN ('failed_before_submit', 'pending') THEN 'retry_issuance'
                  WHEN kind = 'issuance' AND status IN ('submitting', 'submit_unknown') THEN 'reconcile_before_retry'
                  WHEN kind = 'issuance' AND status = 'processing_pre_submit' THEN 'wait_or_reclaim_pre_submit'
                  WHEN kind = 'scoring' AND status = 'running' THEN 'wait_or_reclaim_stale_scoring'
                  WHEN kind = 'scoring' AND status = 'failed' THEN 'retry_scoring'
                  WHEN kind = 'issuance_missing' AND recipient_wallet <> '' THEN 'retry_issuance'
                  ELSE 'inspect'
                END AS next_action
           FROM (
             SELECT * FROM issuance_debt
             UNION ALL
             SELECT * FROM scoring_debt
             UNION ALL
             SELECT * FROM missing_issuance_debt
           ) all_debt
       )
       SELECT count(*)::int AS unresolved_count,
              count(*) FILTER (WHERE kind = 'issuance')::int AS issuance_debt_count,
              count(*) FILTER (WHERE kind = 'scoring')::int AS scoring_debt_count,
              count(*) FILTER (WHERE kind = 'issuance_missing')::int AS missing_issuance_count,
              count(*) FILTER (WHERE next_action = 'retry_issuance')::int AS retryable_issuance_count,
              count(*) FILTER (WHERE next_action = 'reconcile_before_retry')::int AS reconcile_count,
              count(*) FILTER (WHERE next_action IN ('wait_or_reclaim_pre_submit', 'wait_or_reclaim_stale_scoring'))::int AS blocked_count,
              COALESCE(sum(amount_pft) FILTER (WHERE next_action = 'retry_issuance'), 0)::text AS retryable_pft,
              min(updated_at) AS oldest_unresolved_at,
              (array_agg(account_id ORDER BY updated_at ASC, run_id ASC))[1] AS oldest_account_id,
              (array_agg(run_id ORDER BY updated_at ASC, run_id ASC))[1] AS oldest_run_id,
              max(error_message) FILTER (WHERE COALESCE(error_message, '') <> '') AS last_error
         FROM debt`;

async function dailyAirdropItem(tables, nowMs) {
  const { scoringStaleMinutes, preSubmitStaleMinutes } = dailyAirdropDebtStaleThresholds();
  const [latest, runCounts, issuanceCounts, debtSummary] = await Promise.all([
    optionalQuery(
      tables,
      ["profile_daily_airdrop_runs", "board_manager_runs"],
      `SELECT id, run_date, run_mode, status, completed_at, updated_at, source
         FROM (
           SELECT id, run_date, run_mode, status, completed_at, updated_at, 'score' AS source
             FROM profile_daily_airdrop_runs
           UNION ALL
           SELECT id, NULL::date AS run_date, 'worker' AS run_mode, status, completed_at, updated_at, 'worker' AS source
             FROM board_manager_runs
            WHERE manager_id = 'daily_airdrop_worker'
              AND selected_action = 'daily_airdrop'
         ) latest
        ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC
        LIMIT 1`
    ),
    optionalQuery(
      tables,
      ["profile_daily_airdrop_runs"],
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed
         FROM profile_daily_airdrop_runs
        GROUP BY status`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["profile_daily_airdrop_issuances"],
      `SELECT status, count(*)::int AS count,
              count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - ($1 * interval '1 millisecond'))::int AS recent_failed
         FROM profile_daily_airdrop_issuances
        GROUP BY status`,
      [recentFailureWindowMs]
    ),
    optionalQuery(
      tables,
      ["profile_daily_airdrop_runs", "profile_daily_airdrop_issuances"],
      DAILY_AIRDROP_DEBT_SUMMARY_SQL,
      [scoringStaleMinutes, preSubmitStaleMinutes]
    ),
  ]);
  const row = latest.rows[0] || null;
  const debt = debtSummary.rows[0] || {};
  const unresolvedDebt = Number(debt.unresolved_count || 0);
  const reconcileDebt = Number(debt.reconcile_count || 0);
  const blockedDebt = Number(debt.blocked_count || 0);
  const counts = {
    ...Object.fromEntries(Object.entries(countsFromRows(runCounts.rows)).map(([key, value]) => [`runs_${key}`, value])),
    ...Object.fromEntries(Object.entries(countsFromRows(issuanceCounts.rows)).map(([key, value]) => [`issuances_${key}`, value])),
    debt_unresolved: unresolvedDebt,
    debt_issuance: Number(debt.issuance_debt_count || 0),
    debt_scoring: Number(debt.scoring_debt_count || 0),
    debt_missing_issuance: Number(debt.missing_issuance_count || 0),
    debt_retryable_issuance: Number(debt.retryable_issuance_count || 0),
    debt_reconcile: reconcileDebt,
    debt_blocked: blockedDebt,
  };
  let status = runFreshness({
    enabled: boolEnv(process.env.TASKNODE_DAILY_AIRDROP_WORKER_ENABLED),
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    warningAfterMs: 26 * hour,
    staleAfterMs: 48 * hour,
    nowMs,
  });
  if (row?.status === "failed" && Date.parse(row.updated_at || row.completed_at || "") > nowMs - recentFailureWindowMs) {
    status = { status: "critical", label: "Recent run failed" };
  }
  const recentFailed = [...runCounts.rows, ...issuanceCounts.rows]
    .reduce((sum, failedRow) => sum + Number(failedRow.recent_failed || 0), 0);
  status = recentFailureStatus(status, recentFailed, "Recent failed records");
  if (unresolvedDebt > 0) {
    status = mergeStatus(status, {
      status: reconcileDebt > 0 || blockedDebt > 0 ? "critical" : "warning",
      label: reconcileDebt > 0 ? "Airdrop reconciliation needed" : "Airdrop debt unresolved",
    });
  }
  return item({
    id: "daily_airdrop_worker",
    category: "memory",
    title: "Daily Airdrop Worker",
    description: "Scores eligible accounts and optionally issues the daily PFT airdrop.",
    owner: "worker process",
    trigger: "daily interval timer",
    cadence: `${intEnv(process.env.TASKNODE_DAILY_AIRDROP_WORKER_INTERVAL_MS, hour, { min: minute })}ms`,
    status: status.status,
    statusLabel: status.label,
    lastRunAt: row?.completed_at || row?.updated_at,
    lastSuccessAt: row?.status === "completed" ? row.completed_at : null,
    staleAfterMs: 48 * hour,
    counts,
    lastError: debt.last_error || "",
    details: [
      row?.id && `latest=${row.id}`,
      row?.source && `source=${row.source}`,
      row?.run_date && `runDate=${row.run_date}`,
      row?.run_mode && `mode=${row.run_mode}`,
      unresolvedDebt > 0 && `unresolvedDebt=${unresolvedDebt}`,
      Number(debt.missing_issuance_count || 0) > 0 && `missingIssuance=${debt.missing_issuance_count}`,
      Number(debt.retryable_issuance_count || 0) > 0 && `retryableIssuance=${debt.retryable_issuance_count} retryablePft=${debt.retryable_pft}`,
      reconcileDebt > 0 && `reconcileRequired=${reconcileDebt}`,
      blockedDebt > 0 && `blockedOrStale=${blockedDebt}`,
      debt.oldest_unresolved_at && `oldestDebt=${iso(debt.oldest_unresolved_at)}`,
      debt.oldest_account_id && `oldestDebtAccount=${debt.oldest_account_id}`,
      debt.oldest_run_id && `oldestDebtRun=${debt.oldest_run_id}`,
    ],
  });
}

async function categoryItems(tables, nowMs) {
  const hiveItems = [
    await boardManagerItem(tables, nowMs),
    await boardManagerSecretaryPacketItem(tables, nowMs),
    await hiveQueueItem({
      tables,
      id: "hive_secretary",
      title: "Hive Secretary Worker",
      description: "Builds the network context report from validated Hive inputs.",
      owner: "worker process",
      jobTable: "hive_secretary_jobs",
      resultTable: "hive_secretary_reports",
      resultTimeColumn: "completed_at",
      enabled: process.env.TASKNODE_HIVE_SECRETARY_ENABLED !== "false",
      trigger: "validated Hive Context input",
      cadence: `${intEnv(process.env.TASKNODE_HIVE_SECRETARY_INTERVAL_MS, 15000, { min: 1000 })}ms`,
      nowMs,
    }),
    await hiveQueueItem({
      tables,
      id: "hive_active_projects",
      title: "Hive Active Projects Helper",
      description: "Refreshes the active project registry after Secretary reports.",
      owner: "worker process",
      jobTable: "hive_project_planning_jobs",
      resultTable: "hive_project_generations",
      resultTimeColumn: "completed_at",
      enabled: process.env.TASKNODE_HIVE_PROJECT_WORKER_ENABLED !== "false",
      trigger: "Hive Secretary completion",
      cadence: `${intEnv(process.env.TASKNODE_HIVE_PROJECT_INTERVAL_MS, 60000, { min: 15000 })}ms`,
      nowMs,
    }),
  ];

  const taskItems = [
    await networkTaskGenerationItem(tables, nowMs),
    await taskGenerationItem(tables, nowMs),
    await taskReviewItem(tables, nowMs),
  ];

  const syncItems = await pftlSyncItems(tables, nowMs);
  const pftlItems = [
    ...syncItems,
    await pftlWatcherItem(tables, nowMs),
    await pftlReducerItem(tables, nowMs),
    await pftlRetentionItem(tables, nowMs),
    ...rpcItems(syncItems),
  ];

  const memoryItems = [
    await jobsPgvectorCorpusItem(tables),
    await memoryQueueItem({
      tables,
      id: "chat_turn_memory",
      title: "Turn Memory Worker",
      description: "Summarizes individual user/assistant chat turns.",
      jobTable: "chat_memory_jobs",
      entryKind: "turn_memory",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "assistant chat message",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await memoryQueueItem({
      tables,
      id: "deep_memory",
      title: "Deep Memory Worker",
      description: "Compresses batches of turn memory into account-level memory.",
      jobTable: "chat_deep_memory_jobs",
      entryKind: "deep_memory",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "turn memory block threshold",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await memoryQueueItem({
      tables,
      id: "network_task_profile",
      title: "Network Task Profile Worker",
      description: "Builds compact routing profiles for future Network Tasks.",
      jobTable: "network_task_profile_jobs",
      resultTable: "network_task_profiles",
      enabled: process.env.TASKNODE_MEMORY_ENABLED !== "false",
      trigger: "profile refresh request or prompt version change",
      cadence: `${intEnv(process.env.TASKNODE_MEMORY_INTERVAL_MS, 15000, { min: 5000 })}ms`,
      nowMs,
    }),
    await dailyAirdropItem(tables, nowMs),
  ];

  return [
    {
      id: "hive",
      title: "Hive And Board Agents",
      summary: "Board Manager, Secretary, project planning, and board compression jobs.",
      items: hiveItems,
    },
    {
      id: "task_engine",
      title: "Task Systems",
      summary: "Network Task generation, task offer generation, and verification/reward review.",
      items: taskItems,
    },
    {
      id: "pftl",
      title: "PFTL And RPCs",
      summary: "Current and archive RPC paths, websocket watcher, wallet sync, reducer, and retention.",
      items: pftlItems,
    },
    {
      id: "memory",
      title: "Memory, Retrieval, Profiles, And Airdrops",
      summary: "Jobs pgvector retrieval, chat memory, routing profiles, and daily airdrop scoring/issuance.",
      items: memoryItems,
    },
  ];
}

export async function readSystemStatus({
  networkSpendDays = DEFAULT_NETWORK_TASK_SPEND_DAYS,
  boardManagerCostDays = DEFAULT_BOARD_MANAGER_COST_DAYS,
} = {}) {
  const generatedAt = new Date();
  const nowMs = generatedAt.getTime();
  const database = databaseStatus();
  if (!databaseEnabled()) {
    const [categories, chatPricing, networkTaskSpendByDay, boardManagerDailyCost, agentActivity] = await Promise.all([
      categoryItems(new Map(), nowMs),
      chatPricingStatus(),
      readNetworkTaskSpendByDay({ tables: new Map(), days: networkSpendDays }),
      readBoardManagerDailyCost({ tables: new Map(), days: boardManagerCostDays }),
      readAgentActivity({ tables: new Map(), databaseReady: false }),
    ]);
    return {
      ok: true,
      generatedAt: generatedAt.toISOString(),
      database,
      summary: summarizeCategories(categories),
      chatPricing,
      networkTaskSpendByDay,
      boardManagerDailyCost,
      agentActivity,
      categories,
    };
  }
  const tables = await tableMap();
  const [categories, chatPricing, networkTaskSpendByDay, boardManagerDailyCost, agentActivity] = await Promise.all([
    categoryItems(tables, nowMs),
    chatPricingStatus(),
    readNetworkTaskSpendByDay({ tables, days: networkSpendDays }),
    readBoardManagerDailyCost({ tables, days: boardManagerCostDays }),
    readAgentActivity({ tables }),
  ]);
  return {
    ok: true,
    generatedAt: generatedAt.toISOString(),
    database,
    summary: summarizeCategories(categories),
    chatPricing,
    networkTaskSpendByDay,
    boardManagerDailyCost,
    agentActivity,
    categories,
  };
}

export async function handleSystemStatusRoute({ json, res, url } = {}) {
  if (url.pathname !== "/api/system/status") return false;
  const status = await readSystemStatus({
    networkSpendDays: url.searchParams.get("networkSpendDays") || DEFAULT_NETWORK_TASK_SPEND_DAYS,
    boardManagerCostDays: url.searchParams.get("boardManagerCostDays") || DEFAULT_BOARD_MANAGER_COST_DAYS,
  });
  json(res, 200, status);
  return true;
}
