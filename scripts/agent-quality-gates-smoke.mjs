#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.TASKNODE_AGENT_TASK_REQUEST_RATE_LIMIT_MAX = "1";
process.env.TASKNODE_AGENT_TASK_REQUEST_RATE_LIMIT_WINDOW_MS = "60000";

const {
  agentOriginForTaskSession,
  agentSelfDealingDecision,
  checkAgentActionRateLimit,
  enforceAgentActionRateLimit,
  recordAgentActionJournal,
  resetAgentQualityGateRateLimitsForTests,
} = await import("../server/agent-quality-gates.js");

const agentSession = {
  accountId: "acct_agent_quality",
  primaryProvider: "wallet",
};
const agentPayload = {
  agentHandle: "grashnuk",
  walletAddress: "rSpoofedPayloadWallet",
};
const agentOrigin = agentOriginForTaskSession(
  agentSession,
  agentPayload,
  "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW"
);
assert.equal(agentOrigin.actorType, "machine_agent");
assert.equal(agentOrigin.agentHandle, "grashnuk");
assert.equal(agentOrigin.walletAddress, "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW");

const spoofOrigin = agentOriginForTaskSession(
  { accountId: "acct_human", primaryProvider: "github" },
  {
    metadata: {
      senderType: "machine_agent",
      agentOrigin: { agent: true, actorType: "machine_agent", agentHandle: "spoof" },
    },
  },
  "rSpoofedWallet"
);
assert.equal(spoofOrigin, null);

const selfRequest = {
  request_id: "req_self_agent",
  account_id: "acct_agent_quality",
  subject_wallet: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
  source: "agent_capability_client",
  requested_task_kind: "personal",
};
const selfTask = {
  task_id: "task_self_agent",
  request_id: "req_self_agent",
  status: "accepted",
};
const selfDealing = agentSelfDealingDecision({
  agentOrigin,
  accountId: "acct_agent_quality",
  walletAddress: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
  task: selfTask,
  taskRequest: selfRequest,
  action: "task_submission",
});
assert.equal(selfDealing.ok, true);
assert.equal(selfDealing.reason, "self_requested_submission_allowed_independent_review_required");

const selfVerify = agentSelfDealingDecision({
  agentOrigin,
  accountId: "acct_agent_quality",
  walletAddress: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
  task: { ...selfTask, status: "verification_requested" },
  taskRequest: selfRequest,
  action: "task_verification_response",
});
assert.equal(selfVerify.ok, true);
assert.equal(selfVerify.reason, "self_requested_verification_response_allowed_independent_reward_required");

const selfReward = agentSelfDealingDecision({
  agentOrigin,
  accountId: "acct_agent_quality",
  walletAddress: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
  task: { ...selfTask, status: "verification_response_submitted" },
  taskRequest: selfRequest,
  action: "task_reward_decision",
});
assert.equal(selfReward.ok, false);
assert.equal(selfReward.error, "agent_self_dealing_blocked");

const boardRoutedTask = agentSelfDealingDecision({
  agentOrigin,
  accountId: "acct_agent_quality",
  walletAddress: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
  task: { task_id: "task_network", request_id: "req_network", status: "accepted" },
  taskRequest: {
    request_id: "req_network",
    account_id: "acct_agent_quality",
    subject_wallet: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
    source: "network_task_generation",
    requested_task_kind: "network",
  },
  action: "task_submission",
});
assert.equal(boardRoutedTask.ok, true);

resetAgentQualityGateRateLimitsForTests();
const sameAccountOtherWalletOrigin = {
  ...agentOrigin,
  walletAddress: "rh8jpDYBeYyVKPzxaAFzMfxSSdRaCaenSt",
};
const first = await checkAgentActionRateLimit({ agentOrigin, action: "task_request" });
assert.equal(first.ok, true);
const differentWalletSameAccount = await checkAgentActionRateLimit({
  agentOrigin: sameAccountOtherWalletOrigin,
  action: "task_request",
});
assert.equal(differentWalletSameAccount.ok, true, "rate buckets must be keyed by verified wallet before account");
const second = await enforceAgentActionRateLimit({
  agentOrigin,
  action: "task_request",
  accountId: "acct_agent_quality",
  requestId: "req_rate_limited",
});
assert.equal(second.ok, false);
assert.equal(second.status, 429);
assert.equal(second.body.error, "agent_action_rate_limited");
assert.equal(second.body.orcWorkJournal.reason, "database_disabled");

process.env.TASKNODE_TRUSTED_AGENT_WALLETS = agentOrigin.walletAddress;
resetAgentQualityGateRateLimitsForTests();
const trustedTaskRequestAttempts = [];
for (let index = 0; index < 20; index += 1) {
  trustedTaskRequestAttempts.push(await checkAgentActionRateLimit({ agentOrigin, action: "task_request" }));
}
assert.equal(trustedTaskRequestAttempts.every((attempt) => attempt.ok), true);
assert.equal(trustedTaskRequestAttempts[0].limit, 20);
assert.equal(trustedTaskRequestAttempts[0].policy.tier, "trusted_agent");
assert.equal(trustedTaskRequestAttempts[0].policy.reason, "trusted_agent_allowlist");
const trustedRequestOverLimit = await enforceAgentActionRateLimit({
  agentOrigin,
  action: "task_request",
  accountId: "acct_agent_quality",
  requestId: "req_trusted_rate_limited",
});
assert.equal(trustedRequestOverLimit.ok, false);
assert.equal(trustedRequestOverLimit.status, 429);
assert.equal(trustedRequestOverLimit.body.limit, 20);
assert.equal(trustedRequestOverLimit.body.policy.tier, "trusted_agent");
assert.match(trustedRequestOverLimit.body.resetAt, /^\d{4}-\d{2}-\d{2}T/);

resetAgentQualityGateRateLimitsForTests();
const trustedSubmission = await checkAgentActionRateLimit({ agentOrigin, action: "task_submission" });
assert.equal(trustedSubmission.ok, true);
assert.equal(trustedSubmission.limit, 30);
assert.equal(trustedSubmission.policy.tier, "trusted_agent");

const journal = await recordAgentActionJournal({
  agentOrigin,
  action: "task_submission",
  status: "recorded",
  outcomeStatus: "submitted",
  accountId: "acct_agent_quality",
  taskId: "task_network",
  txHash: "ABC123",
});
assert.equal(journal.ok, true);
assert.equal(journal.reason, "database_disabled");

console.log("agent quality gates smoke ok");
