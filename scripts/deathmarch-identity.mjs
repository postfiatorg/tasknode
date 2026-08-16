import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import sodium from "libsodium-wrappers";

export const DEFAULT_DEATHMARCH_SEED_FILE = "deathmarchseed.txt";

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function seedEnvAlreadyConfigured(env = process.env) {
  return Boolean(safeText(
    env.TASKNODE_SERVICE_SEED ||
      env.TASKNODE_ENCRYPTION_SEED ||
      env.TASKNODE_PFT_FAUCET_SEED ||
      env.FAUCET_SEED ||
      "",
    5000
  ));
}

export function configuredDeathmarchUserMnemonic(env = process.env) {
  return safeText(env.DEATHMARCH_USER_MNEMONIC || env.TASKNODE_USER_MNEMONIC || "", 10000)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function looksLikeTaskNodeMnemonic(value = "") {
  const normalized = safeText(value, 10000).toLowerCase().replace(/\s+/g, " ");
  return Boolean(normalized && validateMnemonic(normalized, wordlist));
}

function base64ToBytes(value) {
  return Buffer.from(String(value || ""), "base64");
}

function bytesToBase64(value) {
  return Buffer.from(value).toString("base64");
}

async function userKeypairFromMnemonic(mnemonic = "") {
  const normalized = safeText(mnemonic, 10000).toLowerCase().replace(/\s+/g, " ");
  if (!looksLikeTaskNodeMnemonic(normalized)) throw new Error("deathmarch_user_mnemonic_invalid");
  await sodium.ready;
  const seedBytes = createHash("sha256").update(mnemonicToSeedSync(normalized)).digest();
  return sodium.crypto_box_seed_keypair(seedBytes);
}

async function recipientIdForPublicKey(publicKeyBytes) {
  return createHash("sha256").update(Buffer.from(publicKeyBytes)).digest("hex");
}

export async function tasknodePublicKeyFromUserMnemonic(mnemonic = "") {
  const keypair = await userKeypairFromMnemonic(mnemonic);
  return bytesToBase64(keypair.publicKey);
}

export async function decryptTasknodeUserMnemonicPayload({ blob, mnemonic = "" } = {}) {
  if (!blob || typeof blob !== "object") throw new Error("task_payload_missing");
  if (blob.enc !== "ENC_X25519_XCHACHA20P1305") {
    throw new Error(`task_payload_unsupported_encryption:${blob.enc || "missing"}`);
  }
  const keypair = await userKeypairFromMnemonic(mnemonic);
  const recipientId = await recipientIdForPublicKey(keypair.publicKey);
  const recipients = Array.isArray(blob.recipients) ? blob.recipients : [];
  const shard = recipients.find((entry) => {
    return safeText(entry?.recipient_id, 200).toLowerCase() === recipientId;
  });
  if (!shard) throw new Error("tasknode_user_recipient_missing");

  await sodium.ready;
  const fileKey = sodium.crypto_box_open_easy(
    base64ToBytes(shard.encrypted_file_key),
    base64ToBytes(shard.wrap_nonce),
    base64ToBytes(shard.ephemeral_pubkey),
    keypair.privateKey
  );
  const plaintextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    base64ToBytes(blob.ciphertext),
    null,
    base64ToBytes(blob.nonce),
    fileKey
  );
  if (blob.content_hash) {
    const digest = createHash("sha256").update(Buffer.from(plaintextBytes)).digest("hex");
    if (digest !== safeText(blob.content_hash, 120).toLowerCase()) {
      throw new Error("task_payload_content_hash_mismatch");
    }
  }
  return JSON.parse(Buffer.from(plaintextBytes).toString("utf8"));
}

function seedFileCandidatePaths(seedFile, explicitSeedFile) {
  const configuredFile = safeText(seedFile, 2000);
  if (!configuredFile) return [];
  const firstPath = path.isAbsolute(configuredFile)
    ? configuredFile
    : path.resolve(process.cwd(), configuredFile);
  if (explicitSeedFile || path.basename(configuredFile) !== DEFAULT_DEATHMARCH_SEED_FILE) return [firstPath];
  return [firstPath, path.resolve(process.cwd(), "..", DEFAULT_DEATHMARCH_SEED_FILE)];
}

export async function deathmarchEnvWithSeedFile({
  env = process.env,
  seedFile = DEFAULT_DEATHMARCH_SEED_FILE,
  explicitSeedFile = false,
} = {}) {
  const serviceSeedConfigured = seedEnvAlreadyConfigured(env);
  const candidates = seedFileCandidatePaths(seedFile, explicitSeedFile);
  if (!candidates.length) return env;

  let fileText = null;
  let loadedPath = "";
  for (const candidatePath of candidates) {
    try {
      fileText = await fs.readFile(candidatePath, "utf8");
      loadedPath = candidatePath;
      break;
    } catch {
      fileText = null;
    }
  }
  if (fileText === null) {
    if (explicitSeedFile) {
      throw new Error(`deathmarch_seed_file_missing:${safeText(seedFile, 2000)}`);
    }
    return env;
  }

  const seed = safeText(fileText, 5000);
  if (!seed) {
    if (explicitSeedFile) throw new Error(`deathmarch_seed_file_empty:${loadedPath || safeText(seedFile, 2000)}`);
    return env;
  }
  if (looksLikeTaskNodeMnemonic(seed)) {
    return { ...env, DEATHMARCH_USER_MNEMONIC: configuredDeathmarchUserMnemonic(env) || seed };
  }
  if (serviceSeedConfigured) return env;
  return { ...env, TASKNODE_SERVICE_SEED: seed };
}
