import assert from "node:assert/strict";
import {
  __appStateCacheStatsForTests,
  __resetAppStateCacheForTests,
  __setAppStateComputeForTests,
  getCachedAppState,
} from "../server/app-state.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appStateFixture({
  accountId = "acct_cache_smoke",
  signedOut = false,
  generatedAt = new Date().toISOString(),
  walletAddress = null,
} = {}) {
  return {
    generatedAt,
    session: {
      status: signedOut ? "signed_out" : "signed_in",
      accountId: signedOut ? undefined : accountId,
      walletLink: {
        status: walletAddress ? "linked" : "not_linked",
        address: walletAddress,
      },
    },
    chat: {
      recents: [],
      hiveConversation: null,
      seedMessages: [],
    },
    tasks: {
      outstanding: [],
      verification: [],
      rewarded: [],
      refused: [],
      requests: { items: [] },
      sync: {
        forceProjectionRefresh: false,
      },
    },
    wallet: {
      pftWallet: {
        status: walletAddress ? "linked" : "not_linked",
        address: walletAddress,
      },
      ethereumDeposit: null,
    },
    usage: {},
    context: {
      document: { accountId: null },
      history: { accountId: null, walletAddress: null },
    },
  };
}

async function runSameAccountDedupeCheck() {
  __resetAppStateCacheForTests();
  process.env.APP_STATE_CACHE_TTL_MS = "1000";
  process.env.APP_STATE_MAX_CONCURRENT = "1";

  let computeCount = 0;
  __setAppStateComputeForTests(async (session) => {
    computeCount += 1;
    await delay(20);
    return appStateFixture({
      accountId: session.accountId,
      generatedAt: `compute_${computeCount}`,
    });
  });

  const session = { accountId: "acct_dedupe" };
  const results = await Promise.all(
    Array.from({ length: 40 }, () => getCachedAppState(session))
  );
  assert.equal(computeCount, 1, "same-account cold burst should dedupe to one compute");
  assert.equal(new Set(results.map((state) => state.generatedAt)).size, 1);

  await Promise.all(Array.from({ length: 40 }, () => getCachedAppState(session)));
  assert.equal(computeCount, 1, "fresh cache hits should not compute");
}

async function runCapFallbackCheck() {
  __resetAppStateCacheForTests();
  process.env.APP_STATE_CACHE_TTL_MS = "1";
  process.env.APP_STATE_MAX_CONCURRENT = "1";

  __setAppStateComputeForTests(async (session) => appStateFixture({
    accountId: session.accountId,
    generatedAt: "seeded",
  }));
  const session = { accountId: "acct_stale" };
  await getCachedAppState(session);
  await delay(5);

  let releaseSlowCompute;
  const slowCompute = new Promise((resolve) => {
    releaseSlowCompute = resolve;
  });
  let staleRefreshCount = 0;
  __setAppStateComputeForTests(async (nextSession) => {
    if (nextSession.accountId === "acct_slow") {
      await slowCompute;
      return appStateFixture({ accountId: nextSession.accountId, generatedAt: "slow" });
    }
    staleRefreshCount += 1;
    return appStateFixture({ accountId: nextSession.accountId, generatedAt: "refreshed" });
  });

  const slowPromise = getCachedAppState({ accountId: "acct_slow" });
  await delay(1);
  assert.equal(__appStateCacheStatsForTests().gate.activeComputes, 1);

  const stale = await getCachedAppState(session);
  assert.equal(stale.generatedAt, "seeded");
  assert.equal(stale.refreshing, true);
  assert.equal(staleRefreshCount, 0, "stale refresh should not queue while cap is full");

  releaseSlowCompute();
  await slowPromise;
}

async function runAnonSafetyCheck() {
  __resetAppStateCacheForTests();
  process.env.APP_STATE_CACHE_TTL_MS = "1000";
  process.env.APP_STATE_MAX_CONCURRENT = "1";

  let safeAnonComputes = 0;
  __setAppStateComputeForTests(async () => {
    safeAnonComputes += 1;
    return appStateFixture({ signedOut: true, generatedAt: `safe_${safeAnonComputes}` });
  });
  await getCachedAppState(null);
  await getCachedAppState(null);
  assert.equal(safeAnonComputes, 1, "safe signed-out payload should cache");

  __resetAppStateCacheForTests();
  let unsafeAnonComputes = 0;
  __setAppStateComputeForTests(async () => {
    unsafeAnonComputes += 1;
    return appStateFixture({
      signedOut: true,
      generatedAt: `unsafe_${unsafeAnonComputes}`,
      walletAddress: "rUnsafeAnonWallet",
    });
  });
  await getCachedAppState(null);
  await getCachedAppState(null);
  assert.equal(unsafeAnonComputes, 2, "unsafe signed-out payload should skip cache");
}

await runSameAccountDedupeCheck();
await runCapFallbackCheck();
await runAnonSafetyCheck();
__resetAppStateCacheForTests();

console.log("app-state cache gate smoke ok");
