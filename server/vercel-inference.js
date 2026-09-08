import { inferenceChatCompletion } from "./inference.js";
export { vercelAiGatewayApiKey, vercelAiGatewayBaseUrl, vercelAiGatewayConfigured } from "./inference-provider-config.js";
export const TEAM_CONTEXT_VERCEL_MODEL = "zai/glm-5.3-flash";

// Preserve Team Context's JSON contract while sharing the application failover policy.
export async function vercelChatCompletion({
  messages = [], model = TEAM_CONTEXT_VERCEL_MODEL, maxTokens = 1800,
  env = process.env, fetchImpl = fetch, timeoutMs = 45_000,
} = {}) {
  let result;
  try { result = await inferenceChatCompletion({
    body: { model, messages, response_format: { type: "json_object" }, temperature: 0.1,
      max_tokens: Math.max(400, Number(maxTokens) || 1800) },
    capability: "instant_text", env, fetchImpl, timeoutMs,
  }); } catch (error) {
    if (error.code === "inference_response_truncated") throw Object.assign(new Error("team_context_response_truncated"), { cause: error });
    throw error;
  }
  return result.body;
}
