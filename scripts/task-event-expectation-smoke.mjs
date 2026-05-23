import assert from "node:assert/strict";
import { taskEventExpectation } from "../server/task-event-meaning.js";

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

console.log("task event expectation smoke ok");
