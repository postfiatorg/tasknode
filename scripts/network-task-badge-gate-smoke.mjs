import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TASKNODE_DATABASE_ENABLED = "false";
process.env.TASKNODE_STORE_PATH = join(mkdtempSync(join(tmpdir(), "tasknode-badge-gate-")), "store.json");

const { getOrCreateProviderAccount } = await import("../server/runtime-store.js");
const {
  assertNetworkTaskBadgeEligibility,
  networkBadgeProjectionForAccount,
} = await import("../server/repositories/network-badges.js");
const { buildNetworkTaskRequestContext } = await import("../server/network-task-generation-worker.js");

const coreAccount = getOrCreateProviderAccount({
  provider: "github",
  providerUserId: "badge-gate-core-gh",
  username: "goodalexander",
  displayName: "Good Alexander",
  profileUrl: "https://github.com/goodalexander",
  metadata: {
    proofIntent: "core_contributor",
    coreContributorAccess: {
      sanctioned: true,
      scopeRecorded: true,
      username: "goodalexander",
      matchedHandle: "goodalexander",
      proofMethod: "github_handle_allowlist",
      oauthScope: "user:email",
    },
  },
});

const unbadgedAccount = getOrCreateProviderAccount({
  provider: "email",
  providerUserId: "badge-gate-unbadged-email",
  username: "unbadged@example.com",
  displayName: "Unbadged Smoke",
});

const coreProjection = await networkBadgeProjectionForAccount({
  accountId: coreAccount.id,
  walletAddress: "rCoreBadgeGateSmoke",
});
assert.ok(coreProjection.verifiedBadgeIds.includes("core_contributor"));
assert.ok(coreProjection.allowedWorkTypes.includes("code_task"));

const coreDecision = await assertNetworkTaskBadgeEligibility({
  accountId: coreAccount.id,
  walletAddress: "rCoreBadgeGateSmoke",
  requiredBadgeId: "core_contributor",
  operatingBadgeId: "core_contributor",
  workType: "code_task",
  requestedRewardMinPft: 10000,
  requestedRewardMaxPft: 30000,
});
assert.equal(coreDecision.eligible, true);
assert.equal(coreDecision.badge_reward_cap_pft, 30000);

await assert.rejects(
  () => assertNetworkTaskBadgeEligibility({
    accountId: coreAccount.id,
    walletAddress: "rCoreBadgeGateSmoke",
    requiredBadgeId: "core_contributor",
    operatingBadgeId: "core_contributor",
    workType: "code_task",
    requestedRewardMinPft: 10000,
    requestedRewardMaxPft: 50000,
  }),
  /network_task_reward_exceeds_badge_cap/
);

await assert.rejects(
  () => assertNetworkTaskBadgeEligibility({
    accountId: unbadgedAccount.id,
    walletAddress: "rUnbadgedBadgeGateSmoke",
    requiredBadgeId: "core_contributor",
    operatingBadgeId: "core_contributor",
    workType: "code_task",
    requestedRewardMinPft: 10000,
    requestedRewardMaxPft: 30000,
  }),
  /network_task_candidate_missing_badge/
);

for (const [badgeId, workType, rewardMaxPft] of [
  ["inactive_badge", "inactive_work", 100],
  ["unknown_badge", "unknown_work", 100],
]) {
  await assert.rejects(
    () => assertNetworkTaskBadgeEligibility({
      accountId: unbadgedAccount.id,
      walletAddress: "rUnbadgedBadgeGateSmoke",
      requiredBadgeId: badgeId,
      operatingBadgeId: badgeId,
      workType,
      requestedRewardMinPft: 100,
      requestedRewardMaxPft: rewardMaxPft,
    }),
    /network_task_unsupported_required_badge/,
    `${badgeId} must not be an active user-facing badge`
  );
}

await assert.rejects(
  () => assertNetworkTaskBadgeEligibility({
    accountId: unbadgedAccount.id,
    walletAddress: "rUnbadgedBadgeGateSmoke",
    requestedRewardMinPft: 100,
    requestedRewardMaxPft: 100,
  }),
  /network_task_missing_badge_metadata/
);

const requestContext = buildNetworkTaskRequestContext({
  source: {
    networkTask: {
      requiredBadgeId: "core_contributor",
      operatingBadgeId: "core_contributor",
      badgeWorkType: "code_task",
      badgeRewardCapPft: 30000,
      badgeEvidenceRequirements: ["PR or commit URL."],
      discordEvidenceRequired: true,
      projectNeedSummary: "Patch a code path.",
      allocationReasonSummary: "Core Contributor is badge eligible.",
    },
    policy: {
      badgeEligibilityDecision: coreDecision,
    },
  },
  job: {
    id: "nettaskjob_badge_gate_smoke",
    allocation_id: "netalloc_badge_gate_smoke",
    project_id: "project_badge_gate_smoke",
    task_class: "network",
    source_payload_digest: "sha256:badge-gate",
  },
  reward: { min: 10000, max: 30000 },
});
assert.equal(requestContext.required_badge_id, "core_contributor");
assert.equal(requestContext.badge_work_type, "code_task");
assert.equal(requestContext.badge_reward_cap_pft, 30000);
assert.equal(requestContext.discord_evidence_required, true);
assert.equal(requestContext.badge_eligibility_decision.required_badge_id, "core_contributor");

console.log("network task badge gate smoke ok");
