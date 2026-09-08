import { databaseEnabled, query } from "../db/pool.js";

// Historical planner results remain readable; board writes belong to Kimi and operators.
function useDatabase() { return databaseEnabled(); }
function safeJson(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

export function projectHasOperatorArchiveLock(row = {}) {
  const metadata = safeJson(row.metadata_json);
  return Boolean(metadata.operator_archived === true || metadata.archive_lock_source || metadata.archive_lock_applied_at);
}

export async function latestHiveProjectPlanningState() {
  if (!useDatabase()) return { job: null, generation: null };
  const result = await query(`
    SELECT * FROM hive_project_generations
    WHERE status = 'completed'
    ORDER BY completed_at DESC, created_at DESC, id DESC
    LIMIT 1
  `);
  return { job: null, generation: publicGeneration(result.rows[0] || null) };
}

function publicGeneration(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    sourceReportId: row.source_report_id,
    sourceReportDigest: row.source_report_digest,
    output: row.output_json || {},
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    promptDigest: row.prompt_digest,
    responseId: row.response_id,
    usage: row.usage_json || {},
    completedAt: row.completed_at,
  };
}
