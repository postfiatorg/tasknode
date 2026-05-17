import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import sodium from "libsodium-wrappers";
import * as keypairs from "ripple-keypairs";
import { Wallet } from "xrpl";

export const TASKNODE_DERIVATION_PATH = "m/44'/144'/0'/0/0";
export const TASKNODE_VAULT_VERSION = 1;
export const TASKNODE_VAULT_STORAGE_PREFIX = "tasknode.walletVault.v1.";
export const TASKNODE_VAULT_KDF_ITERATIONS = 310000;
export const TASKNODE_ENC_SUITE = "ENC_X25519_XCHACHA20P1305";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function normalizeMnemonic(mnemonic) {
  return String(mnemonic || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function mnemonicWordCount(mnemonic) {
  const normalized = normalizeMnemonic(mnemonic);
  return normalized ? normalized.split(" ").length : 0;
}

export function isValidTaskNodeMnemonic(mnemonic) {
  const normalized = normalizeMnemonic(mnemonic);
  return mnemonicWordCount(normalized) === 24 && validateMnemonic(normalized, wordlist);
}

export function generateTaskNodeMnemonic() {
  return generateMnemonic(wordlist, 256);
}

function messageToHex(message) {
  return Array.from(textEncoder.encode(String(message || "")))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function deriveWalletSummary(mnemonic) {
  const normalized = normalizeMnemonic(mnemonic);
  if (!isValidTaskNodeMnemonic(normalized)) {
    throw new Error("INVALID_MNEMONIC");
  }

  const wallet = Wallet.fromMnemonic(normalized, {
    mnemonicEncoding: "bip39",
    derivationPath: TASKNODE_DERIVATION_PATH,
  });

  return {
    address: wallet.classicAddress,
    publicKey: wallet.publicKey,
    derivationPath: TASKNODE_DERIVATION_PATH,
  };
}

export function signWalletChallenge(mnemonic, message) {
  const normalized = normalizeMnemonic(mnemonic);
  if (!isValidTaskNodeMnemonic(normalized)) {
    throw new Error("INVALID_MNEMONIC");
  }

  const wallet = Wallet.fromMnemonic(normalized, {
    mnemonicEncoding: "bip39",
    derivationPath: TASKNODE_DERIVATION_PATH,
  });
  const signature = keypairs.sign(messageToHex(message), wallet.privateKey);

  return {
    address: wallet.classicAddress,
    publicKey: wallet.publicKey,
    signature,
    derivationPath: TASKNODE_DERIVATION_PATH,
  };
}

export function signPreparedPftlTransaction({ mnemonic, txJson, expectedAddress = "" } = {}) {
  const normalized = normalizeMnemonic(mnemonic);
  if (!isValidTaskNodeMnemonic(normalized)) {
    throw new Error("INVALID_MNEMONIC");
  }
  if (!txJson || typeof txJson !== "object") {
    throw new Error("MISSING_TRANSACTION_PAYLOAD");
  }

  const wallet = Wallet.fromMnemonic(normalized, {
    mnemonicEncoding: "bip39",
    derivationPath: TASKNODE_DERIVATION_PATH,
  });
  const expected = String(expectedAddress || txJson.Account || "").trim();
  if (expected && wallet.classicAddress !== expected) {
    throw new Error("WALLET_TRANSACTION_ADDRESS_MISMATCH");
  }
  if (txJson.Account && txJson.Account !== wallet.classicAddress) {
    throw new Error("WALLET_TRANSACTION_ADDRESS_MISMATCH");
  }

  const signed = wallet.sign(txJson);
  return {
    address: wallet.classicAddress,
    txBlob: signed.tx_blob,
    txHash: signed.hash || null,
  };
}

function requireBrowserCrypto() {
  const api = globalThis.crypto;
  if (!api?.subtle || typeof api.getRandomValues !== "function") {
    throw new Error("WEB_CRYPTO_UNAVAILABLE");
  }
  return api;
}

function requireStorage() {
  if (!globalThis.localStorage) {
    throw new Error("LOCAL_STORAGE_UNAVAILABLE");
  }
  return globalThis.localStorage;
}

function normalizeAccountId(accountId) {
  const normalized = String(accountId || "").trim();
  if (!normalized) throw new Error("ACCOUNT_REQUIRED");
  return normalized;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToLowerHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isHex(value) {
  return typeof value === "string" && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

async function sha256Bytes(bytes) {
  const hash = await requireBrowserCrypto().subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
}

async function getSodium() {
  await sodium.ready;
  return sodium;
}

async function deriveTaskNodeSeedBytes(mnemonic) {
  const normalized = normalizeMnemonic(mnemonic);
  if (!isValidTaskNodeMnemonic(normalized)) {
    throw new Error("INVALID_MNEMONIC");
  }
  return sha256Bytes(mnemonicToSeedSync(normalized));
}

export async function deriveTaskNodeX25519KeypairFromMnemonic(mnemonic) {
  const libsodium = await getSodium();
  const seedBytes = await deriveTaskNodeSeedBytes(mnemonic);
  return libsodium.crypto_box_seed_keypair(seedBytes);
}

export async function deriveTaskNodePublicKey(mnemonic) {
  const keypair = await deriveTaskNodeX25519KeypairFromMnemonic(mnemonic);
  return bytesToBase64(keypair.publicKey);
}

async function deriveTaskNodeRecipientId(publicKeyBytes) {
  return bytesToLowerHex(await sha256Bytes(publicKeyBytes));
}

export function isTaskNodeEncryptedBlob(blob) {
  return Boolean(blob && blob.version === 1 && blob.enc === TASKNODE_ENC_SUITE);
}

function parseMaybeJson(text) {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function decryptTaskNodePayload({ blob, mnemonic }) {
  if (!blob || !mnemonic) {
    throw new Error("MISSING_TASKNODE_DECRYPT_INPUT");
  }
  if (!isTaskNodeEncryptedBlob(blob)) {
    throw new Error("UNSUPPORTED_TASKNODE_PAYLOAD");
  }

  const libsodium = await getSodium();
  const keypair = await deriveTaskNodeX25519KeypairFromMnemonic(mnemonic);
  const recipientId = await deriveTaskNodeRecipientId(keypair.publicKey);
  const recipients = Array.isArray(blob.recipients) ? blob.recipients : [];
  const shard = recipients.find((entry) => entry && entry.recipient_id === recipientId);
  if (!shard) {
    throw new Error("NO_KEY_SHARD");
  }

  const fileKey = libsodium.crypto_box_open_easy(
    base64ToBytes(shard.encrypted_file_key || ""),
    base64ToBytes(shard.wrap_nonce || ""),
    base64ToBytes(shard.ephemeral_pubkey || ""),
    keypair.privateKey
  );
  const plaintextBytes = libsodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    base64ToBytes(blob.ciphertext || ""),
    null,
    base64ToBytes(blob.nonce || ""),
    fileKey
  );

  if (blob.content_hash && isHex(blob.content_hash)) {
    const contentHash = bytesToLowerHex(await sha256Bytes(plaintextBytes));
    if (contentHash !== String(blob.content_hash).toLowerCase()) {
      throw new Error("TASKNODE_CONTENT_HASH_MISMATCH");
    }
  }

  return textDecoder.decode(plaintextBytes);
}

export async function encryptTaskNodePayload({ plaintext, recipientPublicKeys } = {}) {
  const libsodium = await getSodium();
  const textBytes = textEncoder.encode(String(plaintext || ""));
  const fileKey = libsodium.randombytes_buf(libsodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  const nonce = libsodium.randombytes_buf(libsodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = libsodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    textBytes,
    null,
    null,
    nonce,
    fileKey
  );
  const recipients = [];
  for (const publicKey of Array.isArray(recipientPublicKeys) ? recipientPublicKeys : []) {
    const recipientKey = base64ToBytes(publicKey);
    const ephKeypair = libsodium.crypto_box_keypair();
    const wrapNonce = libsodium.randombytes_buf(libsodium.crypto_box_NONCEBYTES);
    const encryptedFileKey = libsodium.crypto_box_easy(
      fileKey,
      wrapNonce,
      recipientKey,
      ephKeypair.privateKey
    );
    recipients.push({
      recipient_id: await deriveTaskNodeRecipientId(recipientKey),
      ephemeral_pubkey: bytesToBase64(ephKeypair.publicKey),
      wrap_nonce: bytesToBase64(wrapNonce),
      encrypted_file_key: bytesToBase64(encryptedFileKey),
    });
  }

  return {
    version: 1,
    enc: TASKNODE_ENC_SUITE,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
    content_hash: bytesToLowerHex(await sha256Bytes(textBytes)),
    recipients,
  };
}

export async function encryptTaskNodePayloadForTests(args = {}) {
  return encryptTaskNodePayload(args);
}

export async function hydrateTaskNodeFetchedPayload({ payload, mnemonic }) {
  if (isTaskNodeEncryptedBlob(payload)) {
    const plaintext = await decryptTaskNodePayload({ blob: payload, mnemonic });
    return {
      decrypted: true,
      plaintext,
      payload: parseMaybeJson(plaintext),
    };
  }

  return {
    decrypted: false,
    plaintext: null,
    payload,
  };
}

function randomBase64(byteLength) {
  const bytes = new Uint8Array(byteLength);
  requireBrowserCrypto().getRandomValues(bytes);
  return bytesToBase64(bytes);
}

async function deriveVaultKey(password, saltBytes, iterations) {
  const api = requireBrowserCrypto();
  const keyMaterial = await api.subtle.importKey(
    "raw",
    textEncoder.encode(String(password || "")),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return api.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes,
      iterations,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function walletVaultStorageKey({ accountId }) {
  return `${TASKNODE_VAULT_STORAGE_PREFIX}${encodeURIComponent(normalizeAccountId(accountId))}`;
}

export function loadLocalWalletVault({ accountId }) {
  const raw = requireStorage().getItem(walletVaultStorageKey({ accountId }));
  if (!raw) return null;

  try {
    const vault = JSON.parse(raw);
    if (vault?.kind !== "tasknode-local-seed-vault" || vault.version !== TASKNODE_VAULT_VERSION) {
      return null;
    }
    return vault;
  } catch {
    return null;
  }
}

export function localWalletVaultStatus({ accountId }) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId || !globalThis.localStorage) {
    return {
      available: false,
      unlocked: false,
      accountId: normalizedAccountId || null,
      address: null,
    };
  }

  const vault = loadLocalWalletVault({ accountId: normalizedAccountId });
  if (!vault) {
    return {
      available: false,
      unlocked: false,
      accountId: normalizedAccountId,
      address: null,
    };
  }

  return {
    available: true,
    unlocked: false,
    accountId: normalizedAccountId,
    version: vault.version,
    address: vault.address || null,
    publicKey: vault.publicKey || null,
    derivationPath: vault.derivationPath || TASKNODE_DERIVATION_PATH,
    createdAt: vault.createdAt || null,
    updatedAt: vault.updatedAt || null,
    kdf: vault.encryption?.kdf?.name || "PBKDF2",
    hash: vault.encryption?.kdf?.hash || "SHA-256",
    iterations: vault.encryption?.kdf?.iterations || TASKNODE_VAULT_KDF_ITERATIONS,
  };
}

export async function saveEncryptedMnemonicVault({
  accountId,
  mnemonic,
  password,
  iterations = TASKNODE_VAULT_KDF_ITERATIONS,
}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const normalizedMnemonic = normalizeMnemonic(mnemonic);
  if (!isValidTaskNodeMnemonic(normalizedMnemonic)) {
    throw new Error("INVALID_MNEMONIC");
  }
  if (String(password || "").length < 10) {
    throw new Error("VAULT_PASSWORD_TOO_SHORT");
  }

  const api = requireBrowserCrypto();
  const existing = loadLocalWalletVault({ accountId: normalizedAccountId });
  const summary = deriveWalletSummary(normalizedMnemonic);
  const now = new Date().toISOString();
  const salt = randomBase64(16);
  const iv = randomBase64(12);
  const key = await deriveVaultKey(password, base64ToBytes(salt), iterations);
  const payload = {
    mnemonic: normalizedMnemonic,
    address: summary.address,
    publicKey: summary.publicKey,
    derivationPath: summary.derivationPath,
    accountId: normalizedAccountId,
    exportedAt: now,
  };
  const ciphertext = await api.subtle.encrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    textEncoder.encode(JSON.stringify(payload))
  );
  const vault = {
    kind: "tasknode-local-seed-vault",
    version: TASKNODE_VAULT_VERSION,
    accountId: normalizedAccountId,
    address: summary.address,
    publicKey: summary.publicKey,
    derivationPath: summary.derivationPath,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    encryption: {
      name: "AES-GCM",
      iv,
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations,
        salt,
      },
    },
  };

  requireStorage().setItem(walletVaultStorageKey({ accountId: normalizedAccountId }), JSON.stringify(vault));
  return {
    ...localWalletVaultStatus({ accountId: normalizedAccountId }),
    address: summary.address,
    publicKey: summary.publicKey,
    derivationPath: summary.derivationPath,
  };
}

export async function unlockEncryptedMnemonicVault({ accountId, password, expectedAddress = "" }) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const vault = loadLocalWalletVault({ accountId: normalizedAccountId });
  if (!vault?.encryption?.ciphertext || !vault.encryption?.iv || !vault.encryption?.kdf?.salt) {
    throw new Error("VAULT_NOT_FOUND");
  }
  if (!password) {
    throw new Error("VAULT_PASSWORD_REQUIRED");
  }

  try {
    const api = requireBrowserCrypto();
    const key = await deriveVaultKey(
      password,
      base64ToBytes(vault.encryption.kdf.salt),
      vault.encryption.kdf.iterations || TASKNODE_VAULT_KDF_ITERATIONS
    );
    const plaintext = await api.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(vault.encryption.iv) },
      key,
      base64ToBytes(vault.encryption.ciphertext)
    );
    const payload = JSON.parse(textDecoder.decode(plaintext));
    const mnemonic = normalizeMnemonic(payload.mnemonic);
    const summary = deriveWalletSummary(mnemonic);
    const expected = String(expectedAddress || vault.address || "").trim();

    if (expected && summary.address !== expected) {
      throw new Error("VAULT_ADDRESS_MISMATCH");
    }
    if (vault.publicKey && summary.publicKey !== vault.publicKey) {
      throw new Error("VAULT_PUBLIC_KEY_MISMATCH");
    }

    return {
      mnemonic,
      address: summary.address,
      publicKey: summary.publicKey,
      derivationPath: summary.derivationPath,
      accountId: normalizedAccountId,
      unlockedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (
      error?.message === "VAULT_ADDRESS_MISMATCH" ||
      error?.message === "VAULT_PUBLIC_KEY_MISMATCH"
    ) {
      throw error;
    }
    throw new Error("VAULT_UNLOCK_FAILED");
  }
}

export function removeLocalWalletVault({ accountId }) {
  const normalizedAccountId = normalizeAccountId(accountId);
  requireStorage().removeItem(walletVaultStorageKey({ accountId: normalizedAccountId }));
  return localWalletVaultStatus({ accountId: normalizedAccountId });
}
