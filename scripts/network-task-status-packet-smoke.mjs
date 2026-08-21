import assert from "node:assert/strict";

import {
  deriveNetworkTaskStatusPacket,
  deriveNetworkTaskStatusPacketFromRow,
  packetNeedsReview,
} from "../server/repositories/network-task-status.js";

const linkFailed = deriveNetworkTaskStatusPacket({
  projection: {
    task_id: "task_link_failed",
    status: "proposed",
    reward_actual_pft: 0,
  },
  allocation: {
    allocation_status: "queued",
    generated_task_id: "task_link_failed",
  },
  generationJob: {
    status: "link_failed",
    task_id: "task_link_failed",
    last_error: "offer publish pointer not linked",
  },
});
assert.equal(linkFailed.allocationState, "link_failed");
assert.equal(linkFailed.taskState, "proposed");
assert.equal(linkFailed.rewardMovement, "none");
assert.equal(linkFailed.repairRequired, true);
assert.equal(linkFailed.repairReason, "link_failed");
assert.equal(packetNeedsReview(linkFailed), true);

const closedZero = deriveNetworkTaskStatusPacket({
  projection: {
    task_id: "task_zero_reward",
    status: "rewarded",
    reward_actual_pft: 0,
    event_count: 7,
    last_event_tx_hash: "TX_ZERO",
    last_event_cid: "bafyZero",
  },
  allocation: {
    allocation_status: "completed",
  },
  events: [{
    event_type: "pf.reward.v1",
  }],
});
assert.equal(closedZero.allocationState, "published");
assert.equal(closedZero.taskState, "rewarded");
assert.equal(closedZero.rewardMovement, "closed_zero");
assert.equal(closedZero.repairRequired, false);
assert.equal(packetNeedsReview(closedZero), true);

const duplicateGuarded = deriveNetworkTaskStatusPacket({
  projection: {
    task_id: "task_duplicate_guarded",
    status: "rewarded",
    reward_actual_pft: 0,
    event_count: 9,
    last_event_tx_hash: "TX_DUP",
    last_event_cid: "bafyDup",
    metadata_json: {
      reward_payment_guard: {
        status: "submitted",
        tx_hash: "TX_ALREADY_SUBMITTED",
      },
    },
  },
});
assert.equal(duplicateGuarded.taskState, "rewarded");
assert.equal(duplicateGuarded.rewardMovement, "duplicate_guarded");
assert.equal(duplicateGuarded.repairRequired, false);
assert.equal(packetNeedsReview(duplicateGuarded), true);

const paidPositive = deriveNetworkTaskStatusPacketFromRow({
  task_id: "task_paid_positive",
  status: "rewarded",
  reward_actual_pft: "12000",
  reward_offer_pft: "12000",
  event_count: 5,
  last_event_tx_hash: "TX_PAID",
  last_event_cid: "bafyPaid",
  allocation_status: "rewarded",
  generation_job_status: "published",
});
assert.equal(paidPositive.allocationState, "published");
assert.equal(paidPositive.taskState, "rewarded");
assert.equal(paidPositive.rewardMovement, "paid_positive");
assert.equal(paidPositive.repairRequired, false);
assert.equal(packetNeedsReview(paidPositive), true);

const pending = deriveNetworkTaskStatusPacket({
  projection: {
    task_id: "task_pending",
    status: "verification_response_submitted",
    reward_actual_pft: 0,
  },
  allocation: {
    allocation_status: "reward_decided",
  },
});
assert.equal(pending.rewardMovement, "pending");
assert.equal(packetNeedsReview(pending), false);

console.log("network-task-status-packet-smoke ok");
