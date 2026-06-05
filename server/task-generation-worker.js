import { createHash } from "node:crypto";
import { Wallet } from "xrpl";
import { pinContextIpfsJson } from "./context-ipfs.js";
import { resolveTasknodeEncryptionKey } from "./context-publish.js";
import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "./pftl-pointer.js";
import { preparePftPointerTransaction, submitSignedPftTransaction } from "./pftl-submit.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import {
  claimTaskGenerationRequests,
  markTaskRequestFailed,
  markTaskRequestProposed,
} from "./repositories/task-requests.js";
import {
  completeNetworkTaskOfferFromTaskRequest,
  failNetworkTaskGenerationChain,
  markNetworkTaskOfferLinkFailed,
} from "./repositories/network-tasks.js";
import { encryptTasknodePayload, fetchAndDecryptTasknodePayload } from "./task-payloads.js";
import { taskPayloadRecipientPublicKeys } from "./task-payload-recipients.js";

const TASK_POINTER_SCHEMA = 1;
const TASKGEN_PERSONAL_PROMPT = {
  path: "task_engine/taskgen_personal_v1.md",
  version: "taskgen_personal_v1",
};
const TASKGEN_NETWORK_PROMPT = {
  path: "task_engine/taskgen_network_v1.md",
  version: "taskgen_network_v1",
};

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

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isNetworkGeneratedRequest(request = {}) {
  const source = safeText(request.source, 80).toLowerCase();
  const requestedKind = safeText(request.requestedTaskKind || request.requested_task_kind, 80).toLowerCase();
  return source === "network_task" || requestedKind === "network" || requestedKind === "alpha";
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
    }).catch(() => null);
    return { ok: false, hidden: true, repair };
  }

  await markTaskRequestFailed({ requestId, error: message }).catch(() => null);
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
  const networkTask = safeObject(taskInput.network_task);
  const policy = safeObject(taskInput.policy);
  const request = safeObject(taskInput.request);
  const taskClass = safeText(policy.task_class ?? policy.taskClass ?? request.requestedTaskKind ?? request.requested_task_kind, 80).toLowerCase();
  if (objectKeyCount(networkTask) > 0 || taskClass === "network" || taskClass === "alpha") {
    return TASKGEN_NETWORK_PROMPT;
  }
  return TASKGEN_PERSONAL_PROMPT;
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

function projectTaskgenInput(bundle = {}, { bundleCid = "", bundleDigest = "" } = {}) {
  const contextDoc = safeObject(bundle.context?.primary_context_doc);
  const relevantHistory = Array.isArray(bundle.relevant_history?.items) ? bundle.relevant_history.items : [];
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
      accept_by: normalizedPolicyAcceptBy || normalizedOutputAcceptBy || normalizeDeadlineTimestamp(null, { fallbackMs: 24 * 60 * 60 * 1000 }),
      deadline_at: policyDeadlineAt.present ? normalizedPolicyDeadlineAt : normalizedOutputDeadlineAt,
    },
  };
  assertPlainTaskCardSpeech(normalized);
  return normalized;
}

async function generateTaskWithOpenAi(taskInput) {
  const apiKey = safeText(process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("openai_api_key_missing");
  const taskgenPrompt = taskgenPromptForInput(taskInput);
  const systemPrompt = loadPrompt(taskgenPrompt.path);
  const model = safeText(process.env.TASKNODE_TASKGEN_MODEL || "chat-latest", 120);
  const startedAt = Date.now();
  const baseInstruction = `Generate a minimal Task Node task from this input packet. Return JSON matching schema pf.taskgen.output.v1.\n\n${stableJson(taskInput)}`;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const repairInstruction = attempt === 1
      ? ""
      : "\n\nThe previous draft used opaque internal compliance language. Rewrite the task card in plain product language with a concrete object, action, artifact, and evidence. Do not use conformance, compliance, gates, verdict, priority stack, P0 standards, gap note, or exact-edits language.";
    const response = await fetch(`${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
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
      }),
    });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`taskgen_openai_http_${response.status}:${bodyText.slice(0, 500)}`);
    const body = JSON.parse(bodyText);
    try {
      const output = validateTaskgenOutput(parseJsonObject(body?.choices?.[0]?.message?.content || ""), taskInput.policy || {});
      return {
        output,
        metadata: {
          provider: "frontier",
          model,
          prompt_version: taskgenPrompt.version,
          prompt_path: taskgenPrompt.path,
          prompt_digest: promptDigest(systemPrompt),
          input_packet_digest: sha256(taskInput),
          output_digest: sha256(output),
          latency_ms: Date.now() - startedAt,
          parse_status: "ok",
          openai_response_id: body.id || "",
          validation_attempts: attempt,
        },
      };
    } catch (error) {
      lastError = error;
      if (!String(error?.message || "").startsWith("taskgen_plain_speech_violation:") || attempt >= 2) throw error;
    }
  }
  throw lastError || new Error("taskgen_failed");
}

function taskIdForOffer({ authorityWallet = "", requestBundleCid = "", output = {} } = {}) {
  return `task_${sha256([authorityWallet, requestBundleCid, sha256(output)].join(":")).slice(0, 32)}`;
}

async function publishOffer({ request, requestBundle, taskgen, tasknodeKey, authorityWallet }) {
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
      request_bundle_digest: contextDoc.digest || "",
    },
  };
  const recipientPublicKeys = await taskPayloadRecipientPublicKeys({
    tasknodeKey,
    accountId: request.accountId,
    walletAddress: subjectWallet,
    explicitPublicKeys: [
      requestBundle.subject_encryption_pubkey,
      requestBundle.wallet?.subject_encryption_pubkey,
      requestBundle.encryption?.subject_public_key,
    ],
  });
  const encryptedPayload = await encryptTasknodePayload({
    plaintext: stableJson(offerPayload),
    recipientPublicKeys,
  });
  const pin = await pinContextIpfsJson({
    payload: encryptedPayload,
    name: `tasknode-pf-task-offer-v1-${sha256(taskId).slice(0, 16)}`,
    keyvalues: {
      app: "tasknodeofficial",
      content_kind: "TASK",
      schema: "pf.task.offer.v1",
      request_id: request.requestId,
      task_id: taskId,
      subject_wallet: subjectWallet,
    },
  });
  const pointerMemo = buildPftPointerMemo({
    cid: pin.cid,
    kind: "TASK",
    schema: TASK_POINTER_SCHEMA,
    flags: POINTER_FLAGS.encrypted,
    taskId,
  });
  const prepared = await preparePftPointerTransaction({
    account: authorityWallet.classicAddress,
    destination: subjectWallet,
    pointerMemo,
  });
  const signed = authorityWallet.sign(prepared.txJson);
  const submitted = await submitSignedPftTransaction({
    signedTxBlob: signed.tx_blob,
    expectedAccount: authorityWallet.classicAddress,
  });
  return {
    taskId,
    subjectWallet,
    offerPayload,
    offerCid: pin.cid,
    offerDigest: `sha256:${pin.sha256}`,
    txHash: submitted.txHash,
    ledgerIndex: submitted.ledgerIndex,
    engineResult: submitted.engineResult,
  };
}

async function syncOfferProjection({
  accountId = "",
  subjectWallet = "",
  authorityWallet = "",
  allocationWallet = "",
} = {}) {
  const syncJobs = [
    syncPftlWalletTransactions({
      walletAddress: authorityWallet,
      accountId,
      role: "task_authority",
      limit: 80,
      maxPages: 1,
      syncKind: "task_offer_submit",
    }),
    syncPftlWalletTransactions({
      walletAddress: subjectWallet,
      accountId,
      role: "user",
      limit: 80,
      maxPages: 1,
      syncKind: "task_offer_subject_refresh",
    }),
  ];
  const normalizedAllocationWallet = safeText(allocationWallet, 120);
  if (normalizedAllocationWallet) {
    syncJobs.push(
      syncPftlWalletTransactions({
        walletAddress: normalizedAllocationWallet,
        accountId,
        role: "allocation_reward",
        limit: 80,
        maxPages: 1,
        syncKind: "task_offer_allocation_refresh",
      })
    );
  }
  const syncResults = await Promise.all(syncJobs);
  const reduced = await runPftlCacheReducerOnce({ batchLimit: 20, logger: console });
  return {
    authoritySync: syncResults[0],
    subjectSync: syncResults[1],
    allocationSync: syncResults[2] || null,
    reduced,
  };
}

export async function processTaskGenerationQueueOnce({ limit = 1, logger = console } = {}) {
  const requests = await claimTaskGenerationRequests({ limit });
  const results = [];
  for (const request of requests) {
    try {
      const requestBundleResult = await fetchAndDecryptTasknodePayload({ cid: request.requestBundleCid });
      const requestBundle = safeObject(requestBundleResult.payload);
      const requestBundleDigest = `sha256:${sha256(requestBundle)}`;
      const taskInput = projectTaskgenInput(requestBundle, {
        bundleCid: request.requestBundleCid,
        bundleDigest: requestBundleDigest,
      });
      const tasknodeKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
      if (!tasknodeKey?.publicKey) throw new Error("tasknode_encryption_key_missing");
      const authorityWallet = taskAuthorityWallet();
      const taskgen = await generateTaskWithOpenAi(taskInput);
      const offer = await publishOffer({ request, requestBundle, taskgen, tasknodeKey, authorityWallet });
      const sync = await syncOfferProjection({
        accountId: request.accountId,
        subjectWallet: offer.subjectWallet,
        authorityWallet: authorityWallet.classicAddress,
        allocationWallet: offer.offerPayload?.allocation_wallet || "",
      });
      await markTaskRequestProposed({
        requestId: request.requestId,
        generatedTaskId: offer.taskId,
        subjectWallet: offer.subjectWallet,
        metadata: {
          offerCid: offer.offerCid,
          offerTxHash: offer.txHash,
          generatedTask: offer.offerPayload,
          taskgen: taskgen.metadata,
          sync,
        },
      });
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
      results.push({ ok: true, requestId: request.requestId, taskId: offer.taskId, txHash: offer.txHash });
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      const failure = await markGenerationFailure({ request, message, logger });
      logger.warn?.("task_generation_request_failed", {
        requestId: request.requestId,
        error: message,
        userVisible: !failure.hidden,
      });
      results.push({ ok: false, requestId: request.requestId, error: message });
    }
  }
  return { ok: true, claimed: requests.length, results };
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
