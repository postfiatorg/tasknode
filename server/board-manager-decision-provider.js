import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import {
  boardManagerPromptVersion,
  normalizeBoardManagerDecision,
} from "./repositories/board-manager.js";
import {
  AMBIENT_MODELS,
  ambientChatCompletion,
  ambientChatCompletionStream,
  ambientConfigured,
} from "./ambient-inference.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const boardManagerPrompt = loadPrompt("hive/board_manager_v1.md");
const schemaPath = path.join(repoRoot, "schemas", "board-manager-action.schema.json");
const boardManagerActionSchema = JSON.parse(readFileSync(schemaPath, "utf8"));
const unsupportedSchemaKeys = new Set(["$schema", "title", "minLength", "maxLength", "minimum", "maximum"]);

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function boardManagerProvider() {
  return "ambient";
}

export function normalizeBoardManagerModel(model = "") {
  const safeModel = safeText(model, 120);
  return safeModel || AMBIENT_MODELS.reasoningText;
}

export function boardManagerModel(_provider = boardManagerProvider()) {
  const configured = safeText(process.env.TASKNODE_BOARD_MANAGER_MODEL, 120);
  return normalizeBoardManagerModel(configured);
}

export function boardManagerReasoningEffort() {
  return safeText(process.env.TASKNODE_BOARD_MANAGER_REASONING_EFFORT || "high", 40);
}

function providerTimeoutMs() {
  return Math.max(30000, Number(process.env.TASKNODE_BOARD_MANAGER_TIMEOUT_MS || 240000));
}

function schemaValue(value) {
  if (Array.isArray(value)) return value.map(schemaValue);
  if (!value || typeof value !== "object") return value;
  if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !unsupportedSchemaKeys.has(key))
        .map(([key, item]) => {
          if (key !== "properties") return [key, schemaValue(item)];
          return [
            key,
            Object.fromEntries(Object.entries(item).map(([propertyName, propertySchema]) => [propertyName, schemaValue(propertySchema)])),
          ];
        })
    );
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !unsupportedSchemaKeys.has(key))
      .map(([key, item]) => [key, schemaValue(item)])
  );
}

export function boardManagerResponseFormat() {
  return {
    type: "json_schema",
    name: "board_manager_action",
    strict: true,
    schema: schemaValue(boardManagerActionSchema),
  };
}

function openRouterResponseFormat() {
  const format = boardManagerResponseFormat();
  return {
    type: "json_schema",
    json_schema: {
      name: format.name,
      strict: format.strict,
      schema: format.schema,
    },
  };
}

export function boardManagerDecisionInput({ sourcePacket = {}, prompt = boardManagerPrompt } = {}) {
  return [
    {
      role: "system",
      content: [
        prompt,
        "",
        "You are running as the Task Node Board Manager decision model.",
        "Read the live source packet and return exactly one valid JSON action.",
        "Do not claim you executed anything. The Task Node server executes validated hooks after your JSON.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "BOARD MANAGER SOURCE PACKET",
        "```json",
        JSON.stringify(sourcePacket, null, 2),
        "```",
      ].join("\n"),
    },
  ];
}

function parseJsonOutputText(text = "") {
  const trimmed = safeText(text, 1000000);
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("board_manager_provider_invalid_json");
  }
}

function isJsonOutputParseError(error) {
  if (error instanceof SyntaxError) return true;
  const message = safeText(error?.message, 500);
  return message === "board_manager_provider_invalid_json" ||
    /JSON|Unexpected|Expected|unterminated|parse/i.test(message);
}

function boardManagerJsonRepairMessages({ sourcePacket = {}, invalidText = "", parseError = "" } = {}) {
  return [
    ...boardManagerDecisionInput({ sourcePacket }),
    {
      role: "assistant",
      content: safeText(invalidText, 20000),
    },
    {
      role: "user",
      content: [
        "The previous assistant message was not valid JSON and could not be parsed.",
        `Parser error: ${safeText(parseError, 500)}`,
        "Repair the same Board Manager decision now.",
        "Return exactly one JSON object matching the schema. Do not add prose, markdown, comments, or trailing text.",
      ].join("\n"),
    },
  ];
}

function boardManagerMalformedJsonFallbackDecision({ sourcePacket = {}, parseError = "" } = {}) {
  return {
    action: "do_nothing",
    target_type: "",
    target_id: "",
    reason: "Board Manager provider returned malformed JSON after a repair attempt; failing closed with no board mutation.",
    confidence: 0,
    decision_basis: {
      source_facts: [
        `source_packet_digest:${safeText(sourcePacket.sourcePacketDigest, 120) || "unknown"}`,
        "Ambient returned malformed Board Manager JSON after one schema-guided repair attempt.",
      ],
      tradeoffs: [
        "Skipping this turn preserves board state instead of executing an unvalidated or partially parsed model decision.",
      ],
      rejected_actions: [
        {
          action: "initiate_network_task",
          reason: "No valid provider decision was available for runtime validation.",
        },
      ],
      risk_notes: [
        `Provider JSON parse error: ${safeText(parseError, 240) || "unknown"}`,
      ],
      next_check: "Retry on the next Board Manager cadence and inspect provider formatting if this repeats.",
    },
    payload: {},
  };
}

function openRouterUsage(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    reasoningTokens: Number(usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens || 0),
    costUsd: Number(usage.cost || 0),
  };
}

function parseSseBlock(block = "") {
  const lines = String(block || "").split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  return data.join("\n");
}

async function readEventStream(stream, onData) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n|\r\n\r\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const data = parseSseBlock(block);
      if (data) await onData(data);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = parseSseBlock(buffer);
    if (data) await onData(data);
  }
}

async function readOpenRouterBoardManagerStream(response, { model = "", onOutputDelta = null } = {}) {
  let text = "";
  let responseId = "";
  let responseModel = model;
  let usageBody = {};
  await readEventStream(response.body, async (data) => {
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data);
    if (chunk.error) {
      const error = new Error(chunk.error?.message || "board_manager_provider_stream_failed");
      error.status = chunk.error?.code || 502;
      throw error;
    }
    responseId = safeText(chunk.id || responseId, 200);
    responseModel = safeText(chunk.model || responseModel || model, 120);
    if (chunk.usage) usageBody = { usage: chunk.usage };
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      await onOutputDelta?.(delta);
    }
  });
  return {
    body: {
      id: responseId,
      model: responseModel || model,
      choices: [{ message: { content: text } }],
      ...usageBody,
    },
    text,
  };
}

async function fetchOpenRouterBoardManagerDecision({
  sourcePacket = {},
  model = boardManagerModel("ambient"),
  reasoningEffort = boardManagerReasoningEffort(),
  fetchImpl = fetch,
  onOutputDelta = null,
} = {}) {
  if (!ambientConfigured()) {
    const error = new Error("board_manager_ambient_not_configured");
    error.status = 409;
    throw error;
  }
  const startedAt = Date.now();
  try {
    const requestDecision = async (messages) => {
      const streamOutput =
        typeof onOutputDelta === "function" &&
        process.env.TASKNODE_BOARD_MANAGER_LIVE_STREAM_DISABLED !== "true";
      const requestBody = {
          model,
          messages,
          reasoning: { effort: reasoningEffort },
          response_format: openRouterResponseFormat(),
          temperature: 0,
          max_tokens: Math.max(4000, Number(process.env.TASKNODE_BOARD_MANAGER_MAX_OUTPUT_TOKENS || 12000)),
          metadata: {
            app: "tasknodeofficial",
            worker: "board_manager",
            prompt_version: boardManagerPromptVersion,
            source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
          },
      };
      if (streamOutput) {
        const streamed = await ambientChatCompletionStream({
          body: requestBody,
          capability: "strict_json",
          fetchImpl,
          timeoutMs: providerTimeoutMs(),
          onDelta: onOutputDelta,
        });
        return {
          body: {
            id: streamed.id,
            model: streamed.model,
            choices: [{ message: { content: streamed.text } }],
            usage: streamed.usage,
          },
          text: streamed.text,
        };
      }
      const completed = await ambientChatCompletion({
        body: requestBody,
        capability: "strict_json",
        fetchImpl,
        timeoutMs: providerTimeoutMs(),
      });
      return {
        body: completed.body,
        text: completed.text,
      };
    };

    let response = await requestDecision(boardManagerDecisionInput({ sourcePacket }));
    let parsed;
    let repairAttempted = false;
    let repairFailed = false;
    let firstUsage = openRouterUsage(response.body);
    try {
      parsed = parseJsonOutputText(response.text);
    } catch (error) {
      if (!isJsonOutputParseError(error)) throw error;
      repairAttempted = true;
      response = await requestDecision(boardManagerJsonRepairMessages({
        sourcePacket,
        invalidText: response.text,
        parseError: error?.message || String(error),
      }));
      try {
        parsed = parseJsonOutputText(response.text);
      } catch (repairError) {
        if (!isJsonOutputParseError(repairError)) throw repairError;
        repairFailed = true;
        parsed = boardManagerMalformedJsonFallbackDecision({
          sourcePacket,
          parseError: repairError?.message || String(repairError),
        });
        response = {
          ...response,
          text: JSON.stringify(parsed),
        };
      }
    }
    const usage = openRouterUsage(response.body);
    if (repairAttempted) {
      usage.inputTokens += firstUsage.inputTokens;
      usage.outputTokens += firstUsage.outputTokens;
      usage.totalTokens += firstUsage.totalTokens;
      usage.reasoningTokens += firstUsage.reasoningTokens;
      usage.costUsd += firstUsage.costUsd;
      usage.repairAttempted = true;
      usage.repairFailed = repairFailed;
    }
    return {
      decision: normalizeBoardManagerDecision(parsed),
      outputText: response.text,
      provider: "ambient",
      model: response.body?.model || model,
      responseId: safeText(response.body?.id, 200),
      promptDigest: promptDigest(boardManagerPrompt),
      promptVersion: boardManagerPromptVersion,
      usage: {
        ...usage,
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.code === "ambient_timeout") throw new Error("board_manager_ambient_timeout");
    throw error;
  }
}

export async function fetchBoardManagerDecision({
  sourcePacket = {},
  provider = boardManagerProvider(),
  model = boardManagerModel(provider),
  reasoningEffort = boardManagerReasoningEffort(),
  fetchImpl = fetch,
  onOutputDelta = null,
} = {}) {
  if (provider !== "ambient") {
    throw new Error(`board_manager_provider_unsupported:${safeText(provider, 40) || "unknown"}`);
  }
  const normalizedModel = normalizeBoardManagerModel(model);
  return fetchOpenRouterBoardManagerDecision({
    sourcePacket,
    model: normalizedModel,
    reasoningEffort,
    fetchImpl,
    onOutputDelta,
  });
}
