import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { getAccountIdentityProfile } from "../runtime-store.js";
import { getHiveProjectsDocument } from "./hive-projects.js";
import { getHiveLiveTaskPacket } from "./hive-live-task-packet.js";
import { getLatestTaskAccountingHarvestReport } from "./task-accounting-harvester.js";

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
  hive_intelligence: {
    type: "hive_intelligence",
    label: "Hive Intelligence",
    cadenceMs: 6 * 60 * 60 * 1000,
    summary: "Strategic network intelligence brief synthesized from Hive reports, Harvest Report, Live Task Packet, and Board Secretary memos.",
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

function firstText(...values) {
  for (const value of values) {
    const text = safeText(value, 500);
    if (text) return text;
  }
  return "";
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
  const publicHandle = safeText(fallback.publicHandle || "", 120).replace(/^@+/, "");
  const providerHandle = safeText(fallback.providerHandle || "", 120).replace(/^@+/, "");
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
    publicHandle,
    providerHandle,
    profileUrl: safeText(fallback.profileUrl, 500),
    primaryProvider: safeText(profile.primaryProvider || fallback.primaryProvider, 80),
  };
}

export function hiveReportIdentityFallbackFromRow(row = {}) {
  const evidence = safeObject(row.evidence_json || row.evidence);
  const metrics = safeObject(row.validated_metrics_json || row.metrics);
  const nestedEvidence = safeObject(evidence.evidence);
  const publicHandle = firstText(
    row.public_handle,
    row.identity_public_handle,
    evidence.publicHandle,
    nestedEvidence.publicHandle
  ).replace(/^@+/, "");
  const providerHandle = firstText(
    row.provider_handle,
    row.provider_public_handle,
    evidence.xHandle,
    evidence.githubHandle,
    evidence.handle,
    evidence.username,
    nestedEvidence.xHandle,
    nestedEvidence.githubHandle,
    nestedEvidence.handle,
    nestedEvidence.username,
    metrics.xHandle,
    metrics.githubHandle,
    metrics.handle,
    metrics.username
  ).replace(/^@+/, "");
  return {
    publicHandle,
    providerHandle,
    profileUrl: firstText(row.provider_profile_url, evidence.profileUrl, nestedEvidence.profileUrl),
    handle: publicHandle || providerHandle,
    displayName: firstText(
      evidence.displayName,
      nestedEvidence.displayName,
      evidence.name,
      nestedEvidence.name,
      publicHandle,
      providerHandle
    ),
  };
}

function roleAccountRow(row = {}) {
  const evidence = safeObject(row.evidence_json);
  const metrics = safeObject(row.validated_metrics_json);
  const fallback = hiveReportIdentityFallbackFromRow(row);
  const identity = identitySummary(row.account_id, fallback);
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
    handle: metadata.hiveHandle || metadata.handle || row.public_handle,
    publicHandle: row.public_handle,
    displayName: metadata.displayName || row.public_handle,
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

const hiveIntelligenceSourceReportTypes = Object.freeze([
  "operative",
  "rewarded_task",
  "kol",
  "development",
  "qa",
  "executive",
]);

function compactStoredReport(row = {}, { bodyMax = 18000 } = {}) {
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

async function latestReportsForHiveIntelligence() {
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

async function currentBoardSecretaryMemosForHiveIntelligence({ limit = 40 } = {}) {
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

function badgeHandleFromEvidence(row = {}) {
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

function compactBadgeOperator(row = {}) {
  const handle = badgeHandleFromEvidence(row);
  return {
    accountId: safeText(row.account_id, 180),
    handle: handle ? `@${handle}` : "",
    walletAddress: safeText(row.wallet_address, 120),
    badgeId: safeText(row.badge_id, 80),
    badgeLabel: safeText(row.badge_label || row.label, 120),
  };
}

async function taskRoutingConstraintsForHiveIntelligence({ limit = 80 } = {}) {
  const rules = [
    "Task deployment or reassignment recommendations must obey the task requiredBadgeId and operatingBadgeId.",
    "Only recommend a named operator for a task when that operator is listed as badge-eligible for the task's required badge in this packet.",
    "Do not infer badge eligibility from profile text, project point-person status, prior rewards, skills, or wallet history.",
    "If the desired operator is not badge-eligible, recommend a message, a new correctly scoped task, or a founder-level badge/policy change instead of deploying the task to that operator.",
  ];
  if (!useDatabase()) {
    return {
      schema: "pf.task_node.hive_intelligence_task_routing_constraints.v1",
      rules,
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
                 tp.metadata_json #>> '{generatedTask,generation,network_taskgen_v2_gate,requiredBadge}',
                 tp.metadata_json #>> '{taskgen,network_taskgen_v2_gate,requiredBadge}',
                 tp.metadata_json #>> '{generatedTask,network_task,operating_badge_id}',
                 tp.metadata_json #>> '{generatedTask,network_task,operatingBadgeId}',
                 ''
               ) AS required_badge_id,
               COALESCE(
                 tp.metadata_json #>> '{generatedTask,network_task,operating_badge_id}',
                 tp.metadata_json #>> '{generatedTask,network_task,operatingBadgeId}',
                 tp.metadata_json #>> '{generatedTask,generation,network_taskgen_v2_gate,operatingBadge}',
                 tp.metadata_json #>> '{taskgen,network_taskgen_v2_gate,operatingBadge}',
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
               (
                 SELECT event.wallet_address
                 FROM user_observability_events event
                 WHERE event.account_id = badge.account_id
                   AND event.wallet_address <> ''
                 ORDER BY event.occurred_at DESC, event.id DESC
                 LIMIT 1
               ) AS wallet_address
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
    rules,
    activeTaskRequirements,
    eligibleOperatorsByBadge,
  };
}

async function buildHiveIntelligenceReportSourcePacket({ now = new Date() } = {}) {
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

export async function buildHiveReportSourcePacket({ type = "", now = new Date() } = {}) {
  const normalizedType = tableReportType(type);
  if (normalizedType === "hive_intelligence") {
    return buildHiveIntelligenceReportSourcePacket({ now });
  }
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
