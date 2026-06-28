import { createHash } from "node:crypto";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { hiveBoardSecretaryPromptVersion } from "./repositories/hive-board-secretary.js";

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const boardSecretaryPrompt = loadPrompt("hive/glm_board_secretary_status_memo_v1.md");

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function openRouterKey(env = process.env) {
  return safeText(env.OPENROUTER_API_KEY || env.OPENROUTER, 10000);
}

export function hiveBoardSecretaryProvider() {
  return "openrouter";
}

export function hiveBoardSecretaryModel(env = process.env) {
  return safeText(env.TASKNODE_HIVE_BOARD_SECRETARY_MODEL || "z-ai/glm-5.2", 180);
}

export function hiveBoardSecretaryPromptDigest() {
  return promptDigest(boardSecretaryPrompt);
}

export function hiveBoardSecretaryProviderConfigured(env = process.env) {
  return env.TASKNODE_HIVE_BOARD_SECRETARY_PROVIDER_MOCK === "true" || Boolean(openRouterKey(env));
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

  const apiKey = openRouterKey(env);
  if (!apiKey) {
    const error = new Error("hive_board_secretary_openrouter_not_configured");
    error.status = 409;
    throw error;
  }

  const controller = new AbortController();
  const timeoutMs = providerTimeoutMs(env);
  let timeout = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("hive_board_secretary_openrouter_timeout"));
      }, timeoutMs);
      timeout.unref?.();
    });
    const baseUrl = (env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
    const response = await Promise.race([fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": env.OPENROUTER_REFERER || env.TASKNODE_PUBLIC_URL || "https://tasknodeofficial-dev.fly.dev",
        "x-title": env.OPENROUTER_TITLE || "Task Node Official",
        "x-openrouter-title": env.OPENROUTER_TITLE || "Task Node Official",
      },
      body: JSON.stringify({
        model,
        messages: messagesForPacket(sourcePacket),
        reasoning: { effort: safeText(env.TASKNODE_HIVE_BOARD_SECRETARY_REASONING_EFFORT || "high", 40) },
        provider: {
          data_collection: "deny",
          require_parameters: true,
        },
        temperature: 0,
        max_tokens: Math.max(2000, Number(env.TASKNODE_HIVE_BOARD_SECRETARY_MAX_TOKENS || 6000)),
        usage: { include: true },
        metadata: {
          app: "tasknodeofficial",
          worker: "hive_board_secretary",
          prompt_version: hiveBoardSecretaryPromptVersion,
          source_packet_digest: safeText(sourcePacket.sourcePacketDigest, 120),
          project_id: safeText(sourcePacket.projectId, 180),
        },
      }),
    }), timeoutPromise]);
    const bodyText = await response.text();
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.message || `OpenRouter Hive Board Secretary HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const memoMarkdown = stripMarkdownFence(body?.choices?.[0]?.message?.content || "");
    if (!memoMarkdown) throw new Error("hive_board_secretary_empty_memo");
    return {
      memoMarkdown,
      provider: "openrouter",
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
    if (error?.name === "AbortError" || error?.message === "hive_board_secretary_openrouter_timeout") {
      throw new Error("hive_board_secretary_openrouter_timeout");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
