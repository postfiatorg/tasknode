import { createHash } from "node:crypto";

import { databaseEnabled, query } from "../db/pool.js";
import { expertAccessFromTaskState } from "../expert-badge.js";
import { getAccountIdentityProfile } from "./account-profiles.js";
import { hasUsageCreditForSource } from "./chat-billing.js";
import { approveNetworkBadge, manualBadgeApprovalRecords } from "./identity-approvals.js";
import { listTaskState } from "./tasks.js";
import {
  resolveGithubCollaboratorPermission,
  resolveXUserMetrics,
} from "./identity-provider-resolvers.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function useDatabase() {
  return databaseEnabled();
}

function ensureDatabase() {
  if (useDatabase()) return;
  const error = new Error("network_badge_verifier_jobs_database_not_configured");
  error.status = 503;
  throw error;
}

const activeVerifierTypes = new Set([
  "x_user_metrics",
  "github_collaborator_permission",
  "qa_worker_access",
  "expert_access",
]);

const activeVerifierBadgeIds = new Set([
  "kol",
  "core_contributor",
  "qa_worker",
  "expert",
]);

export function normalizeVerifierType(value = "") {
  const normalized = safeText(value, 120)
    .toLowerCase()
    .replace(/[-:]+/g, "_")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (["resolve_x", "resolve_x_user", "x", "x_user"].includes(normalized)) return "x_user_metrics";
  if (["resolve_github_collab", "github_collab", "github_permission"].includes(normalized)) return "github_collaborator_permission";
  if (["qa_worker", "qa_worker_access", "resolve_qa_worker", "qa_access"].includes(normalized)) return "qa_worker_access";
  if (["expert", "expert_access", "resolve_expert", "expert_badge"].includes(normalized)) return "expert_access";
  return normalized;
}

function providerForVerifierType(verifierType = "") {
  if (verifierType === "x_user_metrics") return "x";
  if (verifierType.startsWith("github_")) return "github";
  if (verifierType === "qa_worker_access") return "tasknode";
  if (verifierType === "expert_access") return "tasknode";
  return "tasknode";
}

function badgeForVerifierType(verifierType = "", explicitBadgeId = "") {
  const badgeId = safeText(explicitBadgeId, 80);
  if (badgeId) return badgeId;
  if (verifierType === "x_user_metrics") return "kol";
  if (verifierType === "github_collaborator_permission") return "core_contributor";
  if (verifierType === "qa_worker_access") return "qa_worker";
  if (verifierType === "expert_access") return "expert";
  return "";
}

function scrubVerifierInput(input = {}) {
  const safe = safeObject(input);
  const scrubbed = { ...safe };
  delete scrubbed.token;
  delete scrubbed.providerToken;
  delete scrubbed.provider_token;
  delete scrubbed.bearerToken;
  delete scrubbed.bearer_token;
  return scrubbed;
}

export function networkBadgeVerifierJobRecord({
  accountId = "",
  badgeId = "",
  provider = "",
  verifierType = "",
  input = {},
  requestedByAccountId = "",
  requestedByOperator = "",
  maxAttempts = 3,
  runAfter = "",
} = {}) {
  const normalizedVerifierType = normalizeVerifierType(verifierType);
  const normalizedBadgeId = badgeForVerifierType(normalizedVerifierType, badgeId);
  const normalizedProvider = safeText(provider || providerForVerifierType(normalizedVerifierType), 80);
  const normalizedAccountId = safeText(accountId, 180);
  const safeInput = scrubVerifierInput(input);
  if (!normalizedVerifierType || !normalizedBadgeId) {
    const error = new Error("network_badge_verifier_job_invalid");
    error.status = 400;
    throw error;
  }
  if (!activeVerifierTypes.has(normalizedVerifierType) || !activeVerifierBadgeIds.has(normalizedBadgeId)) {
    const error = new Error("network_badge_verifier_type_not_active");
    error.status = 400;
    throw error;
  }
  const idempotencyKey = `network_badge_verifier:${digest({
    accountId: normalizedAccountId,
    badgeId: normalizedBadgeId,
    provider: normalizedProvider,
    verifierType: normalizedVerifierType,
    input: safeInput,
  })}`;
  const parsedRunAfter = Date.parse(runAfter || "");
  return {
    id: `nbvj_${digest(idempotencyKey).slice(0, 32)}`,
    idempotencyKey,
    accountId: normalizedAccountId,
    badgeId: normalizedBadgeId,
    provider: normalizedProvider,
    verifierType: normalizedVerifierType,
    status: "queued",
    inputJson: safeInput,
    resultJson: {},
    lastError: "",
    attemptCount: 0,
    maxAttempts: Math.min(Math.max(Math.round(Number(maxAttempts) || 3), 1), 10),
    requestedByAccountId: safeText(requestedByAccountId, 180),
    requestedByOperator: safeText(requestedByOperator || "network_badge_verifier", 180),
    runAfter: Number.isNaN(parsedRunAfter) ? new Date().toISOString() : new Date(parsedRunAfter).toISOString(),
  };
}

function rowToJob(row = {}) {
  return {
    id: safeText(row.id, 180),
    idempotencyKey: safeText(row.idempotency_key, 240),
    accountId: safeText(row.account_id, 180),
    badgeId: safeText(row.badge_id, 80),
    provider: safeText(row.provider, 80),
    verifierType: safeText(row.verifier_type, 120),
    status: safeText(row.status, 80),
    inputJson: safeObject(row.input_json),
    resultJson: safeObject(row.result_json),
    lastError: safeText(row.last_error, 1000),
    attemptCount: Math.max(0, Math.round(Number(row.attempt_count || 0))),
    maxAttempts: Math.max(1, Math.round(Number(row.max_attempts || 3))),
    requestedByAccountId: safeText(row.requested_by_account_id, 180),
    requestedByOperator: safeText(row.requested_by_operator, 180),
    runAfter: row.run_after ? new Date(row.run_after).toISOString() : "",
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : "",
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : "",
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : "",
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : "",
  };
}

export async function enqueueNetworkBadgeVerifierJob(input = {}) {
  ensureDatabase();
  const record = networkBadgeVerifierJobRecord(input);
  const result = await query(
    `
      INSERT INTO network_badge_verifier_jobs (
        id,
        idempotency_key,
        account_id,
        badge_id,
        provider,
        verifier_type,
        status,
        input_json,
        result_json,
        max_attempts,
        requested_by_account_id,
        requested_by_operator,
        run_after,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb, '{}'::jsonb, $8, $9, $10, $11::timestamptz, now(), now())
      ON CONFLICT (idempotency_key) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        badge_id = EXCLUDED.badge_id,
        provider = EXCLUDED.provider,
        verifier_type = EXCLUDED.verifier_type,
        input_json = EXCLUDED.input_json,
        max_attempts = EXCLUDED.max_attempts,
        requested_by_account_id = EXCLUDED.requested_by_account_id,
        requested_by_operator = EXCLUDED.requested_by_operator,
        run_after = EXCLUDED.run_after,
        updated_at = now()
      RETURNING *
    `,
    [
      record.id,
      record.idempotencyKey,
      record.accountId,
      record.badgeId,
      record.provider,
      record.verifierType,
      JSON.stringify(record.inputJson),
      record.maxAttempts,
      record.requestedByAccountId,
      record.requestedByOperator,
      record.runAfter,
    ]
  );
  return {
    ok: true,
    job: rowToJob(result.rows[0]),
  };
}

export async function listNetworkBadgeVerifierJobs({
  accountId = "",
  badgeId = "",
  status = "",
  limit = 25,
} = {}) {
  if (!useDatabase()) return [];
  const params = [
    safeText(accountId, 180),
    safeText(badgeId, 80),
    safeText(status, 80),
    Math.min(Math.max(Number(limit) || 25, 1), 100),
  ];
  const result = await query(
    `
      SELECT *
      FROM network_badge_verifier_jobs
      WHERE ($1::text = '' OR account_id = $1)
        AND ($2::text = '' OR badge_id = $2)
        AND ($3::text = '' OR status = $3)
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT $4
    `,
    params
  );
  return result.rows.map(rowToJob);
}

async function resolveJob(job = {}, { fetchImpl = fetch } = {}) {
  const input = safeObject(job.inputJson || job.input_json);
  if (job.verifierType === "x_user_metrics") {
    return resolveXUserMetrics({
      username: input.username || input.handle,
      userId: input.userId || input.user_id,
      fetchImpl,
    });
  }
  if (job.verifierType === "github_collaborator_permission") {
    return resolveGithubCollaboratorPermission({
      owner: input.owner || "postfiatorg",
      repo: input.repo || input.repository,
      username: input.username || input.handle,
      fetchImpl,
    });
  }
  if (job.verifierType === "qa_worker_access") {
    const accountId = safeText(job.accountId || input.accountId || input.account_id, 180);
    const identityProfile = accountId ? await getAccountIdentityProfile({ accountId }) || {} : {};
    const aliases = Array.isArray(identityProfile.aliases) ? identityProfile.aliases : [];
    const aliasFor = (provider = "") => aliases.find((alias) => safeText(alias.provider, 80).toLowerCase() === provider);
    const telegram = aliasFor("telegram");
    const discord = aliasFor("discord");
    const telegramLinked = Boolean(telegram && telegram.verified !== false);
    const discordLinked = Boolean(discord && discord.verified !== false);
    const usdcTopUp = await hasUsageCreditForSource({
      accountId,
      source: "ethereum_deposit",
      metadata: { asset: "USDC" },
    }).catch(() => false);
    const result = {
      schema: "pf.task_node.qa_worker_access_verifier.v1",
      checkedAt: new Date().toISOString(),
      accountId,
      telegramLinked,
      discordLinked,
      usdcTopUp: Boolean(usdcTopUp),
      metrics: {
        linkedProviders: [
          ...(telegramLinked ? ["telegram"] : []),
          ...(discordLinked ? ["discord"] : []),
        ],
        proofMethod: "telegram_discord_usdc_top_up",
      },
      qualifications: {
        qaWorker: telegramLinked && discordLinked && Boolean(usdcTopUp),
      },
    };
    return {
      ...result,
      responseDigest: digest(result),
    };
  }
  if (job.verifierType === "expert_access") {
    const accountId = safeText(job.accountId || input.accountId || input.account_id, 180);
    const walletAddress = safeText(input.walletAddress || input.wallet_address, 180);
    const taskStateInput = safeObject(input.taskState || input.task_state);
    const taskState = Object.keys(taskStateInput).length
      ? taskStateInput
      : await listTaskState({ accountId, walletAddress });
    const expertAccess = await expertAccessFromTaskState({ accountId, taskState });
    const result = {
      schema: "pf.task_node.expert_access_verifier.v1",
      checkedAt: new Date().toISOString(),
      accountId,
      status: expertAccess.status,
      eligible: expertAccess.eligible === true,
      topic: expertAccess.topic,
      recommendedExpertLabel: expertAccess.recommendedExpertLabel,
      score: expertAccess.score,
      thresholdScore: expertAccess.thresholdScore,
      personalTaskCount: expertAccess.personalTaskCount,
      requiredPersonalTaskCount: expertAccess.requiredPersonalTaskCount,
      reviewedAt: expertAccess.reviewedAt,
      reviewCurrent: expertAccess.reviewCurrent === true,
      disqualifyingConcerns: Array.isArray(expertAccess.disqualifyingConcerns) ? expertAccess.disqualifyingConcerns : [],
      evidenceTaskIds: Array.isArray(expertAccess.reviewedTaskIds) ? expertAccess.reviewedTaskIds.slice(0, 20) : [],
      metrics: {
        proofMethod: expertAccess.proofMethod || "glm52_last_20_personal_tasks",
        model: expertAccess.model || "",
        responseId: expertAccess.responseId || "",
      },
      qualifications: {
        expert: expertAccess.eligible === true,
      },
    };
    return {
      ...result,
      responseDigest: digest(result),
    };
  }
  const error = new Error("network_badge_verifier_type_unsupported");
  error.status = 400;
  throw error;
}

export function approvalRecommendationFromVerifierResult({
  job = {},
  result = {},
  approvedByAccountId = "",
  approvedByOperator = "network_badge_verifier_job",
  selectedDefault = false,
} = {}) {
  const badgeId = safeText(job.badgeId || job.badge_id, 80);
  const verifierType = safeText(job.verifierType || job.verifier_type, 120);
  const baseEvidence = {
    source: "network_badge_verifier_job",
    verifierType,
    verifierJobId: safeText(job.id, 180),
    responseDigest: safeText(result.responseDigest, 180),
    checkedAt: safeText(result.checkedAt, 80),
  };

  if (verifierType === "x_user_metrics") {
    const followersCount = numeric(result.metrics?.followersCount, 0);
    const recommended = result.qualifications?.kolXFull === true && badgeId === "kol";
    return {
      recommended,
      reason: recommended ? "x_followers_threshold_met" : "x_followers_threshold_not_met",
      plannedRecords: recommended
        ? manualBadgeApprovalRecords({
            accountId: job.accountId,
            badgeId,
            provider: "x",
            publicHandle: result.username,
            profileUrl: result.profileUrl,
            approvalLevel: "L3",
            approvedByAccountId,
            approvedByOperator,
            evidence: {
              ...baseEvidence,
              providerUserId: result.providerUserId,
            },
            metrics: {
              followersCount,
              proofMethod: "x_public_metrics",
            },
            selectedDefault,
          })
        : null,
    };
  }

  if (verifierType === "github_collaborator_permission") {
    const recommended = result.writeAccess === true && badgeId === "core_contributor";
    return {
      recommended,
      reason: recommended ? "github_write_permission_verified" : "github_write_permission_missing",
      plannedRecords: recommended
        ? manualBadgeApprovalRecords({
            accountId: job.accountId,
            badgeId,
            provider: "github",
            publicHandle: result.username,
            approvalLevel: "L3",
            approvedByAccountId,
            approvedByOperator,
            evidence: {
              ...baseEvidence,
              owner: result.owner,
              repo: result.repo,
              permission: result.permission,
            },
            metrics: {
              permission: result.permission,
              writeAccess: result.writeAccess === true,
              proofMethod: "github_collaborator_permission_api",
            },
            selectedDefault,
          })
        : null,
    };
  }

  if (verifierType === "qa_worker_access") {
    const recommended = result.qualifications?.qaWorker === true && badgeId === "qa_worker";
    return {
      recommended,
      reason: recommended ? "qa_worker_backend_requirements_verified" : "qa_worker_backend_requirements_missing",
      plannedRecords: recommended
        ? manualBadgeApprovalRecords({
            accountId: job.accountId,
            badgeId,
            provider: "tasknode",
            approvalLevel: "L3",
            approvedByAccountId,
            approvedByOperator,
            evidence: {
              ...baseEvidence,
              accountId: result.accountId,
            },
            metrics: {
              telegramLinked: result.telegramLinked === true,
              discordLinked: result.discordLinked === true,
              usdcTopUp: result.usdcTopUp === true,
              linkedProviders: Array.isArray(result.metrics?.linkedProviders) ? result.metrics.linkedProviders : [],
              proofMethod: "telegram_discord_usdc_top_up",
            },
            selectedDefault,
          })
        : null,
    };
  }

  if (verifierType === "expert_access") {
    const recommended = result.qualifications?.expert === true && badgeId === "expert";
    return {
      recommended,
      reason: recommended ? "expert_persisted_review_verified" : "expert_persisted_review_not_verified",
      plannedRecords: recommended
        ? manualBadgeApprovalRecords({
            accountId: job.accountId,
            badgeId,
            provider: "tasknode",
            publicHandle: result.recommendedExpertLabel,
            approvalLevel: "L3",
            approvedByAccountId,
            approvedByOperator,
            evidence: {
              ...baseEvidence,
              topic: result.topic,
              reviewedAt: result.reviewedAt,
              evidenceTaskIds: Array.isArray(result.evidenceTaskIds) ? result.evidenceTaskIds : [],
            },
            metrics: {
              topic: result.topic,
              recommendedExpertLabel: result.recommendedExpertLabel,
              score: numeric(result.score, 0),
              thresholdScore: numeric(result.thresholdScore, 80),
              personalTaskCount: numeric(result.personalTaskCount, 0),
              requiredPersonalTaskCount: numeric(result.requiredPersonalTaskCount, 20),
              reviewCurrent: result.reviewCurrent === true,
              proofMethod: "glm52_last_20_personal_tasks",
              model: result.metrics?.model || "",
              responseId: result.metrics?.responseId || "",
            },
            selectedDefault,
          })
        : null,
    };
  }

  return {
    recommended: false,
    reason: "network_badge_verifier_type_unsupported",
    plannedRecords: null,
  };
}

export function approvalRecommendationFromVerifierJobResultJson({
  job = {},
  approvedByAccountId = "",
  approvedByOperator = "network_badge_verifier_job_approval",
  selectedDefault = false,
} = {}) {
  const resultJson = safeObject(job.resultJson || job.result_json);
  const resolverResult = safeObject(resultJson.resolverResult || resultJson.resolver_result);
  if (!Object.keys(resolverResult).length) {
    return {
      recommended: false,
      reason: "network_badge_verifier_job_missing_resolver_result",
      plannedRecords: null,
    };
  }
  return approvalRecommendationFromVerifierResult({
    job,
    result: resolverResult,
    approvedByAccountId,
    approvedByOperator,
    selectedDefault,
  });
}

export async function runNetworkBadgeVerifierJobRecord(job = {}, {
  fetchImpl = fetch,
  approvedByAccountId = "",
  approvedByOperator = "network_badge_verifier_job",
} = {}) {
  const normalizedJob = {
    ...job,
    verifierType: normalizeVerifierType(job.verifierType || job.verifier_type),
    badgeId: safeText(job.badgeId || job.badge_id, 80),
    accountId: safeText(job.accountId || job.account_id, 180),
    inputJson: safeObject(job.inputJson || job.input_json),
  };
  if (!activeVerifierTypes.has(normalizedJob.verifierType) || !activeVerifierBadgeIds.has(normalizedJob.badgeId)) {
    const error = new Error("network_badge_verifier_type_not_active");
    error.status = 400;
    throw error;
  }
  const result = await resolveJob(normalizedJob, { fetchImpl });
  const recommendation = approvalRecommendationFromVerifierResult({
    job: normalizedJob,
    result,
    approvedByAccountId,
    approvedByOperator,
  });
  return {
    ok: true,
    job: normalizedJob,
    result,
    recommendation,
  };
}

export async function approveNetworkBadgeFromVerifierJob({
  jobId = "",
  approvedByAccountId = "",
  approvedByOperator = "network_badge_verifier_job_approval",
  selectedDefault = false,
} = {}) {
  ensureDatabase();
  const normalizedJobId = safeText(jobId, 180);
  const selected = await query(
    `
      SELECT *
      FROM network_badge_verifier_jobs
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedJobId]
  );
  const job = selected.rows[0] ? rowToJob(selected.rows[0]) : null;
  if (!job) {
    const error = new Error("network_badge_verifier_job_not_found");
    error.status = 404;
    throw error;
  }
  if (job.status !== "succeeded") {
    const error = new Error("network_badge_verifier_job_not_succeeded");
    error.status = 409;
    throw error;
  }
  const recommendation = approvalRecommendationFromVerifierJobResultJson({
    job,
    approvedByAccountId,
    approvedByOperator,
    selectedDefault,
  });
  if (!recommendation.recommended || !recommendation.plannedRecords) {
    const error = new Error(recommendation.reason || "network_badge_verifier_job_not_recommended");
    error.status = 409;
    throw error;
  }
  const planned = recommendation.plannedRecords;
  const approval = await approveNetworkBadge({
    accountId: planned.accountId,
    badgeId: planned.badgeId,
    provider: planned.identityApproval.provider,
    publicHandle: planned.identityApproval.publicHandle,
    profileUrl: planned.identityApproval.profileUrl,
    approvalLevel: planned.identityApproval.approvalLevel,
    approvedByAccountId: approvedByAccountId || planned.identityApproval.approvedByAccountId,
    approvedByOperator: approvedByOperator || planned.identityApproval.approvedByOperator,
    evidence: {
      source: "network_badge_verifier_job_approval",
      verifierJobId: job.id,
      verifierType: job.verifierType,
      recommendationReason: recommendation.reason,
      ...safeObject(planned.identityApproval.evidenceJson?.evidence),
    },
    metrics: safeObject(planned.identityApproval.metricsJson),
    selectedDefault,
  });
  const resultJson = {
    ...job.resultJson,
    approval: {
      approvedAt: new Date().toISOString(),
      approvedByAccountId: safeText(approvedByAccountId, 180),
      approvedByOperator: safeText(approvedByOperator, 180),
      selectedDefault: selectedDefault === true,
      recommendationReason: recommendation.reason,
      identityApprovalId: approval.records?.identityApproval?.id || "",
      accountBadgeId: approval.records?.accountBadge?.id || "",
    },
  };
  const updated = await query(
    `
      UPDATE network_badge_verifier_jobs
      SET status = 'approved',
          result_json = $2::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [job.id, JSON.stringify(resultJson)]
  );
  return {
    ok: true,
    action: "approve_from_verifier_job",
    job: rowToJob(updated.rows[0]),
    recommendation,
    approval,
  };
}

export async function runNetworkBadgeVerifierJob({
  jobId = "",
  fetchImpl = fetch,
  approvedByAccountId = "",
  approvedByOperator = "network_badge_verifier_job",
} = {}) {
  ensureDatabase();
  const normalizedJobId = safeText(jobId, 180);
  const selected = await query(
    `
      SELECT *
      FROM network_badge_verifier_jobs
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedJobId]
  );
  const job = selected.rows[0] ? rowToJob(selected.rows[0]) : null;
  if (!job) {
    const error = new Error("network_badge_verifier_job_not_found");
    error.status = 404;
    throw error;
  }
  await query(
    `
      UPDATE network_badge_verifier_jobs
      SET status = 'running',
          attempt_count = attempt_count + 1,
          started_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [normalizedJobId]
  );
  try {
    const resolved = await runNetworkBadgeVerifierJobRecord(job, {
      fetchImpl,
      approvedByAccountId,
      approvedByOperator,
    });
    const resultJson = {
      resolverResult: resolved.result,
      recommendation: resolved.recommendation,
    };
    const updated = await query(
      `
        UPDATE network_badge_verifier_jobs
        SET status = 'succeeded',
            result_json = $2::jsonb,
            last_error = '',
            completed_at = now(),
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [normalizedJobId, JSON.stringify(resultJson)]
    );
    return {
      ...resolved,
      job: rowToJob(updated.rows[0]),
    };
  } catch (error) {
    const failed = await query(
      `
        UPDATE network_badge_verifier_jobs
        SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
            last_error = $2,
            run_after = now() + interval '5 minutes',
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [normalizedJobId, safeText(error?.message || "network_badge_verifier_job_failed", 1000)]
    );
    return {
      ok: false,
      job: rowToJob(failed.rows[0]),
      error: safeText(error?.message || "network_badge_verifier_job_failed", 1000),
    };
  }
}
