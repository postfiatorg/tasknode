import assert from "node:assert/strict";

import { taskReviewWorkerInternalsForTests } from "../server/task-review-worker.js";

const {
  existingRewardReviewEvent,
  timelineEventPublishedRef,
  workerClaimStaleSeconds,
} = taskReviewWorkerInternalsForTests;

function oldRewardClaimWouldSelect(row, now, staleSeconds = 60) {
  const worker = row.metadata_json?.workers?.reward_scoring || {};
  const published = String(worker.published || "") === "true";
  const processing = String(worker.processing || "") === "true";
  const claimedAt = Date.parse(worker.claimed_at || "");
  const stale = Number.isFinite(claimedAt) && claimedAt < now.getTime() - staleSeconds * 1000;
  return row.status === "verification_response_submitted" && !published && (!processing || stale);
}

const replayNow = new Date("2026-06-01T16:49:00.000Z");
const staleProjectionRow = {
  task_id: "task_2ebb368d49cd48d11802d4f3c4692dd7",
  status: "verification_response_submitted",
  metadata_json: {
    workers: {
      reward_scoring: {
        processing: "true",
        published: "false",
        claimed_at: "2026-06-01T16:47:30.000Z",
      },
    },
  },
};

const detailWithExistingReward = {
  forensics: {
    timeline: [
      {
        rawPayload: {
          schema: "pf.reward.v1",
          event_id: "evt_8785e3fac2e1912e1638fbbd",
          reward_pft: "9000.00",
        },
        txHash: "B3D7B19EA78953031EDBF9F396F26A6A9F5979A908DFEE539E3187EAD296D3E6",
        cid: "QmeB4X12kWbeQFyAsxhB6CMLL3X5wf5dq2UGMaG4NWeJ13",
      },
    ],
  },
};

const oldWouldClaim = oldRewardClaimWouldSelect(staleProjectionRow, replayNow, 60);
const currentStaleWindowSeconds = workerClaimStaleSeconds();
const existingReward = existingRewardReviewEvent(detailWithExistingReward);
const currentWouldPublish = !existingReward;

assert.equal(oldWouldClaim, true);
assert.equal(currentStaleWindowSeconds, 900);
assert.equal(currentWouldPublish, false);

console.log(JSON.stringify({
  reproduction: "controlled stale reward-scoring claim replay",
  task_id: staleProjectionRow.task_id,
  old_boundary: {
    stale_seconds: 60,
    would_claim_and_continue_to_reward_scoring: oldWouldClaim,
    reason: "status was verification_response_submitted, reward_scoring was processing=true, published=false, and claimed_at was older than the old 60 second stale window",
  },
  current_boundary: {
    stale_seconds: currentStaleWindowSeconds,
    would_publish_reward: currentWouldPublish,
    existing_reward_ref: timelineEventPublishedRef(existingReward),
    reason: "current code sees the existing pf.reward.v1 outcome and skips reward scoring publication",
  },
}, null, 2));
