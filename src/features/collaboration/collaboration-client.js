import { requestJson } from "../../api";
import * as walletCore from "../../wallet-core";

function requireMnemonic(walletSecret) {
  const mnemonic = String(walletSecret?.mnemonic || "").trim();
  if (!mnemonic) throw new Error("Unlock your wallet to authorize this action.");
  return mnemonic;
}

export async function signedCollaborationProof({ action, resourceId = "", payload = {}, walletSecret }) {
  const mnemonic = requireMnemonic(walletSecret);
  const challengeResult = await requestJson("/api/collaboration/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, resourceId, payload }),
  });
  if (!challengeResult.ok || !challengeResult.body?.challenge?.message) {
    throw new Error(challengeResult.body?.error || "Could not create wallet authorization.");
  }
  const signed = walletCore.signWalletChallenge(mnemonic, challengeResult.body.challenge.message);
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
