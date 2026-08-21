import { createHash } from "node:crypto";
import { databaseEnabled, query } from "./db/pool.js";

const buckets = new Map();
const defaultWindowMs = 60_000;
const defaultLimit = 60;
const maxBuckets = 10_000;

function nowMs() {
  return Date.now();
}

function pruneBuckets(now) {
  if (buckets.size <= maxBuckets) return;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
    if (buckets.size <= Math.floor(maxBuckets * 0.8)) break;
  }
}

export function checkRateLimit({
  key,
  limit = defaultLimit,
  windowMs = defaultWindowMs,
  now = nowMs(),
} = {}) {
  const safeKey = String(key || "global").slice(0, 300);
  const safeLimit = Math.max(1, Number(limit || defaultLimit));
  const safeWindowMs = Math.max(1000, Number(windowMs || defaultWindowMs));
  pruneBuckets(now);

  const existing = buckets.get(safeKey);
  if (!existing || existing.resetAt <= now) {
    const next = {
      count: 1,
      resetAt: now + safeWindowMs,
    };
    buckets.set(safeKey, next);
    return {
      allowed: true,
      limit: safeLimit,
      remaining: safeLimit - 1,
      resetAt: next.resetAt,
      retryAfterSeconds: 0,
    };
  }

  existing.count += 1;
  const remaining = Math.max(0, safeLimit - existing.count);
  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  return {
    allowed: existing.count <= safeLimit,
    limit: safeLimit,
    remaining,
    resetAt: existing.resetAt,
    retryAfterSeconds,
  };
}

export function resetRateLimitsForTests() {
  buckets.clear();
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.round(parsed) : fallback, min), max);
}

function isProduction(env = process.env) {
  return String(env.TASKNODE_ENV || env.NODE_ENV || "").trim().toLowerCase() === "production";
}

export function sharedRateLimitConfigured(env = process.env) {
  if (env.TASKNODE_POSTGRES_DISABLED === "true" || env.TASKNODE_DATABASE_DISABLED === "true") return false;
  return Boolean(String(env.DATABASE_URL || "").trim()) && (
    env.TASKNODE_DATABASE_ENABLED === "true" || env.TASKNODE_POSTGRES_ENABLED === "true"
  );
}

export function sharedRateLimitStartupIssues(env = process.env) {
  if (!isProduction(env)) return [];
  return sharedRateLimitConfigured(env) ? [] : [{
    code: "shared_rate_limit_store_required",
    detail: "Production API abuse controls require an enabled PostgreSQL store.",
  }];
}

export async function checkRouteRateLimit({
  key,
  route = "api",
  limit = defaultLimit,
  windowMs = defaultWindowMs,
  now = nowMs(),
  env = process.env,
  databaseReady = databaseEnabled(),
  queryImpl = query,
} = {}) {
  const safeKey = String(key || "global").slice(0, 1000);
  const safeRoute = String(route || "api").trim().slice(0, 120) || "api";
  const safeLimit = boundedNumber(limit, defaultLimit, 1, 10_000);
  const safeWindowMs = boundedNumber(windowMs, defaultWindowMs, 1000, 24 * 60 * 60 * 1000);
  const safeNow = Number.isFinite(Number(now)) ? Number(now) : nowMs();

  if (!databaseReady) {
    if (isProduction(env)) {
      const error = new Error("shared_rate_limit_store_required");
      error.status = 503;
      throw error;
    }
    return { ...checkRateLimit({ key: safeKey, limit: safeLimit, windowMs: safeWindowMs, now: safeNow }), storage: "memory" };
  }

  // Persist only a one-way identifier; raw IP addresses and account IDs do not
  // belong in an abuse-control table.
  const bucketHash = createHash("sha256").update(safeKey).digest("hex");
  const nowIso = new Date(safeNow).toISOString();
  const result = await queryImpl(
    `
      INSERT INTO api_rate_limit_buckets (
        bucket_hash, route_id, request_count, limit_count, window_ms, reset_at, updated_at
      )
      VALUES (
        $1, $2, 1, $3, $4,
        $5::timestamptz + ($4::integer::double precision * interval '1 millisecond'),
        $5::timestamptz
      )
      ON CONFLICT (bucket_hash) DO UPDATE SET
        route_id = EXCLUDED.route_id,
        request_count = CASE
          WHEN api_rate_limit_buckets.reset_at <= $5::timestamptz THEN 1
          ELSE LEAST(api_rate_limit_buckets.request_count + 1, EXCLUDED.limit_count + 1)
        END,
        limit_count = EXCLUDED.limit_count,
        window_ms = EXCLUDED.window_ms,
        reset_at = CASE
          WHEN api_rate_limit_buckets.reset_at <= $5::timestamptz THEN EXCLUDED.reset_at
          ELSE api_rate_limit_buckets.reset_at
        END,
        updated_at = $5::timestamptz
      RETURNING request_count, limit_count, reset_at
    `,
    [bucketHash, safeRoute, safeLimit, safeWindowMs, nowIso]
  );
  const row = result.rows[0] || {};
  const count = Math.max(0, Number(row.request_count || 0));
  const resetAt = Date.parse(row.reset_at || "") || safeNow + safeWindowMs;
  return {
    allowed: count <= safeLimit,
    storage: "postgres",
    limit: Number(row.limit_count || safeLimit),
    remaining: Math.max(0, safeLimit - count),
    resetAt,
    retryAfterSeconds: count <= safeLimit ? 0 : Math.max(1, Math.ceil((resetAt - safeNow) / 1000)),
  };
}
