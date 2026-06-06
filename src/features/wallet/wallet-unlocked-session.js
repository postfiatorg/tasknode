const UNLOCKED_SESSION_PREFIX = "tasknode:wallet-unlocked-session:v1:";

function browserSessionStorage() {
  try {
    return typeof globalThis !== "undefined" && globalThis.sessionStorage
      ? globalThis.sessionStorage
      : null;
  } catch {
    return null;
  }
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
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

export function readUnlockedWalletSession({ accountId = "", expectedAddress = "" } = {}) {
  const storage = browserSessionStorage();
  const key = sessionKey(accountId);
  if (!storage || !key) return null;
  try {
    const session = normalizeUnlockedWalletSession(JSON.parse(storage.getItem(key) || "null"));
    if (!session) return null;
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

export function saveUnlockedWalletSession(unlock = {}) {
  const storage = browserSessionStorage();
  const session = normalizeUnlockedWalletSession(unlock);
  const key = sessionKey(session?.accountId);
  if (!storage || !session || !key) return false;
  storage.setItem(key, JSON.stringify(session));
  return true;
}

export function clearUnlockedWalletSession({ accountId = "" } = {}) {
  const storage = browserSessionStorage();
  const key = sessionKey(accountId);
  if (!storage || !key) return false;
  storage.removeItem(key);
  return true;
}
