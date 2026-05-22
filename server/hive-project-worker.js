import { loadPrompt, promptDigest } from "./prompt-registry.js";
import {
  claimHiveProjectPlanningJobs,
  completeHiveProjectPlanningJob,
  failHiveProjectPlanningJob,
  hiveProjectPlanningPromptVersion,
  normalizeHiveProjectPlanningOutput,
} from "./repositories/hive-project-planning.js";
import { databaseEnabled } from "./db/pool.js";

const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
const hiveProjectPrompt = loadPrompt("hive/hive_active_projects_v1.md");
const projectTimeoutMs = Math.max(30000, Number(process.env.TASKNODE_HIVE_PROJECT_TIMEOUT_MS || 240000));
let timer = null;
let running = false;
let scheduled = null;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function openAiKey() {
  return safeText(process.env.OPENAI_API_KEY, 10000);
}

function hiveProjectModel() {
  return safeText(process.env.TASKNODE_HIVE_PROJECT_MODEL || "gpt-5.5-pro", 120);
}

function hiveProjectReasoningEffort() {
  return safeText(process.env.TASKNODE_HIVE_PROJECT_REASONING_EFFORT || "high", 40);
}

function hiveProjectEnabled() {
  return (
    process.env.TASKNODE_HIVE_PROJECT_WORKER_ENABLED !== "false" &&
    databaseEnabled() &&
    Boolean(openAiKey())
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
  if (typeof body.output_text === "string") return body.output_text;
  return (Array.isArray(body.output) ? body.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseOutput(body = {}) {
  const text = outputText(body);
  const parsed = text ? JSON.parse(text) : {};
  return normalizeHiveProjectPlanningOutput(parsed);
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

export async function fetchHiveActiveProjects(job, { fetchImpl = fetch } = {}) {
  if (!openAiKey()) {
    const error = new Error("hive_project_openai_not_configured");
    error.status = 409;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), projectTimeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${(process.env.OPENAI_BASE_URL || defaultOpenAiBaseUrl).replace(/\/+$/, "")}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${openAiKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: hiveProjectModel(),
        input: [
          { role: "system", content: hiveProjectPrompt },
          { role: "user", content: compactSourceText(job.source_packet_text, 90000) },
        ],
        reasoning: { effort: hiveProjectReasoningEffort() },
        text: {
          verbosity: "low",
          format: projectTextFormat(),
        },
        max_output_tokens: Math.max(4000, Number(process.env.TASKNODE_HIVE_PROJECT_MAX_OUTPUT_TOKENS || 12000)),
        store: false,
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
      const error = new Error(body?.error?.message || `OpenAI Hive project planner HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {
      output: parseOutput(body),
      provider: "openai",
      model: body?.model || hiveProjectModel(),
      promptDigest: promptDigest(hiveProjectPrompt),
      responseId: safeText(body?.id, 200),
      usage: {
        ...usageFromOpenAi(body),
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("hive_project_openai_timeout");
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
