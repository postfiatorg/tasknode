import { createHash } from "node:crypto";
import { Wallet } from "xrpl";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { applyOffchainTaskOffer } from "./offchain-task-lifecycle.js";
import {
  claimTaskGenerationRequests,
  heartbeatTaskGenerationRequest,
  markTaskRequestFailed,
  markTaskRequestProposed,
  reclaimStaleTaskGenerationRequests,
} from "./repositories/task-requests.js";
import {
  completeNetworkTaskOfferFromTaskRequest,
  failNetworkTaskGenerationChain,
  markNetworkTaskOfferLinkFailed,
} from "./repositories/network-tasks.js";
import {
  buildTaskgenReplayKey,
  findPublishedTaskgenOfferByTaskId,
  getTaskgenReplay,
  hasGeneratedTaskgenReplay,
  hasPublishedTaskgenReplay,
  markTaskgenReplayFailed,
  recordTaskgenReplayGenerated,
  recordTaskgenReplayPublished,
} from "./repositories/taskgen-replay-cache.js";
import { fetchAndDecryptTasknodePayload } from "./task-payloads.js";

const TASKGEN_PERSONAL_PROMPT = {
  path: "task_engine/taskgen_personal_v1.md",
  version: "taskgen_personal_v1",
};
const TASKGEN_NETWORK_PROMPT = {
  path: "task_engine/taskgen_network_v1.md",
  version: "taskgen_network_v1",
};
const TASKGEN_NETWORK_V2_PROMPT = {
  path: "task_engine/taskgen_network_v2.md",
  version: "taskgen_network_v2",
};
const TASKGEN_REPLAY_ACCEPT_BY_MIN_FRESH_MS = 5 * 60 * 1000;
const TASKGEN_REPLAY_ACCEPT_BY_FALLBACK_MS = 24 * 60 * 60 * 1000;

const taskgenResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "taskgen_output",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        schema: { type: "string", enum: ["pf.taskgen.output.v1"] },
        title: { type: "string" },
        description: { type: "string" },
        task_kind: { type: "string", enum: ["personal", "network", "alpha"] },
        steps: { type: "array", items: { type: "string" } },
        submission_requirement: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["text", "url", "github_commit", "screenshot", "file", "mixed"] },
            criteria: { type: "string" },
          },
          required: ["type", "criteria"],
        },
        verification_policy: {
          type: "object",
          additionalProperties: false,
          properties: {
            followup_required: { type: "boolean" },
            mode: { type: "string" },
            verification_type: {
              type: "string",
              enum: ["text", "url", "github_commit", "screenshot", "file", "mixed"],
            },
          },
          required: ["followup_required", "mode", "verification_type"],
        },
        reward_offer: {
          type: "object",
          additionalProperties: false,
          properties: { amount_estimate_pft: { type: "string" } },
          required: ["amount_estimate_pft"],
        },
        deadline: {
          type: "object",
          additionalProperties: false,
          properties: {
            accept_by: { type: "string" },
            deadline_at: { type: ["string", "null"] },
          },
          required: ["accept_by", "deadline_at"],
        },
      },
      required: [
        "schema",
        "title",
        "description",
        "task_kind",
        "steps",
        "submission_requirement",
        "verification_policy",
        "reward_offer",
        "deadline",
      ],
    },
  },
};

let timer = null;
let immediateTimer = null;
let immediateRunning = false;
const taskGenerationWorkerId = `taskgen_worker_${process.pid}_${Date.now()}`;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value, fallback, { min = 1, max = 1_200_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function taskGenerationProviderTimeoutMs(env = process.env) {
  return positiveInteger(env.TASKNODE_TASK_GENERATION_PROVIDER_TIMEOUT_MS, 90_000, {
    min: 5_000,
    max: 20 * 60 * 1000,
  });
}

function taskGenerationMaxAttempts(env = process.env) {
  return positiveInteger(env.TASKNODE_TASK_GENERATION_MAX_ATTEMPTS, 3, { min: 1, max: 25 });
}

function taskGenerationStaleSeconds(env = process.env) {
  const minimumSeconds = Math.max(60, Math.ceil(taskGenerationProviderTimeoutMs(env) / 1000) + 60);
  return positiveInteger(env.TASKNODE_TASK_GENERATION_STALE_SECONDS, 900, {
    min: minimumSeconds,
    max: 86_400,
  });
}

function isNetworkGeneratedRequest(request = {}) {
  const source = safeText(request.source, 80).toLowerCase();
  const requestedKind = safeText(request.requestedTaskKind || request.requested_task_kind, 80).toLowerCase();
  return source === "network_task" || requestedKind === "network" || requestedKind === "alpha";
}

function taskInputIsNetwork(taskInput = {}) {
  const networkTask = safeObject(taskInput.network_task);
  const policy = safeObject(taskInput.policy);
  const request = safeObject(taskInput.request);
  const taskClass = safeText(policy.task_class ?? policy.taskClass ?? request.requestedTaskKind ?? request.requested_task_kind, 80).toLowerCase();
  return objectKeyCount(networkTask) > 0 || taskClass === "network" || taskClass === "alpha";
}

export function networkTaskGenerationV2Enabled(env = process.env) {
  return env.TASKNODE_NETWORK_TASK_GENERATION_V2_ENABLED === "true" ||
    env.TASKNODE_HIVE_TASK_GENERATION_V2_ENABLED === "true";
}

function networkGenerationFailureMetadata(message = "") {
  return {
    operator_repair: {
      action: "fail_network_task_generation_chain",
      operator: "task_generation_worker",
      reason: safeText(message, 1000) || "network_task_generation_failed_before_offer",
      public_visibility: "hidden",
      user_visible: false,
      repaired_at: new Date().toISOString(),
    },
  };
}

async function markGenerationFailure({ request = {}, message = "", logger = console } = {}) {
  const requestId = request.requestId || request.request_id;
  const ownership = {
    workerAttemptId: request.workerAttemptId || request.worker_attempt_id || "",
    workerId: request.workerId || request.worker_id || "",
  };
  if (isNetworkGeneratedRequest(request)) {
    const repair = await failNetworkTaskGenerationChain({
      requestId,
      reason: message || "network_task_generation_failed_before_offer",
      operator: "task_generation_worker",
    }).catch(async (error) => {
      logger.warn?.("network_task_generation_chain_auto_repair_failed", {
        requestId,
        error: error?.message || String(error),
      });
      return null;
    });

    if (repair?.ok) return { ok: true, hidden: true, repair };

    await markTaskRequestFailed({
      requestId,
      error: message,
      metadata: networkGenerationFailureMetadata(message),
      ...ownership,
    }).catch(() => null);
    return { ok: false, hidden: true, repair };
  }

  await markTaskRequestFailed({ requestId, error: message, ...ownership }).catch(() => null);
  return { ok: true, hidden: false, repair: null };
}

function objectValue(source = {}, keys = []) {
  const object = safeObject(source);
  for (const key of keys) {
    if (Object.hasOwn(object, key)) return { present: true, value: object[key] };
  }
  return { present: false, value: undefined };
}

function objectKeyCount(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

export function taskgenPromptForInput(taskInput = {}) {
  if (taskInputIsNetwork(taskInput)) {
    if (networkTaskGenerationV2Enabled()) return TASKGEN_NETWORK_V2_PROMPT;
    return TASKGEN_NETWORK_PROMPT;
  }
  return TASKGEN_PERSONAL_PROMPT;
}

export function taskgenProviderForInput(taskInput = {}, env = process.env) {
  if (env.TASKNODE_TASKGEN_PROVIDER_MOCK === "true") return "mock";
  if (taskInputIsNetwork(taskInput) && networkTaskGenerationV2Enabled(env)) {
    return safeText(env.TASKNODE_NETWORK_TASKGEN_PROVIDER || env.TASKNODE_HIVE_TASK_GENERATION_PROVIDER || "openai", 80).toLowerCase();
  }
  return safeText(env.TASKNODE_TASKGEN_PROVIDER || "openai", 80).toLowerCase();
}

export function taskgenModelForInput(taskInput = {}, env = process.env) {
  if (taskInputIsNetwork(taskInput) && networkTaskGenerationV2Enabled(env)) {
    return safeText(
      env.TASKNODE_NETWORK_TASKGEN_MODEL ||
        env.TASKNODE_HIVE_TASK_GENERATION_MODEL ||
        env.TASKNODE_TASKGEN_MODEL ||
        "gpt-5.6-sol",
      160
    );
  }
  return safeText(env.TASKNODE_TASKGEN_MODEL || "gpt-5.6-sol", 160);
}

export function taskgenReasoningEffort(taskInput = {}, env = process.env) {
  if (taskInputIsNetwork(taskInput) && networkTaskGenerationV2Enabled(env)) {
    return safeText(
      env.TASKNODE_NETWORK_TASKGEN_REASONING_EFFORT ||
        env.TASKNODE_HIVE_TASK_GENERATION_REASONING_EFFORT ||
        env.TASKNODE_TASKGEN_REASONING_EFFORT ||
        "xhigh",
      40
    );
  }
  return safeText(env.TASKNODE_TASKGEN_REASONING_EFFORT || "xhigh", 40);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function taskAuthoritySeed(env = process.env) {
  return safeText(
    env.TASKNODE_AUTHORITY_SEED ||
      env.TASKNODE_SERVICE_SEED ||
      env.TASKNODE_ENCRYPTION_SEED ||
      env.TASKNODE_PFT_FAUCET_SEED ||
      env.FAUCET_SEED ||
      ""
  );
}

function taskAuthorityWallet(env = process.env) {
  const seed = taskAuthoritySeed(env);
  if (!seed) throw new Error("task_authority_seed_missing");
  return Wallet.fromSeed(seed);
}

function recentMessages(bundle = {}) {
  const conversations = Array.isArray(bundle.recent_chat?.conversations)
    ? bundle.recent_chat.conversations
    : [];
  return conversations.flatMap((conversation) => {
    return (Array.isArray(conversation.messages) ? conversation.messages : []).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: safeText(message.content || message.body || "", 1600),
      created_at: message.created_at || null,
    }));
  }).filter((message) => message.content).slice(-16);
}

export function projectTaskgenInput(bundle = {}, { bundleCid = "", bundleDigest = "" } = {}) {
  const contextDoc = safeObject(bundle.context?.primary_context_doc);
  const relevantHistory = Array.isArray(bundle.relevant_history?.items) ? bundle.relevant_history.items : [];
  const networkTask = safeObject(bundle.network_task);
  const taskLineage = safeObject(networkTask.task_lineage);
  return {
    schema: "pf.taskgen.input.v1",
    request_bundle: {
      bundle_id: bundle.bundle_id || "",
      cid: bundleCid,
      digest: bundleDigest,
    },
    request: safeObject(bundle.request),
    context: {
      context_cid: contextDoc.cid || null,
      context_digest: contextDoc.digest || "",
      summary: contextDoc.summary || "",
    },
    chat: {
      recent_chat_summary: bundle.recent_chat?.summary || "",
      relevant_history_summary: relevantHistory.map((item) => item.summary).filter(Boolean).join("; "),
      recent_messages: recentMessages(bundle),
      summary: bundle.recent_chat?.summary || "",
    },
    memory: {
      deep_memory: Array.isArray(bundle.memory?.deep_memory) ? bundle.memory.deep_memory : [],
      recent_memory: Array.isArray(bundle.memory?.recent_memory) ? bundle.memory.recent_memory : [],
    },
    task_queue: bundle.task_queue || {},
    network_task: bundle.network_task || null,
    hive_policy: {
      operator_standing_policy: safeArray(networkTask.operator_standing_policy),
      generation_quality_policy: safeObject(networkTask.generation_quality_policy),
    },
    prior_output_corpus: networkTask.prior_output_corpus || {},
    task_lineage: taskLineage,
    operator_transparency: {
      task_work_type: safeText(networkTask.task_work_type, 80),
      referenced_outputs: safeArray(taskLineage.referenced_outputs),
      deduped_against: safeArray(taskLineage.deduped_against),
      escalation_stage: safeText(networkTask.escalation_stage, 120),
    },
    wallet: bundle.wallet || {},
    policy: bundle.policy || {},
  };
}

function parseJsonObject(text = "") {
  return JSON.parse(String(text || "").trim());
}

function normalizeReward(value, policy = {}) {
  const min = Number(policy.reward_offer_min_pft ?? policy.rewardOfferMinPft ?? 0.5);
  const max = Number(policy.reward_offer_max_pft ?? policy.rewardOfferMaxPft ?? 5);
  const safeMin = Number.isFinite(min) ? Math.max(0.5, min) : 0.5;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : Math.max(safeMin, 5);
  const fallback = safeMax > 5 ? safeMin : 3.2;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < safeMin || parsed > safeMax) return fallback.toFixed(2);
  return parsed.toFixed(2);
}

function normalizeDeadlineTimestamp(value, { fallbackMs = null } = {}) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const text = safeText(value, 80);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (Number.isFinite(fallbackMs)) return new Date(Date.now() + fallbackMs).toISOString();
  return null;
}

function policyDeadlineValue(policy = {}, field = "accept_by") {
  const keys = field === "deadline_at" ? ["deadline_at", "deadlineAt"] : ["accept_by", "acceptBy"];
  const nested = objectValue(safeObject(policy).deadline, keys);
  if (nested.present) return nested;
  return objectValue(policy, keys);
}

function normalizeTaskKind(value = "", policy = {}) {
  const policyTaskClass = safeText(policy.task_class ?? policy.taskClass, 80).toLowerCase();
  if (policyTaskClass === "network" || policyTaskClass === "alpha") return policyTaskClass;
  const normalized = safeText(value, 80).toLowerCase();
  if (normalized === "network" || normalized === "alpha") return normalized;
  return "personal";
}

const opaqueTaskSpeechPatterns = Object.freeze([
  ["acceptance gates", /\bacceptance\s+gates?\b/i],
  ["active p0", /\bactive\s+p0\b/i],
  ["chat contract enforcement", /\bchat\s+contract\s+enforcement\b/i],
  ["compliance", /\bcompliance\b/i],
  ["conformance", /\bconformance\b/i],
  ["contract enforcement", /\bcontract\s+enforcement\b/i],
  ["deterministic state visibility", /\bdeterministic\s+state\s+visibility\b/i],
  ["exact edits", /\bexact\s+edits?\b/i],
  ["gap note", /\bgap\s+note\b/i],
  ["gates", /\bgates?\b/i],
  ["p0 standards", /\bp0\s+standards?\b/i],
  ["priority stack", /\bpriority\s+stack\b/i],
  ["reliable acknowledgment", /\breliable\s+(user\s+)?acknowledg(e)?ment\b/i],
  ["verdict", /\bverdict\b/i],
]);

function taskCardSpeechText(output = {}) {
  const requirement = safeObject(output.submission_requirement);
  return [
    output.title,
    output.description,
    ...(Array.isArray(output.steps) ? output.steps : []),
    requirement.criteria,
  ].map((value) => safeText(value, 4000)).filter(Boolean).join("\n");
}

function assertPlainTaskCardSpeech(output = {}) {
  const text = taskCardSpeechText(output);
  for (const [label, pattern] of opaqueTaskSpeechPatterns) {
    if (pattern.test(text)) throw new Error(`taskgen_plain_speech_violation:${label}`);
  }
}

export function validateTaskgenOutput(output = {}, policy = {}) {
  const required = ["title", "description", "task_kind", "submission_requirement", "verification_policy", "reward_offer", "deadline"];
  const missing = required.filter((key) => output[key] === undefined || output[key] === null);
  if (missing.length) throw new Error(`taskgen_output_missing:${missing.join(",")}`);
  if (output.schema !== "pf.taskgen.output.v1") throw new Error("taskgen_output_schema_invalid");
  const requirement = safeObject(output.submission_requirement);
  if (!requirement.type || !requirement.criteria) throw new Error("taskgen_submission_requirement_invalid");
  const verification = safeObject(output.verification_policy);
  if (!verification.verification_type || !verification.mode) throw new Error("taskgen_verification_policy_invalid");
  const steps = Array.isArray(output.steps)
    ? output.steps.map((step) => safeText(step, 1000)).filter(Boolean).slice(0, 5)
    : [];
  if (steps.length < 2) throw new Error("taskgen_steps_invalid");
  const reward = safeObject(output.reward_offer);
  const policyAcceptBy = policyDeadlineValue(policy, "accept_by");
  const policyDeadlineAt = policyDeadlineValue(policy, "deadline_at");
  const normalizedPolicyAcceptBy = policyAcceptBy.present ? normalizeDeadlineTimestamp(policyAcceptBy.value) : null;
  const normalizedOutputAcceptBy = normalizeDeadlineTimestamp(output.deadline?.accept_by);
  const normalizedPolicyDeadlineAt = policyDeadlineAt.present ? normalizeDeadlineTimestamp(policyDeadlineAt.value) : null;
  const normalizedOutputDeadlineAt = normalizeDeadlineTimestamp(output.deadline?.deadline_at);
  const normalized = {
    ...output,
    title: safeText(output.title, 240),
    description: safeText(output.description, 8000),
    task_kind: normalizeTaskKind(output.task_kind, policy),
    steps,
    submission_requirement: {
      type: safeText(requirement.type, 80),
      criteria: safeText(requirement.criteria, 4000),
    },
    verification_policy: {
      followup_required: Boolean(verification.followup_required),
      mode: safeText(verification.mode, 120),
      verification_type: safeText(verification.verification_type, 80),
    },
    reward_offer: {
      amount_estimate_pft: normalizeReward(reward.amount_estimate_pft, policy),
    },
    deadline: {
      // Tasks never die by clock. An accept-by stamp appears only when the
      // routing policy explicitly requested a window (accept_window_hours > 0
      // upstream); the model cannot invent one and there is no default.
      accept_by: normalizedPolicyAcceptBy || null,
      deadline_at: policyDeadlineAt.present ? normalizedPolicyDeadlineAt : normalizedOutputDeadlineAt,
    },
  };
  assertPlainTaskCardSpeech(normalized);
  return normalized;
}

export function taskgenReplayIdentity({
  taskInput = {},
  request = {},
  requestBundle = {},
  requestBundleCid = "",
  requestBundleDigest = "",
} = {}) {
  const taskgenPrompt = taskgenPromptForInput(taskInput);
  const systemPrompt = loadPrompt(taskgenPrompt.path);
  const policy = safeObject(taskInput.policy);
  const networkTask = safeObject(taskInput.network_task);
  const requestObject = safeObject(taskInput.request);
  const model = taskgenModelForInput(taskInput);
  const taskClass = safeText(
    policy.task_class ??
      policy.taskClass ??
      networkTask.task_class ??
      networkTask.taskClass ??
      requestObject.requestedTaskKind ??
      requestObject.requested_task_kind ??
      request.requestedTaskKind ??
      request.requested_task_kind ??
      "personal",
    80
  ).toLowerCase() || "personal";
  const identity = {
    schema: "pf.taskgen.replay_identity.v1",
    request_id: safeText(request.requestId || request.request_id || requestObject.request_id, 180),
    request_bundle_cid: safeText(requestBundleCid || request.requestBundleCid || request.request_bundle_cid, 240),
    request_bundle_digest: safeText(requestBundleDigest, 180),
    source_payload_digest: safeText(networkTask.source_payload_digest || networkTask.sourcePayloadDigest, 180),
    input_packet_digest: sha256(taskInput),
    prompt_version: taskgenPrompt.version,
    prompt_path: taskgenPrompt.path,
    prompt_digest: promptDigest(systemPrompt),
    model,
    task_class: taskClass,
    reward_policy_version: safeText(policy.reward_policy_version || policy.rewardPolicyVersion, 120),
    deadline_policy_version: safeText(
      policy.deadline_policy_version ||
        policy.deadlinePolicyVersion ||
        policy.task_policy_version ||
        policy.taskPolicyVersion ||
        "",
      120
    ),
    generation_policy_version: safeText(policy.generation_policy_version || policy.generationPolicyVersion, 120),
    bundle_id: safeText(requestBundle.bundle_id || request.bundleId || request.bundle_id, 180),
  };
  return {
    ...identity,
    replay_key: buildTaskgenReplayKey(identity),
  };
}

function taskgenFromReplay(replay = {}, identity = {}) {
  return {
    output: safeObject(replay.taskgenOutput),
    metadata: {
      ...safeObject(replay.taskgenMetadata),
      replayed: true,
      replay_key: replay.replayKey || identity.replay_key || "",
      replay_status: replay.status || "",
      input_packet_digest: replay.inputPacketDigest || identity.input_packet_digest || "",
      prompt_version: replay.promptVersion || identity.prompt_version || "",
      prompt_digest: replay.promptDigest || identity.prompt_digest || "",
      model: replay.model || identity.model || "",
    },
  };
}

export function refreshTaskgenReplayDeadlineForPublish(taskgen = {}, policy = {}, { nowMs = Date.now() } = {}) {
  const normalizedOutput = validateTaskgenOutput(safeObject(taskgen.output), policy);
  const acceptByMs = Date.parse(normalizedOutput.deadline?.accept_by || "");
  const deadlineAtText = safeText(normalizedOutput.deadline?.deadline_at, 80);
  const deadlineAtMs = Date.parse(deadlineAtText);
  const minFreshMs = Number(nowMs) + TASKGEN_REPLAY_ACCEPT_BY_MIN_FRESH_MS;
  const hasAcceptBy = Boolean(normalizedOutput.deadline?.accept_by);
  const acceptByStale = hasAcceptBy && (!Number.isFinite(acceptByMs) || acceptByMs <= minFreshMs);
  const deadlineAtStale = Boolean(deadlineAtText) && (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= minFreshMs);
  if (!acceptByStale && !deadlineAtStale) {
    return {
      taskgen: {
        ...taskgen,
        output: normalizedOutput,
      },
      refreshed: false,
      staleAcceptBy: "",
    };
  }

  const refreshedAcceptBy = acceptByStale
    ? new Date(Number(nowMs) + TASKGEN_REPLAY_ACCEPT_BY_FALLBACK_MS).toISOString()
    : normalizedOutput.deadline.accept_by;
  const refreshedAcceptByMs = Date.parse(refreshedAcceptBy || "");
  const refreshedDeadlineAt = deadlineAtText && Number.isFinite(deadlineAtMs) && (!Number.isFinite(refreshedAcceptByMs) || deadlineAtMs > refreshedAcceptByMs)
    ? normalizedOutput.deadline.deadline_at
    : null;
  const refreshedOutput = {
    ...normalizedOutput,
    deadline: {
      ...normalizedOutput.deadline,
      accept_by: refreshedAcceptBy,
      deadline_at: refreshedDeadlineAt,
    },
  };
  return {
    taskgen: {
      ...taskgen,
      output: refreshedOutput,
      metadata: {
        ...safeObject(taskgen.metadata),
        output_digest: sha256(refreshedOutput),
        replay_deadline_refreshed: true,
        replay_deadline_refreshed_at: new Date(Number(nowMs)).toISOString(),
        replay_deadline_stale_accept_by: acceptByStale ? safeText(normalizedOutput.deadline?.accept_by, 80) : "",
        replay_deadline_stale_deadline_at: deadlineAtStale ? deadlineAtText : "",
      },
    },
    refreshed: true,
    staleAcceptBy: acceptByStale ? safeText(normalizedOutput.deadline?.accept_by, 80) : "",
  };
}

function offerFromReplay(replay = {}) {
  return {
    taskId: replay.taskId || "",
    subjectWallet: replay.subjectWallet || "",
    offerPayload: safeObject(replay.offerPayload),
    offerCid: replay.offerCid || "",
    offerDigest: replay.offerDigest || "",
    txHash: replay.offerTxHash || "",
    ledgerIndex: null,
    engineResult: "replayed",
    replayed: true,
  };
}

function taskgenApiConfig(taskInput = {}) {
  const provider = taskgenProviderForInput(taskInput);
  if (provider === "mock") {
    return {
      provider,
      model: "mock-taskgen",
      baseUrl: "",
      apiKey: "mock",
      headers: {},
    };
  }
  if (provider === "openrouter") {
    const apiKey = safeText(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER, 10000);
    if (!apiKey) throw new Error("taskgen_openrouter_api_key_missing");
    return {
      provider,
      model: taskgenModelForInput(taskInput),
      baseUrl: (process.env.OPENROUTER_BASE_URL || "https://api.openrouter.ai/api/v1").replace(/\/+$/, ""),
      apiKey,
      headers: {
        "HTTP-Referer": process.env.TASKNODE_PUBLIC_URL || process.env.VITE_SITE_ORIGIN || "https://tasknode.postfiat.org",
        "X-Title": "Task Node task generation",
      },
    };
  }
  const apiKey = safeText(process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("openai_api_key_missing");
  return {
    provider: "frontier",
    model: taskgenModelForInput(taskInput),
    reasoningEffort: taskgenReasoningEffort(taskInput),
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey,
    headers: {},
  };
}

function discordProofCriteriaSuffix(taskInput = {}) {
  return taskInputIsNetwork(taskInput)
    ? " Include Discord announcement proof as a message link/id or screenshot from an approved Post Fiat channel."
    : "";
}

function mockTaskgenOutput(taskInput = {}) {
  const networkTask = safeObject(taskInput.network_task);
  const policy = safeObject(taskInput.policy);
  const taskKind = normalizeTaskKind(networkTask.task_class || policy.task_class || "personal", policy);
  const reward = normalizeReward(networkTask.reward_band_pft?.min || policy.reward_offer_min_pft || "3.20", policy);
  const titleBase = safeText(networkTask.action_output || networkTask.project_need_summary || taskInput.request?.requestText || "Prepare Task Evidence", 80);
  return validateTaskgenOutput({
    schema: "pf.taskgen.output.v1",
    title: safeText(titleBase.replace(/[^\w\s-]+/g, " ").replace(/\s+/g, " ").trim() || "Prepare Task Evidence", 72),
    description: safeText(
      [
        networkTask.project_title ? `This task supports ${networkTask.project_title}.` : "This task supports the selected Task Node project.",
        safeText(networkTask.project_need_summary || taskInput.request?.requestText || "Prepare a concrete artifact and evidence packet.", 500),
      ].join(" "),
      900
    ),
    task_kind: taskKind,
    steps: [
      "Review the project need and any referenced source material.",
      "Create the requested artifact or evidence packet.",
      "Submit the artifact with enough proof for a reviewer to verify it.",
    ],
    submission_requirement: {
      type: taskInputIsNetwork(taskInput) ? "mixed" : "text",
      criteria: `Submit the completed artifact plus a concise note explaining what changed.${discordProofCriteriaSuffix(taskInput)}`,
    },
    verification_policy: {
      followup_required: taskInputIsNetwork(taskInput),
      mode: "standard_followup",
      verification_type: taskInputIsNetwork(taskInput) ? "mixed" : "text",
    },
    reward_offer: {
      amount_estimate_pft: reward,
    },
    deadline: {
      accept_by: normalizeDeadlineTimestamp(null, { fallbackMs: 24 * 60 * 60 * 1000 }),
      deadline_at: null,
    },
  }, policy);
}

function assertNetworkTaskgenV2Input(taskInput = {}) {
  if (!taskInputIsNetwork(taskInput) || !networkTaskGenerationV2Enabled()) return null;
  const networkTask = safeObject(taskInput.network_task);
  const policy = safeObject(taskInput.policy);
  const taskWorkType = safeText(networkTask.task_work_type || networkTask.taskWorkType || policy.task_work_type || policy.taskWorkType, 120);
  const requiredBadge = safeText(networkTask.required_badge_id || networkTask.requiredBadgeId || policy.required_badge_id || policy.requiredBadgeId, 80);
  const operatingBadge = safeText(networkTask.operating_badge_id || networkTask.operatingBadgeId || policy.operating_badge_id || policy.operatingBadgeId, 80);
  const cap = Number(networkTask.badge_reward_cap_pft || networkTask.badgeRewardCapPft || policy.badge_reward_cap_pft || policy.badgeRewardCapPft || 0);
  const isCapabilityGate = taskWorkType === "capability_gating_task";
  if (!requiredBadge && !isCapabilityGate) throw new Error("network_taskgen_v2_required_badge_missing");
  if (!operatingBadge && !isCapabilityGate) throw new Error("network_taskgen_v2_operating_badge_missing");
  if (requiredBadge && operatingBadge && requiredBadge !== operatingBadge) {
    throw new Error("network_taskgen_v2_badge_mismatch");
  }
  if (!taskWorkType) throw new Error("network_taskgen_v2_task_work_type_missing");
  if (Number.isFinite(cap) && cap > 0) {
    const max = Number(policy.reward_offer_max_pft ?? policy.rewardOfferMaxPft ?? networkTask.reward_band_pft?.max ?? 0);
    if (Number.isFinite(max) && max > cap) throw new Error("network_taskgen_v2_reward_cap_violation");
  }
  return {
    requiredBadge,
    operatingBadge,
    taskWorkType,
    badgeRewardCapPft: Number.isFinite(cap) ? cap : 0,
    reportIds: safeArray(networkTask.hive_reports?.report_ids || networkTask.hiveReports?.reportIds),
  };
}

async function fetchWithProviderTimeout(url, init = {}, {
  fetchImpl = fetch,
  timeoutMs = taskGenerationProviderTimeoutMs(),
} = {}) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(new Error("taskgen_provider_timeout")), timeoutMs);
  timerId.unref?.();
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError" || String(error?.message || "").includes("taskgen_provider_timeout")) {
      const timeoutError = new Error("taskgen_provider_timeout");
      timeoutError.code = "TASKGEN_PROVIDER_TIMEOUT";
      timeoutError.timeoutMs = timeoutMs;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timerId);
  }
}

export async function generateTaskWithProvider(taskInput, {
  fetchImpl = fetch,
  providerTimeoutMs = taskGenerationProviderTimeoutMs(),
} = {}) {
  const gate = assertNetworkTaskgenV2Input(taskInput);
  const taskgenPrompt = taskgenPromptForInput(taskInput);
  const systemPrompt = loadPrompt(taskgenPrompt.path);
  const apiConfig = taskgenApiConfig(taskInput);
  const model = apiConfig.model;
  const startedAt = Date.now();
  const baseInstruction = `Generate a minimal Task Node task from this input packet. Return JSON matching schema pf.taskgen.output.v1.\n\n${stableJson(taskInput)}`;
  if (apiConfig.provider === "mock") {
    const output = mockTaskgenOutput(taskInput);
    return {
      output,
      metadata: {
        provider: "mock",
        model,
        prompt_version: taskgenPrompt.version,
        prompt_path: taskgenPrompt.path,
        prompt_digest: promptDigest(systemPrompt),
        input_packet_digest: sha256(taskInput),
        output_digest: sha256(output),
        latency_ms: Date.now() - startedAt,
        parse_status: "ok",
        validation_attempts: 1,
        network_taskgen_v2_gate: gate || null,
      },
    };
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const repairInstruction = attempt === 1
      ? ""
      : "\n\nThe previous draft used opaque internal compliance language. Rewrite the task card in plain product language with a concrete object, action, artifact, and evidence. Do not use conformance, compliance, gates, verdict, priority stack, P0 standards, gap note, or exact-edits language.";
    const response = await fetchWithProviderTimeout(`${apiConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiConfig.apiKey}`,
        "content-type": "application/json",
        ...apiConfig.headers,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `${baseInstruction}${repairInstruction}`,
          },
        ],
        response_format: taskgenResponseFormat,
        reasoning_effort: apiConfig.reasoningEffort,
      }),
    }, {
      fetchImpl,
      timeoutMs: providerTimeoutMs,
    });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`taskgen_openai_http_${response.status}:${bodyText.slice(0, 500)}`);
    const body = JSON.parse(bodyText);
    try {
      const output = validateTaskgenOutput(parseJsonObject(body?.choices?.[0]?.message?.content || ""), taskInput.policy || {});
      return {
        output,
        metadata: {
          provider: apiConfig.provider,
          model,
          prompt_version: taskgenPrompt.version,
          prompt_path: taskgenPrompt.path,
          prompt_digest: promptDigest(systemPrompt),
          input_packet_digest: sha256(taskInput),
          output_digest: sha256(output),
          latency_ms: Date.now() - startedAt,
          parse_status: "ok",
          openai_response_id: body.id || "",
          provider_response_id: body.id || "",
          validation_attempts: attempt,
          network_taskgen_v2_gate: gate || null,
        },
      };
    } catch (error) {
      lastError = error;
      if (!String(error?.message || "").startsWith("taskgen_plain_speech_violation:") || attempt >= 2) throw error;
    }
  }
  throw lastError || new Error("taskgen_failed");
}

async function heartbeatRequestAttempt(request = {}, stage = "") {
  const result = await heartbeatTaskGenerationRequest({
    requestId: request.requestId,
    workerAttemptId: request.workerAttemptId,
    workerId: request.workerId,
    stage,
  });
  if (!result.ok) {
    const error = new Error("task_generation_attempt_lost");
    error.staleAttempt = true;
    error.stage = stage;
    throw error;
  }
  return result.request || request;
}

async function requestAttemptStillOwned(request = {}, stage = "") {
  if (!request.workerAttemptId) return { ok: true, request };
  const result = await heartbeatTaskGenerationRequest({
    requestId: request.requestId,
    workerAttemptId: request.workerAttemptId,
    workerId: request.workerId,
    stage,
  });
  return result.ok
    ? { ok: true, request: result.request || request }
    : { ok: false, reason: result.reason || "task_generation_attempt_not_owner" };
}

function taskIdForOffer({ authorityWallet = "", requestBundleCid = "", output = {} } = {}) {
  return `task_${sha256([authorityWallet, requestBundleCid, sha256(output)].join(":")).slice(0, 32)}`;
}

async function publishOffer({ request, requestBundle, taskgen, authorityWallet, requestBundleDigest = "" }) {
  const subjectWallet = safeText(requestBundle.subject_wallet || request.subjectWallet, 120);
  if (!subjectWallet) throw new Error("task_request_subject_wallet_missing");
  const requestBundleCid = safeText(request.requestBundleCid, 240);
  const taskId = taskIdForOffer({
    authorityWallet: authorityWallet.classicAddress,
    requestBundleCid,
    output: taskgen.output,
  });
  const contextDoc = safeObject(requestBundle.context?.primary_context_doc);
  const networkTask = safeObject(requestBundle.network_task);
  const offerPayload = {
    schema: "pf.task.offer.v1",
    protocol: "tasknode.pftl",
    created_at: new Date().toISOString(),
    chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
    task_id: taskId,
    event_id: `evt_${sha256({ taskId, output: taskgen.output }).slice(0, 24)}`,
    request_id: request.requestId,
    actor_wallet: authorityWallet.classicAddress,
    subject_wallet: subjectWallet,
    authority_wallet: authorityWallet.classicAddress,
    allocation_wallet: safeText(requestBundle.wallet?.allocation_wallet, 120),
    status: "proposed",
    title: taskgen.output.title,
    description: taskgen.output.description,
    task_kind: taskgen.output.task_kind,
    steps: taskgen.output.steps,
    submission_requirement: taskgen.output.submission_requirement,
    verification_policy: taskgen.output.verification_policy,
    reward_offer: taskgen.output.reward_offer,
    proposed_at: new Date().toISOString(),
    accept_by: taskgen.output.deadline.accept_by,
    deadline_at: taskgen.output.deadline.deadline_at,
    context_refs: contextDoc.cid
      ? [{ context_id: contextDoc.context_id || "", cid: contextDoc.cid, digest: contextDoc.digest || "" }]
      : [],
    network_task: objectKeyCount(networkTask) ? networkTask : null,
    network_project_id: safeText(networkTask.project_id, 180),
    network_project_type: safeText(networkTask.project_type, 80),
    network_allocation_id: safeText(networkTask.allocation_id, 180),
    routing_profile_digest: safeText(networkTask.routing_profile_digest, 180),
    task_class: safeText(networkTask.task_class, 80),
    generation: {
      ...taskgen.metadata,
      request_bundle_cid: requestBundleCid,
      request_bundle_digest: requestBundleDigest,
    },
  };
  const recorded = await applyOffchainTaskOffer({
    accountId: request.accountId,
    walletAddress: subjectWallet,
    offerPayload,
    metadata: {
      source: "task_generation_worker",
      request_bundle_cid: requestBundleCid,
      request_bundle_digest: requestBundleDigest,
      taskgen_model: taskgen.metadata?.model || "",
    },
  });
  return {
    taskId,
    subjectWallet,
    offerPayload,
    offerCid: recorded.event.sourceCid,
    offerDigest: `sha256:${recorded.event.eventDigest}`,
    txHash: recorded.event.sourceTxHash,
    ledgerIndex: null,
    engineResult: "direct_write",
    source: recorded.source,
  };
}

async function syncOfferProjection({
  accountId = "",
  subjectWallet = "",
  authorityWallet = "",
  allocationWallet = "",
} = {}) {
  return {
    source: "direct_write",
    accountId: safeText(accountId, 180),
    subjectWallet: safeText(subjectWallet, 180),
    authorityWallet: safeText(authorityWallet, 180),
    allocationWallet: safeText(allocationWallet, 180),
    reduced: { claimed: 0, skipped: true, reason: "task_offer_projection_direct_written" },
  };
}

async function taskRequestBundleForGeneration(request = {}) {
  const requestBundleCid = safeText(request.requestBundleCid, 240);
  if (requestBundleCid.startsWith("postgres:")) {
    const requestBundle = safeObject(request.metadata?.requestBundle);
    if (!Object.keys(requestBundle).length) {
      throw new Error("task_request_postgres_bundle_missing");
    }
    return {
      cid: requestBundleCid,
      payload: requestBundle,
      source: "task_requests.metadata_json",
    };
  }
  return await fetchAndDecryptTasknodePayload({ cid: requestBundleCid });
}

export async function processTaskGenerationQueueOnce({ limit = 1, logger = console } = {}) {
  const stale = await reclaimStaleTaskGenerationRequests({
    maxAttempts: taskGenerationMaxAttempts(),
    staleSeconds: taskGenerationStaleSeconds(),
    limit: 25,
  }).catch((error) => {
    logger.warn?.("task_generation_stale_reclaim_failed", { error: error?.message || String(error) });
    return { retried: [], failed: [] };
  });
  const requests = await claimTaskGenerationRequests({
    limit,
    workerId: taskGenerationWorkerId,
    maxAttempts: taskGenerationMaxAttempts(),
  });
  const results = [];
  for (const request of requests) {
    let replayIdentity = null;
    try {
      await heartbeatRequestAttempt(request, "fetch_request_bundle");
      const requestBundleResult = await taskRequestBundleForGeneration(request);
      const requestBundle = safeObject(requestBundleResult.payload);
      const requestBundleDigest = `sha256:${sha256(requestBundle)}`;
      await heartbeatRequestAttempt(request, "project_taskgen_input");
      const taskInput = projectTaskgenInput(requestBundle, {
        bundleCid: request.requestBundleCid,
        bundleDigest: requestBundleDigest,
      });
      const authorityWallet = taskAuthorityWallet();
      replayIdentity = taskgenReplayIdentity({
        taskInput,
        request,
        requestBundle,
        requestBundleCid: request.requestBundleCid,
        requestBundleDigest,
      });
      const replay = await getTaskgenReplay(replayIdentity.replay_key);
      const replayedPublishedOffer = hasPublishedTaskgenReplay(replay);
      const replayedGeneratedOutput = hasGeneratedTaskgenReplay(replay);
      await heartbeatRequestAttempt(request, "provider_generation");
      let taskgen = replayedGeneratedOutput
        ? taskgenFromReplay(replay, replayIdentity)
        : await generateTaskWithProvider(taskInput);
      let offer = replayedPublishedOffer ? offerFromReplay(replay) : null;
      await heartbeatRequestAttempt(request, "pre_publish_replay_check");
      if (replayedGeneratedOutput && !offer) {
        offer = await findPublishedTaskgenOfferByTaskId({
          taskId: replay.taskId,
          requestId: request.requestId,
        });
        if (!offer) {
          await syncOfferProjection({
            accountId: request.accountId,
            subjectWallet: safeText(requestBundle.subject_wallet || request.subjectWallet, 120),
            authorityWallet: authorityWallet.classicAddress,
            allocationWallet: safeText(requestBundle.wallet?.allocation_wallet, 120),
          }).catch((error) => {
            logger.warn?.("taskgen_replay_pre_publish_sync_failed", {
              requestId: request.requestId,
              taskId: replay.taskId,
              error: error?.message || String(error),
            });
          });
          offer = await findPublishedTaskgenOfferByTaskId({
            taskId: replay.taskId,
            requestId: request.requestId,
          });
        }
        if (offer) {
          await recordTaskgenReplayPublished({
            replayKey: replayIdentity.replay_key,
            identity: replayIdentity,
            taskId: offer.taskId,
            subjectWallet: offer.subjectWallet,
            offerCid: offer.offerCid,
            offerDigest: offer.offerDigest,
            offerTxHash: offer.txHash,
            taskgenOutput: taskgen.output,
            taskgenMetadata: taskgen.metadata,
            offerPayload: offer.offerPayload,
          });
        }
      }
      if (!offer) {
        await heartbeatRequestAttempt(request, "pre_publish_offer");
        const publishReady = refreshTaskgenReplayDeadlineForPublish(taskgen, taskInput.policy || {});
        taskgen = publishReady.taskgen;
        if (!replayedGeneratedOutput || publishReady.refreshed) {
          const generatedTaskId = taskIdForOffer({
            authorityWallet: authorityWallet.classicAddress,
            requestBundleCid: request.requestBundleCid,
            output: taskgen.output,
          });
          await recordTaskgenReplayGenerated({
            replayKey: replayIdentity.replay_key,
            identity: replayIdentity,
            taskId: generatedTaskId,
            subjectWallet: safeText(requestBundle.subject_wallet || request.subjectWallet, 120),
            taskgenOutput: taskgen.output,
            taskgenMetadata: taskgen.metadata,
          });
        }
        offer = await publishOffer({
          request,
          requestBundle,
          taskgen,
          authorityWallet,
          requestBundleDigest,
        });
        await heartbeatRequestAttempt(request, "offer_published");
        await recordTaskgenReplayPublished({
          replayKey: replayIdentity.replay_key,
          identity: replayIdentity,
          taskId: offer.taskId,
          subjectWallet: offer.subjectWallet,
          offerCid: offer.offerCid,
          offerDigest: offer.offerDigest,
          offerTxHash: offer.txHash,
          taskgenOutput: taskgen.output,
          taskgenMetadata: taskgen.metadata,
          offerPayload: offer.offerPayload,
        });
      }
      const sync = await syncOfferProjection({
        accountId: request.accountId,
        subjectWallet: offer.subjectWallet,
        authorityWallet: authorityWallet.classicAddress,
        allocationWallet: offer.offerPayload?.allocation_wallet || "",
      });
      const proposed = await markTaskRequestProposed({
        requestId: request.requestId,
        generatedTaskId: offer.taskId,
        subjectWallet: offer.subjectWallet,
        workerAttemptId: request.workerAttemptId,
        workerId: request.workerId,
        metadata: {
          offerCid: offer.offerCid,
          offerTxHash: offer.txHash,
          generatedTask: offer.offerPayload,
          taskgen: {
            ...taskgen.metadata,
            replay_key: replayIdentity.replay_key,
            replayed_offer: offer.replayed === true,
          },
          sync,
        },
      });
      if (!proposed.ok) {
        throw Object.assign(new Error(proposed.reason || "task_request_not_owned_by_attempt"), {
          staleAttempt: true,
        });
      }
      await completeNetworkTaskOfferFromTaskRequest({
        requestId: request.requestId,
        taskId: offer.taskId,
        subjectWallet: offer.subjectWallet,
        offerCid: offer.offerCid,
        offerTxHash: offer.txHash,
        generatedTask: offer.offerPayload,
      }).catch(async (error) => {
        await markNetworkTaskOfferLinkFailed({
          requestId: request.requestId,
          taskId: offer.taskId,
          error: error?.message || String(error),
        }).catch(() => null);
        logger.warn?.("network_task_link_update_failed", {
          requestId: request.requestId,
          taskId: offer.taskId,
          error: error?.message || String(error),
        });
      });
      results.push({
        ok: true,
        requestId: request.requestId,
        taskId: offer.taskId,
        txHash: offer.txHash,
        replayed: offer.replayed === true,
      });
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      if (error?.staleAttempt) {
        logger.warn?.("task_generation_stale_attempt_stopped", {
          requestId: request.requestId,
          stage: error.stage || "",
          error: message,
        });
        results.push({ ok: false, stale: true, requestId: request.requestId, error: message });
        continue;
      }
      const ownership = await requestAttemptStillOwned(request, "failure_guard").catch((ownershipError) => ({
        ok: false,
        reason: ownershipError?.message || "task_generation_attempt_ownership_check_failed",
      }));
      if (!ownership.ok) {
        logger.warn?.("task_generation_stale_failure_suppressed", {
          requestId: request.requestId,
          reason: ownership.reason,
          error: message,
        });
        results.push({ ok: false, stale: true, requestId: request.requestId, error: message });
        continue;
      }
      if (replayIdentity?.replay_key) {
        await markTaskgenReplayFailed({ replayKey: replayIdentity.replay_key, error: message }).catch(() => null);
      }
      const failure = await markGenerationFailure({ request, message, logger });
      logger.warn?.("task_generation_request_failed", {
        requestId: request.requestId,
        error: message,
        userVisible: !failure.hidden,
      });
      results.push({ ok: false, requestId: request.requestId, error: message });
    }
  }
  return {
    ok: true,
    claimed: requests.length,
    staleReclaimed: stale.retried.length + stale.failed.length,
    staleRetried: stale.retried.length,
    staleFailed: stale.failed.length,
    results,
  };
}

export function scheduleTaskGenerationQueue({
  delayMs = 250,
  enabled = process.env.TASKNODE_TASK_GENERATION_WORKER_ENABLED === "true",
  limit = 3,
  logger = console,
  reason = "task_request_published",
} = {}) {
  if (!enabled) return { scheduled: false, reason: "disabled" };
  if (immediateTimer) return { scheduled: false, reason: "already_scheduled" };
  const safeDelay = Math.min(Math.max(Number(delayMs || 0), 0), 60_000);
  const safeLimit = Math.min(Math.max(Number(limit || 1), 1), 3);
  immediateTimer = setTimeout(async () => {
    immediateTimer = null;
    if (immediateRunning) {
      scheduleTaskGenerationQueue({
        delayMs: 1000,
        limit: safeLimit,
        logger,
        reason: "task_generation_already_running",
      });
      return;
    }
    immediateRunning = true;
    try {
      await processTaskGenerationQueueOnce({ limit: safeLimit, logger });
    } catch (error) {
      logger.warn?.("task_generation_immediate_tick_failed", {
        error: error?.message || String(error),
        reason,
      });
    } finally {
      immediateRunning = false;
    }
  }, safeDelay);
  if (typeof immediateTimer.unref === "function") immediateTimer.unref();
  return { scheduled: true, delayMs: safeDelay, limit: safeLimit, reason };
}

export function startTaskGenerationWorker({
  enabled = process.env.TASKNODE_TASK_GENERATION_WORKER_ENABLED === "true",
  intervalMs = Number(process.env.TASKNODE_TASK_GENERATION_WORKER_INTERVAL_MS || 5000),
  batchLimit = Number(process.env.TASKNODE_TASK_GENERATION_WORKER_BATCH_LIMIT || 1),
  logger = console,
} = {}) {
  if (timer || !enabled) return { started: false, reason: timer ? "already_started" : "disabled" };
  const safeInterval = Math.min(Math.max(intervalMs || 5000, 5000), 3_600_000);
  const safeBatch = Math.min(Math.max(batchLimit || 1, 1), 3);
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      await processTaskGenerationQueueOnce({ limit: safeBatch, logger });
    } catch (error) {
      logger.warn?.("task_generation_worker_tick_failed", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };
  timer = setInterval(runOnce, safeInterval);
  runOnce();
  return { started: true, intervalMs: safeInterval, batchLimit: safeBatch };
}
