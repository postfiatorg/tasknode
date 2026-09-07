import { inferenceError, inferenceRoutes, providerBaseUrl } from "./inference-policy.js";
import { normalizeInferenceRequest } from "./inference-protocol.js";
import { completeWithProvider, inferenceHttp, readInferenceJson, streamWithProvider, withInferenceDeadline } from "./inference-transport.js";

export { INFERENCE_MODELS, inferenceConfigured, inferenceProviderConfigured, inferenceProviderForResponse, resolveInferenceModel } from "./inference-policy.js";
export { normalizeInferenceRequest, outputTextFromInference } from "./inference-protocol.js";

function retryable(error) {
  return error?.code !== "inference_aborted" &&
    ([401, 402, 403, 404, 408, 429].includes(error?.status) || error?.status >= 500);
}

async function execute({ body = {}, capability = "reasoning_text", env = process.env, fetchImpl = fetch, signal, timeoutMs = 45_000, onDelta, stream = false, allowFallback = true } = {}) {
  const routes = inferenceRoutes(env);
  if (!routes.length) throw inferenceError("inference_not_configured", { status: 409 });
  const attempts = [];
  let emitted = false;
  for (const provider of routes) {
    // Resolve/validate before any provider call. Invalid input never causes failover.
    const request = normalizeInferenceRequest({ ...body, ...(stream ? { stream: true, stream_options: { include_usage: true } } : { stream: false }) }, { provider, capability, env });
    const started = Date.now();
    try {
      const result = await (stream ? streamWithProvider : completeWithProvider)(provider, request, {
        env, fetchImpl, signal, timeoutMs,
        onDelta: async (delta) => { emitted = true; await onDelta?.(delta); },
      });
      attempts.push({ provider, status: "completed", latencyMs: Date.now() - started });
      const metadata = { provider, requestedModel: body.model || "", model: result.model,
        fallbackFrom: provider === "ambient" ? "vercel" : "",
        fallbackReason: provider === "ambient" ? attempts[0]?.code || "primary_not_configured" : "", attempts };
      result.body.tasknode_inference = metadata;
      result.body.model ||= result.model;
      return { ...result, ...metadata, latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0) };
    } catch (error) {
      attempts.push({ provider, status: "failed", code: error.code || "inference_error", httpStatus: error.status || 502, latencyMs: Date.now() - started });
      error.attempts = attempts;
      if (signal?.aborted || emitted || !allowFallback || !retryable(error) || provider === routes.at(-1)) throw error;
    }
  }
  throw inferenceError("inference_not_configured", { status: 409 });
}

export function inferenceChatCompletion(options) {
  if (!options?.totalTimeoutMs) return execute(options);
  return withInferenceDeadline({ signal: options.signal, timeoutMs: options.totalTimeoutMs, provider: "inference" },
    (signal) => execute({ ...options, signal }));
}
export function inferenceChatCompletionStream(options) { return execute({ ...options, stream: true }); }

export async function inferenceChatCompletionResponse(options) {
  if (options?.stream || options?.body?.stream) throw inferenceError("inference_use_stream_api", { status: 400 });
  const result = await inferenceChatCompletion(options);
  return new Response(JSON.stringify(result.body), { status: 200, headers: { "content-type": "application/json" } });
}

export function inferenceFetchCompatibility(fetchImpl, _legacyUrl, init = {}, options = {}) {
  const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body || {};
  return inferenceChatCompletionResponse({ ...options, body, fetchImpl, signal: init.signal,
    capability: options.capability || "strict_json", timeoutMs: options.timeoutMs || 240_000 });
}

let catalogCache = null;
export async function inferenceModels({ env = process.env, fetchImpl = fetch, signal, timeoutMs = 15_000 } = {}) {
  const url = `${providerBaseUrl("vercel", env)}/models`;
  const ttl = Math.max(30_000, Number(env.INFERENCE_CATALOG_TTL_MS) || 5 * 60_000);
  if (catalogCache?.url === url && Date.now() - catalogCache.time < ttl) return catalogCache.body;
  try {
    const body = await withInferenceDeadline({ signal, timeoutMs, provider: "vercel" }, async (deadlineSignal) => {
      const response = await inferenceHttp("vercel", "/models", { env, fetchImpl, signal: deadlineSignal, method: "GET" });
      return readInferenceJson("vercel", response, deadlineSignal);
    });
    if (!Array.isArray(body.data)) throw inferenceError("inference_catalogue_invalid", { status: 502 });
    body._meta = { provider: "vercel", sourceUrl: url, stale: false };
    catalogCache = { url, time: Date.now(), body };
    return body;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (catalogCache?.url === url) return { ...catalogCache.body, _meta: { ...catalogCache.body._meta, stale: true, staleReason: error.code || "inference_catalogue_unavailable" } };
    throw error;
  }
}
