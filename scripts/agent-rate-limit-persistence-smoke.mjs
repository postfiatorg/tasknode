#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const {
  checkAgentRateLimitBucket,
  resetAgentRateLimitBucketsForTests,
} = await import("../server/repositories/agent-rate-limits.js");

function fakeAgentRateLimitQuery() {
  const rows = new Map();
  return async (sql, params = []) => {
    assert.match(sql, /INSERT INTO agent_rate_limit_buckets/);
    assert.match(sql, /ON CONFLICT \(bucket_key\) DO UPDATE/);
    const [bucketKey, action, agentKey, limit, windowMs, nowIso] = params;
    const now = Date.parse(nowIso);
    const existing = rows.get(bucketKey);
    let requestCount = 1;
    let resetAt = now + windowMs;
    if (existing && existing.resetAt > now) {
      requestCount = Math.min(existing.requestCount + 1, limit + 1);
      resetAt = existing.resetAt;
    }
    rows.set(bucketKey, {
      bucketKey,
      action,
      agentKey,
      requestCount,
      resetAt,
      limit,
      windowMs,
    });
    return {
      rows: [{
        request_count: requestCount,
        limit_count: limit,
        window_ms: windowMs,
        reset_at: new Date(resetAt).toISOString(),
      }],
    };
  };
}

const queryImpl = fakeAgentRateLimitQuery();
const now = Date.parse("2026-06-19T20:00:00.000Z");
const firstDb = await checkAgentRateLimitBucket({
  action: "task_request",
  agentKey: "acct_grashnuk",
  limit: 1,
  windowMs: 60_000,
  now,
  databaseReady: true,
  queryImpl,
});
assert.equal(firstDb.ok, true);
assert.equal(firstDb.storage, "postgres");

resetAgentRateLimitBucketsForTests();
const secondDb = await checkAgentRateLimitBucket({
  action: "task_request",
  agentKey: "acct_grashnuk",
  limit: 1,
  windowMs: 60_000,
  now: now + 1000,
  databaseReady: true,
  queryImpl,
});
assert.equal(secondDb.ok, false);
assert.equal(secondDb.storage, "postgres");
assert.equal(secondDb.error, "agent_action_rate_limited");
assert.equal(secondDb.retryAfterSeconds, 59);

const otherAction = await checkAgentRateLimitBucket({
  action: "hive_chat",
  agentKey: "acct_grashnuk",
  limit: 1,
  windowMs: 60_000,
  now: now + 1000,
  databaseReady: true,
  queryImpl,
});
assert.equal(otherAction.ok, true, "different actions must use independent persistent buckets");

resetAgentRateLimitBucketsForTests();
const firstMemory = await checkAgentRateLimitBucket({
  action: "task_submission",
  agentKey: "agent_memory",
  limit: 1,
  windowMs: 60_000,
  now,
  databaseReady: false,
});
const secondMemory = await checkAgentRateLimitBucket({
  action: "task_submission",
  agentKey: "agent_memory",
  limit: 1,
  windowMs: 60_000,
  now: now + 1000,
  databaseReady: false,
});
assert.equal(firstMemory.storage, "memory");
assert.equal(firstMemory.ok, true);
assert.equal(secondMemory.storage, "memory");
assert.equal(secondMemory.ok, false);

console.log("agent rate limit persistence smoke ok");
