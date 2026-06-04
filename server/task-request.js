import { createHash, randomUUID } from "node:crypto";
import { getLinkedWallet } from "./runtime-store.js";
import { getContextDocument } from "./repositories/context.js";
import { getChatMemoryContext } from "./repositories/chat-memory.js";
import { getChatMessages, listChatConversations } from "./repositories/chat-billing.js";
import { listTaskState } from "./repositories/tasks.js";
import { pinContextIpfsJson } from "./context-ipfs.js";
import {
  encryptedPayloadHasRecipient,
  resolveTasknodeEncryptionKey,
  safeTxHash,
  validateEncryptedPayload,
} from "./context-publish.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "./pftl-pointer.js";
import { preparePftPointerTransaction, submitSignedPftTransaction } from "./pftl-submit.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";
import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";
import { upsertTaskRequest } from "./repositories/task-requests.js";
import { scheduleTaskGenerationQueue } from "./task-generation-worker.js";
import { taskRequestCanonicalText, taskRequestIntentStart } from "./task-request-intent.js";

const ACTION_ID = "task_request";
const TASK_POINTER_SCHEMA = 1;

function actionResponse({ status, error, message, actionRequired, extra = {} }) {
  return {
    status,
    body: {
      ok: false,
      action: ACTION_ID,
      error,
      message,
      actionRequired,
      ...extra,
    },
  };
}

function okResponse(body, status = 200) {
  return {
    status,
    body: {
      ok: true,
      action: ACTION_ID,
      ...body,
    },
  };
}

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeCorrelationId(value = "", prefix = "req") {
  const normalized = safeText(value, 96);
  if (/^[a-z]+_[A-Za-z0-9_-]{8,90}$/.test(normalized)) return normalized;
  return `${prefix}_${randomUUID()}`;
}

function parsePhase(payload = {}) {
  const phase = safeText(payload?.phase, 40).toLowerCase();
  if (["config", "prepare_bundle", "prepare", "prepare_event", "submit"].includes(phase)) return phase;
  if (payload?.signedTxBlob || payload?.signed_tx_blob) return "submit";
  if (payload?.encryptedEventPayload || payload?.encryptedPayload || payload?.encrypted_payload) return "prepare";
  if (payload?.encryptedBundlePayload) return "prepare_bundle";
  return "config";
}

function requestInput(payload = {}) {
  const requestId = safeCorrelationId(payload?.requestId, "req");
  const bundleId = safeCorrelationId(payload?.bundleId, "bundle");
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments.slice(0, 4) : [];
  return {
    requestId,
    bundleId,
    requestText: safeText(payload?.requestText || taskRequestCanonicalText, 8000),
    userDetailText: safeText(payload?.userDetailText || payload?.message || "", 8000),
    requestedTaskKind: safeText(payload?.requestedTaskKind || "personal", 80) || "personal",
    subjectEncryptionPubkey: safeText(payload?.tasknodeEncryptionPubkey || payload?.subjectEncryptionPubkey || "", 4000),
    source: safeText(payload?.source || "task_interface", 80) || "task_interface",
    sourceConversationTitle: safeText(payload?.sourceConversationTitle || "Tasks", 160) || "Tasks",
    conversationId: safeText(payload?.conversationId || "", 180),
    attachments,
  };
}

async function requireSessionWallet(session = null) {
  if (!session?.accountId) {
    return {
      error: actionResponse({
        status: 401,
        error: "task_request_login_required",
        message: "Sign in before requesting a task.",
        actionRequired: "Use an account login, link a PFT wallet, unlock the local vault, then request again.",
      }),
    };
  }

  const wallet = getLinkedWallet({ accountId: session.accountId });
  if (wallet.status !== "linked" || !wallet.address) {
    return {
      error: actionResponse({
        status: 409,
        error: "task_request_wallet_required",
        message: "Link a PFT wallet before requesting a task.",
        actionRequired: "Create or link a seed wallet, unlock the local vault, then request again.",
      }),
    };
  }

  return {
    accountId: session.accountId,
    wallet,
  };
}

function compactText(value = "", max = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function wordCount(value = "") {
  const words = String(value || "").trim().match(/\S+/g);
  return words ? words.length : 0;
}

function messageProjection(message = {}) {
  return {
    id: safeText(message.id, 180),
    role: message.role === "user" ? "user" : "assistant",
    content: compactText(message.body || message.text || message.content || "", 1600),
    created_at: message.createdAt || message.created_at || null,
  };
}

async function recentChatProjection({ accountId = "", limit = 4 } = {}) {
  const conversations = await listChatConversations({ accountId, limit }).catch(() => []);
  const projected = [];
  for (const conversation of conversations.slice(0, limit)) {
    const messages = await getChatMessages({
      accountId,
      conversationId: conversation.conversationId || conversation.id,
      limit: 8,
    }).catch(() => []);
    projected.push({
      conversation_id: conversation.conversationId || conversation.id || "",
      conversation_title: conversation.title || "New chat",
      updated_at: conversation.updatedAt || null,
      messages: messages.map(messageProjection).filter((item) => item.content),
    });
  }
  return projected;
}

function summarizeRecentChat(chats, userDetailText) {
  const lines = [];
  for (const chat of chats.slice(0, 4)) {
    const title = chat.conversation_title || "New chat";
    const lastUser = [...(chat.messages || [])].reverse().find((item) => item.role === "user")?.content || "";
    const lastAssistant = [...(chat.messages || [])].reverse().find((item) => item.role === "assistant")?.content || "";
    if (lastUser || lastAssistant) {
      lines.push(`${title}: user=${compactText(lastUser, 220)} assistant=${compactText(lastAssistant, 220)}`);
    }
  }
  lines.push(`Explicit task request detail: ${compactText(userDetailText, 500)}`);
  return compactText(lines.join(" "), 1800);
}

function memoryProjection(entry = {}) {
  return {
    kind: safeText(entry.kind || "turn_memory", 80),
    digest: sha256([entry.id, entry.createdAt, entry.memoryText].join(":")).slice(0, 24),
    conversation_title: safeText(entry.conversationTitle || "", 160),
    user: compactText(entry.userRequestSummary || "", 800),
    system: compactText(entry.systemResponseSummary || "", 800),
    memory_text: compactText(entry.memoryText || "", 1400),
    created_at: entry.createdAt || null,
  };
}

function queueProjection(tasks = {}) {
  const project = (items = [], limit = 12) => items.slice(0, limit).map((task) => ({
    task_id: task.taskId || task.fullId || "",
    title: safeText(task.title, 240),
    status: safeText(task.statusKey || task.status, 80),
    reward_pft: task.pft ?? "",
    updated_at: task.updatedAt || null,
  }));
  return {
    outstanding: project(tasks.outstanding || [], 40),
    verification: project(tasks.verification || [], 40),
    refused: project(tasks.refused || [], 10),
    rewarded: project(tasks.rewarded || [], 12),
    summary: [
      `${(tasks.outstanding || []).length} outstanding`,
      `${(tasks.verification || []).length} pending verification`,
      `${(tasks.refused || []).length} refused`,
      `${(tasks.rewarded || []).length} rewarded`,
    ].join("; "),
  };
}

export async function buildRequestBundle({ accountId, walletAddress, request, authorityWallet }) {
  const [context, memoryContext, recentChat, taskState] = await Promise.all([
    getContextDocument({ accountId }),
    getChatMemoryContext({ accountId, deepLimit: 3, turnLimit: 36 }),
    recentChatProjection({ accountId, limit: 4 }),
    listTaskState({ accountId, walletAddress }),
  ]);
  const contextBody = String(context?.body || "");
  const recentMemory = (memoryContext.memories || []).map(memoryProjection);
  const deepMemory = (memoryContext.deepMemories || []).map(memoryProjection);
  return {
    schema: "pf.task.request_bundle.v1",
    bundle_id: request.bundleId,
    subject_wallet: walletAddress,
    subject_encryption_pubkey: request.subjectEncryptionPubkey || "",
    created_at: new Date().toISOString(),
    client: {
      name: "tasknodeofficial-web",
      version: "0.1.0",
      source_app: "tasknodeofficial",
      account_id: accountId,
      conversation_id: request.conversationId || null,
      conversation_title: request.sourceConversationTitle,
    },
    request: {
      request_id: request.requestId,
      request_text: request.requestText,
      user_detail_text: request.userDetailText,
      requested_task_kind: request.requestedTaskKind,
      source: request.source,
      source_conversation_title: request.sourceConversationTitle,
      attachments: request.attachments.map((attachment) => ({
        name: safeText(attachment?.name, 240),
        mime_type: safeText(attachment?.mimeType, 120),
        size: Number(attachment?.size || 0),
        source: safeText(attachment?.source, 80),
      })),
    },
    recent_chat: {
      conversations: recentChat,
      summary: summarizeRecentChat(recentChat, request.userDetailText),
    },
    memory: {
      deep_memory: deepMemory,
      recent_memory: recentMemory,
    },
    relevant_history: {
      strategy: "app_memory_recent_36_plus_deep_3",
      items: [...deepMemory, ...recentMemory]
        .filter((item) => item.memory_text)
        .map((item) => ({
          kind: item.kind,
          digest: item.digest,
          summary: item.memory_text,
          conversation_title: item.conversation_title,
          created_at: item.created_at,
        })),
    },
    context: {
      primary_context_doc: {
        context_id: context?.id || `ctx_${sha256(accountId).slice(0, 24)}`,
        cid: null,
        digest: `sha256:${sha256(contextBody)}`,
        summary: compactText(contextBody, 1600),
        revision: Number(context?.revision || 0),
        word_count: wordCount(contextBody),
      },
      additional_refs: [],
    },
    task_queue: queueProjection(taskState),
    policy: {
      task_policy_version: "task-policy-minimal-v1",
      reward_policy_version: "reward-policy-minimal-v1",
      generation_policy_version: "taskgen-policy-minimal-v1",
    },
    wallet: {
      subject_wallet: walletAddress,
      subject_encryption_pubkey: request.subjectEncryptionPubkey || "",
      authority_wallet: authorityWallet || "",
      authority_hint: authorityWallet || "",
      allocation_wallet: "",
    },
    encryption: {
      subject_public_key: request.subjectEncryptionPubkey || "",
      tasknode_service_required: true,
    },
  };
}

async function taskRequestConfig({ payload, session }) {
  const resolved = await requireSessionWallet(session);
  if (resolved.error) return resolved.error;
  const request = requestInput(payload);
  if (!request.userDetailText) {
    return actionResponse({
      status: 400,
      error: "task_request_detail_required",
      message: "Task requests need detail text.",
      actionRequired: "Describe the work you want generated before publishing the task request.",
    });
  }

  const tasknodeEncryptionKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeEncryptionKey?.publicKey) {
    return actionResponse({
      status: 409,
      error: "tasknode_encryption_key_missing",
      message: "Task Node encryption key is not configured.",
      actionRequired: "Configure the Task Node service encryption key before requesting tasks.",
    });
  }

  const authorityWallet = tasknodeEncryptionKey.serviceAddress || "";
  const requestBundle = await buildRequestBundle({
    accountId: resolved.accountId,
    walletAddress: resolved.wallet.address,
    request,
    authorityWallet,
  });

  return okResponse({
    phase: "config",
    requestId: request.requestId,
    bundleId: request.bundleId,
    requestText: request.requestText,
    userDetailText: request.userDetailText,
    requestedTaskKind: request.requestedTaskKind,
    subjectEncryptionPubkey: request.subjectEncryptionPubkey,
    source: request.source,
    sourceConversationTitle: request.sourceConversationTitle,
    requestBundle,
    requestBundleDigest: `sha256:${sha256(JSON.stringify(requestBundle))}`,
    chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
    tasknodeEncryptionPubkey: tasknodeEncryptionKey.publicKey,
    tasknodeServiceAddress: authorityWallet,
    wallets: {
      user: resolved.wallet.address,
      authority: authorityWallet,
      allocation: "",
    },
    pointer: {
      kind: "TASK",
      schema: TASK_POINTER_SCHEMA,
      flags: POINTER_FLAGS.encrypted,
    },
  });
}

async function pinEncryptedPayload({ payload, encryptedPayload, schema, contentKind, request }) {
  if (!validateEncryptedPayload(encryptedPayload)) {
    return {
      error: actionResponse({
        status: 400,
        error: "task_request_encrypted_payload_invalid",
        message: "Task request payload must be encrypted before it is pinned.",
        actionRequired: "Unlock the local wallet vault and retry the task request.",
      }),
    };
  }

  const tasknodeEncryptionKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeEncryptionKey?.publicKey) {
    return {
      error: actionResponse({
        status: 409,
        error: "tasknode_encryption_key_missing",
        message: "Task Node encryption key is not configured.",
        actionRequired: "Configure the Task Node service encryption key before requesting tasks.",
      }),
    };
  }
  if (!encryptedPayloadHasRecipient(encryptedPayload, tasknodeEncryptionKey.publicKey)) {
    return {
      error: actionResponse({
        status: 400,
        error: "tasknode_recipient_missing",
        message: "Task request payload is not encrypted to Task Node.",
        actionRequired: "Refresh the request configuration and retry so the encrypted IPFS payload includes Task Node.",
      }),
    };
  }

  const pin = await pinContextIpfsJson({
    payload: encryptedPayload,
    name: `tasknode-${schema.replace(/\./g, "-")}-${sha256(`${request.requestId}:${Date.now()}`).slice(0, 16)}`,
    keyvalues: {
      app: "tasknodeofficial",
      content_kind: contentKind,
      schema,
      account_hash: sha256(payload.accountId).slice(0, 24),
      wallet_address: payload.walletAddress,
      request_id: request.requestId,
      bundle_id: request.bundleId,
    },
  });

  return { pin, tasknodeEncryptionKey };
}

async function prepareRequestBundle({ payload, session }) {
  const resolved = await requireSessionWallet(session);
  if (resolved.error) return resolved.error;
  const request = requestInput(payload);
  const pinned = await pinEncryptedPayload({
    payload: { accountId: resolved.accountId, walletAddress: resolved.wallet.address },
    encryptedPayload: payload?.encryptedBundlePayload,
    schema: "pf.task.request_bundle.v1",
    contentKind: "TASK",
    request,
  });
  if (pinned.error) return pinned.error;
  return okResponse({
    phase: "bundle_prepared",
    requestId: request.requestId,
    bundleId: request.bundleId,
    bundleCid: pinned.pin.cid,
    bundleDigest: `sha256:${pinned.pin.sha256}`,
    payloadSha256: pinned.pin.sha256,
    sizeBytes: pinned.pin.sizeBytes,
  });
}

async function prepareRequestEvent({ payload, session }) {
  const resolved = await requireSessionWallet(session);
  if (resolved.error) return resolved.error;
  const request = requestInput(payload);
  const encryptedPayload = payload?.encryptedEventPayload || payload?.encryptedPayload || payload?.encrypted_payload;
  const pinned = await pinEncryptedPayload({
    payload: { accountId: resolved.accountId, walletAddress: resolved.wallet.address },
    encryptedPayload,
    schema: "pf.task.request.v1",
    contentKind: "TASK",
    request,
  });
  if (pinned.error) return pinned.error;

  const pointerMemo = buildPftPointerMemo({
    cid: pinned.pin.cid,
    kind: "TASK",
    schema: TASK_POINTER_SCHEMA,
    flags: POINTER_FLAGS.encrypted,
  });
  const prepared = await preparePftPointerTransaction({
    account: resolved.wallet.address,
    destination: pinned.tasknodeEncryptionKey.serviceAddress || resolved.wallet.address,
    pointerMemo,
  });

  return okResponse({
    phase: "prepared",
    message: "Task request payload pinned. Sign the PFTL pointer transaction to publish.",
    requestId: request.requestId,
    bundleId: request.bundleId,
    cid: pinned.pin.cid,
    eventCid: pinned.pin.cid,
    payloadSha256: pinned.pin.sha256,
    sizeBytes: pinned.pin.sizeBytes,
    txJson: prepared.txJson,
    tx_json: prepared.txJson,
    pointer: pointerMemo.payload,
    memo: {
      memoType: pointerMemo.memoTypeHex,
      memoFormat: pointerMemo.memoFormatHex,
      memoData: pointerMemo.memoDataHex,
    },
    transaction: {
      fromAddress: prepared.fromAddress,
      destination: prepared.destination,
      amountDrops: prepared.amountDrops,
      feeDrops: prepared.feeDrops,
      availableDrops: prepared.availableDrops,
      networkId: prepared.networkId,
    },
  });
}

async function bestEffortRefreshTaskRequest({ accountId, walletAddress }) {
  try {
    const synced = await syncPftlWalletTransactions({
      walletAddress,
      accountId,
      limit: 80,
      maxPages: 1,
      syncKind: "task_request_submit",
    });
    const reduced = await runPftlCacheReducerOnce({ batchLimit: 20, logger: console });
    return { synced, reduced };
  } catch (error) {
    return { ok: false, error: safeText(error?.code || error?.message || error, 500) };
  }
}

async function submitTaskRequest({ payload, session }) {
  const resolved = await requireSessionWallet(session);
  if (resolved.error) return resolved.error;
  const request = requestInput(payload);

  const submit = await submitSignedPftTransaction({
    signedTxBlob: payload?.signedTxBlob || payload?.signed_tx_blob,
    expectedAccount: resolved.wallet.address,
  });
  const txHash = safeTxHash(submit.txHash);
  if (!txHash) {
    return actionResponse({
      status: 502,
      error: "task_request_tx_hash_missing",
      message: "PFTL accepted the transaction response but did not return a hash.",
      actionRequired: "Check the linked wallet history before retrying to avoid a duplicate task request.",
    });
  }

  let intent = null;
  if (request.conversationId) {
    const persisted = await taskRequestIntentStart(
      {
        ...request,
        accountId: resolved.accountId,
        conversationId: request.conversationId,
        requestEventCid: safeText(payload?.cid || payload?.eventCid, 240),
        requestBundleCid: safeText(payload?.bundleCid, 240),
        txHash,
        status: "pftl_request_published",
        assistantMessage: "Task request published to PFT. The Task Node worker can now generate a task offer from the signed request bundle.",
        attachments: request.attachments,
      },
      "POST"
    ).catch((error) => ({ status: 500, body: { ok: false, error: error?.message || "intent_persist_failed" } }));
    intent = persisted.body || null;
  }

  const refresh = await bestEffortRefreshTaskRequest({
    accountId: resolved.accountId,
    walletAddress: resolved.wallet.address,
  });
  const visibleRequest = await upsertTaskRequest({
    requestId: request.requestId,
    bundleId: request.bundleId,
    accountId: resolved.accountId,
    subjectWallet: resolved.wallet.address,
    source: request.source,
    sourceConversationId: request.conversationId,
    sourceConversationTitle: request.sourceConversationTitle,
    requestText: request.requestText,
    userDetailText: request.userDetailText,
    requestedTaskKind: request.requestedTaskKind,
    requestBundleCid: safeText(payload?.bundleCid, 240),
    requestEventCid: safeText(payload?.cid || payload?.eventCid, 240),
    requestTxHash: txHash,
    status: "published",
    metadata: {
      chainSubmitPhase: "submitted",
      pointer: payload?.pointer || {},
      transaction: payload?.transaction || {},
    },
  }).catch((error) => ({ ok: false, error: safeText(error?.message || error, 500) }));
  const generationScheduled = visibleRequest?.ok
    ? scheduleTaskGenerationQueue({
        delayMs: 250,
        limit: 3,
        reason: "browser_task_request_submitted",
      })
    : { scheduled: false, reason: "task_request_not_persisted" };

  return okResponse({
    phase: "submitted",
    message: "Task request published to PFT.",
    requestId: request.requestId,
    bundleId: request.bundleId,
    cid: safeText(payload?.cid || payload?.eventCid, 240),
    bundleCid: safeText(payload?.bundleCid, 240),
    txHash,
    engineResult: submit.engineResult,
    intent,
    visibleRequest,
    generationScheduled,
    refresh,
  });
}

export async function taskRequestAction(payload = {}, method = "POST", session = null) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "task_request_method_not_allowed",
      message: "Task requests require POST.",
      actionRequired: "Call the task request endpoint with POST.",
    });
  }

  const phase = parsePhase(payload);
  try {
    if (phase === "prepare_bundle") return await prepareRequestBundle({ payload, session });
    if (phase === "prepare" || phase === "prepare_event") return await prepareRequestEvent({ payload, session });
    if (phase === "submit") return await submitTaskRequest({ payload, session });
    return await taskRequestConfig({ payload, session });
  } catch (error) {
    return actionResponse({
      status: error?.status || 502,
      error: error?.code || error?.message || "task_request_failed",
      message: error?.message || "Task request could not be published to PFT.",
      actionRequired: "Check wallet unlock state, PFT balance, PFTL connectivity, and IPFS configuration, then retry.",
      extra: {
        attempts: Array.isArray(error?.attempts) ? error.attempts : undefined,
      },
    });
  }
}
