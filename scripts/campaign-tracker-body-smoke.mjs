import assert from "node:assert/strict";
import { campaignTrackerBody } from "../server/request-body-contracts.js";
import { validateJsonDocument } from "../server/request-validation.js";

// Command-specific required fields and nested data remain owned by the tracker.
const envelopes = [
  { workspaceId: "fixture-workspace", enabled: true, apiKey: "fixture-subscription" },
  { event: { id: "fixture-event", prompts: [] }, apiKey: "fixture-subscription" },
  { title: "Fixture campaign", objective: "Verify attribution", memberHandles: ["fixture-member"], taskIds: ["fixture-task"] },
  { accountId: "fixture-account", id: "fixture-event", revision: 1, kind: "review", scores: { clarity: 3 }, note: "Fixture review" },
  { id: "fixture-event", revision: 1, kind: "mapping", taskIds: ["fixture-task"], note: "Fixture mapping" },
  { handle: "fixture-member", capabilities: ["summary"], workspaceIds: ["fixture-workspace"], historyFrom: null, historyTo: null, expiresAt: "2026-09-10T00:00:00Z" },
  { grantId: "fixture-grant" },
  { id: "fixture-event" },
];
for (const envelope of envelopes) {
  assert.deepEqual(validateJsonDocument(envelope, campaignTrackerBody.schema), envelope);
  for (const unknown of ["unexpectedField", "accountOverride", "debugInstructions"]) {
    assert.throws(() => validateJsonDocument({ ...envelope, [unknown]: true }, campaignTrackerBody.schema), { message: "request_body_field_unknown" });
  }
}
console.log("Campaign Tracker body envelopes: all command shapes accepted; undeclared fields rejected");
