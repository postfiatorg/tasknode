import assert from "node:assert/strict";
import { buildTaskCopyPayloads } from "../src/features/tasks/task-copy-format.js";

const acceptedTask = {
  taskId: "task_copy_accepted",
  title: "Instrument task copy interactions",
  kind: "Engineering",
  status: "Accepted",
  fullDue: "May 22",
  pft: 2.5,
  description: "Add a deterministic copy path for task cards.",
  steps: ["Add explicit copy controls.", "Verify useful copied formatting."],
  verification: { body: "Submit screenshots and copied text output." },
  metadata: { requestId: "req_copy_smoke" },
};

const rewardedTask = {
  taskId: "task_copy_rewarded",
  title: "Ship task copy modal",
  kind: "Engineering",
  status: "Rewarded",
  fullDue: "May 22",
  pft: 1.25,
  description: "Finish the copy loop and acknowledge copied state.",
  verification: { body: "Show the copied modal in the running app." },
};

const accepted = buildTaskCopyPayloads(acceptedTask);
assert.equal(accepted.title, acceptedTask.title);
assert.match(accepted.summary, /Status: Accepted/);
assert.match(accepted.summary, /Reward: 2.5 PFT/);
assert.match(accepted.full, /Task ID: task_copy_accepted/);
assert.match(accepted.full, /1\. Add explicit copy controls\./);
assert.match(accepted.full, /Verification\nSubmit screenshots and copied text output\./);
assert.match(accepted.codex, /Task for Codex/);
assert.match(accepted.codex, /Objective\nAdd a deterministic copy path for task cards\./);
assert.match(accepted.codex, /Steps\n1\. Add explicit copy controls\./);
assert.match(accepted.codex, /Verification Requirements\nSubmit screenshots and copied text output\./);
assert.match(accepted.codex, /Requested Output/);

const rewarded = buildTaskCopyPayloads(rewardedTask);
assert.match(rewarded.summary, /Status: Rewarded/);
assert.match(rewarded.summary, /Reward: 1.25 PFT/);
assert.match(rewarded.full, /Ship task copy modal/);

const verificationRequested = buildTaskCopyPayloads(acceptedTask, {
  currentVerificationRequest: {
    body: "Provide the exact code diff and test output.",
    reason: "The first submission did not include test evidence.",
  },
});
assert.match(verificationRequested.codex, /Current Verification Request\nProvide the exact code diff and test output\./);
assert.match(verificationRequested.codex, /Reason: The first submission did not include test evidence\./);

for (const payloads of [accepted, rewarded, verificationRequested]) {
  for (const value of Object.values(payloads)) {
    assert.equal(value.includes("undefined"), false);
    assert.equal(value.includes("[object Object]"), false);
  }
}

console.log("task copy payload smoke ok");
