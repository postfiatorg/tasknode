import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { nonFixtureTaskProjectionSql } from "./task-projection-integrity.js";

const runtimeAwards = new Map();
const runtimeHeartbeats = new Map();
const WORKER_KEY = "profile_nft_daily";

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
    errorCode: row.error_code || row.errorCode || "",
    retryable: Boolean(row.retryable),
    nextAttemptAt: toIso(row.next_attempt_at || row.nextAttemptAt),
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
             AND retry_award.status IN ('pending', 'retry_wait')
             AND retry_award.attempt_count < $5
             AND (retry_award.next_attempt_at IS NULL OR retry_award.next_attempt_at <= now())
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
                       award.status IN ('generated', 'running', 'skipped', 'failed_permanent')
                       OR (
                            award.status = 'retry_wait'
                            AND (award.attempt_count >= $5 OR award.next_attempt_at > now())
                          )
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

export async function listDailyProfileNftBackfillSlots({
  runDates = [],
  personalTaskThreshold = 3,
  networkTaskThreshold = 1,
} = {}) {
  const normalizedDates = [...new Set(runDates.map((value) => dateOnly(value)))].sort();
  if (!normalizedDates.length || !databaseEnabled()) return [];
  const safePersonalTaskThreshold = Math.min(Math.max(Number(personalTaskThreshold) || 3, 0), 1000);
  const safeNetworkTaskThreshold = Math.min(Math.max(Number(networkTaskThreshold) || 1, 1), 1000);
  const result = await query(
    `WITH completed_tasks AS (
       SELECT p.account_id,
              CASE WHEN lower(COALESCE(NULLIF(p.task_kind, ''), p.metadata_json->'generatedTask'->>'task_kind', 'personal')) = 'network' THEN 'network' ELSE 'personal' END AS resolved_kind,
              COALESCE(p.last_event_at, p.updated_at, p.created_at) AS completed_at
         FROM task_projections p
        WHERE p.account_id <> ''
          AND p.status IN ('completed', 'rewarded')
          AND ${nonFixtureTaskProjectionSql("p")}
     ), eligible_accounts AS (
       SELECT account_id,
              COUNT(*) FILTER (WHERE resolved_kind <> 'network')::integer AS personal_completed_count,
              COUNT(*) FILTER (WHERE resolved_kind = 'network')::integer AS network_completed_count,
              MAX(completed_at) AS last_completed_at
         FROM completed_tasks
        GROUP BY account_id
     ), active_wallets AS (
       SELECT DISTINCT ON (account_id) account_id, wallet_address
         FROM pftl_sync_wallets
        WHERE account_id <> '' AND wallet_address <> '' AND status = 'active' AND role = 'user'
        ORDER BY account_id, priority ASC, updated_at DESC, wallet_address ASC
     )
     SELECT e.account_id, w.wallet_address, e.personal_completed_count, e.network_completed_count,
            e.last_completed_at, slot.run_date
       FROM eligible_accounts e
       JOIN active_wallets w ON w.account_id = e.account_id
       CROSS JOIN unnest($1::date[]) AS slot(run_date)
      WHERE (e.personal_completed_count > $2 OR e.network_completed_count >= $3)
        AND NOT EXISTS (
          SELECT 1 FROM profile_nft_daily_awards award
           WHERE award.account_id = e.account_id AND award.run_date = slot.run_date
        )
      ORDER BY e.account_id ASC, slot.run_date DESC`,
    [normalizedDates, safePersonalTaskThreshold, safeNetworkTaskThreshold]
  );
  return result.rows.map((row) => {
    const candidate = {
      accountId: row.account_id,
      walletAddress: row.wallet_address,
      personalCompletedCount: Number(row.personal_completed_count || 0),
      networkCompletedCount: Number(row.network_completed_count || 0),
      lastCompletedAt: toIso(row.last_completed_at),
      runDate: dateOnly(row.run_date),
      existingStateProof: "no_award_row",
    };
    return { ...candidate, eligibilityReason: eligibilityReason(candidate) };
  });
}

export async function verifyDailyProfileNftBackfillSlot({
  accountId = "",
  runDate = "",
  personalTaskThreshold = 3,
  networkTaskThreshold = 1,
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedRunDate = dateOnly(runDate);
  if (!normalizedAccountId || !runDate || !databaseEnabled()) return null;
  const safePersonalTaskThreshold = Math.min(Math.max(Number(personalTaskThreshold) || 3, 0), 1000);
  const safeNetworkTaskThreshold = Math.min(Math.max(Number(networkTaskThreshold) || 1, 1), 1000);
  const result = await query(
    `WITH completed_tasks AS (
       SELECT p.account_id,
              CASE WHEN lower(COALESCE(NULLIF(p.task_kind, ''), p.metadata_json->'generatedTask'->>'task_kind', 'personal')) = 'network' THEN 'network' ELSE 'personal' END AS resolved_kind,
              COALESCE(p.last_event_at, p.updated_at, p.created_at) AS completed_at
         FROM task_projections p
        WHERE p.account_id = $1
          AND p.status IN ('completed', 'rewarded')
          AND ${nonFixtureTaskProjectionSql("p")}
     ), eligible_account AS (
       SELECT account_id,
              COUNT(*) FILTER (WHERE resolved_kind <> 'network')::integer AS personal_completed_count,
              COUNT(*) FILTER (WHERE resolved_kind = 'network')::integer AS network_completed_count,
              MAX(completed_at) AS last_completed_at
         FROM completed_tasks
        GROUP BY account_id
     ), active_wallet AS (
       SELECT wallet_address
         FROM pftl_sync_wallets
        WHERE account_id = $1 AND wallet_address <> '' AND status = 'active' AND role = 'user'
        ORDER BY priority ASC, updated_at DESC, wallet_address ASC
        LIMIT 1
     )
     SELECT e.account_id, w.wallet_address, e.personal_completed_count, e.network_completed_count, e.last_completed_at
       FROM eligible_account e
       JOIN active_wallet w ON true
      WHERE (e.personal_completed_count > $3 OR e.network_completed_count >= $4)
        AND NOT EXISTS (
          SELECT 1 FROM profile_nft_daily_awards award
           WHERE award.account_id = e.account_id AND award.run_date = $2::date
        )`,
    [normalizedAccountId, normalizedRunDate, safePersonalTaskThreshold, safeNetworkTaskThreshold]
  );
  const row = result.rows[0];
  if (!row) return null;
  const candidate = {
    accountId: row.account_id,
    walletAddress: row.wallet_address,
    personalCompletedCount: Number(row.personal_completed_count || 0),
    networkCompletedCount: Number(row.network_completed_count || 0),
    lastCompletedAt: toIso(row.last_completed_at),
    runDate: normalizedRunDate,
    existingStateProof: "no_award_row",
  };
  return { ...candidate, eligibilityReason: eligibilityReason(candidate) };
}

export async function countDailyProfileNftAwardSlots({ slots = [] } = {}) {
  const normalizedSlots = slots.map((slot) => ({
    accountId: safeText(slot.accountId, 180),
    runDate: dateOnly(slot.runDate),
  }));
  if (!normalizedSlots.length) return 0;
  if (!databaseEnabled()) {
    return normalizedSlots.filter((slot) => [...runtimeAwards.values()].some((award) => award.accountId === slot.accountId && award.runDate === slot.runDate)).length;
  }
  const result = await query(
    `SELECT count(*)::integer AS count
       FROM profile_nft_daily_awards award
       JOIN jsonb_to_recordset($1::jsonb) AS slot(account_id text, run_date date)
         ON slot.account_id = award.account_id AND slot.run_date = award.run_date`,
    [JSON.stringify(normalizedSlots.map((slot) => ({ account_id: slot.accountId, run_date: slot.runDate })))]
  );
  return Number(result.rows[0]?.count || 0);
}

export async function recordDailyProfileNftBackfillSkippedSlots({
  slots = [],
  manifestHash = "",
  mode = "profile_nft_daily_backfill_v1",
  reason = "Historical Daily Profile NFT slot intentionally skipped after approved one-slot backfill.",
} = {}) {
  const normalizedSlots = slots.map((slot) => ({
    id: safeText(slot.id || `daily_nft_${randomUUID()}`, 180),
    runDate: dateOnly(slot.runDate),
    accountId: safeText(slot.accountId, 180),
    walletAddress: safeText(slot.walletAddress, 120),
    personalCompletedCount: Math.max(0, Number(slot.personalCompletedCount || 0)),
    networkCompletedCount: Math.max(0, Number(slot.networkCompletedCount || 0)),
    eligibilityReason: safeText(slot.eligibilityReason, 120),
  }));
  const uniqueKeys = new Set(normalizedSlots.map((slot) => `${slot.accountId}\u0000${slot.runDate}`));
  if (!normalizedSlots.length || uniqueKeys.size !== normalizedSlots.length || normalizedSlots.some((slot) => !slot.accountId || !slot.runDate)) {
    throw new Error("profile_nft_daily_backfill_skip_slots_invalid");
  }
  const normalizedMode = safeText(mode, 120);
  const normalizedReason = safeText(reason, 500);
  const normalizedManifestHash = safeText(manifestHash, 64);
  if (!/^[a-f0-9]{64}$/.test(normalizedManifestHash)) throw new Error("profile_nft_daily_backfill_manifest_hash_invalid");
  if (!databaseEnabled()) {
    for (const slot of normalizedSlots) {
      const existing = [...runtimeAwards.values()].find((award) => award.accountId === slot.accountId && award.runDate === slot.runDate);
      if (existing) throw new Error("profile_nft_daily_backfill_skip_before_image_changed");
    }
    const completedAt = new Date().toISOString();
    for (const slot of normalizedSlots) {
      runtimeAwards.set(slot.id, normalizeAward({ ...slot, status: "skipped", error: normalizedReason, eligibilityJson: { mode: normalizedMode, auditReason: normalizedReason, manifestHash: normalizedManifestHash }, completedAt, createdAt: completedAt, updatedAt: completedAt }));
    }
    return { skippedCount: normalizedSlots.length };
  }
  return transaction(async (client) => {
    const before = await client.query(
      `SELECT award.account_id, award.run_date
         FROM profile_nft_daily_awards award
         JOIN jsonb_to_recordset($1::jsonb) AS slot(account_id text, run_date date)
           ON slot.account_id = award.account_id AND slot.run_date = award.run_date
        FOR UPDATE`,
      [JSON.stringify(normalizedSlots.map((slot) => ({ account_id: slot.accountId, run_date: slot.runDate })))]
    );
    if (before.rowCount) throw new Error("profile_nft_daily_backfill_skip_before_image_changed");
    const inserted = await client.query(
      `INSERT INTO profile_nft_daily_awards (
         id, run_date, account_id, wallet_address, status, eligibility_reason,
         personal_completed_count, network_completed_count, eligibility_json, error, completed_at
       )
       SELECT slot.id, slot.run_date::date, slot.account_id, slot.wallet_address, 'skipped',
              slot.eligibility_reason, slot.personal_completed_count, slot.network_completed_count,
              jsonb_build_object('mode', $2, 'auditReason', $3, 'manifestHash', $4), $3, now()
         FROM jsonb_to_recordset($1::jsonb) AS slot(
           id text, run_date text, account_id text, wallet_address text,
           personal_completed_count integer, network_completed_count integer, eligibility_reason text
         )
       RETURNING id`,
      [JSON.stringify(normalizedSlots.map((slot) => ({ id: slot.id, run_date: slot.runDate, account_id: slot.accountId, wallet_address: slot.walletAddress, personal_completed_count: slot.personalCompletedCount, network_completed_count: slot.networkCompletedCount, eligibility_reason: slot.eligibilityReason }))), normalizedMode, normalizedReason, normalizedManifestHash]
    );
    if (inserted.rowCount !== normalizedSlots.length) throw new Error("profile_nft_daily_backfill_skip_count_mismatch");
    return { skippedCount: inserted.rowCount };
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
        status: "retry_wait",
        error: normalizedError,
        errorCode: "profile_nft_daily_stale_running",
        retryable: true,
        nextAttemptAt: now.toISOString(),
        completedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }));
      failedCount += 1;
    }
    return { failedCount };
  }

  const result = await query(
    `UPDATE profile_nft_daily_awards
        SET status = 'retry_wait',
            error = $2,
            error_code = 'profile_nft_daily_stale_running',
            retryable = true,
            next_attempt_at = now(),
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
            errorCode: "",
            retryable: false,
            nextAttemptAt: null,
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
            error_code = '',
            retryable = false,
            next_attempt_at = NULL,
            started_at = now(),
            updated_at = now()
      WHERE id = $1
        AND status IN ('pending', 'retry_wait')
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

export async function markDailyProfileNftAwardFailed({
  awardId = "",
  error = "",
  errorCode = "profile_nft_daily_generation_failed",
  retryable = true,
  maxAttempts = 3,
  retryDelayMs = 60_000,
} = {}) {
  const normalizedAwardId = safeText(awardId, 180);
  if (!normalizedAwardId) return null;
  const completedAt = new Date().toISOString();
  const safeMaxAttempts = Math.min(Math.max(Number(maxAttempts) || 3, 1), 20);
  const safeDelayMs = Math.min(Math.max(Number(retryDelayMs) || 60_000, 1000), 24 * 60 * 60 * 1000);

  if (!databaseEnabled()) {
    const award = runtimeAwards.get(normalizedAwardId);
    if (!award) return null;
    const next = normalizeAward({
      ...award,
      status: !retryable || Number(award.attemptCount || 0) >= safeMaxAttempts ? "failed_permanent" : "retry_wait",
      error: safeText(error, 500),
      errorCode: safeText(errorCode, 160),
      retryable: retryable && Number(award.attemptCount || 0) < safeMaxAttempts,
      nextAttemptAt: retryable && Number(award.attemptCount || 0) < safeMaxAttempts ? new Date(Date.now() + safeDelayMs).toISOString() : null,
      completedAt,
      updatedAt: completedAt,
    });
    runtimeAwards.set(normalizedAwardId, next);
    return next;
  }

  const result = await query(
    `UPDATE profile_nft_daily_awards
        SET status = CASE
              WHEN $4::boolean = false THEN 'failed_permanent'
              WHEN attempt_count >= $5::integer THEN 'failed_permanent'
              ELSE 'retry_wait'
            END,
            error = $2,
            error_code = $3,
            retryable = $4::boolean AND attempt_count < $5::integer,
            next_attempt_at = CASE WHEN $4::boolean AND attempt_count < $5::integer THEN now() + ($6::text || ' milliseconds')::interval ELSE NULL END,
            completed_at = CASE WHEN $4::boolean AND attempt_count < $5::integer THEN NULL ELSE now() END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [normalizedAwardId, safeText(error, 500), safeText(errorCode, 160), retryable === true, safeMaxAttempts, String(safeDelayMs)]
  );
  return result.rows[0] ? normalizeAward(result.rows[0]) : null;
}

function normalizeHeartbeat(row = {}) {
  return {
    workerKey: row.worker_key || row.workerKey || WORKER_KEY,
    enabled: Boolean(row.enabled), generationGated: Boolean(row.generation_gated ?? row.generationGated), dryRun: Boolean(row.dry_run ?? row.dryRun),
    lastTickStartedAt: toIso(row.last_tick_started_at || row.lastTickStartedAt), lastTickFinishedAt: toIso(row.last_tick_finished_at || row.lastTickFinishedAt), lastSuccessAt: toIso(row.last_success_at || row.lastSuccessAt),
    lastErrorCode: row.last_error_code || row.lastErrorCode || "", lastErrorMessage: row.last_error_message || row.lastErrorMessage || "",
    retryableCount: Number(row.retryable_count || row.retryableCount || 0), permanentCount: Number(row.permanent_count || row.permanentCount || 0),
    currentRetryAwardId: row.current_retry_award_id || row.currentRetryAwardId || "", nextRetryAt: toIso(row.next_retry_at || row.nextRetryAt), candidateCount: Number(row.candidate_count || row.candidateCount || 0),
  };
}

export async function upsertDailyProfileNftWorkerHeartbeat(values = {}) {
  const next = normalizeHeartbeat({ ...values, workerKey: WORKER_KEY });
  if (!databaseEnabled()) {
    const previous = runtimeHeartbeats.get(WORKER_KEY);
    const merged = normalizeHeartbeat({ ...previous, ...next, lastSuccessAt: next.lastSuccessAt || previous?.lastSuccessAt || null });
    runtimeHeartbeats.set(WORKER_KEY, merged);
    return merged;
  }
  const result = await query(`INSERT INTO profile_nft_daily_worker_heartbeats (worker_key, enabled, generation_gated, dry_run, last_tick_started_at, last_tick_finished_at, last_success_at, last_error_code, last_error_message, retryable_count, permanent_count, current_retry_award_id, next_retry_at, candidate_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (worker_key) DO UPDATE SET enabled=EXCLUDED.enabled, generation_gated=EXCLUDED.generation_gated, dry_run=EXCLUDED.dry_run, last_tick_started_at=COALESCE(EXCLUDED.last_tick_started_at,profile_nft_daily_worker_heartbeats.last_tick_started_at), last_tick_finished_at=EXCLUDED.last_tick_finished_at, last_success_at=COALESCE(EXCLUDED.last_success_at,profile_nft_daily_worker_heartbeats.last_success_at), last_error_code=EXCLUDED.last_error_code, last_error_message=EXCLUDED.last_error_message, retryable_count=EXCLUDED.retryable_count, permanent_count=EXCLUDED.permanent_count, current_retry_award_id=EXCLUDED.current_retry_award_id, next_retry_at=EXCLUDED.next_retry_at, candidate_count=EXCLUDED.candidate_count, updated_at=now() RETURNING *`,
    [WORKER_KEY,next.enabled,next.generationGated,next.dryRun,next.lastTickStartedAt,next.lastTickFinishedAt,next.lastSuccessAt,next.lastErrorCode,next.lastErrorMessage,next.retryableCount,next.permanentCount,next.currentRetryAwardId,next.nextRetryAt,next.candidateCount]);
  return normalizeHeartbeat(result.rows[0]);
}

export async function getDailyProfileNftWorkerHeartbeat() {
  if (!databaseEnabled()) return runtimeHeartbeats.get(WORKER_KEY) || null;
  const result = await query("SELECT * FROM profile_nft_daily_worker_heartbeats WHERE worker_key = $1", [WORKER_KEY]);
  return result.rows[0] ? normalizeHeartbeat(result.rows[0]) : null;
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
