import assert from "node:assert/strict";
import { assessTaskIntent, validateTaskIntentAssessment } from "../server/task-intent-assessment.js";
import { normalizedIntentText } from "../server/repositories/network-task-generation-source.js";

const priorTasks = [{ task_id: "task_report", status: "rewarded", title: "Audit retry failures", description: "Deliver a report identifying the causes of duplicate task requests." }];
const valid = { relationship: "continuation", priorTaskIds: ["task_report"], reason: "The prior task delivered an audit; this task delivers a patch and regression evidence.", newOutput: "Implement immutable request receipts and demonstrate retry safety.", actionable: true, scopeClear: true };
assert.deepEqual(validateTaskIntentAssessment(valid, priorTasks), valid);
assert.throws(() => validateTaskIntentAssessment({ ...valid, priorTaskIds: ["task_invented"] }, priorTasks));
assert.throws(() => validateTaskIntentAssessment({ ...valid, newOutput: "" }, priorTasks));
assert.throws(() => validateTaskIntentAssessment({ ...valid, relationship: "duplicate", priorTaskIds: [] }, priorTasks));
assert.notEqual(normalizedIntentText("Research the report"), normalizedIntentText("Research about the report"));
assert.notEqual(normalizedIntentText("Evaluate long-only holdings"), normalizedIntentText("Do not evaluate long-only holdings"));
let calls = 0;
for (const need of ["Implement the retry fix described in the audit.", "Turn the findings into a working patch with regression evidence."]) {
  const result = await assessTaskIntent({ need, priorTasks }, { complete: async (request) => {
    calls += 1;
    assert.equal(request.body.response_format.json_schema.strict, true);
    assert.equal(JSON.parse(request.body.messages[1].content).need, need);
    return { body: { choices: [{ message: { content: JSON.stringify(valid) } }] }, model: "fixture", provider: "fixture" };
  } });
  assert.equal(result.relationship, "continuation");
}
const invalid = await assessTaskIntent({ need: "A task", priorTasks }, { complete: async () => ({ body: { choices: [{ message: { content: "unstructured prose" } }] } }) });
assert.equal(invalid.relationship, "uncertain"); assert.equal(invalid.actionable, false);
console.log(JSON.stringify({ ok: true, classifierCallsForParaphrases: calls, inventedReferencesRejected: true, malformedResponseConservative: true, note: "Contract fixture; live semantic accuracy is a separate evaluation." }));
