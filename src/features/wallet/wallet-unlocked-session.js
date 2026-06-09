const UNLOCKED_SESSION_PREFIX = "tasknode:wallet-unlocked-session:v2:";
const LEGACY_UNLOCKED_SESSION_PREFIXES = ["tasknode:wallet-unlocked-session:v1:"];
const LAST_ACTIVE_KEY = "tasknode:wallet-unlocked-session:last-active";
const SESSION_KEY_DB_NAME = "tasknode-wallet-session-keys";
const SESSION_KEY_DB_VERSION = 1;
const SESSION_KEY_DB_STORE = "keys";
const SESSION_KEY_ID = "aes-gcm-v1";

export const DEFAULT_WALLET_UNLOCK_IDLE_LOCK_MINUTES = 30;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function walletUnlockIdleLockMs(rawMinutes) {
  const configured = rawMinutes !== undefined
    ? rawMinutes
    : globalThis.__TASKNODE_CONFIG__?.walletUnlockIdleLockMinutes;
  const minutes = Number(configured || DEFAULT_WALLET_UNLOCK_IDLE_LOCK_MINUTES);
  const bounded = Number.isFinite(minutes) && minutes > 0
    ? Math.min(Math.max(minutes, 1), 24 * 60)
    : DEFAULT_WALLET_UNLOCK_IDLE_LOCK_MINUTES;
  return Math.round(bounded * 60_000);
}

export function walletUnlockIdleLockMinutes(rawMinutes) {
  return Math.round(walletUnlockIdleLockMs(rawMinutes) / 60_000);
}

function browserSessionStorage() {
  try {
    return typeof globalThis !== "undefined" && globalThis.sessionStorage
      ? globalThis.sessionStorage
      : null;
  } catch {
    return null;
  }
}

function sessionKey(accountId = "") {
  const normalized = safeText(accountId, 180);
  return normalized ? `${UNLOCKED_SESSION_PREFIX}${normalized}` : "";
}

function normalizeUnlockedWalletSession(value = {}) {
  const accountId = safeText(value.accountId, 180);
  const address = safeText(value.address, 120);
  const mnemonic = safeText(value.mnemonic, 400);
  if (!accountId || !address || !mnemonic) return null;
  return {
    accountId,
    address,
    publicKey: safeText(value.publicKey, 180) || null,
    derivationPath: safeText(value.derivationPath, 120) || null,
    mnemonic,
    unlockedAt: safeText(value.unlockedAt, 80) || new Date().toISOString(),
  };
}

function listStorageKeys(storage) {
  const keys = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function isUnlockedSessionKey(key = "") {
  return (
    key.startsWith(UNLOCKED_SESSION_PREFIX) ||
    LEGACY_UNLOCKED_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(text = "") {
  const binary = globalThis.atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function browserIndexedDbKeyStore() {
  const hasIndexedDb = typeof globalThis !== "undefined" && Boolean(globalThis.indexedDB);
  // Without IndexedDB the encryption key cannot outlive this page load, so a
  // reload simply re-prompts for the vault password instead of restoring.
  let memoryKey = null;
  if (!hasIndexedDb) {
    return {
      get: async () => memoryKey,
      set: async (key) => {
        memoryKey = key;
      },
    };
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(SESSION_KEY_DB_NAME, SESSION_KEY_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SESSION_KEY_DB_STORE)) {
          db.createObjectStore(SESSION_KEY_DB_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("INDEXEDDB_OPEN_FAILED"));
      request.onblocked = () => reject(new Error("INDEXEDDB_OPEN_BLOCKED"));
    });
  }

  async function withStore(mode, callback) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_KEY_DB_STORE, mode);
        const store = tx.objectStore(SESSION_KEY_DB_STORE);
        let callbackResult = null;
        tx.oncomplete = () => resolve(callbackResult);
        tx.onerror = () => reject(tx.error || new Error("INDEXEDDB_TRANSACTION_FAILED"));
        tx.onabort = () => reject(tx.error || new Error("INDEXEDDB_TRANSACTION_ABORTED"));
        const request = callback(store);
        if (request) {
          request.onsuccess = () => {
            callbackResult = request.result || null;
          };
        }
      });
    } finally {
      db.close();
    }
  }

  return {
    get: async () => {
      const record = await withStore("readonly", (store) => store.get(SESSION_KEY_ID));
      return record?.key || null;
    },
    set: async (key) => {
      await withStore("readwrite", (store) => store.put({ id: SESSION_KEY_ID, key }));
    },
  };
}

export function createUnlockedWalletSessionStore({
  storage = browserSessionStorage(),
  cryptoObj = globalThis.crypto,
  keyStore = null,
  now = () => Date.now(),
} = {}) {
  const keys = keyStore || browserIndexedDbKeyStore();
  const subtle = cryptoObj?.subtle || null;
  let keyPromise = null;

  async function sessionCryptoKey() {
    if (!subtle) return null;
    if (!keyPromise) {
      keyPromise = (async () => {
        const existing = await keys.get().catch(() => null);
        if (existing) return existing;
        const generated = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]);
        await keys.set(generated).catch(() => null);
        return generated;
      })().catch(() => null);
    }
    return keyPromise;
  }

  function touchActivity() {
    if (!storage) return false;
    try {
      storage.setItem(LAST_ACTIVE_KEY, String(now()));
      return true;
    } catch {
      return false;
    }
  }

  function idleRemainingMs({ idleLockMs = walletUnlockIdleLockMs() } = {}) {
    if (!storage || !(idleLockMs > 0)) return null;
    const lastActive = Number(storage.getItem(LAST_ACTIVE_KEY) || 0);
    if (!Number.isFinite(lastActive) || lastActive <= 0) return null;
    return Math.max(0, idleLockMs - (now() - lastActive));
  }

  function clearAll() {
    if (!storage) return false;
    for (const key of listStorageKeys(storage)) {
      if (isUnlockedSessionKey(key)) storage.removeItem(key);
    }
    storage.removeItem(LAST_ACTIVE_KEY);
    return true;
  }

  function clear({ accountId = "" } = {}) {
    if (!storage) return false;
    const normalized = safeText(accountId, 180);
    if (!normalized) return false;
    storage.removeItem(sessionKey(normalized));
    for (const prefix of LEGACY_UNLOCKED_SESSION_PREFIXES) {
      storage.removeItem(`${prefix}${normalized}`);
    }
    return true;
  }

  function clearOthers({ keepAccountId = "" } = {}) {
    if (!storage) return false;
    const keepKey = sessionKey(keepAccountId);
    for (const key of listStorageKeys(storage)) {
      if (!isUnlockedSessionKey(key)) continue;
      // Legacy v1 entries are plaintext and are always purged.
      if (key !== keepKey) storage.removeItem(key);
    }
    return true;
  }

  async function save(unlock = {}) {
    const session = normalizeUnlockedWalletSession(unlock);
    const key = sessionKey(session?.accountId);
    if (!storage || !session || !key) return false;
    const cryptoKey = await sessionCryptoKey();
    if (!cryptoKey) return false;
    try {
      const iv = cryptoObj.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(JSON.stringify(session));
      const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext);
      storage.setItem(
        key,
        JSON.stringify({ v: 2, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ciphertext)) })
      );
      for (const prefix of LEGACY_UNLOCKED_SESSION_PREFIXES) {
        storage.removeItem(`${prefix}${session.accountId}`);
      }
      touchActivity();
      return true;
    } catch {
      return false;
    }
  }

  async function read({
    accountId = "",
    expectedAddress = "",
    idleLockMs = walletUnlockIdleLockMs(),
  } = {}) {
    const key = sessionKey(accountId);
    if (!storage || !key) return null;
    for (const prefix of LEGACY_UNLOCKED_SESSION_PREFIXES) {
      storage.removeItem(`${prefix}${safeText(accountId, 180)}`);
    }
    const remaining = idleRemainingMs({ idleLockMs });
    if (remaining !== null && remaining <= 0) {
      clearAll();
      return null;
    }
    try {
      const envelope = JSON.parse(storage.getItem(key) || "null");
      if (!envelope || envelope.v !== 2 || !envelope.iv || !envelope.ct) {
        storage.removeItem(key);
        return null;
      }
      const cryptoKey = await sessionCryptoKey();
      if (!cryptoKey) return null;
      const plaintext = await subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
        cryptoKey,
        base64ToBytes(envelope.ct)
      );
      const session = normalizeUnlockedWalletSession(JSON.parse(new TextDecoder().decode(plaintext)));
      if (!session) {
        storage.removeItem(key);
        return null;
      }
      const expected = safeText(expectedAddress, 120);
      if (expected && session.address !== expected) {
        storage.removeItem(key);
        return null;
      }
      return session;
    } catch {
      storage.removeItem(key);
      return null;
    }
  }

  return { save, read, clear, clearOthers, clearAll, touchActivity, idleRemainingMs };
}

let defaultStore = null;

function store() {
  if (!defaultStore) defaultStore = createUnlockedWalletSessionStore();
  return defaultStore;
}

export function saveUnlockedWalletSession(unlock = {}) {
  return store().save(unlock);
}

export function readUnlockedWalletSession(options = {}) {
  return store().read(options);
}

export function clearUnlockedWalletSession(options = {}) {
  return store().clear(options);
}

export function clearOtherUnlockedWalletSessions(options = {}) {
  return store().clearOthers(options);
}

export function clearAllUnlockedWalletSessions() {
  return store().clearAll();
}

export function touchWalletUnlockActivity() {
  return store().touchActivity();
}

export function walletUnlockIdleRemainingMs(options = {}) {
  return store().idleRemainingMs(options);
}
