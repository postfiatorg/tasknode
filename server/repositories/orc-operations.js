import { databaseEnabled, query } from "../db/pool.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function agentKey(row = {}) {
  return [
    safeText(row.id, 180),
    safeText(row.handle || row.orc_handle, 120).toLowerCase(),
    safeText(row.agent_id || row.agentId, 180).toLowerCase(),
    safeText(row.account_id || row.accountId, 180),
    safeText(row.wallet_address || row.walletAddress, 120),
  ].filter(Boolean).join("|");
}

function byAgent(rows = []) {
  const map = new Map();
  for (const row of safeArray(rows)) {
    const key = agentKey(row);
    if (key) map.set(key, row);
  }
  return map;
}

function findForAgent(agent = {}, rows = []) {
  const candidates = new Set([
    safeText(agent.id, 180),
    safeText(agent.handle, 120).toLowerCase(),
    safeText(agent.agent_id || agent.agentId, 180).toLowerCase(),
    safeText(agent.account_id || agent.accountId, 180),
    safeText(agent.wallet_address || agent.walletAddress, 120),
  ].filter(Boolean));
  return safeArray(rows).find((row) => {
    const rowKeys = [
      safeText(row.id, 180),
      safeText(row.orc_handle || row.handle, 120).toLowerCase(),
      safeText(row.agent_id || row.agentId, 180).toLowerCase(),
      safeText(row.account_id || row.accountId, 180),
      safeText(row.wallet_address || row.walletAddress, 120),
    ].filter(Boolean);
    return rowKeys.some((key) => candidates.has(key));
  }) || null;
}

function compactRecentRun(row = {}) {
  return {
    orcHandle: safeText(row.orc_handle || row.handle, 120),
    agentId: safeText(row.agent_id || row.agentId, 180),
    command: safeText(row.command, 160),
    phase: safeText(row.phase, 120),
    status: safeText(row.status || "unknown", 80),
    taskId: safeText(row.task_id || row.taskId, 180),
    followupTaskId: safeText(row.followup_task_id || row.followupTaskId, 180),
    cid: safeText(row.cid, 240),
    txHash: safeText(row.tx_hash || row.txHash, 240),
    error: safeText(row.error, 500),
    createdAt: row.created_at || row.createdAt || null,
  };
}

function compactReview(row = {}) {
  return {
    taskId: safeText(row.task_id || row.taskId, 180),
    disposition: safeText(row.disposition || row.review_disposition || "not_reviewed", 120),
    actionRequired: booleanValue(row.action_required || row.actionRequired, false),
    actionOwner: safeText(row.action_owner || row.actionOwner, 160),
    confidence: safeText(row.confidence || "medium", 40),
    categories: safeArray(row.categories).slice(0, 8).map((item) => safeText(item, 80)).filter(Boolean),
    integritySignals: safeArray(row.integrity_signals || row.integritySignals).slice(0, 8).map((item) => safeText(item, 80)).filter(Boolean),
    summary: safeText(row.summary || row.review_summary, 700),
    recommendedAction: safeText(row.recommended_action || row.recommendedAction, 700),
    reviewerHandle: safeText(row.reviewer_handle || row.reviewerHandle, 120),
    reviewerWallet: safeText(row.reviewer_wallet || row.reviewerWallet, 120),
    sourceTaskIds: safeArray(row.source_task_ids || row.sourceTaskIds).slice(0, 8).map((item) => safeText(item, 180)).filter(Boolean),
    sourceCids: safeArray(row.source_cids || row.sourceCids).slice(0, 8).map((item) => safeText(item, 240)).filter(Boolean),
    sourceTxHashes: safeArray(row.source_tx_hashes || row.sourceTxHashes).slice(0, 8).map((item) => safeText(item, 240)).filter(Boolean),
    reviewedAt: row.reviewed_at || row.reviewedAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
  };
}

function compactInteraction(row = {}) {
  return {
    id: safeText(row.id, 180),
    orcHandle: safeText(row.orc_handle || row.orcHandle, 120),
    interactionType: safeText(row.interaction_type || row.interactionType, 80),
    directive: safeText(row.directive, 900),
    issue: safeText(row.issue, 900),
    status: safeText(row.status || "recorded", 80),
    createdAt: row.created_at || row.createdAt || null,
  };
}

function compactTaskStats(row = {}) {
  return {
    outstandingNetworkTaskCount: numeric(row.outstanding_network_task_count || row.outstandingNetworkTaskCount, 0),
    outstandingPersonalTaskCount: numeric(row.outstanding_personal_task_count || row.outstandingPersonalTaskCount, 0),
    pendingGenerationCount: numeric(row.pending_generation_count || row.pendingGenerationCount, 0),
    rewardedTaskCount: numeric(row.rewarded_task_count || row.rewardedTaskCount, 0),
    rewardActualPft: numeric(row.reward_actual_pft || row.rewardActualPft, 0),
    activeTaskIds: safeArray(row.active_task_ids || row.activeTaskIds).slice(0, 8).map((item) => safeText(item, 180)).filter(Boolean),
    lastTaskAt: row.last_task_at || row.lastTaskAt || null,
  };
}

function compactReviewCounts(row = {}) {
  return {
    reviewedCount: numeric(row.reviewed_count || row.reviewedCount, 0),
    actionRequiredCount: numeric(row.action_required_count || row.actionRequiredCount, 0),
    byDisposition: safeObject(row.by_disposition || row.byDisposition),
    lastReviewAt: row.last_review_at || row.lastReviewAt || null,
  };
}

function compactLastReviewedAction(row = {}) {
  const action = safeObject(row.last_reviewed_action || row.lastReviewedAction);
  return {
    taskId: safeText(action.taskId || action.task_id, 180),
    disposition: safeText(action.disposition, 120),
    actionRequired: booleanValue(action.actionRequired ?? action.action_required, false),
    confidence: safeText(action.confidence, 40),
    reviewerHandle: safeText(action.reviewerHandle || action.reviewer_handle, 120),
    reviewedAt: action.reviewedAt || action.reviewed_at || null,
    updatedAt: action.updatedAt || action.updated_at || null,
  };
}

function compactReviewRollup(row = {}) {
  const integritySignalCounts = safeObject(row.integrity_signal_counts || row.integritySignalCounts);
  const repeatedIntegritySignals = safeArray(row.repeated_integrity_signals || row.repeatedIntegritySignals)
    .slice(0, 8)
    .map((item) => safeText(item, 120))
    .filter(Boolean);
  return {
    accountId: safeText(row.account_id || row.accountId, 180),
    walletAddress: safeText(row.wallet_address || row.walletAddress, 120),
    category: safeText(row.category || "uncategorized", 120) || "uncategorized",
    reviewedCount: numeric(row.reviewed_count || row.reviewedCount, 0),
    actionRequiredCount: numeric(row.action_required_count || row.actionRequiredCount, 0),
    integrityFollowUpCount: numeric(row.integrity_follow_up_count || row.integrityFollowUpCount, 0),
    resolvedReviewCount: numeric(row.resolved_review_count || row.resolvedReviewCount, 0),
    hasIntegritySignals: booleanValue(row.has_integrity_signals ?? row.hasIntegritySignals, false),
    highValueCategory: booleanValue(row.high_value_category ?? row.highValueCategory, false),
    byDisposition: safeObject(row.by_disposition || row.byDisposition),
    integritySignalCounts,
    repeatedIntegritySignals,
    lastReviewedAction: compactLastReviewedAction(row),
    lastReviewAt: row.last_review_at || row.lastReviewAt || null,
  };
}

export function compactBoardManagerOrcOperationsForSourcePacket({
  agents = [],
  taskStats = [],
  reviewCounts = [],
  reviewRollups = [],
  recentReviews = [],
  reviewHistoryCount = 0,
  runJournal = [],
  operatorInteractions = [],
  tableStatus = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const taskStatsByAgent = byAgent(taskStats);
  const recentRunRows = safeArray(runJournal).map(compactRecentRun);
  const recentReviewRows = safeArray(recentReviews).map(compactReview);
  const reviewRollupRows = safeArray(reviewRollups)
    .map(compactReviewRollup)
    .filter((item) => item.accountId || item.walletAddress)
    .sort((left, right) => (
      right.integrityFollowUpCount - left.integrityFollowUpCount ||
      right.actionRequiredCount - left.actionRequiredCount ||
      right.reviewedCount - left.reviewedCount ||
      (Date.parse(right.lastReviewAt || "") || 0) - (Date.parse(left.lastReviewAt || "") || 0)
    ));
  const recentInteractionRows = safeArray(operatorInteractions).map(compactInteraction);
  const compactAgents = safeArray(agents).slice(0, 24).map((agent) => {
    const key = agentKey(agent);
    const stats = compactTaskStats(taskStatsByAgent.get(key) || {});
    const review = compactReviewCounts(findForAgent(agent, reviewCounts) || {});
    const lastRun = compactRecentRun(findForAgent(agent, runJournal) || {});
    const recentInteractionCount = recentInteractionRows.filter((item) => (
      item.orcHandle && item.orcHandle.toLowerCase() === safeText(agent.handle, 120).toLowerCase()
    )).length;
    const active = booleanValue(agent.active, true);
    const status = safeText(agent.status || (active ? "active" : "inactive"), 80) || (active ? "active" : "inactive");
    return {
      id: safeText(agent.id, 180),
      handle: safeText(agent.handle, 120),
      agentId: safeText(agent.agent_id || agent.agentId, 180),
      accountId: safeText(agent.account_id || agent.accountId, 180),
      walletAddress: safeText(agent.wallet_address || agent.walletAddress, 120),
      role: safeText(agent.role || "operator", 80) || "operator",
      status,
      active,
      capacityLimit: Math.max(0, Math.round(numeric(agent.capacity_limit || agent.capacityLimit, 1))),
      routingEligible: active && ["active", "idle", "available", "operator"].includes(status.toLowerCase()),
      currentTasks: stats,
      reviews: review,
      interactions: {
        recentCount: recentInteractionCount,
      },
      lastRun: lastRun.createdAt || lastRun.status || lastRun.command ? lastRun : null,
      updatedAt: agent.updated_at || agent.updatedAt || null,
    };
  });
  const summary = {
    agentCount: compactAgents.length,
    activeAgentCount: compactAgents.filter((agent) => agent.active).length,
    availableForRoutingCount: compactAgents.filter((agent) => agent.routingEligible && agent.currentTasks.outstandingNetworkTaskCount < Math.max(1, agent.capacityLimit)).length,
    outstandingOrcNetworkTaskCount: compactAgents.reduce((sum, agent) => sum + agent.currentTasks.outstandingNetworkTaskCount, 0),
    pendingOrcGenerationCount: compactAgents.reduce((sum, agent) => sum + agent.currentTasks.pendingGenerationCount, 0),
    reviewedTaskCount: compactAgents.reduce((sum, agent) => sum + agent.reviews.reviewedCount, 0),
    reviewHistoryCount: numeric(reviewHistoryCount, 0),
    actionRequiredReviewCount: compactAgents.reduce((sum, agent) => sum + agent.reviews.actionRequiredCount, 0),
    reviewRollupCount: reviewRollupRows.length,
    integrityFollowUpRollupCount: reviewRollupRows.reduce((sum, row) => sum + row.integrityFollowUpCount, 0),
    repeatedIntegritySignalRollupCount: reviewRollupRows.filter((row) => row.repeatedIntegritySignals.length > 0).length,
    recentRunCount: recentRunRows.length,
    recentInteractionCount: recentInteractionRows.length,
  };
  return {
    schema: "pf.hive.board_manager.orc_operations.v1",
    generatedAt,
    status: compactAgents.length ? "available" : safeText(tableStatus.status || "no_orc_agents", 120),
    enforcement: "none_context_only",
    accountingPolicy: "Orc registry and activity are Board Manager context only; they do not mutate rewards, custody, task lifecycle, capacity predicates, bans, or deployment state.",
    tables: {
      orcAgents: Boolean(tableStatus.orcAgents ?? tableStatus.orc_agents),
      orcRunJournal: Boolean(tableStatus.orcRunJournal ?? tableStatus.orc_run_journal),
      orcTaskReviews: Boolean(tableStatus.orcTaskReviews ?? tableStatus.orc_task_reviews),
      orcTaskReviewStates: Boolean(tableStatus.orcTaskReviewStates ?? tableStatus.orc_task_review_states),
      orcReviewRollups: Boolean(tableStatus.orcReviewRollups ?? tableStatus.orc_review_rollups),
      orcOperatorInteractions: Boolean(tableStatus.orcOperatorInteractions ?? tableStatus.orc_operator_interactions),
    },
    summary,
    agents: compactAgents,
    routingCandidates: compactAgents
      .filter((agent) => agent.routingEligible)
      .map((agent) => ({
        source: "orc_agents",
        role: "orc_operator",
        handle: agent.handle,
        agentId: agent.agentId,
        accountId: agent.accountId,
        walletAddress: agent.walletAddress,
        availableForNetworkTask: agent.currentTasks.outstandingNetworkTaskCount < Math.max(1, agent.capacityLimit) &&
          agent.currentTasks.pendingGenerationCount === 0,
        capacityContext: {
          capacityLimit: agent.capacityLimit,
          outstandingNetworkTaskCount: agent.currentTasks.outstandingNetworkTaskCount,
          pendingGenerationCount: agent.currentTasks.pendingGenerationCount,
        },
      })),
    reviewQueue: {
      actionRequiredCount: summary.actionRequiredReviewCount,
      recent: recentReviewRows.slice(0, 12),
    },
    reviewRollups: {
      policy: "manager_internal_triage_signals_only_not_public_fraud_findings",
      recent: reviewRollupRows.slice(0, 12),
      repeatedIntegritySignals: reviewRollupRows.filter((row) => row.repeatedIntegritySignals.length > 0).slice(0, 8),
    },
    runJournal: {
      recent: recentRunRows.slice(0, 12),
    },
    operatorInteractions: {
      recent: recentInteractionRows.slice(0, 12),
    },
  };
}

async function existingOrcTables() {
  if (!databaseEnabled()) {
    return {
      status: "database_disabled",
      orcAgents: false,
      orcRunJournal: false,
      orcTaskReviews: false,
      orcTaskReviewStates: false,
      orcReviewRollups: false,
      orcOperatorInteractions: false,
    };
  }
  const result = await query(`
    SELECT
      to_regclass('public.orc_agents') IS NOT NULL AS orc_agents,
      to_regclass('public.orc_run_journal') IS NOT NULL AS orc_run_journal,
      to_regclass('public.orc_task_reviews') IS NOT NULL AS orc_task_reviews,
      to_regclass('public.orc_task_review_states') IS NOT NULL AS orc_task_review_states,
      to_regclass('public.orc_review_rollups') IS NOT NULL AS orc_review_rollups,
      to_regclass('public.orc_operator_interactions') IS NOT NULL AS orc_operator_interactions
  `);
  const row = result.rows[0] || {};
  return {
    status: row.orc_agents ? "available" : "orc_agents_missing",
    orcAgents: Boolean(row.orc_agents),
    orcRunJournal: Boolean(row.orc_run_journal),
    orcTaskReviews: Boolean(row.orc_task_reviews),
    orcTaskReviewStates: Boolean(row.orc_task_review_states),
    orcReviewRollups: Boolean(row.orc_review_rollups),
    orcOperatorInteractions: Boolean(row.orc_operator_interactions),
  };
}

export async function getBoardManagerOrcOperations({ limit = 24 } = {}) {
  const tableStatus = await existingOrcTables().catch(() => ({
    status: "table_check_failed",
    orcAgents: false,
    orcRunJournal: false,
    orcTaskReviews: false,
    orcTaskReviewStates: false,
    orcReviewRollups: false,
    orcOperatorInteractions: false,
  }));
  if (!databaseEnabled() || !tableStatus.orcAgents) {
    return compactBoardManagerOrcOperationsForSourcePacket({ tableStatus });
  }

  const cappedLimit = Math.min(48, Math.max(1, Math.round(Number(limit) || 24)));
  const agentsResult = await query(
    `
      SELECT
        id,
        handle,
        agent_id,
        account_id,
        wallet_address,
        role,
        status,
        active,
        capacity_limit,
        updated_at
      FROM orc_agents
      WHERE COALESCE(active, true) = true
      ORDER BY
        CASE WHEN lower(COALESCE(status, '')) IN ('active', 'idle', 'available') THEN 0 ELSE 1 END,
        COALESCE(updated_at, created_at) DESC,
        handle ASC
      LIMIT $1
    `,
    [cappedLimit]
  );
  const agents = agentsResult.rows;
  if (!agents.length) {
    return compactBoardManagerOrcOperationsForSourcePacket({ tableStatus });
  }

  const taskStatsResult = await query(
    `
      WITH agents AS (
        SELECT *
        FROM orc_agents
        WHERE COALESCE(active, true) = true
        ORDER BY
          CASE WHEN lower(COALESCE(status, '')) IN ('active', 'idle', 'available') THEN 0 ELSE 1 END,
          COALESCE(updated_at, created_at) DESC,
          handle ASC
        LIMIT $1
      ),
      matched_tasks AS (
        SELECT
          agents.id,
          agents.handle,
          agents.agent_id,
          agents.account_id,
          agents.wallet_address,
          p.task_id,
          p.task_kind,
          p.status,
          p.reward_actual_pft,
          p.updated_at
        FROM agents
        LEFT JOIN task_projections p
          ON (
            (agents.account_id <> '' AND p.account_id = agents.account_id) OR
            (agents.wallet_address <> '' AND p.subject_wallet = agents.wallet_address)
          )
          AND COALESCE(p.source, '') <> 'directory_polish_local_fixture'
          AND COALESCE(p.metadata_json->>'directoryPolishFixture', 'false') <> 'true'
      )
      SELECT
        id,
        handle,
        agent_id,
        account_id,
        wallet_address,
        count(*) FILTER (
          WHERE lower(COALESCE(task_kind, '')) = 'network'
            AND status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'reward_decided')
        )::int AS outstanding_network_task_count,
        count(*) FILTER (
          WHERE lower(COALESCE(task_kind, '')) <> 'network'
            AND status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'reward_decided')
        )::int AS outstanding_personal_task_count,
        count(*) FILTER (WHERE status = 'rewarded')::int AS rewarded_task_count,
        COALESCE(sum(reward_actual_pft) FILTER (WHERE status = 'rewarded'), 0)::numeric AS reward_actual_pft,
        COALESCE(array_agg(task_id ORDER BY updated_at DESC) FILTER (
          WHERE status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'reward_decided')
        ), ARRAY[]::text[]) AS active_task_ids,
        max(updated_at) AS last_task_at
      FROM matched_tasks
      GROUP BY id, handle, agent_id, account_id, wallet_address
    `,
    [cappedLimit]
  ).catch(() => ({ rows: [] }));

  const pendingGenerationResult = await query(
    `
      WITH agents AS (
        SELECT *
        FROM orc_agents
        WHERE COALESCE(active, true) = true
        ORDER BY
          CASE WHEN lower(COALESCE(status, '')) IN ('active', 'idle', 'available') THEN 0 ELSE 1 END,
          COALESCE(updated_at, created_at) DESC,
          handle ASC
        LIMIT $1
      ),
      pending AS (
        SELECT
          agents.id,
          agents.handle,
          agents.agent_id,
          agents.account_id,
          agents.wallet_address,
          count(*)::int AS pending_generation_count
        FROM agents
        LEFT JOIN network_task_generation_jobs jobs
          ON (
            (agents.account_id <> '' AND jobs.candidate_account_id = agents.account_id) OR
            (agents.wallet_address <> '' AND jobs.candidate_wallet_address = agents.wallet_address)
          )
          AND jobs.status NOT IN ('failed', 'cancelled', 'expired', 'completed', 'linked', 'generated')
        GROUP BY agents.id, agents.handle, agents.agent_id, agents.account_id, agents.wallet_address
      )
      SELECT * FROM pending
    `,
    [cappedLimit]
  ).catch(() => ({ rows: [] }));

  const pendingByAgent = byAgent(pendingGenerationResult.rows);
  const taskStats = taskStatsResult.rows.map((row) => ({
    ...row,
    pending_generation_count: numeric(pendingByAgent.get(agentKey(row))?.pending_generation_count, 0),
  }));

  const reviewCounts = tableStatus.orcTaskReviewStates ? (await query(
    `
      WITH base AS (
        SELECT
          reviewer_handle,
          reviewer_wallet,
          disposition,
          action_required,
          updated_at
        FROM orc_task_review_states
        WHERE reviewer_handle <> '' OR reviewer_wallet <> ''
      ),
      grouped AS (
        SELECT
          reviewer_handle,
          reviewer_wallet,
          count(*) FILTER (WHERE disposition <> 'not_reviewed')::int AS reviewed_count,
          count(*) FILTER (WHERE action_required = true)::int AS action_required_count,
          max(updated_at) AS last_review_at
        FROM base
        GROUP BY reviewer_handle, reviewer_wallet
      ),
      dispositions AS (
        SELECT
          reviewer_handle,
          reviewer_wallet,
          jsonb_object_agg(disposition, total) AS by_disposition
        FROM (
          SELECT reviewer_handle, reviewer_wallet, disposition, count(*)::int AS total
          FROM base
          GROUP BY reviewer_handle, reviewer_wallet, disposition
        ) counts
        GROUP BY reviewer_handle, reviewer_wallet
      )
      SELECT
        grouped.reviewer_handle AS handle,
        grouped.reviewer_wallet AS wallet_address,
        grouped.reviewed_count,
        grouped.action_required_count,
        COALESCE(dispositions.by_disposition, '{}'::jsonb) AS by_disposition,
        grouped.last_review_at
      FROM grouped
      LEFT JOIN dispositions
        ON dispositions.reviewer_handle = grouped.reviewer_handle
       AND dispositions.reviewer_wallet = grouped.reviewer_wallet
    `
  ).catch(() => ({ rows: [] }))).rows : [];

  const recentReviews = tableStatus.orcTaskReviewStates ? (await query(
    `
      SELECT
        task_id,
        disposition,
        action_required,
        action_owner,
        confidence,
        categories,
        integrity_signals,
        summary,
        recommended_action,
        reviewer_handle,
        reviewer_wallet,
        source_task_ids,
        source_cids,
        source_tx_hashes,
        reviewed_at,
        updated_at
      FROM orc_task_review_states
      WHERE disposition <> 'not_reviewed' OR action_required = true
      ORDER BY updated_at DESC
      LIMIT 24
    `
  ).catch(() => ({ rows: [] }))).rows : [];

  const reviewHistoryCount = tableStatus.orcTaskReviews ? Number((await query(
    "SELECT count(*)::int AS count FROM orc_task_reviews"
  ).catch(() => ({ rows: [{ count: 0 }] }))).rows[0]?.count || 0) : 0;

  const reviewRollups = tableStatus.orcReviewRollups ? (await query(
    `
      SELECT
        account_id,
        wallet_address,
        category,
        reviewed_count,
        action_required_count,
        integrity_follow_up_count,
        resolved_review_count,
        has_integrity_signals,
        high_value_category,
        by_disposition,
        integrity_signal_counts,
        repeated_integrity_signals,
        last_reviewed_action,
        last_review_at
      FROM orc_review_rollups
      ORDER BY
        integrity_follow_up_count DESC,
        action_required_count DESC,
        reviewed_count DESC,
        last_review_at DESC NULLS LAST,
        account_id ASC,
        wallet_address ASC,
        category ASC
      LIMIT 24
    `
  ).catch(() => ({ rows: [] }))).rows : [];

  const runJournal = tableStatus.orcRunJournal ? (await query(
    `
      SELECT
        orc_handle,
        agent_id,
        command,
        phase,
        status,
        task_id,
        followup_task_id,
        cid,
        tx_hash,
        error,
        created_at
      FROM orc_run_journal
      ORDER BY created_at DESC
      LIMIT 24
    `
  ).catch(() => ({ rows: [] }))).rows : [];

  const operatorInteractions = tableStatus.orcOperatorInteractions ? (await query(
    `
      SELECT
        id,
        orc_handle,
        interaction_type,
        directive,
        issue,
        status,
        created_at
      FROM orc_operator_interactions
      ORDER BY created_at DESC
      LIMIT 24
    `
  ).catch(() => ({ rows: [] }))).rows : [];

  return compactBoardManagerOrcOperationsForSourcePacket({
    agents,
    taskStats,
    reviewCounts,
    reviewRollups,
    recentReviews,
    reviewHistoryCount,
    runJournal,
    operatorInteractions,
    tableStatus,
  });
}
