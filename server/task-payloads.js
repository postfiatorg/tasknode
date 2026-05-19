import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";
import { Wallet } from "xrpl";
import { fetchContextIpfsJson } from "./context-ipfs.js";

const ENCRYPTION_SUITE = "ENC_X25519_XCHACHA20P1305";
const TEXT_DECODER = new TextDecoder();

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function sha256Hex(value) {
  const data = typeof value === "string" || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(value || {});
  return createHash("sha256").update(data).digest("hex");
}

function base64ToBytes(value) {
  return Buffer.from(String(value || ""), "base64");
}

function bytesToBase64(value) {
  return Buffer.from(value).toString("base64");
}

function configuredSeed(env = process.env) {
  return normalizeText(
    env.TASKNODE_SERVICE_SEED ||
      env.TASKNODE_ENCRYPTION_SEED ||
      env.TASKNODE_PFT_FAUCET_SEED ||
      env.FAUCET_SEED ||
      ""
  );
}

export async function tasknodeServiceIdentityFromEnv(env = process.env) {
  const seed = configuredSeed(env);
  if (!seed) return null;
  await sodium.ready;
  const seedBytes = createHash("sha256").update(seed, "utf8").digest();
  const keypair = sodium.crypto_box_seed_keypair(seedBytes);
  let walletAddress = "";
  try {
    walletAddress = Wallet.fromSeed(seed).classicAddress;
  } catch {
    walletAddress = "";
  }
  return {
    role: "task_node_service",
    walletAddress,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    publicKeyBase64: bytesToBase64(keypair.publicKey),
    recipientId: sha256Hex(Buffer.from(keypair.publicKey)),
  };
}

export async function decryptTasknodeServicePayload({ blob, env = process.env } = {}) {
  if (!blob || typeof blob !== "object") throw new Error("task_payload_missing");
  if (blob.enc !== ENCRYPTION_SUITE) {
    throw new Error(`task_payload_unsupported_encryption:${blob.enc || "missing"}`);
  }
  const identity = await tasknodeServiceIdentityFromEnv(env);
  if (!identity?.privateKey) throw new Error("tasknode_service_decryption_seed_missing");

  const recipients = Array.isArray(blob.recipients) ? blob.recipients : [];
  const shard = recipients.find((entry) => {
    return normalizeText(entry?.recipient_id).toLowerCase() === identity.recipientId;
  });
  if (!shard) throw new Error("tasknode_service_recipient_missing");

  await sodium.ready;
  const fileKey = sodium.crypto_box_open_easy(
    base64ToBytes(shard.encrypted_file_key),
    base64ToBytes(shard.wrap_nonce),
    base64ToBytes(shard.ephemeral_pubkey),
    identity.privateKey
  );
  const plaintextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    base64ToBytes(blob.ciphertext),
    null,
    base64ToBytes(blob.nonce),
    fileKey
  );
  if (blob.content_hash) {
    const digest = sha256Hex(Buffer.from(plaintextBytes));
    if (digest !== normalizeText(blob.content_hash).toLowerCase()) {
      throw new Error("task_payload_content_hash_mismatch");
    }
  }
  const plaintext = TEXT_DECODER.decode(plaintextBytes);
  return JSON.parse(plaintext);
}

async function recipientIdForPublicKey(publicKeyBytes) {
  return sha256Hex(Buffer.from(publicKeyBytes));
}

export async function encryptTasknodePayload({ plaintext, recipientPublicKeys = [] } = {}) {
  await sodium.ready;
  const textBytes = Buffer.from(String(plaintext || ""), "utf8");
  const fileKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(textBytes, null, null, nonce, fileKey);
  const recipients = [];

  for (const publicKey of Array.isArray(recipientPublicKeys) ? recipientPublicKeys : []) {
    const recipientKey = base64ToBytes(publicKey);
    if (recipientKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
      throw new Error("task_payload_recipient_pubkey_invalid");
    }
    const ephKeypair = sodium.crypto_box_keypair();
    const wrapNonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const encryptedFileKey = sodium.crypto_box_easy(fileKey, wrapNonce, recipientKey, ephKeypair.privateKey);
    recipients.push({
      recipient_id: await recipientIdForPublicKey(recipientKey),
      ephemeral_pubkey: bytesToBase64(ephKeypair.publicKey),
      wrap_nonce: bytesToBase64(wrapNonce),
      encrypted_file_key: bytesToBase64(encryptedFileKey),
    });
  }

  return {
    version: 1,
    enc: ENCRYPTION_SUITE,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
    content_hash: sha256Hex(textBytes),
    recipients,
  };
}

export async function fetchAndDecryptTasknodePayload({
  cid,
  env = process.env,
  fetchIpfsJson = fetchContextIpfsJson,
} = {}) {
  const fetched = await fetchIpfsJson({ cid });
  if (!fetched?.ok) throw new Error(fetched?.error || "task_ipfs_fetch_failed");
  const payload = await decryptTasknodeServicePayload({ blob: fetched.payload, env });
  return {
    cid: fetched.cid || cid,
    gateway: fetched.gateway || "",
    payload,
  };
}
