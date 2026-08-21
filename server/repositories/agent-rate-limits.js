import { databaseEnabled, query } from "../db/pool.js";

const memoryBuckets = new Map();
const maxMemoryBuckets = 10_000;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeLimit(value = 1) {
  const parsed = Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.round(parsed) : 1, 1), 100);
}

function safeWindowMs(value = 60_000) {
  const parsed = Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.round(parsed) : 60_000, 1000), 24 * 60 * 60 * 1000);
}

function pruneMemoryBuckets(now) {
  if (memoryBuckets.size <= maxMemoryBuckets) return;
  for (const [key, bucket] of memoryBuckets.entries()) {
    if (bucket.resetAt <= now) memoryBuckets.delete(key);
    if (memoryBuckets.size <= Math.floor(maxMemoryBuckets * 0.8)) break;
  }
}

function memoryRateLimit({ bucketKey, limit, windowMs, now }) {
  pruneMemoryBuckets(now);
  const existing = memoryBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowMs };
    memoryBuckets.set(bucketKey, next);
    return {
      ok: true,
      storage: "memory",
      remaining: limit - 1,
      resetAt: next.resetAt,
      limit,
      windowMs,
    };
  }
  existing.count = Math.min(existing.count + 1, limit + 1);
  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  return {
    ok: existing.count <= limit,
    storage: "memory",
    error: existing.count <= limit ? "" : "agent_action_rate_limited",
    remaining: Math.max(0, limit - existing.count),
    retryAfterSeconds,
    limit,
    windowMs,
    resetAt: existing.resetAt,
  };
}

export function resetAgentRateLimitBucketsForTests() {
  memoryBuckets.clear();
}

export function agentRateLimitBucketKey({ action = "", agentKey = "" } = {}) {
  const normalizedAction = safeText(action || "agent_action", 80) || "agent_action";
  const normalizedAgentKey = safeText(agentKey || "unknown_agent", 180) || "unknown_agent";
  return `${normalizedAction}:${normalizedAgentKey}`.slice(0, 300);
}

export async function checkAgentRateLimitBucket({
  action = "",
  agentKey = "",
  limit = 1,
  windowMs = 60_000,
  now = Date.now(),
  databaseReady = databaseEnabled(),
  queryImpl = query,
} = {}) {
  const normalizedAction = safeText(action || "agent_action", 80) || "agent_action";
  const normalizedAgentKey = safeText(agentKey || "unknown_agent", 180) || "unknown_agent";
  const normalizedLimit = safeLimit(limit);
  const normalizedWindowMs = safeWindowMs(windowMs);
  const bucketKey = agentRateLimitBucketKey({ action: normalizedAction, agentKey: normalizedAgentKey });
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();

  if (!databaseReady) {
    return memoryRateLimit({
      bucketKey,
      limit: normalizedLimit,
      windowMs: normalizedWindowMs,
      now: nowMs,
    });
  }

  const nowIso = new Date(nowMs).toISOString();
  const result = await queryImpl(
    `
      INSERT INTO agent_rate_limit_buckets (
        bucket_key,
        action,
        agent_key,
        request_count,
        limit_count,
        window_ms,
        reset_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        1,
        $4,
        $5::integer,
        $6::timestamptz + ($5::integer::double precision * interval '1 millisecond'),
        $6::timestamptz
      )
      ON CONFLICT (bucket_key) DO UPDATE SET
        action = EXCLUDED.action,
        agent_key = EXCLUDED.agent_key,
        request_count = CASE
          WHEN agent_rate_limit_buckets.reset_at <= $6::timestamptz THEN 1
          ELSE LEAST(agent_rate_limit_buckets.request_count + 1, EXCLUDED.limit_count + 1)
        END,
        limit_count = EXCLUDED.limit_count,
        window_ms = EXCLUDED.window_ms,
        reset_at = CASE
          WHEN agent_rate_limit_buckets.reset_at <= $6::timestamptz THEN EXCLUDED.reset_at
          ELSE agent_rate_limit_buckets.reset_at
        END,
        updated_at = $6::timestamptz
      RETURNING request_count, limit_count, window_ms, reset_at
    `,
    [bucketKey, normalizedAction, normalizedAgentKey, normalizedLimit, normalizedWindowMs, nowIso]
  );
  const row = result.rows[0] || {};
  const requestCount = Math.max(0, Number(row.request_count || 0));
  const resetAtMs = Date.parse(row.reset_at || "") || nowMs + normalizedWindowMs;
  const ok = requestCount <= normalizedLimit;
  return {
    ok,
    storage: "postgres",
    error: ok ? "" : "agent_action_rate_limited",
    remaining: Math.max(0, normalizedLimit - requestCount),
    retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
    limit: Number(row.limit_count || normalizedLimit),
    windowMs: Number(row.window_ms || normalizedWindowMs),
    resetAt: resetAtMs,
  };
}
