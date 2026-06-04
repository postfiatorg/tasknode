import assert from "node:assert/strict";
import { canonicalReceiptProjection } from "../server/task-receipt-projection.js";
import { TASK_STATUS } from "../shared/task-lifecycle.js";

const positiveRewardOutcome = canonicalReceiptProjection({
  projection: {
    status: "verification_response_submitted",
    reward_actual_pft: "4.50",
    events: [{ schema: "pf.reward.v1" }],
  },
  hydratedEvents: [{ payload: { schema: "pf.reward.v1", reward_pft: "4.50" } }],
});
assert.equal(positiveRewardOutcome.status, TASK_STATUS.rewarded);
assert.equal(positiveRewardOutcome.rewardActualPft, "4.50");

const zeroRewardOutcome = canonicalReceiptProjection({
  projection: {
    status: "verification_response_submitted",
    events: [{ schema: "pf.reward.v1" }],
  },
  hydratedEvents: [{ payload: { schema: "pf.reward.v1", reward_pft: "0.00" } }],
});
assert.equal(zeroRewardOutcome.status, TASK_STATUS.rewarded);
assert.equal(zeroRewardOutcome.rewardActualPft, "0.00");

const legacyDecisionDoesNotFinalize = canonicalReceiptProjection({
  projection: {
    status: "verification_response_submitted",
    reward_actual_pft: "4.50",
    events: [{ schema: "pf.task.reward_decision.v1" }],
  },
  hydratedEvents: [{ payload: { schema: "pf.task.reward_decision.v1", score: { reward_pft: "4.50" } } }],
});
assert.equal(legacyDecisionDoesNotFinalize.status, TASK_STATUS.verificationResponseSubmitted);
assert.equal(legacyDecisionDoesNotFinalize.rewardActualPft, "4.50");

console.log("task receipt projection smoke ok");
