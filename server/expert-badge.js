import { createHash } from "node:crypto";
import { getAccountExpertReview, setAccountExpertReview } from "./runtime-store.js";
import { listTaskState } from "./repositories/tasks.js";

export const expertRequiredPersonalTaskCount = 20;
export const expertScoreThreshold = 80;
export const expertPromptVersion = "expert_badge_evaluator_v1";

const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
const providerOrder = ["z-ai", "wafer", "fireworks", "novita"];

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampScore(value) {
  return Math.min(100, Math.max(0, Math.round(numeric(value, 0))));
}

function stringArray(values = [], maxItems = 8, maxLength = 240) {
  return (Array.isArray(values) ? values : [])
    .map((value) => safeText(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function promptDigest(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function openRouterKey() {
  return safeText(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER, 10000);
}

function expertModel() {
  return safeText(process.env.TASKNODE_EXPERT_EVALUATOR_MODEL || "z-ai/glm-5.2", 120);
}

function expertReasoningEffort() {
  return safeText(process.env.TASKNODE_EXPERT_EVALUATOR_REASONING_EFFORT || "high", 40);
}

function expertTimeoutMs() {
  return Math.max(30000, Number(process.env.TASKNODE_EXPERT_EVALUATOR_TIMEOUT_MS || 120000));
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

function parseJsonOutputText(text = "") {
  const trimmed = safeText(text, 200000);
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("expert_badge_model_invalid_json");
  }
}

function taskTimestamp(task = {}) {
  return Date.parse(task.updatedAt || task.lastEventAt || "") || 0;
}

function isCompletedPersonalTask(task = {}) {
  return !task.isNetworkTask &&
    safeText(task.kind, 80).toLowerCase() === "personal" &&
    ["rewarded", "reward_decided"].includes(safeText(task.statusKey || task.status, 80).toLowerCase());
}

export function completedPersonalTasksFromTaskState(taskState = {}) {
  const candidates = [
    ...(Array.isArray(taskState.rewarded) ? taskState.rewarded : []),
    ...(Array.isArray(taskState.outstanding) ? taskState.outstanding : []),
    ...(Array.isArray(taskState.verification) ? taskState.verification : []),
  ];
  const byId = new Map();
  for (const task of candidates) {
    if (!isCompletedPersonalTask(task)) continue;
    const taskId = safeText(task.taskId || task.fullId || task.id, 180);
    if (!taskId || byId.has(taskId)) continue;
    byId.set(taskId, task);
  }
  return [...byId.values()].sort((a, b) => taskTimestamp(b) - taskTimestamp(a));
}

function taskPacket(task = {}) {
  return {
    taskId: safeText(task.taskId || task.fullId || task.id, 180),
    title: safeText(task.title, 240),
    description: safeText(task.description, 1000),
    status: safeText(task.statusKey || task.status, 80),
    pft: numeric(task.pft, 0),
    updatedAt: safeText(task.updatedAt || task.lastEventAt, 80),
    steps: stringArray(task.steps, 5, 400),
    verification: safeText(task.verification?.body || task.submissionRequirement?.criteria, 700),
  };
}

function sameTaskIds(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

export function expertAccessFromTaskState({ accountId = "", taskState = {} } = {}) {
  const completedPersonalTasks = completedPersonalTasksFromTaskState(taskState);
  const latestTaskIds = completedPersonalTasks
    .slice(0, expertRequiredPersonalTaskCount)
    .map((task) => safeText(task.taskId || task.fullId || task.id, 180))
    .filter(Boolean);
  const review = getAccountExpertReview({ accountId });
  const reviewedTaskIds = Array.isArray(review.reviewedTaskIds) ? review.reviewedTaskIds : [];
  const reviewCurrent = Boolean(review.reviewedAt) && sameTaskIds(reviewedTaskIds, latestTaskIds);
  const score = clampScore(review.score);
  const disqualifyingConcerns = stringArray(review.disqualifyingConcerns, 8, 240);
  const eligible = completedPersonalTasks.length >= expertRequiredPersonalTaskCount &&
    reviewCurrent &&
    score >= expertScoreThreshold &&
    disqualifyingConcerns.length === 0 &&
    safeText(review.topic, 160);

  return {
    checkedAt: new Date().toISOString(),
    status: eligible
      ? "verified"
      : completedPersonalTasks.length < expertRequiredPersonalTaskCount
        ? "needs_tasks"
        : review.reviewedAt
          ? reviewCurrent
            ? "score_below_threshold"
            : "stale_review"
          : "needs_review",
    eligible: Boolean(eligible),
    topic: safeText(review.topic, 160),
    recommendedExpertLabel: safeText(review.recommendedExpertLabel, 160),
    score,
    thresholdScore: expertScoreThreshold,
    personalTaskCount: completedPersonalTasks.length,
    requiredPersonalTaskCount: expertRequiredPersonalTaskCount,
    reviewedAt: review.reviewedAt || null,
    reviewCurrent,
    reviewedTaskIds,
    latestTaskIds,
    summary: safeText(review.summary, 700),
    strengths: stringArray(review.strengths, 6, 240),
    weaknesses: stringArray(review.weaknesses, 6, 240),
    disqualifyingConcerns,
    proofMethod: "glm52_last_20_personal_tasks",
    model: safeText(review.model, 120),
    responseId: safeText(review.responseId, 200),
  };
}

function expertResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "expert_badge_evaluation",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "score",
          "recommended_expert_label",
          "summary",
          "strengths",
          "weaknesses",
          "disqualifying_concerns",
          "evidence_task_ids",
        ],
        properties: {
          score: { type: "integer" },
          recommended_expert_label: { type: "string" },
          summary: { type: "string" },
          strengths: { type: "array", items: { type: "string" } },
          weaknesses: { type: "array", items: { type: "string" } },
          disqualifying_concerns: { type: "array", items: { type: "string" } },
          evidence_task_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
}

function expertEvaluationPrompt() {
  return [
    "You are the Task Node Expert badge evaluator.",
    "Grade harshly. An Expert badge means the user has high expertise in one specific topic based on completed Task Node Personal tasks, not self-description.",
    "Input gives a requested expert topic and the user's latest 20 completed Personal tasks.",
    "Return JSON only.",
    "",
    "Scoring rubric:",
    "- 0-39: little or no evidence of expertise in the requested topic.",
    "- 40-59: some adjacent activity, but shallow, generic, or inconsistent.",
    "- 60-79: useful competence, but not enough for Expert routing.",
    "- 80-89: clear specialist expertise, consistent work, and concrete artifacts.",
    "- 90-100: exceptional depth, repeated high-quality outputs, and clear authority.",
    "",
    "Do not reward generic chatbot-style task titles, repetitive low-evidence work, or broad unfocused topics.",
    "Use disqualifying_concerns for severe mismatch, obviously low-effort tasks, topic too broad, or evidence that the task list does not support expert rewards.",
  ].join("\n");
}

function expertMessages({ topic = "", tasks = [] } = {}) {
  const packet = {
    requestedExpertTopic: safeText(topic, 160),
    completedPersonalTaskCount: tasks.length,
    tasks: tasks.map(taskPacket),
  };
  return [
    {
      role: "system",
      content: expertEvaluationPrompt(),
    },
    {
      role: "user",
      content: [
        "EXPERT BADGE APPLICATION PACKET",
        "```json",
        JSON.stringify(packet, null, 2),
        "```",
      ].join("\n"),
    },
  ];
}

async function fetchExpertEvaluation({ topic = "", tasks = [], fetchImpl = fetch } = {}) {
  const apiKey = openRouterKey();
  if (!apiKey) {
    const error = new Error("expert_badge_openrouter_not_configured");
    error.status = 409;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), expertTimeoutMs());
  const startedAt = Date.now();
  const model = expertModel();
  const promptText = expertEvaluationPrompt();
  try {
    const response = await fetchImpl(`${(process.env.OPENROUTER_BASE_URL || defaultOpenRouterBaseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": process.env.OPENROUTER_REFERER || process.env.TASKNODE_PUBLIC_URL || "https://tasknodeofficial-dev.fly.dev",
        "x-title": process.env.OPENROUTER_TITLE || "Task Node Official",
        "x-openrouter-title": process.env.OPENROUTER_TITLE || "Task Node Official",
      },
      body: JSON.stringify({
        model,
        messages: expertMessages({ topic, tasks }),
        reasoning: { effort: expertReasoningEffort() },
        response_format: expertResponseFormat(),
        provider: {
          order: providerOrder,
          data_collection: "deny",
          require_parameters: true,
        },
        temperature: 0,
        max_tokens: Math.max(1200, Number(process.env.TASKNODE_EXPERT_EVALUATOR_MAX_OUTPUT_TOKENS || 2500)),
        usage: { include: true },
        metadata: {
          app: "tasknodeofficial",
          worker: "expert_badge_evaluator",
          prompt_version: expertPromptVersion,
        },
      }),
    });
    const bodyText = await response.text();
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.message || `OpenRouter Expert evaluator HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const text = body?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonOutputText(text);
    return {
      parsed,
      provider: "openrouter",
      model: body?.model || model,
      responseId: safeText(body?.id, 200),
      promptDigest: promptDigest(promptText),
      promptVersion: expertPromptVersion,
      usage: {
        ...openRouterUsage(body),
        latencyMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("expert_badge_openrouter_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function evaluateExpertBadge({
  accountId = "",
  walletAddress = "",
  topic = "",
  taskState = null,
  fetchImpl = fetch,
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWalletAddress = safeText(walletAddress, 180);
  const normalizedTopic = safeText(topic, 160);
  if (!normalizedAccountId) {
    const error = new Error("expert_badge_login_required");
    error.status = 401;
    throw error;
  }
  if (!normalizedWalletAddress && !taskState) {
    const error = new Error("expert_badge_wallet_required");
    error.status = 409;
    throw error;
  }
  if (normalizedTopic.length < 3) {
    const error = new Error("expert_badge_topic_required");
    error.status = 400;
    throw error;
  }

  const resolvedTaskState = taskState || await listTaskState({
    accountId: normalizedAccountId,
    walletAddress: normalizedWalletAddress,
  });
  const completedPersonalTasks = completedPersonalTasksFromTaskState(resolvedTaskState);
  if (completedPersonalTasks.length < expertRequiredPersonalTaskCount) {
    const access = expertAccessFromTaskState({ accountId: normalizedAccountId, taskState: resolvedTaskState });
    return {
      ok: false,
      status: 409,
      error: "expert_badge_personal_task_count_required",
      message: `Complete at least ${expertRequiredPersonalTaskCount} Personal tasks before applying for Expert rewards.`,
      expertAccess: {
        ...access,
        topic: normalizedTopic,
      },
    };
  }

  const reviewTasks = completedPersonalTasks.slice(0, expertRequiredPersonalTaskCount);
  const reviewTaskIds = reviewTasks
    .map((task) => safeText(task.taskId || task.fullId || task.id, 180))
    .filter(Boolean);
  const modelResult = await fetchExpertEvaluation({
    topic: normalizedTopic,
    tasks: reviewTasks,
    fetchImpl,
  });
  const parsed = modelResult.parsed || {};
  const score = clampScore(parsed.score);
  const disqualifyingConcerns = stringArray(parsed.disqualifying_concerns, 8, 240);
  const eligible = score >= expertScoreThreshold && disqualifyingConcerns.length === 0;
  const review = {
    status: eligible ? "verified" : "rejected",
    topic: normalizedTopic,
    score,
    thresholdScore: expertScoreThreshold,
    personalTaskCount: completedPersonalTasks.length,
    requiredPersonalTaskCount: expertRequiredPersonalTaskCount,
    reviewedTaskIds: reviewTaskIds,
    reviewedAt: new Date().toISOString(),
    recommendedExpertLabel: safeText(parsed.recommended_expert_label, 160),
    summary: safeText(parsed.summary, 700),
    strengths: stringArray(parsed.strengths, 6, 240),
    weaknesses: stringArray(parsed.weaknesses, 6, 240),
    disqualifyingConcerns,
    evidenceTaskIds: stringArray(parsed.evidence_task_ids, 20, 180),
    provider: modelResult.provider,
    model: modelResult.model,
    responseId: modelResult.responseId,
    promptDigest: modelResult.promptDigest,
    promptVersion: modelResult.promptVersion,
    usage: modelResult.usage,
  };
  const saved = setAccountExpertReview({
    accountId: normalizedAccountId,
    review,
  });
  if (!saved.ok) {
    const error = new Error(saved.error || "expert_badge_review_save_failed");
    error.status = saved.status || 500;
    throw error;
  }

  const access = expertAccessFromTaskState({
    accountId: normalizedAccountId,
    taskState: resolvedTaskState,
  });
  return {
    ok: true,
    expertAccess: access,
    review,
  };
}
