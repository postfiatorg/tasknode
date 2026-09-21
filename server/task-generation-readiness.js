import { INFERENCE_MODELS, inferenceChatCompletion } from "./inference.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";

const READINESS_VERSION = "taskgen_readiness_v2";
const PROMPT_PATH = "task_engine/taskgen_readiness_v1.md";
const FLAGS = ["actionable_task", "actionable_submission", "consistent_scope"];

function candidateForReview(output) {
  return {
    title: output.title,
    description: output.description,
    steps: output.steps,
    submission_requirement: output.submission_requirement,
  };
}

export function taskGenerationReadinessIsCurrent(output, readiness) {
  return readiness?.approved === true &&
    readiness.version === READINESS_VERSION &&
    readiness.promptDigest === promptDigest(loadPrompt(PROMPT_PATH)) &&
    readiness.candidateDigest === promptDigest(JSON.stringify(candidateForReview(output)));
}

function invalidReview(detail, message = "taskgen_readiness_invalid") {
  return Object.assign(new Error(message), {
    code: "TASKGEN_PROVIDER_OUTPUT_INVALID",
    validationError: detail,
  });
}

export async function reviewTaskGenerationReadiness(output, { fetchImpl = fetch } = {}) {
  const prompt = loadPrompt(PROMPT_PATH);
  const candidate = candidateForReview(output);
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    throw invalidReview("taskgen_readiness_steps_missing");
  }
  const completion = await inferenceChatCompletion({
    fetchImpl,
    capability: "strict_json",
    timeoutMs: 45_000,
    totalTimeoutMs: 60_000,
    body: {
      model: INFERENCE_MODELS.instantText,
      max_tokens: 8192,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify(candidate) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "taskgen_readiness",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              actionable_task: { type: "boolean" },
              actionable_submission: { type: "boolean" },
              consistent_scope: { type: "boolean" },
              step_reviews: {
                type: "array",
                minItems: candidate.steps.length,
                maxItems: candidate.steps.length,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    step_index: { type: "integer", minimum: 1, maximum: candidate.steps.length },
                    actionable: { type: "boolean" },
                    reason: { type: "string", minLength: 1, maxLength: 500 },
                  },
                  required: ["step_index", "actionable", "reason"],
                },
              },
            },
            required: [...FLAGS, "step_reviews"],
          },
        },
      },
    },
  }).catch((error) => {
    if (error?.code === "inference_response_truncated") {
      throw invalidReview("taskgen_readiness_truncated");
    }
    throw error;
  });
  if (completion.body?.choices?.[0]?.finish_reason === "length") {
    throw invalidReview("taskgen_readiness_truncated");
  }
  let result;
  try { result = JSON.parse(completion.body?.choices?.[0]?.message?.content || ""); }
  catch { throw invalidReview("taskgen_readiness_not_json"); }
  if (!result || Array.isArray(result) || typeof result !== "object" ||
    Object.keys(result).length !== FLAGS.length + 1 ||
    FLAGS.some((field) => typeof result[field] !== "boolean") ||
    !Array.isArray(result.step_reviews) || result.step_reviews.length !== candidate.steps.length ||
    result.step_reviews.some((review, index) =>
      !review || Array.isArray(review) || typeof review !== "object" ||
      Object.keys(review).length !== 3 || review.step_index !== index + 1 ||
      typeof review.actionable !== "boolean" || typeof review.reason !== "string" ||
      !review.reason.trim() || review.reason.length > 500
    )) {
    throw invalidReview("taskgen_readiness_incomplete_review");
  }
  const rejectedSteps = result.step_reviews.filter((review) => !review.actionable).map((review) => review.step_index);
  const rejectedFlags = FLAGS.filter((field) => !result[field]);
  if (rejectedSteps.length || rejectedFlags.length) {
    throw invalidReview(
      `taskgen_readiness_rejected: steps=[${rejectedSteps.join(",")}]; checks=[${rejectedFlags.join(",")}]`,
      "taskgen_offer_not_actionable"
    );
  }
  return {
    approved: true,
    version: READINESS_VERSION,
    model: completion.model,
    provider: completion.provider,
    promptDigest: promptDigest(prompt),
    candidateDigest: promptDigest(JSON.stringify(candidate)),
    stepReviews: result.step_reviews,
  };
}
