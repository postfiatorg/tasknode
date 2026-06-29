import { createHash } from "node:crypto";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { hiveTaskManagerActions, normalizeTaskManagerOutput } from "./repositories/hive-task-manager.js";

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const taskManagerPrompt = loadPrompt("hive/task_manager_selection_v1.md");

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function openRouterKey() {
  return safeText(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER, 10000);
}

export function hiveTaskManagerProvider() {
  return "openrouter";
}

export function hiveTaskManagerModel() {
  return safeText(process.env.TASKNODE_HIVE_TASK_MANAGER_MODEL || process.env.TASKNODE_BOARD_MANAGER_MODEL || "z-ai/glm-5.2", 160);
}

export function hiveTaskManagerReasoningEffort() {
  return safeText(process.env.TASKNODE_HIVE_TASK_MANAGER_REASONING_EFFORT || "high", 40);
}

export function hiveTaskManagerProviderConfigured() {
  return process.env.TASKNODE_HIVE_TASK_MANAGER_PROVIDER_MOCK === "true" || Boolean(openRouterKey());
}

function providerTimeoutMs() {
  return Math.min(Math.max(Number(process.env.TASKNODE_HIVE_TASK_MANAGER_TIMEOUT_MS || 240000), 1000), 600000);
}

function compactJson(value, maxLength = 180_000) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength * 0.72))}\n\n[...middle truncated for Task Manager prompt...]\n\n${text.slice(-Math.floor(maxLength * 0.28))}`;
}

function selectionSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "hive_task_manager_output",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "explanation",
          "action",
          "board_selection",
          "operator_selection",
          "task_intent",
          "constraints_checked",
          "confidence",
        ],
        properties: {
          explanation: { type: "string" },
          action: { type: "string", enum: hiveTaskManagerActions },
          board_selection: {
            type: "object",
            additionalProperties: false,
            required: ["project_id", "title", "why_this_board"],
            properties: {
              project_id: { type: "string" },
              title: { type: "string" },
              why_this_board: { type: "string" },
            },
          },
          operator_selection: {
            type: "object",
            additionalProperties: false,
            required: [
              "account_id",
              "wallet_address",
              "required_badge_id",
              "operating_badge_id",
              "task_work_type",
              "badge_work_type",
              "why_this_operator",
            ],
            properties: {
              account_id: { type: "string" },
              wallet_address: { type: "string" },
              required_badge_id: { type: "string" },
              operating_badge_id: { type: "string" },
              task_work_type: { type: "string" },
              badge_work_type: { type: "string" },
              why_this_operator: { type: "string" },
            },
          },
          task_intent: {
            type: "object",
            additionalProperties: false,
            required: [
              "title",
              "project_need_summary",
              "routing_reason",
              "dedup_basis",
              "action_output",
              "delivery_surface",
              "recipient_or_reviewer",
              "escalation_stage",
              "reward_min_pft",
              "reward_max_pft",
            ],
            properties: {
              title: { type: "string" },
              project_need_summary: { type: "string" },
              routing_reason: { type: "string" },
              dedup_basis: { type: "string" },
              action_output: { type: "string" },
              delivery_surface: { type: "string" },
              recipient_or_reviewer: { type: "string" },
              escalation_stage: { type: "string" },
              reward_min_pft: { type: "number" },
              reward_max_pft: { type: "number" },
            },
          },
          constraints_checked: {
            type: "object",
            additionalProperties: false,
            required: [
              "contributor_badge",
              "operator_idle",
              "refusal_history",
              "rewarded_history",
              "not_duplicative",
              "cold_start_problem",
            ],
            properties: {
              contributor_badge: { type: "boolean" },
              operator_idle: { type: "boolean" },
              refusal_history: { type: "boolean" },
              rewarded_history: { type: "boolean" },
              not_duplicative: { type: "boolean" },
              cold_start_problem: { type: "boolean" },
            },
          },
          confidence: { type: "number" },
        },
      },
    },
  };
}

function parseJsonOutput(text = "") {
  const trimmed = safeText(text, 500_000);
  if (!trimmed) throw new Error("hive_task_manager_empty_output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("hive_task_manager_invalid_json");
  }
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

function emptySelection() {
  return {
    explanation: "No eligible board/operator pair should receive a Network Task this tick.",
    action: "do_nothing",
    board_selection: { project_id: "", title: "", why_this_board: "" },
    operator_selection: {
      account_id: "",
      wallet_address: "",
      required_badge_id: "",
      operating_badge_id: "",
      task_work_type: "",
      badge_work_type: "",
      why_this_operator: "",
    },
    task_intent: {
      title: "",
      project_need_summary: "",
      routing_reason: "",
      dedup_basis: "",
      action_output: "",
      delivery_surface: "",
      recipient_or_reviewer: "",
      escalation_stage: "",
      reward_min_pft: 0,
      reward_max_pft: 0,
    },
    constraints_checked: {
      contributor_badge: true,
      operator_idle: true,
      refusal_history: true,
      rewarded_history: true,
      not_duplicative: true,
      cold_start_problem: false,
    },
    confidence: 0.7,
  };
}

function mockSelection(sourcePacket = {}) {
  const board = safeArray(sourcePacket.activeBoards)[0] || {};
  const operator = safeArray(sourcePacket.eligibleSelectionPool)[0] || {};
  if (!board.projectId || !operator.accountId) return normalizeTaskManagerOutput(emptySelection());
  const badge = operator.defaultBadge || operator.verifiedBadges?.[0] || "";
  const workType = operator.allowedWorkTypes?.[0] || "capability_gating_task";
  const rewardMax = Number(operator.rewardCaps?.[workType] || operator.badgeDetails?.[0]?.maxPayoutPft || 1000);
  return normalizeTaskManagerOutput({
    explanation: "Mock Task Manager selected the first active board and first idle badge-eligible operator to validate the two-step contract.",
    action: "create_task",
    board_selection: {
      project_id: board.projectId,
      title: board.title,
      why_this_board: "The board is active and visible in the source packet.",
    },
    operator_selection: {
      account_id: operator.accountId,
      wallet_address: operator.walletAddress,
      required_badge_id: badge,
      operating_badge_id: badge,
      task_work_type: workType,
      badge_work_type: workType,
      why_this_operator: "The operator is idle, badge-eligible, and present in the narrowed eligible pool.",
    },
    task_intent: {
      title: `Move ${board.title || "the board"} forward with one concrete handoff`,
      project_need_summary: `Create one concrete, non-duplicative work artifact that moves ${board.title || "the selected board"} forward based on current board state.`,
      routing_reason: "Mock routing reason for two-step Task Manager contract validation.",
      dedup_basis: "Mock mode uses the source dedup index and guardrails after selection.",
      action_output: "Submit the concrete artifact and proof that it was delivered to the named surface.",
      delivery_surface: "task_node",
      recipient_or_reviewer: "@goodalexander or the current project lead",
      escalation_stage: "normal",
      reward_min_pft: Math.min(100, rewardMax),
      reward_max_pft: rewardMax,
    },
    constraints_checked: {
      contributor_badge: true,
      operator_idle: true,
      refusal_history: true,
      rewarded_history: true,
      not_duplicative: true,
      cold_start_problem: false,
    },
    confidence: 0.66,
  });
}

export async function fetchHiveTaskManagerSelection({
  sourcePacket = {},
  model = hiveTaskManagerModel(),
  reasoningEffort = hiveTaskManagerReasoningEffort(),
  fetchImpl = fetch,
} = {}) {
  if (process.env.TASKNODE_HIVE_TASK_MANAGER_PROVIDER_MOCK === "true") {
    const selection = mockSelection(sourcePacket);
    return {
      selection,
      outputText: JSON.stringify(selection, null, 2),
      provider: "mock",
      model: "mock-hive-task-manager",
      responseId: `mock_hivetaskmgr_${createHash("sha256").update(JSON.stringify(sourcePacket)).digest("hex").slice(0, 16)}`,
      promptDigest: promptDigest(taskManagerPrompt),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, costUsd: 0, latencyMs: 0 },
    };
  }
  const apiKey = openRouterKey();
  if (!apiKey) {
    const error = new Error("hive_task_manager_openrouter_not_configured");
    error.status = 409;
    throw error;
  }
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const controller = new AbortController();
  const timeoutMs = providerTimeoutMs();
  let timeout = null;
  const startedAt = Date.now();
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("hive_task_manager_openrouter_timeout"));
      }, timeoutMs);
      timeout.unref?.();
    });
    const response = await Promise.race([fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": process.env.OPENROUTER_REFERER || process.env.TASKNODE_PUBLIC_URL || "https://tasknode.postfiat.org",
        "x-title": process.env.OPENROUTER_TITLE || "Task Node Official",
        "x-openrouter-title": process.env.OPENROUTER_TITLE || "Task Node Official",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: taskManagerPrompt },
          {
            role: "user",
            content: [
              "HIVE TASK MANAGER SOURCE PACKET",
              "```json",
              compactJson(sourcePacket),
              "```",
            ].join("\n"),
          },
        ],
        response_format: selectionSchema(),
        reasoning: { effort: reasoningEffort },
        usage: { include: true },
        data_collection: "deny",
        temperature: 0.1,
      }),
    }), timeoutPromise]);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(safeText(body?.error?.message || body?.message || `hive_task_manager_openrouter_${response.status}`, 1000));
      error.status = response.status;
      throw error;
    }
    const outputText = safeText(body.choices?.[0]?.message?.content || "", 500_000);
    const selection = normalizeTaskManagerOutput(parseJsonOutput(outputText));
    return {
      selection,
      outputText,
      provider: "openrouter",
      model,
      responseId: safeText(body.id, 180),
      promptDigest: promptDigest(taskManagerPrompt),
      usage: {
        ...openRouterUsage(body),
        latencyMs: Date.now() - startedAt,
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
