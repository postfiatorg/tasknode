import { requestJson } from "../../api";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function normalizeAction(value = "") {
  const action = safeText(value, 40).toLowerCase();
  if (action === "accept" || action === "accepted") return "accept";
  if (action === "refuse" || action === "refused") return "refuse";
  return "cancel";
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

function actionTimestamps(action, createdAt) {
  if (action === "accept") return { accepted_at: createdAt };
  if (action === "refuse") return { refused_at: createdAt };
  return { cancelled_at: createdAt };
}

export async function publishTaskLifecycleAction({
  accountId = "",
  linkedWalletAddress = "",
  walletSecret = null,
  task = {},
  detail = {},
  taskAction = "cancel",
  reason = "",
} = {}) {
  const taskId = safeText(task.taskId || task.fullId || task.id || detail?.task?.taskId || detail?.task?.fullId, 180);
  if (!taskId) throw new Error("Task ID is missing.");
  if (!accountId || !walletSecret?.mnemonic || walletSecret.accountId !== accountId) {
    throw new Error("Unlock the local seed vault before changing a task.");
  }
  if (!linkedWalletAddress || walletSecret.address !== linkedWalletAddress) {
    throw new Error("Unlocked wallet does not match the linked wallet.");
  }

  const action = normalizeAction(taskAction);
  const transition = action === "accept" ? "accepted" : action === "refuse" ? "refused" : "cancelled";
  const createdAt = new Date().toISOString();
  const wallets = detail?.wallets || {};
  const basePayload = {
    schema: "pf.task.update.v1",
    protocol: "tasknode.pftl",
    created_at: createdAt,
    chain: "pftl-testnet",
    task_id: taskId,
    actor_wallet: linkedWalletAddress,
    subject_wallet: linkedWalletAddress,
    authority_wallet: wallets.authority || "",
    allocation_wallet: wallets.allocation || "",
    transition,
    status_after: transition,
    reason:
      safeText(reason, 2000) ||
      (action === "accept"
        ? "User accepted the task."
        : action === "refuse"
          ? "User refused the task."
          : "User cancelled the task."),
    ...actionTimestamps(action, createdAt),
  };
  const eventPayload = {
    ...basePayload,
    event_id: await eventIdFor(basePayload),
  };

  const walletCore = await import("../../wallet-core");
  const config = await requestJson("/api/tasks/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase: "config", taskId, taskAction: action }),
  });
  if (!config.ok || !config.body?.tasknodeEncryptionPubkey) {
    throw new Error(config.body?.message || "Task action publishing is not configured.");
  }

  const userPubkey = await walletCore.deriveTaskNodePublicKey(walletSecret.mnemonic);
  const encryptedPayload = await walletCore.encryptTaskNodePayload({
    plaintext: JSON.stringify(eventPayload),
    recipientPublicKeys: [userPubkey, config.body.tasknodeEncryptionPubkey],
  });

  const prepared = await requestJson("/api/tasks/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "prepare",
      taskId,
      taskAction: action,
      encryptedPayload,
    }),
  });
  if (!prepared.ok || !prepared.body?.txJson) {
    throw new Error(prepared.body?.message || "Task action transaction could not be prepared.");
  }

  const signed = walletCore.signPreparedPftlTransaction({
    mnemonic: walletSecret.mnemonic,
    txJson: prepared.body.txJson,
    expectedAddress: linkedWalletAddress,
  });
  const submitted = await requestJson("/api/tasks/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "submit",
      taskId,
      taskAction: action,
      cid: prepared.body.cid,
      signedTxBlob: signed.txBlob,
      pointer: prepared.body.pointer,
      transaction: prepared.body.transaction,
    }),
  });
  if (!submitted.ok || !submitted.body?.ok) {
    throw new Error(submitted.body?.message || "Task action transaction could not be submitted.");
  }

  return submitted.body;
}
