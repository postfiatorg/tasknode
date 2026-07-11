import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";

const {
  buildDailyProfileNftGenerationPayload,
  runDailyProfileNftWorkerOnce,
} = await import("../server/profile-nft-daily-worker.js");
const {
  createDailyProfileNftAward,
  markDailyProfileNftAwardFailed,
  markDailyProfileNftAwardGenerated,
  markDailyProfileNftAwardRunning,
} = await import("../server/repositories/profile-nft-daily-awards.js");

const runDate = "2026-06-30";
const candidates = [
  {
    accountId: "acct_daily_nft_personal",
    walletAddress: "rDailyNftPersonal111111111111111111",
    personalCompletedCount: 4,
    networkCompletedCount: 0,
    eligibilityReason: "personal_task_threshold",
    lastCompletedAt: "2026-06-30T08:00:00.000Z",
  },
  {
    accountId: "acct_daily_nft_network",
    walletAddress: "rDailyNftNetwork1111111111111111111",
    personalCompletedCount: 0,
    networkCompletedCount: 1,
    eligibilityReason: "network_task_completed",
    lastCompletedAt: "2026-06-30T09:00:00.000Z",
  },
];

const payload = buildDailyProfileNftGenerationPayload({ candidate: candidates[0], runDate });
assert.match(payload.contextDocument, /Completed personal tasks: 4/);
assert.match(payload.contextDocument, /Completed Network Tasks: 0/);
assert.equal(JSON.parse(payload.nftUserData).eligibility.reason, "personal_task_threshold");

const first = await runDailyProfileNftWorkerOnce({
  runDate,
  enabled: true,
  useLease: false,
  dependencies: {
    listCandidates: async () => candidates,
    createAward: createDailyProfileNftAward,
    markRunning: markDailyProfileNftAwardRunning,
    generateNft: async ({ award }) => ({ id: `nft_${award.id}` }),
    markGenerated: markDailyProfileNftAwardGenerated,
    markFailed: markDailyProfileNftAwardFailed,
  },
});

assert.equal(first.ok, true);
assert.equal(first.candidateCount, 2);
assert.equal(first.generatedCount, 2);
assert.equal(first.failedCount, 0);
assert.deepEqual(
  first.generated.map((item) => item.accountId).sort(),
  ["acct_daily_nft_network", "acct_daily_nft_personal"]
);
assert.ok(first.generated.every((item) => item.profileNftId.startsWith("nft_daily_nft_")));

const second = await runDailyProfileNftWorkerOnce({
  runDate,
  enabled: true,
  useLease: false,
  dependencies: {
    listCandidates: async () => candidates,
    createAward: createDailyProfileNftAward,
    markRunning: markDailyProfileNftAwardRunning,
    generateNft: async ({ award }) => ({ id: `duplicate_${award.id}` }),
    markGenerated: markDailyProfileNftAwardGenerated,
    markFailed: markDailyProfileNftAwardFailed,
  },
});

assert.equal(second.generatedCount, 0);
assert.equal(second.skippedCount, 2);
assert.deepEqual(
  second.skipped.map((item) => item.status).sort(),
  ["generated", "generated"]
);

const retryCandidate = {
  accountId: "acct_daily_nft_retry",
  walletAddress: "rDailyNftRetry11111111111111111111",
  personalCompletedCount: 5,
  networkCompletedCount: 0,
  eligibilityReason: "personal_task_threshold",
  lastCompletedAt: "2026-06-30T10:00:00.000Z",
};
const failed = await runDailyProfileNftWorkerOnce({
  runDate,
  enabled: true,
  useLease: false,
  dependencies: {
    listCandidates: async () => [retryCandidate],
    createAward: createDailyProfileNftAward,
    markRunning: markDailyProfileNftAwardRunning,
    generateNft: async () => {
      throw new Error("transient image provider failure");
    },
    markGenerated: markDailyProfileNftAwardGenerated,
    markFailed: markDailyProfileNftAwardFailed,
  },
});

assert.equal(failed.generatedCount, 0);
assert.equal(failed.failedCount, 1);
assert.match(failed.failed[0].error, /transient image provider failure/);

const retried = await runDailyProfileNftWorkerOnce({
  runDate,
  enabled: true,
  useLease: false,
  dependencies: {
    listCandidates: async () => [retryCandidate],
    createAward: createDailyProfileNftAward,
    markRunning: markDailyProfileNftAwardRunning,
    generateNft: async ({ award }) => ({ id: `retry_${award.id}` }),
    markGenerated: markDailyProfileNftAwardGenerated,
    markFailed: markDailyProfileNftAwardFailed,
  },
});

assert.equal(retried.generatedCount, 1);
assert.equal(retried.failedCount, 0);
assert.equal(retried.generated[0].accountId, retryCandidate.accountId);
assert.ok(retried.generated[0].profileNftId.startsWith("retry_daily_nft_"));

console.log("profile-nft-daily-worker-smoke ok");
