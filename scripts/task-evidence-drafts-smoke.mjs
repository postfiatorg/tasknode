import assert from "node:assert/strict";
import {
  addUserRequestedEvidenceDraft,
  evidenceDraftStateHasUserInput,
  evidenceDraftIsReady,
  evidenceMethodFromContract,
  evidenceValueForDraft,
  MAX_TASK_EVIDENCE_ITEMS,
  restoreEvidenceDraftState,
  resetEvidenceDrafts,
  serializeEvidenceDraftState,
  taskEvidenceDraftStorageKey,
} from "../src/features/tasks/task-evidence-drafts.js";

const screenshotDefault = resetEvidenceDrafts("screenshot");
assert.equal(screenshotDefault.length, 1);
assert.equal(screenshotDefault[0].method, "screenshot");
assert.equal(evidenceValueForDraft(screenshotDefault[0]), "");
assert.equal(evidenceDraftIsReady(screenshotDefault[0]), false);

const typedFirstEvidence = [{ ...screenshotDefault[0], screenshot: "proof.png" }];
const withSecond = addUserRequestedEvidenceDraft(typedFirstEvidence, "text");
assert.equal(withSecond.length, 2);
assert.equal(withSecond[0].method, "screenshot");
assert.equal(withSecond[0].screenshot, "proof.png");
assert.equal(evidenceDraftIsReady(withSecond[0]), false, "screenshot filenames without processed file data are not ready");
assert.equal(withSecond[1].method, "text");
assert.equal(evidenceValueForDraft(withSecond[1]), "");
assert.equal(evidenceDraftIsReady({ ...withSecond[0], screenshotFile: { name: "proof.png" } }), true);
assert.equal(evidenceDraftIsReady({ ...withSecond[1], text: "second evidence body" }), true);

const capped = addUserRequestedEvidenceDraft(withSecond, "url");
assert.equal(capped.length, MAX_TASK_EVIDENCE_ITEMS);
assert.deepEqual(capped, withSecond);

assert.equal(evidenceMethodFromContract({ submissionRequirement: { type: "mixed" } }), "mixed");
const mixedDrafts = resetEvidenceDrafts("mixed");
assert.equal(mixedDrafts.length, 1);
assert.equal(mixedDrafts[0].method, "text");
const mixedWithSecond = addUserRequestedEvidenceDraft([{ ...mixedDrafts[0], text: "proof" }], "mixed");
assert.equal(mixedWithSecond.length, 2);
assert.equal(mixedWithSecond[1].method, "screenshot");
assert.equal(evidenceMethodFromContract({ submissionRequirement: { type: "github_commit" } }), "commit");
assert.equal(evidenceMethodFromContract({}, { policy: { verification_type: "screenshot" } }), "screenshot");

const storageKey = taskEvidenceDraftStorageKey({
  accountId: "acct_test",
  taskId: "task_test",
  submissionModeKey: "initial:task_test",
});
assert.equal(
  storageKey,
  "tasknode_task_evidence_drafts_v1:acct_test:task_test:initial%3Atask_test"
);

const typedDraftState = {
  evidenceDrafts: [
    { ...resetEvidenceDrafts("text")[0], text: "This is the evidence I do not want to lose." },
    { ...resetEvidenceDrafts("url")[0], method: "url", url: "https://example.com/proof" },
  ],
  notes: "Verifier note",
};
assert.equal(evidenceDraftStateHasUserInput(typedDraftState), true);
const serialized = serializeEvidenceDraftState(typedDraftState);
const restored = restoreEvidenceDraftState(JSON.stringify(serialized), "text");
assert.equal(restored.evidenceDrafts.length, 2);
assert.equal(restored.evidenceDrafts[0].method, "text");
assert.equal(restored.evidenceDrafts[0].text, "This is the evidence I do not want to lose.");
assert.equal(restored.evidenceDrafts[1].method, "url");
assert.equal(restored.evidenceDrafts[1].url, "https://example.com/proof");
assert.equal(restored.notes, "Verifier note");

const fileDraftState = serializeEvidenceDraftState({
  evidenceDrafts: [
    { ...resetEvidenceDrafts("file")[0], fileName: "local-only.pdf", file: { name: "local-only.pdf" } },
  ],
});
const restoredFile = restoreEvidenceDraftState(fileDraftState, "file");
assert.equal(restoredFile.evidenceDrafts[0].method, "file");
assert.equal(restoredFile.evidenceDrafts[0].fileName, "");
assert.equal(evidenceValueForDraft(restoredFile.evidenceDrafts[0]), "");

console.log("task evidence drafts smoke ok");
