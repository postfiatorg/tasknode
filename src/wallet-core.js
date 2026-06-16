import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import sodium from "libsodium-wrappers";
import * as keypairs from "ripple-keypairs";
import { Wallet } from "xrpl";

export const TASKNODE_DERIVATION_PATH = "m/44'/144'/0'/0/0";
export const TASKNODE_VAULT_VERSION = 1;
export const TASKNODE_VAULT_STORAGE_PREFIX = "tasknode.walletVault.v1.";
export const TASKNODE_VAULT_IDB_NAME = "tasknode-wallet-vaults";
export const TASKNODE_VAULT_IDB_STORE = "vaults";
export const TASKNODE_VAULT_IDB_VERSION = 1;
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

function hasLocalStorage() {
  return Boolean(globalThis.localStorage);
}

function hasIndexedDb() {
  return Boolean(globalThis.indexedDB);
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

function normalizeStoredWalletVault(value) {
  const vault = value?.vault || value;
  try {
    if (vault?.kind !== "tasknode-local-seed-vault" || vault.version !== TASKNODE_VAULT_VERSION) {
      return null;
    }
    return vault;
  } catch {
    return null;
  }
}

function normalizeVaultPersistence(value) {
  return value === "persistent" || value === "volatile" || value === "unknown" ? value : "unknown";
}

export async function walletVaultPersistence() {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage || typeof storage.persisted !== "function") return "unknown";
    return await storage.persisted() ? "persistent" : "volatile";
  } catch {
    return "unknown";
  }
}

async function persistenceFromRequestResult(persistent) {
  if (persistent) return "persistent";
  const current = await walletVaultPersistence();
  if (current === "persistent") return "persistent";
  const storage = globalThis.navigator?.storage;
  if (storage && (typeof storage.persist === "function" || typeof storage.persisted === "function")) {
    return "volatile";
  }
  return "unknown";
}

export function vaultStatusFromVault({ accountId, vault, storage = "", persistence = "unknown" }) {
  const normalizedPersistence = normalizeVaultPersistence(persistence);
  if (!vault) {
    return {
      available: false,
      unlocked: false,
      accountId,
      address: null,
      persistence: normalizedPersistence,
    };
  }

  return {
    available: true,
    unlocked: false,
    accountId,
    version: vault.version,
    address: vault.address || null,
    publicKey: vault.publicKey || null,
    derivationPath: vault.derivationPath || TASKNODE_DERIVATION_PATH,
    createdAt: vault.createdAt || null,
    updatedAt: vault.updatedAt || null,
    storage: storage || "local",
    persistence: normalizedPersistence,
    kdf: vault.encryption?.kdf?.name || "PBKDF2",
    hash: vault.encryption?.kdf?.hash || "SHA-256",
    iterations: vault.encryption?.kdf?.iterations || TASKNODE_VAULT_KDF_ITERATIONS,
  };
}

function loadLocalStorageWalletVault({ accountId }) {
  if (!hasLocalStorage()) return null;
  const raw = requireStorage().getItem(walletVaultStorageKey({ accountId }));
  if (!raw) return null;

  try {
    return normalizeStoredWalletVault(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveVaultToLocalStorage({ accountId, vault }) {
  requireStorage().setItem(walletVaultStorageKey({ accountId }), JSON.stringify(vault));
}

function removeVaultFromLocalStorage({ accountId }) {
  if (!hasLocalStorage()) return;
  requireStorage().removeItem(walletVaultStorageKey({ accountId }));
}

function openWalletVaultDb() {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(TASKNODE_VAULT_IDB_NAME, TASKNODE_VAULT_IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TASKNODE_VAULT_IDB_STORE)) {
        db.createObjectStore(TASKNODE_VAULT_IDB_STORE, { keyPath: "accountId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("INDEXEDDB_OPEN_FAILED"));
    request.onblocked = () => reject(new Error("INDEXEDDB_OPEN_BLOCKED"));
  });
}

async function withVaultObjectStore(mode, callback) {
  const db = await openWalletVaultDb();
  if (!db) return null;
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TASKNODE_VAULT_IDB_STORE, mode);
      const store = tx.objectStore(TASKNODE_VAULT_IDB_STORE);
      let callbackResult = null;
      tx.oncomplete = () => resolve(callbackResult);
      tx.onerror = () => reject(tx.error || new Error("INDEXEDDB_TRANSACTION_FAILED"));
      tx.onabort = () => reject(tx.error || new Error("INDEXEDDB_TRANSACTION_ABORTED"));
      callbackResult = callback(store);
    });
  } finally {
    db.close();
  }
}

async function requestPersistentVaultStorage() {
  try {
    if (typeof globalThis.navigator?.storage?.persist !== "function") return false;
    return await globalThis.navigator.storage.persist();
  } catch {
    return false;
  }
}

function requestFromStore(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("INDEXEDDB_REQUEST_FAILED"));
  });
}

async function loadIndexedDbWalletVault({ accountId }) {
  if (!hasIndexedDb()) return null;
  try {
    const record = await withVaultObjectStore("readonly", (store) =>
      requestFromStore(store.get(accountId))
    );
    return normalizeStoredWalletVault(record);
  } catch {
    return null;
  }
}

async function saveVaultToIndexedDb({ accountId, vault }) {
  if (!hasIndexedDb()) throw new Error("INDEXEDDB_UNAVAILABLE");
  await withVaultObjectStore("readwrite", (store) =>
    requestFromStore(store.put({
      accountId,
      key: walletVaultStorageKey({ accountId }),
      vault,
      updatedAt: new Date().toISOString(),
    }))
  );
}

async function removeVaultFromIndexedDb({ accountId }) {
  if (!hasIndexedDb()) return;
  await withVaultObjectStore("readwrite", (store) => requestFromStore(store.delete(accountId)));
}

export function loadLocalWalletVault({ accountId }) {
  return loadLocalStorageWalletVault({ accountId });
}

export async function loadLocalWalletVaultAsync({ accountId }) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const indexedDbVault = await loadIndexedDbWalletVault({ accountId: normalizedAccountId });
  if (indexedDbVault) return indexedDbVault;

  const localStorageVault = loadLocalStorageWalletVault({ accountId: normalizedAccountId });
  if (localStorageVault) {
    try {
      await saveVaultToIndexedDb({ accountId: normalizedAccountId, vault: localStorageVault });
      await requestPersistentVaultStorage();
    } catch {
      // localStorage remains the compatibility fallback if IndexedDB is blocked.
    }
  }
  return localStorageVault;
}

export function localWalletVaultStatus({ accountId }) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId) {
    return {
      available: false,
      unlocked: false,
      accountId: null,
      address: null,
      persistence: "unknown",
    };
  }

  const vault = loadLocalStorageWalletVault({ accountId: normalizedAccountId });
  return vaultStatusFromVault({ accountId: normalizedAccountId, vault, storage: "localStorage" });
}

export async function localWalletVaultStatusAsync({ accountId }) {
  const normalizedAccountId = String(accountId || "").trim();
  const persistence = await walletVaultPersistence();
  if (!normalizedAccountId) {
    return {
      available: false,
      unlocked: false,
      accountId: null,
      address: null,
      persistence,
    };
  }

  const indexedDbVault = await loadIndexedDbWalletVault({ accountId: normalizedAccountId });
  if (indexedDbVault) {
    return vaultStatusFromVault({
      accountId: normalizedAccountId,
      vault: indexedDbVault,
      storage: "indexedDB",
      persistence,
    });
  }

  const localStorageVault = loadLocalStorageWalletVault({ accountId: normalizedAccountId });
  if (localStorageVault) {
    try {
      await saveVaultToIndexedDb({ accountId: normalizedAccountId, vault: localStorageVault });
      const persistent = await requestPersistentVaultStorage();
      const nextPersistence = await persistenceFromRequestResult(persistent);
      return vaultStatusFromVault({
        accountId: normalizedAccountId,
        vault: localStorageVault,
        storage: "localStorage",
        persistence: nextPersistence,
      });
    } catch {
      // Keep reporting the fallback vault; persistence can be blocked in private/in-app browsers.
    }
    return vaultStatusFromVault({
      accountId: normalizedAccountId,
      vault: localStorageVault,
      storage: "localStorage",
      persistence,
    });
  }

  return vaultStatusFromVault({ accountId: normalizedAccountId, vault: null, persistence });
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
  const existing = await loadLocalWalletVaultAsync({ accountId: normalizedAccountId });
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

  let saved = false;
  let lastError = null;
  let savedStorage = "";
  let persistence = await walletVaultPersistence();
  try {
    await saveVaultToIndexedDb({ accountId: normalizedAccountId, vault });
    const persistent = persistence === "persistent" ? true : await requestPersistentVaultStorage();
    persistence = await persistenceFromRequestResult(persistent);
    saved = true;
    savedStorage = "indexedDB";
  } catch (error) {
    lastError = error;
  }
  try {
    saveVaultToLocalStorage({ accountId: normalizedAccountId, vault });
    saved = true;
    if (!savedStorage) savedStorage = "localStorage";
  } catch (error) {
    lastError = error;
  }
  if (!saved) {
    throw lastError || new Error("VAULT_STORAGE_UNAVAILABLE");
  }

  return vaultStatusFromVault({
    accountId: normalizedAccountId,
    vault,
    storage: savedStorage || "localStorage",
    persistence,
  });
}

export async function unlockEncryptedMnemonicVault({ accountId, password, expectedAddress = "" }) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const vault = await loadLocalWalletVaultAsync({ accountId: normalizedAccountId });
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
  removeVaultFromLocalStorage({ accountId: normalizedAccountId });
  void removeVaultFromIndexedDb({ accountId: normalizedAccountId });
  return localWalletVaultStatus({ accountId: normalizedAccountId });
}

export async function removeLocalWalletVaultAsync({ accountId }) {
  const normalizedAccountId = normalizeAccountId(accountId);
  removeVaultFromLocalStorage({ accountId: normalizedAccountId });
  await removeVaultFromIndexedDb({ accountId: normalizedAccountId });
  return localWalletVaultStatusAsync({ accountId: normalizedAccountId });
}
