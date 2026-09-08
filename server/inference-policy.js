export const INFERENCE_MODELS = Object.freeze({
  instantText: "zai/glm-5.3-flash",
  fastText: "deepseek/deepseek-v4-flash-0731",
  reasoningText: "zai/glm-5.3",
  structured: "zai/glm-5.3",
  research: "zai/glm-5.3",
  vision: "moonshotai/kimi-k2.7-code",
});

const models = new Map([
  ["openai/gpt-6-astra", { ambient: "", image: true }],
  ["moonshotai/kimi-k3", { ambient: "", image: true }],
  [INFERENCE_MODELS.instantText, { ambient: "z-ai/glm-5.2", image: true }],
  [INFERENCE_MODELS.reasoningText, { ambient: "z-ai/glm-5.2", image: false }],
  [INFERENCE_MODELS.fastText, { ambient: "z-ai/glm-5.2", image: false }],
  [INFERENCE_MODELS.vision, { ambient: "google/gemma-4-26b-a4b-it", image: true }],
]);
const aliases = new Map([
  ["z-ai/glm-5.2", INFERENCE_MODELS.reasoningText],
  ["zai/glm-5.2", INFERENCE_MODELS.reasoningText],
  ["glm-5.2", INFERENCE_MODELS.reasoningText],
  ["z-ai/glm-5.3", INFERENCE_MODELS.reasoningText],
  ["glm-5.3", INFERENCE_MODELS.reasoningText],
  ["z-ai/glm-5.3-flash", INFERENCE_MODELS.instantText],
  ["glm-5.3-flash", INFERENCE_MODELS.instantText],
  ["deepseek/deepseek-v4-flash", INFERENCE_MODELS.fastText],
  ["deepseek-v4-flash", INFERENCE_MODELS.fastText],
  ["chat-latest", INFERENCE_MODELS.structured],
]);
const capabilities = Object.freeze({
  instant_text: ["INFERENCE_MODEL_INSTANT", "", INFERENCE_MODELS.instantText],
  fast_text: ["INFERENCE_MODEL_FAST_TEXT", "AMBIENT_MODEL_FAST_TEXT", INFERENCE_MODELS.fastText],
  reasoning_text: ["INFERENCE_MODEL_REASONING", "AMBIENT_MODEL_REASONING", INFERENCE_MODELS.reasoningText],
  strict_json: ["INFERENCE_MODEL_STRUCTURED", "AMBIENT_MODEL_STRUCTURED", INFERENCE_MODELS.structured],
  research_text: ["INFERENCE_MODEL_RESEARCH", "AMBIENT_MODEL_RESEARCH", INFERENCE_MODELS.research],
  vision_text: ["INFERENCE_MODEL_VISION", "AMBIENT_MODEL_VISION", INFERENCE_MODELS.vision],
  verification_vision: ["INFERENCE_MODEL_VISION", "AMBIENT_MODEL_VISION", INFERENCE_MODELS.vision],
});

export function inferenceError(code, { status = 502, provider = "", cause } = {}) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code, status, provider });
}

export function cleanConfig(value = "") {
  let text = String(value || "").trim();
  const quotes = new Set(["'", '"', "‘", "’"]);
  while (quotes.has(text[0])) text = text.slice(1);
  while (quotes.has(text.at(-1))) text = text.slice(0, -1);
  return text.trim();
}

const modelCredentialNames = new Map([
  ["openai/gpt-6-astra", "VERCEL_ASTRA_API_KEY"],
  ["moonshotai/kimi-k3", "VERCEL_KIMI_API_KEY"],
]);

export function providerApiKey(provider, env = process.env, model = "") {
  if (provider === "vercel") {
    const name = modelCredentialNames.get(model);
    return (name ? cleanConfig(env[name]) : "") || cleanConfig(env.VERCEL_AI_GATEWAY_API_KEY) || cleanConfig(env.AI_GATEWAY_API_KEY);
  }
  if (provider === "ambient") return cleanConfig(env.AMBIENT_API_KEY);
  throw inferenceError("inference_provider_unsupported", { status: 400 });
}

export function providerBaseUrl(provider, env = process.env) {
  let value = provider === "vercel"
    ? cleanConfig(env.VERCEL_AI_GATEWAY_BASE_URL) || "https://ai-gateway.vercel.sh/v1"
    : provider === "ambient"
      ? cleanConfig(env.AMBIENT_BASE_URL) || "https://api.ambient.xyz/v1"
      : "";
  if (!value) throw inferenceError("inference_provider_unsupported", { status: 400 });
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

export function inferenceProviderConfigured(provider, env = process.env, model = "") {
  return Boolean(providerApiKey(provider, env, model));
}

export function inferenceConfigured(env = process.env) {
  return inferenceProviderConfigured("vercel", env) ||
    (env.INFERENCE_AMBIENT_BACKUP_ENABLED !== "false" && inferenceProviderConfigured("ambient", env));
}

export function inferenceRoutes(env = process.env, model = "") {
  return ["vercel", ...(env.INFERENCE_AMBIENT_BACKUP_ENABLED !== "false" ? ["ambient"] : [])]
    .filter((provider) => inferenceProviderConfigured(provider, env, model));
}

export function canonicalModel(model) {
  const value = cleanConfig(model);
  const resolved = aliases.get(value) || value;
  if (!models.has(resolved)) throw inferenceError("inference_model_unsupported", { status: 400 });
  return resolved;
}

export function resolveInferenceModel({ model = "", capability = "reasoning_text", env = process.env, hasImages = false } = {}) {
  // A user-selected model is an exact contract, independent of operator defaults.
  if (capability === "selected_model") {
    const selected = canonicalModel(model);
    if (hasImages && !models.get(selected).image) throw inferenceError("inference_image_model_required", { status: 400 });
    return selected;
  }
  const policy = capabilities[capability];
  if (!policy) throw inferenceError("inference_capability_unsupported", { status: 400 });
  const configured = cleanConfig(env[policy[0]]) || cleanConfig(env[policy[1]]);
  let resolved = canonicalModel(configured || model || policy[2]);
  if ((hasImages || capability === "vision_text" || capability === "verification_vision") && !models.get(resolved).image) {
    const vision = capabilities.vision_text;
    resolved = canonicalModel(cleanConfig(env[vision[0]]) || cleanConfig(env[vision[1]]) || vision[2]);
    if (!models.get(resolved).image) throw inferenceError("inference_image_model_required", { status: 400 });
  }
  return resolved;
}

export function modelForProvider(model, provider, env = process.env, capability = "reasoning_text", hasImages = false) {
  const canonical = canonicalModel(model);
  if (provider === "vercel") return canonical;
  if (provider !== "ambient") throw inferenceError("inference_provider_unsupported", { status: 400 });
  if (!models.get(canonical).ambient || capability === "selected_model") throw inferenceError("inference_private_model_fallback_forbidden", { status: 400 });
  // Ambient catalogue verified 2026-09-05: text GLM 5.2; vision Gemma 4.
  // Record actual provider/model on every completion; primary remains GLM 5.3.
  const needsVision = hasImages || capability === "vision_text" || capability === "verification_vision";
  const overrideName = needsVision ? "AMBIENT_BACKUP_MODEL_VISION" : capability === "instant_text" ? "AMBIENT_BACKUP_MODEL_INSTANT"
    : models.get(canonical).image ? "AMBIENT_BACKUP_MODEL_VISION"
      : capability === "fast_text" ? "AMBIENT_BACKUP_MODEL_FAST_TEXT" : "AMBIENT_BACKUP_MODEL_REASONING";
  return cleanConfig(env[overrideName]) || (needsVision ? "google/gemma-4-26b-a4b-it" : models.get(canonical).ambient);
}

export function inferenceProviderForResponse(body = {}) {
  return body.tasknode_inference?.provider || "vercel";
}
