import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";

export const taskAccountingHarvestPromptVersion = "task_accounting_harvester_v1";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function intValue(value, fallback = 0, { min = 0, max = 10000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function rowToHarvest(row = {}) {
  const sourcePacket = safeObject(row.source_packet_json);
  const taskPacket = safeObject(sourcePacket.task);
  const badgeIds = safeArray(row.verified_badges_json).map((badge) => safeText(badge.badgeId || badge.badge_id || badge.label, 80)).filter(Boolean);
  const requiredBadgeId = safeText(
    row.required_badge_id ||
      taskPacket.requiredBadgeId ||
      sourcePacket.requiredBadgeId ||
      inferredBadgeForWork({
        title: row.title,
        taskProposal: row.task_proposal,
        submissionRequirement: row.submission_requirement_text,
        actionCategory: row.action_category,
      }),
    80
  );
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    accountId: safeText(row.account_id, 180),
    walletAddress: safeText(row.subject_wallet, 120),
    contributor: {
      accountId: safeText(row.account_id, 180),
      walletAddress: safeText(row.subject_wallet, 120),
      displayName: safeText(row.contributor_display_name, 160),
      publicHandle: safeText(row.contributor_public_handle, 120),
      verifiedBadges: safeArray(row.verified_badges_json),
    },
    badgeContext: {
      verifiedBadgeIds: badgeIds,
      requiredBadgeId,
      operatingBadgeId: safeText(row.operating_badge_id || taskPacket.operatingBadgeId || requiredBadgeId, 80),
      taskWorkType: safeText(row.task_work_type || taskPacket.taskWorkType, 120),
      badgeWorkType: safeText(row.badge_work_type || taskPacket.badgeWorkType || row.task_work_type || taskPacket.taskWorkType, 120),
      rewardCapPft: numeric(row.badge_reward_cap_pft || taskPacket.badgeRewardCapPft),
      requiredBadgeSource: safeText(row.required_badge_id || taskPacket.requiredBadgeId, 80) ? "task_packet" : "inferred",
    },
    projectIds: safeArray(row.project_ids_json),
    title: safeText(row.title, 360),
    taskProposal: safeText(row.task_proposal, 5000),
    submissionRequirement: safeText(row.submission_requirement_text, 2000),
    rewardOfferPft: numeric(row.reward_offer_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    rewardedAt: iso(row.rewarded_at),
    rewardEventTxHash: safeText(row.reward_event_tx_hash, 180),
    rewardEventCid: safeText(row.reward_event_cid, 240),
    status: safeText(row.status, 40),
    classification: safeText(row.classification, 80),
    requiresAction: Boolean(row.requires_action),
    actionCategory: safeText(row.action_category, 120),
    suggestedAction: safeText(row.suggested_action, 4000),
    assessmentSummary: safeText(row.assessment_summary, 4000),
    confidence: numeric(row.confidence),
    sourcePacket,
    result: safeObject(row.result_json),
    provider: safeText(row.provider, 80),
    model: safeText(row.model, 180),
    promptVersion: safeText(row.prompt_version, 120),
    promptDigest: safeText(row.prompt_digest, 120),
    responseId: safeText(row.response_id, 200),
    usage: safeObject(row.usage_json),
    workerId: safeText(row.worker_id, 180),
    workerAttemptId: safeText(row.worker_attempt_id, 180),
    workerAttemptCount: Number(row.worker_attempt_count || 0),
    workerClaimedAt: iso(row.worker_claimed_at),
    workerHeartbeatAt: iso(row.worker_heartbeat_at),
    completedAt: iso(row.completed_at),
    resolvedAt: iso(row.resolved_at),
    resolvedByAccountId: safeText(row.resolved_by_account_id, 180),
    resolutionNote: safeText(row.resolution_note, 1000),
    resolved: Boolean(row.resolved_at),
    lastError: safeText(row.last_error, 1000),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function inferredBadgeForWork({ title = "", taskProposal = "", submissionRequirement = "", actionCategory = "" } = {}) {
  const text = [title, taskProposal, submissionRequirement, actionCategory].join("\n").toLowerCase();
  if (/\b(pr|pull request|code|script|cli|api|migration|regression|test suite|docker|patch|repository|github|json payload|exporter)\b/.test(text)) {
    return "core_contributor";
  }
  if (/\b(qa|ux|ui|bug|repro|screenshot|friction|workflow|login|evidence submission|task acceptance|visibility gap)\b/.test(text)) {
    return "qa_worker";
  }
  if (/\b(tweet|x post|kol|article|medium|amplification|youtube|tiktok|instagram|community announcement)\b/.test(text)) {
    return "kol";
  }
  if (/\b(expert|domain|market alpha|research|analysis|validator|risk assessment)\b/.test(text)) {
    return "expert";
  }
  if (/\b(project leader|project proposal|new project|work breakdown|roadmap|project plan)\b/.test(text)) {
    return "project_leader";
  }
  return "";
}

export function taskAccountingHarvestSourcePacket(row = {}) {
  return {
    schema: "pf.task_node.task_accounting_harvest_source.v1",
    prompt: "The following task proposal and reward were granted.",
    task: {
      taskId: safeText(row.task_id || row.taskId, 180),
      requestId: safeText(row.request_id || row.requestId, 180),
      accountId: safeText(row.account_id || row.accountId, 180),
      walletAddress: safeText(row.subject_wallet || row.walletAddress, 120),
      projectIds: safeArray(row.project_ids_json || row.projectIds),
      title: safeText(row.title, 360),
      proposal: safeText(row.task_proposal || row.taskProposal || row.description, 6000),
      submissionRequirement: safeText(row.submission_requirement_text || row.submissionRequirement, 2400),
    },
    reward: {
      offerPft: numeric(row.reward_offer_pft || row.rewardOfferPft),
      actualPft: numeric(row.reward_actual_pft || row.rewardActualPft),
      rewardedAt: iso(row.rewarded_at || row.rewardedAt),
      eventTxHash: safeText(row.reward_event_tx_hash || row.rewardEventTxHash, 180),
      eventCid: safeText(row.reward_event_cid || row.rewardEventCid, 240),
    },
    badgeContext: {
      taskWorkType: safeText(row.task_work_type || row.taskWorkType, 120),
      requiredBadgeId: safeText(row.required_badge_id || row.requiredBadgeId, 80),
      operatingBadgeId: safeText(row.operating_badge_id || row.operatingBadgeId, 80),
      badgeWorkType: safeText(row.badge_work_type || row.badgeWorkType, 120),
      badgeRewardCapPft: numeric(row.badge_reward_cap_pft || row.badgeRewardCapPft),
    },
    taskEvents: safeArray(row.event_context_json || row.taskEvents),
  };
}

export async function enqueueRewardedNetworkTaskHarvests({ limit = 1000 } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured", upserted: 0 };
  const safeLimit = intValue(limit, 1000, { min: 1, max: 5000 });
  const result = await query(
    `
      WITH candidates AS (
        SELECT
          projection.task_id,
          projection.request_id,
          projection.account_id,
          projection.subject_wallet,
          projection.title,
          projection.description AS task_proposal,
          projection.submission_requirement_text,
          projection.reward_offer_pft,
          projection.reward_actual_pft,
          COALESCE(
            projection.metadata_json #>> '{networkTask,task_work_type}',
            projection.metadata_json #>> '{network_task,task_work_type}',
            projection.metadata_json #>> '{generatedTask,network_task,task_work_type}',
            projection.metadata_json #>> '{task_work_type}',
            ''
          ) AS task_work_type,
          COALESCE(
            projection.metadata_json #>> '{networkTask,required_badge_id}',
            projection.metadata_json #>> '{network_task,required_badge_id}',
            projection.metadata_json #>> '{generatedTask,network_task,required_badge_id}',
            projection.metadata_json #>> '{required_badge_id}',
            ''
          ) AS required_badge_id,
          COALESCE(
            projection.metadata_json #>> '{networkTask,operating_badge_id}',
            projection.metadata_json #>> '{network_task,operating_badge_id}',
            projection.metadata_json #>> '{generatedTask,network_task,operating_badge_id}',
            projection.metadata_json #>> '{operating_badge_id}',
            ''
          ) AS operating_badge_id,
          COALESCE(
            projection.metadata_json #>> '{networkTask,badge_work_type}',
            projection.metadata_json #>> '{network_task,badge_work_type}',
            projection.metadata_json #>> '{generatedTask,network_task,badge_work_type}',
            projection.metadata_json #>> '{badge_work_type}',
            ''
          ) AS badge_work_type,
          COALESCE(
            projection.metadata_json #>> '{networkTask,badge_reward_cap_pft}',
            projection.metadata_json #>> '{network_task,badge_reward_cap_pft}',
            projection.metadata_json #>> '{generatedTask,network_task,badge_reward_cap_pft}',
            projection.metadata_json #>> '{badge_reward_cap_pft}',
            ''
          ) AS badge_reward_cap_pft,
          COALESCE(reward_event.occurred_at, projection.last_event_at, projection.updated_at) AS rewarded_at,
          COALESCE(NULLIF(reward_event.source_tx_hash, ''), projection.last_event_tx_hash) AS reward_event_tx_hash,
          COALESCE(NULLIF(reward_event.source_cid, ''), projection.last_event_cid) AS reward_event_cid,
          COALESCE(project_refs.project_ids_json, '[]'::jsonb) AS project_ids_json,
          COALESCE(event_context.event_context_json, '[]'::jsonb) AS event_context_json
        FROM task_projections projection
        LEFT JOIN LATERAL (
          SELECT
            jsonb_agg(DISTINCT ref.project_id ORDER BY ref.project_id) FILTER (WHERE ref.project_id <> '') AS project_ids_json
          FROM network_project_task_refs ref
          WHERE ref.task_id = projection.task_id
        ) project_refs ON true
        LEFT JOIN LATERAL (
          SELECT event.source_tx_hash, event.source_cid, event.occurred_at
          FROM task_events event
          WHERE event.task_id = projection.task_id
            AND event.event_type = 'pf.reward.v1'
          ORDER BY event.occurred_at DESC, event.created_at DESC, event.id DESC
          LIMIT 1
        ) reward_event ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(event_payload ORDER BY occurred_at, id) AS event_context_json
          FROM (
            SELECT
              event.occurred_at,
              event.id,
              jsonb_strip_nulls(jsonb_build_object(
                'eventType', event.event_type,
                'occurredAt', event.occurred_at,
                'sourceCid', NULLIF(event.source_cid, ''),
                'sourceTxHash', NULLIF(event.source_tx_hash, ''),
                'phase', NULLIF(event.payload_json->>'phase', ''),
                'transition', NULLIF(event.payload_json->>'transition', ''),
                'artifactType', NULLIF(COALESCE(
                  event.payload_json #>> '{evidence,artifact_type}',
                  event.payload_json #>> '{response,artifact_type}',
                  event.payload_json->>'artifact_type'
                ), ''),
                'evidenceText', NULLIF(LEFT(COALESCE(
                  event.payload_json #>> '{evidence,value}',
                  event.payload_json #>> '{response,value}',
                  event.payload_json->>'response_text',
                  ''
                ), 16000), ''),
                'evidenceNotes', NULLIF(LEFT(COALESCE(
                  event.payload_json #>> '{evidence,notes}',
                  event.payload_json #>> '{response,notes}',
                  ''
                ), 3000), ''),
                'verificationAsk', NULLIF(LEFT(COALESCE(
                  event.payload_json #>> '{verification_request,verification_ask}',
                  event.payload_json->>'verification_ask',
                  ''
                ), 3000), ''),
                'verificationReason', NULLIF(LEFT(COALESCE(
                  event.payload_json #>> '{verification_request,reason}',
                  ''
                ), 2000), ''),
                'rewardReason', NULLIF(LEFT(COALESCE(
                  event.payload_json #>> '{reward_score,reason}',
                  ''
                ), 5000), ''),
                'rewardFeedback', NULLIF(LEFT(COALESCE(
                  event.payload_json #>> '{reward_score,user_feedback}',
                  ''
                ), 3000), ''),
                'rewardDecision', NULLIF(event.payload_json #>> '{reward_score,decision}', ''),
                'rewardCompletion', NULLIF(event.payload_json #>> '{reward_score,completion}', ''),
                'rewardEvidenceQuality', NULLIF(event.payload_json #>> '{reward_score,evidence_quality}', '')
              )) AS event_payload
            FROM task_events event
            WHERE event.task_id = projection.task_id
              AND event.event_type IN (
                'pf.task.submission.v1',
                'pf.task.verification_response.v1',
                'pf.task.update.v1',
                'pf.reward.v1'
              )
            ORDER BY event.occurred_at ASC, event.created_at ASC, event.id ASC
            LIMIT 16
          ) bounded_events
        ) event_context ON true
        LEFT JOIN task_accounting_harvests existing
          ON existing.task_id = projection.task_id
        WHERE lower(projection.task_kind) = 'network'
          AND lower(projection.status) IN ('rewarded', 'paid')
          AND projection.task_id <> ''
          AND (
            existing.task_id IS NULL
            OR existing.reward_event_tx_hash IS DISTINCT FROM COALESCE(NULLIF(reward_event.source_tx_hash, ''), projection.last_event_tx_hash)
            OR existing.reward_event_cid IS DISTINCT FROM COALESCE(NULLIF(reward_event.source_cid, ''), projection.last_event_cid)
            OR existing.reward_actual_pft IS DISTINCT FROM projection.reward_actual_pft
            OR existing.reward_offer_pft IS DISTINCT FROM projection.reward_offer_pft
            OR NOT (existing.source_packet_json ? 'taskEvents')
          )
        ORDER BY COALESCE(reward_event.occurred_at, projection.last_event_at, projection.updated_at) ASC,
                 projection.task_id ASC
        LIMIT $1
      ),
      upserted AS (
        INSERT INTO task_accounting_harvests (
          task_id,
          request_id,
          account_id,
          subject_wallet,
          project_ids_json,
          title,
          task_proposal,
          submission_requirement_text,
          reward_offer_pft,
          reward_actual_pft,
          rewarded_at,
          reward_event_tx_hash,
          reward_event_cid,
          status,
          classification,
          requires_action,
          action_category,
          suggested_action,
          assessment_summary,
          confidence,
          source_packet_json,
          result_json,
          provider,
          model,
          prompt_version,
          prompt_digest,
          response_id,
          usage_json,
          last_error,
          updated_at
        )
        SELECT
          task_id,
          COALESCE(request_id, ''),
          COALESCE(account_id, ''),
          COALESCE(subject_wallet, ''),
          COALESCE(project_ids_json, '[]'::jsonb),
          COALESCE(title, ''),
          COALESCE(task_proposal, ''),
          COALESCE(submission_requirement_text, ''),
          COALESCE(reward_offer_pft, 0),
          COALESCE(reward_actual_pft, 0),
          rewarded_at,
          COALESCE(reward_event_tx_hash, ''),
          COALESCE(reward_event_cid, ''),
          'queued',
          'not_harvested',
          false,
          '',
          '',
          '',
          0,
          jsonb_build_object(
            'schema', 'pf.task_node.task_accounting_harvest_source.v1',
            'prompt', 'The following task proposal and reward were granted.',
            'task', jsonb_build_object(
              'taskId', task_id,
              'requestId', COALESCE(request_id, ''),
              'accountId', COALESCE(account_id, ''),
              'walletAddress', COALESCE(subject_wallet, ''),
              'projectIds', COALESCE(project_ids_json, '[]'::jsonb),
              'title', COALESCE(title, ''),
              'proposal', COALESCE(task_proposal, ''),
              'submissionRequirement', COALESCE(submission_requirement_text, '')
            ),
            'reward', jsonb_build_object(
              'offerPft', COALESCE(reward_offer_pft, 0),
              'actualPft', COALESCE(reward_actual_pft, 0),
              'rewardedAt', rewarded_at,
              'eventTxHash', COALESCE(reward_event_tx_hash, ''),
              'eventCid', COALESCE(reward_event_cid, '')
            ),
            'badgeContext', jsonb_build_object(
              'taskWorkType', COALESCE(task_work_type, ''),
              'requiredBadgeId', COALESCE(required_badge_id, ''),
              'operatingBadgeId', COALESCE(operating_badge_id, ''),
              'badgeWorkType', COALESCE(badge_work_type, ''),
              'badgeRewardCapPft', COALESCE(NULLIF(badge_reward_cap_pft, '')::numeric, 0)
            ),
            'taskEvents', COALESCE(event_context_json, '[]'::jsonb)
          ),
          '{}'::jsonb,
          '',
          '',
          '',
          '',
          '',
          '{}'::jsonb,
          '',
          now()
        FROM candidates
        ON CONFLICT (task_id) DO UPDATE SET
          request_id = EXCLUDED.request_id,
          account_id = EXCLUDED.account_id,
          subject_wallet = EXCLUDED.subject_wallet,
          project_ids_json = EXCLUDED.project_ids_json,
          title = EXCLUDED.title,
          task_proposal = EXCLUDED.task_proposal,
          submission_requirement_text = EXCLUDED.submission_requirement_text,
          reward_offer_pft = EXCLUDED.reward_offer_pft,
          reward_actual_pft = EXCLUDED.reward_actual_pft,
          rewarded_at = EXCLUDED.rewarded_at,
          reward_event_tx_hash = EXCLUDED.reward_event_tx_hash,
          reward_event_cid = EXCLUDED.reward_event_cid,
          status = 'queued',
          classification = 'not_harvested',
          requires_action = false,
          action_category = '',
          suggested_action = '',
          assessment_summary = '',
          confidence = 0,
          source_packet_json = EXCLUDED.source_packet_json,
          result_json = '{}'::jsonb,
          provider = '',
          model = '',
          prompt_version = '',
          prompt_digest = '',
          response_id = '',
          usage_json = '{}'::jsonb,
          worker_id = '',
          worker_attempt_id = '',
          worker_attempt_count = 0,
          worker_claimed_at = NULL,
          worker_heartbeat_at = NULL,
          completed_at = NULL,
          last_error = '',
          updated_at = now()
        RETURNING task_id
      )
      SELECT count(*)::int AS upserted
      FROM upserted
    `,
    [safeLimit]
  );
  return {
    ok: true,
    upserted: Number(result.rows[0]?.upserted || 0),
  };
}

export async function claimTaskAccountingHarvests({
  limit = 3,
  workerId = "",
  maxAttempts = 3,
  staleSeconds = 900,
} = {}) {
  if (!databaseEnabled()) return [];
  const safeLimit = intValue(limit, 3, { min: 1, max: 250 });
  const safeMaxAttempts = intValue(maxAttempts, 3, { min: 1, max: 20 });
  const safeStaleSeconds = intValue(staleSeconds, 900, { min: 60, max: 86_400 });
  const normalizedWorkerId = safeText(workerId, 180) || `task_accounting_harvester_${process.pid || "unknown"}`;
  const attemptId = `tah_attempt_${randomUUID().replaceAll("-", "")}`;
  const result = await query(
    `
      WITH next_rows AS (
        SELECT task_id
        FROM task_accounting_harvests
        WHERE worker_attempt_count < $2
          AND (
            status = 'queued'
            OR (
              status = 'harvesting'
              AND COALESCE(worker_heartbeat_at, worker_claimed_at, updated_at) < now() - ($3::text || ' seconds')::interval
            )
            OR (
              status = 'failed'
              AND updated_at < now() - '5 minutes'::interval
            )
          )
        ORDER BY
          CASE status WHEN 'queued' THEN 0 WHEN 'harvesting' THEN 1 ELSE 2 END,
          rewarded_at ASC NULLS LAST,
          updated_at ASC,
          task_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE task_accounting_harvests harvest
      SET status = 'harvesting',
          worker_id = $4,
          worker_attempt_id = $5,
          worker_attempt_count = worker_attempt_count + 1,
          worker_claimed_at = now(),
          worker_heartbeat_at = now(),
          completed_at = NULL,
          last_error = '',
          updated_at = now()
      FROM next_rows
      WHERE harvest.task_id = next_rows.task_id
      RETURNING harvest.*
    `,
    [safeLimit, safeMaxAttempts, safeStaleSeconds, normalizedWorkerId, attemptId]
  );
  return result.rows.map(rowToHarvest);
}

export async function heartbeatTaskAccountingHarvest({
  taskId = "",
  workerAttemptId = "",
  workerId = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE task_accounting_harvests
      SET worker_heartbeat_at = now(),
          updated_at = now()
      WHERE task_id = $1
        AND status = 'harvesting'
        AND worker_attempt_id = $2
        AND ($3::text = '' OR worker_id = $3)
      RETURNING *
    `,
    [safeText(taskId, 180), safeText(workerAttemptId, 180), safeText(workerId, 180)]
  );
  return result.rows[0]
    ? { ok: true, harvest: rowToHarvest(result.rows[0]) }
    : { ok: false, stale: true, reason: "task_accounting_harvest_not_owned" };
}

export async function completeTaskAccountingHarvest({
  taskId = "",
  workerAttemptId = "",
  workerId = "",
  classification = "",
  requiresAction = false,
  actionCategory = "",
  suggestedAction = "",
  assessmentSummary = "",
  confidence = 0,
  result = {},
  provider = "",
  model = "",
  promptVersion = taskAccountingHarvestPromptVersion,
  promptDigest = "",
  responseId = "",
  usage = {},
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedClassification = requiresAction ? "requires_action" : "no_action";
  const resultRow = await query(
    `
      UPDATE task_accounting_harvests
      SET status = 'harvested',
          classification = $4,
          requires_action = $5,
          action_category = $6,
          suggested_action = $7,
          assessment_summary = $8,
          confidence = $9,
          result_json = $10::jsonb,
          provider = $11,
          model = $12,
          prompt_version = $13,
          prompt_digest = $14,
          response_id = $15,
          usage_json = $16::jsonb,
          worker_heartbeat_at = now(),
          completed_at = now(),
          last_error = '',
          updated_at = now()
      WHERE task_id = $1
        AND status = 'harvesting'
        AND worker_attempt_id = $2
        AND ($3::text = '' OR worker_id = $3)
      RETURNING *
    `,
    [
      safeText(taskId, 180),
      safeText(workerAttemptId, 180),
      safeText(workerId, 180),
      ["requires_action", "no_action"].includes(classification) ? classification : normalizedClassification,
      Boolean(requiresAction),
      safeText(actionCategory, 120),
      safeText(suggestedAction, 4000),
      safeText(assessmentSummary, 4000),
      Math.min(Math.max(numeric(confidence), 0), 1),
      jsonValue(result),
      safeText(provider, 80),
      safeText(model, 180),
      safeText(promptVersion, 120),
      safeText(promptDigest, 120),
      safeText(responseId, 200),
      jsonValue(usage),
    ]
  );
  return resultRow.rows[0]
    ? { ok: true, harvest: rowToHarvest(resultRow.rows[0]) }
    : { ok: false, stale: true, reason: "task_accounting_harvest_not_owned" };
}

export async function failTaskAccountingHarvest({
  taskId = "",
  workerAttemptId = "",
  workerId = "",
  error = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE task_accounting_harvests
      SET status = 'failed',
          classification = 'unknown',
          worker_heartbeat_at = now(),
          completed_at = now(),
          last_error = $4,
          updated_at = now()
      WHERE task_id = $1
        AND status = 'harvesting'
        AND worker_attempt_id = $2
        AND ($3::text = '' OR worker_id = $3)
      RETURNING *
    `,
    [
      safeText(taskId, 180),
      safeText(workerAttemptId, 180),
      safeText(workerId, 180),
      safeText(error, 1000),
    ]
  );
  return result.rows[0]
    ? { ok: true, harvest: rowToHarvest(result.rows[0]) }
    : { ok: false, stale: true, reason: "task_accounting_harvest_not_owned" };
}

export async function listTaskAccountingHarvests({
  status = "",
  classification = "",
  requiresAction = "",
  includeResolved = false,
  limit = 40,
  page = 1,
} = {}) {
  if (!databaseEnabled()) {
    return {
      ok: true,
      harvests: [],
      summary: {
        total: 0,
        queued: 0,
        harvesting: 0,
        harvested: 0,
        failed: 0,
        requiresAction: 0,
        noAction: 0,
      },
      page: 1,
      pageSize: 0,
      hasMore: false,
    };
  }
  const filters = [];
  const params = [];
  const normalizedStatus = safeText(status, 40);
  if (normalizedStatus) {
    params.push(normalizedStatus);
    filters.push(`status = $${params.length}`);
  }
  const normalizedClassification = safeText(classification, 80);
  if (normalizedClassification) {
    params.push(normalizedClassification);
    filters.push(`classification = $${params.length}`);
  }
  const actionFilter = safeText(requiresAction, 20).toLowerCase();
  if (["true", "false"].includes(actionFilter)) {
    params.push(actionFilter === "true");
    filters.push(`requires_action = $${params.length}`);
  }
  if (includeResolved !== true) {
    filters.push("resolved_at IS NULL");
  }
  const safeLimit = intValue(limit, 40, { min: 1, max: 100 });
  const safePage = intValue(page, 1, { min: 1, max: 1000 });
  params.push(safeLimit + 1, (safePage - 1) * safeLimit);
  const result = await query(
    `
      SELECT
        harvest.*,
        COALESCE(identity.public_handle, '') AS contributor_public_handle,
        COALESCE(hive.display_name, identity.public_handle, '') AS contributor_display_name,
        COALESCE(badges.verified_badges_json, '[]'::jsonb) AS verified_badges_json,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,taskWorkType}',
          harvest.source_packet_json #>> '{task,taskWorkType}',
          ''
        ) AS task_work_type,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,requiredBadgeId}',
          harvest.source_packet_json #>> '{task,requiredBadgeId}',
          ''
        ) AS required_badge_id,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,operatingBadgeId}',
          harvest.source_packet_json #>> '{task,operatingBadgeId}',
          ''
        ) AS operating_badge_id,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,badgeWorkType}',
          harvest.source_packet_json #>> '{task,badgeWorkType}',
          ''
        ) AS badge_work_type,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,badgeRewardCapPft}',
          harvest.source_packet_json #>> '{task,badgeRewardCapPft}',
          ''
        ) AS badge_reward_cap_pft
      FROM task_accounting_harvests harvest
      LEFT JOIN LATERAL (
        SELECT display_name
        FROM hive_context_entries entry
        WHERE entry.account_id = harvest.account_id
          AND entry.deleted_at IS NULL
          AND entry.display_name <> ''
        ORDER BY entry.created_at DESC, entry.id DESC
        LIMIT 1
      ) hive ON true
      LEFT JOIN LATERAL (
        SELECT public_handle
        FROM account_identity_approvals approval
        WHERE approval.account_id = harvest.account_id
          AND approval.status = 'active'
          AND approval.public_handle <> ''
          AND approval.revoked_at IS NULL
        ORDER BY approval.updated_at DESC, approval.id DESC
        LIMIT 1
      ) identity ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'badgeId', badge.badge_id,
          'label', definition.label,
          'selectedDefault', badge.selected_default
        ) ORDER BY badge.selected_default DESC, badge.updated_at DESC, badge.badge_id ASC) AS verified_badges_json
        FROM account_network_badges badge
        JOIN network_badge_definitions definition
          ON definition.badge_id = badge.badge_id
        WHERE badge.account_id = harvest.account_id
          AND badge.status = 'verified'
          AND badge.revoked_at IS NULL
          AND definition.active = true
          AND (badge.expires_at IS NULL OR badge.expires_at > now())
      ) badges ON true
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY
        harvest.requires_action DESC,
        harvest.completed_at DESC NULLS LAST,
        harvest.rewarded_at DESC NULLS LAST,
        harvest.updated_at DESC,
        harvest.task_id DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `,
    params
  );
  const summaryResult = await query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'queued')::int AS queued,
      count(*) FILTER (WHERE status = 'harvesting')::int AS harvesting,
      count(*) FILTER (WHERE status = 'harvested')::int AS harvested,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE classification = 'requires_action')::int AS requires_action,
      count(*) FILTER (WHERE classification = 'no_action')::int AS no_action,
      count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved
    FROM task_accounting_harvests
  `);
  const summary = summaryResult.rows[0] || {};
  return {
    ok: true,
    harvests: result.rows.slice(0, safeLimit).map(rowToHarvest),
    summary: {
      total: Number(summary.total || 0),
      queued: Number(summary.queued || 0),
      harvesting: Number(summary.harvesting || 0),
      harvested: Number(summary.harvested || 0),
      failed: Number(summary.failed || 0),
      requiresAction: Number(summary.requires_action || 0),
      noAction: Number(summary.no_action || 0),
      resolved: Number(summary.resolved || 0),
    },
    page: safePage,
    pageSize: safeLimit,
    hasMore: result.rows.length > safeLimit,
  };
}

export async function resolveTaskAccountingHarvest({
  taskId = "",
  resolvedByAccountId = "",
  note = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE task_accounting_harvests
      SET resolved_at = now(),
          resolved_by_account_id = $2,
          resolution_note = $3,
          updated_at = now()
      WHERE task_id = $1
      RETURNING *
    `,
    [safeText(taskId, 180), safeText(resolvedByAccountId, 180), safeText(note, 1000)]
  );
  return result.rows[0]
    ? { ok: true, harvest: rowToHarvest(result.rows[0]) }
    : { ok: false, status: 404, error: "task_accounting_harvest_not_found" };
}
