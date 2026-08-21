import { createHash } from "node:crypto";
import * as keypairs from "ripple-keypairs";
import { messageToHex, verifyWalletSignature } from "./wallet-proof.js";

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

export function taskTransitionSignatureMessage({
  payload = {},
  role = "actor",
  transition = "",
  taskId = "",
} = {}) {
  const digest = `sha256:${sha256Hex(payload)}`;
  return [
    "Post Fiat Task Node task transition",
    "Purpose: task_transition",
    `Role: ${safeText(role, 80)}`,
    `Task-ID: ${safeText(taskId || payload.task_id || payload.taskId, 180)}`,
    `Transition: ${safeText(transition || payload.transition || payload.status_after || payload.schema, 120)}`,
    `Payload-Digest: ${digest}`,
  ].join("\n");
}

export function signTaskTransition({
  payload = {},
  signerWallet = null,
  role = "authority",
  transition = "",
  signedAt = new Date().toISOString(),
} = {}) {
  if (!signerWallet?.privateKey || !signerWallet?.publicKey || !signerWallet?.classicAddress) {
    throw new Error("task_transition_signer_wallet_required");
  }
  const taskId = safeText(payload.task_id || payload.taskId, 180);
  const message = taskTransitionSignatureMessage({ payload, role, transition, taskId });
  return {
    schema: "pf.task.transition_signature.v1",
    role: safeText(role, 80),
    task_id: taskId,
    transition: safeText(transition || payload.transition || payload.status_after || payload.schema, 120),
    signer_wallet: signerWallet.classicAddress,
    public_key: signerWallet.publicKey,
    payload_digest: `sha256:${sha256Hex(payload)}`,
    message,
    signature: keypairs.sign(messageToHex(message), signerWallet.privateKey),
    signed_at: signedAt,
    algorithm: "ripple-keypairs.secp256k1",
  };
}

export function verifyTaskTransitionSignature({ payload = {}, signature = {} } = {}) {
  const envelope = safeObject(signature);
  const payloadDigest = `sha256:${sha256Hex(payload)}`;
  if (!Object.keys(envelope).length) {
    return { present: false, verified: false, reason: "signature_missing" };
  }
  if (safeText(envelope.payload_digest, 180) !== payloadDigest) {
    return {
      present: true,
      verified: false,
      reason: "payload_digest_mismatch",
      payloadDigest,
      signatureDigest: safeText(envelope.payload_digest, 180),
    };
  }
  const expectedMessage = taskTransitionSignatureMessage({
    payload,
    role: envelope.role,
    transition: envelope.transition,
    taskId: envelope.task_id,
  });
  if (safeText(envelope.message, 2000) !== expectedMessage) {
    return { present: true, verified: false, reason: "signature_message_mismatch", payloadDigest };
  }
  const verified = verifyWalletSignature({
    message: expectedMessage,
    signature: envelope.signature,
    publicKey: envelope.public_key || envelope.publicKey,
    address: envelope.signer_wallet || envelope.address,
  });
  return {
    present: true,
    verified,
    reason: verified ? "verified" : "signature_invalid",
    payloadDigest,
  };
}

export function taskTransitionSignatureRequired(env = process.env) {
  return ["1", "true", "yes", "on"].includes(
    String(env.TASKNODE_TASK_TRANSITION_SIGNATURES_REQUIRED || "").trim().toLowerCase()
  );
}

export function signatureRecord({ payload = {}, signature = {}, required = false } = {}) {
  const verification = verifyTaskTransitionSignature({ payload, signature });
  if (required && !verification.verified) {
    const error = new Error(`task_transition_signature_invalid:${verification.reason}`);
    error.code = "task_transition_signature_invalid";
    error.status = 400;
    throw error;
  }
  return {
    ...safeObject(signature),
    verification,
  };
}
