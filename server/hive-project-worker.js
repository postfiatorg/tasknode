import { loadPrompt, promptDigest } from "./prompt-registry.js";
import {
  claimHiveProjectPlanningJobs,
  completeHiveProjectPlanningJob,
  failHiveProjectPlanningJob,
  hiveProjectPlanningPromptVersion,
  normalizeHiveProjectPlanningOutput,
} from "./repositories/hive-project-planning.js";
import { databaseEnabled } from "./db/pool.js";

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const hiveProjectPrompt = loadPrompt("hive/hive_active_projects_v1.md");
const projectTimeoutMs = Math.max(30000, Number(process.env.TASKNODE_HIVE_PROJECT_TIMEOUT_MS || 240000));
let timer = null;
let running = false;
let scheduled = null;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function openRouterKey() {
  return safeText(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER, 10000);
}

function unsupportedModel(model) {
  return /(?:^|[/_:])gpt-5\.5-pro(?:[-_.:/]|$)/i.test(safeText(model, 160));
}

export function normalizeHiveProjectProvider(value = "openrouter") {
  const provider = safeText(value, 80).toLowerCase() || "openrouter";
  if (provider !== "openrouter") {
    throw new Error(`hive_project_provider_unsupported:${provider || "unknown"}`);
  }
  return provider;
}

export function normalizeHiveProjectModel(value = "z-ai/glm-5.2") {
  const rawModel = String(value || "").trim();
  if (unsupportedModel(rawModel)) {
    throw new Error(`hive_project_model_unsupported:${safeText(rawModel, 160).toLowerCase()}`);
  }
  const model = safeText(rawModel, 160) || "z-ai/glm-5.2";
  return model;
}

export function hiveProjectProvider(env = process.env) {
  return normalizeHiveProjectProvider(env.TASKNODE_HIVE_PROJECT_PROVIDER || "openrouter");
}

export function hiveProjectModel(env = process.env) {
  return normalizeHiveProjectModel(env.TASKNODE_HIVE_PROJECT_MODEL || "z-ai/glm-5.2");
}

function hiveProjectReasoningEffort() {
  return safeText(process.env.TASKNODE_HIVE_PROJECT_REASONING_EFFORT || "high", 40);
}

function hiveProjectEnabled() {
  const provider = hiveProjectProvider();
  hiveProjectModel();
  return (
    process.env.TASKNODE_HIVE_PROJECT_WORKER_ENABLED !== "false" &&
    databaseEnabled() &&
    provider === "openrouter" &&
    Boolean(openRouterKey())
  );
}

function compactSourceText(value = "", maxLength = 90000) {
  const text = String(value || "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted_api_key]")
    .replace(/\b(?:0x)?[a-fA-F0-9]{64}\b/g, "[redacted_secret_or_hash]")
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength * 0.7))}\n\n[...middle truncated...]\n\n${text.slice(-Math.floor(maxLength * 0.3))}`;
}

function outputText(body = {}) {
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function parseOutput(body = {}) {
  const text = outputText(body);
  const parsed = text ? JSON.parse(text) : {};
  return normalizeHiveProjectPlanningOutput(parsed);
}

function usageFromOpenRouter(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    reasoningTokens: Number(usage.reasoning_tokens || usage.output_tokens_details?.reasoning_tokens || 0),
    costUsd: Number(usage.cost || 0),
  };
}

function projectTextFormat() {
  return {
    type: "json_schema",
    name: "hive_active_projects",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "summary", "projects"],
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        projects: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "type",
              "title",
              "summary",
              "objective",
              "about",
              "phase_label",
              "phase_current",
              "phase_total",
              "task_count",
              "contributor_count",
              "pft_routed",
              "priority",
              "rationale",
            ],
            properties: {
              id: { type: "string" },
              type: {
                type: "string",
                enum: [
                  "protocol_marketing",
                  "protocol_development",
                  "alpha_generation",
                  "protocol_applications",
                  "network_validation",
                ],
              },
              title: { type: "string" },
              summary: { type: "string" },
              objective: { type: "string" },
              about: { type: "string" },
              phase_label: { type: "string" },
              phase_current: { type: "integer" },
              phase_total: { type: "integer" },
              task_count: { type: "integer" },
              contributor_count: { type: "integer" },
              pft_routed: { type: "number" },
              priority: { type: "integer" },
              rationale: { type: "string" },
            },
          },
        },
      },
    },
  };
}

function projectResponseFormat() {
  const { type: _type, ...jsonSchema } = projectTextFormat();
  return { type: "json_schema", json_schema: jsonSchema };
}

export async function fetchHiveActiveProjects(job, { fetchImpl = fetch, provider, model } = {}) {
  const resolvedProvider = normalizeHiveProjectProvider(provider || hiveProjectProvider());
  const resolvedModel = normalizeHiveProjectModel(model || hiveProjectModel());
  if (resolvedProvider !== "openrouter") {
    throw new Error(`hive_project_provider_unsupported:${resolvedProvider}`);
  }
  if (!openRouterKey()) {
    const error = new Error("hive_project_openrouter_not_configured");
    error.status = 409;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), projectTimeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${(process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${openRouterKey()}`,
        "content-type": "application/json",
        "http-referer": process.env.OPENROUTER_REFERER || process.env.TASKNODE_PUBLIC_URL || "https://tasknodeofficial-dev.fly.dev",
        "x-title": process.env.OPENROUTER_TITLE || "Task Node Official",
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [
          { role: "system", content: hiveProjectPrompt },
          { role: "user", content: compactSourceText(job.source_packet_text, 90000) },
        ],
        reasoning: { effort: hiveProjectReasoningEffort() },
        response_format: projectResponseFormat(),
        provider: { data_collection: "deny", require_parameters: true },
        temperature: 0,
        max_tokens: Math.max(4000, Number(process.env.TASKNODE_HIVE_PROJECT_MAX_OUTPUT_TOKENS || 12000)),
        usage: { include: true },
        metadata: {
          app: "tasknodeofficial",
          worker: "hive_active_projects",
          prompt_version: hiveProjectPlanningPromptVersion,
        },
      }),
    });
    const bodyText = await response.text();
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (!response.ok) {
      const error = new Error(body?.error?.message || `OpenRouter Hive project planner HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {
      output: parseOutput(body),
      provider: "openrouter",
      model: body?.model || resolvedModel,
      promptDigest: promptDigest(hiveProjectPrompt),
      responseId: safeText(body?.id, 200),
      usage: {
        ...usageFromOpenRouter(body),
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("hive_project_openrouter_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function processHiveProjectQueueOnce({ limit = 1 } = {}) {
  if (!hiveProjectEnabled()) {
    return { ok: true, skipped: true, reason: "hive_project_worker_not_configured" };
  }
  if (running) return { ok: true, skipped: true, reason: "hive_project_worker_busy" };

  running = true;
  let processed = 0;
  let failed = 0;
  let claimed = 0;
  try {
    const jobs = await claimHiveProjectPlanningJobs({ limit });
    claimed = jobs.length;
    for (const job of jobs) {
      try {
        const result = await fetchHiveActiveProjects(job);
        await completeHiveProjectPlanningJob({
          job,
          output: result.output,
          provider: result.provider,
          model: result.model,
          promptDigest: result.promptDigest,
          responseId: result.responseId,
          usage: result.usage,
        });
        processed += 1;
      } catch (error) {
        failed += 1;
        await failHiveProjectPlanningJob(job, error);
      }
    }
    return { ok: true, claimed, processed, failed };
  } finally {
    running = false;
  }
}

export function scheduleHiveProjectQueue({ delayMs = 500 } = {}) {
  if (scheduled || !hiveProjectEnabled()) {
    return { scheduled: false };
  }
  scheduled = setTimeout(() => {
    scheduled = null;
    processHiveProjectQueueOnce({ limit: 1 })
      .catch((error) => console.warn(`hive project worker failed: ${error?.message || error}`));
  }, Math.max(0, Number(delayMs) || 0));
  scheduled.unref?.();
  return { scheduled: true };
}

export function startHiveProjectWorker() {
  if (timer || process.env.TASKNODE_HIVE_PROJECT_WORKER_ENABLED === "false" || !hiveProjectEnabled()) {
    return { ok: true, skipped: true };
  }
  const intervalMs = Math.max(15000, Number(process.env.TASKNODE_HIVE_PROJECT_INTERVAL_MS || 60000));
  const tick = () => {
    processHiveProjectQueueOnce({ limit: Number(process.env.TASKNODE_HIVE_PROJECT_BATCH_SIZE || 1) })
      .catch((error) => console.warn(`hive project worker failed: ${error?.message || error}`));
  };
  const initial = setTimeout(tick, 5000);
  initial.unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { ok: true, intervalMs };
}
