import { inferenceError, modelForProvider, resolveInferenceModel } from "./inference-policy.js";

export function outputTextFromInference(body = {}) {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || "").filter(Boolean).join("\n").trim();
  return typeof body.output_text === "string" ? body.output_text.trim() : "";
}

function normalizePart(part) {
  if (!part || typeof part !== "object") throw inferenceError("inference_content_part_invalid", { status: 400 });
  if (part.type === "text" || part.type === "input_text") return { type: "text", text: String(part.text || "") };
  if (part.type === "image_url" || part.type === "input_image") {
    const source = part.image_url || part.url;
    const image = typeof source === "string" ? { url: source } : source;
    if (typeof image?.url !== "string" || !image.url) throw inferenceError("inference_image_url_invalid", { status: 400 });
    return { type: "image_url", image_url: image };
  }
  throw inferenceError("inference_file_part_requires_local_extraction", { status: 415 });
}

const searchTypes = new Map([
  ["exa", "vercel:exa_search"], ["parallel", "vercel:parallel_search"], ["perplexity", "vercel:perplexity_search"],
]);
function searchQuery(messages) {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    try {
      const parsed = JSON.parse(message.content);
      if (typeof parsed?.query === "string") return parsed.query;
    } catch { /* Only explicit structured search inputs supply a fixed query. */ }
  }
  return "";
}

export function normalizeInferenceRequest(body = {}, { provider = "vercel", capability = "reasoning_text", env = process.env } = {}) {
  const request = { ...body };
  request.messages = (Array.isArray(body.messages) ? body.messages : []).map((message) => ({
    ...message,
    role: message.role === "developer" ? "system" : message.role,
    content: Array.isArray(message.content) ? message.content.map(normalizePart) : String(message.content || ""),
  }));
  const hasImages = request.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
  const canonical = resolveInferenceModel({ model: body.model, capability, env, hasImages });
  request.model = modelForProvider(canonical, provider, env, capability, hasImages);
  if (request.max_tokens == null && request.max_completion_tokens != null) request.max_tokens = request.max_completion_tokens;
  if (!request.reasoning && request.reasoning_effort) request.reasoning = { effort: request.reasoning_effort, exclude: true };
  if (!request.reasoning && request.thinking) request.reasoning = { effort: request.thinking.type === "disabled" ? "none" : request.thinking.effort || "high", exclude: true };
  if (request.response_format?.type === "json_schema" && !request.response_format.json_schema) {
    const format = request.response_format;
    request.response_format = { type: "json_schema", json_schema: { name: format.name || "tasknode_output", strict: format.strict !== false, schema: format.schema || {} } };
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const search = tools.filter((tool) => ["web_search", "websearch", ...searchTypes.values()].includes(tool?.type));
  const requestedSearch = search.length > 0 || body.enabled_tools?.includes("websearch") || body.plugins?.some((plugin) => (plugin?.id || plugin?.type || plugin) === "web");
  const functions = tools.filter((tool) => !search.includes(tool));
  if (provider === "ambient") {
    if (requestedSearch) request.enabled_tools = ["websearch"];
    request.tools = functions;
    delete request.providerOptions;
  } else {
    request.tools = [...functions];
    if (requestedSearch) {
      const source = search[0] || {};
      const parameters = source.parameters || {};
      const type = source.type?.startsWith("vercel:") ? source.type : searchTypes.get(parameters.engine || "exa");
      if (!type) throw inferenceError("inference_search_engine_unsupported", { status: 400 });
      const query = source.config?.query || parameters.query || searchQuery(request.messages);
      const config = source.config || (query ? {
        [type === "vercel:parallel_search" ? "objective" : "query"]: query,
        [type === "vercel:exa_search" ? "num_results" : "max_results"]: Math.max(1, Math.min(20, Number(parameters.max_results) || 5)),
      } : {});
      request.tools.push({ type, config });
      if (query && !request.tool_choice) request.tool_choice = "required";
    }
    delete request.enabled_tools;
  }
  if (!request.tools.length) delete request.tools;
  for (const field of ["max_completion_tokens", "provider", "plugins", "usage", "transforms", "include_reasoning", "reasoning_effort", "thinking"]) delete request[field];
  return request;
}

// Incremental SSE framing handles LF, CRLF, split CRLF, multi-line data and EOF.
export function createInferenceSseParser(onEvent) {
  let line = "";
  let data = [];
  let afterCr = false;
  async function finishLine() {
    if (line === "") {
      if (data.length) await onEvent(data.join("\n"));
      data = [];
    } else if (line.startsWith("data:")) {
      let value = line.slice(5);
      if (value.startsWith(" ")) value = value.slice(1);
      data.push(value);
    }
    line = "";
  }
  return {
    async push(chunk) {
      for (const char of chunk) {
        if (afterCr && char === "\n") { afterCr = false; continue; }
        afterCr = false;
        if (char === "\r" || char === "\n") {
          await finishLine();
          afterCr = char === "\r";
        } else line += char;
      }
    },
    async end() {
      if (line) await finishLine();
      if (data.length) await onEvent(data.join("\n"));
      data = [];
    },
  };
}
