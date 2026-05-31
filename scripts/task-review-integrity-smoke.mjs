import assert from "node:assert/strict";
import { taskReviewWorkerInternals } from "../server/task-review-worker.js";

const {
  latestRewardPaymentEvent,
  normalizeReward,
  rewardPaymentGuardBlocksRetry,
  rewardPaymentGuardPayload,
  rewardPaymentGuardStatus,
} = taskReviewWorkerInternals;

assert.equal(normalizeReward("999.50", "12.25"), 12.25);
assert.equal(normalizeReward("4.50", "12.25"), 4.5);
assert.equal(normalizeReward("4.50", "0"), 0);
assert.equal(normalizeReward("4.50", ""), 0);
assert.equal(normalizeReward("-4.50", "12.25"), 0);

assert.equal(
  latestRewardPaymentEvent({
    forensics: {
      timeline: [
        { schema: "pf.task.reward_decision.v1", txHash: "decision" },
        { rawPayload: { schema: "pf.reward.v1" }, txHash: "reward" },
      ],
    },
  })?.txHash,
  "reward"
);

assert.equal(rewardPaymentGuardBlocksRetry({ status: "submitting" }), true);
assert.equal(rewardPaymentGuardBlocksRetry({ status: "submitted" }), true);
assert.equal(rewardPaymentGuardBlocksRetry({ status: "submit_unknown" }), true);
assert.equal(rewardPaymentGuardBlocksRetry({ status: "failed_before_submit" }), false);
assert.equal(rewardPaymentGuardStatus({ status: "Submitted" }), "submitted");

const guard = rewardPaymentGuardPayload({
  taskId: "task_integrity_smoke",
  rewardPft: 12.5,
  rewardPayload: {
    schema: "pf.reward.v1",
    task_id: "task_integrity_smoke",
    event_id: "evt_integrity_smoke",
    reward_pft: "12.50",
  },
});
assert.equal(guard.status, "submitting");
assert.equal(guard.task_id, "task_integrity_smoke");
assert.equal(guard.event_id, "evt_integrity_smoke");
assert.equal(guard.reward_pft, "12.50");
assert.match(guard.payload_digest, /^[a-f0-9]{64}$/);

console.log("task-review-integrity-smoke ok");
