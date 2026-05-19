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
import { encryptTasknodePayload, fetchAndDecryptTasknodePayload } from "./task-payloads.js";

const TASK_POINTER_SCHEMA = 1;
const TASKGEN_PROMPT_PATH = "task_engine/taskgen_minimal_v1.md";
const TASKGEN_PROMPT_VERSION = "taskgen_minimal_v1";

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
        task_kind: { type: "string" },
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
    wallet: bundle.wallet || {},
    policy: bundle.policy || {},
  };
}

function parseJsonObject(text = "") {
  return JSON.parse(String(text || "").trim());
}

function normalizeReward(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 5) return "3.20";
  return parsed.toFixed(2);
}

function validateTaskgenOutput(output = {}) {
  const required = ["title", "description", "task_kind", "submission_requirement", "verification_policy", "reward_offer", "deadline"];
  const missing = required.filter((key) => output[key] === undefined || output[key] === null);
  if (missing.length) throw new Error(`taskgen_output_missing:${missing.join(",")}`);
  if (output.schema !== "pf.taskgen.output.v1") throw new Error("taskgen_output_schema_invalid");
  const requirement = safeObject(output.submission_requirement);
  if (!requirement.type || !requirement.criteria) throw new Error("taskgen_submission_requirement_invalid");
  const verification = safeObject(output.verification_policy);
  if (!verification.verification_type || !verification.mode) throw new Error("taskgen_verification_policy_invalid");
  const reward = safeObject(output.reward_offer);
  return {
    ...output,
    title: safeText(output.title, 240),
    description: safeText(output.description, 8000),
    task_kind: safeText(output.task_kind, 80),
    steps: Array.isArray(output.steps) ? output.steps.map((step) => safeText(step, 1000)).filter(Boolean).slice(0, 5) : [],
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
      amount_estimate_pft: normalizeReward(reward.amount_estimate_pft),
    },
    deadline: {
      accept_by: safeText(output.deadline?.accept_by, 80) || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      deadline_at: output.deadline?.deadline_at ? safeText(output.deadline.deadline_at, 80) : null,
    },
  };
}

async function generateTaskWithOpenAi(taskInput) {
  const apiKey = safeText(process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("openai_api_key_missing");
  const systemPrompt = loadPrompt(TASKGEN_PROMPT_PATH);
  const model = safeText(process.env.TASKNODE_TASKGEN_MODEL || "chat-latest", 120);
  const startedAt = Date.now();
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
          content: `Generate a minimal Task Node task from this input packet. Return JSON matching schema pf.taskgen.output.v1.\n\n${stableJson(taskInput)}`,
        },
      ],
      response_format: taskgenResponseFormat,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`taskgen_openai_http_${response.status}:${bodyText.slice(0, 500)}`);
  const body = JSON.parse(bodyText);
  const output = validateTaskgenOutput(parseJsonObject(body?.choices?.[0]?.message?.content || ""));
  return {
    output,
    metadata: {
      provider: "frontier",
      model,
      prompt_version: TASKGEN_PROMPT_VERSION,
      prompt_digest: promptDigest(systemPrompt),
      input_packet_digest: sha256(taskInput),
      output_digest: sha256(output),
      latency_ms: Date.now() - startedAt,
      parse_status: "ok",
      openai_response_id: body.id || "",
    },
  };
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
    generation: {
      ...taskgen.metadata,
      request_bundle_cid: requestBundleCid,
      request_bundle_digest: contextDoc.digest || "",
    },
  };
  const encryptedPayload = await encryptTasknodePayload({
    plaintext: stableJson(offerPayload),
    recipientPublicKeys: [tasknodeKey.publicKey],
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

async function syncOfferProjection({ accountId = "", subjectWallet = "", authorityWallet = "" } = {}) {
  const [authoritySync, subjectSync] = await Promise.all([
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
  ]);
  const reduced = await runPftlCacheReducerOnce({ batchLimit: 20, logger: console });
  return { authoritySync, subjectSync, reduced };
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
      });
      await markTaskRequestProposed({
        requestId: request.requestId,
        generatedTaskId: offer.taskId,
        subjectWallet: offer.subjectWallet,
        metadata: {
          offerCid: offer.offerCid,
          offerTxHash: offer.txHash,
          taskgen: taskgen.metadata,
          sync,
        },
      });
      results.push({ ok: true, requestId: request.requestId, taskId: offer.taskId, txHash: offer.txHash });
    } catch (error) {
      const message = safeText(error?.message || error, 1000);
      await markTaskRequestFailed({ requestId: request.requestId, error: message }).catch(() => null);
      logger.warn?.("task_generation_request_failed", { requestId: request.requestId, error: message });
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
