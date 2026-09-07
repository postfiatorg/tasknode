import { inferenceError, providerApiKey, providerBaseUrl } from "./inference-policy.js";
import { createInferenceSseParser, outputTextFromInference } from "./inference-protocol.js";

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(inferenceError("inference_aborted", { status: 499 }));
  return new Promise((resolve, reject) => {
    const abort = () => reject(inferenceError("inference_aborted", { status: 499 }));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function withInferenceDeadline({ signal, timeoutMs = 45_000, provider }, run) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const duration = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 45_000;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration);
  try {
    if (controller.signal.aborted) throw inferenceError("inference_aborted", { status: 499, provider });
    return await abortable(run(controller.signal), controller.signal);
  } catch (error) {
    if (signal?.aborted) throw inferenceError("inference_aborted", { status: 499, provider });
    if (timedOut) throw inferenceError("inference_timeout", { status: 504, provider });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function providerError(provider, response, body) {
  const explicitStatus = Number(body?.error?.status || body?.error?.code);
  const statuses = { rate_limit_exceeded: 429, insufficient_quota: 402, model_not_found: 404 };
  const status = !response.ok ? response.status
    : explicitStatus >= 400 && explicitStatus <= 599 ? explicitStatus
      : statuses[body?.error?.type] || 502;
  // Do not log upstream text: errors can echo credentials or private prompts.
  return inferenceError(`inference_http_${status}`, { status, provider });
}

export async function inferenceHttp(provider, path, { body, env = process.env, fetchImpl = fetch, signal, method = "POST" } = {}) {
  const apiKey = providerApiKey(provider, env);
  const headers = { accept: body?.stream ? "text/event-stream" : "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (body) headers["content-type"] = "application/json";
  try {
    return await abortable(fetchImpl(`${providerBaseUrl(provider, env)}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal,
    }), signal);
  } catch (error) {
    if (signal.aborted) throw inferenceError("inference_aborted", { status: 499, provider });
    throw inferenceError("inference_network_error", { status: 502, provider, cause: error });
  }
}

export async function readInferenceJson(provider, response, signal) {
  let text;
  try { text = await abortable(response.text(), signal); }
  catch (error) {
    if (signal.aborted) throw error;
    throw inferenceError("inference_network_error", { status: 502, provider });
  }
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch {
    if (!response.ok) throw providerError(provider, response);
    throw inferenceError("inference_response_invalid_json", { status: 502, provider });
  }
  if (!response.ok || body?.error) throw providerError(provider, response, body);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw inferenceError("inference_response_invalid_json", { status: 502, provider });
  return body;
}

function addUsage(total, usage) {
  if (!usage) return total;
  if (!total) return structuredClone(usage);
  const result = { ...total };
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") result[key] = Number(total[key] || 0) + value;
    else if (value && typeof value === "object" && !Array.isArray(value)) result[key] = addUsage(total[key], value);
  }
  return result;
}

export async function completeWithProvider(provider, request, options) {
  return withInferenceDeadline({ ...options, provider }, async (signal) => {
    let body;
    let current = request;
    let usage = null;
    let toolRounds = 0;
    let searchCalls = 0;
    const maxRounds = Math.max(1, Math.min(6, Number(options.env?.AMBIENT_MAX_TOOL_ROUNDS) || 3));
    while (true) {
      const response = await inferenceHttp(provider, "/chat/completions", { ...options, body: current, signal });
      body = await readInferenceJson(provider, response, signal);
      usage = addUsage(usage, body.usage);
      const message = body.choices?.[0]?.message;
      const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      if (!calls.length) break;
      if (provider !== "ambient" || !current.enabled_tools?.includes("websearch")) {
        throw inferenceError("inference_unexpected_tool_calls", { status: 422, provider });
      }
      if (toolRounds >= maxRounds) throw inferenceError("inference_tool_round_limit", { status: 422, provider });
      const toolsResponse = await inferenceHttp(provider, "/tools", { ...options, body: { tool_calls: calls }, signal });
      const toolsBody = await readInferenceJson(provider, toolsResponse, signal);
      const results = Array.isArray(toolsBody.tool_calls) ? toolsBody.tool_calls : [];
      if (results.length !== calls.length || results.some((tool, i) => tool.id !== calls[i].id || tool.content?.success === false)) {
        throw inferenceError("inference_tool_execution_failed", { status: 502, provider });
      }
      current = { ...current, messages: [...current.messages,
        { role: "assistant", content: message.content || "", tool_calls: calls },
        ...results.map((tool) => ({ role: "tool", tool_call_id: tool.id, content: JSON.stringify(tool.content ?? tool.result ?? {}) })),
      ] };
      toolRounds += 1;
      searchCalls += calls.length;
    }
    if (searchCalls) usage = { ...usage, server_tool_use: { ...usage?.server_tool_use, web_search_requests: searchCalls } };
    if (usage) body.usage = usage;
    if (body.choices?.[0]?.finish_reason === "length") throw inferenceError("inference_response_truncated", { status: 422, provider });
    const text = outputTextFromInference(body);
    if (!text) throw inferenceError("inference_empty_response", { status: 502, provider });
    return { body, request, text, id: body.id || null, model: body.model || request.model, usage: usage || null, toolRounds };
  });
}

export async function streamWithProvider(provider, request, options) {
  return withInferenceDeadline({ ...options, provider }, async (signal) => {
    const response = await inferenceHttp(provider, "/chat/completions", { ...options, body: request, signal });
    if (!response.ok) await readInferenceJson(provider, response, signal);
    if (!response.body?.getReader) throw inferenceError("inference_stream_body_missing", { status: 502, provider });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let id = null;
    let model = request.model;
    let usage = null;
    let finishReason = "";
    let doneEvent = false;
    let providerMetadata = null;
    const parser = createInferenceSseParser(async (data) => {
      if (data === "[DONE]") { doneEvent = true; return; }
      let chunk;
      try { chunk = JSON.parse(data); }
      catch { throw inferenceError("inference_stream_invalid_json", { status: 502, provider }); }
      if (chunk.error) throw providerError(provider, response, chunk);
      id = chunk.id || id;
      model = chunk.model || model;
      usage = chunk.usage || usage;
      const choice = chunk.choices?.[0];
      finishReason = choice?.finish_reason || finishReason;
      providerMetadata = choice?.delta?.provider_metadata || choice?.message?.provider_metadata || providerMetadata;
      if (choice?.delta?.tool_calls?.length) throw inferenceError("inference_stream_unexpected_tool_calls", { status: 422, provider });
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        await options.onDelta?.(delta);
      }
    });
    try {
      while (true) {
        let chunk;
        try { chunk = await abortable(reader.read(), signal); }
        catch (error) {
          if (signal.aborted) throw error;
          throw inferenceError("inference_network_error", { status: 502, provider });
        }
        await parser.push(decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done }));
        if (chunk.done) break;
      }
      await parser.end();
      if (!doneEvent && !finishReason) throw inferenceError("inference_stream_incomplete", { status: 502, provider });
      if (finishReason === "length") throw inferenceError("inference_response_truncated", { status: 422, provider });
      if (!text.trim()) throw inferenceError("inference_empty_response", { status: 502, provider });
      const body = { id, model, usage, choices: [{ message: { content: text, provider_metadata: providerMetadata }, finish_reason: finishReason }] };
      return { body, request, text: text.trim(), id, model, usage, finishReason };
    } finally {
      await reader.cancel().catch(() => null);
      reader.releaseLock();
    }
  });
}
