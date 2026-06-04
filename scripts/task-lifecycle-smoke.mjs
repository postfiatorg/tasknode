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
import { taskgenPromptForInput, validateTaskgenOutput } from "../server/task-generation-worker.js";
import { isSafeEvidenceUrlLiteral } from "../server/task-review-worker.js";

assert.equal(taskStatusTab(TASK_STATUS.verificationRequested), TASK_TABS.verification);
assert.equal(taskRequiresRefresh(TASK_STATUS.verificationRequested), true);
assert.equal(taskLifecycleActions(TASK_STATUS.verificationRequested).canSubmitVerificationEvidence, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).canAccept, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).canRefuse, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).canStop, true);
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).stopAction, "refuse");
assert.equal(taskLifecycleActions(TASK_STATUS.proposed).stopLabel, "Refuse task");
assert.equal(statusFromRewardAmount("2.50"), TASK_STATUS.rewarded);
assert.equal(statusFromRewardAmount("0"), TASK_STATUS.rewarded);

const taskgenBase = {
  schema: "pf.taskgen.output.v1",
  title: "Build deterministic task taxonomy check",
  description: "Produce a compact artifact showing task type normalization.",
  task_kind: "engineering",
  steps: ["Create the fixture.", "Run the check."],
  submission_requirement: { type: "text", criteria: "Submit the result." },
  verification_policy: { followup_required: true, mode: "standard_followup", verification_type: "text" },
  reward_offer: { amount_estimate_pft: "3.2" },
  deadline: { accept_by: "2026-05-26T00:00:00.000Z", deadline_at: null },
};
assert.equal(validateTaskgenOutput(taskgenBase).task_kind, "personal");
assert.equal(validateTaskgenOutput({ ...taskgenBase, task_kind: "alpha" }).task_kind, "alpha");
assert.equal(validateTaskgenOutput(taskgenBase, { task_class: "network" }).task_kind, "network");
const normalizedRelativeDeadline = validateTaskgenOutput({
  ...taskgenBase,
  deadline: { accept_by: "24h", deadline_at: "tomorrow" },
}).deadline;
assert.equal(Number.isFinite(Date.parse(normalizedRelativeDeadline.accept_by)), true);
assert.equal(normalizedRelativeDeadline.deadline_at, null);
assert.deepEqual(taskgenPromptForInput({ request: { requestText: "Build a personal task" } }), {
  path: "task_engine/taskgen_personal_v1.md",
  version: "taskgen_personal_v1",
});
assert.deepEqual(taskgenPromptForInput({
  request: { requestText: "Network Task", requestedTaskKind: "network" },
  network_task: { project_id: "project_1", project_need_summary: "Patch a named surface." },
  policy: { task_class: "network" },
}), {
  path: "task_engine/taskgen_network_v1.md",
  version: "taskgen_network_v1",
});
assert.equal(isSafeEvidenceUrlLiteral("https://example.com/proof").ok, true);
assert.equal(isSafeEvidenceUrlLiteral("file:///etc/passwd").reason, "unsupported_protocol");
assert.equal(isSafeEvidenceUrlLiteral("http://localhost:5174").reason, "localhost_not_allowed");
assert.equal(isSafeEvidenceUrlLiteral("http://127.0.0.1:5174").reason, "private_ip_not_allowed");
assert.equal(isSafeEvidenceUrlLiteral("http://169.254.169.254/latest/meta-data").reason, "private_ip_not_allowed");
assert.equal(isSafeEvidenceUrlLiteral("https://user:pass@example.com").reason, "credentials_not_allowed");

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
