import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";

export const IPFS_REPLICATION_RETRYABLE_STATUSES = ["queued", "retry_wait"];

function safeText(value = "", max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function jobFromRow(row = {}) {
  return {
    id: row.id,
    cid: row.cid,
    payloadClass: row.payload_class,
    source: row.source,
    sourceRef: row.source_ref,
    exactCidRequired: row.exact_cid_required,
    status: row.status,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || "",
    metadata: row.metadata_json || {},
    firstSeenAt: row.first_seen_at,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    claimedBy: row.claimed_by || "",
    claimedAt: row.claimed_at,
    verifiedGateway: row.verified_gateway || "",
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function enqueueIpfsReplicationJob({
  cid,
  payloadClass = "unknown",
  source = "",
  sourceRef = "",
  exactCidRequired = true,
  metadata = {},
} = {}) {
  const normalizedCid = safeText(cid, 240);
  if (!normalizedCid) return { ok: false, skipped: true, reason: "cid_missing" };
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };

  const result = await query(
    `
      INSERT INTO ipfs_replication_jobs (
        id,
        cid,
        payload_class,
        source,
        source_ref,
        exact_cid_required,
        status,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb)
      ON CONFLICT (cid, payload_class, source, source_ref)
      DO UPDATE SET
        metadata_json = ipfs_replication_jobs.metadata_json || EXCLUDED.metadata_json,
        next_attempt_at = CASE
          WHEN ipfs_replication_jobs.status IN ('retry_wait', 'failed') THEN now()
          ELSE ipfs_replication_jobs.next_attempt_at
        END,
        status = CASE
          WHEN ipfs_replication_jobs.status IN ('retry_wait', 'failed') THEN 'queued'
          ELSE ipfs_replication_jobs.status
        END,
        updated_at = now()
      RETURNING *
    `,
    [
      `ipfsjob_${randomUUID()}`,
      normalizedCid,
      safeText(payloadClass, 120) || "unknown",
      safeText(source, 160),
      safeText(sourceRef, 240),
      exactCidRequired !== false,
      JSON.stringify(safeObject(metadata)),
    ]
  );

  return { ok: true, job: jobFromRow(result.rows[0]) };
}

export async function claimIpfsReplicationJobs({
  workerId = `ipfs_worker_${process.pid}`,
  limit = 10,
  staleClaimMs = 5 * 60 * 1000,
  sourceRefPrefix = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured", jobs: [] };
  const boundedLimit = clampInteger(limit, 10, 1, 100);
  const staleMs = clampInteger(staleClaimMs, 5 * 60 * 1000, 30_000, 3_600_000);
  const result = await query(
    `
      UPDATE ipfs_replication_jobs
      SET
        status = 'pinning',
        claimed_by = $1,
        claimed_at = now(),
        last_attempt_at = now(),
        attempts = attempts + 1,
        updated_at = now()
      WHERE id IN (
        SELECT id
        FROM ipfs_replication_jobs
        WHERE
          (
            (
              status IN ('queued', 'retry_wait')
              AND next_attempt_at <= now()
              AND (
                claimed_at IS NULL
                OR claimed_at < now() - ($2::text || ' milliseconds')::interval
              )
            )
            OR (
              status = 'pinning'
              AND claimed_at < now() - ($2::text || ' milliseconds')::interval
            )
          )
          AND (
            $4::text = ''
            OR source_ref LIKE ($4::text || '%')
          )
        ORDER BY first_seen_at ASC, id ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `,
    [safeText(workerId, 160), String(staleMs), boundedLimit, safeText(sourceRefPrefix, 240)]
  );
  return { ok: true, jobs: result.rows.map(jobFromRow) };
}

export async function markIpfsReplicationJobVerified({
  id,
  verifiedGateway,
  status = "verified",
  metadata = {},
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const result = await query(
    `
      UPDATE ipfs_replication_jobs
      SET
        status = $2,
        verified_gateway = $3,
        verified_at = now(),
        last_error = '',
        claimed_by = '',
        claimed_at = NULL,
        metadata_json = metadata_json || $4::jsonb,
        updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      safeText(id, 160),
      status === "first_party_pinned" ? "first_party_pinned" : "verified",
      safeText(verifiedGateway, 500),
      JSON.stringify(safeObject(metadata)),
    ]
  );
  return { ok: Boolean(result.rows[0]), job: result.rows[0] ? jobFromRow(result.rows[0]) : null };
}

export async function markIpfsReplicationJobFailed({
  id,
  error,
  retry = true,
  retryDelayMs,
  maxAttempts = 10,
  metadata = {},
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const delayMs = clampInteger(retryDelayMs, 60_000, 1_000, 24 * 60 * 60 * 1000);
  const boundedMax = clampInteger(maxAttempts, 10, 1, 100);
  const result = await query(
    `
      UPDATE ipfs_replication_jobs
      SET
        status = CASE
          WHEN $3::boolean = false THEN 'failed'
          WHEN attempts >= $4::integer THEN 'exception_required'
          ELSE 'retry_wait'
        END,
        last_error = $2,
        next_attempt_at = CASE
          WHEN $3::boolean = false OR attempts >= $4::integer THEN next_attempt_at
          ELSE now() + ($5::text || ' milliseconds')::interval
        END,
        claimed_by = '',
        claimed_at = NULL,
        metadata_json = metadata_json || $6::jsonb,
        updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      safeText(id, 160),
      safeText(error, 1000),
      retry !== false,
      boundedMax,
      String(delayMs),
      JSON.stringify(safeObject(metadata)),
    ]
  );
  return { ok: Boolean(result.rows[0]), job: result.rows[0] ? jobFromRow(result.rows[0]) : null };
}

export async function releaseIpfsReplicationJob({ id, status = "queued" } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const safeStatus = ["queued", "retry_wait", "failed"].includes(status) ? status : "queued";
  const result = await query(
    `
      UPDATE ipfs_replication_jobs
      SET status = $2, claimed_by = '', claimed_at = NULL, updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [safeText(id, 160), safeStatus]
  );
  return { ok: Boolean(result.rows[0]), job: result.rows[0] ? jobFromRow(result.rows[0]) : null };
}

export async function ipfsReplicationFreshWriteSummary({
  lookbackHours = 24,
  staleSeconds = 60,
  limit = 100,
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const hours = clampInteger(lookbackHours, 24, 1, 24 * 30);
  const stale = clampInteger(staleSeconds, 60, 1, 24 * 60 * 60);
  const boundedLimit = clampInteger(limit, 100, 1, 500);
  const [counts, oldest, samples] = await Promise.all([
    query(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'verified')::int AS verified,
          COUNT(*) FILTER (WHERE status IN ('queued', 'pinning', 'first_party_pinned', 'retry_wait'))::int AS pending,
          COUNT(*) FILTER (WHERE status IN ('failed', 'exception_required'))::int AS failed,
          COUNT(*) FILTER (
            WHERE status <> 'verified'
              AND first_seen_at < now() - ($2::text || ' seconds')::interval
          )::int AS stale
        FROM ipfs_replication_jobs
        WHERE first_seen_at >= now() - ($1::text || ' hours')::interval
      `,
      [String(hours), String(stale)]
    ),
    query(
      `
        SELECT MIN(first_seen_at) AS oldest_unverified_at
        FROM ipfs_replication_jobs
        WHERE
          status <> 'verified'
          AND first_seen_at >= now() - ($1::text || ' hours')::interval
      `,
      [String(hours)]
    ),
    query(
      `
        SELECT *
        FROM ipfs_replication_jobs
        WHERE
          status <> 'verified'
          AND first_seen_at >= now() - ($1::text || ' hours')::interval
        ORDER BY first_seen_at ASC, id ASC
        LIMIT $2
      `,
      [String(hours), boundedLimit]
    ),
  ]);
  const row = counts.rows[0] || {};
  return {
    ok: true,
    lookbackHours: hours,
    staleSeconds: stale,
    total: Number(row.total || 0),
    verified: Number(row.verified || 0),
    pending: Number(row.pending || 0),
    failed: Number(row.failed || 0),
    stale: Number(row.stale || 0),
    oldestUnverifiedAt: oldest.rows[0]?.oldest_unverified_at || null,
    unverifiedSamples: samples.rows.map(jobFromRow),
  };
}

export async function deleteIpfsReplicationJobsForTest({ sourceRefPrefix = "" } = {}) {
  const prefix = safeText(sourceRefPrefix, 240);
  if (!prefix || !databaseEnabled()) return { ok: false, deleted: 0 };
  const result = await query(
    "DELETE FROM ipfs_replication_jobs WHERE source_ref LIKE $1 RETURNING id",
    [`${prefix}%`]
  );
  return { ok: true, deleted: result.rowCount || 0 };
}

export async function withIpfsReplicationTransaction(work) {
  return transaction(work);
}
