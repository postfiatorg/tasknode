import { randomUUID } from "node:crypto";
import { query, transaction } from "../db/pool.js";
import { listAccountIdentityProfiles } from "./account-profiles.js";
import {
  hiveReportVersion,
  hiveReportTypes,
  jsonValue,
  markdownBody,
  reportRow,
  roleDefinitions,
  safeArray,
  safeObject,
  safeText,
  tableReportType,
  useDatabase,
  verificationRow,
} from "./hive-report-contract.js";
import {
  buildBoardManagerPlanningReportSourcePacket,
  buildHiveIntelligenceReportSourcePacket,
} from "./hive-report-planning-source.js";
import {
  listActiveTasksByRole,
  listProjectSnapshot,
  listRecentHiveChats,
  listRewardedTasksByRole,
  listRoleAccounts,
  sourceCounts,
} from "./hive-report-source-base.js";

export {
  hiveReportIdentityFallbackFromRow,
  hiveReportTypeIds,
  hiveReportTypes,
  hiveReportVersion,
} from "./hive-report-contract.js";

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

export async function buildHiveReportSourcePacket({ type = "", now = new Date() } = {}) {
  const normalizedType = tableReportType(type);
  if (normalizedType === "hive_intelligence") {
    return buildHiveIntelligenceReportSourcePacket({ now });
  }
  if (normalizedType === "board_manager_planning") {
    return buildBoardManagerPlanningReportSourcePacket({ now });
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
  const identityByAccount = new Map((await listAccountIdentityProfiles())
    .map((profile) => [safeText(profile.accountId, 180), profile]));
  const [
    roles,
    projects,
    rewardedTasksByRole,
    activeTasksByRole,
    hiveChats,
    productFeedbackChats,
    projectLeaderChats,
  ] = await Promise.all([
    listRoleAccounts(identityByAccount),
    listProjectSnapshot(),
    listRewardedTasksByRole({ perRole: 10, identityByAccount }),
    listActiveTasksByRole({ perRole: 12, identityByAccount }),
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
