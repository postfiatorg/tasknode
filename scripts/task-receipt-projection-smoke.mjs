import assert from "node:assert/strict";
import { canonicalReceiptProjection } from "../server/task-receipt-projection.js";
import { TASK_STATUS } from "../shared/task-lifecycle.js";

const positiveDecision = canonicalReceiptProjection({
  projection: {
    status: "reward_decided",
    reward_actual_pft: "4.50",
    events: [{ schema: "pf.task.reward_decision.v1" }],
  },
  hydratedEvents: [{ payload: { schema: "pf.task.reward_decision.v1", score: { reward_pft: "4.50" } } }],
});
assert.equal(positiveDecision.status, TASK_STATUS.rewardDecided);
assert.equal(positiveDecision.rewardActualPft, "4.50");

const zeroDecision = canonicalReceiptProjection({
  projection: {
    status: "verification_response_submitted",
    events: [{ schema: "pf.task.reward_decision.v1" }],
  },
  hydratedEvents: [{ payload: { schema: "pf.task.reward_decision.v1", score: { reward_pft: "0.00" } } }],
});
assert.equal(zeroDecision.status, TASK_STATUS.rewarded);

const paymentFinalizes = canonicalReceiptProjection({
  projection: {
    status: "reward_decided",
    reward_actual_pft: "4.50",
    events: [
      { schema: "pf.task.reward_decision.v1" },
      { schema: "pf.reward.v1" },
    ],
  },
  hydratedEvents: [
    { payload: { schema: "pf.task.reward_decision.v1", score: { reward_pft: "4.50" } } },
    { payload: { schema: "pf.reward.v1", reward_pft: "4.50" } },
  ],
});
assert.equal(paymentFinalizes.status, TASK_STATUS.rewarded);

console.log("task receipt projection smoke ok");
