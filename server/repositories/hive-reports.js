import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { getAccountIdentityProfile } from "../runtime-store.js";
import { getHiveProjectsDocument } from "./hive-projects.js";

export const hiveReportVersion = "hive_reports.v1";

export const hiveReportTypes = Object.freeze({
  operative: {
    type: "operative",
    label: "Operative",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Per-role operator context, allocation state, and current task descriptions.",
  },
  rewarded_task: {
    type: "rewarded_task",
    label: "Rewarded Task",
    cadenceMs: 20 * 60 * 1000,
    summary: "Last rewarded Network Tasks per verified role, including proposal and reward context.",
  },
  kol: {
    type: "kol",
    label: "KOL",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Marketing state, public amplification evidence, KOL operators, and trajectory.",
    verifier: "kol_link_verifier",
  },
  development: {
    type: "development",
    label: "Development",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Core development state, tasks, repository evidence, and delivery risks.",
    verifier: "dev_repo_verifier",
  },
  qa: {
    type: "qa",
    label: "QA",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Product QA activity, user-flow findings, and suggested improvements.",
  },
  executive: {
    type: "executive",
    label: "Executive",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Project Leader Hive chat over the past 24 hours.",
  },
});

export const hiveReportTypeIds = Object.freeze(Object.keys(hiveReportTypes));

const roleDefinitions = Object.freeze({
  kol: { badgeId: "kol", label: "KOL", reportGroup: "marketing" },
  core_contributor: { badgeId: "core_contributor", label: "Core Contributor", reportGroup: "development" },
  project_leader: { badgeId: "project_leader", label: "Project Leader", reportGroup: "executive" },
  qa_worker: { badgeId: "qa_worker", label: "QA Worker", reportGroup: "qa" },
  expert: { badgeId: "expert", label: "Expert", reportGroup: "expert" },
});

const activeProjectTaskStatuses = Object.freeze([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
]);

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

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

function iso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function tableReportType(type = "") {
  const normalized = safeText(type, 80);
  if (!hiveReportTypes[normalized]) {
    const error = new Error("hive_report_type_invalid");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function markdownBody(value = "") {
  const body = safeText(value, 250_000);
  if (!body) {
    const error = new Error("hive_report_body_required");
    error.status = 400;
    throw error;
  }
  const first = body.trimStart().slice(0, 1);
  if (first === "{" || first === "[") {
    const error = new Error("hive_report_body_must_be_markdown");
    error.status = 400;
    throw error;
  }
  return body;
}

function reportRow(row = {}) {
  const body = row.body_markdown || "";
  return {
    id: safeText(row.id, 180),
    type: safeText(row.type, 80),
    label: hiveReportTypes[row.type]?.label || safeText(row.type, 80),
    version: safeText(row.version, 80),
    generatedAt: iso(row.generated_at),
    bodyMarkdown: body,
    bodyExcerpt: safeText(body.replace(/\s+/g, " "), 360),
    bodyBytes: Buffer.byteLength(body, "utf8"),
    sourceRunId: safeText(row.source_run_id, 180),
    model: safeText(row.model, 180),
    metadata: safeObject(row.metadata_json),
    verificationCount: Number(row.verification_count || 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function verificationRow(row = {}) {
  return {
    id: safeText(row.id, 180),
    reportId: safeText(row.report_id, 180),
    phase: safeText(row.phase, 40),
    agent: safeText(row.agent, 120),
    resultSummary: row.result_summary || "",
    verifiedAt: iso(row.verified_at),
    metadata: safeObject(row.metadata_json),
    createdAt: iso(row.created_at),
  };
}

function identitySummary(accountId = "", fallback = {}) {
  const profile = accountId ? getAccountIdentityProfile({ accountId }) || {} : {};
  const hiveHandle = safeText(profile.hiveHandle || profile.handle || profile.username || fallback.handle, 120).replace(/^@+/, "");
  const displayName = safeText(
    profile.publicDisplayName ||
      profile.displayName ||
      fallback.displayName ||
      (hiveHandle ? `@${hiveHandle}` : "") ||
      accountId,
    160
  );
  return {
    accountId: safeText(accountId, 180),
    displayName,
    hiveHandle,
    primaryProvider: safeText(profile.primaryProvider || fallback.primaryProvider, 80),
  };
}

function roleAccountRow(row = {}) {
  const evidence = safeObject(row.evidence_json);
  const metrics = safeObject(row.validated_metrics_json);
  const identity = identitySummary(row.account_id, {
    handle: evidence.handle || evidence.xHandle || evidence.githubHandle || evidence.username,
    displayName: evidence.displayName || evidence.name,
  });
  return {
    ...identity,
    walletAddress: safeText(row.wallet_address, 120),
    badgeId: safeText(row.badge_id, 80),
    role: roleDefinitions[row.badge_id]?.label || safeText(row.label || row.badge_id, 120),
    badgeLabel: safeText(row.label, 120),
    verifiedAt: iso(row.updated_at),
    evidence,
    metrics,
  };
}

function taskRow(row = {}) {
  const metadata = safeObject(row.metadata_json);
  const identity = identitySummary(row.account_id, {
    handle: metadata.hiveHandle || metadata.handle,
    displayName: metadata.displayName,
  });
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    accountId: safeText(row.account_id, 180),
    walletAddress: safeText(row.subject_wallet, 120),
    operator: identity,
    roleBadgeId: safeText(row.badge_id, 80),
    role: roleDefinitions[row.badge_id]?.label || safeText(row.badge_label || row.badge_id, 120),
    status: safeText(row.status, 80),
    title: safeText(row.title, 240),
    proposal: safeText(row.description || row.submission_requirement_text, 2200),
    submissionRequirement: safeText(row.submission_requirement_text, 1600),
    taskKind: safeText(row.task_kind, 80),
    rewardOfferPft: numeric(row.reward_offer_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    updatedAt: iso(row.updated_at),
    lastEventAt: iso(row.last_event_at),
    source: safeText(row.source, 80),
    metadata,
  };
}

function chatRow(row = {}) {
  return {
    id: safeText(row.id, 180),
    accountId: safeText(row.account_id, 180),
    displayName: safeText(row.display_name, 160),
    body: safeText(row.body, 6000),
    sourceConversationTitle: safeText(row.source_conversation_title, 160),
    createdAt: iso(row.created_at),
    metadata: safeObject(row.metadata_json),
  };
}

function projectTaskIsActive(task = {}) {
  return activeProjectTaskStatuses.includes(safeText(task.state || task.status, 80).toLowerCase());
}

function compactProjectTasks(project = {}, limit = 8) {
  const tasks = safeArray(project.tasks);
  const activeTasks = tasks.filter(projectTaskIsActive);
  return (activeTasks.length ? activeTasks : tasks).slice(0, limit).map((task) => ({
    taskId: safeText(task.taskId, 180),
    title: safeText(task.title, 240),
    state: safeText(task.state, 80),
    assigneeAccountId: safeText(task.assigneeAccountId, 180),
    assigneeHandle: safeText(task.assigneeHandle || task.assigneeDisplayName, 160),
    pft: numeric(task.pft),
    updatedAt: iso(task.updatedAt),
  }));
}

function compactProject(project = {}) {
  const taskCount = Number(project.taskCount || safeArray(project.tasks).length || 0);
  const tasksInFlight = Number(project.tasksInFlight ?? safeArray(project.tasks).filter(projectTaskIsActive).length ?? 0);
  return {
    id: safeText(project.id, 180),
    name: safeText(project.name || project.title, 180),
    type: safeText(project.type, 120),
    status: safeText(project.status, 80),
    priority: Number(project.priority || 0),
    summary: safeText(project.summary || project.objective || project.about, 700),
    taskCount,
    tasksInFlight,
    terminalTaskCount: Number(project.terminalTaskCount || Math.max(0, taskCount - tasksInFlight)),
    contributorCount: Number(project.contributorCount || safeArray(project.contributors).length || 0),
    pftRouted: numeric(project.pft),
    pendingGenerationCount: Number(project.pendingGenerationCount || 0),
    tasks: compactProjectTasks(project, 8),
  };
}

export async function saveHiveReport({
  id = "",
  type = "",
  version = hiveReportVersion,
  generatedAt = new Date(),
  bodyMarkdown = "",
  sourceRunId = "",
  model = "",
  metadata = {},
  verifications = [],
} = {}) {
  if (!useDatabase()) {
    const error = new Error("hive_reports_database_not_configured");
    error.status = 503;
    throw error;
  }
  const normalizedType = tableReportType(type);
  const reportId = safeText(id, 180) || `hiverep_${randomUUID()}`;
  const body = markdownBody(bodyMarkdown);
  await transaction(async (client) => {
    await client.query(
      `
        INSERT INTO hive_reports (
          id, type, version, generated_at, body_markdown, source_run_id, model, metadata_json, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), now())
        ON CONFLICT (id) DO UPDATE SET
          type = EXCLUDED.type,
          version = EXCLUDED.version,
          generated_at = EXCLUDED.generated_at,
          body_markdown = EXCLUDED.body_markdown,
          source_run_id = EXCLUDED.source_run_id,
          model = EXCLUDED.model,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now()
      `,
      [
        reportId,
        normalizedType,
        safeText(version, 80) || hiveReportVersion,
        generatedAt,
        body,
        safeText(sourceRunId, 180),
        safeText(model, 180),
        jsonValue(metadata),
      ]
    );
    for (const verification of safeArray(verifications)) {
      await client.query(
        `
          INSERT INTO hive_report_verifications (
            id, report_id, phase, agent, result_summary, verified_at, metadata_json, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
          ON CONFLICT (id) DO UPDATE SET
            phase = EXCLUDED.phase,
            agent = EXCLUDED.agent,
            result_summary = EXCLUDED.result_summary,
            verified_at = EXCLUDED.verified_at,
            metadata_json = EXCLUDED.metadata_json
        `,
        [
          safeText(verification.id, 180) || `hiverepv_${randomUUID()}`,
          reportId,
          safeText(verification.phase, 40),
          safeText(verification.agent, 120),
          markdownBody(verification.resultSummary || verification.result_summary || "Verification phase recorded."),
          verification.verifiedAt || verification.verified_at || generatedAt,
          jsonValue(verification.metadata || verification.metadata_json || {}),
        ]
      );
    }
  });
  return getHiveReport({ id: reportId });
}

export async function listHiveReports({
  type = "",
  since = "",
  limit = 20,
  page = 1,
  includeLatestByType = false,
} = {}) {
  if (!useDatabase()) {
    return { ok: true, reports: [], page: 1, pageSize: 0, hasMore: false, filters: { type: "", since: "" } };
  }
  const filters = [];
  const params = [];
  const normalizedType = safeText(type, 80);
  if (normalizedType) {
    tableReportType(normalizedType);
    params.push(normalizedType);
    filters.push(`r.type = $${params.length}`);
  }
  const sinceText = safeText(since, 80);
  if (sinceText) {
    params.push(sinceText);
    filters.push(`r.generated_at >= $${params.length}::timestamptz`);
  }
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 80);
  const normalizedPage = Math.min(Math.max(Number(page) || 1, 1), 1000);
  params.push(normalizedLimit + 1, (normalizedPage - 1) * normalizedLimit);
  const result = await query(
    `
      SELECT r.*,
             (
               SELECT count(*)::int
               FROM hive_report_verifications verification
               WHERE verification.report_id = r.id
             ) AS verification_count
      FROM hive_reports r
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY r.generated_at DESC, r.id DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `,
    params
  );
  let rows = result.rows.slice(0, normalizedLimit);
  const shouldIncludeLatestByType = Boolean(includeLatestByType) && !normalizedType && !sinceText && normalizedPage === 1;
  if (shouldIncludeLatestByType) {
    const latestByType = await query(
      `
        SELECT *
        FROM (
          SELECT r.*,
                 (
                   SELECT count(*)::int
                   FROM hive_report_verifications verification
                   WHERE verification.report_id = r.id
                 ) AS verification_count,
                 row_number() OVER (
                   PARTITION BY r.type
                   ORDER BY r.generated_at DESC, r.id DESC
                 ) AS type_rank
          FROM hive_reports r
        ) ranked
        WHERE type_rank = 1
      `
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of latestByType.rows) byId.set(row.id, row);
    rows = [...byId.values()].sort((left, right) => {
      const timeDiff = Number(new Date(right.generated_at)) - Number(new Date(left.generated_at));
      if (timeDiff) return timeDiff;
      return String(right.id || "").localeCompare(String(left.id || ""));
    });
  }
  return {
    ok: true,
    reports: rows.map(reportRow),
    page: normalizedPage,
    pageSize: normalizedLimit,
    hasMore: result.rows.length > normalizedLimit,
    filters: {
      type: normalizedType,
      since: sinceText,
      includeLatestByType: shouldIncludeLatestByType,
    },
  };
}

export async function getHiveReport({ id = "" } = {}) {
  const reportId = safeText(id, 180);
  if (!reportId) {
    return { ok: false, status: 400, error: "hive_report_id_required", message: "A report id is required." };
  }
  if (!useDatabase()) {
    return { ok: false, status: 503, error: "hive_reports_database_not_configured", message: "Hive reports require database storage." };
  }
  const result = await query(
    `
      SELECT r.*,
             (
               SELECT count(*)::int
               FROM hive_report_verifications verification
               WHERE verification.report_id = r.id
             ) AS verification_count
      FROM hive_reports r
      WHERE r.id = $1
      LIMIT 1
    `,
    [reportId]
  );
  const row = result.rows[0] || null;
  if (!row) {
    return { ok: false, status: 404, error: "hive_report_not_found", message: "Hive report not found." };
  }
  const verifications = await query(
    `
      SELECT *
      FROM hive_report_verifications
      WHERE report_id = $1
      ORDER BY verified_at ASC, id ASC
    `,
    [reportId]
  );
  return {
    ok: true,
    report: reportRow(row),
    verifications: verifications.rows.map(verificationRow),
  };
}

export async function latestHiveReport({ type = "" } = {}) {
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

export async function hiveReportDue({ type = "", now = new Date() } = {}) {
  const normalizedType = tableReportType(type);
  const latest = await latestHiveReport({ type: normalizedType });
  if (!latest?.generatedAt) return { due: true, latest: null, ageMs: null };
  const ageMs = Math.max(0, Number(now) - Number(new Date(latest.generatedAt)));
  return {
    due: ageMs >= hiveReportTypes[normalizedType].cadenceMs,
    latest,
    ageMs,
  };
}

async function listRoleAccounts() {
  const result = await query(
    `
      SELECT badge.account_id,
             badge.badge_id,
             badge.updated_at,
             badge.evidence_json,
             badge.validated_metrics_json,
             definition.label,
             wallet.subject_wallet AS wallet_address
      FROM account_network_badges badge
      JOIN network_badge_definitions definition
        ON definition.badge_id = badge.badge_id
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
  const rows = result.rows.map(roleAccountRow);
  return {
    accounts: rows,
    byRole: Object.fromEntries(Object.keys(roleDefinitions).map((role) => [
      role,
      rows.filter((row) => row.badgeId === role),
    ])),
  };
}

async function listRewardedTasksByRole({ perRole = 10 } = {}) {
  const result = await query(
    `
      WITH role_tasks AS (
        SELECT badge.badge_id,
               definition.label AS badge_label,
               projection.*,
               row_number() OVER (
                 PARTITION BY badge.badge_id
                 ORDER BY projection.last_event_at DESC NULLS LAST, projection.updated_at DESC, projection.task_id DESC
               ) AS role_rank
        FROM account_network_badges badge
        JOIN network_badge_definitions definition
          ON definition.badge_id = badge.badge_id
        JOIN task_projections projection
          ON projection.account_id = badge.account_id
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
  const rows = result.rows.map(taskRow);
  return Object.fromEntries(Object.keys(roleDefinitions).map((role) => [
    role,
    rows.filter((row) => row.roleBadgeId === role),
  ]));
}

async function listActiveTasksByRole({ perRole = 12 } = {}) {
  const result = await query(
    `
      WITH role_tasks AS (
        SELECT badge.badge_id,
               definition.label AS badge_label,
               projection.*,
               row_number() OVER (
                 PARTITION BY badge.badge_id
                 ORDER BY projection.updated_at DESC, projection.task_id DESC
               ) AS role_rank
        FROM account_network_badges badge
        JOIN network_badge_definitions definition
          ON definition.badge_id = badge.badge_id
        JOIN task_projections projection
          ON projection.account_id = badge.account_id
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
  const rows = result.rows.map(taskRow);
  return Object.fromEntries(Object.keys(roleDefinitions).map((role) => [
    role,
    rows.filter((row) => row.roleBadgeId === role),
  ]));
}

async function listRecentHiveChats({ sinceHours = 24, projectLeaderOnly = false, productFeedbackOnly = false } = {}) {
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

async function listProjectSnapshot() {
  const document = await getHiveProjectsDocument({ includeEmptyActive: true }).catch(() => null);
  const projects = Object.values(safeObject(document?.projects));
  return {
    generatedAt: document?.generatedAt || new Date().toISOString(),
    stats: safeObject(document?.stats),
    projects: projects.map(compactProject).slice(0, 30),
  };
}

function sourceCounts(source = {}) {
  return {
    roleAccountCount: safeArray(source.roles?.accounts).length,
    projectCount: safeArray(source.projects?.projects).length,
    rewardedTaskCount: Object.values(safeObject(source.rewardedTasksByRole)).reduce((sum, items) => sum + safeArray(items).length, 0),
    activeTaskCount: Object.values(safeObject(source.activeTasksByRole)).reduce((sum, items) => sum + safeArray(items).length, 0),
    hiveChatCount: safeArray(source.hiveChats).length,
    projectLeaderChatCount: safeArray(source.projectLeaderChats).length,
  };
}

export async function buildHiveReportSourcePacket({ type = "", now = new Date() } = {}) {
  const normalizedType = tableReportType(type);
  if (!useDatabase()) {
    return {
      schema: "pf.task_node.hive_report_source_packet.v1",
      type: normalizedType,
      generatedAt: now.toISOString(),
      databaseEnabled: false,
      roles: { accounts: [], byRole: {} },
      projects: { projects: [], stats: {} },
      rewardedTasksByRole: {},
      activeTasksByRole: {},
      hiveChats: [],
      projectLeaderChats: [],
      sourceCounts: {},
    };
  }
  const [
    roles,
    projects,
    rewardedTasksByRole,
    activeTasksByRole,
    hiveChats,
    productFeedbackChats,
    projectLeaderChats,
  ] = await Promise.all([
    listRoleAccounts(),
    listProjectSnapshot(),
    listRewardedTasksByRole({ perRole: 10 }),
    listActiveTasksByRole({ perRole: 12 }),
    listRecentHiveChats({ sinceHours: 24 }),
    listRecentHiveChats({ sinceHours: 24, productFeedbackOnly: true }),
    listRecentHiveChats({ sinceHours: 24, projectLeaderOnly: true }),
  ]);
  const source = {
    schema: "pf.task_node.hive_report_source_packet.v1",
    type: normalizedType,
    label: hiveReportTypes[normalizedType].label,
    generatedAt: now.toISOString(),
    roleDefinitions,
    focus: hiveReportTypes[normalizedType].summary,
    roles,
    projects,
    rewardedTasksByRole,
    activeTasksByRole,
    hiveChats: normalizedType === "qa" ? productFeedbackChats : hiveChats,
    projectLeaderChats,
  };
  return {
    ...source,
    sourceCounts: sourceCounts(source),
  };
}

export function hiveReportMetadataFromSource(sourcePacket = {}) {
  return {
    schema: "pf.task_node.hive_report_metadata.v1",
    type: safeText(sourcePacket.type, 80),
    label: safeText(sourcePacket.label, 120),
    generatedAt: safeText(sourcePacket.generatedAt, 80),
    sourceCounts: safeObject(sourcePacket.sourceCounts),
    roleDefinitions,
  };
}
