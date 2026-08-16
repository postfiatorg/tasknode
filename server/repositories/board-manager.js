import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  buildBoardManagerRunMicroSummary,
  formatBoardManagerAgentJob,
  formatBoardManagerAgentRun,
} from "./board-manager-run-summary.js";
import { activeBoardManagerJobs } from "./board-manager-agent-jobs.js";
import {
  actionSet,
  emptyBoardManagerPayload,
  iso,
  jsonValue,
  normalizeDecisionBasis,
  normalizePayload,
  safeObject,
  safeText,
} from "./board-manager-contract.js";
import {
  recentBoardManagerRuns,
} from "./board-manager-source-data.js";

export { formatBoardManagerAgentJob, formatBoardManagerAgentRun } from "./board-manager-run-summary.js";
export {
  boardManagerActions,
  boardManagerInternalActions,
  boardManagerPromptVersion,
} from "./board-manager-contract.js";
export {
  boardManagerTaskWorkTypeVocabulary,
  buildBoardManagerCapabilityInstrumentation,
  buildHiveGenerationQualityPolicy,
  compactNetworkTaskOutputCorpusForBoardManager,
  ensureRecentEvidenceEvaluationPackets,
  extractOperatorStandingPolicy,
  getNetworkTaskOutputCorpus,
} from "./board-manager-source-data.js";
export {
  buildBoardManagerSourcePacket,
  isBoardManagerSourceReadTimeout,
  runBoardManagerSourceReads,
} from "./board-manager-source-packet.js";

function useDatabase() {
  return databaseEnabled();
}

export async function getBoardManagerAgentFeed({ limit = 20, includeInternal = false, includeDetails = false } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 30);
  const [jobs, runs] = await Promise.all([
    activeBoardManagerJobs({ limit: Math.min(normalizedLimit, 10), includeInternal, includeDetails }),
    recentBoardManagerRuns({ limit: normalizedLimit, includeInternal, includeDetails }),
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
    decision_basis: normalizeDecisionBasis(decision, decision.reason),
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
  provider = "",
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
        provider, codex_session_id, codex_session_path, session_mode
      )
      VALUES ($1, $2, $3, $4, 'running', $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
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
      safeText(provider, 80),
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
  usage = {},
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
          usage_json = $7::jsonb,
          error = $8,
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
      jsonValue(usage),
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

export async function updateBoardManagerRunOutput({
  runId = "",
  outputText = "",
} = {}) {
  if (!useDatabase()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE board_manager_runs
      SET output_text = $2,
          updated_at = now()
      WHERE id = $1
        AND status = 'running'
      RETURNING id, octet_length(COALESCE(output_text, '')) AS output_bytes
    `,
    [
      safeText(runId, 180),
      safeText(outputText, 1000000),
    ]
  );
  return {
    ok: true,
    updated: result.rowCount || 0,
    outputBytes: Number(result.rows[0]?.output_bytes || 0),
  };
}
