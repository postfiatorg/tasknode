import { createHash } from "node:crypto";
import { databaseEnabled } from "./db/pool.js";
import { loadPrompt } from "./prompt-registry.js";
import {
  claimHiveSecretaryJobs,
  completeHiveSecretaryJob,
  failHiveSecretaryJob,
  hiveSecretaryPromptVersion,
  normalizeHiveSecretaryOutput,
} from "./repositories/hive-context.js";
import { enqueueHiveProjectPlanningJob } from "./repositories/hive-project-planning.js";
import { scheduleHiveProjectQueue } from "./hive-project-worker.js";

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const defaultProviderOrder = ["parasail", "siliconflow", "atlas-cloud", "deepinfra", "akashml", "novita"];
const providerTimeoutMs = Math.max(5000, Number(process.env.TASKNODE_HIVE_SECRETARY_PROVIDER_TIMEOUT_MS || 240000));
const hiveSecretaryPrompt = loadPrompt("hive/hive_secretary_v1.md");
let timer = null;
let running = false;
let scheduled = null;

function openRouterKey() {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER || "";
}

function safeConfig(value = "", max = 200) {
  return String(value || "").trim().slice(0, max);
}

function unsupportedModel(model) {
  return /(?:^|[/_:])gpt-5\.5-pro(?:[-_.:/]|$)/i.test(safeConfig(model));
}

export function normalizeHiveSecretaryProvider(value = "openrouter") {
  const provider = safeConfig(value, 80).toLowerCase() || "openrouter";
  if (provider !== "openrouter") {
    throw new Error(`hive_secretary_provider_unsupported:${provider || "unknown"}`);
  }
  return provider;
}

export function normalizeHiveSecretaryModel(value = "z-ai/glm-5.2") {
  const rawModel = String(value || "").trim();
  if (unsupportedModel(rawModel)) {
    throw new Error(`hive_secretary_model_unsupported:${safeConfig(rawModel, 160).toLowerCase()}`);
  }
  const model = safeConfig(rawModel, 160) || "z-ai/glm-5.2";
  return model;
}

export function hiveSecretaryProvider(env = process.env) {
  return normalizeHiveSecretaryProvider(env.TASKNODE_HIVE_SECRETARY_PROVIDER || "openrouter");
}

function providerOrder() {
  const configured = process.env.TASKNODE_HIVE_SECRETARY_OPENROUTER_PROVIDERS || process.env.TASKNODE_MEMORY_OPENROUTER_PROVIDERS || "";
  return configured
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function hiveSecretaryModel(env = process.env) {
  return normalizeHiveSecretaryModel(env.TASKNODE_HIVE_SECRETARY_MODEL || "z-ai/glm-5.2");
}

function hiveSecretaryReasoningEffort() {
  return process.env.TASKNODE_HIVE_SECRETARY_REASONING_EFFORT || "high";
}

function hiveSecretaryEnabled() {
  const provider = hiveSecretaryProvider();
  hiveSecretaryModel();
  return (
    process.env.TASKNODE_HIVE_SECRETARY_ENABLED !== "false" &&
    databaseEnabled() &&
    provider === "openrouter" &&
    Boolean(openRouterKey())
  );
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
    );
}

function compactSourceText(value = "", maxLength = 60000) {
  const text = redactSensitiveText(value).trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength * 0.7))}\n\n[...middle truncated...]\n\n${text.slice(-Math.floor(maxLength * 0.3))}`;
}

function stripMarkdownFence(text = "") {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseHiveSecretaryJson(text = "") {
  const raw = stripMarkdownFence(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("hive_secretary_invalid_json");
  }
  const parsed = normalizeHiveSecretaryOutput(JSON.parse(raw.slice(start, end + 1)));
  if (!parsed.summary || !parsed.projectSignals.length) {
    throw new Error("hive_secretary_missing_fields");
  }
  return parsed;
}

function openRouterUsage(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    reasoningTokens: Number(usage.reasoning_tokens || usage.output_tokens_details?.reasoning_tokens || 0),
    costUsd: Number(usage.cost || 0),
  };
}

function hiveSecretaryTextFormat() {
  return {
    type: "json_schema",
    name: "hive_secretary_report",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "summary", "project_signals", "network_implications", "open_questions", "next_system_focus"],
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        project_signals: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["project_type", "signal", "reason", "input_refs"],
            properties: {
              project_type: {
                type: "string",
                enum: [
                  "protocol_marketing",
                  "protocol_development",
                  "alpha_generation",
                  "protocol_applications",
                  "network_validation",
                ],
              },
              signal: { type: "string" },
              reason: { type: "string" },
              input_refs: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
        network_implications: { type: "array", items: { type: "string" } },
        open_questions: { type: "array", items: { type: "string" } },
        next_system_focus: { type: "array", items: { type: "string" } },
      },
    },
  };
}

function hiveSecretaryResponseFormat() {
  const { type: _type, ...jsonSchema } = hiveSecretaryTextFormat();
  return { type: "json_schema", json_schema: jsonSchema };
}

async function fetchHiveSecretaryReportOpenRouter(source, { fetchImpl, model } = {}) {
  const baseUrl = (process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "");
  const order = providerOrder();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
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
        model,
        messages: [
          { role: "system", content: hiveSecretaryPrompt },
          { role: "user", content: compactSourceText(source.source_packet_text, 60000) },
        ],
        reasoning: { effort: hiveSecretaryReasoningEffort() },
        response_format: hiveSecretaryResponseFormat(),
        provider: {
          zdr: true,
          data_collection: "deny",
          require_parameters: true,
          order: order.length > 0 ? order : defaultProviderOrder,
          only: order.length > 0 ? order : defaultProviderOrder,
        },
        temperature: 0,
        max_tokens: Math.max(900, Number(process.env.TASKNODE_HIVE_SECRETARY_MAX_TOKENS || 1800)),
        usage: { include: true },
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("hive_secretary_provider_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `OpenRouter Hive Secretary HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const content = body?.choices?.[0]?.message?.content || "";
  return {
    output: parseHiveSecretaryJson(content),
    provider: "openrouter",
    model: body?.model || model,
    promptDigest: promptDigest(hiveSecretaryPrompt),
    promptVersion: hiveSecretaryPromptVersion,
    usage: openRouterUsage(body),
  };
}

export async function fetchHiveSecretaryReport(source, { fetchImpl = fetch, provider, model } = {}) {
  const resolvedProvider = normalizeHiveSecretaryProvider(provider || hiveSecretaryProvider());
  const resolvedModel = normalizeHiveSecretaryModel(model || hiveSecretaryModel());
  if (resolvedProvider !== "openrouter") {
    throw new Error(`hive_secretary_provider_unsupported:${resolvedProvider}`);
  }
  if (!openRouterKey()) {
    const error = new Error("hive_secretary_openrouter_not_configured");
    error.status = 409;
    throw error;
  }
  return fetchHiveSecretaryReportOpenRouter(source, { fetchImpl, model: resolvedModel });
}

export async function processHiveSecretaryQueueOnce({ limit = 1 } = {}) {
  if (!hiveSecretaryEnabled()) {
    return { ok: true, skipped: true, reason: "hive_secretary_not_configured" };
  }
  if (running) return { ok: true, skipped: true, reason: "hive_secretary_busy" };

  running = true;
  let processed = 0;
  let failed = 0;
  let claimed = 0;
  try {
    const jobs = await claimHiveSecretaryJobs({ limit });
    claimed = jobs.length;
    for (const job of jobs) {
      try {
        if (!job?.source_packet_text) {
          throw new Error("hive_secretary_source_missing");
        }
        const result = await fetchHiveSecretaryReport(job);
        const completed = await completeHiveSecretaryJob({
          job,
          output: result.output,
          provider: result.provider,
          model: result.model,
          promptDigest: result.promptDigest,
          promptVersion: result.promptVersion,
          usage: result.usage,
        });
        if (completed?.report) {
          await enqueueHiveProjectPlanningJob({ report: completed.report, reason: "hive_secretary_completed" });
          scheduleHiveProjectQueue({ delayMs: 500 });
        }
        processed += 1;
      } catch (error) {
        failed += 1;
        await failHiveSecretaryJob(job, error);
      }
    }
    return { ok: true, claimed, processed, failed };
  } finally {
    running = false;
  }
}

export function scheduleHiveSecretaryQueue({ delayMs = 250 } = {}) {
  if (scheduled || !hiveSecretaryEnabled()) {
    return { scheduled: false };
  }
  scheduled = setTimeout(() => {
    scheduled = null;
    processHiveSecretaryQueueOnce({ limit: 1 })
      .catch((error) => console.warn(`hive secretary worker failed: ${error?.message || error}`));
  }, Math.max(0, Number(delayMs) || 0));
  scheduled.unref?.();
  return { scheduled: true };
}

export function startHiveSecretaryWorker() {
  if (timer || process.env.TASKNODE_HIVE_SECRETARY_ENABLED === "false" || !hiveSecretaryEnabled()) {
    return { ok: true, skipped: true };
  }
  const intervalMs = Math.max(5000, Number(process.env.TASKNODE_HIVE_SECRETARY_INTERVAL_MS || 15000));
  const tick = () => {
    processHiveSecretaryQueueOnce({ limit: Number(process.env.TASKNODE_HIVE_SECRETARY_BATCH_SIZE || 1) })
      .catch((error) => console.warn(`hive secretary worker failed: ${error?.message || error}`));
  };
  const initial = setTimeout(tick, 3000);
  initial.unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { ok: true, intervalMs };
}
