import { requestJson } from "../../api";

export const taskRequestCanonicalText =
  "Request a task using my current context document, account memory, recent messages, and the additional task details I just provided.";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

async function sha256Hex(value = "") {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function eventIdFor(payload) {
  const digest = await sha256Hex(JSON.stringify(payload));
  return `evt_${digest.slice(0, 24)}`;
}

function buildRequestEvent({
  bundleCid = "",
  bundleDigest = "",
  config = {},
  linkedWalletAddress = "",
} = {}) {
  const requestBundle = config.requestBundle || {};
  const request = requestBundle.request || {};
  const wallets = config.wallets || {};
  const createdAt = new Date().toISOString();
  const basePayload = {
    schema: "pf.task.request.v1",
    protocol: "tasknode.pftl",
    created_at: createdAt,
    chain: config.chain || "pftl-testnet",
    request_id: config.requestId || request.request_id || "",
    actor_wallet: linkedWalletAddress,
    subject_wallet: linkedWalletAddress,
    authority_wallet: wallets.authority || config.tasknodeServiceAddress || "",
    allocation_wallet: wallets.allocation || "",
    request_bundle: {
      bundle_id: config.bundleId || requestBundle.bundle_id || "",
      cid: bundleCid,
      digest: bundleDigest,
      summary: safeText(requestBundle.recent_chat?.summary || "", 1800),
    },
    request_text: request.request_text || config.requestText || taskRequestCanonicalText,
    user_detail_text: request.user_detail_text || config.userDetailText || "",
    requested_task_kind: request.requested_task_kind || config.requestedTaskKind || "personal",
    client: requestBundle.client || {},
  };
  return eventIdFor(basePayload).then((eventId) => ({ ...basePayload, event_id: eventId }));
}

export async function publishTaskRequest({
  accountId = "",
  linkedWalletAddress = "",
  walletSecret = null,
  conversationId = "",
  userDetailText = "",
  requestedTaskKind = "personal",
  source = "task_interface",
  sourceConversationTitle = "Tasks",
  requestId = "",
  bundleId = "",
  attachments = [],
  onProgress = null,
} = {}) {
  if (!accountId || !walletSecret?.mnemonic || walletSecret.accountId !== accountId) {
    throw new Error("Unlock the local seed vault before requesting a task.");
  }
  if (!linkedWalletAddress || walletSecret.address !== linkedWalletAddress) {
    throw new Error("Unlocked wallet does not match the linked wallet.");
  }

  const requestPayload = {
    requestId,
    bundleId,
    conversationId,
    requestText: taskRequestCanonicalText,
    userDetailText: safeText(userDetailText, 8000),
    requestedTaskKind,
    source,
    sourceConversationTitle,
    attachments,
  };
  const progress = (label) => {
    if (typeof onProgress === "function") onProgress(label);
  };
  progress("Configuring request");
  const walletCore = await import("../../wallet-core");
  const userPubkey = await walletCore.deriveTaskNodePublicKey(walletSecret.mnemonic);

  const config = await requestJson("/api/tasks/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase: "config", ...requestPayload, tasknodeEncryptionPubkey: userPubkey }),
  });
  if (!config.ok || !config.body?.tasknodeEncryptionPubkey || !config.body?.requestBundle) {
    throw new Error(config.body?.message || "Task request publishing is not configured.");
  }

  progress("Encrypting request");
  const recipients = [userPubkey, config.body.tasknodeEncryptionPubkey];
  const encryptedBundlePayload = await walletCore.encryptTaskNodePayload({
    plaintext: JSON.stringify(config.body.requestBundle),
    recipientPublicKeys: recipients,
  });
  progress("Pinning request bundle");
  const bundlePrepared = await requestJson("/api/tasks/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "prepare_bundle",
      ...requestPayload,
      encryptedBundlePayload,
    }),
  });
  if (!bundlePrepared.ok || !bundlePrepared.body?.bundleCid) {
    throw new Error(bundlePrepared.body?.message || "Task request bundle could not be pinned.");
  }

  progress("Preparing transaction");
  const eventPayload = await buildRequestEvent({
    bundleCid: bundlePrepared.body.bundleCid,
    bundleDigest: bundlePrepared.body.bundleDigest,
    config: config.body,
    linkedWalletAddress,
  });
  const encryptedEventPayload = await walletCore.encryptTaskNodePayload({
    plaintext: JSON.stringify(eventPayload),
    recipientPublicKeys: recipients,
  });
  const prepared = await requestJson("/api/tasks/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "prepare",
      ...requestPayload,
      bundleCid: bundlePrepared.body.bundleCid,
      bundleDigest: bundlePrepared.body.bundleDigest,
      encryptedEventPayload,
    }),
  });
  if (!prepared.ok || !prepared.body?.txJson) {
    throw new Error(prepared.body?.message || "Task request transaction could not be prepared.");
  }

  progress("Signing transaction");
  const signed = walletCore.signPreparedPftlTransaction({
    mnemonic: walletSecret.mnemonic,
    txJson: prepared.body.txJson,
    expectedAddress: linkedWalletAddress,
  });
  progress("Publishing to PFTL");
  const submitted = await requestJson("/api/tasks/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "submit",
      ...requestPayload,
      cid: prepared.body.cid,
      eventCid: prepared.body.cid,
      bundleCid: bundlePrepared.body.bundleCid,
      bundleDigest: bundlePrepared.body.bundleDigest,
      signedTxBlob: signed.txBlob,
      pointer: prepared.body.pointer,
      transaction: prepared.body.transaction,
    }),
  });
  if (!submitted.ok || !submitted.body?.ok) {
    throw new Error(submitted.body?.message || "Task request transaction could not be submitted.");
  }

  return {
    ...submitted.body,
    requestBundle: config.body.requestBundle,
    requestEvent: eventPayload,
  };
}
