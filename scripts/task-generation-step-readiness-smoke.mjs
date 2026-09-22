import assert from "node:assert/strict";

process.env.AMBIENT_API_KEY = "readiness-fixture-key";
delete process.env.VERCEL_AI_GATEWAY_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
process.env.TASKNODE_INFERENCE_PROVIDER = "ambient";

const { reviewTaskGenerationReadiness, taskGenerationReadinessIsCurrent } = await import("../server/task-generation-readiness.js");

const candidate = {
  title: "Verify the task contract",
  description: "Inspect the task contract and record the validation result.",
  steps: ["Inspect submission_requirement.type in the saved task.", "Record whether the contract matches the documented schema."],
  submission_requirement: { type: "text", criteria: "Submit the validation result and any mismatches." },
};
function verdict(steps, rejected = []) {
  return {
    actionable_task: true, actionable_submission: true, consistent_scope: true,
    step_reviews: steps.map((_step, index) => ({
      step_index: index + 1, actionable: !rejected.includes(index + 1),
      reason: rejected.includes(index + 1) ? "Label or placeholder without a contributor action." : "Concrete contributor action.",
    })),
  };
}
async function review(output, response, finishReason = "stop") {
  return reviewTaskGenerationReadiness(output, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const schema = body.response_format.json_schema.schema;
      assert.equal(schema.properties.step_reviews.minItems, output.steps.length);
      assert.equal(schema.properties.step_reviews.maxItems, output.steps.length);
      assert.deepEqual(JSON.parse(body.messages[1].content), output);
      return Response.json({ choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(response) } }] });
    },
  });
}
const approved = await review(candidate, verdict(candidate.steps));
assert.equal(taskGenerationReadinessIsCurrent(candidate, approved), true);
assert.equal(taskGenerationReadinessIsCurrent(candidate, { approved: true }), false);
assert.equal(taskGenerationReadinessIsCurrent(candidate, { ...approved, promptDigest: "older-prompt" }), false);
assert.equal(taskGenerationReadinessIsCurrent({ ...candidate, steps: [...candidate.steps, "deadline"] }, approved), false);

for (const junk of [
  ["submission_requirement.type", "submission_requirement.criteria", "verification_policy", "reward_offer", "deadline", "deadline.deadline_at"],
  ["Evidence settings", "To be determined", "The required output"],
]) {
  const output = { ...candidate, steps: [...candidate.steps, ...junk] };
  const rejected = junk.map((_item, index) => candidate.steps.length + index + 1);
  // Even an approving overall verdict cannot override a rejected individual step.
  await assert.rejects(review(output, verdict(output.steps, rejected)),
    (error) => error.code === "TASKGEN_PROVIDER_OUTPUT_INVALID" &&
      error.validationError.includes(`steps=[${rejected.join(",")}]`));
}

const valid = verdict(candidate.steps);
for (const response of [
  { actionable_task: true, actionable_submission: true, consistent_scope: true },
  { ...valid, step_reviews: valid.step_reviews.slice(0, 1) },
  { ...valid, step_reviews: [valid.step_reviews[0], valid.step_reviews[0]] },
  { ...valid, step_reviews: [...valid.step_reviews].reverse() },
  { ...valid, step_reviews: valid.step_reviews.map((item) => ({ ...item, actionable: "true" })) },
  { ...valid, step_reviews: valid.step_reviews.map((item) => ({ ...item, reason: "" })) },
  { ...valid, extra: true },
]) {
  await assert.rejects(review(candidate, response),
    (error) => error.validationError === "taskgen_readiness_incomplete_review");
}
for (const flag of ["actionable_task", "actionable_submission", "consistent_scope"]) {
  await assert.rejects(review(candidate, { ...valid, [flag]: false }),
    (error) => error.validationError.includes(flag));
}
await assert.rejects(review(candidate, valid, "length"),
  (error) => error.validationError === "taskgen_readiness_truncated");
console.log("task-generation step readiness smoke passed: per-step coverage, mixed-quality offers, malformed reviews, legitimate field instructions, stale approvals");
