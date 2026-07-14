import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";

const {
  buildDailyProfileNftGenerationPayload,
  buildDailyProfileNftBackfillManifest,
  runDailyProfileNftBackfill,
  runDailyProfileNftWorkerOnce,
} = await import("../server/profile-nft-daily-worker.js");
const {
  countDailyProfileNftAwardSlots,
  createDailyProfileNftAward,
  markDailyProfileNftAwardFailed,
  markDailyProfileNftAwardGenerated,
  markDailyProfileNftAwardRunning,
  recordDailyProfileNftBackfillSkippedSlots,
} = await import("../server/repositories/profile-nft-daily-awards.js");

const runDate = "2026-06-30";
const backfillRunDates = ["2026-06-28", "2026-06-29", "2026-06-30"];
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
  forwardEnabled: true,
  allowHistoricalRunDate: true,
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
  forwardEnabled: true,
  allowHistoricalRunDate: true,
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
  forwardEnabled: true,
  allowHistoricalRunDate: true,
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
  forwardEnabled: true,
  allowHistoricalRunDate: true,
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

const classifiedCandidate = { ...retryCandidate, accountId: "acct_daily_nft_classified" };
const capturedFailures = [];
for (const [status, expectedRetryable] of [[401, false], [429, true], [503, true]]) {
  const result = await runDailyProfileNftWorkerOnce({
    runDate: `2026-07-${String(status % 28 + 1).padStart(2, "0")}`,
    enabled: true,
    forwardEnabled: true,
    allowHistoricalRunDate: true,
    useLease: false,
    maxAttempts: 3,
    dependencies: {
      listCandidates: async () => [classifiedCandidate],
      createAward: async () => ({ id: `award_${status}`, status: "pending", attemptCount: status === 503 ? 3 : 1 }),
      markRunning: async ({ awardId }) => ({ id: awardId, status: "running", attemptCount: status === 503 ? 3 : 1 }),
      generateNft: async () => { const error = new Error(`provider_${status}`); error.status = status; throw error; },
      markGenerated: async () => null,
      markFailed: async (input) => { capturedFailures.push(input); return input; },
      writeHeartbeat: async () => null,
    },
  });
  assert.equal(result.failed[0].retryable, expectedRetryable);
}
assert.equal(capturedFailures[0].retryable, false, "401/auth must be permanent");
assert.equal(capturedFailures[1].retryable, true, "429 must back off and retry");
assert.ok(capturedFailures[1].retryDelayMs >= 60_000, "transient retry receives deterministic backoff");
assert.equal(capturedFailures[2].maxAttempts, 3, "max-attempt terminal decision is passed to persistence");

const transientAward = await createDailyProfileNftAward({ runDate: "2026-07-16", accountId: "acct_daily_nft_backoff", walletAddress: "rDailyNftBackoff", personalCompletedCount: 4 });
await markDailyProfileNftAwardRunning({ awardId: transientAward.id });
const transientStored = await markDailyProfileNftAwardFailed({ awardId: transientAward.id, error: "temporary provider outage", errorCode: "profile_nft_provider_transient", retryable: true, maxAttempts: 3, retryDelayMs: 60_000 });
assert.equal(transientStored.status, "retry_wait", "429/5xx-style transient failures wait for retry");
assert.equal(transientStored.retryable, true);
assert.ok(new Date(transientStored.nextAttemptAt).getTime() > Date.now(), "retry backoff stores a future deterministic next attempt");
const terminalAward = await createDailyProfileNftAward({ runDate: "2026-07-16", accountId: "acct_daily_nft_max_attempt", walletAddress: "rDailyNftMax", personalCompletedCount: 4 });
await markDailyProfileNftAwardRunning({ awardId: terminalAward.id });
const terminalStored = await markDailyProfileNftAwardFailed({ awardId: terminalAward.id, error: "retry exhausted", errorCode: "profile_nft_provider_transient", retryable: true, maxAttempts: 1, retryDelayMs: 60_000 });
assert.equal(terminalStored.status, "failed_permanent", "max attempts makes transient failure terminal");
assert.equal(terminalStored.retryable, false);
const permanentAward = await createDailyProfileNftAward({ runDate: "2026-07-16", accountId: "acct_daily_nft_permanent", walletAddress: "rDailyNftPermanent", personalCompletedCount: 4 });
await markDailyProfileNftAwardRunning({ awardId: permanentAward.id });
const permanentStored = await markDailyProfileNftAwardFailed({ awardId: permanentAward.id, error: "unauthorized", errorCode: "profile_nft_provider_permanent", retryable: false, maxAttempts: 3 });
assert.equal(permanentStored.status, "failed_permanent", "401/auth failures are terminal");
assert.equal(permanentStored.retryable, false);

const staleRecovery = await runDailyProfileNftWorkerOnce({
  runDate: "2026-07-15",
  enabled: true,
  forwardEnabled: true,
  allowHistoricalRunDate: true,
  useLease: false,
  dependencies: {
    failStaleRunning: async () => ({ failedCount: 1 }),
    listCandidates: async () => [],
    writeHeartbeat: async () => null,
  },
});
assert.equal(staleRecovery.staleFailedCount, 1, "stale running awards are recovered outside dry run");

let dryRunClaims = 0;
let dryRunProviders = 0;
const dryRun = await runDailyProfileNftWorkerOnce({
  runDate: "2026-07-15",
  enabled: true,
  forwardEnabled: true,
  allowHistoricalRunDate: true,
  dryRun: true,
  useLease: false,
  dependencies: {
    failStaleRunning: async () => ({ failedCount: 1 }),
    listCandidates: async () => [classifiedCandidate],
    createAward: async () => { dryRunClaims += 1; return null; },
    generateNft: async () => { dryRunProviders += 1; return null; },
    writeHeartbeat: async () => null,
  },
});
assert.equal(dryRun.dryRun, true);
assert.equal(dryRun.candidateCount, 1);
assert.equal(dryRun.staleFailedCount, 0, "dry run must not mutate stale awards");
assert.equal(dryRunClaims, 0, "dry run must not claim/create awards");
assert.equal(dryRunProviders, 0, "dry run must not invoke generation/provider paths");

let historicalClaims = 0;
const historicalNormalRun = await runDailyProfileNftWorkerOnce({
  runDate: "2026-07-13",
  enabled: true,
  forwardEnabled: true,
  useLease: false,
  dependencies: {
    createAward: async () => { historicalClaims += 1; return null; },
    writeHeartbeat: async () => null,
  },
});
assert.equal(historicalNormalRun.reason, "profile_nft_daily_current_utc_day_only");
assert.equal(historicalClaims, 0, "normal worker never creates historical awards");

const backfillSlots = [];
for (let index = 1; index <= 41; index += 1) {
  for (const runDate of backfillRunDates) {
    backfillSlots.push({
      accountId: `acct_backfill_${String(index).padStart(2, "0")}`,
      walletAddress: `rBackfill${String(index).padStart(2, "0")}`,
      runDate,
      existingStateProof: "no_award_row",
      eligibilityReason: "network_task_completed",
      personalCompletedCount: 0,
      networkCompletedCount: 1,
      lastCompletedAt: "2026-07-14T00:00:00.000Z",
    });
  }
}
const manifest = await buildDailyProfileNftBackfillManifest({
  runDates: backfillRunDates,
  maxAccounts: 41,
  selectedAt: "2026-07-15T00:00:00.000Z",
  dependencies: { listBackfillSlots: async () => [...backfillSlots].reverse() },
});
assert.equal(manifest.slots.length, 41, "backfill hard cap is 41");
assert.equal(manifest.remainingSlots.length, 82, "remaining historical slots are 82");
assert.ok(manifest.slots.every((slot) => slot.runDate === "2026-06-30"), "each account selects its most recent missing UTC date");
assert.deepEqual(manifest.slots.map((slot) => slot.accountId), [...manifest.slots.map((slot) => slot.accountId)].sort(), "backfill order is stable by account");
assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/);

await assert.rejects(
  () => runDailyProfileNftBackfill({ manifest, manifestHash: "incorrect", enabled: true }),
  /profile_nft_daily_backfill_manifest_hash_mismatch/
);

let backfillClaims = 0;
let backfillProviderCalls = 0;
const dryBackfill = await runDailyProfileNftBackfill({
  manifest,
  manifestHash: manifest.manifestHash,
  enabled: true,
  dryRun: true,
  dependencies: {
    countAwardSlots: async () => 0,
    verifyBackfillSlot: async ({ accountId, runDate }) => ({ ...backfillSlots.find((slot) => slot.accountId === accountId && slot.runDate === runDate) }),
    listBackfillSlots: async () => backfillSlots,
    createAward: async () => { backfillClaims += 1; return null; },
    generateNft: async () => { backfillProviderCalls += 1; return null; },
  },
});
assert.equal(dryBackfill.dryRun, true);
assert.equal(dryBackfill.results.length, 41);
assert.equal(backfillClaims, 0, "backfill dry run has zero claims");
assert.equal(backfillProviderCalls, 0, "backfill dry run has zero provider calls");

const driftedBackfill = await runDailyProfileNftBackfill({
  manifest,
  manifestHash: manifest.manifestHash,
  enabled: true,
  dryRun: true,
  dependencies: {
    countAwardSlots: async () => 0,
    listBackfillSlots: async () => backfillSlots,
    verifyBackfillSlot: async ({ accountId, runDate }) => accountId === manifest.slots[0].accountId ? null : ({ ...backfillSlots.find((slot) => slot.accountId === accountId && slot.runDate === runDate) }),
  },
});
assert.equal(driftedBackfill.results[0].status, "before_image_changed", "backfill never substitutes a drifted slot");

let generationCalls = 0;
let backfillSnapshotReads = 0;
let skippedManifestHash = "";
const executedBackfill = await runDailyProfileNftBackfill({
  manifest,
  manifestHash: manifest.manifestHash,
  enabled: true,
  dryRun: false,
  dependencies: {
    countAwardSlots: countDailyProfileNftAwardSlots,
    verifyBackfillSlot: async ({ accountId, runDate }) => ({ ...backfillSlots.find((slot) => slot.accountId === accountId && slot.runDate === runDate) }),
    listBackfillSlots: async () => {
      backfillSnapshotReads += 1;
      return backfillSnapshotReads === 1 ? backfillSlots : manifest.remainingSlots;
    },
    createAward: createDailyProfileNftAward,
    markRunning: markDailyProfileNftAwardRunning,
    generateNft: async ({ award }) => { generationCalls += 1; return { id: `nft_backfill_${award.id}` }; },
    markGenerated: markDailyProfileNftAwardGenerated,
    markFailed: markDailyProfileNftAwardFailed,
    recordSkippedSlots: async (input) => {
      skippedManifestHash = input.manifestHash;
      return recordDailyProfileNftBackfillSkippedSlots(input);
    },
  },
});
assert.equal(executedBackfill.ok, true);
assert.equal(executedBackfill.selectedCount, 41);
assert.equal(executedBackfill.skippedLedgerCount, 82, "exactly 82 historical slots are ledger-skipped");
assert.equal(generationCalls, 41, "backfill uses the normal worker generation path once per selected account");
assert.equal(skippedManifestHash, manifest.manifestHash, "skipped ledger rows bind the manifest digest");
assert.equal(await countDailyProfileNftAwardSlots({ slots: [...manifest.slots, ...manifest.remainingSlots] }), 123, "all selected and skipped slots are idempotently recorded");
const idempotentBackfill = await runDailyProfileNftBackfill({
  manifest,
  manifestHash: manifest.manifestHash,
  enabled: true,
  dryRun: false,
  dependencies: { countAwardSlots: countDailyProfileNftAwardSlots, listBackfillSlots: async () => backfillSlots },
});
assert.equal(idempotentBackfill.alreadyApplied, true, "an already-applied manifest does not create another sweep");

await assert.rejects(
  () => runDailyProfileNftBackfill({ manifest, manifestHash: manifest.manifestHash, enabled: true, dependencies: { countAwardSlots: async () => 123, listBackfillSlots: async () => backfillSlots, releaseLease: async () => { throw new Error("release_only_failure"); } } }),
  /release_only_failure/
);
await assert.rejects(
  () => runDailyProfileNftBackfill({ manifest, manifestHash: manifest.manifestHash, enabled: true, logger: { error() {} }, dependencies: { claimLease: async () => ({ ok: true }), listBackfillSlots: async () => { throw new Error("primary_snapshot_failure"); }, releaseLease: async () => { throw new Error("release_after_primary_failure"); } } }),
  /primary_snapshot_failure/
);

console.log("profile-nft-daily-worker-smoke ok");
