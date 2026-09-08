import { databaseEnabled, query } from "../db/pool.js";

// Archived decision history. Kimi is the production manager; no autonomous writer lives here.
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

function iso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function runRow(row = {}, { includeSourcePacket = true } = {}) {
  const sourcePacketBytes = Number(row.source_packet_bytes || 0);
  return {
    id: safeText(row.id, 180),
    scope: safeText(row.scope, 120),
    trigger: safeText(row.trigger, 160),
    status: safeText(row.status, 80),
    shadow: row.shadow !== false,
    sourcePacketDigest: safeText(row.source_packet_digest, 120),
    sourcePacketBytes,
    sourcePacketOmitted: !includeSourcePacket && sourcePacketBytes > 0,
    inputReportIds: safeArray(row.input_report_ids),
    taskStatusSnapshot: safeObject(row.task_status_snapshot_json),
    discussionIds: safeArray(row.discussion_ids),
    sourcePacket: includeSourcePacket ? safeObject(row.source_packet_json) : {},
    reasoningText: row.reasoning_text || "",
    optionsConsidered: safeArray(row.options_considered_json),
    informedBy: safeObject(row.informed_by_json),
    selectedAction: safeText(row.selected_action, 80),
    actionPayload: safeObject(row.action_payload_json),
    decision: safeObject(row.decision_json),
    guardrailResult: safeObject(row.guardrail_result_json),
    result: safeObject(row.result_json),
    provider: safeText(row.provider, 80),
    model: safeText(row.model, 180),
    reasoningEffort: safeText(row.reasoning_effort, 40),
    outputText: row.output_text || "",
    error: row.error || "",
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function listHiveDecisionRuns({ limit = 20, page = 1, action = "all" } = {}) {
  if (!useDatabase()) return { ok: true, runs: [], page: 1, pageSize: 0, hasMore: false };
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 80);
  const normalizedPage = Math.min(Math.max(Number(page) || 1, 1), 1000);
  const filters = [];
  const params = [];
  const normalizedAction = safeText(action, 80);
  if (normalizedAction && normalizedAction !== "all") {
    params.push(normalizedAction);
    filters.push(`selected_action = $${params.length}`);
  }
  params.push(normalizedLimit + 1, (normalizedPage - 1) * normalizedLimit);
  const result = await query(
    `
      SELECT id, scope, trigger, status, shadow, source_packet_digest, input_report_ids,
             task_status_snapshot_json, discussion_ids, reasoning_text, options_considered_json,
             informed_by_json, selected_action, action_payload_json, decision_json,
             guardrail_result_json, result_json, provider, model, reasoning_effort,
             output_text, error, started_at, completed_at, created_at, updated_at,
             '{}'::jsonb AS source_packet_json
      FROM hive_decision_runs
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY started_at DESC, id DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `,
    params
  );
  return {
    ok: true,
    runs: result.rows.slice(0, normalizedLimit).map(runRow),
    page: normalizedPage,
    pageSize: normalizedLimit,
    hasMore: result.rows.length > normalizedLimit,
    filters: { action: normalizedAction || "all" },
  };
}

export async function getHiveDecisionRun({ runId = "", includeSourcePacket = true } = {}) {
  const normalizedRunId = safeText(runId, 180);
  if (!normalizedRunId) return { ok: false, status: 400, error: "hive_decision_run_id_required" };
  if (!useDatabase()) return { ok: false, status: 503, error: "hive_decision_database_not_configured" };
  const sourceSelect = includeSourcePacket ? "source_packet_json" : "'{}'::jsonb AS source_packet_json";
  const result = await query(
    `
      SELECT id, scope, trigger, status, shadow, source_packet_digest, input_report_ids,
             task_status_snapshot_json, discussion_ids, ${sourceSelect}, reasoning_text,
             options_considered_json, informed_by_json, selected_action, action_payload_json,
             decision_json, guardrail_result_json, result_json, provider, model,
             reasoning_effort, output_text, error, started_at, completed_at, created_at, updated_at,
             pg_column_size(source_packet_json) AS source_packet_bytes
      FROM hive_decision_runs
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedRunId]
  );
  const row = result.rows[0] || null;
  if (!row) return { ok: false, status: 404, error: "hive_decision_run_not_found" };
  return { ok: true, run: runRow(row, { includeSourcePacket }) };
}
