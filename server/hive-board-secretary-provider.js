import { createHash } from "node:crypto";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { hiveBoardSecretaryPromptVersion } from "./repositories/hive-board-secretary.js";
import { AMBIENT_MODELS, ambientChatCompletion, ambientConfigured } from "./ambient-inference.js";

const boardSecretaryPrompt = loadPrompt("hive/glm_board_secretary_status_memo_v1.md");

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function hiveBoardSecretaryProvider() {
  return "ambient";
}

export function hiveBoardSecretaryModel(env = process.env) {
  return safeText(env.TASKNODE_HIVE_BOARD_SECRETARY_MODEL || AMBIENT_MODELS.structured, 180);
}

export function hiveBoardSecretaryPromptDigest() {
  return promptDigest(boardSecretaryPrompt);
}

export function hiveBoardSecretaryProviderConfigured(env = process.env) {
  return env.TASKNODE_HIVE_BOARD_SECRETARY_PROVIDER_MOCK === "true" || ambientConfigured(env);
}

function providerTimeoutMs(env = process.env) {
  return Math.min(Math.max(Number(env.TASKNODE_HIVE_BOARD_SECRETARY_TIMEOUT_MS || 240000), 1000), 600000);
}

function compactJson(value = {}, maxLength = 90000) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength * 0.72))}\n\n[...middle truncated...]\n\n${text.slice(-Math.floor(maxLength * 0.28))}`;
}

function openRouterUsage(body = {}) {
  const usage = safeObject(body.usage);
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    reasoningTokens: Number(usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens || 0),
    costUsd: Number(usage.cost || 0),
  };
}

function stripMarkdownFence(text = "") {
  const trimmed = safeText(text, 200000);
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  return safeText(fenced?.[1] || trimmed, 200000);
}

function messagesForPacket(sourcePacket = {}) {
  return [
    {
      role: "system",
      content: boardSecretaryPrompt,
    },
    {
      role: "user",
      content: [
        "HIVE BOARD SECRETARY SOURCE PACKET",
        "```json",
        compactJson(sourcePacket),
        "```",
      ].join("\n"),
    },
  ];
}

function mockMemo(sourcePacket = {}) {
  const project = safeObject(sourcePacket.project);
  const activeCount = Number(sourcePacket.counts?.activeTaskCount || 0);
  const terminalCount = Number(sourcePacket.counts?.terminalTaskCount || 0);
  return [
    `# Project Status: ${project.title || sourcePacket.projectId || "Hive Board"}`,
    "",
    "## What This Project Is",
    `- ${project.summary || project.objective || "This board coordinates Task Node network work."}`,
    "",
    "## Why This Advances PFT Value",
    "- It routes verified contributor attention toward work that improves task throughput, quality, and reward confidence for PFT-denominated work.",
    "",
    "## Current Point People",
    "- Current contributors: Infer point people from active tasks, rewarded task history, and board comments before routing more work.",
    "",
    "## Operators Needed",
    "- Badge-eligible operators: Needed to convert board objectives into shipped, reviewed, or rewarded outcomes.",
    "",
    "## Next Tactics",
    `- Review ${activeCount} active task rows and remove blockers on accepted/submitted work.`,
    `- Use the ${terminalCount} recent terminal task rows to avoid repeating already rewarded work.`,
    "- Route the next task only after the task management agent confirms the target contributor is idle and the tactic is not duplicative.",
    "",
    "## Overall Strategy",
    "- Keep the board focused on a small number of concrete outcomes that compound network reliability and visible PFT utility.",
    "",
    "## Recommendation For Task Management Agent",
    "- Use this memo as advisory context only; create or route work only after checking current task state, badge eligibility, and duplicate history.",
  ].join("\n");
}

export async function fetchHiveBoardSecretaryMemo({
  sourcePacket = {},
  model = hiveBoardSecretaryModel(),
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const startedAt = Date.now();
  if (env.TASKNODE_HIVE_BOARD_SECRETARY_PROVIDER_MOCK === "true") {
    return {
      memoMarkdown: mockMemo(sourcePacket),
      provider: "mock",
      model: "mock-glm-board-secretary",
      responseId: `mock_hiveboardmemo_${createHash("sha256").update(JSON.stringify(sourcePacket)).digest("hex").slice(0, 16)}`,
      promptVersion: hiveBoardSecretaryPromptVersion,
      promptDigest: hiveBoardSecretaryPromptDigest(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      },
    };
  }

  if (!ambientConfigured(env)) {
    const error = new Error("hive_board_secretary_ambient_not_configured");
    error.status = 409;
    throw error;
  }

  const timeoutMs = providerTimeoutMs(env);
  try {
    const result = await ambientChatCompletion({
      env,
      fetchImpl,
      capability: "strict_json",
      timeoutMs,
      body: {
        model,
        messages: messagesForPacket(sourcePacket),
        reasoning: { effort: safeText(env.TASKNODE_HIVE_BOARD_SECRETARY_REASONING_EFFORT || "high", 40) },
        temperature: 0,
        max_tokens: Math.max(2000, Number(env.TASKNODE_HIVE_BOARD_SECRETARY_MAX_TOKENS || 6000)),
        metadata: {
          app: "tasknodeofficial",
          worker: "hive_board_secretary",
          prompt_version: hiveBoardSecretaryPromptVersion,
          source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
          project_id: safeText(sourcePacket.projectId, 180),
        },
      },
    });
    const body = result.body;
    const memoMarkdown = stripMarkdownFence(result.text);
    if (!memoMarkdown) throw new Error("hive_board_secretary_empty_memo");
    return {
      memoMarkdown,
      provider: "ambient",
      model: safeText(body?.model || model, 180),
      responseId: safeText(body?.id, 200),
      promptVersion: hiveBoardSecretaryPromptVersion,
      promptDigest: hiveBoardSecretaryPromptDigest(),
      usage: {
        ...openRouterUsage(body),
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.code === "ambient_timeout") {
      throw new Error("hive_board_secretary_ambient_timeout");
    }
    throw error;
  }
}
