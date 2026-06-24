import assert from "node:assert/strict";
import { Wallet } from "xrpl";
import {
  signTaskTransition,
  verifyTaskTransitionSignature,
} from "../server/task-transition-signatures.js";
import { taskReviewWorkerInternalsForTests } from "../server/task-review-worker.js";

const rewardWallet = Wallet.generate();
const baseRewardPayload = {
  schema: "pf.reward.v1",
  task_id: "task_reward_forensics_smoke",
  reward_pft: "12.50",
  economic_reward_pft: "12.50",
  reward_score: {
    decision: "reward",
    reward_pft: "12.50",
    reason: "Smoke proof.",
  },
  task_history: {
    task: { schema: "pf.task.offer.v1", title: "Smoke task" },
    submission: { schema: "pf.task.submission.v1", evidence: { artifact_type: "text", value: "proof" } },
    verification_response: { schema: "pf.task.verification_response.v1", response_text: "verified" },
  },
};

const rewardSignature = signTaskTransition({
  payload: baseRewardPayload,
  signerWallet: rewardWallet,
  role: "pf_reward_authority",
  transition: "rewarded",
});

assert.equal(verifyTaskTransitionSignature({ payload: baseRewardPayload, signature: rewardSignature }).verified, true);
assert.equal(
  verifyTaskTransitionSignature({
    payload: { ...baseRewardPayload, reward_pft: "99.00" },
    signature: rewardSignature,
  }).verified,
  false
);

const rewardPayload = taskReviewWorkerInternalsForTests.attachRewardForensics({
  detail: {
    forensics: {
      timeline: [
        {
          schema: "pf.task.submission.v1",
          txHash: "",
          cid: "postgres:evt_actor_submission",
          eventDigest: "sha256:actor_payload",
          writeSource: "direct_write",
          signature: {
            role: "actor",
            signer_wallet: "rActorSmoke",
            payload_digest: "sha256:actor_payload",
            verification: { verified: true, reason: "verified" },
          },
        },
      ],
    },
  },
  rewardPayload: baseRewardPayload,
  rewardSignature,
  scoringMetadata: {
    provider: "smoke",
    model: "deterministic",
  },
});

assert.equal(rewardPayload.schema, "pf.reward.v1");
assert.equal(rewardPayload.reward_forensics.schema, "pf.reward.forensics.v1");
assert.equal(rewardPayload.reward_forensics.anchoring.mode, "single_reward_payload_cid");
assert.equal(rewardPayload.reward_forensics.integrity.timeline_event_count, 1);
assert.equal(rewardPayload.reward_forensics.integrity.signed_transition_count, 2);
assert.equal(rewardPayload.reward_forensics.integrity.actor_signed_transition_count, 1);
assert.equal(rewardPayload.reward_forensics.integrity.pf_signed_transition_count, 1);
assert.equal(rewardPayload.transition_signatures.at(-1).role, "pf_reward_authority");
assert.equal(rewardPayload.transition_signatures.at(-1).payload_digest, rewardSignature.payload_digest);

console.log("task-reward-forensics-signatures-smoke ok");
