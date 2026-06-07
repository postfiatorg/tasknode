import { createHash } from "node:crypto";
import { getLinkedWallet } from "./runtime-store.js";
import { pinContextIpfsJson } from "./context-ipfs.js";
import {
  encryptedPayloadHasRecipient,
  resolveTasknodeEncryptionKey,
  safeTxHash,
  validateEncryptedPayload,
} from "./context-publish.js";
import { buildPftPointerMemo, POINTER_FLAGS } from "./pftl-pointer.js";
import { preparePftPointerTransaction, submitSignedPftTransaction } from "./pftl-submit.js";
import { query } from "./db/pool.js";
import { canApplyTaskStopAction, taskLifecycleActions } from "./task-lifecycle-policy.js";
import { syncPftlWalletTransactions } from "./pftl-cache-sync.js";
import { runPftlCacheReducerOnce } from "./pftl-cache-reducer.js";

const ACTION_ID = "task_lifecycle_action";
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

function normalizeTaskAction(value = "") {
  const action = safeText(value, 40).toLowerCase();
  if (["accept", "accepted"].includes(action)) return "accept";
  if (["cancel", "cancelled"].includes(action)) return "cancel";
  if (["refuse", "refused", "reject", "rejected"].includes(action)) return "refuse";
  return "";
}

async function requireSessionTask({ payload = {}, session = null } = {}) {
  if (!session?.accountId) {
    return {
      error: actionResponse({
        status: 401,
        error: "task_login_required",
        message: "Sign in before changing a task.",
        actionRequired: "Sign in, unlock the linked wallet, then retry.",
      }),
    };
  }

  const wallet = getLinkedWallet({ accountId: session.accountId });
  if (wallet.status !== "linked" || !wallet.address) {
    return {
      error: actionResponse({
        status: 409,
        error: "task_wallet_required",
        message: "Link a PFT wallet before changing a task.",
        actionRequired: "Create or link a seed wallet, unlock the local vault, then retry.",
      }),
    };
  }

  const taskId = safeText(payload?.taskId || payload?.task_id, 180);
  if (!taskId) {
    return {
      error: actionResponse({
        status: 400,
        error: "task_id_required",
        message: "A task ID is required.",
        actionRequired: "Open a task detail page and retry from that task.",
      }),
    };
  }

  const taskResult = await query(
    `
      SELECT task_id, account_id, subject_wallet, authority_wallet, allocation_wallet, status, title
      FROM task_projections
      WHERE task_id = $1
        AND subject_wallet = $2
        AND account_id = $3
      LIMIT 1
    `,
    [taskId, wallet.address, session.accountId]
  );
  const task = taskResult.rows[0];
  if (!task) {
    return {
      error: actionResponse({
        status: 404,
        error: "task_not_found",
        message: "No indexed task projection was found for the linked wallet.",
        actionRequired: "Refresh tasks and confirm the task belongs to the active wallet.",
      }),
    };
  }

  return {
    accountId: session.accountId,
    wallet,
    task,
  };
}

async function taskActionConfig({ payload, session }) {
  const resolved = await requireSessionTask({ payload, session });
  if (resolved.error) return resolved.error;

  const tasknodeEncryptionKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeEncryptionKey?.publicKey) {
    return actionResponse({
      status: 409,
      error: "tasknode_encryption_key_missing",
      message: "Task Node encryption key is not configured.",
      actionRequired: "Configure the Task Node service encryption key before publishing task actions.",
    });
  }

  const actions = taskLifecycleActions(resolved.task.status);
  return okResponse({
    phase: "config",
    taskId: resolved.task.task_id,
    status: resolved.task.status,
    title: resolved.task.title || "",
    actions,
    tasknodeEncryptionPubkey: tasknodeEncryptionKey.publicKey,
    tasknodeServiceAddress: tasknodeEncryptionKey.serviceAddress,
    wallets: {
      user: resolved.wallet.address,
      authority: resolved.task.authority_wallet || "",
      allocation: resolved.task.allocation_wallet || "",
    },
    pointer: {
      kind: "TASK_UPDATE",
      schema: TASK_POINTER_SCHEMA,
      flags: POINTER_FLAGS.encrypted,
    },
  });
}

async function prepareTaskAction({ payload, session }) {
  const resolved = await requireSessionTask({ payload, session });
  if (resolved.error) return resolved.error;

  const requestedAction = normalizeTaskAction(payload?.taskAction || payload?.task_action);
  const actions = taskLifecycleActions(resolved.task.status);
  const action = requestedAction || actions.stopAction;
  if (!canApplyTaskStopAction(resolved.task.status, action)) {
    return actionResponse({
      status: 409,
      error: "task_action_not_available",
      message: "This task state does not allow that action.",
      actionRequired: "Refresh the task. Terminal tasks cannot be cancelled or refused.",
      extra: { status: resolved.task.status, actions },
    });
  }

  const encryptedPayload = payload?.encryptedPayload || payload?.encrypted_payload;
  if (!validateEncryptedPayload(encryptedPayload)) {
    return actionResponse({
      status: 400,
      error: "task_encrypted_payload_invalid",
      message: "Task action payload must be encrypted before it is pinned.",
      actionRequired: "Unlock the local wallet vault and retry from the task detail page.",
    });
  }

  const tasknodeEncryptionKey = await resolveTasknodeEncryptionKey(process.env, { checkOnchain: true });
  if (!tasknodeEncryptionKey?.publicKey) {
    return actionResponse({
      status: 409,
      error: "tasknode_encryption_key_missing",
      message: "Task Node encryption key is not configured.",
      actionRequired: "Configure the Task Node service encryption key before publishing task actions.",
    });
  }
  if (!encryptedPayloadHasRecipient(encryptedPayload, tasknodeEncryptionKey.publicKey)) {
    return actionResponse({
      status: 400,
      error: "tasknode_recipient_missing",
      message: "Task action payload is not encrypted to Task Node.",
      actionRequired:
        "Refresh the task action configuration and retry so the encrypted IPFS payload includes the Task Node recipient shard.",
    });
  }

  const transition = action === "accept" ? "accepted" : action === "refuse" ? "refused" : "cancelled";
  const contentKind = action === "accept" ? "TASK" : "TASK_UPDATE";
  const pin = await pinContextIpfsJson({
    payload: encryptedPayload,
    name: `tasknode-task-${transition}-${sha256(`${resolved.accountId}:${resolved.task.task_id}:${Date.now()}`).slice(0, 16)}`,
    keyvalues: {
      app: "tasknodeofficial",
      content_kind: contentKind,
      schema: "pf.task.update.v1",
      account_hash: sha256(resolved.accountId).slice(0, 24),
      wallet_address: resolved.wallet.address,
      task_id: resolved.task.task_id,
      task_action: transition,
    },
  });

  const pointerMemo = buildPftPointerMemo({
    cid: pin.cid,
    kind: "TASK_UPDATE",
    schema: TASK_POINTER_SCHEMA,
    flags: POINTER_FLAGS.encrypted,
    taskId: resolved.task.task_id,
  });
  const prepared = await preparePftPointerTransaction({
    account: resolved.wallet.address,
    destination: resolved.task.authority_wallet || tasknodeEncryptionKey.serviceAddress || resolved.wallet.address,
    pointerMemo,
  });

  return okResponse({
    phase: "prepared",
    message: `${transition === "accepted" ? "Accept task" : actions.stopLabel} payload pinned. Sign the PFTL pointer transaction to publish.`,
    taskId: resolved.task.task_id,
    taskAction: action,
    transition,
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

async function bestEffortRefreshTaskProjection({ accountId, walletAddress, taskId = "", txHash = "" }) {
  try {
    const synced = await syncPftlWalletTransactions({
      walletAddress,
      accountId,
      limit: 80,
      maxPages: 1,
      syncKind: "task_action_submit",
    });
    const targeted = taskId || txHash
      ? await runPftlCacheReducerOnce({ batchLimit: 8, logger: console, taskId, txHash })
      : { claimed: 0 };
    const reduced = targeted.claimed > 0
      ? targeted
      : await runPftlCacheReducerOnce({ batchLimit: 20, logger: console });
    return { synced, reduced, targeted: Boolean(targeted.claimed > 0) };
  } catch (error) {
    return {
      ok: false,
      error: safeText(error?.code || error?.message || error, 500),
    };
  }
}

async function submitTaskAction({ payload, session }) {
  const resolved = await requireSessionTask({ payload, session });
  if (resolved.error) return resolved.error;

  const submit = await submitSignedPftTransaction({
    signedTxBlob: payload?.signedTxBlob || payload?.signed_tx_blob,
    expectedAccount: resolved.wallet.address,
  });
  const txHash = safeTxHash(submit.txHash);
  if (!txHash) {
    return actionResponse({
      status: 502,
      error: "task_action_tx_hash_missing",
      message: "PFTL accepted the transaction response but did not return a hash.",
      actionRequired: "Check the linked wallet history before retrying to avoid a duplicate pointer.",
    });
  }

  const refresh = await bestEffortRefreshTaskProjection({
    accountId: resolved.accountId,
    walletAddress: resolved.wallet.address,
    taskId: resolved.task.task_id,
    txHash,
  });

  return okResponse({
    phase: "submitted",
    message: "Task action published to PFT.",
    taskId: resolved.task.task_id,
    cid: safeText(payload?.cid, 240),
    txHash,
    engineResult: submit.engineResult,
    refresh,
  });
}

export async function taskLifecycleAction(payload = {}, method = "POST", session = null) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "task_action_method_not_allowed",
      message: "Task actions require POST.",
      actionRequired: "Call the task action endpoint with POST.",
    });
  }

  const phase = safeText(payload?.phase || "", 40).toLowerCase();
  try {
    if (phase === "prepare") return await prepareTaskAction({ payload, session });
    if (phase === "submit" || payload?.signedTxBlob || payload?.signed_tx_blob) {
      return await submitTaskAction({ payload, session });
    }
    return await taskActionConfig({ payload, session });
  } catch (error) {
    return actionResponse({
      status: error?.status || 502,
      error: error?.code || error?.message || "task_action_failed",
      message: error?.message || "Task action could not be published to PFT.",
      actionRequired: "Check wallet unlock state, PFT balance, PFTL connectivity, and IPFS configuration, then retry.",
      extra: {
        attempts: Array.isArray(error?.attempts) ? error.attempts : undefined,
      },
    });
  }
}
