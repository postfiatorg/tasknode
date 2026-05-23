import assert from "node:assert/strict";
import { taskEventExpectation, taskEventMeaning } from "../server/task-event-meaning.js";

const submittedAwaitingReview = taskEventExpectation({
  status: "submitted",
  timeline: [
    {
      schema: "pf.task.submission.v1",
      rawPayload: { schema: "pf.task.submission.v1", phase: "initial_submission" },
    },
  ],
});
assert.equal(submittedAwaitingReview?.severity, "warning");
assert.equal(submittedAwaitingReview?.label, "Awaiting authority review");

const submittedAfterVerificationRequest = taskEventExpectation({
  status: "verification_requested",
  timeline: [
    { schema: "pf.task.submission.v1", rawPayload: { schema: "pf.task.submission.v1" } },
    {
      schema: "pf.task.update.v1",
      rawPayload: { schema: "pf.task.update.v1", transition: "verification_requested" },
    },
  ],
});
assert.equal(submittedAfterVerificationRequest, null);

const verificationResponseAwaitingReview = taskEventExpectation({
  status: "verification_response_submitted",
  timeline: [
    {
      schema: "pf.task.verification_response.v1",
      rawPayload: { schema: "pf.task.verification_response.v1" },
    },
  ],
});
assert.equal(verificationResponseAwaitingReview?.label, "Awaiting Task Node review");

assert.equal(
  taskEventMeaning("pf.task.verification_response.v1", {}),
  "The user responded to the verification request."
);
assert.equal(
  taskEventMeaning("pf.task.submission.v1", { phase: "verification_response" }),
  "The user submitted initial task evidence."
);

console.log("task event expectation smoke ok");
