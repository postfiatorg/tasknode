import assert from "node:assert/strict";
import {
  __hiveRouteCacheStatsForTests,
  __resetHiveRouteCacheForTests,
  getCachedHiveRead,
  hiveReadResponseIsCacheSafe,
} from "../server/hive-route-cache.js";
import {
  __resetRouteObservabilityForTests,
  recordRouteObservation,
} from "../server/route-observability.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cacheDedupeSmoke() {
  __resetHiveRouteCacheForTests();
  process.env.HIVE_ROUTE_CACHE_TTL_MS = "1000";
  let computeCount = 0;
  const compute = async () => {
    computeCount += 1;
    await delay(5);
    return {
      ok: true,
      document: {
        projects: [{ id: "project_smoke" }],
      },
    };
  };
  const results = await Promise.all(
    Array.from({ length: 25 }, () => getCachedHiveRead({
      cacheKey: "hive_projects:test",
      compute,
      isSafe: () => true,
    }))
  );
  assert.equal(computeCount, 1, "cold concurrent reads should dedupe");
  assert.equal(results[0].document.projects[0].id, "project_smoke");
  assert.deepEqual(__hiveRouteCacheStatsForTests().keys, ["hive_projects:test"]);
}

async function staleWhileRevalidateSmoke() {
  __resetHiveRouteCacheForTests();
  process.env.HIVE_ROUTE_CACHE_TTL_MS = "1";
  let computeCount = 0;
  const compute = async () => {
    computeCount += 1;
    await delay(5);
    return { ok: true, value: `value_${computeCount}` };
  };
  const first = await getCachedHiveRead({ cacheKey: "swr", compute, isSafe: () => true });
  assert.equal(first.value, "value_1");
  await delay(5);
  const stale = await getCachedHiveRead({ cacheKey: "swr", compute, isSafe: () => true });
  assert.equal(stale.value, "value_1", "stale read should return immediately");
  await delay(10);
  const refreshed = await getCachedHiveRead({ cacheKey: "swr", compute, isSafe: () => true });
  assert.equal(refreshed.value, "value_2");
}

function hiveSafetySmoke() {
  assert.equal(hiveReadResponseIsCacheSafe({
    pathname: "/api/hive/projects",
    value: { ok: true, document: { projects: [] } },
  }), true);
  assert.equal(hiveReadResponseIsCacheSafe({
    pathname: "/api/hive/context",
    value: { ok: true, boardManager: { logsAvailable: false, messages: [] } },
  }), true);
  assert.equal(hiveReadResponseIsCacheSafe({
    pathname: "/api/hive/context",
    session: { accountId: "account_private" },
    value: { ok: true, boardManager: { logsAvailable: false, messages: [] } },
  }), false);
  assert.equal(hiveReadResponseIsCacheSafe({
    pathname: "/api/hive/context",
    value: { ok: true, boardManager: { logsAvailable: true, messages: [] } },
  }), false);
  assert.equal(hiveReadResponseIsCacheSafe({
    pathname: "/api/hive/context",
    value: { ok: true, boardManager: { logsAvailable: false, messages: [{ id: "private" }] } },
  }), false);
}

function routeObservabilitySmoke() {
  __resetRouteObservabilityForTests();
  process.env.ROUTE_OBSERVABILITY_MIN_SAMPLES = "3";
  const originalInfo = console.info;
  const summaries = [];
  console.info = (event, payload) => {
    if (event === "route_observability_summary") summaries.push(payload);
  };
  try {
    recordRouteObservation({
      method: "GET",
      pathname: "/api/app-state",
      authState: "anon",
      statusCode: 200,
      durationMs: 20,
    });
    recordRouteObservation({
      method: "GET",
      pathname: "/api/app-state",
      authState: "anon",
      statusCode: 200,
      durationMs: 40,
    });
    recordRouteObservation({
      method: "GET",
      pathname: "/api/app-state",
      authState: "anon",
      statusCode: 500,
      durationMs: 60,
    });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].count, 3);
  assert.equal(summaries[0].p50Ms, 40);
  assert.equal(summaries[0].p95Ms, 60);
  assert.equal(summaries[0].errorCount, 1);
  assert.equal(summaries[0].dbPool.max > 0, true);
}

await cacheDedupeSmoke();
await staleWhileRevalidateSmoke();
hiveSafetySmoke();
routeObservabilitySmoke();

console.log("hive route cache observability smoke ok");
