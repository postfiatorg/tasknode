import assert from "node:assert/strict";
import {
  TASK_STATUS,
  TASK_TABS,
  taskLifecycleActions,
  taskRefreshMetadata,
  taskRequiresRefresh,
  taskStatusTab,
} from "../shared/task-lifecycle.js";

assert.equal(taskStatusTab(TASK_STATUS.verificationRequested), TASK_TABS.verification);
assert.equal(taskRequiresRefresh(TASK_STATUS.verificationRequested), true);
assert.equal(taskLifecycleActions(TASK_STATUS.verificationRequested).canSubmitVerificationEvidence, true);

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
