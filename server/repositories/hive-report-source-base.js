import { query } from "../db/pool.js";
import { getHiveProjectsDocument } from "./hive-projects.js";
import {
  chatRow,
  compactProject,
  hiveReportTypes,
  iso,
  numeric,
  roleAccountRow,
  roleDefinitions,
  safeArray,
  safeObject,
  safeText,
  taskRow,
} from "./hive-report-contract.js";

export async function listRoleAccounts(identityByAccount) {
  const result = await query(
    `
      SELECT badge.account_id,
             badge.badge_id,
             badge.updated_at,
             badge.evidence_json,
             badge.validated_metrics_json,
             definition.label,
             wallet.subject_wallet AS wallet_address,
             identity.public_handle AS public_handle,
             approval.public_handle AS provider_handle,
             approval.profile_url AS provider_profile_url
      FROM account_network_badges badge
      JOIN network_badge_definitions definition
        ON definition.badge_id = badge.badge_id
      LEFT JOIN LATERAL (
        SELECT event.public_handle
        FROM user_observability_events event
        WHERE event.account_id = badge.account_id
          AND event.public_handle <> ''
        ORDER BY event.occurred_at DESC, event.id DESC
        LIMIT 1
      ) identity ON true
      LEFT JOIN LATERAL (
        SELECT identity_approval.public_handle,
               identity_approval.profile_url
        FROM account_identity_approvals identity_approval
        WHERE identity_approval.account_id = badge.account_id
          AND identity_approval.status = 'active'
          AND identity_approval.revoked_at IS NULL
          AND (identity_approval.expires_at IS NULL OR identity_approval.expires_at > now())
          AND (
            identity_approval.approval_scope = ('badge:' || badge.badge_id)
            OR (
              badge.badge_id = 'kol'
              AND identity_approval.provider = 'x'
            )
            OR (
              badge.badge_id = 'core_contributor'
              AND identity_approval.provider = 'github'
            )
          )
        ORDER BY identity_approval.updated_at DESC, identity_approval.id DESC
        LIMIT 1
      ) approval ON true
      LEFT JOIN LATERAL (
        SELECT projection.subject_wallet
        FROM task_projections projection
        WHERE projection.account_id = badge.account_id
          AND projection.subject_wallet <> ''
        ORDER BY projection.updated_at DESC, projection.task_id DESC
        LIMIT 1
      ) wallet ON true
      WHERE badge.status = 'verified'
        AND badge.revoked_at IS NULL
        AND (badge.expires_at IS NULL OR badge.expires_at > now())
        AND definition.active = true
        AND badge.badge_id = ANY($1::text[])
      ORDER BY badge.badge_id ASC, badge.updated_at DESC, badge.account_id ASC
    `,
    [Object.keys(roleDefinitions)]
  ).catch(() => ({ rows: [] }));
  const rows = result.rows.map((row) => roleAccountRow(row, identityByAccount));
  return {
    accounts: rows,
    byRole: Object.fromEntries(Object.keys(roleDefinitions).map((role) => [
      role,
      rows.filter((row) => row.badgeId === role),
    ])),
  };
}

export async function listRewardedTasksByRole({ perRole = 10, identityByAccount = new Map() } = {}) {
  const result = await query(
    `
      WITH role_tasks AS (
        SELECT badge.badge_id,
               definition.label AS badge_label,
               projection.*,
               identity.public_handle AS public_handle,
               row_number() OVER (
                 PARTITION BY badge.badge_id
                 ORDER BY projection.last_event_at DESC NULLS LAST, projection.updated_at DESC, projection.task_id DESC
               ) AS role_rank
        FROM account_network_badges badge
        JOIN network_badge_definitions definition
          ON definition.badge_id = badge.badge_id
        JOIN task_projections projection
          ON projection.account_id = badge.account_id
        LEFT JOIN LATERAL (
          SELECT event.public_handle
          FROM user_observability_events event
          WHERE event.account_id = projection.account_id
            AND event.public_handle <> ''
          ORDER BY event.occurred_at DESC, event.id DESC
          LIMIT 1
        ) identity ON true
        WHERE badge.status = 'verified'
          AND badge.revoked_at IS NULL
          AND (badge.expires_at IS NULL OR badge.expires_at > now())
          AND badge.badge_id = ANY($2::text[])
          AND lower(projection.task_kind) = 'network'
          AND lower(projection.status) IN ('rewarded', 'paid', 'reward_decided')
      )
      SELECT *
      FROM role_tasks
      WHERE role_rank <= $1
      ORDER BY badge_id ASC, role_rank ASC
    `,
    [Math.min(Math.max(Number(perRole) || 10, 1), 20), Object.keys(roleDefinitions)]
  ).catch(() => ({ rows: [] }));
  const rows = result.rows.map((row) => taskRow(row, identityByAccount));
  return Object.fromEntries(Object.keys(roleDefinitions).map((role) => [
    role,
    rows.filter((row) => row.roleBadgeId === role),
  ]));
}

export async function listActiveTasksByRole({ perRole = 12, identityByAccount = new Map() } = {}) {
  const result = await query(
    `
      WITH role_tasks AS (
        SELECT badge.badge_id,
               definition.label AS badge_label,
               projection.*,
               identity.public_handle AS public_handle,
               row_number() OVER (
                 PARTITION BY badge.badge_id
                 ORDER BY projection.updated_at DESC, projection.task_id DESC
               ) AS role_rank
        FROM account_network_badges badge
        JOIN network_badge_definitions definition
          ON definition.badge_id = badge.badge_id
        JOIN task_projections projection
          ON projection.account_id = badge.account_id
        LEFT JOIN LATERAL (
          SELECT event.public_handle
          FROM user_observability_events event
          WHERE event.account_id = projection.account_id
            AND event.public_handle <> ''
          ORDER BY event.occurred_at DESC, event.id DESC
          LIMIT 1
        ) identity ON true
        WHERE badge.status = 'verified'
          AND badge.revoked_at IS NULL
          AND (badge.expires_at IS NULL OR badge.expires_at > now())
          AND badge.badge_id = ANY($2::text[])
          AND lower(projection.task_kind) = 'network'
          AND lower(projection.status) IN ('proposed', 'accepted', 'submitted', 'verification_requested')
      )
      SELECT *
      FROM role_tasks
      WHERE role_rank <= $1
      ORDER BY badge_id ASC, role_rank ASC
    `,
    [Math.min(Math.max(Number(perRole) || 12, 1), 24), Object.keys(roleDefinitions)]
  ).catch(() => ({ rows: [] }));
  const rows = result.rows.map((row) => taskRow(row, identityByAccount));
  return Object.fromEntries(Object.keys(roleDefinitions).map((role) => [
    role,
    rows.filter((row) => row.roleBadgeId === role),
  ]));
}

export async function listRecentHiveChats({ sinceHours = 24, projectLeaderOnly = false, productFeedbackOnly = false } = {}) {
  const filters = ["entry.deleted_at IS NULL", "entry.created_at >= now() - ($1::text)::interval"];
  const params = [`${Math.min(Math.max(Number(sinceHours) || 24, 1), 720)} hours`];
  if (projectLeaderOnly) {
    filters.push(`
      EXISTS (
        SELECT 1
        FROM account_network_badges badge
        WHERE badge.account_id = entry.account_id
          AND badge.badge_id = 'project_leader'
          AND badge.status = 'verified'
          AND badge.revoked_at IS NULL
          AND (badge.expires_at IS NULL OR badge.expires_at > now())
      )
    `);
  }
  if (productFeedbackOnly) {
    filters.push(`
      entry.body ~* '(bug|broken|error|issue|ux|ui|flow|profile|task|wallet|chat|loading|refresh|screenshot|feedback|report|docs|button|submit|reward)'
    `);
  }
  const result = await query(
    `
      SELECT entry.*
      FROM hive_context_entries entry
      WHERE ${filters.join(" AND ")}
      ORDER BY entry.created_at DESC, entry.id DESC
      LIMIT 80
    `,
    params
  ).catch(() => ({ rows: [] }));
  return result.rows.map(chatRow);
}

export async function listProjectSnapshot() {
  const document = await getHiveProjectsDocument({ includeEmptyActive: true }).catch(() => null);
  const projects = Object.values(safeObject(document?.projects));
  return {
    generatedAt: document?.generatedAt || new Date().toISOString(),
    stats: safeObject(document?.stats),
    projects: projects.map(compactProject).slice(0, 30),
  };
}

export function sourceCounts(source = {}) {
  return {
    roleAccountCount: safeArray(source.roles?.accounts).length,
    projectCount: safeArray(source.projects?.projects).length,
    rewardedTaskCount: Object.values(safeObject(source.rewardedTasksByRole)).reduce((sum, items) => sum + safeArray(items).length, 0),
    activeTaskCount: Object.values(safeObject(source.activeTasksByRole)).reduce((sum, items) => sum + safeArray(items).length, 0),
    hiveChatCount: safeArray(source.hiveChats).length,
    projectLeaderChatCount: safeArray(source.projectLeaderChats).length,
  };
}

export const hiveIntelligenceSourceReportTypes = Object.freeze([
  "operative",
  "rewarded_task",
  "kol",
  "development",
  "qa",
  "executive",
]);

export const boardManagerPlanningOutstandingStatuses = Object.freeze([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
]);

export const boardManagerPlanningTerminalStatuses = Object.freeze([
  "rewarded",
  "paid",
  "refused",
  "rejected",
  "cancelled",
  "expired",
  "rerouted",
  "failed",
  "completed",
]);

export function compactStoredReport(row = {}, { bodyMax = 18000 } = {}) {
  const type = safeText(row.type, 80);
  return {
    id: safeText(row.id, 180),
    type,
    label: hiveReportTypes[type]?.label || type,
    generatedAt: iso(row.generated_at),
    model: safeText(row.model, 180),
    bodyMarkdown: safeText(row.body_markdown, bodyMax),
    metadata: safeObject(row.metadata_json),
  };
}

export async function latestReportsForHiveIntelligence() {
  const result = await query(
    `
      SELECT *
      FROM (
        SELECT report.*,
               row_number() OVER (
                 PARTITION BY report.type
                 ORDER BY report.generated_at DESC, report.id DESC
               ) AS type_rank
        FROM hive_reports report
        WHERE report.type = ANY($1::text[])
      ) ranked
      WHERE type_rank = 1
      ORDER BY array_position($1::text[], type), generated_at DESC, id DESC
    `,
    [hiveIntelligenceSourceReportTypes]
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => compactStoredReport(row, { bodyMax: 16000 }));
}

export function compactReportForPlanning(report = null, { bodyMax = 24000 } = {}) {
  if (!report) return null;
  return {
    id: safeText(report.id, 180),
    type: safeText(report.type, 80),
    label: safeText(report.label, 120),
    generatedAt: safeText(report.generatedAt, 80),
    model: safeText(report.model, 180),
    bodyMarkdown: safeText(report.bodyMarkdown, bodyMax),
    metadata: {
      sourceCounts: safeObject(report.metadata?.sourceCounts),
      sourceRunId: safeText(report.metadata?.sourceRunId, 180),
    },
  };
}

export function compactPlanningTask(task = {}) {
  return {
    taskId: safeText(task.taskId || task.task_id, 180),
    requestId: safeText(task.requestId || task.request_id, 180),
    title: safeText(task.title, 260),
    status: safeText(task.state || task.status, 80),
    projectId: safeText(task.projectId || task.project_id, 180),
    projectTitle: safeText(task.projectTitle || task.project_title || task.project, 240),
    contributor: {
      accountId: safeText(task.assigneeAccountId || task.accountId || task.account_id, 180),
      handle: safeText(task.assigneeHandle || task.hiveHandle || task.handle, 160),
      walletAddress: safeText(task.assignee || task.walletAddress || task.subject_wallet || task.wallet, 120),
      displayName: safeText(task.assigneeDisplayName || task.displayName, 180),
    },
    rewardOfferPft: numeric(task.rewardOfferPft || task.reward_offer_pft || task.pft),
    rewardActualPft: numeric(task.rewardActualPft || task.reward_actual_pft),
    requiredBadgeId: safeText(task.requiredBadgeId || task.required_badge_id, 80),
    operatingBadgeId: safeText(task.operatingBadgeId || task.operating_badge_id, 80),
    updatedAt: iso(task.updatedAt || task.updated_at),
    lastEventAt: iso(task.lastEventAt || task.last_event_at),
    proposalSummary: safeText(task.description || task.proposal || task.projectNeedSummary || task.project_need_summary || "", 180),
    submissionRequirement: safeText(task.submissionRequirement || task.submission_requirement_text || "", 120),
    rewardProof: {
      txHash: safeText(task.proofTxHash || task.rewardTxHash || task.lastEventTxHash || task.last_event_tx_hash, 180),
      cid: safeText(task.proofCid || task.rewardCid || task.lastEventCid || task.last_event_cid, 180),
    },
  };
}

export function compactTaskForPlanningFeed(task = {}) {
  return {
    taskId: safeText(task.taskId, 180),
    title: safeText(task.title, 180),
    status: safeText(task.status, 80),
    projectId: safeText(task.projectId, 180),
    projectTitle: safeText(task.projectTitle, 180),
    contributor: {
      handle: safeText(task.contributor?.handle, 160),
      walletAddress: safeText(task.contributor?.walletAddress, 120),
    },
    rewardOfferPft: numeric(task.rewardOfferPft),
    rewardActualPft: numeric(task.rewardActualPft),
    requiredBadgeId: safeText(task.requiredBadgeId, 80),
    operatingBadgeId: safeText(task.operatingBadgeId, 80),
    updatedAt: safeText(task.updatedAt, 80),
  };
}

export function compactLiveTaskPacketTask(task = {}) {
  return {
    taskId: safeText(task.taskId, 180),
    title: safeText(task.title, 180),
    status: safeText(task.status || task.normalizedStatus, 80),
    projectId: safeText(task.projectId, 180),
    projectTitle: safeText(task.projectTitle, 180),
    rewardOfferPft: numeric(task.rewardOfferPft),
    rewardActualPft: numeric(task.rewardActualPft),
    updatedAt: safeText(task.updatedAt, 80),
  };
}

export function compactLiveTaskPacketContributorForPlanning(contributor = {}) {
  const profile = safeObject(contributor.profile);
  return {
    accountId: safeText(contributor.accountId, 180),
    walletAddress: safeText(contributor.walletAddress, 120),
    handle: safeText(contributor.handle, 160),
    displayName: safeText(contributor.displayName, 180),
    badges: safeArray(contributor.badges).slice(0, 8).map((badge) => safeText(badge, 120)).filter(Boolean),
    profile: profile
      ? {
          roleTitle: safeText(profile.roleTitle || profile.role_title, 160),
          roleSummary: safeText(profile.roleSummary || profile.role_summary, 260),
          skills: safeArray(profile.skills).slice(0, 5).map((skill) => safeText(skill, 80)).filter(Boolean),
          usefulTo: safeText(profile.usefulTo || profile.useful_to, 220),
        }
      : null,
    proposals: safeArray(contributor.proposals).slice(0, 2).map(compactLiveTaskPacketTask),
    outstanding: safeArray(contributor.outstanding).slice(0, 2).map(compactLiveTaskPacketTask),
    rewarded: safeArray(contributor.rewarded).slice(0, 2).map(compactLiveTaskPacketTask),
  };
}

export function taskStatusBucket(status = "") {
  const normalized = safeText(status, 80).toLowerCase();
  if (boardManagerPlanningOutstandingStatuses.includes(normalized)) return "outstanding";
  if (["rewarded", "paid", "reward_decided"].includes(normalized)) return "rewarded";
  if (boardManagerPlanningTerminalStatuses.includes(normalized)) return "terminal";
  return "other";
}

export function compactPlanningBoard(project = {}) {
  const tasks = safeArray(project.tasks).map(compactPlanningTask);
  const outstandingTasks = tasks.filter((task) => taskStatusBucket(task.status) === "outstanding").slice(0, 12);
  const recentRewardedTasks = tasks.filter((task) => taskStatusBucket(task.status) === "rewarded").slice(0, 5);
  const recentStoppedTasks = tasks.filter((task) => {
    const normalized = safeText(task.status, 80).toLowerCase();
    return boardManagerPlanningTerminalStatuses.includes(normalized) && !["rewarded", "paid"].includes(normalized);
  }).slice(0, 2);
  const memo = safeObject(project.secretaryMemo);
  return {
    projectId: safeText(project.id, 180),
    title: safeText(project.name || project.title, 220),
    type: safeText(project.type, 120),
    typeKey: safeText(project.typeKey, 80),
    status: safeText(project.status, 80),
    priority: Number(project.priority || 0),
    phase: safeText(project.phase, 120),
    summary: safeText(project.summary, 600),
    objective: safeText(project.objective, 800),
    about: safeText(project.about, 900),
    pftRouted: numeric(project.pft),
    taskCount: Number(project.taskCount ?? safeArray(project.tasks).length ?? 0),
    tasksInFlight: Number(project.tasksInFlight ?? outstandingTasks.length ?? 0),
    terminalTaskCount: Number(project.terminalTaskCount ?? 0),
    contributorCount: Number(project.contributorCount ?? safeArray(project.contributors).length ?? 0),
    pendingGenerationCount: Number(project.pendingGenerationCount ?? 0),
    planned: {
      pftTarget: numeric(project.plannedPftTarget),
      taskCount: Number(project.plannedTaskCount || 0),
      contributorTarget: Number(project.plannedContributorTarget || 0),
    },
    contributors: safeArray(project.contributors).slice(0, 8).map((contributor) => ({
      accountId: safeText(contributor.accountId, 180),
      walletAddress: safeText(contributor.wallet, 120),
      handle: safeText(contributor.handle || contributor.hiveHandle, 160),
      displayName: safeText(contributor.displayName || contributor.codename, 180),
      role: safeText(contributor.role, 120),
      allotted: contributor.allotted === true,
      pft: numeric(contributor.pft),
      tasks: Number(contributor.tasks || 0),
    })),
    outstandingTasks,
    recentRewardedTasks,
    recentStoppedTasks,
    secretaryMemo: memo?.id
      ? {
          id: safeText(memo.id, 180),
          generatedAt: safeText(memo.generatedAt, 80),
          sourceCounts: safeObject(memo.sourceCounts),
          memoMarkdown: safeText(memo.memoMarkdown, 2000),
        }
      : null,
    comments: safeArray(project.comments).slice(0, 8).map((comment) => ({
      id: safeText(comment.id, 180),
      accountId: safeText(comment.accountId, 180),
      displayName: safeText(comment.displayName, 180),
      body: safeText(comment.body, 600),
      createdAt: safeText(comment.createdAt, 80),
    })),
    nextTask: project.nextTask ? compactPlanningTask(project.nextTask) : null,
  };
}
