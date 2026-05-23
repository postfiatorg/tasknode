import assert from "node:assert/strict";
import {
  addUserRequestedEvidenceDraft,
  evidenceMethodFromContract,
  evidenceValueForDraft,
  MAX_TASK_EVIDENCE_ITEMS,
  resetEvidenceDrafts,
} from "../src/features/tasks/task-evidence-drafts.js";

const screenshotDefault = resetEvidenceDrafts("screenshot");
assert.equal(screenshotDefault.length, 1);
assert.equal(screenshotDefault[0].method, "screenshot");
assert.equal(evidenceValueForDraft(screenshotDefault[0]), "");

const typedFirstEvidence = [{ ...screenshotDefault[0], screenshot: "proof.png" }];
const withSecond = addUserRequestedEvidenceDraft(typedFirstEvidence, "text");
assert.equal(withSecond.length, 2);
assert.equal(withSecond[0].method, "screenshot");
assert.equal(withSecond[0].screenshot, "proof.png");
assert.equal(withSecond[1].method, "text");
assert.equal(evidenceValueForDraft(withSecond[1]), "");

const capped = addUserRequestedEvidenceDraft(withSecond, "url");
assert.equal(capped.length, MAX_TASK_EVIDENCE_ITEMS);
assert.deepEqual(capped, withSecond);

assert.equal(evidenceMethodFromContract({ submissionRequirement: { type: "mixed" } }), "text");
assert.equal(evidenceMethodFromContract({ submissionRequirement: { type: "github_commit" } }), "commit");
assert.equal(evidenceMethodFromContract({}, { policy: { verification_type: "screenshot" } }), "screenshot");

console.log("task evidence drafts smoke ok");
