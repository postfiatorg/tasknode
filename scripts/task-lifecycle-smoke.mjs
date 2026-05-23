import assert from "node:assert/strict";
import {
  TASK_STATUS,
  TASK_TABS,
  statusFromRewardAmount,
  taskLifecycleActions,
  taskRefreshMetadata,
  taskRequiresRefresh,
  taskStatusTab,
} from "../shared/task-lifecycle.js";

assert.equal(taskStatusTab(TASK_STATUS.verificationRequested), TASK_TABS.verification);
assert.equal(taskRequiresRefresh(TASK_STATUS.verificationRequested), true);
assert.equal(taskLifecycleActions(TASK_STATUS.verificationRequested).canSubmitVerificationEvidence, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).canAccept, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).canRefuse, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).canStop, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).stopAction, "refuse");
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).stopLabel, "Refuse task");
assert.equal(statusFromRewardAmount("2.50"), TASK_STATUS.rewardDecided);
assert.equal(statusFromRewardAmount("0"), TASK_STATUS.rewarded);

const activeReview = taskRefreshMetadata({
  tasks: [
    {
      taskId: "task_review_loop",
      statusKey: TASK_STATUS.verificationRequested,
    },
  ],
});
assert.equal(activeReview.requiresRefresh, true);
assert.equal(activeReview.refreshReason, "task_review_active");
assert.deepEqual(activeReview.refreshTaskIds, ["task_review_loop"]);

const rewardDecidedLoop = taskRefreshMetadata({
  tasks: [{ taskId: "task_reward_decided", statusKey: TASK_STATUS.rewardDecided }],
});
assert.equal(rewardDecidedLoop.requiresRefresh, true);
assert.deepEqual(rewardDecidedLoop.refreshTaskIds, ["task_reward_decided"]);

const acceptedOpenLoop = taskRefreshMetadata({
  tasks: [{ taskId: "task_accepted", statusKey: TASK_STATUS.accepted }],
});
assert.equal(acceptedOpenLoop.requiresRefresh, true);
assert.equal(acceptedOpenLoop.nextPollMs, 10000);
assert.equal(acceptedOpenLoop.refreshReason, "task_state_active");
assert.deepEqual(acceptedOpenLoop.refreshTaskIds, ["task_accepted"]);

const terminalReward = taskRefreshMetadata({
  tasks: [
    {
      taskId: "task_rewarded",
      statusKey: TASK_STATUS.rewarded,
    },
  ],
});
assert.equal(terminalReward.requiresRefresh, false);
assert.deepEqual(terminalReward.refreshTaskIds, []);

console.log("task lifecycle smoke ok");
