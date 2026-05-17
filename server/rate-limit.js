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
