const DEFAULT_VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const TEAM_CONTEXT_VERCEL_MODEL = "zai/glm-5.3-flash";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function vercelAiGatewayApiKey(env = process.env) {
  return safeText(env.VERCEL_AI_GATEWAY_API_KEY || env.AI_GATEWAY_API_KEY, 10000);
}

export function vercelAiGatewayConfigured(env = process.env) {
  return Boolean(vercelAiGatewayApiKey(env));
}

export function vercelAiGatewayBaseUrl(env = process.env) {
  const configured = safeText(env.VERCEL_AI_GATEWAY_BASE_URL, 1000);
  let value = configured || DEFAULT_VERCEL_AI_GATEWAY_BASE_URL;
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

export async function vercelChatCompletion({
  messages = [],
  model = TEAM_CONTEXT_VERCEL_MODEL,
  maxTokens = 1800,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 45_000,
} = {}) {
  const apiKey = vercelAiGatewayApiKey(env);
  if (!apiKey) throw Object.assign(new Error("vercel_ai_gateway_key_missing"), { code: "vercel_ai_gateway_key_missing" });
  const timeout = timeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(`${vercelAiGatewayBaseUrl(env)}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: Math.max(400, Number(maxTokens) || 1800),
      }),
      signal: timeout.signal,
    });
    const bodyText = await response.text();
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw Object.assign(new Error("vercel_ai_gateway_invalid_json"), { code: "vercel_ai_gateway_invalid_json" });
    }
    if (!response.ok || body?.error) {
      const detail = safeText(body?.error?.message || body?.message || `HTTP ${response.status}`, 500);
      throw Object.assign(new Error(`vercel_ai_gateway_request_failed:${detail}`), {
        code: "vercel_ai_gateway_request_failed",
        status: response.status,
      });
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(new Error("vercel_ai_gateway_timeout"), { code: "vercel_ai_gateway_timeout" });
    }
    throw error;
  } finally {
    timeout.clear();
  }
}
