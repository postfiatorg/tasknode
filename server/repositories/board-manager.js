import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { databaseEnabled, databaseStatus, query, transaction } from "../db/pool.js";
import {
  buildHiveSecretarySourcePacket,
  getHiveContextDocument,
  getHiveSecretaryState,
} from "./hive-context.js";
import { latestHiveProjectPlanningState } from "./hive-project-planning.js";
import { getHiveProjectsDocument } from "./hive-projects.js";
import {
  getNetworkTaskContentSnapshot,
  listEligibleNetworkTaskCandidates,
  normalizeNetworkTaskRewardBand,
} from "./network-tasks.js";
import {
  formatBoardManagerAgentJob,
  buildBoardManagerRunMicroSummary,
  compactBoardManagerRunForSourcePacket,
  formatBoardManagerAgentRun,
} from "./board-manager-run-summary.js";
import { activeBoardManagerJobs } from "./board-manager-agent-jobs.js";
import { buildBoardManagerActionPressure } from "./board-manager-health.js";
import {
  compactHiveProjectsForBoardManager,
  compactNetworkTaskContentForBoardManager,
  compactProjectRegistryForBoardManager,
  compactTaskRequestsForBoardManager,
  compactTaskStateForBoardManager,
} from "./board-manager-source-compact.js";

export { formatBoardManagerAgentJob, formatBoardManagerAgentRun } from "./board-manager-run-summary.js";

export const boardManagerPromptVersion = "board_manager_v1";
export const boardManagerActions = Object.freeze([
  "do_nothing",
  "refresh_hive_secretary",
  "message_user",
  "create_project",
  "archive_project",
  "refresh_project_document",
  "assign_contributor",
  "initiate_network_task",
]);

export const boardManagerInternalActions = Object.freeze([
  "daily_airdrop",
]);

const actionSet = new Set([...boardManagerActions, ...boardManagerInternalActions]);
const emptyBoardManagerPayload = Object.freeze({
  summary: "",
  next_steps: [],
  message_text: "",
  archive_reason: "",
  project: {
    id: "",
    type: "",
    title: "",
    summary: "",
    objective: "",
    about: "",
    priority: 0,
    phase_label: "",
    phase_current: 0,
    phase_total: 0,
    pft_routed: 0,
    task_count: 0,
    contributor_count: 0,
  },
  project_document: {
    title: "",
    summary: "",
    project_status: "",
    key_points: [],
    blocked_or_unclear: [],
    next_actions: [],
  },
  contributor: {
    project_id: "",
    account_id: "",
    wallet_address: "",
    codename: "",
    archetype: "",
    role_label: "",
    status: "",
    allotted: false,
    cap: 0,
    load: 0,
    sort_order: 0,
  },
  network_task: {
    task_class: "",
    candidate_account_id: "",
    candidate_wallet_address: "",
    project_need_summary: "",
    routing_reason: "",
    cadence_reason: "",
    reward_min_pft: 10000,
    reward_max_pft: 50000,
    accept_window_hours: 24,
    allow_over_capacity: false,
  },
});

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function normalizePayload(payload = {}) {
  const input = safeObject(payload);
  const project = safeObject(input.project);
  const projectDocument = safeObject(input.project_document || input.projectDocument);
  const contributor = safeObject(input.contributor);
  const networkTask = safeObject(input.network_task || input.networkTask);
  const rewardBand = normalizeNetworkTaskRewardBand({
    min: networkTask.reward_min_pft ?? networkTask.rewardMinPft,
    max: networkTask.reward_max_pft ?? networkTask.rewardMaxPft,
  });
  return {
    summary: safeText(input.summary, 2000),
    next_steps: safeArray(input.next_steps || input.nextSteps).slice(0, 8).map((item) => safeText(item, 500)).filter(Boolean),
    message_text: safeText(input.message_text || input.messageText, 4000),
    archive_reason: safeText(input.archive_reason || input.archiveReason, 1000),
    project: {
      id: safeText(project.id, 180),
      type: safeText(project.type, 80),
      title: safeText(project.title, 180),
      summary: safeText(project.summary, 600),
      objective: safeText(project.objective, 900),
      about: safeText(project.about, 2000),
      priority: Math.max(0, Math.round(Number(project.priority || 0) || 0)),
      phase_label: safeText(project.phase_label || project.phaseLabel, 100),
      phase_current: Math.max(0, Math.round(Number(project.phase_current ?? project.phaseCurrent ?? 0) || 0)),
      phase_total: Math.max(0, Math.round(Number(project.phase_total ?? project.phaseTotal ?? 0) || 0)),
      pft_routed: Math.max(0, Number(project.pft_routed ?? project.pftRouted ?? 0) || 0),
      task_count: Math.max(0, Math.round(Number(project.task_count ?? project.taskCount ?? 0) || 0)),
      contributor_count: Math.max(0, Math.round(Number(project.contributor_count ?? project.contributorCount ?? 0) || 0)),
    },
    project_document: {
      title: safeText(projectDocument.title, 180),
      summary: safeText(projectDocument.summary, 1200),
      project_status: safeText(projectDocument.project_status || projectDocument.projectStatus, 1800),
      key_points: safeArray(projectDocument.key_points || projectDocument.keyPoints).slice(0, 8).map((item) => safeText(item, 700)).filter(Boolean),
      blocked_or_unclear: safeArray(projectDocument.blocked_or_unclear || projectDocument.blockedOrUnclear).slice(0, 6).map((item) => safeText(item, 700)).filter(Boolean),
      next_actions: safeArray(projectDocument.next_actions || projectDocument.nextActions).slice(0, 6).map((item) => safeText(item, 700)).filter(Boolean),
    },
    contributor: {
      project_id: safeText(contributor.project_id || contributor.projectId, 180),
      account_id: safeText(contributor.account_id || contributor.accountId, 180),
      wallet_address: safeText(contributor.wallet_address || contributor.walletAddress, 120),
      codename: safeText(contributor.codename, 120),
      archetype: safeText(contributor.archetype, 180),
      role_label: safeText(contributor.role_label || contributor.roleLabel, 80),
      status: safeText(contributor.status, 80),
      allotted: Boolean(contributor.allotted),
      cap: Math.max(0, Math.round(Number(contributor.cap || 0) || 0)),
      load: Math.max(0, Math.round(Number(contributor.load || 0) || 0)),
      sort_order: Math.max(0, Math.round(Number(contributor.sort_order ?? contributor.sortOrder ?? 0) || 0)),
    },
    network_task: {
      task_class: safeText(networkTask.task_class || networkTask.taskClass, 40),
      candidate_account_id: safeText(networkTask.candidate_account_id || networkTask.candidateAccountId, 180),
      candidate_wallet_address: safeText(networkTask.candidate_wallet_address || networkTask.candidateWalletAddress, 120),
      project_need_summary: safeText(networkTask.project_need_summary || networkTask.projectNeedSummary, 2000),
      routing_reason: safeText(networkTask.routing_reason || networkTask.routingReason, 1800),
      cadence_reason: safeText(networkTask.cadence_reason || networkTask.cadenceReason, 700),
      reward_min_pft: rewardBand.min,
      reward_max_pft: rewardBand.max,
      accept_window_hours: Math.min(
        336,
        Math.max(1, Math.round(Number(networkTask.accept_window_hours ?? networkTask.acceptWindowHours ?? 24) || 24))
      ),
      allow_over_capacity: Boolean(networkTask.allow_over_capacity || networkTask.allowOverCapacity),
    },
  };
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function ageMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null;
}

function compactContextDocument(document = {}) {
  return {
    id: safeText(document.id, 120),
    generatedAt: document.generatedAt,
    entryCount: Number(document.entryCount || 0),
    userCount: Number(document.userCount || 0),
    groups: safeArray(document.groups).slice(0, 24).map((group) => ({
      accountId: safeText(group.accountId, 160),
      displayName: safeText(group.displayName, 120),
      latestAt: group.latestAt || null,
      entryCount: Number(group.entryCount || 0),
      entries: safeArray(group.entries).slice(0, 12).map((entry) => ({
        id: safeText(entry.id, 180),
        accountId: safeText(entry.accountId, 160),
        displayName: safeText(entry.displayName, 120),
        body: safeText(entry.body, 3600),
        sourceConversationId: safeText(entry.sourceConversationId, 180),
        walletValidated: Boolean(entry.walletValidated),
        walletAddress: safeText(entry.walletAddress, 120),
        createdAt: entry.createdAt || null,
      })),
    })),
  };
}

function compactSecretarySourcePacket(packet = {}) {
  return {
    digest: safeText(packet.sourcePacketDigest, 120),
    counts: safeObject(packet.counts),
    sourceJson: safeObject(packet.sourceJson),
    sourceText: safeText(packet.sourceText, 24000),
  };
}

function compactTask(row = {}) {
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    status: safeText(row.status, 80),
    title: safeText(row.title, 240),
    kind: safeText(row.task_kind, 80),
    rewardOfferPft: Number(row.reward_offer_pft || 0),
    rewardActualPft: Number(row.reward_actual_pft || 0),
    subjectWallet: safeText(row.subject_wallet, 120),
    updatedAt: iso(row.updated_at),
    lastEventAt: iso(row.last_event_at),
  };
}

async function currentProjectRegistry({ limit = 50 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT id, type, title, summary, objective, about, status, priority, origin,
             phase_label, phase_current, phase_total, pft_routed, task_count,
             contributor_count, source_hive_secretary_report_id,
             source_hive_secretary_report_digest, metadata_json, updated_at, created_at
      FROM network_projects
      ORDER BY
        CASE status
          WHEN 'active' THEN 1
          WHEN 'paused' THEN 2
          WHEN 'archived' THEN 3
          WHEN 'completed' THEN 4
          ELSE 5
        END,
        priority ASC,
        updated_at DESC,
        id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 50, 1), 100)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    objective: row.objective,
    about: row.about,
    status: row.status,
    priority: Number(row.priority || 0),
    origin: row.origin,
    phaseLabel: row.phase_label,
    phaseCurrent: Number(row.phase_current || 0),
    phaseTotal: Number(row.phase_total || 0),
    pftRouted: Number(row.pft_routed || 0),
    taskCount: Number(row.task_count || 0),
    contributorCount: Number(row.contributor_count || 0),
    sourceHiveSecretaryReportId: row.source_hive_secretary_report_id,
    sourceHiveSecretaryReportDigest: row.source_hive_secretary_report_digest,
    metadata: safeObject(row.metadata_json),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
  }));
}

async function currentTaskState({ limit = 30 } = {}) {
  if (!useDatabase()) return { counts: [], recent: [] };
  const [counts, recent] = await Promise.all([
    query(
      `
        SELECT status, count(*)::int AS count
        FROM task_projections
        GROUP BY status
        ORDER BY status ASC
      `
    ),
    query(
      `
        SELECT task_id, request_id, status, title, task_kind, reward_offer_pft,
               reward_actual_pft, subject_wallet, updated_at, last_event_at
        FROM task_projections
        ORDER BY updated_at DESC, task_id ASC
        LIMIT $1
      `,
      [Math.min(Math.max(Number(limit) || 30, 1), 80)]
    ),
  ]);
  return {
    counts: counts.rows.map((row) => ({ status: row.status, count: Number(row.count || 0) })),
    recent: recent.rows.map(compactTask),
  };
}

async function currentTaskRequests({ limit = 20 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT request_id, account_id, subject_wallet, source, source_conversation_id,
             source_conversation_title, request_text, user_detail_text,
             requested_task_kind, status, generated_task_id, worker_attempt_count,
             last_error, created_at, updated_at
      FROM task_requests
      ORDER BY updated_at DESC, request_id ASC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 20, 1), 60)]
  );
  return result.rows.map((row) => ({
    requestId: row.request_id,
    accountId: row.account_id,
    subjectWallet: row.subject_wallet,
    source: row.source,
    sourceConversationId: row.source_conversation_id,
    sourceConversationTitle: row.source_conversation_title,
    requestText: safeText(row.request_text, 800),
    userDetailText: safeText(row.user_detail_text, 1600),
    requestedTaskKind: row.requested_task_kind,
    status: row.status,
    generatedTaskId: row.generated_task_id,
    workerAttemptCount: Number(row.worker_attempt_count || 0),
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}

function internalRunFilterSql(includeInternal = false) {
  return includeInternal
    ? ""
    : "AND lower(trigger) NOT LIKE '%smoke%' AND lower(manager_id) NOT LIKE '%smoke%'";
}

async function recentBoardManagerRuns({ limit = 12, includeInternal = false } = {}) {
  if (!useDatabase()) return [];
  const exists = await query("SELECT to_regclass('public.board_manager_runs') AS name");
  if (!exists.rows[0]?.name) return [];
  const result = await query(
    `
      SELECT id, scope, manager_id, trigger, status, source_packet_digest,
             selected_action, action_payload_json, decision_json, dry_run,
             model, reasoning_effort, error, codex_session_id, codex_session_path,
             session_mode, micro_summary_json, micro_summary_text,
             started_at, completed_at
      FROM board_manager_runs
      WHERE 1 = 1
        ${internalRunFilterSql(includeInternal)}
      ORDER BY started_at DESC, id DESC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 12, 1), 30)]
  );
  const actionResults = result.rows.length
    ? await query(
        `
          SELECT run_id, id, action, target_type, target_id, result_json, created_at
          FROM board_manager_action_results
          WHERE run_id = ANY($1::text[])
          ORDER BY created_at DESC, id DESC
        `,
        [result.rows.map((row) => row.id)]
      )
    : { rows: [] };
  const actionResultsByRun = new Map();
  for (const row of actionResults.rows) {
    const list = actionResultsByRun.get(row.run_id) || [];
    list.push({
      id: row.id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      result: safeObject(row.result_json),
      createdAt: iso(row.created_at),
    });
    actionResultsByRun.set(row.run_id, list);
  }
  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    managerId: row.manager_id,
    trigger: row.trigger,
    status: row.status,
    sourcePacketDigest: row.source_packet_digest,
    selectedAction: row.selected_action,
    actionPayload: safeObject(row.action_payload_json),
    decision: safeObject(row.decision_json),
    microSummary: safeObject(row.micro_summary_json),
    microSummaryText: safeText(row.micro_summary_text, 3000),
    dryRun: Boolean(row.dry_run),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    codexSessionId: row.codex_session_id,
    codexSessionPath: row.codex_session_path,
    sessionMode: row.session_mode,
    error: row.error,
    actionResults: actionResultsByRun.get(row.id) || [],
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  }));
}

export async function getBoardManagerAgentFeed({ limit = 20, includeInternal = false } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 30);
  const [jobs, runs] = await Promise.all([
    activeBoardManagerJobs({ limit: Math.min(normalizedLimit, 10), includeInternal }),
    recentBoardManagerRuns({ limit: normalizedLimit, includeInternal }),
  ]);
  return [
    ...jobs.map(formatBoardManagerAgentJob),
    ...runs.map(formatBoardManagerAgentRun),
  ]
    .sort((left, right) =>
      (Date.parse(right.startedAt || right.completedAt || "") || 0) - (Date.parse(left.startedAt || left.completedAt || "") || 0)
    )
    .slice(0, normalizedLimit);
}

export async function getBoardManagerSession({ scope = "global_hive" } = {}) {
  if (!useDatabase()) return null;
  const exists = await query("SELECT to_regclass('public.board_manager_sessions') AS name");
  if (!exists.rows[0]?.name) return null;
  const result = await query(
    `
      SELECT scope, session_id, session_path, status, model, reasoning_effort,
             last_run_id, metadata_json, created_at, updated_at
      FROM board_manager_sessions
      WHERE scope = $1
        AND status = 'active'
      LIMIT 1
    `,
    [safeText(scope, 120) || "global_hive"]
  );
  const row = result.rows[0];
  if (!row?.session_id) return null;
  return {
    scope: row.scope,
    sessionId: row.session_id,
    sessionPath: row.session_path,
    status: row.status,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    lastRunId: row.last_run_id,
    metadata: safeObject(row.metadata_json),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function upsertBoardManagerSession({
  scope = "global_hive",
  sessionId = "",
  sessionPath = "",
  model = "",
  reasoningEffort = "",
  lastRunId = "",
  metadata = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedSessionId = safeText(sessionId, 120);
  if (!normalizedSessionId) throw new Error("board_manager_session_id_required");
  const result = await query(
    `
      INSERT INTO board_manager_sessions (
        scope,
        session_id,
        session_path,
        status,
        model,
        reasoning_effort,
        last_run_id,
        metadata_json
      )
      VALUES ($1, $2, $3, 'active', $4, $5, $6, $7::jsonb)
      ON CONFLICT (scope) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        session_path = EXCLUDED.session_path,
        status = 'active',
        model = EXCLUDED.model,
        reasoning_effort = EXCLUDED.reasoning_effort,
        last_run_id = EXCLUDED.last_run_id,
        metadata_json = board_manager_sessions.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
      RETURNING *
    `,
    [
      safeText(scope, 120) || "global_hive",
      normalizedSessionId,
      safeText(sessionPath, 1000),
      safeText(model, 120),
      safeText(reasoningEffort, 40),
      safeText(lastRunId, 180),
      jsonValue(metadata),
    ]
  );
  return { ok: true, session: result.rows[0] };
}

export async function updateBoardManagerRunSession({
  runId = "",
  codexSessionId = "",
  codexSessionPath = "",
  sessionMode = "",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE board_manager_runs
      SET codex_session_id = $2,
          codex_session_path = $3,
          session_mode = $4,
          updated_at = now()
      WHERE id = $1
      RETURNING id, codex_session_id, codex_session_path, session_mode
    `,
    [
      safeText(runId, 180),
      safeText(codexSessionId, 120),
      safeText(codexSessionPath, 1000),
      safeText(sessionMode, 80),
    ]
  );
  return { ok: true, run: result.rows[0] || null };
}

export async function buildBoardManagerSourcePacket({
  trigger = "manual",
  scope = "global_hive",
  limit = 120,
} = {}) {
  const [
    hiveContext,
    hiveSecretarySource,
    hiveSecretaryState,
    hiveProjects,
    projectPlanning,
    projectRegistry,
    taskState,
    taskRequests,
    networkTaskContent,
    networkTaskCandidates,
    recentRuns,
  ] = await Promise.all([
    getHiveContextDocument({ limit }),
    buildHiveSecretarySourcePacket({ limit }),
    getHiveSecretaryState(),
    getHiveProjectsDocument(),
    latestHiveProjectPlanningState().catch(() => null),
    currentProjectRegistry({ limit: 20 }),
    currentTaskState({ limit: 12 }),
    currentTaskRequests({ limit: 8 }),
    getNetworkTaskContentSnapshot({ completedLimit: 5, outstandingLimit: 12, stoppedLimit: 6, pendingLimit: 6 }).catch(() => null),
    listEligibleNetworkTaskCandidates({ limit: 12 }).catch(() => []),
    recentBoardManagerRuns({ limit: 20 }),
  ]);

  const generatedAt = new Date().toISOString();
  const freshness = {
    hiveSecretaryAgeMs: ageMs(hiveSecretaryState?.report?.completedAt),
    latestProjectGenerationAgeMs: ageMs(projectPlanning?.generation?.completedAt),
  };
  const compactRecentRuns = recentRuns.map(compactBoardManagerRunForSourcePacket);
  const boardActionPressure = buildBoardManagerActionPressure({
    hiveProjects,
    networkTaskContent,
    networkTaskCandidates,
    taskState,
    recentBoardManagerRuns: compactRecentRuns,
    freshness,
  });
  const packetCore = {
    schema: "pf.hive.board_manager.source.v0",
    scope: safeText(scope, 120) || "global_hive",
    trigger: safeText(trigger, 160) || "manual",
    generatedAt,
    database: databaseStatus(),
    actionRegistry: boardManagerActions,
    freshness,
    boardActionPressure,
    hiveContext: compactContextDocument(hiveContext),
    hiveSecretarySource: compactSecretarySourcePacket(hiveSecretarySource),
    hiveSecretary: hiveSecretaryState,
    hiveProjects: compactHiveProjectsForBoardManager(hiveProjects),
    projectPlanning,
    projectRegistry: compactProjectRegistryForBoardManager(projectRegistry),
    taskState: compactTaskStateForBoardManager(taskState),
    taskRequests: compactTaskRequestsForBoardManager(taskRequests),
    networkTaskContent: compactNetworkTaskContentForBoardManager(networkTaskContent),
    networkTaskCandidates,
    recentBoardManagerRuns: compactRecentRuns,
    executionPolicy: {
      dryRunDefault: true,
      implementedActionHooks: [
        "do_nothing",
        "message_user",
        "refresh_hive_secretary",
        "create_project",
        "archive_project",
        "refresh_project_document",
        "assign_contributor",
        "initiate_network_task",
      ],
      projectDeletionPolicy: "archive_project hides a project from the active Hive board without hard deletion. Board Manager archives are soft and reversible; only explicit operator archive locks prevent planner resurrection.",
      taskLifecyclePolicy: "Network tasks must use the existing PFTL task lifecycle.",
      networkTaskPolicy: "Board Manager initiates allocation/generation jobs only. The network task generation worker writes concrete task offers through the existing task engine. Default reward band is 10000-50000 PFT.",
      userResponsePolicy: "Hive Context entries are inbound user messages. message_user responses must target a hive_context_entry when possible and are delivered back to that entry's sourceConversationId as a chat assistant message. A prior message_user response is pending user follow-up; do not send another Hive message until new user input or a materially new blocker appears.",
    },
  };

  return {
    ...packetCore,
    sourcePacketDigest: digestJson({ ...packetCore, generatedAt: "" }),
  };
}

export function formatBoardManagerCodexPrompt({ prompt = "", sourcePacket = {} } = {}) {
  return [
    prompt,
    "",
    "You are running inside the persistent Board Manager Codex session.",
    "Use your prior session context plus the current source packet, but treat the current packet as the live state of the app.",
    "Do not edit files. Do not run shell commands. Do not mutate database state.",
    "The Task Node app will execute supported action hooks after your final JSON only when the caller uses --execute.",
    "Read the source packet and return exactly one action JSON object that matches the provided schema.",
    "",
    "BOARD MANAGER SOURCE PACKET",
    "```json",
    JSON.stringify(sourcePacket, null, 2),
    "```",
  ].join("\n");
}

export function normalizeBoardManagerDecision(decision = {}) {
  const action = safeText(decision.action, 80);
  if (!actionSet.has(action)) {
    const error = new Error(`board_manager_invalid_action:${action || "missing"}`);
    error.status = 422;
    throw error;
  }
  const confidence = Number(decision.confidence);
  return {
    action,
    target_type: safeText(decision.target_type, 120),
    target_id: safeText(decision.target_id, 240),
    reason: safeText(decision.reason, 2000) || "No reason provided.",
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    payload: normalizePayload({ ...emptyBoardManagerPayload, ...safeObject(decision.payload) }),
  };
}

export async function recordBoardManagerActionResult({
  runId = "",
  action = "",
  targetType = "",
  targetId = "",
  result = {},
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const inserted = await query(
    `
      INSERT INTO board_manager_action_results (
        id,
        run_id,
        action,
        target_type,
        target_id,
        result_json
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
    `,
    [
      `boardaction_${randomUUID()}`,
      safeText(runId, 180),
      safeText(action, 80),
      safeText(targetType, 120),
      safeText(targetId, 240),
      jsonValue(result),
    ]
  );
  const refreshed = await refreshBoardManagerRunMicroSummary({ runId }).catch(() => null);
  return {
    ok: true,
    result: inserted.rows[0],
    microSummary: refreshed?.microSummary || null,
  };
}

export async function refreshBoardManagerRunMicroSummary({ runId = "" } = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedRunId = safeText(runId, 180);
  if (!normalizedRunId) return { ok: false, skipped: true, reason: "run_id_required" };
  const runResult = await query(
    `
      SELECT id, scope, manager_id, trigger, status, source_packet_digest,
             selected_action, action_payload_json, decision_json, dry_run,
             model, reasoning_effort, error, codex_session_id, codex_session_path,
             session_mode, started_at, completed_at
      FROM board_manager_runs
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedRunId]
  );
  const row = runResult.rows[0];
  if (!row) return { ok: false, skipped: true, reason: "run_not_found" };
  const actionRows = await query(
    `
      SELECT id, action, target_type, target_id, result_json, created_at
      FROM board_manager_action_results
      WHERE run_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [normalizedRunId]
  );
  const run = {
    id: row.id,
    scope: row.scope,
    managerId: row.manager_id,
    trigger: row.trigger,
    status: row.status,
    sourcePacketDigest: row.source_packet_digest,
    selectedAction: row.selected_action,
    actionPayload: safeObject(row.action_payload_json),
    decision: safeObject(row.decision_json),
    dryRun: Boolean(row.dry_run),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    codexSessionId: row.codex_session_id,
    codexSessionPath: row.codex_session_path,
    sessionMode: row.session_mode,
    error: row.error,
    actionResults: actionRows.rows.map((actionRow) => ({
      id: actionRow.id,
      action: actionRow.action,
      targetType: actionRow.target_type,
      targetId: actionRow.target_id,
      result: safeObject(actionRow.result_json),
      createdAt: iso(actionRow.created_at),
    })),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
  const summary = buildBoardManagerRunMicroSummary(run);
  const updated = await query(
    `
      UPDATE board_manager_runs
      SET micro_summary_json = $2::jsonb,
          micro_summary_text = $3,
          updated_at = now()
      WHERE id = $1
      RETURNING id, micro_summary_json, micro_summary_text
    `,
    [normalizedRunId, jsonValue(summary.json), summary.text]
  );
  return {
    ok: true,
    run: updated.rows[0] || null,
    microSummary: summary.json,
    microSummaryText: summary.text,
  };
}

export async function getBoardManagerUserMessages({ accountId = "", limit = 12 } = {}) {
  if (!useDatabase()) return [];
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return [];
  const result = await query(
    `
      SELECT id, run_id, account_id, display_name, message_text, status,
             source_action, source_packet_digest, metadata_json, created_at, read_at
      FROM board_manager_user_messages
      WHERE account_id = $1
        AND status <> 'archived'
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [normalizedAccountId, Math.min(Math.max(Number(limit) || 12, 1), 50)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    accountId: row.account_id,
    displayName: row.display_name,
    body: row.message_text,
    status: row.status,
    sourceAction: row.source_action,
    sourcePacketDigest: row.source_packet_digest,
    metadata: safeObject(row.metadata_json),
    createdAt: iso(row.created_at),
    readAt: iso(row.read_at),
  }));
}

export async function claimBoardManagerLease({
  scope = "global_hive",
  managerId = `board_manager_${randomUUID()}`,
  ownerInstance = hostname(),
  ttlSeconds = 900,
  metadata = {},
} = {}) {
  if (!useDatabase()) return { ok: true, skipped: true, reason: "database_not_configured", managerId };
  const normalizedScope = safeText(scope, 120) || "global_hive";
  const normalizedManagerId = safeText(managerId, 180) || `board_manager_${randomUUID()}`;
  const ttl = Math.min(Math.max(Number(ttlSeconds) || 900, 60), 7200);
  return transaction(async (client) => {
    const result = await client.query(
      `
        INSERT INTO board_manager_leases (
          scope, manager_id, owner_instance, status, claimed_at, heartbeat_at,
          expires_at, metadata_json
        )
        VALUES (
          $1, $2, $3, 'active', now(), now(),
          now() + ($4::text || ' seconds')::interval, $5::jsonb
        )
        ON CONFLICT (scope) DO UPDATE SET
          manager_id = EXCLUDED.manager_id,
          owner_instance = EXCLUDED.owner_instance,
          status = 'active',
          claimed_at = now(),
          heartbeat_at = now(),
          expires_at = now() + ($4::text || ' seconds')::interval,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now()
        WHERE board_manager_leases.status <> 'active'
           OR board_manager_leases.expires_at IS NULL
           OR board_manager_leases.expires_at < now()
           OR board_manager_leases.manager_id = $2
        RETURNING *
      `,
      [normalizedScope, normalizedManagerId, safeText(ownerInstance, 180), String(ttl), jsonValue(metadata)]
    );
    if (!result.rows[0]) {
      const active = await client.query(
        `
          SELECT scope, manager_id, owner_instance, status, claimed_at, heartbeat_at, expires_at
          FROM board_manager_leases
          WHERE scope = $1
        `,
        [normalizedScope]
      );
      return { ok: false, managerId: normalizedManagerId, active: active.rows[0] || null };
    }
    return { ok: true, managerId: normalizedManagerId, lease: result.rows[0] };
  });
}

export async function releaseBoardManagerLease({ scope = "global_hive", managerId = "" } = {}) {
  if (!useDatabase()) return { ok: true, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE board_manager_leases
      SET status = 'released',
          heartbeat_at = now(),
          updated_at = now()
      WHERE scope = $1
        AND manager_id = $2
      RETURNING scope, manager_id, status
    `,
    [safeText(scope, 120) || "global_hive", safeText(managerId, 180)]
  );
  return { ok: true, released: result.rowCount || 0 };
}

export async function startBoardManagerRun({
  scope = "global_hive",
  managerId = "",
  trigger = "manual",
  sourcePacket = {},
  dryRun = true,
  model = "",
  reasoningEffort = "",
  codexSessionId = "",
  codexSessionPath = "",
  sessionMode = "untracked",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      INSERT INTO board_manager_runs (
        id, scope, manager_id, trigger, status, source_packet_digest,
        source_packet_json, dry_run, model, reasoning_effort,
        codex_session_id, codex_session_path, session_mode
      )
      VALUES ($1, $2, $3, $4, 'running', $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `,
    [
      `boardrun_${randomUUID()}`,
      safeText(scope, 120) || "global_hive",
      safeText(managerId, 180),
      safeText(trigger, 160),
      safeText(sourcePacket.sourcePacketDigest, 120),
      jsonValue(sourcePacket),
      Boolean(dryRun),
      safeText(model, 120),
      safeText(reasoningEffort, 40),
      safeText(codexSessionId, 120),
      safeText(codexSessionPath, 1000),
      safeText(sessionMode, 80),
    ]
  );
  return { ok: true, run: result.rows[0] };
}

export async function completeBoardManagerRun({
  runId = "",
  decision = {},
  outputText = "",
  status = "completed",
  error = "",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedDecision = status === "completed" ? normalizeBoardManagerDecision(decision) : {};
  const result = await query(
    `
      UPDATE board_manager_runs
      SET status = $2,
          selected_action = $3,
          action_payload_json = $4::jsonb,
          decision_json = $5::jsonb,
          output_text = $6,
          error = $7,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      safeText(runId, 180),
      status === "failed" ? "failed" : "completed",
      normalizedDecision.action || "",
      jsonValue(normalizedDecision.payload || {}),
      jsonValue(normalizedDecision),
      safeText(outputText, 120_000),
      safeText(error, 2000),
    ]
  );
  const completedRun = result.rows[0] || null;
  const refreshed = completedRun
    ? await refreshBoardManagerRunMicroSummary({ runId: completedRun.id }).catch(() => null)
    : null;
  return {
    ok: true,
    run: completedRun,
    decision: normalizedDecision,
    microSummary: refreshed?.microSummary || null,
  };
}
