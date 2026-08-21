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
import { AMBIENT_MODELS, ambientChatCompletion, ambientConfigured } from "./ambient-inference.js";

const providerTimeoutMs = Math.max(5000, Number(process.env.TASKNODE_HIVE_SECRETARY_PROVIDER_TIMEOUT_MS || 240000));
const hiveSecretaryPrompt = loadPrompt("hive/hive_secretary_v1.md");
let timer = null;
let running = false;
let scheduled = null;

function safeConfig(value = "", max = 200) {
  return String(value || "").trim().slice(0, max);
}

export function normalizeHiveSecretaryProvider(value = "ambient") {
  const provider = safeConfig(value, 80).toLowerCase() || "ambient";
  if (provider !== "ambient") {
    throw new Error(`hive_secretary_provider_unsupported:${provider || "unknown"}`);
  }
  return provider;
}

export function normalizeHiveSecretaryModel(value = AMBIENT_MODELS.structured) {
  const rawModel = String(value || "").trim();
  const model = safeConfig(rawModel, 160) || AMBIENT_MODELS.structured;
  return model;
}

export function hiveSecretaryProvider(env = process.env) {
  return normalizeHiveSecretaryProvider(env.TASKNODE_HIVE_SECRETARY_PROVIDER || "ambient");
}

export function hiveSecretaryModel(env = process.env) {
  return normalizeHiveSecretaryModel(env.TASKNODE_HIVE_SECRETARY_MODEL || AMBIENT_MODELS.structured);
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
    provider === "ambient" &&
    ambientConfigured()
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
  const result = await ambientChatCompletion({
    fetchImpl,
    capability: "strict_json",
    timeoutMs: providerTimeoutMs,
    body: {
        model,
        messages: [
          { role: "system", content: hiveSecretaryPrompt },
          { role: "user", content: compactSourceText(source.source_packet_text, 60000) },
        ],
        reasoning: { effort: hiveSecretaryReasoningEffort() },
        response_format: hiveSecretaryResponseFormat(),
        temperature: 0,
        max_tokens: Math.max(900, Number(process.env.TASKNODE_HIVE_SECRETARY_MAX_TOKENS || 1800)),
      },
  });
  const body = result.body;

  const content = body?.choices?.[0]?.message?.content || "";
  return {
    output: parseHiveSecretaryJson(content),
    provider: "ambient",
    model: body?.model || model,
    promptDigest: promptDigest(hiveSecretaryPrompt),
    promptVersion: hiveSecretaryPromptVersion,
    usage: openRouterUsage(body),
  };
}

export async function fetchHiveSecretaryReport(source, { fetchImpl = fetch, provider, model } = {}) {
  const resolvedProvider = normalizeHiveSecretaryProvider(provider || hiveSecretaryProvider());
  const resolvedModel = normalizeHiveSecretaryModel(model || hiveSecretaryModel());
  if (resolvedProvider !== "ambient") {
    throw new Error(`hive_secretary_provider_unsupported:${resolvedProvider}`);
  }
  if (!ambientConfigured()) {
    const error = new Error("hive_secretary_ambient_not_configured");
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
