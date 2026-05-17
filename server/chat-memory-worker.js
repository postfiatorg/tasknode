import { databaseEnabled } from "./db/pool.js";
import {
  chatMemoryJobSource,
  claimChatMemoryJobs,
  claimDeepMemoryJobs,
  completeChatMemoryJob,
  completeDeepMemoryJob,
  deepMemoryBlockSize,
  deepMemoryJobSource,
  failDeepMemoryJob,
  failChatMemoryJob,
} from "./repositories/chat-memory.js";

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const defaultProviderOrder = ["parasail", "siliconflow", "atlas-cloud", "deepinfra", "akashml", "novita"];
const providerTimeoutMs = Math.max(5000, Number(process.env.TASKNODE_MEMORY_PROVIDER_TIMEOUT_MS || 45000));
const promptVersion = "chat_memory_v1";
const deepPromptVersion = "deep_memory_v1";
let timer = null;
let running = false;

function openRouterKey() {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER || "";
}

function providerOrder() {
  const configured = process.env.TASKNODE_MEMORY_OPENROUTER_PROVIDERS || "";
  return configured
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function memoryModel() {
  return process.env.TASKNODE_MEMORY_MODEL || "deepseek/deepseek-v4-flash";
}

function memoryWorkerEnabled() {
  return (
    process.env.TASKNODE_MEMORY_ENABLED !== "false" &&
    databaseEnabled() &&
    Boolean(openRouterKey())
  );
}

function memorySystemPrompt() {
  return [
    "You create compact private memory records from one Task Node chat exchange.",
    "Return only valid JSON with keys user_request_summary, system_response_summary, and memory_text.",
    "Return raw JSON only: no markdown fence, no prose before or after the JSON object.",
    "user_request_summary must be 2-3 sentences summarizing what the user asked or implied.",
    "system_response_summary must be 2-3 sentences summarizing what the assistant answered or committed to.",
    "memory_text must preserve durable facts, preferences, goals, constraints, decisions, and follow-ups useful for future work.",
    "Do not include secrets, seed phrases, private keys, access tokens, API keys, or passwords.",
  ].join("\n");
}

function deepMemorySystemPrompt() {
  return [
    "You create account-level deep memory from exactly 36 compact Task Node memory records.",
    "Return raw JSON only: no markdown fence, no prose before or after the JSON object.",
    "Return keys user_request_summary_bullets, system_response_summary_bullets, and memory_text.",
    "user_request_summary_bullets must be an array of up to 5 strings, each 1-2 sentences.",
    "system_response_summary_bullets must be an array of up to 5 strings, each 1-2 sentences.",
    "memory_text must be exactly 3 sentences summarizing what the user is exploring and how the system responded.",
    "Do not include secrets, seed phrases, private keys, access tokens, API keys, or passwords.",
  ].join("\n");
}

function redactSensitiveText(value = "") {
  return String(value || "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted_api_key]")
    .replace(/\b(?:0x)?[a-fA-F0-9]{64}\b/g, "[redacted_secret_or_hash]")
    .replace(
      /\b(seed phrase|recovery phrase|mnemonic|private key|password)\s*[:=]\s*[^\n\r]+/gi,
      "$1: [redacted]"
    );
}

function compactSourceText(value = "", maxLength = 16000) {
  const text = redactSensitiveText(value).trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength * 0.65))}\n\n[...middle truncated...]\n\n${text.slice(-Math.floor(maxLength * 0.35))}`;
}

function boundedDeepMemoryEntry(entry, index) {
  return {
    block_position: index + 1,
    chat_title: compactSourceText(entry.conversationTitle, 180),
    user_request_summary: compactSourceText(entry.userRequestSummary, 1800),
    system_response_summary: compactSourceText(entry.systemResponseSummary, 1800),
    memory_text: compactSourceText(entry.memoryText, 2400),
  };
}

function stripMarkdownFence(text = "") {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function bulletText(value, { maxItems = 5 } = {}) {
  if (Array.isArray(value)) {
    return value
      .slice(0, maxItems)
      .map((item) => String(item || "").trim().replace(/^[-*]\s+/, ""))
      .filter(Boolean)
      .map((item) => `- ${item}`)
      .join("\n");
  }
  return String(value || "").trim();
}

function parsedSummaryObject(parsed) {
  return {
    userRequestSummary: bulletText(
      parsed.user_request_summary_bullets ||
        parsed.user_request_bullets ||
        parsed.user_requests ||
        parsed.user_request_summary
    ),
    systemResponseSummary: bulletText(
      parsed.system_response_summary_bullets ||
        parsed.system_response_bullets ||
        parsed.system_responses ||
        parsed.system_response_summary
    ),
    memoryText: String(parsed.memory_text || parsed.memory || "").trim(),
  };
}

function parseSummaryJson(text = "") {
  const raw = stripMarkdownFence(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("memory_summary_invalid_json");
  }
  const parsed = JSON.parse(raw.slice(start, end + 1));
  return parsedSummaryObject(parsed);
}

function openRouterUsage(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    costUsd: Number(usage.cost || 0),
  };
}

async function fetchMemorySummary(source) {
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const order = providerOrder();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);
  const userPayload = {
    conversation_title: source.conversation_title || "New chat",
    user_query: compactSourceText(source.user_body, 12000),
    system_response: compactSourceText(source.assistant_body, 18000),
  };
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${openRouterKey()}`,
        "content-type": "application/json",
        "http-referer": process.env.OPENROUTER_REFERER || process.env.TASKNODE_PUBLIC_URL || "https://tasknodeofficial-dev.fly.dev",
        "x-title": process.env.OPENROUTER_TITLE || "Task Node Official",
        "x-openrouter-title": process.env.OPENROUTER_TITLE || "Task Node Official",
      },
      body: JSON.stringify({
        model: memoryModel(),
        messages: [
          { role: "system", content: memorySystemPrompt() },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
        provider: {
          zdr: true,
          data_collection: "deny",
          order: order.length > 0 ? order : defaultProviderOrder,
          only: order.length > 0 ? order : defaultProviderOrder,
        },
        temperature: 0.1,
        max_tokens: 700,
        usage: { include: true },
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("memory_provider_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `OpenRouter memory HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const content = body?.choices?.[0]?.message?.content || "";
  const parsed = parseSummaryJson(content);
  if (!parsed.userRequestSummary || !parsed.systemResponseSummary || !parsed.memoryText) {
    throw new Error("memory_summary_missing_fields");
  }

  return {
    ...parsed,
    conversationTitle: source.conversation_title || "New chat",
    sourceUserExcerpt: compactSourceText(source.user_body, 500),
    sourceAssistantExcerpt: compactSourceText(source.assistant_body, 500),
    provider: "openrouter",
    model: body?.model || memoryModel(),
    promptVersion,
    usage: openRouterUsage(body),
  };
}

async function fetchDeepMemorySummary(source) {
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const order = providerOrder();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);
  const memorySummaries = source.entries.map(boundedDeepMemoryEntry);
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${openRouterKey()}`,
        "content-type": "application/json",
        "http-referer": process.env.OPENROUTER_REFERER || process.env.TASKNODE_PUBLIC_URL || "https://tasknodeofficial-dev.fly.dev",
        "x-title": process.env.OPENROUTER_TITLE || "Task Node Official",
        "x-openrouter-title": process.env.OPENROUTER_TITLE || "Task Node Official",
      },
      body: JSON.stringify({
        model: memoryModel(),
        messages: [
          { role: "system", content: deepMemorySystemPrompt() },
          {
            role: "user",
            content: JSON.stringify({
              deep_memory_block_index: source.block_index,
              summary_count: memorySummaries.length,
              memory_summaries: memorySummaries,
            }),
          },
        ],
        provider: {
          zdr: true,
          data_collection: "deny",
          order: order.length > 0 ? order : defaultProviderOrder,
          only: order.length > 0 ? order : defaultProviderOrder,
        },
        temperature: 0.1,
        max_tokens: Math.max(3500, Number(process.env.TASKNODE_DEEP_MEMORY_MAX_TOKENS || 12000)),
        usage: { include: true },
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("deep_memory_provider_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `OpenRouter deep memory HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const content = body?.choices?.[0]?.message?.content || "";
  const parsed = parseSummaryJson(content);
  if (!parsed.userRequestSummary || !parsed.systemResponseSummary || !parsed.memoryText) {
    throw new Error("deep_memory_summary_missing_fields");
  }

  return {
    ...parsed,
    sourceUserExcerpt: `${memorySummaries.length} memory summaries in block ${source.block_index}.`,
    sourceAssistantExcerpt: `Deep memory synthesis for block ${source.block_index}.`,
    provider: "openrouter",
    model: body?.model || memoryModel(),
    promptVersion: deepPromptVersion,
    usage: openRouterUsage(body),
  };
}

export async function processMemoryQueueOnce({ limit = 3 } = {}) {
  if (!memoryWorkerEnabled()) {
    return { ok: true, skipped: true, reason: "memory_worker_not_configured" };
  }
  if (running) return { ok: true, skipped: true, reason: "memory_worker_busy" };

  running = true;
  let processed = 0;
  let failed = 0;
  let deepProcessed = 0;
  let deepFailed = 0;
  let deepClaimed = 0;
  try {
    const jobs = await claimChatMemoryJobs({ limit });
    for (const job of jobs) {
      try {
        const source = await chatMemoryJobSource(job);
        if (!source?.user_body || !source?.assistant_body) {
          throw new Error("memory_job_source_missing");
        }
        const summary = await fetchMemorySummary(source);
        await completeChatMemoryJob({ job: source, summary });
        processed += 1;
      } catch (error) {
        failed += 1;
        await failChatMemoryJob(job, error);
      }
    }
    const deepJobs = await claimDeepMemoryJobs({ limit: Math.max(1, Math.floor(Number(limit || 1) / 2)) });
    deepClaimed = deepJobs.length;
    for (const job of deepJobs) {
      try {
        const source = await deepMemoryJobSource(job);
        if (!source?.entries || source.entries.length !== deepMemoryBlockSize) {
          throw new Error("deep_memory_job_source_incomplete");
        }
        const summary = await fetchDeepMemorySummary(source);
        await completeDeepMemoryJob({ job: source, summary });
        deepProcessed += 1;
      } catch (error) {
        deepFailed += 1;
        await failDeepMemoryJob(job, error);
      }
    }
    return {
      ok: true,
      processed,
      failed,
      claimed: jobs.length,
      deepProcessed,
      deepFailed,
      deepClaimed,
    };
  } finally {
    running = false;
  }
}

export function startMemoryWorker() {
  if (timer || process.env.TASKNODE_MEMORY_ENABLED === "false" || !memoryWorkerEnabled()) {
    return { ok: true, skipped: true };
  }
  const intervalMs = Math.max(5000, Number(process.env.TASKNODE_MEMORY_INTERVAL_MS || 15000));
  const tick = () => {
    processMemoryQueueOnce({ limit: Number(process.env.TASKNODE_MEMORY_BATCH_SIZE || 3) })
      .catch((error) => console.warn(`chat memory worker failed: ${error?.message || error}`));
  };
  const initial = setTimeout(tick, 2500);
  initial.unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { ok: true, intervalMs };
}
