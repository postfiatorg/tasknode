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

export function boardManagerModel() {
  return safeText(process.env.TASKNODE_BOARD_MANAGER_MODEL || "gpt-5.5-pro", 120);
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

export async function fetchBoardManagerDecision({
  sourcePacket = {},
  model = boardManagerModel(),
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
    const parsed = text ? JSON.parse(text) : {};
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
