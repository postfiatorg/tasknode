import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import {
  boardManagerPromptVersion,
  normalizeBoardManagerDecision,
} from "./repositories/board-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const boardManagerPrompt = loadPrompt("hive/board_manager_v1.md");
const schemaPath = path.join(repoRoot, "schemas", "board-manager-action.schema.json");
const boardManagerActionSchema = JSON.parse(readFileSync(schemaPath, "utf8"));
const unsupportedOpenAiSchemaKeys = new Set(["$schema", "title", "minLength", "maxLength", "minimum", "maximum"]);

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function openAiKey() {
  return safeText(process.env.OPENAI_API_KEY, 10000);
}

function openRouterKey() {
  return safeText(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER, 10000);
}

export function boardManagerProvider() {
  const provider = safeText(process.env.TASKNODE_BOARD_MANAGER_PROVIDER || "openrouter", 40).toLowerCase();
  return provider === "openai" ? "openai" : "openrouter";
}

export function boardManagerModel(provider = boardManagerProvider()) {
  const fallback = provider === "openai" ? "gpt-5.5-pro" : "qwen/qwen3.7-max";
  return safeText(process.env.TASKNODE_BOARD_MANAGER_MODEL || fallback, 120);
}

export function boardManagerReasoningEffort() {
  return safeText(process.env.TASKNODE_BOARD_MANAGER_REASONING_EFFORT || "high", 40);
}

function providerTimeoutMs() {
  return Math.max(30000, Number(process.env.TASKNODE_BOARD_MANAGER_TIMEOUT_MS || 240000));
}

function outputText(body = {}) {
  if (typeof body.output_text === "string") return body.output_text;
  return (Array.isArray(body.output) ? body.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function usageFromOpenAi(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.input_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens || 0),
  };
}

function openAiSchemaValue(value) {
  if (Array.isArray(value)) return value.map(openAiSchemaValue);
  if (!value || typeof value !== "object") return value;
  if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !unsupportedOpenAiSchemaKeys.has(key))
        .map(([key, item]) => {
          if (key !== "properties") return [key, openAiSchemaValue(item)];
          return [
            key,
            Object.fromEntries(
              Object.entries(item).map(([propertyName, propertySchema]) => [propertyName, openAiSchemaValue(propertySchema)])
            ),
          ];
        })
    );
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !unsupportedOpenAiSchemaKeys.has(key))
      .map(([key, item]) => [key, openAiSchemaValue(item)])
  );
}

export function boardManagerResponseFormat() {
  return {
    type: "json_schema",
    name: "board_manager_action",
    strict: true,
    schema: openAiSchemaValue(boardManagerActionSchema),
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
        "OpenRouter returned malformed Board Manager JSON after one schema-guided repair attempt.",
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

async function fetchOpenAiBoardManagerDecision({
  sourcePacket = {},
  model = boardManagerModel("openai"),
  reasoningEffort = boardManagerReasoningEffort(),
  fetchImpl = fetch,
} = {}) {
  const apiKey = openAiKey();
  if (!apiKey) {
    const error = new Error("board_manager_openai_not_configured");
    error.status = 409;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs());
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${(process.env.OPENAI_BASE_URL || defaultOpenAiBaseUrl).replace(/\/+$/, "")}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: boardManagerDecisionInput({ sourcePacket }),
        reasoning: { effort: reasoningEffort },
        text: {
          verbosity: "low",
          format: boardManagerResponseFormat(),
        },
        max_output_tokens: Math.max(4000, Number(process.env.TASKNODE_BOARD_MANAGER_MAX_OUTPUT_TOKENS || 12000)),
        store: false,
        metadata: {
          app: "tasknodeofficial",
          worker: "board_manager",
          prompt_version: boardManagerPromptVersion,
          source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
        },
      }),
    });
    const bodyText = await response.text();
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (!response.ok) {
      const error = new Error(body?.error?.message || `OpenAI Board Manager HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const text = outputText(body);
    const parsed = parseJsonOutputText(text);
    return {
      decision: normalizeBoardManagerDecision(parsed),
      outputText: text,
      provider: "openai",
      model: body?.model || model,
      responseId: safeText(body?.id, 200),
      promptDigest: promptDigest(boardManagerPrompt),
      promptVersion: boardManagerPromptVersion,
      usage: {
        ...usageFromOpenAi(body),
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("board_manager_openai_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenRouterBoardManagerDecision({
  sourcePacket = {},
  model = boardManagerModel("openrouter"),
  reasoningEffort = boardManagerReasoningEffort(),
  fetchImpl = fetch,
} = {}) {
  const apiKey = openRouterKey();
  if (!apiKey) {
    const error = new Error("board_manager_openrouter_not_configured");
    error.status = 409;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs());
  const startedAt = Date.now();
  try {
    const requestDecision = async (messages) => {
      const response = await fetchImpl(`${(process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "http-referer": process.env.OPENROUTER_REFERER || process.env.TASKNODE_PUBLIC_URL || "https://tasknodeofficial-dev.fly.dev",
          "x-title": process.env.OPENROUTER_TITLE || "Task Node Official",
          "x-openrouter-title": process.env.OPENROUTER_TITLE || "Task Node Official",
        },
        body: JSON.stringify({
          model,
          messages,
          reasoning: { effort: reasoningEffort },
          response_format: openRouterResponseFormat(),
          provider: {
            data_collection: "deny",
            require_parameters: true,
          },
          temperature: 0,
          max_tokens: Math.max(4000, Number(process.env.TASKNODE_BOARD_MANAGER_MAX_OUTPUT_TOKENS || 12000)),
          usage: { include: true },
          metadata: {
            app: "tasknodeofficial",
            worker: "board_manager",
            prompt_version: boardManagerPromptVersion,
            source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
          },
        }),
      });
      const bodyText = await response.text();
      const body = bodyText ? JSON.parse(bodyText) : {};
      if (!response.ok) {
        const error = new Error(body?.error?.message || body?.message || `OpenRouter Board Manager HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return {
        body,
        text: body?.choices?.[0]?.message?.content || "",
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
      provider: "openrouter",
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
    if (error?.name === "AbortError") throw new Error("board_manager_openrouter_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchBoardManagerDecision({
  sourcePacket = {},
  provider = boardManagerProvider(),
  model = boardManagerModel(provider),
  reasoningEffort = boardManagerReasoningEffort(),
  fetchImpl = fetch,
} = {}) {
  if (provider === "openai") {
    return fetchOpenAiBoardManagerDecision({ sourcePacket, model, reasoningEffort, fetchImpl });
  }
  return fetchOpenRouterBoardManagerDecision({ sourcePacket, model, reasoningEffort, fetchImpl });
}
