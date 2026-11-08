import assert from "node:assert/strict";
import { publicVerificationSummary } from "../server/repositories/hive-task-evidence-projection.js";

const request = (id, ask) => ({
  schema: "pf.task.verification_request.v1",
  rawPayload: {
    event_id: id,
    verification_request: { verification_ask: ask },
  },
});
const response = (id) => ({
  schema: "pf.task.verification_response.v1",
  rawPayload: { event_id: id },
});
const legacyRequest = (id, ask) => ({
  schema: "pf.task.update.v1",
  rawPayload: {
    event_id: id,
    transition: "verification_requested",
    verification_ask: ask,
  },
});

assert.deepEqual(publicVerificationSummary([request("r1", "First proof?")]), {
  request: "First proof?",
  response: "",
});
assert.deepEqual(publicVerificationSummary([
  request("r1", "First proof?"), response("s1"),
]), {
  request: "First proof?",
  response: "Verification response submitted.",
});
assert.deepEqual(publicVerificationSummary([
  request("r1", "First proof?"), response("s1"), request("r2", "New Discord proof?"),
]), {
  request: "New Discord proof?",
  response: "",
});
assert.deepEqual(publicVerificationSummary([
  request("r1", "First proof?"), response("s1"), request("r2", "New Discord proof?"), response("s2"),
]), {
  request: "New Discord proof?",
  response: "Verification response submitted.",
});
assert.deepEqual(publicVerificationSummary([
  request("r1", "First proof?"), response("s1"), legacyRequest("r2", "Legacy follow-up?"),
]), {
  request: "Legacy follow-up?",
  response: "",
});
assert.deepEqual(publicVerificationSummary([response("s1")]), {
  request: "",
  response: "Verification response submitted.",
});
console.log("verification-round-summary: 6 PASS");
