import assert from "node:assert/strict";
import { assessTaskIntent, normalizeTaskIntentAssessment, taskIntentFailureFamily, validateTaskIntentAssessment } from "../server/task-intent-assessment.js";
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
{
  let calls = 0;
  await assert.rejects(assessTaskIntent({ need: "A task", priorTasks }, { complete: async () => { calls += 1; return { body: { choices: [{ message: { content: "unstructured prose" }, finish_reason: "stop" }] } }; } }),
    error => error.code === "network_task_intent_contract_failed" && error.causeCode === "task_intent_assessment_json_invalid" && error.retryable === false);
  assert.equal(calls, 2);
}
// The classifier's actual production output on 2026-09-21 (job nettaskjob_7a9fb8fb…):
// right verdict, wrong key, missing booleans. Normalization maps the key; the
// booleans are still required, so this goes to the repair turn and succeeds there.
const productionOutput = '{"classification":"independent","reason":"The request is a concrete, scoped bug fix (route crash on double-slash GET paths).","newOutput":"A code fix in the Task Node server route layer plus a regression test.","priorTaskIds":[]}';
assert.equal(normalizeTaskIntentAssessment(JSON.parse(productionOutput)).relationship, "independent");
assert.ok(!("actionable" in normalizeTaskIntentAssessment(JSON.parse(productionOutput))), "normalization never invents actionable/scopeClear");
{
  let calls = 0;
  const repaired = await assessTaskIntent({ need: "Fix the double-slash crash", priorTasks }, { complete: async ({ body }) => {
    calls += 1;
    assert.ok(body.messages[0].content.includes('"relationship" (one of'), "the prompt names the contract");
    if (calls === 1) return { body: { choices: [{ message: { content: productionOutput }, finish_reason: "stop" }] }, model: "fixture", provider: "fixture" };
    assert.equal(body.messages.at(-2).content, productionOutput, "the repair turn shows the model its own output");
    return { body: { choices: [{ message: { content: JSON.stringify({ classification: "independent", prior_task_ids: [], reason: "Distinct.", new_output: "A fix.", actionable: "true", scope_clear: true }) }, finish_reason: "stop" }] }, model: "fixture", provider: "fixture" };
  } });
  assert.equal(calls, 2);
  assert.deepEqual([repaired.relationship, repaired.actionable, repaired.scopeClear, repaired.repairAttempted], ["independent", true, true, true]);
  assert.equal(repaired.rawAttempts.length, 2);
}
// Aliased but complete output needs no repair call at all.
{
  let calls = 0;
  const direct = await assessTaskIntent({ need: "A task", priorTasks }, { complete: async () => { calls += 1; return { body: { choices: [{ message: { content: JSON.stringify({ verdict: "continuation", priorTasks: ["task_report"], rationale: "Next artifact.", deliverable: "A patch.", is_actionable: true, scope_clear: "yes" }) } }] } }; } });
  assert.equal(calls, 1);
  assert.deepEqual([direct.relationship, direct.priorTaskIds, direct.actionable, direct.scopeClear], ["continuation", ["task_report"], true, true]);
}
// Provider failures keep their family and stay retryable; unknown references are contract failures.
await assert.rejects(assessTaskIntent({ need: "A task", priorTasks }, { complete: async () => { throw Object.assign(new Error("inference_response_truncated"), { code: "inference_response_truncated", status: 422 }); } }),
  error => error.code === "network_task_intent_assessment_failed" && error.family === "provider" && error.retryable);
assert.equal(taskIntentFailureFamily({ code: "network_task_intent_needs_review" }), "semantic");
assert.equal(taskIntentFailureFamily({ code: "network_task_intent_assessment_failed", causeCode: "inference_timeout" }), "provider");
assert.equal(taskIntentFailureFamily({ code: "network_task_intent_assessment_failed", causeCode: "task_intent_assessment_schema_invalid" }), "contract");
console.log(JSON.stringify({ ok: true, classifierCallsForParaphrases: calls, inventedReferencesRejected: true, malformedResponseConservative: true, note: "Contract fixture; live semantic accuracy is a separate evaluation." }));
