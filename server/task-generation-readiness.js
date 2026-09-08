import { INFERENCE_MODELS, inferenceChatCompletion } from "./inference.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";

export async function reviewTaskGenerationReadiness(output, { fetchImpl = fetch } = {}) {
  const prompt = loadPrompt("task_engine/taskgen_readiness_v1.md");
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
        { role: "user", content: JSON.stringify({ title: output.title, description: output.description, steps: output.steps, submission_requirement: output.submission_requirement }) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "taskgen_readiness", strict: true, schema: {
          type: "object", additionalProperties: false,
          properties: { actionable_task: { type: "boolean" }, actionable_submission: { type: "boolean" }, consistent_scope: { type: "boolean" } },
          required: ["actionable_task", "actionable_submission", "consistent_scope"],
        } },
      },
    },
  });
  let result;
  try { result = JSON.parse(completion.body?.choices?.[0]?.message?.content || ""); }
  catch { throw Object.assign(new Error("taskgen_readiness_invalid"), { code: "TASKGEN_PROVIDER_OUTPUT_INVALID" }); }
  const fields = ["actionable_task", "actionable_submission", "consistent_scope"];
  if (!result || Array.isArray(result) || typeof result !== "object" || Object.keys(result).length !== fields.length || fields.some((field) => result[field] !== true)) {
    throw Object.assign(new Error("taskgen_offer_not_actionable"), { code: "TASKGEN_PROVIDER_OUTPUT_INVALID" });
  }
  return { approved: true, model: completion.model, provider: completion.provider, promptDigest: promptDigest(prompt) };
}
