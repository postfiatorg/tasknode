import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.TASKNODE_STORE_PATH = path.join(
  await mkdtemp(path.join(os.tmpdir(), "tasknode-network-badge-verifier-jobs-")),
  "runtime-store.json"
);
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_INITIAL_PROVIDER_CREDIT_USD = "0";

const {
  approvalRecommendationFromVerifierJobResultJson,
  approvalRecommendationFromVerifierResult,
  networkBadgeVerifierJobRecord,
  normalizeVerifierType,
  runNetworkBadgeVerifierJobRecord,
} = await import("../server/repositories/network-badge-verifier-jobs.js");
const {
  getOrCreateEmailAccount,
  linkProviderToAccount,
  setAccountExpertReview,
} = await import("../server/runtime-store.js");
const { appendUsageCredit } = await import("../server/repositories/chat-billing.js");

function expertPersonalTask(index) {
  const day = String(index + 1).padStart(2, "0");
  return {
    taskId: `task_expert_${day}`,
    fullId: `task_expert_${day}`,
    kind: "Personal",
    isNetworkTask: false,
    status: "Rewarded",
    statusKey: "rewarded",
    title: `Completed expert task ${day}`,
    description: `Original specialist output for market structure topic ${day}.`,
    pft: 100,
    updatedAt: `2026-06-${day}T12:00:00.000Z`,
    steps: ["Review evidence", "Produce specialist findings"],
    verification: { body: "Evidence was reviewed and rewarded." },
  };
}

function expertTaskState(count = 20) {
  return {
    rewarded: Array.from({ length: count }, (_, index) => expertPersonalTask(index)),
    outstanding: [],
    verification: [],
    refused: [],
  };
}

function latestExpertTaskIds(count = 20) {
  return Array.from({ length: count }, (_, index) => `task_expert_${String(count - index).padStart(2, "0")}`);
}

assert.equal(normalizeVerifierType("resolve-x"), "x_user_metrics");
assert.equal(normalizeVerifierType("github_collab"), "github_collaborator_permission");
assert.equal(normalizeVerifierType("resolve-qa-worker"), "qa_worker_access");
assert.equal(normalizeVerifierType("expert-badge"), "expert_access");
assert.throws(
  () => networkBadgeVerifierJobRecord({
    accountId: "acct_inactive",
    badgeId: "inactive_badge",
    verifierType: "github-pr",
  }),
  /network_badge_verifier_type_not_active|network_badge_verifier_job_invalid/
);

const xJob = networkBadgeVerifierJobRecord({
  accountId: "acct_demo",
  verifierType: "resolve-x",
  input: {
    username: "goodalexander",
    providerToken: "must-not-persist",
    token: "must-not-persist",
  },
  requestedByOperator: "nazgul",
});
const xJobAgain = networkBadgeVerifierJobRecord({
  accountId: "acct_demo",
  verifierType: "x_user_metrics",
  input: { username: "goodalexander" },
  requestedByOperator: "nazgul",
});
assert.equal(xJob.id, xJobAgain.id, "provider tokens must not affect verifier job identity");
assert.equal(xJob.badgeId, "kol");
assert.equal(xJob.provider, "x");
assert.equal(xJob.inputJson.username, "goodalexander");
assert.equal("token" in xJob.inputJson, false);
assert.equal("providerToken" in xJob.inputJson, false);
assert.equal(xJob.status, "queued");

process.env.X_BEARER_TOKEN = "x-smoke-token";
const xRun = await runNetworkBadgeVerifierJobRecord(xJob, {
  fetchImpl: async (url, options = {}) => {
    assert.match(String(url), /\/2\/users\/by\/username\/goodalexander/);
    assert.equal(options.headers.authorization, "Bearer x-smoke-token");
    return new Response(JSON.stringify({
      data: {
        id: "123",
        username: "goodalexander",
        public_metrics: {
          followers_count: 134000,
          following_count: 100,
        },
      },
    }), { status: 200 });
  },
  approvedByOperator: "nazgul",
});
assert.equal(xRun.ok, true);
assert.equal(xRun.recommendation.recommended, true);
assert.equal(xRun.recommendation.reason, "x_followers_threshold_met");
assert.equal(xRun.recommendation.plannedRecords.accountBadge.badgeId, "kol");
assert.equal(xRun.recommendation.plannedRecords.identityApproval.publicHandle, "goodalexander");
assert.equal(xRun.recommendation.plannedRecords.identityApproval.metricsJson.followersCount, 134000);

const xJobApprovalPlan = approvalRecommendationFromVerifierJobResultJson({
  job: {
    ...xRun.job,
    status: "succeeded",
    resultJson: {
      resolverResult: xRun.result,
    },
  },
  approvedByOperator: "nazgul",
});
assert.equal(xJobApprovalPlan.recommended, true);
assert.equal(xJobApprovalPlan.reason, "x_followers_threshold_met");
assert.equal(xJobApprovalPlan.plannedRecords.accountBadge.badgeId, "kol");

const missingResolverPlan = approvalRecommendationFromVerifierJobResultJson({
  job: {
    ...xRun.job,
    status: "succeeded",
    resultJson: {},
  },
});
assert.equal(missingResolverPlan.recommended, false);
assert.equal(missingResolverPlan.reason, "network_badge_verifier_job_missing_resolver_result");

const lowFollowerRecommendation = approvalRecommendationFromVerifierResult({
  job: xJob,
  result: {
    checkedAt: "2026-06-22T00:00:00.000Z",
    username: "smallaccount",
    profileUrl: "https://x.com/smallaccount",
    metrics: { followersCount: 400 },
    qualifications: { kolXFull: false },
  },
});
assert.equal(lowFollowerRecommendation.recommended, false);
assert.equal(lowFollowerRecommendation.plannedRecords, null);

const coreJob = networkBadgeVerifierJobRecord({
  accountId: "acct_core",
  verifierType: "github_collab",
  input: {
    owner: "postfiatorg",
    repo: "tasknodeofficial",
    username: "goodalexander",
  },
});
assert.equal(coreJob.badgeId, "core_contributor");
process.env.GITHUB_TOKEN = "gh-smoke-token";
const coreRun = await runNetworkBadgeVerifierJobRecord(coreJob, {
  fetchImpl: async (url, options = {}) => {
    assert.match(String(url), /\/repos\/postfiatorg\/tasknodeofficial\/collaborators\/goodalexander\/permission$/);
    assert.equal(options.headers.authorization, "Bearer gh-smoke-token");
    return new Response(JSON.stringify({ permission: "write" }), { status: 200 });
  },
});
assert.equal(coreRun.recommendation.recommended, true);
assert.equal(coreRun.recommendation.plannedRecords.accountBadge.badgeId, "core_contributor");
assert.equal(coreRun.recommendation.plannedRecords.identityApproval.metricsJson.writeAccess, true);

const qaAccount = getOrCreateEmailAccount({
  email: "qa-verifier@example.test",
  canonicalEmail: "qa-verifier@example.test",
});
assert.ok(qaAccount?.id, "QA verifier account should exist");
assert.equal(linkProviderToAccount({
  accountId: qaAccount.id,
  provider: "telegram",
  providerUserId: "qa-verifier-telegram",
  username: "qa_verifier_tg",
}).ok, true);
assert.equal(linkProviderToAccount({
  accountId: qaAccount.id,
  provider: "discord",
  providerUserId: "qa-verifier-discord",
  username: "qa_verifier_discord",
}).ok, true);

const qaJob = networkBadgeVerifierJobRecord({
  accountId: qaAccount.id,
  verifierType: "qa_worker",
});
assert.equal(qaJob.badgeId, "qa_worker");
assert.equal(qaJob.provider, "tasknode");

const qaMissingCredit = await runNetworkBadgeVerifierJobRecord(qaJob);
assert.equal(qaMissingCredit.recommendation.recommended, false);
assert.equal(qaMissingCredit.recommendation.reason, "qa_worker_backend_requirements_missing");

await appendUsageCredit({
  accountId: qaAccount.id,
  amountUsd: 20,
  source: "ethereum_deposit",
  uniqueKey: "ethereum_deposit:qa-verifier:usdc",
  metadata: { asset: "USDC" },
});
const qaRun = await runNetworkBadgeVerifierJobRecord(qaJob);
assert.equal(qaRun.recommendation.recommended, true);
assert.equal(qaRun.recommendation.reason, "qa_worker_backend_requirements_verified");
assert.equal(qaRun.recommendation.plannedRecords.accountBadge.badgeId, "qa_worker");
assert.equal(qaRun.recommendation.plannedRecords.identityApproval.metricsJson.telegramLinked, true);
assert.equal(qaRun.recommendation.plannedRecords.identityApproval.metricsJson.discordLinked, true);
assert.equal(qaRun.recommendation.plannedRecords.identityApproval.metricsJson.usdcTopUp, true);

const expertAccount = getOrCreateEmailAccount({
  email: "expert-verifier@example.test",
  canonicalEmail: "expert-verifier@example.test",
});
const expertReviewSaved = setAccountExpertReview({
  accountId: expertAccount.id,
  review: {
    status: "verified",
    topic: "market structure",
    score: 88,
    thresholdScore: 80,
    personalTaskCount: 20,
    requiredPersonalTaskCount: 20,
    reviewedTaskIds: latestExpertTaskIds(20),
    reviewedAt: "2026-06-22T00:00:00.000Z",
    recommendedExpertLabel: "Market structure analyst",
    summary: "Repeated specialist Personal tasks support Expert routing.",
    strengths: ["Specific market structure outputs"],
    weaknesses: [],
    disqualifyingConcerns: [],
    evidenceTaskIds: ["task_expert_20", "task_expert_19"],
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    responseId: "orchatcmpl_expert_verifier",
  },
});
assert.equal(expertReviewSaved.ok, true);

const expertJob = networkBadgeVerifierJobRecord({
  accountId: expertAccount.id,
  verifierType: "expert",
  input: {
    taskState: expertTaskState(20),
  },
});
assert.equal(expertJob.badgeId, "expert");
assert.equal(expertJob.provider, "tasknode");
const expertRun = await runNetworkBadgeVerifierJobRecord(expertJob);
assert.equal(expertRun.recommendation.recommended, true);
assert.equal(expertRun.recommendation.reason, "expert_persisted_review_verified");
assert.equal(expertRun.recommendation.plannedRecords.accountBadge.badgeId, "expert");
assert.equal(expertRun.recommendation.plannedRecords.identityApproval.metricsJson.score, 88);
assert.equal(expertRun.recommendation.plannedRecords.identityApproval.metricsJson.reviewCurrent, true);

const staleExpertRun = await runNetworkBadgeVerifierJobRecord({
  ...expertJob,
  inputJson: {
    taskState: {
      ...expertTaskState(20),
      rewarded: [
        {
          ...expertPersonalTask(99),
          taskId: "task_expert_new",
          fullId: "task_expert_new",
          updatedAt: "2026-07-01T12:00:00.000Z",
        },
        ...expertTaskState(20).rewarded,
      ],
    },
  },
});
assert.equal(staleExpertRun.recommendation.recommended, false);
assert.equal(staleExpertRun.recommendation.reason, "expert_persisted_review_not_verified");

const migration = await readFile(new URL("../server/db/migrations/073_network_badge_verifier_jobs.sql", import.meta.url), "utf8");
assert.match(migration, /CREATE TABLE IF NOT EXISTS network_badge_verifier_jobs/);
assert.match(migration, /idempotency_key text NOT NULL UNIQUE/);

console.log("network badge verifier jobs smoke ok");
