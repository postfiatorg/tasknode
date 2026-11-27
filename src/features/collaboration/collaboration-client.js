import { requestJson } from "../../api.js";
import * as walletCore from "../../wallet-core.js";
import { validateWalletChallengeMessage } from "../../../shared/wallet-challenge-guard.js";

function requireMnemonic(walletSecret) {
  const mnemonic = String(walletSecret?.mnemonic || "").trim();
  if (!mnemonic) throw new Error("Unlock your wallet to authorize this action.");
  return mnemonic;
}

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

async function sha256Hex(value = "") {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeCollaborationPayloadDigest({ action = "", resourceId = "", payload = {} } = {}) {
  const canonical = {
    action: safeText(action, 80),
    resourceId: safeText(resourceId, 240),
    payload: stableValue(safeObject(payload)),
  };
  return {
    canonical,
    digest: await sha256Hex(JSON.stringify(canonical)),
  };
}

function guardError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export async function verifyCollaborationChallengeMessage({
  message = "",
  action = "",
  resourceId = "",
  payload = {},
  accountId = "",
  walletAddress = "",
  now = Date.now(),
} = {}) {
  const parsed = validateWalletChallengeMessage(message, {
    purpose: "collaboration_auth",
    walletAddress,
    expectedAccountId: accountId,
    now,
  });
  const { canonical, digest } = await computeCollaborationPayloadDigest({ action, resourceId, payload });
  const { fields } = parsed;
  if (fields.Action !== canonical.action) {
    throw guardError("SIGNING_GUARD_PREFIX_MISMATCH", "Collaboration challenge Action does not match local request.");
  }
  if (fields.Resource !== (canonical.resourceId || "new")) {
    throw guardError("SIGNING_GUARD_PREFIX_MISMATCH", "Collaboration challenge Resource does not match local request.");
  }
  if (fields["Payload SHA-256"].toLowerCase() !== digest.toLowerCase()) {
    throw guardError("SIGNING_GUARD_PREFIX_MISMATCH", "Collaboration challenge Payload SHA-256 does not match local payload.");
  }
  return { parsed, canonical, digest };
}

export async function signedCollaborationProof({
  action,
  resourceId = "",
  payload = {},
  walletSecret,
  accountId = "",
  requestImpl = requestJson,
  now = Date.now(),
}) {
  const mnemonic = requireMnemonic(walletSecret);
  const wallet = walletCore.deriveWalletSummary(mnemonic);
  const expectedAccountId = String(accountId || walletSecret?.accountId || "").trim();
  const challengeResult = await requestImpl("/api/collaboration/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, resourceId, payload }),
  });
  if (!challengeResult.ok || !challengeResult.body?.challenge?.message) {
    throw new Error(challengeResult.body?.error || "Could not create wallet authorization.");
  }
  const message = challengeResult.body.challenge.message;
  await verifyCollaborationChallengeMessage({
    message,
    action,
    resourceId,
    payload,
    accountId: expectedAccountId,
    walletAddress: wallet.address,
    now,
  });
  const signed = walletCore.signWalletChallenge(mnemonic, message, {
    purpose: "collaboration_auth",
    expectedAccountId,
    now,
  });
  return {
    challengeId: challengeResult.body.challenge.id,
    signature: signed.signature,
    publicKey: signed.publicKey,
  };
}

export async function encryptForTaskNodeWallet(value, recipientPublicKeys, walletSecret) {
  requireMnemonic(walletSecret);
  return walletCore.encryptTaskNodePayload({
    plaintext: JSON.stringify(value),
    recipientPublicKeys,
  });
}

export async function decryptFromTaskNodeWallet(blob, walletSecret) {
  const plaintext = await walletCore.decryptTaskNodePayload({
    blob,
    mnemonic: requireMnemonic(walletSecret),
  });
  return JSON.parse(plaintext);
}

export async function ownEncryptionPublicKey(walletSecret) {
  return walletCore.deriveTaskNodePublicKey(requireMnemonic(walletSecret));
}

export function newUuid() {
  return globalThis.crypto.randomUUID();
}
