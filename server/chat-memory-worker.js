import { createHash } from "node:crypto";
import { databaseEnabled } from "./db/pool.js";
import { loadPrompt } from "./prompt-registry.js";
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
import {
  claimNetworkTaskProfileJobs,
  completeNetworkTaskProfileJob,
  enqueueNetworkTaskProfilesForRewardedAccounts,
  failNetworkTaskProfileJob,
  networkTaskProfilePromptVersion,
} from "./repositories/network-task-profile.js";
import {
  AMBIENT_MODELS,
  ambientChatCompletion,
  ambientConfigured,
} from "./ambient-inference.js";
import {
  claimRewardedTaskMemoryJobs,
  completeRewardedTaskMemoryJob,
  enqueueMissingRewardedTaskMemoryJobs,
  failRewardedTaskMemoryJob,
} from "./repositories/task-reward-memory.js";

const providerTimeoutMs = Math.max(5000, Number(process.env.TASKNODE_MEMORY_PROVIDER_TIMEOUT_MS || 45000));
const promptVersion = "chat_memory_v1";
const deepPromptVersion = "deep_memory_v1";
const chatMemoryPrompt = loadPrompt("memory/chat_memory_v1.md");
const deepMemoryPrompt = loadPrompt("memory/deep_memory_v1.md");
const networkTaskProfilePrompt = loadPrompt("memory/network_task_profile_v2.md");
const rewardedTaskMemoryPrompt = loadPrompt("memory/rewarded_task_memory_v1.md");
const rewardedTaskMemoryPromptVersion = "rewarded_task_memory_v1";
let timer = null;
let running = false;

function memoryModel() {
  return process.env.TASKNODE_MEMORY_MODEL || AMBIENT_MODELS.fastText;
}

function memoryWorkerEnabled() {
  return (
    process.env.TASKNODE_MEMORY_ENABLED !== "false" &&
    databaseEnabled() &&
    ambientConfigured()
  );
}

function memorySystemPrompt() {
  return chatMemoryPrompt;
}

function deepMemorySystemPrompt() {
  return deepMemoryPrompt;
}

function networkTaskProfileSystemPrompt() {
  return networkTaskProfilePrompt;
}

function envNumberAtLeast(name, fallback, minimum) {
  const parsed = Number(process.env[name] || fallback);
  return Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback);
}

export function turnMemoryMaxTokens() {
  return envNumberAtLeast("TASKNODE_MEMORY_MAX_TOKENS", 1200, 900);
}

export function deepMemoryMaxTokens() {
  return envNumberAtLeast("TASKNODE_DEEP_MEMORY_MAX_TOKENS", 12000, 3500);
}

export function networkTaskProfileMaxTokens() {
  return envNumberAtLeast("TASKNODE_NETWORK_TASK_PROFILE_MAX_TOKENS", 1800, 900);
}

export function rewardedTaskMemoryMaxTokens() {
  return envNumberAtLeast("TASKNODE_REWARDED_TASK_MEMORY_MAX_TOKENS", 1200, 900);
}

export function memoryOpenRouterProviderPreferences() {
  return {};
}

export function memoryOpenRouterRequestBody({ messages = [], temperature = 0.1, maxTokens = turnMemoryMaxTokens() } = {}) {
  return {
    model: memoryModel(),
    messages,
    reasoning: {
      effort: "none",
      exclude: true,
    },
    response_format: { type: "json_object" },
    temperature,
    max_tokens: maxTokens,
  };
}

function promptDigest(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function redactSensitiveText(value = "") {
  return String(value || "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted_api_key]")
    .replace(/\b(?:0x)?[a-fA-F0-9]{64}\b/g, "[redacted_secret_or_hash]")
    .replace(
      /\b(seed phrase|recovery phrase|mnemonic|private key|password)\s*[:=]\s*[^\n\r]+/gi,
      "$1: [redacted]"
    )
    .replace(
      /("(?:seed_phrase|recovery_phrase|mnemonic|private_key|password|api_key|access_token)"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"'
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

function stringArray(value, { maxItems = 5, maxLength = 260 } = {}) {
  const values = Array.isArray(value) ? value : [];
  return values
    .slice(0, maxItems)
    .map((item) => compactSourceText(item, maxLength))
    .filter(Boolean);
}

function parseNetworkTaskProfileJson(text = "") {
  const raw = stripMarkdownFence(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("network_task_profile_invalid_json");
  }
  const parsed = JSON.parse(raw.slice(start, end + 1));
  return {
    profile_title: compactSourceText(parsed.profile_title, 160),
    current_focus: stringArray(parsed.current_focus, { maxItems: 6, maxLength: 420 }),
    primary_contribution_ability: stringArray(parsed.primary_contribution_ability, { maxItems: 6, maxLength: 460 }),
    domain_expertise: stringArray(parsed.domain_expertise, { maxItems: 10, maxLength: 520 }),
  };
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
  const userPayload = {
    conversation_title: source.conversation_title || "New chat",
    user_query: compactSourceText(source.user_body, 12000),
    system_response: compactSourceText(source.assistant_body, 18000),
  };
  const result = await ambientChatCompletion({
    capability: "fast_text",
    timeoutMs: providerTimeoutMs,
    body: memoryOpenRouterRequestBody({
      messages: [
        { role: "system", content: memorySystemPrompt() },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      temperature: 0.1,
      maxTokens: turnMemoryMaxTokens(),
    }),
  });
  const body = result.body;

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
    provider: "ambient",
    model: body?.model || memoryModel(),
    promptVersion,
    usage: openRouterUsage(body),
  };
}

async function fetchDeepMemorySummary(source) {
  const memorySummaries = source.entries.map(boundedDeepMemoryEntry);
  const result = await ambientChatCompletion({
    capability: "fast_text",
    timeoutMs: providerTimeoutMs,
    body: memoryOpenRouterRequestBody({
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
      temperature: 0.1,
      maxTokens: deepMemoryMaxTokens(),
    }),
  });
  const body = result.body;

  const content = body?.choices?.[0]?.message?.content || "";
  const parsed = parseSummaryJson(content);
  if (!parsed.userRequestSummary || !parsed.systemResponseSummary || !parsed.memoryText) {
    throw new Error("deep_memory_summary_missing_fields");
  }

  return {
    ...parsed,
    sourceUserExcerpt: `${memorySummaries.length} memory summaries in block ${source.block_index}.`,
    sourceAssistantExcerpt: `Deep memory synthesis for block ${source.block_index}.`,
    provider: "ambient",
    model: body?.model || memoryModel(),
    promptVersion: deepPromptVersion,
    usage: openRouterUsage(body),
  };
}

async function fetchNetworkTaskProfile(source) {
  const result = await ambientChatCompletion({
    capability: "fast_text",
    timeoutMs: providerTimeoutMs,
    body: memoryOpenRouterRequestBody({
      messages: [
        { role: "system", content: networkTaskProfileSystemPrompt() },
        { role: "user", content: compactSourceText(source.source_packet_text, 60000) },
      ],
      temperature: 0,
      maxTokens: networkTaskProfileMaxTokens(),
    }),
  });
  const body = result.body;

  const content = body?.choices?.[0]?.message?.content || "";
  const parsed = parseNetworkTaskProfileJson(content);
  if (
    !parsed.profile_title ||
    !parsed.current_focus.length ||
    !parsed.primary_contribution_ability.length ||
    !parsed.domain_expertise.length
  ) {
    throw new Error("network_task_profile_missing_fields");
  }

  return {
    output: parsed,
    provider: "ambient",
    model: body?.model || memoryModel(),
    promptDigest: promptDigest(networkTaskProfileSystemPrompt()),
    promptVersion: networkTaskProfilePromptVersion,
    usage: openRouterUsage(body),
  };
}

async function fetchRewardedTaskMemorySummary(source) {
  const result = await ambientChatCompletion({
    capability: "fast_text",
    allowCapacityFallback: false,
    timeoutMs: providerTimeoutMs,
    body: memoryOpenRouterRequestBody({
      messages: [
        { role: "system", content: rewardedTaskMemoryPrompt },
        { role: "user", content: compactSourceText(source.source_packet_text, 60000) },
      ],
      temperature: 0.1,
      maxTokens: rewardedTaskMemoryMaxTokens(),
    }),
  });
  const body = result.body;
  const parsed = parseSummaryJson(body?.choices?.[0]?.message?.content || "");
  if (!parsed.userRequestSummary || !parsed.systemResponseSummary || !parsed.memoryText) {
    throw new Error("rewarded_task_memory_summary_missing_fields");
  }
  return {
    ...parsed,
    provider: "ambient",
    model: body?.model || memoryModel(),
    promptVersion: rewardedTaskMemoryPromptVersion,
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
  let networkProfileProcessed = 0;
  let networkProfileFailed = 0;
  let networkProfileClaimed = 0;
  let networkProfileSeeded = 0;
  let networkProfileSeedFailed = 0;
  let rewardedTaskProcessed = 0;
  let rewardedTaskFailed = 0;
  let rewardedTaskClaimed = 0;
  let rewardedTaskSeeded = 0;
  let rewardedTaskSeedFailed = 0;
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
    const rewardedTaskSeed = await enqueueMissingRewardedTaskMemoryJobs({
      limit: Math.min(Math.max(Number(process.env.TASKNODE_REWARDED_TASK_MEMORY_AUTO_QUEUE_LIMIT || 3), 1), 25),
    }).catch((error) => ({
      queuedCount: 0,
      failedCount: 1,
      error: error?.message || String(error),
    }));
    rewardedTaskSeeded = Number(rewardedTaskSeed.queuedCount || 0);
    rewardedTaskSeedFailed = Number(rewardedTaskSeed.failedCount || 0);
    const rewardedTaskJobs = await claimRewardedTaskMemoryJobs({ limit });
    rewardedTaskClaimed = rewardedTaskJobs.length;
    for (const job of rewardedTaskJobs) {
      try {
        if (!job?.source_packet_text) throw new Error("rewarded_task_memory_source_missing");
        const summary = await fetchRewardedTaskMemorySummary(job);
        await completeRewardedTaskMemoryJob({ job, summary });
        rewardedTaskProcessed += 1;
      } catch (error) {
        rewardedTaskFailed += 1;
        await failRewardedTaskMemoryJob(job, error);
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
    const seedLimit = Math.min(
      Math.max(Number(process.env.TASKNODE_NETWORK_TASK_PROFILE_AUTO_QUEUE_LIMIT || 2), 1),
      10
    );
    const seedResult = await enqueueNetworkTaskProfilesForRewardedAccounts({
      limit: seedLimit,
      reason: "rewarded_task_threshold_worker",
    }).catch((error) => ({
      queuedCount: 0,
      failedCount: 1,
      error: error?.message || String(error),
    }));
    networkProfileSeeded = Number(seedResult.queuedCount || 0);
    networkProfileSeedFailed = Number(seedResult.failedCount || 0);

    const networkJobs = await claimNetworkTaskProfileJobs({ limit: 1 });
    networkProfileClaimed = networkJobs.length;
    for (const job of networkJobs) {
      try {
        if (!job?.source_packet_text) {
          throw new Error("network_task_profile_source_missing");
        }
        const result = await fetchNetworkTaskProfile(job);
        await completeNetworkTaskProfileJob({
          job,
          output: result.output,
          provider: result.provider,
          model: result.model,
          promptDigest: result.promptDigest,
          usage: result.usage,
        });
        networkProfileProcessed += 1;
      } catch (error) {
        networkProfileFailed += 1;
        await failNetworkTaskProfileJob(job, error);
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
      networkProfileProcessed,
      networkProfileFailed,
      networkProfileClaimed,
      networkProfileSeeded,
      networkProfileSeedFailed,
      rewardedTaskProcessed,
      rewardedTaskFailed,
      rewardedTaskClaimed,
      rewardedTaskSeeded,
      rewardedTaskSeedFailed,
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
