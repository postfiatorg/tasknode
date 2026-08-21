import { query } from "../db/pool.js";
import { hiveBrainLiveSnapshot } from "../hive-brain-live.js";

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

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function firstText(values = [], max = 240) {
  for (const value of values) {
    const text = safeText(value, max);
    if (text) return text;
  }
  return "";
}

function historyOccurredAt(item = {}) {
  return iso(item.completedAt || item.updatedAt || item.startedAt || item.createdAt);
}

function compactTaskManagerHistory(row = {}) {
  const decision = safeObject(row.decision_json);
  const actionPayload = safeObject(row.action_payload_json);
  const guardrail = safeObject(row.guardrail_result_json);
  const result = safeObject(row.result_json);
  const executionResult = safeObject(result.executionResult || result.execution_result);
  const board = safeObject(
    decision.boardSelection ||
      decision.board_selection ||
      actionPayload.boardSelection ||
      actionPayload.board_selection
  );
  const operator = safeObject(
    decision.operatorSelection ||
      decision.operator_selection ||
      actionPayload.operatorSelection ||
      actionPayload.operator_selection
  );
  const taskIntent = safeObject(
    decision.taskIntent ||
      decision.task_intent ||
      actionPayload.taskIntent ||
      actionPayload.task_intent
  );
  const startedAt = iso(row.started_at);
  const completedAt = iso(row.completed_at);
  const updatedAt = iso(row.updated_at);
  const createdAt = iso(row.created_at);
  const executed = result.executed === true || executionResult.executed === true;
  const title = firstText([
    taskIntent.title,
    taskIntent.task_title,
    executionResult.title,
    executionResult.taskTitle,
    executionResult.task_title,
    row.selected_action === "create_task" ? "Task Manager selected a task" : "",
    row.selected_action || row.status,
  ], 240);
  return {
    id: row.id || "",
    kind: "task_manager_run",
    label: "Task Manager selection",
    scope: row.scope || "",
    trigger: row.trigger || "",
    status: row.status || "",
    action: row.selected_action || "",
    title,
    summary: firstText([
      row.reasoning_text,
      decision.explanation,
      actionPayload.explanation,
      taskIntent.routingReason,
      taskIntent.routing_reason,
      executionResult.reason,
    ], 1000),
    projectId: firstText([board.projectId, board.project_id, executionResult.projectId, executionResult.project_id], 180),
    projectTitle: firstText([board.projectTitle, board.project_title, board.title, executionResult.projectTitle], 240),
    accountId: firstText([operator.accountId, operator.account_id, executionResult.accountId, executionResult.account_id], 180),
    walletAddress: firstText([operator.walletAddress, operator.wallet_address, executionResult.walletAddress, executionResult.wallet_address], 140),
    requiredBadgeId: firstText([operator.requiredBadgeId, operator.required_badge_id], 80),
    badgeWorkType: firstText([operator.badgeWorkType, operator.badge_work_type, operator.taskWorkType, operator.task_work_type], 120),
    rewardMinPft: numeric(taskIntent.rewardMinPft ?? taskIntent.reward_min_pft, 0),
    rewardMaxPft: numeric(taskIntent.rewardMaxPft ?? taskIntent.reward_max_pft, 0),
    requestId: firstText([executionResult.requestId, executionResult.request_id], 180),
    jobId: firstText([executionResult.jobId, executionResult.job_id, executionResult.generationJobId], 180),
    allocationId: firstText([executionResult.allocationId, executionResult.allocation_id], 180),
    taskId: firstText([executionResult.taskId, executionResult.task_id], 180),
    guardrailOk: guardrail.ok === true,
    guardrailBlocked: guardrail.blocked === true,
    guardrailReasons: safeArray(guardrail.reasons).map((reason) => safeText(reason, 180)).filter(Boolean),
    executed,
    resultSummary: firstText([
      executionResult.reason,
      executionResult.status,
      executed ? "Queued Network Task generation." : "",
      row.error,
    ], 1000),
    model: row.model || "",
    provider: row.provider || "",
    reasoningEffort: row.reasoning_effort || "",
    error: row.error || "",
    startedAt,
    completedAt,
    createdAt,
    updatedAt,
    occurredAt: historyOccurredAt({ completedAt, updatedAt, startedAt, createdAt }),
  };
}

function compactGenerationJobHistory(row = {}) {
  const sourcePayload = safeObject(row.source_payload_json);
  const generatedPayload = safeObject(row.generated_task_payload);
  const networkTask = safeObject(sourcePayload.networkTask || sourcePayload.network_task);
  const project = safeObject(sourcePayload.project);
  const candidate = safeObject(sourcePayload.candidate);
  const taskManager = safeObject(sourcePayload.taskManager || sourcePayload.task_manager);
  const taskManagerSelection = safeObject(taskManager.selection);
  const taskIntent = safeObject(taskManagerSelection.taskIntent || taskManagerSelection.task_intent);
  const operatorSelection = safeObject(taskManagerSelection.operatorSelection || taskManagerSelection.operator_selection);
  const boardSelection = safeObject(taskManagerSelection.boardSelection || taskManagerSelection.board_selection);
  const updatedAt = iso(row.updated_at);
  const createdAt = iso(row.created_at);
  const lastEventAt = iso(row.projected_last_event_at);
  const title = firstText([
    row.projected_task_title,
    generatedPayload.title,
    taskIntent.title,
    networkTask.title,
    row.task_id,
    row.request_id,
    row.id,
  ], 240);
  const rewardMin = numeric(row.reward_min_pft ?? networkTask.rewardMinPft ?? networkTask.reward_min_pft, 0);
  const rewardMax = numeric(row.reward_max_pft ?? networkTask.rewardMaxPft ?? networkTask.reward_max_pft, 0);
  return {
    id: row.id || "",
    kind: "generation_job",
    label: "Network Task generation job",
    status: row.projected_task_status || row.status || "",
    generationStatus: row.status || "",
    allocationStatus: row.allocation_status || "",
    title,
    summary: firstText([
      networkTask.projectNeedSummary,
      networkTask.project_need_summary,
      row.allocation_project_need_summary,
      taskIntent.projectNeedSummary,
      taskIntent.project_need_summary,
      sourcePayload.decision?.reason,
      row.last_error,
    ], 1000),
    routingReason: firstText([
      networkTask.allocationReasonSummary,
      networkTask.allocation_reason_summary,
      row.allocation_reason_summary,
      taskIntent.routingReason,
      taskIntent.routing_reason,
    ], 1000),
    projectId: firstText([row.project_id, project.id, boardSelection.projectId, boardSelection.project_id], 180),
    projectTitle: firstText([row.project_title, project.title, boardSelection.projectTitle, boardSelection.title], 240),
    projectType: firstText([row.project_type, project.type], 120),
    accountId: firstText([row.candidate_account_id, candidate.accountId, candidate.account_id, operatorSelection.accountId, operatorSelection.account_id], 180),
    walletAddress: firstText([row.candidate_wallet_address, candidate.walletAddress, candidate.wallet_address, operatorSelection.walletAddress, operatorSelection.wallet_address], 140),
    requiredBadgeId: firstText([networkTask.requiredBadgeId, networkTask.required_badge_id, operatorSelection.requiredBadgeId, operatorSelection.required_badge_id], 80),
    badgeWorkType: firstText([networkTask.badgeWorkType, networkTask.badge_work_type, operatorSelection.badgeWorkType, operatorSelection.badge_work_type], 120),
    rewardMinPft: rewardMin,
    rewardMaxPft: rewardMax,
    rewardOfferPft: numeric(row.projected_reward_offer_pft, 0),
    rewardActualPft: numeric(row.projected_reward_actual_pft, 0),
    requestId: row.request_id || "",
    jobId: row.id || "",
    allocationId: row.allocation_id || "",
    taskId: row.task_id || "",
    promptVersion: row.prompt_version || "",
    sourcePayloadDigest: row.source_payload_digest || "",
    offerCid: row.offer_cid || "",
    offerTxHash: row.offer_tx_hash || "",
    attemptCount: numeric(row.attempt_count, 0),
    error: row.last_error || "",
    createdAt,
    updatedAt,
    lastEventAt,
    occurredAt: historyOccurredAt({ updatedAt, createdAt, completedAt: lastEventAt }),
  };
}

export async function listHiveBrainTaskGenerationHistory({
  limit = 24,
  page = 1,
} = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 24, 1), 80);
  const normalizedPage = Math.min(Math.max(Number(page) || 1, 1), 1000);
  const offset = (normalizedPage - 1) * normalizedLimit;
  const windowLimit = Math.min(Math.max(offset + normalizedLimit + 1, normalizedLimit + 1), 200);
  const hasDecisionRuns = await tableExists("hive_decision_runs");
  const hasGenerationJobs = await tableExists("network_task_generation_jobs");
  const [decisionResult, jobResult] = await Promise.all([
    hasDecisionRuns
      ? query(
          `
            SELECT id, scope, trigger, status, shadow, selected_action,
                   action_payload_json, decision_json, guardrail_result_json,
                   result_json, reasoning_text, provider, model,
                   reasoning_effort, output_text, error, started_at,
                   completed_at, created_at, updated_at
            FROM hive_decision_runs
            WHERE scope LIKE 'hive_task_manager:%'
            ORDER BY started_at DESC NULLS LAST, created_at DESC, id DESC
            LIMIT $1
          `,
          [windowLimit]
        )
      : Promise.resolve({ rows: [] }),
    hasGenerationJobs
      ? query(
          `
            SELECT job.id, job.allocation_id, job.project_id, job.task_class,
                   job.candidate_account_id, job.candidate_wallet_address,
                   job.reward_min_pft, job.reward_max_pft, job.status,
                   job.trigger, job.board_manager_run_id, job.request_id,
                   job.source_payload_digest, job.source_payload_json,
                   job.provider, job.model, job.prompt_version,
                   job.request_bundle_cid, job.generated_task_payload,
                   job.task_id, job.offer_cid, job.offer_tx_hash,
                   job.attempt_count, job.last_error,
                   job.created_at, job.updated_at,
                   project.title AS project_title,
                   project.type AS project_type,
                   allocation.allocation_status,
                   allocation.project_need_summary AS allocation_project_need_summary,
                   allocation.allocation_reason_summary,
                   projection.title AS projected_task_title,
                   projection.status AS projected_task_status,
                   projection.reward_offer_pft AS projected_reward_offer_pft,
                   projection.reward_actual_pft AS projected_reward_actual_pft,
                   projection.last_event_at AS projected_last_event_at
            FROM network_task_generation_jobs job
            LEFT JOIN network_projects project ON project.id = job.project_id
            LEFT JOIN network_task_allocations allocation ON allocation.id = job.allocation_id
            LEFT JOIN task_projections projection ON projection.task_id = job.task_id
            ORDER BY job.updated_at DESC, job.created_at DESC, job.id DESC
            LIMIT $1
          `,
          [windowLimit]
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const items = [
    ...decisionResult.rows.map(compactTaskManagerHistory),
    ...jobResult.rows.map(compactGenerationJobHistory),
  ].sort((left, right) => {
    const leftMs = Date.parse(left.occurredAt || left.updatedAt || left.createdAt || "");
    const rightMs = Date.parse(right.occurredAt || right.updatedAt || right.createdAt || "");
    return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
  });
  return {
    ok: true,
    items: items.slice(offset, offset + normalizedLimit),
    page: normalizedPage,
    pageSize: normalizedLimit,
    hasMore: items.length > offset + normalizedLimit,
    sources: {
      taskManagerRuns: hasDecisionRuns,
      generationJobs: hasGenerationJobs,
    },
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

export async function getHiveBrainRunDetail({ runId = "", includeSourcePacket = true } = {}) {
  const normalizedRunId = safeText(runId, 180);
  if (!normalizedRunId) {
    return { ok: false, status: 400, error: "hive_brain_run_id_required", message: "A Board Manager run id is required." };
  }
  if (!(await tableExists("board_manager_runs"))) {
    return { ok: false, status: 404, error: "hive_brain_runs_unavailable", message: "Board Manager run storage is not available." };
  }
  const sourceSelect = includeSourcePacket ? "source_packet_json" : "'{}'::jsonb AS source_packet_json";
  const result = await query(
    `
      SELECT id, scope, manager_id, trigger, status, source_packet_digest,
             ${sourceSelect}, selected_action, action_payload_json, decision_json,
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
  const secretaryResult = includeSourcePacket
    ? await query(
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
      ).catch(() => ({ rows: [] }))
    : { rows: [] };
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
      sourcePacketOmitted: !includeSourcePacket && compact.sourcePacketBytes > 0,
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
