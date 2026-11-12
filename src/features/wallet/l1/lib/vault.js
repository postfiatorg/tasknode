// Encrypted vault using Web Crypto API + IndexedDB.
// Master seed encrypted with AES-256-GCM, key derived from passphrase via PBKDF2.

import {
  clearCustodyMaterialRegistry,
  registerCustodyMaterial,
} from './custody-boundary.js';

const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 310000;
const DB_NAME = 'tasknode-l1-wallet';
const DB_VERSION = 1;
const STORE_VAULTS = 'vaults';
const STORE_SETTINGS = 'settings';

export function defaultRpcEndpoint() {
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/l1/rpc`;
}
export function normalizeRpcEndpoint() { return defaultRpcEndpoint(); }
function normalizeSettings(settings = {}) { return { autoLockMinutes: settings.autoLockMinutes || 15, rpcEndpoint: defaultRpcEndpoint() }; }

// Module-scope only — never on window
let decryptedSeed = null;
let decryptedBackupJson = null;
let autoLockTimer = null;
let autoLockMinutes = 15;
let autoLockLeaseCount = 0;
let autoLockCallback = null;

export function clearSensitiveMemory() {
  decryptedSeed = null;
  decryptedBackupJson = null;
  clearCustodyMaterialRegistry();
}

export function getDecryptedSeed() {
  return decryptedSeed;
}

export function getDecryptedBackup() {
  return decryptedBackupJson;
}

export function setDecryptedState(seed, backupJson) {
  decryptedSeed = seed;
  decryptedBackupJson = backupJson;
  clearCustodyMaterialRegistry();
  registerCustodyMaterial({ seed, backupJson });
}

export function setAutoLockMinutes(minutes) {
  autoLockMinutes = minutes;
}

function scheduleAutoLock(onLock, delayMs = autoLockMinutes * 60 * 1000) {
  if (onLock) autoLockCallback = onLock;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = null;
  if (autoLockLeaseCount > 0) return;
  autoLockTimer = setTimeout(() => {
    if (autoLockLeaseCount > 0) {
      autoLockTimer = null;
      return;
    }
    clearSensitiveMemory();
    autoLockTimer = null;
    const callback = autoLockCallback;
    autoLockCallback = null;
    if (callback) callback();
  }, delayMs);
}

export function resetAutoLock(onLock) {
  scheduleAutoLock(onLock);
}

export function acquireAutoLockLease() {
  autoLockLeaseCount += 1;
  // A bridge proof or Ethereum finality wait can outlive the ordinary idle
  // timeout. Cancel the pending idle timer completely while value is in
  // flight; the final lease release starts a fresh full idle window.
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    autoLockLeaseCount = Math.max(0, autoLockLeaseCount - 1);
    if (autoLockLeaseCount === 0 && autoLockCallback) {
      scheduleAutoLock(autoLockCallback);
    }
  };
}

export function clearAutoLock() {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  autoLockCallback = null;
}

// --- Encryption ---

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function ensureWebCrypto() {
  if (!crypto?.subtle) {
    const isSecure = typeof isSecureContext !== 'undefined' ? isSecureContext
      : (window.location.protocol === 'https:'
        || window.location.hostname === 'localhost'
        || window.location.hostname === '127.0.0.1');
    throw new Error(
      isSecure
        ? 'WebCrypto (crypto.subtle) is unavailable in this browser context.'
        : 'Encrypted vault requires a secure context. Open the wallet over HTTPS, '
          + 'localhost, or 127.0.0.1 — crypto.subtle is disabled on plain HTTP '
          + `at ${window.location.host}.`
    );
  }
}

export async function encryptVault(masterSeedHex, passphrase) {
  ensureWebCrypto();
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(masterSeedHex)
  );

  return {
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptVault(blob, passphrase) {
  ensureWebCrypto();
  if (!blob || !blob.salt || !blob.iv || !blob.ciphertext) {
    throw new Error('Invalid encrypted blob');
  }
  const enc = new TextEncoder();
  const salt = base64ToBytes(blob.salt);
  const iv = base64ToBytes(blob.iv);
  const ciphertext = base64ToBytes(blob.ciphertext);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(plaintext);
  } catch (_e) {
    throw new Error('Incorrect passphrase');
  }
}

// --- IndexedDB ---

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_VAULTS)) {
        db.createObjectStore(STORE_VAULTS, { keyPath: 'accountId' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(storeName, mode, callback) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("Vault transaction aborted")); };
      result = callback(store);
    });
  });
}

function requireAccount(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('Task Node account id required');
}

export async function saveVault(accountId, blob, metadata) {
  requireAccount(accountId);
  await withStore(STORE_VAULTS, 'readwrite', (store) => {
    store.add({
      accountId,
      vault: blob,
      metadata,
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function loadVault(accountId) {
  requireAccount(accountId);
  {
    const record = await withStore(STORE_VAULTS, 'readonly', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.get(accountId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
    if (!record) return null;
    return { blob: record.vault, metadata: record.metadata };
  }
}

export async function removeVault(accountId) {
  requireAccount(accountId);
  await withStore(STORE_VAULTS, 'readwrite', (store) => {
    store.delete(accountId);
  });
  // Also clear settings
  await withStore(STORE_SETTINGS, 'readwrite', (store) => {
    store.delete('settings');
  });
}

export async function saveSettings(settings) {
  await withStore(STORE_SETTINGS, 'readwrite', (store) => {
    store.put({ key: 'settings', ...normalizeSettings(settings) });
  });
}

export async function loadSettings() {
  try {
    const record = await withStore(STORE_SETTINGS, 'readonly', (store) => {
      return new Promise((resolve, reject) => {
        const req = store.get('settings');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    });
    if (!record) return normalizeSettings();
    const { key: _key, ...settings } = record;
    return normalizeSettings(settings);
  } catch (_e) {
    return normalizeSettings();
  }
}

// --- Page unload cleanup ---

export function setupUnloadCleanup() {
  window.addEventListener('beforeunload', () => {
    clearSensitiveMemory();
  });

  // Reset auto-lock on user activity
  ['click', 'keydown', 'touchstart'].forEach(event => {
    window.addEventListener(event, () => {
      if (decryptedSeed) {
        // Re-export resetAutoLock for App to call with callback
        // We just clear and let App re-set it
      }
    });
  });
}
