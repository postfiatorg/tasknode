import { query } from "../db/pool.js";
import { listAccountIdentityProfiles } from "./account-profiles.js";
import { getHiveLiveTaskPacket } from "./hive-live-task-packet.js";
import { getLatestTaskAccountingHarvestReport } from "./task-accounting-harvester.js";
import {
  firstText,
  hiveReportTypes,
  identitySummary,
  iso,
  numeric,
  reportRow,
  safeArray,
  safeObject,
  safeText,
  tableReportType,
  useDatabase,
} from "./hive-report-contract.js";
import {
  boardManagerPlanningOutstandingStatuses,
  boardManagerPlanningTerminalStatuses,
  compactLiveTaskPacketContributorForPlanning,
  compactPlanningBoard,
  compactPlanningTask,
  compactReportForPlanning,
  compactTaskForPlanningFeed,
  hiveIntelligenceSourceReportTypes,
  latestReportsForHiveIntelligence,
  taskStatusBucket,
} from "./hive-report-source-base.js";

async function latestHiveReportForPlanning({ type = "" } = {}) {
  const normalizedType = tableReportType(type);
  if (!useDatabase()) return null;
  const result = await query(
    `
      SELECT r.*,
             (
               SELECT count(*)::int
               FROM hive_report_verifications verification
               WHERE verification.report_id = r.id
             ) AS verification_count
      FROM hive_reports r
      WHERE r.type = $1
      ORDER BY r.generated_at DESC, r.id DESC
      LIMIT 1
    `,
    [normalizedType]
  );
  return result.rows[0] ? reportRow(result.rows[0]) : null;
}

export async function activeBoardStatesForBoardManagerPlanning() {
  if (!useDatabase()) {
    return {
      ok: false,
      error: "database_not_configured",
      generatedAt: "",
      stats: {},
      boards: [],
    };
  }
  let projectRows = [];
  let taskRows = [];
  let contributorRows = [];
  let memoRows = [];
  try {
    const result = await Promise.all([
      query(
        `
          SELECT *
          FROM network_projects
          WHERE status = 'active'
          ORDER BY priority ASC NULLS LAST, title ASC, id ASC
        `
      ),
      query(
        `
          SELECT refs.project_id,
                 project.title AS project_title,
                 COALESCE(projection.task_id, refs.task_id, '') AS task_id,
                 COALESCE(projection.request_id, refs.request_id, '') AS request_id,
                 COALESCE(projection.account_id, refs.metadata_json #>> '{accountId}', '') AS account_id,
                 COALESCE(projection.subject_wallet, refs.assignee_wallet, '') AS subject_wallet,
                 COALESCE(projection.status, refs.state, '') AS status,
                 COALESCE(projection.title, refs.title, '') AS title,
                 projection.description,
                 projection.submission_requirement_text,
                 COALESCE(projection.reward_offer_pft, refs.reward_pft, 0) AS reward_offer_pft,
                 projection.reward_actual_pft,
                 projection.updated_at,
                 projection.last_event_at,
                 projection.last_event_tx_hash,
                 projection.last_event_cid,
                 COALESCE(
                   projection.metadata_json #>> '{generatedTask,network_task,required_badge_id}',
                   projection.metadata_json #>> '{generatedTask,network_task,requiredBadgeId}',
                   ''
                 ) AS required_badge_id,
                 COALESCE(
                   projection.metadata_json #>> '{generatedTask,network_task,operating_badge_id}',
                   projection.metadata_json #>> '{generatedTask,network_task,operatingBadgeId}',
                   ''
                 ) AS operating_badge_id
          FROM network_project_task_refs refs
          JOIN network_projects project
            ON project.id = refs.project_id
           AND project.status = 'active'
          LEFT JOIN task_projections projection
            ON projection.task_id = refs.task_id
          ORDER BY refs.project_id ASC,
                   COALESCE(projection.updated_at, refs.updated_at) DESC NULLS LAST,
                   refs.sort_order ASC,
                   refs.id ASC
          LIMIT 700
        `
      ),
      query(
        `
          SELECT *
          FROM network_project_contributors
          WHERE project_id IN (
            SELECT id
            FROM network_projects
            WHERE status = 'active'
          )
            AND status = 'active'
          ORDER BY project_id ASC, allotted DESC, pft_earned DESC, task_count DESC, sort_order ASC, wallet_address ASC
          LIMIT 240
        `
      ),
      query(
        `
          SELECT *
          FROM hive_board_secretary_memos
          WHERE status = 'current'
            AND superseded_at IS NULL
            AND project_id IN (
              SELECT id
              FROM network_projects
              WHERE status = 'active'
            )
          ORDER BY generated_at DESC, id DESC
        `
      ),
    ]);
    [projectRows, taskRows, contributorRows, memoRows] = result.map((item) => item.rows || []);
  } catch (error) {
    return {
      ok: false,
      error: safeText(error?.message || "board_state_unavailable", 500),
      generatedAt: "",
      stats: {},
      boards: [],
    };
  }
  const tasksByProject = new Map();
  for (const row of taskRows) {
    const projectId = safeText(row.project_id, 180);
    if (!projectId) continue;
    if (!tasksByProject.has(projectId)) tasksByProject.set(projectId, []);
    tasksByProject.get(projectId).push(planningTaskRow(row));
  }
  const contributorsByProject = new Map();
  for (const row of contributorRows) {
    const projectId = safeText(row.project_id, 180);
    if (!projectId) continue;
    if (!contributorsByProject.has(projectId)) contributorsByProject.set(projectId, []);
    contributorsByProject.get(projectId).push({
      wallet: row.wallet_address,
      handle: row.codename,
      displayName: row.codename,
      role: row.role_label || row.archetype,
      allotted: row.allotted === true,
      pft: row.pft_earned,
      tasks: row.task_count,
    });
  }
  const memoByProject = new Map();
  for (const row of memoRows) {
    const projectId = safeText(row.project_id, 180);
    if (!projectId || memoByProject.has(projectId)) continue;
    memoByProject.set(projectId, {
      id: row.id,
      generatedAt: iso(row.generated_at),
      sourceCounts: safeObject(row.source_counts_json),
      memoMarkdown: row.memo_markdown,
    });
  }
  const boards = projectRows.map((row) => {
    const tasks = tasksByProject.get(row.id) || [];
    const outstandingTaskCount = tasks.filter((task) => taskStatusBucket(task.status) === "outstanding").length;
    const terminalTaskCount = tasks.filter((task) => taskStatusBucket(task.status) === "terminal" || taskStatusBucket(task.status) === "rewarded").length;
    const contributorKeys = new Set(
      tasks.map((task) => task.contributor?.accountId || task.contributor?.walletAddress).filter(Boolean)
    );
    const explicitContributorCount = safeArray(contributorsByProject.get(row.id)).length;
    return compactPlanningBoard({
      id: row.id,
      name: row.title,
      title: row.title,
      type: row.type,
      status: row.status,
      priority: row.priority,
      phase: row.phase_label,
      summary: row.summary,
      objective: row.objective,
      about: row.about,
      pft: row.pft_routed,
      taskCount: Number(row.task_count || tasks.length || 0),
      tasksInFlight: outstandingTaskCount,
      terminalTaskCount,
      contributorCount: Math.max(Number(row.contributor_count || 0), explicitContributorCount, contributorKeys.size),
      pendingGenerationCount: 0,
      contributors: contributorsByProject.get(row.id) || [],
      tasks,
      secretaryMemo: memoByProject.get(row.id) || null,
      comments: [],
      nextTask: tasks.find((task) => taskStatusBucket(task.status) === "outstanding") || null,
    });
  });
  const stats = {
    activeProjects: boards.length,
    taskRows: boards.reduce((total, board) => total + Number(board.taskCount || 0), 0),
    tasksInFlight: boards.reduce((total, board) => total + Number(board.tasksInFlight || 0), 0),
    terminalTaskRows: boards.reduce((total, board) => total + Number(board.terminalTaskCount || 0), 0),
    pftRouted: boards.reduce((total, board) => total + numeric(board.pftRouted), 0),
    contributors: boards.reduce((total, board) => total + Number(board.contributorCount || 0), 0),
  };
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    stats,
    boards,
  };
}

export function planningTaskRow(row = {}) {
  const metadata = safeObject(row.metadata_json);
  const generatedTask = safeObject(metadata.generatedTask);
  const networkTask = safeObject(generatedTask.network_task || metadata.network_task);
  return compactPlanningTask({
    taskId: row.task_id,
    requestId: row.request_id,
    accountId: row.account_id,
    subject_wallet: row.subject_wallet,
    status: row.status,
    title: row.title,
    description: row.description,
    submission_requirement_text: row.submission_requirement_text,
    reward_offer_pft: row.reward_offer_pft,
    reward_actual_pft: row.reward_actual_pft,
    updated_at: row.updated_at,
    last_event_at: row.last_event_at,
    last_event_tx_hash: row.last_event_tx_hash,
    last_event_cid: row.last_event_cid,
    project_id: row.project_id,
    project_title: row.project_title,
    required_badge_id: row.required_badge_id || networkTask.required_badge_id || networkTask.requiredBadgeId,
    operating_badge_id: row.operating_badge_id || networkTask.operating_badge_id || networkTask.operatingBadgeId,
  });
}

export async function liveTaskFeedForBoardManagerPlanning() {
  if (!useDatabase()) {
    return {
      outstandingNetworkTasks: [],
      recentTerminalNetworkTasks: [],
      pendingGenerationJobs: [],
    };
  }
  const [outstanding, terminal, generationJobs] = await Promise.all([
    query(
      `
        SELECT projection.*,
               COALESCE(refs.project_id, projection.metadata_json #>> '{generatedTask,network_task,project_id}', '') AS project_id,
               project.title AS project_title,
               COALESCE(
                 projection.metadata_json #>> '{generatedTask,network_task,required_badge_id}',
                 projection.metadata_json #>> '{generatedTask,network_task,requiredBadgeId}',
                 ''
               ) AS required_badge_id,
               COALESCE(
                 projection.metadata_json #>> '{generatedTask,network_task,operating_badge_id}',
                 projection.metadata_json #>> '{generatedTask,network_task,operatingBadgeId}',
                 ''
               ) AS operating_badge_id
        FROM task_projections projection
        LEFT JOIN network_project_task_refs refs
          ON refs.task_id = projection.task_id
        LEFT JOIN network_projects project
          ON project.id = COALESCE(refs.project_id, projection.metadata_json #>> '{generatedTask,network_task,project_id}', '')
        WHERE lower(projection.task_kind) = 'network'
          AND lower(projection.status) = ANY($1::text[])
        ORDER BY projection.updated_at DESC NULLS LAST, projection.task_id DESC
        LIMIT 140
      `,
      [boardManagerPlanningOutstandingStatuses]
    ).catch(() => ({ rows: [] })),
    query(
      `
        SELECT projection.*,
               COALESCE(refs.project_id, projection.metadata_json #>> '{generatedTask,network_task,project_id}', '') AS project_id,
               project.title AS project_title,
               COALESCE(
                 projection.metadata_json #>> '{generatedTask,network_task,required_badge_id}',
                 projection.metadata_json #>> '{generatedTask,network_task,requiredBadgeId}',
                 ''
               ) AS required_badge_id,
               COALESCE(
                 projection.metadata_json #>> '{generatedTask,network_task,operating_badge_id}',
                 projection.metadata_json #>> '{generatedTask,network_task,operatingBadgeId}',
                 ''
               ) AS operating_badge_id
        FROM task_projections projection
        LEFT JOIN network_project_task_refs refs
          ON refs.task_id = projection.task_id
        LEFT JOIN network_projects project
          ON project.id = COALESCE(refs.project_id, projection.metadata_json #>> '{generatedTask,network_task,project_id}', '')
        WHERE lower(projection.task_kind) = 'network'
          AND lower(projection.status) = ANY($1::text[])
        ORDER BY projection.updated_at DESC NULLS LAST, projection.task_id DESC
        LIMIT 20
      `,
      [boardManagerPlanningTerminalStatuses]
    ).catch(() => ({ rows: [] })),
    query(
      `
        SELECT job.id,
               job.project_id,
               project.title AS project_title,
               job.status,
               job.allocation_id,
               job.request_id,
               job.task_id,
               job.candidate_account_id,
               job.candidate_wallet_address,
               job.project_need_summary,
               job.task_work_type,
               job.required_badge_id,
               job.operating_badge_id,
               job.reward_min_pft,
               job.reward_max_pft,
               job.created_at,
               job.updated_at
        FROM network_task_generation_jobs job
        LEFT JOIN network_projects project
          ON project.id = job.project_id
        WHERE job.status IN ('queued', 'running', 'generated', 'link_failed')
        ORDER BY job.updated_at DESC NULLS LAST, job.id DESC
        LIMIT 100
      `
    ).catch(() => ({ rows: [] })),
  ]);
  return {
    outstandingNetworkTasks: outstanding.rows.map(planningTaskRow).map(compactTaskForPlanningFeed),
    recentTerminalNetworkTasks: terminal.rows.map(planningTaskRow).map(compactTaskForPlanningFeed),
    pendingGenerationJobs: generationJobs.rows.map((row) => ({
      id: safeText(row.id, 180),
      projectId: safeText(row.project_id, 180),
      projectTitle: safeText(row.project_title, 220),
      status: safeText(row.status, 80),
      allocationId: safeText(row.allocation_id, 180),
      requestId: safeText(row.request_id, 180),
      taskId: safeText(row.task_id, 180),
      candidateAccountId: safeText(row.candidate_account_id, 180),
      candidateWalletAddress: safeText(row.candidate_wallet_address, 120),
      projectNeedSummary: safeText(row.project_need_summary, 320),
      taskWorkType: safeText(row.task_work_type, 120),
      requiredBadgeId: safeText(row.required_badge_id, 80),
      operatingBadgeId: safeText(row.operating_badge_id, 80),
      rewardMinPft: numeric(row.reward_min_pft),
      rewardMaxPft: numeric(row.reward_max_pft),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })),
  };
}

export async function boardCommentsForBoardManagerPlanning(identityByAccount) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT entry.id,
             entry.account_id,
             entry.display_name,
             entry.body,
             entry.created_at,
             entry.metadata_json,
             COALESCE(
               entry.metadata_json #>> '{projectComment,projectId}',
               entry.metadata_json #>> '{project_comment,project_id}',
               entry.metadata_json #>> '{metadata,projectComment,projectId}',
               ''
             ) AS project_id,
             project.title AS project_title
      FROM hive_context_entries entry
      LEFT JOIN network_projects project
        ON project.id = COALESCE(
          entry.metadata_json #>> '{projectComment,projectId}',
          entry.metadata_json #>> '{project_comment,project_id}',
          entry.metadata_json #>> '{metadata,projectComment,projectId}',
          ''
        )
      WHERE entry.deleted_at IS NULL
        AND (
          entry.metadata_json->>'kind' = 'hive_project_comment'
          OR entry.metadata_json->>'source' = 'project_board'
          OR COALESCE(entry.metadata_json #>> '{projectComment,projectId}', '') <> ''
          OR COALESCE(entry.metadata_json #>> '{project_comment,project_id}', '') <> ''
        )
      ORDER BY entry.created_at DESC, entry.id DESC
      LIMIT 240
    `
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({
    id: safeText(row.id, 180),
    projectId: safeText(row.project_id, 180),
    projectTitle: safeText(row.project_title, 220),
    accountId: safeText(row.account_id, 180),
    speaker: identitySummary(row.account_id, { displayName: row.display_name }, identityByAccount),
    body: safeText(row.body, 700),
    createdAt: iso(row.created_at),
  }));
}

export async function projectLeaderContextForBoardManagerPlanning({ sinceHours = 72, identityByAccount = new Map() } = {}) {
  if (!useDatabase()) return [];
  const hours = Math.min(Math.max(Number(sinceHours) || 72, 1), 720);
  const result = await query(
    `
      SELECT entry.id,
             entry.account_id,
             entry.display_name,
             entry.body,
             entry.source_conversation_title,
             entry.created_at,
             entry.metadata_json
      FROM hive_context_entries entry
      WHERE entry.deleted_at IS NULL
        AND entry.created_at >= now() - ($1::text)::interval
        AND EXISTS (
          SELECT 1
          FROM account_network_badges badge
          WHERE badge.account_id = entry.account_id
            AND badge.badge_id = 'project_leader'
            AND badge.status = 'verified'
            AND badge.revoked_at IS NULL
            AND (badge.expires_at IS NULL OR badge.expires_at > now())
        )
      ORDER BY entry.created_at DESC, entry.id DESC
      LIMIT 120
    `,
    [`${hours} hours`]
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({
    id: safeText(row.id, 180),
    accountId: safeText(row.account_id, 180),
    speaker: identitySummary(row.account_id, { displayName: row.display_name }, identityByAccount),
    body: safeText(row.body, 800),
    sourceConversationTitle: safeText(row.source_conversation_title, 160),
    createdAt: iso(row.created_at),
    metadata: safeObject(row.metadata_json),
  }));
}

export async function archivedBoardIndexForBoardManagerPlanning({ limit = 80 } = {}) {
  if (!useDatabase()) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 24, 1), 80);
  const result = await query(
    `
      SELECT project.id,
             project.title,
             project.type,
             project.status,
             project.priority,
             project.summary,
             project.objective,
             project.pft_routed,
             project.task_count,
             project.contributor_count,
             project.metadata_json,
             project.updated_at,
             (
               SELECT count(*)::int
               FROM network_project_task_refs refs
               WHERE refs.project_id = project.id
             ) AS task_ref_count,
             (
               SELECT max(COALESCE(projection.last_event_at, projection.updated_at, refs.updated_at))
               FROM network_project_task_refs refs
               LEFT JOIN task_projections projection
                 ON projection.task_id = refs.task_id
               WHERE refs.project_id = project.id
             ) AS last_task_activity_at
      FROM network_projects project
      WHERE project.status = 'archived'
      ORDER BY COALESCE(
        (
          SELECT max(COALESCE(projection.last_event_at, projection.updated_at, refs.updated_at))
          FROM network_project_task_refs refs
          LEFT JOIN task_projections projection
            ON projection.task_id = refs.task_id
          WHERE refs.project_id = project.id
        ),
        project.updated_at
      ) DESC NULLS LAST,
      project.priority ASC,
      project.title ASC
      LIMIT $1
    `,
    [safeLimit]
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => {
    const metadata = safeObject(row.metadata_json);
    return {
      projectId: safeText(row.id, 180),
      title: safeText(row.title, 220),
      type: safeText(row.type, 120),
      priority: Number(row.priority || 0),
      summary: safeText(row.summary || row.objective, 700),
      pftRouted: numeric(row.pft_routed),
      taskCount: Number(row.task_ref_count || row.task_count || 0),
      contributorCount: Number(row.contributor_count || 0),
      status: "archived",
      archivedReason: safeText(metadata.archived_reason || metadata.archive_reason, 900),
      archivedAt: safeText(metadata.archived_at || metadata.archive_at, 80),
      operatorArchiveLock: Boolean(metadata.operator_archived === true || metadata.archive_lock_source || metadata.archive_lock_applied_at),
      lastActivityAt: iso(row.last_task_activity_at || row.updated_at),
    };
  });
}

export async function currentBoardSecretaryMemosForHiveIntelligence({ limit = 40 } = {}) {
  const result = await query(
    `
      SELECT memo.*,
             project.title AS project_title,
             project.type AS project_type,
             project.priority AS project_priority,
             project.pft_routed AS project_pft_routed,
             project.task_count AS project_task_count
      FROM hive_board_secretary_memos memo
      LEFT JOIN network_projects project
        ON project.id = memo.project_id
      WHERE memo.status = 'current'
        AND memo.superseded_at IS NULL
      ORDER BY project.priority ASC NULLS LAST, memo.generated_at DESC, memo.id DESC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 40, 1), 100)]
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({
    id: safeText(row.id, 180),
    projectId: safeText(row.project_id, 180),
    projectTitle: safeText(row.project_title, 220),
    projectType: safeText(row.project_type, 120),
    projectPriority: Number(row.project_priority || 0),
    projectPftRouted: numeric(row.project_pft_routed),
    projectTaskCount: Number(row.project_task_count || 0),
    generatedAt: iso(row.generated_at),
    model: safeText(row.model, 180),
    sourceCounts: safeObject(row.source_counts_json),
    memoMarkdown: safeText(row.memo_markdown, 10000),
  }));
}

export function badgeHandleFromEvidence(row = {}) {
  const evidence = safeObject(row.evidence_json || row.evidence);
  const nestedEvidence = safeObject(evidence.evidence);
  const metrics = safeObject(row.validated_metrics_json || row.metrics);
  return firstText(
    row.public_handle,
    row.provider_handle,
    nestedEvidence.handle,
    nestedEvidence.githubHandle,
    nestedEvidence.xHandle,
    nestedEvidence.username,
    evidence.handle,
    evidence.githubHandle,
    evidence.xHandle,
    evidence.username,
    metrics.handle,
    metrics.githubHandle,
    metrics.xHandle,
    metrics.username
  ).replace(/^@+/, "");
}

export function compactBadgeOperator(row = {}) {
  const handle = badgeHandleFromEvidence(row);
  return {
    accountId: safeText(row.account_id, 180),
    handle: handle ? `@${handle}` : "",
    walletAddress: safeText(row.wallet_address, 120),
    badgeId: safeText(row.badge_id, 80),
    badgeLabel: safeText(row.badge_label || row.label, 120),
  };
}

export function compactRoutingConstraintOperator(operator = {}) {
  return {
    accountId: safeText(operator.accountId || operator.account_id, 180),
    handle: safeText(operator.handle, 160),
    walletAddress: safeText(operator.walletAddress || operator.wallet_address, 120),
    badgeId: safeText(operator.badgeId || operator.badge_id, 80),
    badgeLabel: safeText(operator.badgeLabel || operator.badge_label, 120),
  };
}

export function compactTaskRoutingConstraintsForPlanning(constraints = {}) {
  const sourceOperatorsByBadge = safeObject(constraints.eligibleOperatorsByBadge);
  const eligibleOperatorsByBadge = Object.fromEntries(
    Object.entries(sourceOperatorsByBadge).map(([badgeId, operators]) => [
      safeText(badgeId, 80),
      safeArray(operators).slice(0, 6).map(compactRoutingConstraintOperator),
    ])
  );
  const activeTaskRequirements = safeArray(constraints.activeTaskRequirements).slice(0, 32).map((task) => ({
    taskId: safeText(task.taskId, 180),
    title: safeText(task.title, 220),
    status: safeText(task.status, 80),
    projectId: safeText(task.projectId, 180),
    projectTitle: safeText(task.projectTitle, 220),
    rewardOfferPft: numeric(task.rewardOfferPft),
    requiredBadgeId: safeText(task.requiredBadgeId, 80),
    operatingBadgeId: safeText(task.operatingBadgeId, 80),
    currentAssignee: {
      accountId: safeText(task.currentAssignee?.accountId, 180),
      walletAddress: safeText(task.currentAssignee?.walletAddress, 120),
    },
    eligibleReplacementOperators: safeArray(task.eligibleReplacementOperators).slice(0, 3).map(compactRoutingConstraintOperator),
    eligibilityNote: safeText(task.eligibilityNote, 240),
  }));
  return {
    schema: safeText(constraints.schema, 180) || "pf.task_node.hive_intelligence_task_routing_constraints.v1",
    rulePromptFiles: safeArray(constraints.rulePromptFiles).map((path) => safeText(path, 240)).filter(Boolean),
    activeTaskRequirements,
    eligibleOperatorsByBadge,
  };
}

export async function taskRoutingConstraintsForHiveIntelligence({ limit = 80 } = {}) {
  const rulePromptFiles = [
    "prompts/hive/reports/hive_intelligence_v1.md",
    "prompts/hive/reports/board_manager_planning_v1.md",
  ];
  if (!useDatabase()) {
    return {
      schema: "pf.task_node.hive_intelligence_task_routing_constraints.v1",
      rulePromptFiles,
      activeTaskRequirements: [],
      eligibleOperatorsByBadge: {},
    };
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 80, 1), 120);
  const [taskRows, badgeRows] = await Promise.all([
    query(
      `
        SELECT tp.task_id,
               tp.title,
               tp.status,
               tp.account_id,
               tp.subject_wallet,
               tp.reward_offer_pft,
               tp.updated_at,
               COALESCE(refs.project_id, tp.metadata_json #>> '{generatedTask,network_task,project_id}', '') AS project_id,
               project.title AS project_title,
               COALESCE(
                 tp.metadata_json #>> '{generatedTask,network_task,required_badge_id}',
                 tp.metadata_json #>> '{generatedTask,network_task,requiredBadgeId}',
                 tp.metadata_json #>> '{generatedTask,network_task,operating_badge_id}',
                 tp.metadata_json #>> '{generatedTask,network_task,operatingBadgeId}',
                 ''
               ) AS required_badge_id,
               COALESCE(
                 tp.metadata_json #>> '{generatedTask,network_task,operating_badge_id}',
                 tp.metadata_json #>> '{generatedTask,network_task,operatingBadgeId}',
                 tp.metadata_json #>> '{generatedTask,network_task,required_badge_id}',
                 tp.metadata_json #>> '{generatedTask,network_task,requiredBadgeId}',
                 ''
               ) AS operating_badge_id
        FROM task_projections tp
        LEFT JOIN network_project_task_refs refs
          ON refs.task_id = tp.task_id
        LEFT JOIN network_projects project
          ON project.id = COALESCE(refs.project_id, tp.metadata_json #>> '{generatedTask,network_task,project_id}', '')
        WHERE tp.status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'reward_decided')
          AND (
            tp.task_kind = 'network'
            OR refs.id IS NOT NULL
            OR tp.metadata_json #>> '{generatedTask,network_task,task_class}' = 'network'
          )
        ORDER BY tp.updated_at DESC NULLS LAST, tp.task_id ASC
        LIMIT $1
      `,
      [safeLimit]
    ).catch(() => ({ rows: [] })),
    query(
      `
        SELECT badge.account_id,
               badge.badge_id,
               definition.label AS badge_label,
               badge.evidence_json,
               badge.validated_metrics_json,
               ''::text AS wallet_address
        FROM account_network_badges badge
        JOIN network_badge_definitions definition
          ON definition.badge_id = badge.badge_id
        WHERE badge.status = 'verified'
          AND badge.revoked_at IS NULL
          AND (badge.expires_at IS NULL OR badge.expires_at > now())
        ORDER BY badge.badge_id ASC, badge.account_id ASC
      `
    ).catch(() => ({ rows: [] })),
  ]);
  const operatorsByBadge = new Map();
  for (const row of badgeRows.rows) {
    const badgeId = safeText(row.badge_id, 80);
    if (!badgeId) continue;
    if (!operatorsByBadge.has(badgeId)) operatorsByBadge.set(badgeId, []);
    const operator = compactBadgeOperator(row);
    const existing = operatorsByBadge.get(badgeId);
    if (!existing.some((item) => item.accountId === operator.accountId)) existing.push(operator);
  }
  const eligibleOperatorsByBadge = Object.fromEntries(
    Array.from(operatorsByBadge.entries()).map(([badgeId, operators]) => [badgeId, operators.slice(0, 40)])
  );
  const activeTaskRequirements = taskRows.rows.map((row) => {
    const requiredBadgeId = safeText(row.required_badge_id, 80);
    const operatingBadgeId = safeText(row.operating_badge_id || requiredBadgeId, 80);
    const currentAccountId = safeText(row.account_id, 180);
    const eligibleOperators = requiredBadgeId ? operatorsByBadge.get(requiredBadgeId) || [] : [];
    return {
      taskId: safeText(row.task_id, 180),
      title: safeText(row.title, 220),
      status: safeText(row.status, 80),
      projectId: safeText(row.project_id, 180),
      projectTitle: safeText(row.project_title, 220),
      rewardOfferPft: numeric(row.reward_offer_pft),
      requiredBadgeId,
      operatingBadgeId,
      currentAssignee: {
        accountId: currentAccountId,
        walletAddress: safeText(row.subject_wallet, 120),
      },
      eligibleReplacementOperators: eligibleOperators
        .filter((operator) => operator.accountId && operator.accountId !== currentAccountId)
        .slice(0, 16),
      eligibilityNote: requiredBadgeId
        ? "Badge eligibility only; final routing must still enforce capacity, wallet, and current-task blockers."
        : "No required badge was extracted; do not recommend named reassignment without a routing executor check.",
    };
  });
  return {
    schema: "pf.task_node.hive_intelligence_task_routing_constraints.v1",
    rulePromptFiles,
    activeTaskRequirements,
    eligibleOperatorsByBadge,
  };
}

export async function buildHiveIntelligenceReportSourcePacket({ now = new Date() } = {}) {
  const [
    upstreamReports,
    harvestReport,
    liveTaskPacket,
    boardSecretaryMemos,
    taskRoutingConstraints,
  ] = await Promise.all([
    latestReportsForHiveIntelligence(),
    getLatestTaskAccountingHarvestReport({ generate: true }).catch((error) => ({
      ok: false,
      error: safeText(error?.message || "harvest_report_unavailable", 300),
      report: null,
    })),
    getHiveLiveTaskPacket({ limit: 24 }).catch((error) => ({
      ok: false,
      error: safeText(error?.message || "live_task_packet_unavailable", 300),
      packet: null,
    })),
    currentBoardSecretaryMemosForHiveIntelligence({ limit: 40 }),
    taskRoutingConstraintsForHiveIntelligence({ limit: 80 }),
  ]);
  const missingReportTypes = hiveIntelligenceSourceReportTypes.filter(
    (type) => !upstreamReports.some((report) => report.type === type)
  );
  const source = {
    schema: "pf.task_node.hive_intelligence_report_source_packet.v1",
    type: "hive_intelligence",
    label: hiveReportTypes.hive_intelligence.label,
    generatedAt: now.toISOString(),
    focus: hiveReportTypes.hive_intelligence.summary,
    northStar: {
      asset: "PFT",
      premise: "Post Fiat is a cryptocurrency and the base reward asset of the Hive Mind. Network strategy should increase PFT value by routing rewards toward work that grows community, improves product capability, and shapes useful economic outcomes.",
      availableActions: [
        "deploy tasks to members",
        "send messages to people",
        "recommend founder-level changes to Task Node or other network assets",
      ],
    },
    sourceReports: upstreamReports,
    harvestReport: harvestReport?.report || null,
    liveTaskPacket: liveTaskPacket?.packet || null,
    boardSecretaryMemos,
    taskRoutingConstraints,
    missingReportTypes,
  };
  return {
    ...source,
    sourceCounts: {
      upstreamReportCount: upstreamReports.length,
      missingReportTypeCount: missingReportTypes.length,
      boardSecretaryMemoCount: boardSecretaryMemos.length,
      constrainedActiveTaskCount: safeArray(taskRoutingConstraints?.activeTaskRequirements).length,
      harvestReportPresent: Boolean(harvestReport?.report),
      liveTaskPacketContributorCount: safeArray(liveTaskPacket?.packet?.contributors).length,
    },
  };
}

export async function buildBoardManagerPlanningReportSourcePacket({ now = new Date() } = {}) {
  const identityByAccount = new Map((await listAccountIdentityProfiles())
    .map((profile) => [safeText(profile.accountId, 180), profile]));
  const boardStates = await activeBoardStatesForBoardManagerPlanning();
  const [
    intelligenceReport,
    liveTaskFeed,
    boardComments,
    projectLeaderContext,
    archivedBoards,
    liveTaskPacket,
    taskRoutingConstraints,
  ] = await Promise.all([
    latestHiveReportForPlanning({ type: "hive_intelligence" }).catch(() => null),
    liveTaskFeedForBoardManagerPlanning(),
    boardCommentsForBoardManagerPlanning(identityByAccount),
    projectLeaderContextForBoardManagerPlanning({ sinceHours: 72, identityByAccount }),
    archivedBoardIndexForBoardManagerPlanning({ limit: 12 }),
    getHiveLiveTaskPacket({ limit: 40 }).catch((error) => ({
      ok: false,
      error: safeText(error?.message || "live_task_packet_unavailable", 300),
      packet: null,
    })),
    taskRoutingConstraintsForHiveIntelligence({ limit: 80 }),
  ]);
  const source = {
    schema: "pf.task_node.board_manager_planning_report_source_packet.v1",
    type: "board_manager_planning",
    label: hiveReportTypes.board_manager_planning.label,
    generatedAt: now.toISOString(),
    focus: hiveReportTypes.board_manager_planning.summary,
    northStar: {
      asset: "PFT",
      executableActionVocabulary: ["ADD_BOARD", "ARCHIVE_BOARD", "UNARCHIVE_BOARD"],
      advisoryOnly: true,
    },
    planningRules: {
      cadence: "3 hours",
      reasoningEffort: "high",
      archivePosture: "risk_averse_high_intensity_action",
      promptFiles: [
        "prompts/hive/reports/hive_report_common_v1.md",
        "prompts/hive/reports/board_manager_planning_v1.md",
        "prompts/hive/reports/phase_initial_v1.md",
      ],
    },
    activeBoardAuthority: {
      source: "boardStates.boards",
      activeBoardIds: safeArray(boardStates.boards).map((board) => board.projectId).filter(Boolean),
    },
    hiveIntelligenceReport: compactReportForPlanning(intelligenceReport, { bodyMax: 12000 }),
    boardStates,
    liveTaskFeed,
    boardComments,
    projectLeaderContext,
    liveTaskPacket: liveTaskPacket?.packet
      ? {
          generatedAt: safeText(liveTaskPacket.packet.generatedAt, 80),
          refreshCadenceSeconds: Number(liveTaskPacket.packet.refreshCadenceSeconds || 0),
          contributorCount: Number(liveTaskPacket.packet.contributorCount || safeArray(liveTaskPacket.packet.contributors).length || 0),
          contributors: safeArray(liveTaskPacket.packet.contributors).slice(0, 8).map(compactLiveTaskPacketContributorForPlanning),
          text: safeText(liveTaskPacket.packet.text, 1000),
        }
      : {
          unavailable: true,
          error: safeText(liveTaskPacket?.error || "live_task_packet_unavailable", 300),
        },
    taskRoutingConstraints: compactTaskRoutingConstraintsForPlanning(taskRoutingConstraints),
    archivedBoardIndex: archivedBoards,
  };
  return {
    ...source,
    sourceCounts: {
      activeBoardCount: safeArray(boardStates.boards).length,
      archivedBoardIndexCount: safeArray(archivedBoards).length,
      boardStateAvailable: boardStates.ok === true,
      boardStateError: safeText(boardStates.error, 500),
      outstandingNetworkTaskCount: safeArray(liveTaskFeed.outstandingNetworkTasks).length,
      recentTerminalNetworkTaskCount: safeArray(liveTaskFeed.recentTerminalNetworkTasks).length,
      pendingGenerationJobCount: safeArray(liveTaskFeed.pendingGenerationJobs).length,
      boardCommentCount: safeArray(boardComments).length,
      projectLeaderContextCount: safeArray(projectLeaderContext).length,
      liveTaskPacketContributorCount: safeArray(liveTaskPacket?.packet?.contributors).length,
      constrainedActiveTaskCount: safeArray(taskRoutingConstraints?.activeTaskRequirements).length,
      hiveIntelligenceReportPresent: Boolean(intelligenceReport?.id),
    },
  };
}
