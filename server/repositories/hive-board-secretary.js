import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { listHiveProjectComments } from "./hive-context.js";

export const hiveBoardSecretaryPromptVersion = "glm_board_secretary_status_memo_v1";
export const hiveBoardSecretarySourceVersion = "pf.hive.board_secretary.source.v1";

const activeTaskStatuses = new Set([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
]);
const terminalTaskStatuses = new Set([
  "rewarded",
  "paid",
  "refused",
  "cancelled",
  "rejected",
  "expired",
  "failed",
  "completed",
  "rerouted",
]);

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function safeObject(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function iso(value = null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function jsonValue(value = {}) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["generatedAt", "generated_at"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

function digestJson(value = {}) {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function oneLine(value = "", max = 1000) {
  return safeText(value, max).replace(/\s+/g, " ");
}

function compactAccount(value = "") {
  const text = safeText(value, 180);
  if (text.length <= 24) return text;
  return `${text.slice(0, 12)}...${text.slice(-8)}`;
}

function displayName(row = {}) {
  const handle = safeText(row.public_handle || row.provider_public_handle || row.identity_public_handle, 120).replace(/^@+/, "");
  return safeText(
    row.display_name ||
      row.hive_display_name ||
      (handle ? `@${handle}` : "") ||
      row.account_id ||
      row.assignee_account_id ||
      row.subject_wallet ||
      "",
    180
  );
}

function normalizeTaskRow(row = {}) {
  const status = safeText(row.status || row.project_state || row.state, 80).toLowerCase();
  const common = {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    title: oneLine(row.title || row.project_title, 260),
    status,
    contributor: {
      accountId: safeText(row.account_id || row.assignee_account_id, 180),
      walletAddress: safeText(row.subject_wallet || row.assignee_wallet, 140),
      displayName: displayName(row),
    },
    rewardOfferPft: numeric(row.reward_offer_pft || row.reward_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    updatedAt: iso(row.updated_at || row.project_updated_at),
    taskgen: {
      jobId: safeText(row.generation_job_id, 180),
      status: safeText(row.generation_job_status, 80),
      requiredBadgeId: safeText(row.required_badge_id, 80),
      operatingBadgeId: safeText(row.operating_badge_id, 80),
      taskWorkType: safeText(row.task_work_type, 120),
      projectNeedSummary: oneLine(row.project_need_summary, 700),
    },
  };

  if (activeTaskStatuses.has(status)) {
    return {
      ...common,
      kind: "active_or_outstanding",
      proposalSummary: oneLine(row.description || row.submission_requirement_text || row.project_need_summary, 1200),
      submissionRequirementSummary: oneLine(row.submission_requirement_text, 700),
    };
  }

  return {
    ...common,
    kind: terminalTaskStatuses.has(status) ? "terminal_or_rewarded" : "other",
    proposalSummary: oneLine(row.description || row.submission_requirement_text || row.project_need_summary, 700),
    reward: {
      pft: numeric(row.reward_actual_pft || row.reward_pft),
      txHash: safeText(row.last_event_tx_hash, 240),
      cid: safeText(row.last_event_cid, 240),
      observedAt: iso(row.last_event_at || row.updated_at),
      summary: oneLine(row.reward_summary || row.metadata_json?.rewardSummary || row.metadata_json?.reward_summary, 500),
    },
  };
}

function normalizePendingGeneration(row = {}) {
  return {
    id: safeText(row.id, 180),
    projectId: safeText(row.project_id, 180),
    status: safeText(row.status, 80),
    allocationId: safeText(row.allocation_id, 180),
    requestId: safeText(row.request_id, 180),
    taskId: safeText(row.task_id, 180),
    accountId: safeText(row.candidate_account_id, 180),
    walletAddress: safeText(row.candidate_wallet_address, 140),
    projectNeedSummary: oneLine(row.project_need_summary, 700),
    taskWorkType: safeText(row.task_work_type, 120),
    requiredBadgeId: safeText(row.required_badge_id, 80),
    operatingBadgeId: safeText(row.operating_badge_id, 80),
    rewardMinPft: numeric(row.reward_min_pft),
    rewardMaxPft: numeric(row.reward_max_pft),
    updatedAt: iso(row.updated_at || row.created_at),
  };
}

function normalizeComment(row = {}, badgesByAccount = new Map()) {
  const accountId = safeText(row.accountId || row.account_id, 180);
  return {
    id: safeText(row.id, 180),
    accountId,
    displayName: safeText(row.displayName || row.display_name, 180),
    handle: safeText(row.handle || row.displayName || row.display_name, 180),
    verifiedBadges: badgesByAccount.get(accountId) || [],
    body: oneLine(row.body, 1000),
    createdAt: iso(row.createdAt || row.created_at),
  };
}

function normalizeLeaderEntry(row = {}, badgesByAccount = new Map()) {
  const accountId = safeText(row.account_id, 180);
  return {
    id: safeText(row.id, 180),
    accountId,
    displayName: safeText(row.display_name, 180),
    verifiedBadges: badgesByAccount.get(accountId) || [],
    body: oneLine(row.body, 1200),
    sourceConversationTitle: safeText(row.source_conversation_title, 180),
    createdAt: iso(row.created_at),
  };
}

function normalizeContributor(row = {}) {
  const rewarded = safeArray(row.recent_rewarded_tasks);
  return {
    accountId: safeText(row.account_id, 180),
    displayName: safeText(row.display_name, 180) || compactAccount(row.account_id),
    handle: safeText(row.public_handle, 120).replace(/^@+/, ""),
    walletAddress: safeText(row.wallet_address, 140),
    verifiedBadges: safeArray(row.verified_badges).map((item) => safeText(item, 80)).filter(Boolean),
    capacity: {
      outstandingNetworkTasks: Number(row.outstanding_network_tasks || 0),
      proposedNetworkTasks: Number(row.proposed_network_tasks || 0),
      availableForRouting: Number(row.outstanding_network_tasks || 0) === 0 && Number(row.proposed_network_tasks || 0) === 0,
    },
    profile: {
      roleTitle: safeText(row.role_title, 220),
      roleSummary: oneLine(row.role_summary, 900),
      skills: safeArray(row.skills).map((item) => safeText(item, 160)).filter(Boolean).slice(0, 8),
      usefulTo: oneLine(row.useful_to, 900),
      updatedAt: iso(row.profile_completed_at),
    },
    lastRewardedNetworkTasks: rewarded.slice(0, 5).map((task) => ({
      taskId: safeText(task.task_id, 180),
      title: oneLine(task.title, 240),
      rewardPft: numeric(task.reward_actual_pft),
      rewardedAt: iso(task.rewarded_at),
    })),
  };
}

export function publicHiveBoardSecretaryMemo(row = {}) {
  if (!row?.id) return null;
  return {
    id: safeText(row.id, 180),
    projectId: safeText(row.project_id, 180),
    status: safeText(row.status, 80),
    memoMarkdown: safeText(row.memo_markdown, 20000),
    sourcePacketDigest: safeText(row.source_packet_digest, 120),
    sourceCounts: safeObject(row.source_counts_json),
    provider: safeText(row.provider, 80),
    model: safeText(row.model, 180),
    promptVersion: safeText(row.prompt_version, 120),
    promptDigest: safeText(row.prompt_digest, 120),
    usage: safeObject(row.usage_json),
    error: safeText(row.error, 1000),
    generatedAt: iso(row.generated_at),
    createdAt: iso(row.created_at),
  };
}

export async function getCurrentHiveBoardSecretaryMemos({ projectIds = [], queryImpl = query } = {}) {
  const ids = Array.from(new Set(safeArray(projectIds).map((id) => safeText(id, 180)).filter(Boolean)));
  if (!useDatabase() || !ids.length) return [];
  const result = await queryImpl(
    `
      SELECT *
      FROM hive_board_secretary_memos
      WHERE project_id = ANY($1::text[])
        AND status = 'current'
        AND superseded_at IS NULL
      ORDER BY project_id ASC, generated_at DESC, id DESC
    `,
    [ids]
  );
  return result.rows.map(publicHiveBoardSecretaryMemo).filter(Boolean);
}

export async function listHiveBoardSecretaryProjects({ limit = 100, queryImpl = query } = {}) {
  if (!useDatabase()) return [];
  const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 250);
  const result = await queryImpl(
    `
      SELECT id, title, priority, status, updated_at
      FROM network_projects
      WHERE status = 'active'
      ORDER BY priority ASC, title ASC, id ASC
      LIMIT $1
    `,
    [cappedLimit]
  );
  return result.rows.map((row) => ({
    id: safeText(row.id, 180),
    title: safeText(row.title, 220),
    priority: Number(row.priority || 0),
    status: safeText(row.status, 80),
    updatedAt: iso(row.updated_at),
  }));
}

async function badgesForAccounts(accountIds = [], queryImpl = query) {
  const ids = Array.from(new Set(safeArray(accountIds).map((id) => safeText(id, 180)).filter(Boolean)));
  if (!ids.length) return new Map();
  const result = await queryImpl(
    `
      SELECT account_id,
             array_agg(badge_id ORDER BY badge_id) FILTER (WHERE badge_id <> '') AS badges
      FROM account_network_badges
      WHERE account_id = ANY($1::text[])
        AND status = 'verified'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      GROUP BY account_id
    `,
    [ids]
  );
  return new Map(result.rows.map((row) => [safeText(row.account_id, 180), safeArray(row.badges).map((item) => safeText(item, 80)).filter(Boolean)]));
}

async function fetchProject(projectId = "", queryImpl = query) {
  const result = await queryImpl("SELECT * FROM network_projects WHERE id = $1 LIMIT 1", [projectId]);
  const row = result.rows[0] || null;
  if (!row?.id) throw new Error("hive_board_secretary_project_not_found");
  return {
    id: safeText(row.id, 180),
    title: safeText(row.title, 220),
    type: safeText(row.type, 120),
    summary: oneLine(row.summary, 900),
    objective: oneLine(row.objective, 1200),
    about: oneLine(row.about, 1800),
    status: safeText(row.status, 80),
    priority: Number(row.priority || 0),
    proposedBy: safeText(row.proposed_by, 120),
    proposedAt: iso(row.proposed_at),
    phase: safeText(row.phase_label, 120),
    pftRouted: numeric(row.pft_routed),
    plannedTaskCount: Number(row.task_count || 0),
    plannedContributorCount: Number(row.contributor_count || 0),
    updatedAt: iso(row.updated_at),
  };
}

async function fetchTaskState(projectId = "", queryImpl = query) {
  const [tasks, pending] = await Promise.all([
    queryImpl(
      `
        SELECT refs.id AS ref_id,
               refs.project_id,
               refs.state AS project_state,
               refs.assignee_wallet,
               refs.reward_pft,
               refs.updated_at AS project_updated_at,
               projection.task_id,
               projection.request_id,
               projection.account_id,
               projection.subject_wallet,
               projection.status,
               projection.title,
               projection.description,
               projection.submission_requirement_text,
               projection.reward_offer_pft,
               projection.reward_actual_pft,
               projection.last_event_at,
               projection.last_event_tx_hash,
               projection.last_event_cid,
               projection.metadata_json,
               job.id AS generation_job_id,
               job.status AS generation_job_status,
               COALESCE(
                 alloc.project_need_summary,
                 job.source_payload_json #>> '{network_task,project_need_summary}',
                 job.source_payload_json #>> '{networkTask,projectNeedSummary}',
                 job.source_payload_json #>> '{projectNeedSummary}',
                 ''
               ) AS project_need_summary,
               COALESCE(
                 job.source_payload_json #>> '{network_task,task_work_type}',
                 job.source_payload_json #>> '{networkTask,taskWorkType}',
                 job.source_payload_json #>> '{taskWorkType}',
                 ''
               ) AS task_work_type,
               COALESCE(
                 job.source_payload_json #>> '{network_task,required_badge_id}',
                 job.source_payload_json #>> '{networkTask,requiredBadgeId}',
                 job.source_payload_json #>> '{requiredBadgeId}',
                 ''
               ) AS required_badge_id,
               COALESCE(
                 job.source_payload_json #>> '{network_task,operating_badge_id}',
                 job.source_payload_json #>> '{networkTask,operatingBadgeId}',
                 job.source_payload_json #>> '{operatingBadgeId}',
                 ''
               ) AS operating_badge_id,
               COALESCE(handle.public_handle, '') AS public_handle
        FROM network_project_task_refs refs
        JOIN task_projections projection
          ON projection.task_id = refs.task_id
        LEFT JOIN LATERAL (
          SELECT candidate.*
          FROM network_task_generation_jobs candidate
          WHERE candidate.project_id = refs.project_id
            AND (
              candidate.task_id = projection.task_id
              OR (projection.request_id <> '' AND candidate.request_id = projection.request_id)
              OR (refs.metadata_json->>'generation_job_id' <> '' AND candidate.id = refs.metadata_json->>'generation_job_id')
            )
          ORDER BY candidate.updated_at DESC NULLS LAST, candidate.id DESC
          LIMIT 1
        ) job ON true
        LEFT JOIN network_task_allocations alloc
          ON alloc.id = job.allocation_id
        LEFT JOIN LATERAL (
          SELECT public_handle
          FROM account_identity_approvals approval
          WHERE approval.account_id = projection.account_id
            AND approval.status = 'active'
            AND approval.public_handle <> ''
          ORDER BY approval.updated_at DESC, approval.created_at DESC, approval.id DESC
          LIMIT 1
        ) handle ON true
        WHERE refs.project_id = $1
          AND refs.task_id <> ''
        ORDER BY projection.updated_at DESC NULLS LAST, refs.updated_at DESC NULLS LAST, refs.id DESC
        LIMIT 120
      `,
      [projectId]
    ),
    queryImpl(
      `
        SELECT job.id,
               job.project_id,
               job.status,
               job.allocation_id,
               job.request_id,
               job.task_id,
               job.candidate_account_id,
               job.candidate_wallet_address,
               COALESCE(
                 alloc.project_need_summary,
                 job.source_payload_json #>> '{network_task,project_need_summary}',
                 job.source_payload_json #>> '{networkTask,projectNeedSummary}',
                 job.source_payload_json #>> '{projectNeedSummary}',
                 ''
               ) AS project_need_summary,
               COALESCE(
                 job.source_payload_json #>> '{network_task,task_work_type}',
                 job.source_payload_json #>> '{networkTask,taskWorkType}',
                 job.source_payload_json #>> '{taskWorkType}',
                 ''
               ) AS task_work_type,
               COALESCE(
                 job.source_payload_json #>> '{network_task,required_badge_id}',
                 job.source_payload_json #>> '{networkTask,requiredBadgeId}',
                 job.source_payload_json #>> '{requiredBadgeId}',
                 ''
               ) AS required_badge_id,
               COALESCE(
                 job.source_payload_json #>> '{network_task,operating_badge_id}',
                 job.source_payload_json #>> '{networkTask,operatingBadgeId}',
                 job.source_payload_json #>> '{operatingBadgeId}',
                 ''
               ) AS operating_badge_id,
               job.reward_min_pft,
               job.reward_max_pft,
               job.created_at,
               job.updated_at
        FROM network_task_generation_jobs job
        LEFT JOIN network_task_allocations alloc
          ON alloc.id = job.allocation_id
        WHERE job.project_id = $1
          AND job.status IN ('queued', 'running', 'generated', 'link_failed')
        ORDER BY job.updated_at DESC, job.id DESC
        LIMIT 40
      `,
      [projectId]
    ),
  ]);
  const normalized = tasks.rows.map(normalizeTaskRow);
  const active = normalized.filter((task) => activeTaskStatuses.has(task.status)).slice(0, 40);
  const terminal = normalized.filter((task) => !activeTaskStatuses.has(task.status)).slice(0, 40);
  return {
    activeTasks: active,
    terminalTasks: terminal,
    pendingGenerationJobs: pending.rows.map(normalizePendingGeneration),
    omitted: {
      activeTasks: Math.max(0, normalized.filter((task) => activeTaskStatuses.has(task.status)).length - active.length),
      terminalTasks: Math.max(0, normalized.filter((task) => !activeTaskStatuses.has(task.status)).length - terminal.length),
    },
  };
}

async function fetchEligibleContributors(queryImpl = query) {
  const result = await queryImpl(
    `
      WITH badge_accounts AS (
        SELECT badge.account_id,
               array_agg(badge.badge_id ORDER BY badge.badge_id) AS verified_badges
        FROM account_network_badges badge
        WHERE badge.status = 'verified'
          AND badge.revoked_at IS NULL
          AND (badge.expires_at IS NULL OR badge.expires_at > now())
        GROUP BY badge.account_id
      )
      SELECT badge_accounts.account_id,
             badge_accounts.verified_badges,
             COALESCE(handle.public_handle, '') AS public_handle,
             COALESCE(profile.role_title, '') AS role_title,
             COALESCE(profile.role_summary, '') AS role_summary,
             COALESCE(profile.skills, '[]'::jsonb) AS skills,
             COALESCE(profile.useful_to, '') AS useful_to,
             profile.completed_at AS profile_completed_at,
             COALESCE(active_counts.outstanding_network_tasks, 0)::int AS outstanding_network_tasks,
             COALESCE(active_counts.proposed_network_tasks, 0)::int AS proposed_network_tasks,
             COALESCE(wallet.wallet_address, '') AS wallet_address,
             COALESCE(rewards.recent_rewarded_tasks, '[]'::jsonb) AS recent_rewarded_tasks,
             CASE
               WHEN COALESCE(handle.public_handle, '') <> ''
                 THEN '@' || regexp_replace(handle.public_handle, '^@+', '')
               ELSE badge_accounts.account_id
             END AS display_name
      FROM badge_accounts
      LEFT JOIN LATERAL (
        SELECT *
        FROM profile_public_snapshots snapshot
        WHERE snapshot.account_id = badge_accounts.account_id
          AND snapshot.status = 'completed'
        ORDER BY snapshot.completed_at DESC NULLS LAST, snapshot.updated_at DESC NULLS LAST, snapshot.snapshot_id DESC
        LIMIT 1
      ) profile ON true
      LEFT JOIN LATERAL (
        SELECT public_handle
        FROM account_identity_approvals approval
        WHERE approval.account_id = badge_accounts.account_id
          AND approval.status = 'active'
          AND approval.public_handle <> ''
        ORDER BY approval.updated_at DESC, approval.created_at DESC, approval.id DESC
        LIMIT 1
      ) handle ON true
      LEFT JOIN LATERAL (
        SELECT subject_wallet AS wallet_address
        FROM task_projections task
        WHERE task.account_id = badge_accounts.account_id
          AND subject_wallet <> ''
        ORDER BY task.updated_at DESC NULLS LAST, task.task_id DESC
        LIMIT 1
      ) wallet ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE lower(status) IN ('accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'reward_decided')) AS outstanding_network_tasks,
          count(*) FILTER (WHERE lower(status) = 'proposed') AS proposed_network_tasks
        FROM task_projections task
        WHERE task.account_id = badge_accounts.account_id
          AND lower(task_kind) = 'network'
      ) active_counts ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(row_to_json(rewarded_task) ORDER BY rewarded_task.rewarded_at DESC) AS recent_rewarded_tasks
        FROM (
          SELECT task_id, title, reward_actual_pft, COALESCE(last_event_at, updated_at) AS rewarded_at
          FROM task_projections task
          WHERE task.account_id = badge_accounts.account_id
            AND lower(task_kind) = 'network'
            AND lower(status) IN ('rewarded', 'paid')
          ORDER BY COALESCE(last_event_at, updated_at) DESC NULLS LAST, task_id DESC
          LIMIT 5
        ) rewarded_task
      ) rewards ON true
      ORDER BY
        COALESCE(active_counts.outstanding_network_tasks, 0) ASC,
        array_length(badge_accounts.verified_badges, 1) DESC NULLS LAST,
        badge_accounts.account_id ASC
      LIMIT 80
    `
  );
  return result.rows.map(normalizeContributor);
}

async function fetchProjectLeaderEntries({ project = {}, projectId = "", queryImpl = query } = {}) {
  const titleNeedle = `%${safeText(project.title, 160).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const result = await queryImpl(
    `
      SELECT entry.*
      FROM hive_context_entries entry
      JOIN account_network_badges badge
        ON badge.account_id = entry.account_id
       AND badge.badge_id = 'project_leader'
       AND badge.status = 'verified'
       AND badge.revoked_at IS NULL
       AND (badge.expires_at IS NULL OR badge.expires_at > now())
      WHERE entry.deleted_at IS NULL
        AND (
          COALESCE(entry.metadata_json #>> '{projectComment,projectId}', '') = $1
          OR COALESCE(entry.metadata_json #>> '{boardComment,projectId}', '') = $1
          OR entry.body ILIKE $2
          OR entry.body ILIKE $3
          OR entry.source_conversation_title ILIKE $2
        )
      ORDER BY entry.created_at DESC, entry.id DESC
      LIMIT 50
    `,
    [projectId, titleNeedle, `%${projectId}%`]
  );
  return result.rows;
}

export async function buildHiveBoardSecretarySourcePacket({
  projectId = "",
  now = new Date(),
  queryImpl = query,
} = {}) {
  if (!useDatabase()) throw new Error("hive_board_secretary_database_not_configured");
  const normalizedProjectId = safeText(projectId, 180);
  if (!normalizedProjectId) throw new Error("hive_board_secretary_project_required");

  const project = await fetchProject(normalizedProjectId, queryImpl);
  const [taskState, commentsByProject, eligibleContributors, projectLeaderRows] = await Promise.all([
    fetchTaskState(normalizedProjectId, queryImpl),
    listHiveProjectComments({ projectIds: [normalizedProjectId], limitPerProject: 30 }),
    fetchEligibleContributors(queryImpl),
    fetchProjectLeaderEntries({ project, projectId: normalizedProjectId, queryImpl }),
  ]);
  const comments = commentsByProject[normalizedProjectId] || [];
  const badgeAccounts = Array.from(new Set([
    ...comments.map((comment) => safeText(comment.accountId, 180)),
    ...projectLeaderRows.map((row) => safeText(row.account_id, 180)),
  ].filter(Boolean)));
  const badgesByAccount = await badgesForAccounts(badgeAccounts, queryImpl);

  const packetCore = {
    schema: hiveBoardSecretarySourceVersion,
    version: hiveBoardSecretaryPromptVersion,
    projectId: normalizedProjectId,
    generatedAt: now.toISOString(),
    project,
    taskState,
    boardComments: comments.map((comment) => normalizeComment(comment, badgesByAccount)),
    eligibleContributors,
    projectLeaderContext: projectLeaderRows.map((row) => normalizeLeaderEntry(row, badgesByAccount)),
    rules: {
      advisoryOnly: true,
      noTaskCreation: true,
      noUserMessaging: true,
      noRewardMutation: true,
      rewardedTaskEvidenceTruncated: true,
    },
  };
  const sourcePacketDigest = digestJson(packetCore);
  const counts = {
    activeTaskCount: taskState.activeTasks.length,
    terminalTaskCount: taskState.terminalTasks.length,
    pendingGenerationJobCount: taskState.pendingGenerationJobs.length,
    omittedActiveTaskCount: taskState.omitted.activeTasks,
    omittedTerminalTaskCount: taskState.omitted.terminalTasks,
    boardCommentCount: comments.length,
    eligibleContributorCount: eligibleContributors.length,
    projectLeaderContextCount: projectLeaderRows.length,
  };
  return {
    ...packetCore,
    sourcePacketDigest,
    counts,
  };
}

export async function completeHiveBoardSecretaryMemo({
  projectId = "",
  sourcePacket = {},
  memoMarkdown = "",
  provider = "",
  model = "",
  promptVersion = hiveBoardSecretaryPromptVersion,
  promptDigest = "",
  usage = {},
  generatedAt = new Date(),
} = {}) {
  if (!useDatabase()) throw new Error("hive_board_secretary_database_not_configured");
  const normalizedProjectId = safeText(projectId || sourcePacket.projectId, 180);
  if (!normalizedProjectId) throw new Error("hive_board_secretary_project_required");
  const markdown = safeText(memoMarkdown, 20000);
  if (!markdown) throw new Error("hive_board_secretary_memo_required");
  const memoId = `hiveboardmemo_${randomUUID()}`;

  return transaction(async (client) => {
    await client.query(
      `
        UPDATE hive_board_secretary_memos
        SET status = 'superseded',
            superseded_at = now()
        WHERE project_id = $1
          AND status = 'current'
          AND superseded_at IS NULL
      `,
      [normalizedProjectId]
    );
    const inserted = await client.query(
      `
        INSERT INTO hive_board_secretary_memos (
          id, project_id, status, source_packet_digest, source_packet_json,
          source_counts_json, memo_markdown, provider, model, prompt_version,
          prompt_digest, usage_json, generated_at
        )
        VALUES (
          $1, $2, 'current', $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12
        )
        RETURNING *
      `,
      [
        memoId,
        normalizedProjectId,
        safeText(sourcePacket.sourcePacketDigest, 120),
        jsonValue(sourcePacket),
        jsonValue(sourcePacket.counts || {}),
        markdown,
        safeText(provider, 80),
        safeText(model, 180),
        safeText(promptVersion, 120),
        safeText(promptDigest, 120),
        jsonValue(usage),
        generatedAt,
      ]
    );
    return { ok: true, memo: publicHiveBoardSecretaryMemo(inserted.rows[0]) };
  });
}

export async function failHiveBoardSecretaryMemo({
  projectId = "",
  sourcePacket = {},
  error = "",
  provider = "",
  model = "",
  promptVersion = hiveBoardSecretaryPromptVersion,
  promptDigest = "",
  usage = {},
} = {}) {
  if (!useDatabase()) return { ok: false };
  const normalizedProjectId = safeText(projectId || sourcePacket.projectId, 180);
  if (!normalizedProjectId) return { ok: false };
  const result = await query(
    `
      INSERT INTO hive_board_secretary_memos (
        id, project_id, status, source_packet_digest, source_packet_json,
        source_counts_json, memo_markdown, provider, model, prompt_version,
        prompt_digest, usage_json, error, generated_at
      )
      VALUES (
        $1, $2, 'failed', $3, $4::jsonb, $5::jsonb, '', $6, $7, $8, $9, $10::jsonb, $11, now()
      )
      RETURNING *
    `,
    [
      `hiveboardmemo_${randomUUID()}`,
      normalizedProjectId,
      safeText(sourcePacket.sourcePacketDigest, 120),
      jsonValue(sourcePacket),
      jsonValue(sourcePacket.counts || {}),
      safeText(provider, 80),
      safeText(model, 180),
      safeText(promptVersion, 120),
      safeText(promptDigest, 120),
      jsonValue(usage),
      safeText(error?.message || error || "hive_board_secretary_failed", 2000),
    ]
  );
  return { ok: true, memo: publicHiveBoardSecretaryMemo(result.rows[0]) };
}
