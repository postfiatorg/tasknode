import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { getChatMemoryContext } from "./chat-memory.js";
import { getContextDocument } from "./context.js";
import { buildPublicProfileSnapshotInput, getLatestPublicProfileSnapshot } from "./profile-public.js";
import { recordUserObservabilityEvent } from "./user-observability.js";
import {
  canonicalRewardedTaskProjectionSql,
  nonFixtureTaskProjectionSql,
} from "./task-projection-integrity.js";
import {
  buildNetworkTaskProfileSourcePacket,
  formatLiveTaskRoutingContext,
  formatNetworkContextInputs,
  formatNetworkTaskProfileOutput,
  networkTaskProfilePromptVersion,
  publicNetworkTaskProfile,
  publicNetworkTaskProfileJob,
  publicProfileFromRow,
} from "./network-task-profile-source.js";

export {
  buildNetworkTaskProfileSourcePacket,
  formatLiveTaskRoutingContext,
  formatNetworkContextInputs,
  formatNetworkTaskProfileOutput,
  networkTaskProfilePromptVersion,
} from "./network-task-profile-source.js";

const maxClaimLimit = 5;
const failedAttemptLimit = 3;
const autoRefreshMs = 24 * 60 * 60 * 1000;
const rewardThresholdDefault = 2;
export const networkTaskProfileRewardThreshold = rewardThresholdDefault;

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeAccountId(accountId = "") {
  return safeText(accountId, 180);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

export async function getLiveTaskRoutingContext({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId || !useDatabase()) {
    return formatLiveTaskRoutingContext([]);
  }

  const result = await query(
    `
      SELECT p.*,
             (
               SELECT e.payload_json
	               FROM task_events e
	               WHERE e.task_id = p.task_id
	                 AND e.event_type = 'pf.reward.v1'
	               ORDER BY e.occurred_at DESC, e.id DESC
	               LIMIT 1
	             ) AS reward_outcome_payload,
             (
               SELECT e.payload_json
               FROM task_events e
               WHERE e.task_id = p.task_id
                 AND e.event_type = 'pf.task.update.v1'
                 AND (
                   e.payload_json->>'transition' IN ('refused', 'cancelled', 'rejected')
                   OR e.payload_json->>'status_after' IN ('refused', 'cancelled', 'rejected')
                 )
               ORDER BY e.occurred_at DESC, e.id DESC
               LIMIT 1
             ) AS stop_payload
      FROM task_projections p
      WHERE p.account_id = $1
        AND p.status <> 'unknown'
        AND ${nonFixtureTaskProjectionSql("p")}
      ORDER BY p.updated_at DESC, p.task_id DESC
      LIMIT 200
    `,
    [normalizedAccountId]
  );
  return formatLiveTaskRoutingContext(result.rows.map(publicProfileFromRow));
}

export async function buildNetworkTaskProfileSource({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) throw new Error("network_task_profile_account_required");
  const [contextDocument, memoryContext, liveTaskContext, profileInput, latestProfileSnapshot] = await Promise.all([
    getContextDocument({ accountId: normalizedAccountId }),
    getChatMemoryContext({ accountId: normalizedAccountId, deepLimit: 3, turnLimit: 36 }),
    getLiveTaskRoutingContext({ accountId: normalizedAccountId }),
    buildPublicProfileSnapshotInput({ accountId: normalizedAccountId }).catch(() => null),
    getLatestPublicProfileSnapshot({ accountId: normalizedAccountId }).catch(() => null),
  ]);
  const networkContextInputs = {
    text: formatNetworkContextInputs({
      liveTaskContext,
      profileInput,
      latestProfileSnapshot,
    }),
    counts: liveTaskContext.counts,
  };
  return {
    liveTaskContext,
    networkContextInputs,
    ...buildNetworkTaskProfileSourcePacket({
      accountId: normalizedAccountId,
      contextDocument,
      memoryContext,
      liveTaskContext,
      profileInput,
      latestProfileSnapshot,
    }),
  };
}

export async function getLatestNetworkTaskProfile({ accountId = "" } = {}) {
  if (!useDatabase()) return null;
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return null;
  const result = await query(
    `
      SELECT *
      FROM network_task_profiles
      WHERE account_id = $1
        AND status = 'completed'
        AND superseded_at IS NULL
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId]
  );
  return publicNetworkTaskProfile(result.rows[0] || null);
}

export async function getLatestNetworkTaskProfileJob({ accountId = "" } = {}) {
  if (!useDatabase()) return null;
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return null;
  const result = await query(
    `
      SELECT *
      FROM network_task_profile_jobs
      WHERE account_id = $1
        AND status IN ('pending', 'processing')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId]
  );
  return publicNetworkTaskProfileJob(result.rows[0] || null);
}

export async function enqueueNetworkTaskProfileJob({
  accountId = "",
  sourcePacket = null,
  reason = "memory_page",
} = {}) {
  if (!useDatabase()) return { queued: false, reason: "database_not_configured" };
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId || !sourcePacket?.sourcePacketDigest) {
    return { queued: false, reason: "missing_source_packet" };
  }
  const result = await query(
    `
      INSERT INTO network_task_profile_jobs (
        id,
        account_id,
        reason,
        source_packet_digest,
        source_packet_json,
        source_packet_text
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (account_id, source_packet_digest)
        WHERE status IN ('pending', 'processing')
      DO UPDATE SET
        reason = EXCLUDED.reason,
        source_packet_json = EXCLUDED.source_packet_json,
        source_packet_text = EXCLUDED.source_packet_text,
        updated_at = now()
      RETURNING *
    `,
    [
      `nettaskprofilejob_${randomUUID()}`,
      normalizedAccountId,
      safeText(reason, 120),
      sourcePacket.sourcePacketDigest,
      jsonValue(sourcePacket.sourceJson),
      sourcePacket.sourceText,
    ]
  );
  const job = publicNetworkTaskProfileJob(result.rows[0]);
  await recordUserObservabilityEvent({
    eventType: "user.memory.network_profile_queued",
    accountId: normalizedAccountId,
    sourceSurface: "memory",
    sourceRoute: "server/repositories/network-task-profile.js::enqueueNetworkTaskProfileJob",
    resultStatus: "queued",
    reasonCode: safeText(reason, 120),
    metadata: {
      jobId: job?.id || "",
      sourcePacketDigest: sourcePacket.sourcePacketDigest,
    },
  }).catch(() => {});
  return { queued: true, job };
}

export async function positiveRewardStats({ accountId = "" } = {}) {
  if (!useDatabase()) return { positiveRewardedTaskCount: 0, lastRewardedTaskAt: null };
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return { positiveRewardedTaskCount: 0, lastRewardedTaskAt: null };
  const result = await query(
    `
      SELECT COUNT(task_id)::integer AS rewarded_task_count,
             MAX(updated_at) AS last_rewarded_task_at
      FROM task_projections
      WHERE account_id = $1
        AND ${canonicalRewardedTaskProjectionSql("task_projections")}
    `,
    [normalizedAccountId]
  );
  const row = result.rows[0] || {};
  return {
    positiveRewardedTaskCount: Number(row.rewarded_task_count || 0),
    lastRewardedTaskAt: toIso(row.last_rewarded_task_at),
  };
}

export async function enqueueNetworkTaskProfileForRewardThreshold({
  accountId = "",
  reason = "rewarded_task_threshold",
  minRewardedTasks = rewardThresholdDefault,
} = {}) {
  if (!useDatabase()) return { queued: false, reason: "database_not_configured" };
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return { queued: false, reason: "missing_account_id" };

  const threshold = Math.max(1, Number(minRewardedTasks || rewardThresholdDefault));
  const stats = await positiveRewardStats({ accountId: normalizedAccountId });
  if (stats.positiveRewardedTaskCount < threshold) {
    return {
      queued: false,
      reason: "reward_threshold_not_met",
      minRewardedTasks: threshold,
      ...stats,
    };
  }

  const source = await buildNetworkTaskProfileSource({ accountId: normalizedAccountId });
  const [latest, activeJob] = await Promise.all([
    getLatestNetworkTaskProfile({ accountId: normalizedAccountId }),
    getLatestNetworkTaskProfileJob({ accountId: normalizedAccountId }),
  ]);
  const currentCompletedProfile = Boolean(
    latest?.sourcePacketDigest === source.sourcePacketDigest &&
      latest?.promptVersion === networkTaskProfilePromptVersion
  );
  if (currentCompletedProfile) {
    return {
      queued: false,
      reason: "network_task_profile_current",
      minRewardedTasks: threshold,
      sourcePacketDigest: source.sourcePacketDigest,
      ...stats,
    };
  }
  if (activeJob?.sourcePacketDigest === source.sourcePacketDigest) {
    return {
      queued: false,
      reason: "network_task_profile_job_already_active",
      minRewardedTasks: threshold,
      job: activeJob,
      sourcePacketDigest: source.sourcePacketDigest,
      ...stats,
    };
  }

  const queued = await enqueueNetworkTaskProfileJob({
    accountId: normalizedAccountId,
    sourcePacket: source,
    reason,
  });
  return {
    ...queued,
    reason: queued.reason || reason,
    minRewardedTasks: threshold,
    sourcePacketDigest: source.sourcePacketDigest,
    ...stats,
  };
}

export async function enqueueNetworkTaskProfilesForRewardedAccounts({
  limit = 2,
  minRewardedTasks = rewardThresholdDefault,
  reason = "rewarded_task_threshold_backfill",
} = {}) {
  if (!useDatabase()) return { ok: true, skipped: true, reason: "database_not_configured" };
  const threshold = Math.max(1, Number(minRewardedTasks || rewardThresholdDefault));
  const normalizedLimit = Math.min(Math.max(Number(limit) || 1, 1), 10);
  const result = await query(
    `
      WITH reward_accounts AS (
        SELECT account_id,
               COUNT(task_id)::integer AS rewarded_task_count,
               MAX(updated_at) AS last_rewarded_task_at
        FROM task_projections
        WHERE account_id <> ''
          AND ${canonicalRewardedTaskProjectionSql("task_projections")}
        GROUP BY account_id
        HAVING COUNT(task_id) >= $1
      ),
      latest_profiles AS (
        SELECT DISTINCT ON (account_id)
               account_id,
               source_packet_digest,
               prompt_version,
               completed_at,
               created_at
        FROM network_task_profiles
        WHERE status = 'completed'
          AND superseded_at IS NULL
        ORDER BY account_id, completed_at DESC NULLS LAST, created_at DESC, id DESC
      ),
      active_jobs AS (
        SELECT DISTINCT account_id
        FROM network_task_profile_jobs
        WHERE status IN ('pending', 'processing')
      )
      SELECT reward_accounts.account_id,
             reward_accounts.rewarded_task_count,
             reward_accounts.last_rewarded_task_at
      FROM reward_accounts
      LEFT JOIN latest_profiles
        ON latest_profiles.account_id = reward_accounts.account_id
      LEFT JOIN active_jobs
        ON active_jobs.account_id = reward_accounts.account_id
      WHERE active_jobs.account_id IS NULL
        AND (
          latest_profiles.account_id IS NULL
          OR latest_profiles.prompt_version <> $2
          OR COALESCE(latest_profiles.completed_at, latest_profiles.created_at)
               < reward_accounts.last_rewarded_task_at
        )
      ORDER BY reward_accounts.last_rewarded_task_at ASC,
               reward_accounts.account_id ASC
      LIMIT $3
    `,
    [threshold, networkTaskProfilePromptVersion, normalizedLimit]
  );

  const results = [];
  for (const row of result.rows) {
    try {
      results.push(await enqueueNetworkTaskProfileForRewardThreshold({
        accountId: row.account_id,
        reason,
        minRewardedTasks: threshold,
      }));
    } catch (error) {
      results.push({
        queued: false,
        reason: "reward_threshold_enqueue_failed",
        accountId: safeAccountId(row.account_id),
        error: safeText(error?.message || error, 1000),
      });
    }
  }

  return {
    ok: true,
    scanned: result.rows.length,
    queuedCount: results.filter((item) => item.queued).length,
    failedCount: results.filter((item) => item.reason === "reward_threshold_enqueue_failed").length,
    results,
  };
}

export async function getNetworkTaskProfileState({
  accountId = "",
  force = false,
  reason = "memory_page",
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) return { ok: false, status: 401, error: "network_task_profile_login_required" };
  const source = await buildNetworkTaskProfileSource({ accountId: normalizedAccountId });
  const latest = await getLatestNetworkTaskProfile({ accountId: normalizedAccountId });
  const latestCompletedAt = latest?.completedAt ? Date.parse(latest.completedAt) : 0;
  const stale = !latestCompletedAt || Date.now() - latestCompletedAt > autoRefreshMs;
  const digestChanged = latest?.sourcePacketDigest !== source.sourcePacketDigest;
  const promptChanged = latest?.promptVersion !== networkTaskProfilePromptVersion;
  let enqueue = null;

  if (!latest || force || promptChanged || (digestChanged && stale)) {
    enqueue = await enqueueNetworkTaskProfileJob({
      accountId: normalizedAccountId,
      sourcePacket: source,
      reason,
    });
  }

  const job = await getLatestNetworkTaskProfileJob({ accountId: normalizedAccountId });
  return {
    ok: true,
    liveTaskContext: source.liveTaskContext,
    networkContextInputs: source.networkContextInputs,
    profile: latest,
    job: job || enqueue?.job || null,
    sourcePacket: {
      text: source.sourceText,
      digest: source.sourcePacketDigest,
      counts: source.sourceCounts,
    },
    refresh: {
      stale,
      digestChanged,
      promptChanged,
      queued: Boolean(enqueue?.queued),
      reason: enqueue?.reason || reason,
    },
  };
}

export async function resetNetworkTaskProfileMemory({ accountId = "" } = {}) {
  if (!useDatabase()) return { ok: false, status: 503, error: "database_not_configured" };
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) {
    return { ok: false, status: 400, error: "network_task_profile_reset_missing_account", message: "Sign in before resetting the diagnostic report." };
  }

  return transaction(async (client) => {
    const jobs = await client.query(
      `
        DELETE FROM network_task_profile_jobs
        WHERE account_id = $1
      `,
      [normalizedAccountId]
    );
    const profiles = await client.query(
      `
        DELETE FROM network_task_profiles
        WHERE account_id = $1
      `,
      [normalizedAccountId]
    );

    return {
      ok: true,
      action: "reset_network_profile",
      deleted: {
        jobs: jobs.rowCount,
        profiles: profiles.rowCount,
      },
      message: "Diagnostic report reset.",
    };
  });
}

export async function claimNetworkTaskProfileJobs({ limit = 1 } = {}) {
  if (!useDatabase()) return [];
  const normalizedLimit = Math.min(Math.max(Number(limit) || 1, 1), maxClaimLimit);
  return transaction(async (client) => {
    await client.query(
      `
        UPDATE network_task_profile_jobs
        SET status = 'pending',
            next_attempt_at = now(),
            locked_at = NULL,
            updated_at = now()
        WHERE status = 'processing'
          AND locked_at < now() - interval '5 minutes'
      `
    );

    const result = await client.query(
      `
        WITH picked AS (
          SELECT id
          FROM network_task_profile_jobs
          WHERE status = 'pending'
            AND next_attempt_at <= now()
          ORDER BY created_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE network_task_profile_jobs AS job
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

export async function completeNetworkTaskProfileJob({
  job,
  output = {},
  provider = "",
  model = "",
  promptDigest = "",
  usage = {},
} = {}) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const outputJson = safeObject(output);
  const outputText = formatNetworkTaskProfileOutput(outputJson);
  const result = await transaction(async (client) => {
    await client.query(
      `
        UPDATE network_task_profiles
        SET superseded_at = now()
        WHERE account_id = $1
          AND status = 'completed'
          AND superseded_at IS NULL
      `,
      [safeAccountId(job.account_id)]
    );
    const inserted = await client.query(
      `
        INSERT INTO network_task_profiles (
          id,
          account_id,
          status,
          source_packet_json,
          source_packet_text,
          source_packet_digest,
          output_json,
          output_text,
          provider,
          model,
          prompt_version,
          prompt_digest,
          usage_json,
          completed_at
        )
        VALUES ($1, $2, 'completed', $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, now())
        RETURNING *
      `,
      [
        `nettaskprofile_${randomUUID()}`,
        safeAccountId(job.account_id),
        jsonValue(job.source_packet_json),
        safeText(job.source_packet_text, 120_000),
        safeText(job.source_packet_digest, 120),
        jsonValue(outputJson),
        outputText,
        safeText(provider, 80),
        safeText(model, 160),
        networkTaskProfilePromptVersion,
        safeText(promptDigest, 120),
        jsonValue(usage),
      ]
    );
    await client.query(
      `
        UPDATE network_task_profile_jobs
        SET status = 'completed',
            locked_at = NULL,
            last_error = '',
            updated_at = now()
        WHERE id = $1
      `,
      [job.id]
    );
    return { ok: true, profile: publicNetworkTaskProfile(inserted.rows[0]) };
  });
  await recordUserObservabilityEvent({
    eventType: "user.memory.network_profile_completed",
    accountId: safeAccountId(job.account_id),
    sourceSurface: "memory",
    sourceRoute: "server/repositories/network-task-profile.js::completeNetworkTaskProfileJob",
    resultStatus: "completed",
    metadata: {
      jobId: job.id,
      profileId: result.profile?.id || "",
      sourcePacketDigest: safeText(job.source_packet_digest, 120),
      provider: safeText(provider, 80),
      model: safeText(model, 160),
      promptVersion: networkTaskProfilePromptVersion,
      promptDigest: safeText(promptDigest, 120),
    },
    metrics: {
      inputTokens: Number(usage?.inputTokens || usage?.prompt_tokens || 0),
      outputTokens: Number(usage?.outputTokens || usage?.completion_tokens || 0),
      totalTokens: Number(usage?.totalTokens || usage?.total_tokens || 0),
    },
  }).catch(() => {});
  return result;
}

export async function failNetworkTaskProfileJob(job, error) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const attemptCount = Number(job.attempt_count || 0);
  const finalFailure = attemptCount >= failedAttemptLimit;
  const backoffSeconds = Math.min(900, Math.max(30, 30 * attemptCount * attemptCount));
  await query(
    `
      UPDATE network_task_profile_jobs
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
      safeText(error?.message || error || "network_task_profile_job_failed", 1000),
    ]
  );
  await recordUserObservabilityEvent({
    eventType: "user.memory.network_profile_failed",
    accountId: safeAccountId(job.account_id),
    sourceSurface: "memory",
    sourceRoute: "server/repositories/network-task-profile.js::failNetworkTaskProfileJob",
    resultStatus: finalFailure ? "failed" : "retry_pending",
    reasonCode: safeText(error?.message || error || "network_task_profile_job_failed", 180),
    metadata: {
      jobId: job.id,
      sourcePacketDigest: safeText(job.source_packet_digest, 120),
      attemptCount,
      finalFailure,
    },
  }).catch(() => {});
  return { ok: true, retry: !finalFailure };
}
