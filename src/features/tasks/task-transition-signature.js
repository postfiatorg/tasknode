function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value = "") {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signatureMessage({ payload = {}, role = "actor", transition = "", taskId = "" } = {}) {
  const digest = `sha256:${await sha256Hex(stableJson(payload))}`;
  return {
    digest,
    message: [
      "Post Fiat Task Node task transition",
      "Purpose: task_transition",
      `Role: ${safeText(role, 80)}`,
      `Task-ID: ${safeText(taskId || payload.task_id || payload.taskId, 180)}`,
      `Transition: ${safeText(transition || payload.transition || payload.status_after || payload.schema, 120)}`,
      `Payload-Digest: ${digest}`,
    ].join("\n"),
  };
}

export async function buildActorTransitionSignature({
  accountId = "",
  linkedWalletAddress = "",
  payload = {},
  taskId = "",
  transition = "",
  walletSecret = null,
} = {}) {
  if (!walletSecret?.mnemonic || walletSecret.accountId !== accountId || walletSecret.address !== linkedWalletAddress) {
    return null;
  }
  const { digest, message } = await signatureMessage({ payload, role: "actor", transition, taskId });
  const walletCore = await import("../../wallet-core");
  const proof = walletCore.signWalletChallenge(walletSecret.mnemonic, message);
  return {
    schema: "pf.task.transition_signature.v1",
    role: "actor",
    task_id: safeText(taskId || payload.task_id || payload.taskId, 180),
    transition: safeText(transition || payload.transition || payload.status_after || payload.schema, 120),
    signer_wallet: proof.address,
    public_key: proof.publicKey,
    payload_digest: digest,
    message,
    signature: proof.signature,
    signed_at: new Date().toISOString(),
    algorithm: "ripple-keypairs.secp256k1",
  };
}
