import { randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";
import { nonFixtureTaskProjectionSql } from "./task-projection-integrity.js";

const runtimeAwards = new Map();

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function dateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeAward(row = {}) {
  const eligibilityJson = row.eligibility_json || row.eligibilityJson || {};
  return {
    id: row.id || "",
    runDate: row.run_date ? dateOnly(row.run_date) : row.runDate || "",
    accountId: row.account_id || row.accountId || "",
    walletAddress: row.wallet_address || row.walletAddress || "",
    profileNftId: row.profile_nft_id || row.profileNftId || "",
    status: row.status || "pending",
    eligibilityReason: row.eligibility_reason || row.eligibilityReason || "",
    personalCompletedCount: Number(row.personal_completed_count || row.personalCompletedCount || 0),
    networkCompletedCount: Number(row.network_completed_count || row.networkCompletedCount || 0),
    eligibilityJson,
    attemptCount: Number(row.attempt_count || row.attemptCount || 0),
    error: row.error || "",
    startedAt: toIso(row.started_at || row.startedAt),
    completedAt: toIso(row.completed_at || row.completedAt),
    createdAt: toIso(row.created_at || row.createdAt),
    updatedAt: toIso(row.updated_at || row.updatedAt),
  };
}

function eligibilityReason({ personalCompletedCount = 0, networkCompletedCount = 0 } = {}) {
  if (Number(networkCompletedCount || 0) >= 1) return "network_task_completed";
  if (Number(personalCompletedCount || 0) > 3) return "personal_task_threshold";
  return "ineligible";
}

export function dailyProfileNftEligibilityReason(candidate = {}) {
  return eligibilityReason(candidate);
}

export async function listDailyProfileNftCandidates({
  runDate = dateOnly(),
  personalTaskThreshold = 3,
  networkTaskThreshold = 1,
  maxAttempts = 3,
  limit = 10,
} = {}) {
  if (!databaseEnabled()) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
  const safePersonalTaskThreshold = Math.min(Math.max(Number(personalTaskThreshold) || 3, 0), 1000);
  const safeNetworkTaskThreshold = Math.min(Math.max(Number(networkTaskThreshold) || 1, 1), 1000);
  const safeMaxAttempts = Math.min(Math.max(Number(maxAttempts) || 3, 1), 20);
  const result = await query(
    `WITH completed_tasks AS (
       SELECT p.account_id,
              CASE
                WHEN lower(COALESCE(NULLIF(p.task_kind, ''), p.metadata_json->'generatedTask'->>'task_kind', 'personal')) = 'network'
                  THEN 'network'
                ELSE 'personal'
              END AS resolved_kind,
              COALESCE(p.last_event_at, p.updated_at, p.created_at) AS completed_at
         FROM task_projections p
        WHERE p.account_id <> ''
          AND p.status IN ('completed', 'rewarded')
          AND ${nonFixtureTaskProjectionSql("p")}
     ),
     eligible_accounts AS (
       SELECT account_id,
              COUNT(*) FILTER (WHERE resolved_kind <> 'network')::integer AS personal_completed_count,
              COUNT(*) FILTER (WHERE resolved_kind = 'network')::integer AS network_completed_count,
              MAX(completed_at) AS last_completed_at
         FROM completed_tasks
        GROUP BY account_id
     ),
     active_wallets AS (
       SELECT DISTINCT ON (account_id)
              account_id,
              wallet_address
         FROM pftl_sync_wallets
        WHERE account_id <> ''
          AND wallet_address <> ''
          AND status = 'active'
          AND role = 'user'
        ORDER BY account_id, priority ASC, updated_at DESC, wallet_address ASC
     )
     SELECT e.account_id,
            w.wallet_address,
            e.personal_completed_count,
            e.network_completed_count,
            e.last_completed_at
       FROM eligible_accounts e
       JOIN active_wallets w ON w.account_id = e.account_id
       LEFT JOIN profile_nft_daily_awards retry_award
              ON retry_award.account_id = e.account_id
             AND retry_award.run_date = $1::date
             AND retry_award.status IN ('pending', 'failed')
             AND retry_award.attempt_count < $5
      WHERE (
              e.personal_completed_count > $2
              OR e.network_completed_count >= $3
            )
        AND NOT EXISTS (
              SELECT 1
                FROM profile_nft_daily_awards award
               WHERE award.account_id = e.account_id
                 AND award.run_date = $1::date
                 AND (
                       award.status IN ('generated', 'running', 'skipped')
                       OR (
                            award.status = 'failed'
                            AND award.attempt_count >= $5
                         )
                     )
            )
      ORDER BY (retry_award.id IS NOT NULL) DESC,
               e.last_completed_at DESC NULLS LAST,
               e.network_completed_count DESC,
               e.personal_completed_count DESC,
               e.account_id ASC
      LIMIT $4`,
    [dateOnly(runDate), safePersonalTaskThreshold, safeNetworkTaskThreshold, safeLimit, safeMaxAttempts]
  );
  return result.rows.map((row) => {
    const candidate = {
      accountId: row.account_id,
      walletAddress: row.wallet_address,
      personalCompletedCount: Number(row.personal_completed_count || 0),
      networkCompletedCount: Number(row.network_completed_count || 0),
      lastCompletedAt: toIso(row.last_completed_at),
    };
    return {
      ...candidate,
      eligibilityReason: eligibilityReason(candidate),
    };
  });
}

export async function failStaleRunningDailyProfileNftAwards({
  staleAfterMs = 20 * 60 * 1000,
  error = "Daily Profile NFT generation was interrupted before completion.",
} = {}) {
  const safeStaleAfterMs = Math.min(Math.max(Number(staleAfterMs) || 20 * 60 * 1000, 60_000), 24 * 60 * 60 * 1000);
  const normalizedError = safeText(error, 500);
  const now = new Date();
  const cutoffMs = now.getTime() - safeStaleAfterMs;

  if (!databaseEnabled()) {
    let failedCount = 0;
    for (const [id, award] of runtimeAwards.entries()) {
      if (award.status !== "running") continue;
      const startedAtMs = award.startedAt ? new Date(award.startedAt).getTime() : 0;
      if (Number.isFinite(startedAtMs) && startedAtMs > cutoffMs) continue;
      runtimeAwards.set(id, normalizeAward({
        ...award,
        status: "failed",
        error: normalizedError,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }));
      failedCount += 1;
    }
    return { failedCount };
  }

  const result = await query(
    `UPDATE profile_nft_daily_awards
        SET status = 'failed',
            error = $2,
            completed_at = now(),
            updated_at = now()
      WHERE status = 'running'
        AND COALESCE(started_at, updated_at, created_at) < now() - ($1 * interval '1 millisecond')
      RETURNING id`,
    [safeStaleAfterMs, normalizedError]
  );
  return { failedCount: result.rowCount || 0 };
}

export async function createDailyProfileNftAward({
  id = `daily_nft_${randomUUID()}`,
  runDate = dateOnly(),
  accountId = "",
  walletAddress = "",
  personalCompletedCount = 0,
  networkCompletedCount = 0,
  eligibilityReason: reason = "",
  eligibilityJson = {},
} = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) throw new Error("profile_nft_daily_account_required");
  const normalizedRunDate = dateOnly(runDate);
  const normalizedPersonalCount = Math.max(0, Number(personalCompletedCount || 0));
  const normalizedNetworkCount = Math.max(0, Number(networkCompletedCount || 0));
  const normalizedReason = safeText(reason, 120) || eligibilityReason({
    personalCompletedCount: normalizedPersonalCount,
    networkCompletedCount: normalizedNetworkCount,
  });
  const normalized = normalizeAward({
    id,
    runDate: normalizedRunDate,
    accountId: normalizedAccount,
    walletAddress: safeText(walletAddress, 120),
    status: "pending",
    eligibilityReason: normalizedReason,
    personalCompletedCount: normalizedPersonalCount,
    networkCompletedCount: normalizedNetworkCount,
    eligibilityJson,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  if (!databaseEnabled()) {
    const existing = [...runtimeAwards.values()].find(
      (award) => award.accountId === normalizedAccount && award.runDate === normalizedRunDate
    );
    if (existing) return existing;
    runtimeAwards.set(normalized.id, normalized);
    return normalized;
  }

  const result = await query(
    `INSERT INTO profile_nft_daily_awards (
       id, run_date, account_id, wallet_address, status, eligibility_reason,
       personal_completed_count, network_completed_count, eligibility_json
     )
     VALUES ($1, $2::date, $3, $4, 'pending', $5, $6, $7, $8::jsonb)
     ON CONFLICT (run_date, account_id) DO UPDATE SET
       updated_at = profile_nft_daily_awards.updated_at
     RETURNING *`,
    [
      normalized.id,
      normalized.runDate,
      normalized.accountId,
      normalized.walletAddress,
      normalized.eligibilityReason,
      normalized.personalCompletedCount,
      normalized.networkCompletedCount,
      JSON.stringify(normalized.eligibilityJson || {}),
    ]
  );
  return normalizeAward(result.rows[0]);
}

export async function markDailyProfileNftAwardRunning({ awardId = "" } = {}) {
  const normalizedAwardId = safeText(awardId, 180);
  if (!normalizedAwardId) return null;
  const startedAt = new Date().toISOString();

  if (!databaseEnabled()) {
    const award = runtimeAwards.get(normalizedAwardId);
    if (!award) return null;
    const next = normalizeAward({
      ...award,
      status: "running",
      attemptCount: Number(award.attemptCount || 0) + 1,
      error: "",
      startedAt,
      updatedAt: startedAt,
    });
    runtimeAwards.set(normalizedAwardId, next);
    return next;
  }

  const result = await query(
    `UPDATE profile_nft_daily_awards
        SET status = 'running',
            attempt_count = attempt_count + 1,
            error = '',
            started_at = now(),
            updated_at = now()
      WHERE id = $1
        AND status IN ('pending', 'failed')
      RETURNING *`,
    [normalizedAwardId]
  );
  return result.rows[0] ? normalizeAward(result.rows[0]) : null;
}

export async function markDailyProfileNftAwardGenerated({ awardId = "", profileNftId = "" } = {}) {
  const normalizedAwardId = safeText(awardId, 180);
  if (!normalizedAwardId) return null;
  const completedAt = new Date().toISOString();

  if (!databaseEnabled()) {
    const award = runtimeAwards.get(normalizedAwardId);
    if (!award) return null;
    const next = normalizeAward({
      ...award,
      profileNftId: safeText(profileNftId, 180),
      status: "generated",
      error: "",
      completedAt,
      updatedAt: completedAt,
    });
    runtimeAwards.set(normalizedAwardId, next);
    return next;
  }

  const result = await query(
    `UPDATE profile_nft_daily_awards
        SET status = 'generated',
            profile_nft_id = $2,
            error = '',
            completed_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [normalizedAwardId, safeText(profileNftId, 180)]
  );
  return result.rows[0] ? normalizeAward(result.rows[0]) : null;
}

export async function markDailyProfileNftAwardFailed({ awardId = "", error = "" } = {}) {
  const normalizedAwardId = safeText(awardId, 180);
  if (!normalizedAwardId) return null;
  const completedAt = new Date().toISOString();

  if (!databaseEnabled()) {
    const award = runtimeAwards.get(normalizedAwardId);
    if (!award) return null;
    const next = normalizeAward({
      ...award,
      status: "failed",
      error: safeText(error, 500),
      completedAt,
      updatedAt: completedAt,
    });
    runtimeAwards.set(normalizedAwardId, next);
    return next;
  }

  const result = await query(
    `UPDATE profile_nft_daily_awards
        SET status = 'failed',
            error = $2,
            completed_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [normalizedAwardId, safeText(error, 500)]
  );
  return result.rows[0] ? normalizeAward(result.rows[0]) : null;
}

export async function latestDailyProfileNftAwardSummary() {
  if (!databaseEnabled()) return null;
  const result = await query(
    `SELECT *
       FROM profile_nft_daily_awards
      ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
      LIMIT 1`
  );
  return result.rows[0] ? normalizeAward(result.rows[0]) : null;
}
