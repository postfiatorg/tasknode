import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";

const maxClaimLimit = 2;
const failedAttemptLimit = 3;
export const hiveProjectPlanningPromptVersion = "hive_active_projects_v1";
const projectTypes = new Set([
  "protocol_marketing",
  "protocol_development",
  "alpha_generation",
  "protocol_applications",
  "network_validation",
]);

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeJson(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

function intValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function slug(value = "") {
  const normalized = safeText(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || `project_${randomUUID().slice(0, 12)}`;
}

function normalizeProject(project = {}, index = 0) {
  const title = safeText(project.title || project.name, 180) || `Network project ${index + 1}`;
  const id = slug(project.id || title);
  const type = projectTypes.has(project.type) ? project.type : "protocol_development";
  const phaseCurrent = intValue(project.phase_current ?? project.phaseCurrent, 0);
  const phaseTotal = intValue(project.phase_total ?? project.phaseTotal, 0);
  const phaseLabel = safeText(
    project.phase_label ||
      project.phase ||
      (phaseCurrent && phaseTotal ? `${phaseCurrent} of ${phaseTotal}` : ""),
    80
  );
  return {
    id,
    type,
    title,
    summary: safeText(project.summary, 500),
    objective: safeText(project.objective, 800),
    about: safeText(project.about || project.description, 1800),
    status: "active",
    priority: intValue(project.priority, (index + 1) * 10),
    phase_label: phaseLabel,
    phase_current: phaseCurrent,
    phase_total: phaseTotal,
    pft_routed: numberValue(project.pft_routed ?? project.pftRouted ?? project.pft_target ?? project.pftTarget, 0),
    task_count: intValue(project.task_count ?? project.taskCount ?? project.scoped_task_count ?? project.scopedTaskCount, 0),
    contributor_count: intValue(
      project.contributor_count ?? project.contributorCount ?? project.target_contributor_count ?? project.targetContributorCount,
      0
    ),
    rationale: safeText(project.rationale || project.reason, 1200),
  };
}

export function normalizeHiveProjectPlanningOutput(output = {}) {
  const raw = safeJson(output);
  const projects = safeArray(raw.projects)
    .slice(0, 8)
    .map((project, index) => normalizeProject(project, index))
    .filter((project) => project.title && project.summary);
  return {
    title: safeText(raw.title, 180) || "Hive Active Projects",
    summary: safeText(raw.summary, 1200),
    projects,
  };
}

export async function latestHiveProjectPlanningState() {
  if (!useDatabase()) return { job: null, generation: null };
  const [jobResult, generationResult] = await Promise.all([
    query(
      `
        SELECT *
        FROM hive_project_planning_jobs
        WHERE status IN ('pending', 'processing')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
    ),
    query(
      `
        SELECT *
        FROM hive_project_generations
        WHERE status = 'completed'
        ORDER BY completed_at DESC, created_at DESC, id DESC
        LIMIT 1
      `
    ),
  ]);
  return {
    job: publicJob(jobResult.rows[0] || null),
    generation: publicGeneration(generationResult.rows[0] || null),
  };
}

export async function enqueueHiveProjectPlanningJob({ report, reason = "hive_secretary_completed" } = {}) {
  if (!useDatabase() || !report?.id) return { queued: false, reason: "database_or_report_missing" };
  const existingProjects = await query(
    `
      SELECT id, type, title, summary, objective, about, status, priority, phase_label,
             phase_current, phase_total, pft_routed, task_count, contributor_count, origin
      FROM network_projects
      WHERE status IN ('active', 'paused')
      ORDER BY priority ASC, title ASC
      LIMIT 20
    `
  );
  const sourcePacket = {
    secretary_report: {
      id: report.id,
      digest: report.source_packet_digest || report.sourcePacketDigest,
      output: report.output_json || report.output || {},
      completed_at: report.completed_at || report.completedAt || null,
    },
    existing_projects: existingProjects.rows,
    project_types: Array.from(projectTypes),
  };
  const sourceText = [
    "HIVE SECRETARY REPORT",
    JSON.stringify(sourcePacket.secretary_report, null, 2),
    "CURRENT PROJECTS",
    JSON.stringify(sourcePacket.existing_projects, null, 2),
  ].join("\n\n");
  const result = await query(
    `
      INSERT INTO hive_project_planning_jobs (
        id,
        reason,
        source_report_id,
        source_report_digest,
        source_packet_json,
        source_packet_text,
        prompt_version
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
      ON CONFLICT (source_report_id, prompt_version)
      DO UPDATE SET
        reason = EXCLUDED.reason,
        source_report_digest = EXCLUDED.source_report_digest,
        source_packet_json = EXCLUDED.source_packet_json,
        source_packet_text = EXCLUDED.source_packet_text,
        status = CASE
          WHEN hive_project_planning_jobs.status = 'failed' THEN 'pending'
          ELSE hive_project_planning_jobs.status
        END,
        next_attempt_at = CASE
          WHEN hive_project_planning_jobs.status = 'failed' THEN now()
          ELSE hive_project_planning_jobs.next_attempt_at
        END,
        updated_at = now()
      RETURNING *
    `,
    [
      `hiveprojectjob_${randomUUID()}`,
      safeText(reason, 120),
      safeText(report.id, 180),
      safeText(report.source_packet_digest || report.sourcePacketDigest, 180),
      jsonValue(sourcePacket),
      sourceText,
      hiveProjectPlanningPromptVersion,
    ]
  );
  return { queued: true, job: publicJob(result.rows[0]) };
}

export async function claimHiveProjectPlanningJobs({ limit = 1 } = {}) {
  if (!useDatabase()) return [];
  const normalizedLimit = Math.min(Math.max(Number(limit) || 1, 1), maxClaimLimit);
  return transaction(async (client) => {
    await client.query(
      `
        UPDATE hive_project_planning_jobs
        SET status = 'pending',
            next_attempt_at = now(),
            locked_at = NULL,
            updated_at = now()
        WHERE status = 'processing'
          AND locked_at < now() - interval '10 minutes'
      `
    );
    const result = await client.query(
      `
        WITH picked AS (
          SELECT id
          FROM hive_project_planning_jobs
          WHERE status = 'pending'
            AND next_attempt_at <= now()
          ORDER BY created_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE hive_project_planning_jobs AS job
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            locked_at = now(),
            updated_at = now()
        FROM picked
        WHERE job.id = picked.id
        RETURNING job.*
      `,
      [normalizedLimit]
    );
    return result.rows;
  });
}

export async function completeHiveProjectPlanningJob({
  job,
  output = {},
  provider = "",
  model = "",
  promptDigest = "",
  responseId = "",
  usage = {},
} = {}) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const normalized = normalizeHiveProjectPlanningOutput(output);
  if (!normalized.projects.length) throw new Error("hive_project_planning_no_projects");
  return transaction(async (client) => {
    const inserted = await client.query(
      `
        INSERT INTO hive_project_generations (
          id,
          source_report_id,
          source_report_digest,
          source_packet_json,
          source_packet_text,
          output_json,
          output_text,
          provider,
          model,
          prompt_version,
          prompt_digest,
          response_id,
          usage_json,
          completed_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb, now())
        RETURNING *
      `,
      [
        `hiveprojectgen_${randomUUID()}`,
        safeText(job.source_report_id, 180),
        safeText(job.source_report_digest, 180),
        jsonValue(job.source_packet_json),
        safeText(job.source_packet_text, 120_000),
        jsonValue(normalized),
        formatProjectPlanningOutput(normalized),
        safeText(provider, 80),
        safeText(model, 160),
        safeText(job.prompt_version || hiveProjectPlanningPromptVersion, 120),
        safeText(promptDigest, 120),
        safeText(responseId, 200),
        jsonValue(usage),
      ]
    );

    const activeIds = normalized.projects.map((project) => project.id);
    for (const project of normalized.projects) {
      await client.query(
        `
          INSERT INTO network_projects (
            id,
            type,
            title,
            summary,
            objective,
            about,
            status,
            priority,
            origin,
            proposed_by,
            proposed_at,
            phase_label,
            phase_current,
            phase_total,
            pft_routed,
            task_count,
            contributor_count,
            source_hive_secretary_report_id,
            source_hive_secretary_report_digest,
            source_inputs_json,
            metadata_json
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, 'active', $7, 'system_generated', 'hive',
            CURRENT_DATE, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb
          )
          ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type,
            title = EXCLUDED.title,
            summary = EXCLUDED.summary,
            objective = EXCLUDED.objective,
            about = EXCLUDED.about,
            status = 'active',
            priority = EXCLUDED.priority,
            origin = EXCLUDED.origin,
            proposed_by = EXCLUDED.proposed_by,
            phase_label = EXCLUDED.phase_label,
            phase_current = EXCLUDED.phase_current,
            phase_total = EXCLUDED.phase_total,
            pft_routed = EXCLUDED.pft_routed,
            task_count = EXCLUDED.task_count,
            contributor_count = EXCLUDED.contributor_count,
            source_hive_secretary_report_id = EXCLUDED.source_hive_secretary_report_id,
            source_hive_secretary_report_digest = EXCLUDED.source_hive_secretary_report_digest,
            source_inputs_json = EXCLUDED.source_inputs_json,
            metadata_json = network_projects.metadata_json || EXCLUDED.metadata_json,
            updated_at = now()
        `,
        [
          project.id,
          project.type,
          project.title,
          project.summary,
          project.objective,
          project.about,
          project.priority,
          project.phase_label,
          project.phase_current,
          project.phase_total,
          project.pft_routed,
          project.task_count,
          project.contributor_count,
          safeText(job.source_report_id, 180),
          safeText(job.source_report_digest, 180),
          jsonValue({
            inputs: ["hive_secretary_report", "gpt_5_5_pro_project_planning"],
            hive_secretary: {
              report_id: job.source_report_id,
              source_packet_digest: job.source_report_digest,
            },
            active_project_generation: {
              generation_id: inserted.rows[0].id,
              prompt_version: job.prompt_version || hiveProjectPlanningPromptVersion,
            },
          }),
          jsonValue({ rationale: project.rationale }),
        ]
      );
    }

    await client.query(
      `
        UPDATE network_projects
        SET status = 'paused',
            updated_at = now()
        WHERE origin IN ('system_generated', 'system_seed')
          AND status = 'active'
          AND id <> ALL($1::text[])
      `,
      [activeIds]
    );
    await client.query(
      `
        UPDATE hive_project_planning_jobs
        SET status = 'completed',
            locked_at = NULL,
            last_error = '',
            updated_at = now()
        WHERE id = $1
      `,
      [job.id]
    );
    return { ok: true, generation: publicGeneration(inserted.rows[0]), projects: normalized.projects };
  });
}

export async function failHiveProjectPlanningJob(job, error) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const attemptCount = Number(job.attempt_count || 0);
  const finalFailure = attemptCount >= failedAttemptLimit;
  const backoffSeconds = Math.min(1800, Math.max(60, 60 * attemptCount * attemptCount));
  await query(
    `
      UPDATE hive_project_planning_jobs
      SET status = $2,
          next_attempt_at = CASE
            WHEN $2 = 'failed' THEN next_attempt_at
            ELSE now() + ($3::text || ' seconds')::interval
          END,
          locked_at = NULL,
          last_error = $4,
          updated_at = now()
      WHERE id = $1
    `,
    [
      job.id,
      finalFailure ? "failed" : "pending",
      String(backoffSeconds),
      safeText(error?.message || error || "hive_project_planning_job_failed", 1000),
    ]
  );
  return { ok: true, retry: !finalFailure };
}

function publicJob(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    sourceReportId: row.source_report_id,
    sourceReportDigest: row.source_report_digest,
    promptVersion: row.prompt_version,
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

function formatProjectPlanningOutput(output = {}) {
  const projects = safeArray(output.projects)
    .map((project) => `- ${project.title} (${project.type}): ${project.summary}`)
    .join("\n");
  return [safeText(output.title || "Hive Active Projects", 180), safeText(output.summary, 1200), projects]
    .filter(Boolean)
    .join("\n\n");
}
