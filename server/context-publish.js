import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";
import { getLinkedWallet } from "./runtime-store.js";
import { getContextDocument, saveIndexedContextHistory } from "./repositories/context.js";
import { contextIpfsPinStatus, pinContextIpfsJson } from "./context-ipfs.js";
import { buildPftPointerMemo, CONTENT_KIND, POINTER_FLAGS } from "./pftl-pointer.js";
import { preparePftPointerTransaction, pftlSubmitStatus, submitSignedPftTransaction } from "./pftl-submit.js";
import { normalizeContextBodyForStorage } from "../shared/context-html.js";

const ACTION_ID = "ink_manifest";
const CONTEXT_POINTER_SCHEMA = 1;
const ENCRYPTION_SUITE = "ENC_X25519_XCHACHA20P1305";
let tasknodeEncryptionPubkeyCache = null;

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

function cleanText(value = "", maxLength = 50000) {
  return String(value || "").slice(0, maxLength);
}

function stripHtml(value = "") {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(value = "") {
  const text = stripHtml(value);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function parsePhase(payload = {}) {
  const phase = String(payload?.phase || "").trim().toLowerCase();
  if (["config", "prepare", "submit"].includes(phase)) return phase;
  if (payload?.signedTxBlob || payload?.signed_tx_blob) return "submit";
  if (payload?.encryptedPayload || payload?.encrypted_payload) return "prepare";
  return "config";
}

function configuredSeed(env = process.env) {
  return String(env.TASKNODE_PFT_FAUCET_SEED || env.FAUCET_SEED || "").trim();
}

export async function getTasknodeEncryptionPubkey(env = process.env) {
  const explicit = String(env.TASKNODE_ENCRYPTION_PUBKEY || "").trim();
  if (explicit) return explicit;
  if (tasknodeEncryptionPubkeyCache) return tasknodeEncryptionPubkeyCache;

  const seed = configuredSeed(env);
  if (!seed) return null;
  await sodium.ready;
  const seedBytes = createHash("sha256").update(seed, "utf8").digest();
  const keypair = sodium.crypto_box_seed_keypair(seedBytes);
  tasknodeEncryptionPubkeyCache = sodium.to_base64(
    keypair.publicKey,
    sodium.base64_variants.ORIGINAL
  );
  return tasknodeEncryptionPubkeyCache;
}

export async function contextPublishStatus(env = process.env) {
  const ipfs = contextIpfsPinStatus(env);
  const pftl = pftlSubmitStatus(env);
  const tasknodeEncryptionPubkey = await getTasknodeEncryptionPubkey(env).catch(() => null);
  return {
    configured: Boolean(ipfs.configured && pftl.wssConfigured && tasknodeEncryptionPubkey),
    ipfs,
    pftl,
    tasknodeEncryptionPubkeyConfigured: Boolean(tasknodeEncryptionPubkey),
  };
}

function validateEncryptedPayload(payload) {
  const encrypted = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!encrypted || encrypted.version !== 1 || encrypted.enc !== ENCRYPTION_SUITE) return false;
  return Boolean(encrypted.nonce && encrypted.ciphertext && Array.isArray(encrypted.recipients));
}

function safeTxHash(value = "") {
  const text = String(value || "").trim().toUpperCase();
  return /^[A-F0-9]{64}$/.test(text) ? text : "";
}

async function requireSessionWallet(session) {
  if (!session?.accountId) {
    return {
      error: actionResponse({
        status: 401,
        error: "context_login_required",
        message: "Sign in before publishing context to PFT.",
        actionRequired: "Use an account login, link a PFT wallet, then publish again.",
      }),
    };
  }

  const wallet = getLinkedWallet({ accountId: session.accountId });
  if (wallet.status !== "linked" || !wallet.address) {
    return {
      error: actionResponse({
        status: 409,
        error: "context_wallet_required",
        message: "Link a PFT wallet before publishing context.",
        actionRequired: "Create or link a seed wallet, unlock the local vault, then publish again.",
      }),
    };
  }

  return {
    accountId: session.accountId,
    wallet,
  };
}

async function contextPublishConfig(session) {
  const resolved = await requireSessionWallet(session);
  if (resolved.error) return resolved.error;

  const tasknodeEncryptionPubkey = await getTasknodeEncryptionPubkey();
  if (!tasknodeEncryptionPubkey) {
    return actionResponse({
      status: 409,
      error: "tasknode_encryption_key_missing",
      message: "Task Node encryption key is not configured.",
      actionRequired:
        "Configure TASKNODE_ENCRYPTION_PUBKEY or the PFT faucet seed so published context can be encrypted to Task Node.",
    });
  }

  return okResponse({
    phase: "config",
    tasknodeEncryptionPubkey,
    pointer: {
      kind: "CONTEXT",
      schema: CONTEXT_POINTER_SCHEMA,
      flags: POINTER_FLAGS.encrypted,
    },
    message: "Context publishing is ready.",
  });
}

async function prepareContextPublish({ payload, session }) {
  const resolved = await requireSessionWallet(session);
  if (resolved.error) return resolved.error;

  const encryptedPayload = payload?.encryptedPayload || payload?.encrypted_payload;
  if (!validateEncryptedPayload(encryptedPayload)) {
    return actionResponse({
      status: 400,
      error: "context_encrypted_payload_invalid",
      message: "Context payload must be encrypted before it is pinned.",
      actionRequired: "Unlock the local wallet vault and retry publish from the browser.",
    });
  }

  const document = await getContextDocument({ accountId: resolved.accountId });
  const title = cleanText(payload?.title || document.title || "Task Node Context", 120);
  const body = normalizeContextBodyForStorage(payload?.body || document.body || "");
  const normalizedWordCount = Number.isFinite(Number(payload?.wordCount))
    ? Math.max(0, Math.trunc(Number(payload.wordCount)))
    : wordCount(body);
  const contextId = document.id || `ctx_${sha256(resolved.accountId).slice(0, 16)}`;
  const revision = Number(document.revision || 0);

  const pin = await pinContextIpfsJson({
    payload: encryptedPayload,
    name: `tasknode-context-${sha256(`${resolved.accountId}:${revision}:${Date.now()}`).slice(0, 16)}`,
    keyvalues: {
      app: "tasknodeofficial",
      content_kind: "CONTEXT",
      schema: String(CONTEXT_POINTER_SCHEMA),
      account_hash: sha256(resolved.accountId).slice(0, 24),
      wallet_address: resolved.wallet.address,
      context_id: contextId,
    },
  });

  const pointerMemo = buildPftPointerMemo({
    cid: pin.cid,
    kind: "CONTEXT",
    schema: CONTEXT_POINTER_SCHEMA,
    flags: POINTER_FLAGS.encrypted,
    contextId,
  });
  const prepared = await preparePftPointerTransaction({
    account: resolved.wallet.address,
    pointerMemo,
  });

  return okResponse({
    phase: "prepared",
    message: "Context payload pinned. Sign the PFTL pointer transaction to publish.",
    cid: pin.cid,
    payloadSha256: pin.sha256,
    sizeBytes: pin.sizeBytes,
    txJson: prepared.txJson,
    tx_json: prepared.txJson,
    pointer: pointerMemo.payload,
    memo: {
      memoType: pointerMemo.memoTypeHex,
      memoFormat: pointerMemo.memoFormatHex,
      memoData: pointerMemo.memoDataHex,
    },
    context: {
      id: contextId,
      title,
      revision,
      wordCount: normalizedWordCount,
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

async function submitContextPublish({ payload, session }) {
  const resolved = await requireSessionWallet(session);
  if (resolved.error) return resolved.error;

  const cid = String(payload?.cid || "").trim().replace(/^ipfs:\/\//i, "").replace(/^\/ipfs\//i, "");
  if (!cid) {
    return actionResponse({
      status: 400,
      error: "context_publish_cid_required",
      message: "Published context CID is missing.",
      actionRequired: "Prepare the context publish again, then sign and submit the fresh transaction.",
    });
  }

  const submit = await submitSignedPftTransaction({
    signedTxBlob: payload?.signedTxBlob || payload?.signed_tx_blob,
    expectedAccount: resolved.wallet.address,
  });
  const txHash = safeTxHash(submit.txHash);
  if (!txHash) {
    return actionResponse({
      status: 502,
      error: "context_publish_tx_hash_missing",
      message: "PFTL accepted the transaction response but did not return a hash.",
      actionRequired: "Check the linked wallet history before retrying to avoid a duplicate pointer.",
    });
  }

  const pointer = payload?.pointer && typeof payload.pointer === "object" ? payload.pointer : {};
  const context = payload?.context && typeof payload.context === "object" ? payload.context : {};
  const now = new Date().toISOString();
  const snapshot = {
    source: "tasknodeofficial_context_publish",
    walletAddress: resolved.wallet.address,
    contextRevisions: [{
      id: context.id || pointer.contextId || `pftl:${txHash}:0`,
      cid,
      context_id: context.id || pointer.contextId || null,
      tx_hash: txHash,
      tx_timestamp: now,
      ledger_index: submit.ledgerIndex || null,
      memo_index: 0,
      context_version: context.revision || pointer.schema || CONTEXT_POINTER_SCHEMA,
      schema: pointer.schema || CONTEXT_POINTER_SCHEMA,
      flags: pointer.flags ?? POINTER_FLAGS.encrypted,
      kind: CONTENT_KIND.CONTEXT,
      kindLabel: "CONTEXT",
      account: resolved.wallet.address,
      destination: submit.destination || payload?.transaction?.destination || null,
      direction:
        submit.destination && submit.destination === resolved.wallet.address
          ? "self"
          : "outbound",
      source: "tasknodeofficial.context_publish",
      word_count: context.wordCount ?? null,
    }],
    tasks: [],
    taskEvents: [],
    taskSubmissions: [],
  };
  const saved = await saveIndexedContextHistory({
    accountId: resolved.accountId,
    snapshot,
  });

  return okResponse({
    phase: "submitted",
    message: "Published to PFT.",
    cid,
    txHash,
    engineResult: submit.engineResult,
    history: saved.history || null,
  });
}

export async function contextManifestInk(payload = {}, method = "POST", session = null) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      message: "Publish to PFT requires POST.",
      actionRequired: "Call the context publish action with POST.",
    });
  }

  const phase = parsePhase(payload);
  try {
    if (phase === "config") return await contextPublishConfig(session);
    if (phase === "prepare") return await prepareContextPublish({ payload, session });
    return await submitContextPublish({ payload, session });
  } catch (error) {
    return actionResponse({
      status: error?.status || 502,
      error: error?.code || error?.message || "context_publish_failed",
      message: error?.message || "Context could not be published to PFT.",
      actionRequired: "Check wallet balance, PFTL connectivity, and IPFS configuration, then retry.",
    });
  }
}
