import { createHash, randomBytes, randomUUID } from "node:crypto";
import { databaseEnabled, query } from "../db/pool.js";
import { verifyWalletSignature } from "../wallet-proof.js";
import { getLinkedWallet as getDurableLinkedWallet } from "./account-wallets.js";

const challengeTtlMs = 5 * 60_000;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((output, key) => {
    if (value[key] !== undefined) output[key] = stableValue(value[key]);
    return output;
  }, {});
}

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function ensureDatabase() {
  if (databaseEnabled()) return;
  const error = new Error("collaboration_database_not_configured");
  error.code = "collaboration_database_not_configured";
  error.status = 503;
  throw error;
}

export function stableCollaborationJson(value) {
  return JSON.stringify(stableValue(value));
}

export function collaborationChallengePayload({
  action = "",
  resourceId = "",
  payload = {},
} = {}) {
  return {
    action: safeText(action, 80),
    resourceId: safeText(resourceId, 240),
    payload: stableValue(safeObject(payload)),
  };
}

export async function createCollaborationChallenge({
  accountId = "",
  action = "",
  resourceId = "",
  payload = {},
  now = new Date(),
} = {}) {
  ensureDatabase();
  const wallet = await getDurableLinkedWallet({ accountId });
  if (!wallet?.address) {
    return { ok: false, status: 409, error: "collaboration_wallet_required" };
  }
  const challengeId = randomUUID();
  const canonical = collaborationChallengePayload({ action, resourceId, payload });
  if (!canonical.action) {
    return { ok: false, status: 400, error: "collaboration_action_required" };
  }
  const payloadDigest = sha256(stableCollaborationJson(canonical));
  const expiresAt = new Date(now.getTime() + challengeTtlMs);
  const nonce = randomBytes(18).toString("base64url");
  const message = [
    "Task Node collaboration authorization",
    `Action: ${canonical.action}`,
    `Resource: ${canonical.resourceId || "new"}`,
    `Account: ${accountId}`,
    `Wallet: ${wallet.address}`,
    `Payload SHA-256: ${payloadDigest}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");
  await query(
    `INSERT INTO collaboration_wallet_challenges (
       challenge_id, account_id, wallet_address, action, resource_id,
       payload_digest, message, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [challengeId, accountId, wallet.address, canonical.action, canonical.resourceId, payloadDigest, message, expiresAt]
  );
  return {
    ok: true,
    challenge: {
      id: challengeId,
      message,
      action: canonical.action,
      resourceId: canonical.resourceId,
      payloadDigest,
      walletAddress: wallet.address,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

function proofError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

export async function consumeCollaborationProof({
  client,
  accountId = "",
  action = "",
  resourceId = "",
  payload = {},
  proof = {},
} = {}) {
  const challengeId = safeText(proof.challengeId || proof.challenge_id, 180);
  const signature = safeText(proof.signature, 1000);
  const publicKey = safeText(proof.publicKey || proof.public_key, 240);
  if (!challengeId || !signature || !publicKey) {
    throw proofError("collaboration_wallet_proof_required", 400);
  }
  const selected = await client.query(
    `SELECT * FROM collaboration_wallet_challenges
     WHERE challenge_id = $1 AND account_id = $2
     FOR UPDATE`,
    [challengeId, accountId]
  );
  const challenge = selected.rows[0];
  const canonical = collaborationChallengePayload({ action, resourceId, payload });
  const expectedDigest = sha256(stableCollaborationJson(canonical));
  if (
    !challenge ||
    challenge.consumed_at ||
    Date.parse(challenge.expires_at) <= Date.now() ||
    challenge.action !== canonical.action ||
    challenge.resource_id !== canonical.resourceId ||
    challenge.payload_digest !== expectedDigest
  ) {
    throw proofError("collaboration_challenge_invalid", 400);
  }
  const linkedWallet = await getDurableLinkedWallet({ accountId });
  if (!linkedWallet?.address || linkedWallet.address !== challenge.wallet_address) {
    throw proofError("collaboration_wallet_changed", 409);
  }
  if (!verifyWalletSignature({
    message: challenge.message,
    signature,
    publicKey,
    address: challenge.wallet_address,
  })) {
    throw proofError("collaboration_wallet_signature_invalid", 401);
  }
  await client.query(
    "UPDATE collaboration_wallet_challenges SET consumed_at = now() WHERE challenge_id = $1",
    [challengeId]
  );
  return {
    canonical,
    signature,
    publicKey,
    walletAddress: challenge.wallet_address,
    signatureHash: sha256(signature),
  };
}
