import { inferenceChatCompletion, INFERENCE_MODELS } from "./inference.js";
import { parseInferenceJson } from "./inference-text.js";
import { loadPrompt } from "./prompt-registry.js";

const decidePrompt = loadPrompt("hive/hive_group_decide_v1.md");
const replyPrompt = loadPrompt("hive/hive_group_reply_v1.md");
const schema = { type: "object", additionalProperties: false,
  required: ["respond","escalate","board_id","source_event_id","escalation_summary","reply_brief"], properties: {
    respond: { type: "boolean" }, escalate: { type: "boolean" }, board_id: { type: "string", maxLength: 100 },
    source_event_id: { type: "string", maxLength: 64 }, escalation_summary: { type: "string", maxLength: 1500 }, reply_brief: { type: "string", maxLength: 1500 },
  } };

export function validateHiveGroupDecision(value, context) {
  if (!value || Object.keys(value).length !== schema.required.length || schema.required.some(key => !Object.hasOwn(value,key)) ||
      typeof value.respond !== "boolean" || typeof value.escalate !== "boolean" ||
      ["board_id","source_event_id","escalation_summary","reply_brief"].some(key => typeof value[key] !== "string" || value[key].length > schema.properties[key].maxLength)) throw new Error("hive_group_decision_invalid");
  if (value.respond || value.escalate) {
    if (!context.messages.some(message => message.id === value.source_event_id && message.new && message.actor === "member")) throw new Error("hive_group_decision_source_invalid");
  }
  if (value.escalate && (!context.boards.some(board => board.id === value.board_id) || value.escalation_summary.trim().length < 12)) throw new Error("hive_group_decision_board_invalid");
  if (!value.escalate && (value.board_id || value.escalation_summary)) throw new Error("hive_group_decision_invalid");
  return value;
}

export async function decideHiveGroupParticipation({ context, env = process.env, complete = inferenceChatCompletion, signal }) {
  const result = await complete({ env: { ...env, INFERENCE_MODEL_STRUCTURED: INFERENCE_MODELS.instantText }, capability: "strict_json", signal,
    timeoutMs: 45_000, totalTimeoutMs: 60_000, body: {
      model: INFERENCE_MODELS.instantText, max_tokens: 8192,
      messages: [{ role: "system", content: decidePrompt }, { role: "user", content: JSON.stringify(context) }],
      response_format: { type: "json_schema", json_schema: { name: "hive_group_participation", strict: true, schema } },
    } });
  return { decision: validateHiveGroupDecision(parseInferenceJson(result.text), context), model: result.model };
}

export async function composeHiveGroupReply({ context, decision, env = process.env, complete = inferenceChatCompletion, signal }) {
  const result = await complete({ env: { ...env, INFERENCE_MODEL_REASONING: INFERENCE_MODELS.reasoningText }, capability: "reasoning_text", signal,
    timeoutMs: 150_000, totalTimeoutMs: 180_000, body: {
      model: INFERENCE_MODELS.reasoningText, max_tokens: 16384,
      messages: [{ role: "system", content: replyPrompt }, { role: "user", content: JSON.stringify({ context, decision, escalation: { queued: decision.escalate } }) }],
    } });
  const text = result.text?.trim();
  if (!text || text.length > 4000) throw new Error("hive_group_reply_invalid");
  return { text, model: result.model };
}
