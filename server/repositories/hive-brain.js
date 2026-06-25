import { query } from "../db/pool.js";
import { hiveBrainLiveSnapshot } from "../hive-brain-live.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function iso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function bytes(value) {
  if (value === null || value === undefined) return 0;
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
}

function durationMs(startedAt, completedAt) {
  const startMs = Date.parse(startedAt || "");
  const endMs = Date.parse(completedAt || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function likePattern(value = "") {
  const text = safeText(value, 240).replace(/[\\%_]/g, (match) => `\\${match}`);
  return `%${text}%`;
}

async function tableExists(name = "") {
  const result = await query("SELECT to_regclass($1) AS name", [`public.${safeText(name, 80)}`]);
  return Boolean(result.rows[0]?.name);
}

function compactRun(row = {}) {
  const startedAt = iso(row.started_at);
  const completedAt = iso(row.completed_at);
  const outputBytes = Number(row.output_bytes || 0);
  const sourcePacketBytes = Number(row.source_packet_bytes || 0);
  const decisionBytes = Number(row.decision_bytes || 0);
  return {
    id: row.id || "",
    scope: row.scope || "",
    managerId: row.manager_id || "",
    trigger: row.trigger || "",
    status: row.status || "",
    sourcePacketDigest: row.source_packet_digest || "",
    selectedAction: row.selected_action || "",
    dryRun: Boolean(row.dry_run),
    provider: row.provider || "",
    model: row.model || "",
    reasoningEffort: row.reasoning_effort || "",
    error: row.error || "",
    startedAt,
    completedAt,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    durationMs: durationMs(startedAt, completedAt),
    sourcePacketBytes,
    decisionBytes,
    outputBytes,
    totalAuditBytes: sourcePacketBytes + decisionBytes + outputBytes,
    microSummary: safeObject(row.micro_summary_json),
    microSummaryText: row.micro_summary_text || "",
  };
}

function secretaryPacket(row = null) {
  if (!row) return null;
  return {
    id: row.id || "",
    scope: row.scope || "",
    packetType: row.packet_type || "",
    sourceDigest: row.source_digest || "",
    packetDigest: row.packet_digest || "",
    packetJson: safeObject(row.packet_json),
    packetText: row.packet_text || "",
    provider: row.provider || "",
    model: row.model || "",
    promptVersion: row.prompt_version || "",
    promptDigest: row.prompt_digest || "",
    responseId: row.response_id || "",
    usage: safeObject(row.usage_json),
    status: row.status || "",
    error: row.error || "",
    createdAt: iso(row.created_at),
    supersededAt: iso(row.superseded_at),
    packetBytes: bytes(row.packet_json),
    packetTextBytes: bytes(row.packet_text || ""),
  };
}

function highlightValue(value, fallback = "unknown") {
  if (Array.isArray(value)) return value.length;
  if (value === true || value === false) return value;
  if (value === 0 || value) return value;
  return fallback;
}

function countMaybeArray(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    if (Array.isArray(value.items)) return value.items.length;
    if (Array.isArray(value.rows)) return value.rows.length;
    if (Array.isArray(value.candidates)) return value.candidates.length;
  }
  return 0;
}

function buildHighlights(sourcePacket = {}, secretary = null) {
  const boardActionPressure = safeObject(sourcePacket.boardActionPressure || sourcePacket.board_action_pressure);
  const badgeEligibility = safeObject(sourcePacket.badgeEligibility || sourcePacket.badge_eligibility);
  const secretaryJson = safeObject(secretary?.packetJson);
  const candidateRows =
    sourcePacket.candidateRows ||
    sourcePacket.candidates ||
    badgeEligibility.candidates ||
    badgeEligibility.eligibleCandidates ||
    secretaryJson.badge_eligibility?.candidates ||
    [];
  const projectsWithoutLiveTasks =
    boardActionPressure.projectsWithoutLiveTasks ||
    boardActionPressure.projects_without_live_tasks ||
    sourcePacket.projectsWithoutLiveTasks ||
    [];
  const taskState = safeObject(sourcePacket.taskState || sourcePacket.task_state);
  const taskSummary = safeObject(taskState.summary || sourcePacket.taskSummary || sourcePacket.task_summary);
  return {
    requiresAction: highlightValue(
      boardActionPressure.requiresAction ?? boardActionPressure.requires_action ?? secretaryJson.requires_attention,
      false
    ),
    motionState: highlightValue(
      boardActionPressure.motionState ||
        boardActionPressure.motion_state ||
        secretaryJson.motion_state ||
        sourcePacket.motionState ||
        sourcePacket.motion_state
    ),
    eligibleCandidateCount: Number(
      badgeEligibility.eligibleCandidateCount ||
        badgeEligibility.eligible_candidate_count ||
        countMaybeArray(candidateRows) ||
        0
    ),
    projectsWithoutLiveTasks: countMaybeArray(projectsWithoutLiveTasks),
    outstandingNetworkTaskCount: Number(
      taskSummary.outstandingNetworkTaskCount ||
        taskSummary.outstanding_network_task_count ||
        taskSummary.networkTasksOutstanding ||
        taskSummary.network_tasks_outstanding ||
        0
    ),
    openFollowupCount: countMaybeArray(sourcePacket.openFollowups || sourcePacket.open_followups),
  };
}

function sourceSections(sourcePacket = {}) {
  return {
    projectsAndTasks: {
      hiveProjects: sourcePacket.hiveProjects || sourcePacket.hive_projects || null,
      projectRegistry: sourcePacket.projectRegistry || sourcePacket.project_registry || null,
      taskState: sourcePacket.taskState || sourcePacket.task_state || null,
      networkTaskContent: sourcePacket.networkTaskContent || sourcePacket.network_task_content || null,
    },
    candidateRows: {
      badgeEligibility: sourcePacket.badgeEligibility || sourcePacket.badge_eligibility || null,
      candidates: sourcePacket.candidateRows || sourcePacket.candidates || null,
      orcOperations: sourcePacket.orcOperations || sourcePacket.orc_operations || null,
    },
    hiveContext: {
      operatorStandingPolicy: sourcePacket.operatorStandingPolicy || sourcePacket.operator_standing_policy || null,
      generationQualityPolicy: sourcePacket.generationQualityPolicy || sourcePacket.generation_quality_policy || null,
      projectLeaderInputs: sourcePacket.projectLeaderInputs || sourcePacket.project_leader_inputs || null,
      openFollowups: sourcePacket.openFollowups || sourcePacket.open_followups || null,
    },
    recentRuns: sourcePacket.recentBoardManagerRuns || sourcePacket.recent_board_manager_runs || null,
    badgeEligibility: sourcePacket.badgeEligibility || sourcePacket.badge_eligibility || null,
  };
}

export async function listHiveBrainRuns({
  limit = 20,
  page = 1,
  action = "all",
  queryText = "",
} = {}) {
  if (!(await tableExists("board_manager_runs"))) {
    return { ok: true, runs: [], page: 1, pageSize: 0, hasMore: false, total: 0 };
  }
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const normalizedPage = Math.min(Math.max(Number(page) || 1, 1), 1000);
  const offset = (normalizedPage - 1) * normalizedLimit;
  const filters = ["scope = 'global_hive'"];
  const params = [];
  const selectSql = `
    SELECT id, scope, manager_id, trigger, status, source_packet_digest,
           selected_action, dry_run, provider, model, reasoning_effort,
           error, started_at, completed_at, created_at, updated_at,
           micro_summary_json, micro_summary_text,
           pg_column_size(source_packet_json) AS source_packet_bytes,
           pg_column_size(decision_json) AS decision_bytes,
           octet_length(COALESCE(output_text, '')) AS output_bytes,
           COALESCE(output_text, '') AS output_text
    FROM board_manager_runs
  `;
  const normalizedAction = safeText(action, 80).toLowerCase();
  if (normalizedAction && normalizedAction !== "all") {
    if (normalizedAction === "error") {
      filters.push("(status = 'failed' OR COALESCE(error, '') <> '')");
    } else {
      params.push(normalizedAction);
      filters.push(`selected_action = $${params.length}`);
    }
  }
  const search = safeText(queryText, 240);
  let result;
  if (search) {
    const recentWindow = Math.min(
      Math.max(Number(process.env.TASKNODE_HIVE_BRAIN_SEARCH_RECENT_LIMIT || 40), normalizedLimit),
      100
    );
    params.push(recentWindow);
    const recentWindowIndex = params.length;
    params.push(likePattern(search));
    const searchIndex = params.length;
    params.push(normalizedLimit + 1, offset);
    const limitIndex = params.length - 1;
    const offsetIndex = params.length;
    result = await query(
      `
        WITH recent_runs AS (
          ${selectSql}
          WHERE ${filters.join(" AND ")}
          ORDER BY started_at DESC NULLS LAST, created_at DESC, id DESC
          LIMIT $${recentWindowIndex}
        )
        SELECT id, scope, manager_id, trigger, status, source_packet_digest,
               selected_action, dry_run, provider, model, reasoning_effort,
               error, started_at, completed_at, created_at, updated_at,
               micro_summary_json, micro_summary_text,
               source_packet_bytes, decision_bytes, output_bytes
        FROM recent_runs
        WHERE (
          id ILIKE $${searchIndex} ESCAPE '\\' OR
          source_packet_digest ILIKE $${searchIndex} ESCAPE '\\' OR
          selected_action ILIKE $${searchIndex} ESCAPE '\\' OR
          trigger ILIKE $${searchIndex} ESCAPE '\\' OR
          status ILIKE $${searchIndex} ESCAPE '\\' OR
          COALESCE(error, '') ILIKE $${searchIndex} ESCAPE '\\' OR
          COALESCE(micro_summary_text, '') ILIKE $${searchIndex} ESCAPE '\\' OR
          output_text ILIKE $${searchIndex} ESCAPE '\\'
        )
        ORDER BY started_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      `,
      params
    );
  } else {
    params.push(normalizedLimit + 1, offset);
    result = await query(
      `
        SELECT id, scope, manager_id, trigger, status, source_packet_digest,
               selected_action, dry_run, provider, model, reasoning_effort,
               error, started_at, completed_at, created_at, updated_at,
               micro_summary_json, micro_summary_text,
               pg_column_size(source_packet_json) AS source_packet_bytes,
               pg_column_size(decision_json) AS decision_bytes,
               octet_length(COALESCE(output_text, '')) AS output_bytes
        FROM board_manager_runs
        WHERE ${filters.join(" AND ")}
        ORDER BY started_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params
    );
  }
  const rows = result.rows.slice(0, normalizedLimit);
  return {
    ok: true,
    runs: rows.map(compactRun),
    page: normalizedPage,
    pageSize: normalizedLimit,
    hasMore: result.rows.length > normalizedLimit,
    filters: {
      action: normalizedAction || "all",
      queryText: search,
    },
  };
}

export async function getHiveBrainRunDetail({ runId = "" } = {}) {
  const normalizedRunId = safeText(runId, 180);
  if (!normalizedRunId) {
    return { ok: false, status: 400, error: "hive_brain_run_id_required", message: "A Board Manager run id is required." };
  }
  if (!(await tableExists("board_manager_runs"))) {
    return { ok: false, status: 404, error: "hive_brain_runs_unavailable", message: "Board Manager run storage is not available." };
  }
  const result = await query(
    `
      SELECT id, scope, manager_id, trigger, status, source_packet_digest,
             source_packet_json, selected_action, action_payload_json, decision_json,
             dry_run, provider, model, reasoning_effort, output_text, error,
             codex_session_id, codex_session_path, session_mode,
             micro_summary_json, micro_summary_text, usage_json,
             started_at, completed_at, created_at, updated_at,
             pg_column_size(source_packet_json) AS source_packet_bytes,
             pg_column_size(decision_json) AS decision_bytes,
             octet_length(COALESCE(output_text, '')) AS output_bytes
      FROM board_manager_runs
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedRunId]
  );
  const row = result.rows[0] || null;
  if (!row) {
    return { ok: false, status: 404, error: "hive_brain_run_not_found", message: "Board Manager run not found." };
  }
  const sourcePacket = safeObject(row.source_packet_json);
  const sourceDigest =
    safeText(sourcePacket.rawSourcePacketDigest, 120) ||
    safeText(sourcePacket.secretaryPacket?.sourceDigest, 120) ||
    safeText(sourcePacket.secretarySourceDigest, 120) ||
    safeText(row.source_packet_digest, 120);
  const secretaryResult = await query(
    `
      SELECT id, scope, packet_type, source_digest, packet_digest,
             packet_json, packet_text, provider, model, prompt_version,
             prompt_digest, response_id, usage_json, status, error,
             created_at, superseded_at
      FROM board_manager_secretary_packets
      WHERE source_digest = $1
         OR packet_digest = $2
         OR id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [
      sourceDigest,
      safeText(sourcePacket.secretaryPacket?.packetDigest, 120),
      safeText(sourcePacket.secretaryPacket?.id, 180),
    ]
  ).catch(() => ({ rows: [] }));
  const actionResults = await query(
    `
      SELECT id, run_id, action, target_type, target_id, result_json, created_at
      FROM board_manager_action_results
      WHERE run_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [normalizedRunId]
  ).catch(() => ({ rows: [] }));
  const secretary = secretaryPacket(secretaryResult.rows[0] || null);
  const compact = compactRun(row);
  return {
    ok: true,
    run: {
      ...compact,
      actionPayload: safeObject(row.action_payload_json),
      decision: safeObject(row.decision_json),
      sourcePacket,
      outputText: row.output_text || "",
      usage: safeObject(row.usage_json),
      codexSessionId: row.codex_session_id || "",
      codexSessionPath: row.codex_session_path || "",
      sessionMode: row.session_mode || "",
    },
    highlights: buildHighlights(sourcePacket, secretary),
    sourcePacket,
    sourceSections: sourceSections(sourcePacket),
    secretaryReport: secretary || {
      packetJson: safeObject(sourcePacket.secretaryPacket?.packetJson),
      packetText: sourcePacket.secretaryPacket?.packetText || "",
      status: sourcePacket.secretaryPacket ? "embedded" : "missing",
      sourceDigest,
    },
    decision: {
      selectedAction: row.selected_action || "",
      actionPayload: safeObject(row.action_payload_json),
      decisionJson: safeObject(row.decision_json),
      outputText: row.output_text || "",
      provider: row.provider || "",
      model: row.model || "",
      reasoningEffort: row.reasoning_effort || "",
      usage: safeObject(row.usage_json),
    },
    result: {
      status: row.status || "",
      error: row.error || "",
      actionResults: actionResults.rows.map((item) => ({
        id: item.id,
        action: item.action || "",
        targetType: item.target_type || "",
        targetId: item.target_id || "",
        result: safeObject(item.result_json),
        createdAt: iso(item.created_at),
      })),
      durationMs: compact.durationMs,
      startedAt: compact.startedAt,
      completedAt: compact.completedAt,
      usage: safeObject(row.usage_json),
    },
    live: hiveBrainLiveSnapshot(),
  };
}

export async function getHiveBrainLive() {
  if (!(await tableExists("board_manager_runs"))) return hiveBrainLiveSnapshot();
  const selectSql = `
    SELECT id, scope, manager_id, trigger, status, source_packet_digest,
           selected_action, dry_run, provider, model, reasoning_effort,
           error, started_at, completed_at, created_at, updated_at,
           micro_summary_json, micro_summary_text, output_text,
           pg_column_size(source_packet_json) AS source_packet_bytes,
           pg_column_size(decision_json) AS decision_bytes,
           octet_length(COALESCE(output_text, '')) AS output_bytes
    FROM board_manager_runs
  `;
  let result = await query(
    `
      ${selectSql}
      WHERE scope = 'global_hive'
        AND status = 'running'
      ORDER BY started_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    `
  );
  if (!result.rows[0]) {
    result = await query(
      `
        ${selectSql}
        WHERE scope = 'global_hive'
        ORDER BY started_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
      `
    );
  }
  const row = result.rows[0] || null;
  if (!row) return hiveBrainLiveSnapshot();
  return {
    ok: true,
    latestRunId: row.id || "",
    run: {
      ...compactRun(row),
      outputText: row.output_text || "",
    },
  };
}
