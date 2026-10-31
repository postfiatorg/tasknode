import assert from "node:assert/strict";
import test from "node:test";
import { verificationRequestStallSeconds, verificationRequestStatus } from "../server/task-verification-view.js";

const nowMs = Date.parse("2026-10-31T12:00:00.000Z");
const recent = "2026-10-31T11:50:00.000Z";
const old = "2026-10-31T10:00:00.000Z";

function status(overrides = {}) {
  return verificationRequestStatus({ status: "submitted", submittedAt: recent, nowMs, stallSeconds: 3600, ...overrides });
}

test("only submitted tasks report a pending verification request", () => {
  for (const value of ["accepted", "verification_requested", "verification_response_submitted", "rewarded", "", null]) {
    assert.equal(status({ status: value }), null);
  }
});

test("a fresh submission is queued, not stalled", () => {
  assert.deepEqual(status(), {
    phase: "queued",
    stalled: false,
    failureCount: 0,
    lastErrorCode: "",
    retryAfter: null,
    submittedAt: recent,
    message: "Task Node is generating the verification request for this submission.",
  });
});

test("worker phases map from the projection's worker state", () => {
  assert.equal(status({ worker: { processing: "true" } }).phase, "processing");
  assert.equal(status({ worker: { published: "true", processing: "false" } }).phase, "published");
  const waiting = status({ worker: { last_error: "awaiting_agent_verification_request", wait_count: 5 } });
  assert.equal(waiting.phase, "awaiting_agent");
  assert.equal(waiting.lastErrorCode, "");
  const retrying = status({
    worker: { last_error: "task_review_missing_offer_or_submission", retry_count: 1, retry_after: "2026-10-31T12:01:00Z" },
  });
  assert.equal(retrying.phase, "retrying");
  assert.equal(retrying.stalled, false);
  assert.equal(retrying.lastErrorCode, "task_review_missing_offer_or_submission");
  assert.equal(retrying.retryAfter, "2026-10-31T12:01:00.000Z");
});

test("repeated failures or an overdue submission mark the request stalled", () => {
  const failing = status({ worker: { last_error: "task_authority_seed_missing", retry_count: 3 } });
  assert.equal(failing.stalled, true);
  assert.match(failing.message, /do not resubmit or cancel/);
  assert.equal(status({ submittedAt: old }).stalled, true);
  assert.equal(status({ submittedAt: old, worker: { last_error: "awaiting_agent_verification_request" } }).stalled, true);
  assert.equal(status({ submittedAt: old, worker: { published: "true" } }).stalled, false);
  assert.equal(status({ submittedAt: null }).stalled, false, "an unknown submit time is not overdue");
});

test("provider error text is reduced to a generic code", () => {
  const leaked = status({ worker: { last_error: "Provider 502 at https://internal.example/v1: key sk-abc", retry_count: 1 } });
  assert.equal(leaked.lastErrorCode, "verification_request_failed");
  assert.equal(JSON.stringify(leaked).includes("internal.example"), false);
});

test("the stall threshold is configurable within bounds", () => {
  assert.equal(verificationRequestStallSeconds({}), 3600);
  assert.equal(verificationRequestStallSeconds({ TASKNODE_VERIFICATION_REQUEST_STALL_SECONDS: "7200" }), 7200);
  assert.equal(verificationRequestStallSeconds({ TASKNODE_VERIFICATION_REQUEST_STALL_SECONDS: "1" }), 300);
  assert.equal(verificationRequestStallSeconds({ TASKNODE_VERIFICATION_REQUEST_STALL_SECONDS: "nope" }), 3600);
});
