const DEFAULT_AMBIENT_BASE_URL = "https://api.ambient.xyz/v1";
const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1000;
let catalogCache = null;

export const AMBIENT_MODELS = Object.freeze({
  fastText: "deepseek/deepseek-v4-flash-0731",
  reasoningText: "z-ai/glm-5.2",
  structured: "z-ai/glm-5.2",
  research: "z-ai/glm-5.2",
  vision: "moonshotai/kimi-k2.7-code",
});

const CAPABILITY_ENV = Object.freeze({
  fast_text: "AMBIENT_MODEL_FAST_TEXT",
  reasoning_text: "AMBIENT_MODEL_REASONING",
  strict_json: "AMBIENT_MODEL_STRUCTURED",
  research_text: "AMBIENT_MODEL_RESEARCH",
  vision_text: "AMBIENT_MODEL_VISION",
  verification_vision: "AMBIENT_MODEL_VISION",
});

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function ambientApiKey(env = process.env) {
  return safeText(env.AMBIENT_API_KEY, 10000).replace(/^['"‘’]+|['"‘’]+$/g, "");
}

export function ambientBaseUrl(env = process.env) {
  return safeText(env.AMBIENT_BASE_URL || DEFAULT_AMBIENT_BASE_URL, 1000).replace(/\/+$/, "");
}

export function ambientConfigured(env = process.env) {
  return Boolean(ambientApiKey(env));
}

function capabilityDefault(capability = "") {
  if (capability === "fast_text") return AMBIENT_MODELS.fastText;
  if (capability === "vision_text" || capability === "verification_vision") return AMBIENT_MODELS.vision;
  if (capability === "research_text") return AMBIENT_MODELS.research;
  if (capability === "strict_json") return AMBIENT_MODELS.structured;
  return AMBIENT_MODELS.reasoningText;
}

export function resolveAmbientModel({ model = "", capability = "reasoning_text", env = process.env } = {}) {
  const configured = safeText(env[CAPABILITY_ENV[capability]], 160);
  if (configured) return configured;

  const requested = safeText(model, 160);
  if (/^(?:z-ai\/glm-5\.2|ambient\/large)$/i.test(requested)) return requested;
  if (/^moonshotai\/kimi-k2\.7-code$/i.test(requested)) return requested;
  if (/^deepseek\/deepseek-v4-flash-0731$/i.test(requested)) return requested;
  if (/deepseek.*flash/i.test(requested)) return AMBIENT_MODELS.fastText;
  if (/glm-5\.2/i.test(requested)) return AMBIENT_MODELS.reasoningText;
  return capabilityDefault(capability);
}

function normalizedImageUrl(value) {
  if (typeof value === "string") return { url: value };
  if (value && typeof value === "object" && typeof value.url === "string") return { url: value.url };
  throw Object.assign(new Error("ambient_image_url_invalid"), { status: 400 });
}

function normalizeContentPart(part = {}) {
  if (!part || typeof part !== "object") return part;
  if (part.type === "text" || part.type === "input_text") {
    return { type: "text", text: String(part.text || "") };
  }
  if (part.type === "image_url" || part.type === "input_image") {
    return {
      type: "image_url",
      image_url: normalizedImageUrl(part.image_url || part.url),
    };
  }
  if (part.type === "file" || part.type === "input_file") {
    throw Object.assign(new Error("ambient_file_part_requires_local_extraction"), { status: 415 });
  }
  return part;
}

function normalizeMessage(message = {}) {
  const content = Array.isArray(message.content)
    ? message.content.map(normalizeContentPart)
    : String(message.content || "");
  return {
    ...message,
    role: message.role === "developer" ? "system" : message.role,
    content,
  };
}

function webSearchRequested(body = {}) {
  const enabled = Array.isArray(body.enabled_tools) ? body.enabled_tools : [];
  if (enabled.some((tool) => String(tool).toLowerCase() === "websearch")) return true;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.some((tool) => ["web_search", "websearch"].includes(String(tool?.type || tool).toLowerCase()))) return true;
  const plugins = Array.isArray(body.plugins) ? body.plugins : [];
  return plugins.some((plugin) => /web/i.test(String(plugin?.id || plugin?.type || plugin)));
}

export function normalizeAmbientChatRequest(body = {}, { capability = "reasoning_text", env = process.env } = {}) {
  const request = { ...body };
  request.model = resolveAmbientModel({ model: request.model, capability, env });
  request.messages = Array.isArray(request.messages) ? request.messages.map(normalizeMessage) : [];

  if (request.max_completion_tokens != null && request.max_tokens == null) {
    request.max_tokens = request.max_completion_tokens;
  }
  if (!request.reasoning && request.reasoning_effort) {
    request.reasoning = { effort: request.reasoning_effort, exclude: true };
  }
  if (!request.reasoning && request.thinking && typeof request.thinking === "object") {
    request.reasoning = {
      effort: request.thinking.type === "disabled" ? "none" : request.thinking.effort || "high",
      exclude: true,
    };
  }
  if (webSearchRequested(request)) {
    request.enabled_tools = [...new Set([...(request.enabled_tools || []), "websearch"])];
  }

  if (Array.isArray(request.tools)) {
    request.tools = request.tools.filter((tool) => !["web_search", "websearch"].includes(String(tool?.type || tool).toLowerCase()));
    if (request.tools.length === 0) delete request.tools;
  }

  delete request.max_completion_tokens;
  delete request.provider;
  delete request.plugins;
  delete request.usage;
  delete request.transforms;
  delete request.include_reasoning;
  delete request.reasoning_effort;
  delete request.thinking;
  return request;
}

function sanitizedProviderMessage(value = "") {
  return safeText(value, 500)
    .replace(/\b(?:sk-|ak-)[A-Za-z0-9_-]{12,}\b/g, "[redacted_api_key]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function ambientError({ status = 502, body = null, bodyText = "" } = {}) {
  const message = sanitizedProviderMessage(body?.error?.message || body?.message || bodyText || `Ambient returned HTTP ${status}`);
  const error = new Error(`ambient_http_${status}:${message}`);
  error.status = status;
  error.code = status === 429 && /no workers?/i.test(message)
    ? "ambient_no_workers"
    : status === 429
      ? "ambient_rate_limited"
      : `ambient_http_${status}`;
  error.providerMessage = message;
  return error;
}

async function parsedAmbientResponse(response) {
  const bodyText = await response.text();
  let parsed = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    if (!response.ok) throw ambientError({ status: response.status, bodyText });
    throw Object.assign(new Error("ambient_response_invalid_json"), { status: 502, code: "ambient_response_invalid_json" });
  }
  if (!response.ok || parsed?.error) {
    throw ambientError({ status: response.status || 502, body: parsed, bodyText });
  }
  return parsed;
}

async function executeAmbientTools(toolCalls, options = {}) {
  const attempts = Math.max(1, Math.min(3, Number(options.env?.AMBIENT_TOOL_ATTEMPTS || 2)));
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await ambientFetch("/tools", {
        ...options,
        body: { tool_calls: toolCalls },
      });
      const parsed = await parsedAmbientResponse(response);
      const results = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : [];
      if (results.length !== toolCalls.length) {
        throw Object.assign(new Error("ambient_tool_result_count_mismatch"), { status: 502, code: "ambient_tool_result_count_mismatch" });
      }
      const failed = results.find((tool) => tool?.content?.success === false);
      if (failed) {
        const detail = sanitizedProviderMessage(failed?.content?.error || failed?.content?.details || "Ambient tool execution failed");
        throw Object.assign(new Error(`ambient_tool_execution_failed:${detail}`), { status: 502, code: "ambient_tool_execution_failed" });
      }
      return results;
    } catch (error) {
      lastError = error;
      const retryable = error?.code === "ambient_tool_execution_failed" || error?.status === 429 || error?.status >= 500;
      if (!retryable || attempt + 1 >= attempts) throw error;
    }
  }
  throw lastError;
}

function linkedAbortController(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.("abort", onAbort, { once: true });
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear() {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
    },
  };
}

async function ambientFetch(path, {
  body,
  env = process.env,
  fetchImpl = fetch,
  signal,
  timeoutMs = 45_000,
  headers = {},
} = {}) {
  const apiKey = ambientApiKey(env);
  if (!apiKey) {
    throw Object.assign(new Error("ambient_api_key_missing"), { status: 409, code: "ambient_api_key_missing" });
  }

  const linked = linkedAbortController(signal, timeoutMs);
  try {
    return await fetchImpl(`${ambientBaseUrl(env)}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: linked.signal,
    });
  } catch (error) {
    if (linked.timedOut()) {
      throw Object.assign(new Error("ambient_timeout"), { status: 504, code: "ambient_timeout" });
    }
    throw error;
  } finally {
    linked.clear();
  }
}

export function outputTextFromAmbient(body = {}) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || "").filter(Boolean).join("\n").trim();
  }
  if (typeof body?.output_text === "string") return body.output_text.trim();
  return "";
}

export async function ambientChatCompletionResponse({
  body,
  capability = "reasoning_text",
  env = process.env,
  fetchImpl = fetch,
  signal,
  timeoutMs = 45_000,
  stream = false,
} = {}) {
  const request = normalizeAmbientChatRequest({
    ...body,
    stream: stream || body?.stream || undefined,
  }, { capability, env });
  return ambientFetch("/chat/completions", {
    body: request,
    env,
    fetchImpl,
    signal,
    timeoutMs,
    headers: stream ? { accept: "text/event-stream" } : {},
  });
}

export async function ambientFetchCompatibility(fetchImpl, _legacyUrl, init = {}, {
  capability = "strict_json",
  env = process.env,
  timeoutMs = 240_000,
} = {}) {
  const body = typeof init.body === "string" ? JSON.parse(init.body) : (init.body || {});
  return ambientChatCompletionResponse({
    body,
    capability,
    env,
    fetchImpl,
    signal: init.signal,
    timeoutMs,
    stream: body.stream === true,
  });
}

export async function ambientChatCompletion({
  body,
  capability = "reasoning_text",
  env = process.env,
  fetchImpl = fetch,
  signal,
  timeoutMs = 45_000,
  allowCapacityFallback = true,
} = {}) {
  let request = normalizeAmbientChatRequest(body, { capability, env });
  const startedAt = Date.now();
  let parsed = null;
  let fallbackFrom = "";
  let capacityFallbackUsed = false;
  let toolRounds = 0;
  const maxToolRounds = Math.max(1, Math.min(6, Number(env.AMBIENT_MAX_TOOL_ROUNDS || 3)));
  while (true) {
    const response = await ambientFetch("/chat/completions", { body: request, env, fetchImpl, signal, timeoutMs });
    try {
      parsed = await parsedAmbientResponse(response);
    } catch (error) {
      const canFallback = allowCapacityFallback && !capacityFallbackUsed && error.code === "ambient_no_workers" &&
        capability === "fast_text" && request.model === AMBIENT_MODELS.fastText;
      if (!canFallback) throw error;
      capacityFallbackUsed = true;
      fallbackFrom = request.model;
      request = { ...request, model: AMBIENT_MODELS.reasoningText, reasoning: { effort: "none", exclude: true } };
      continue;
    }

    const message = parsed?.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!toolCalls.length) break;
    if (!Array.isArray(request.enabled_tools) || request.enabled_tools.length === 0) {
      throw Object.assign(new Error("ambient_unexpected_tool_calls"), { status: 502, code: "ambient_unexpected_tool_calls" });
    }
    if (toolRounds >= maxToolRounds) {
      throw Object.assign(new Error("ambient_tool_round_limit"), { status: 502, code: "ambient_tool_round_limit" });
    }
    const toolResults = await executeAmbientTools(toolCalls, { env, fetchImpl, signal, timeoutMs });
    request = {
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: message.content || "", tool_calls: toolCalls },
        ...toolResults.map((tool) => ({
          role: "tool",
          tool_call_id: tool.id,
          content: JSON.stringify(tool.content ?? tool.result ?? {}),
        })),
      ],
    };
    toolRounds += 1;
  }
  const latencyMs = Date.now() - startedAt;
  if (env.TASKNODE_AMBIENT_METRICS_LOG === "true") {
    console.info("ambient_inference_complete", { capability, model: parsed?.model || request.model, fallbackFrom, toolRounds, latencyMs, requestId: parsed?.id || "" });
  }
  return {
    body: parsed,
    request,
    text: outputTextFromAmbient(parsed),
    id: parsed?.id || null,
    model: parsed?.model || request.model,
    usage: parsed?.usage || null,
    fallbackFrom,
    toolRounds,
    latencyMs,
  };
}

function eventPayloads(buffer = "") {
  const events = [];
  const chunks = buffer.split(/\r?\n\r?\n/);
  const remainder = chunks.pop() || "";
  for (const chunk of chunks) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) events.push(data);
  }
  return { events, remainder };
}

function readStreamChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(signal.reason || new Error("ambient_stream_aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("ambient_stream_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function ambientChatCompletionStream({
  body,
  capability = "reasoning_text",
  env = process.env,
  fetchImpl = fetch,
  signal,
  timeoutMs = 45_000,
  onDelta,
} = {}) {
  const request = normalizeAmbientChatRequest({ ...body, stream: true, stream_options: { include_usage: true } }, { capability, env });
  const response = await ambientFetch("/chat/completions", {
    body: request,
    env,
    fetchImpl,
    signal,
    timeoutMs: 0,
    headers: { accept: "text/event-stream" },
  });
  if (!response.ok) {
    const bodyText = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
    throw ambientError({ status: response.status, body: parsed, bodyText });
  }
  if (!response.body?.getReader) {
    throw Object.assign(new Error("ambient_stream_body_missing"), { status: 502, code: "ambient_stream_body_missing" });
  }

  const linked = linkedAbortController(signal, timeoutMs);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let id = null;
  let model = request.model;
  let usage = null;
  let finishReason = "";

  async function consume(data) {
    if (!data || data === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk.error) throw ambientError({ status: Number(chunk.error?.code) || 502, body: chunk });
    id = chunk.id || id;
    model = chunk.model || model;
    usage = chunk.usage || usage;
    const choice = chunk.choices?.[0] || {};
    finishReason = choice.finish_reason || finishReason;
    const delta = choice.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      await onDelta?.(delta);
    }
  }

  try {
    while (true) {
      if (linked.signal.aborted) {
        if (linked.timedOut()) throw Object.assign(new Error("ambient_timeout"), { status: 504, code: "ambient_timeout" });
        throw Object.assign(new Error("ambient_stream_aborted"), { status: 499, code: "ambient_stream_aborted" });
      }
      const { value, done } = await readStreamChunk(reader, linked.signal);
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const parsed = eventPayloads(buffer);
      buffer = parsed.remainder;
      for (const data of parsed.events) await consume(data);
      if (done) break;
    }
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      await consume(data);
    }
  } catch (error) {
    if (linked.timedOut()) {
      throw Object.assign(new Error("ambient_timeout"), { status: 504, code: "ambient_timeout" });
    }
    throw error;
  } finally {
    linked.clear();
    if (linked.signal.aborted) await reader.cancel().catch(() => null);
    reader.releaseLock();
  }

  return { request, text: text.trim(), id, model, usage, finishReason };
}

export async function ambientModels({ env = process.env, fetchImpl = fetch, signal, timeoutMs = 15_000 } = {}) {
  const apiKey = ambientApiKey(env);
  if (!apiKey) throw Object.assign(new Error("ambient_api_key_missing"), { status: 409, code: "ambient_api_key_missing" });
  const cacheKey = ambientBaseUrl(env);
  const ttlMs = Math.max(30_000, Number(env.AMBIENT_CATALOG_TTL_MS || DEFAULT_CATALOG_TTL_MS));
  if (catalogCache?.key === cacheKey && Date.now() - catalogCache.fetchedAt < ttlMs) return catalogCache.body;
  const linked = linkedAbortController(signal, timeoutMs);
  try {
    const response = await fetchImpl(`${ambientBaseUrl(env)}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: linked.signal,
    });
    const bodyText = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch { parsed = null; }
    if (!response.ok || !parsed) throw ambientError({ status: response.status, body: parsed, bodyText });
    catalogCache = { key: cacheKey, fetchedAt: Date.now(), body: parsed };
    return parsed;
  } catch (error) {
    if (catalogCache?.key === cacheKey) {
      return { ...catalogCache.body, _meta: { ...(catalogCache.body?._meta || {}), stale: true, staleReason: sanitizedProviderMessage(error?.message || error) } };
    }
    if (linked.timedOut()) throw Object.assign(new Error("ambient_timeout"), { status: 504, code: "ambient_timeout" });
    throw error;
  } finally {
    linked.clear();
  }
}
