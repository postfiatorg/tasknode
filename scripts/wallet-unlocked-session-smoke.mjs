import assert from "node:assert/strict";

import {
  createUnlockedWalletSessionStore,
  createSessionStorageKeyStore,
  walletUnlockIdleLockMs,
  walletUnlockIdleLockMinutes,
} from "../src/features/wallet/wallet-unlocked-session.js";

function fakeStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    raw: map,
  };
}

function fakeKeyStore() {
  let stored = null;
  return {
    get: async () => stored,
    set: async (key) => {
      stored = key;
    },
  };
}

const unlock = {
  accountId: "acct_session_smoke",
  address: "rSessionWallet",
  publicKey: "public-key",
  derivationPath: "m/44'/144'/0'/0/0",
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  unlockedAt: "2026-06-06T00:00:00.000Z",
};

const IDLE_MS = walletUnlockIdleLockMs();
assert.equal(IDLE_MS, 30 * 60_000);
assert.equal(walletUnlockIdleLockMinutes(), 30);
assert.equal(walletUnlockIdleLockMs("5"), 5 * 60_000);
assert.equal(walletUnlockIdleLockMs("not-a-number"), 30 * 60_000);
assert.equal(walletUnlockIdleLockMs("100000"), 24 * 60 * 60_000);

let nowMs = Date.parse("2026-06-09T00:00:00.000Z");
const storage = fakeStorage();
const store = createUnlockedWalletSessionStore({
  storage,
  keyStore: fakeKeyStore(),
  now: () => nowMs,
});

// Empty store reads null; invalid sessions are rejected.
assert.equal(await store.read({ accountId: unlock.accountId }), null);
assert.equal(await store.save({ ...unlock, mnemonic: "" }), false);

// Round trip.
assert.equal(await store.save(unlock), true);
assert.deepEqual(await store.read({ accountId: unlock.accountId, expectedAddress: unlock.address }), unlock);

// The persisted value is ciphertext: no plaintext mnemonic, address, or words leak.
const storedValues = [...storage.raw.entries()]
  .filter(([key]) => key.includes("wallet-unlocked-session"))
  .map(([, value]) => value)
  .join(" ");
assert.ok(!storedValues.includes("abandon"), "stored value must not contain the mnemonic");
assert.ok(!storedValues.includes(unlock.address), "stored value must not contain the address");
assert.ok(storedValues.includes('"v":2'), "stored value must be a v2 envelope");

// Address mismatch clears the entry.
assert.equal(await store.read({ accountId: unlock.accountId, expectedAddress: "rOtherWallet" }), null);
assert.equal(await store.read({ accountId: unlock.accountId }), null);

// Idle expiry: activity within the window keeps the unlock; beyond it, all entries clear.
assert.equal(await store.save(unlock), true);
nowMs += IDLE_MS - 60_000;
assert.ok(await store.read({ accountId: unlock.accountId }), "still unlocked inside the idle window");
assert.ok(store.idleRemainingMs() > 0);
store.touchActivity();
nowMs += IDLE_MS + 60_000;
assert.equal(store.idleRemainingMs(), 0);
assert.equal(await store.read({ accountId: unlock.accountId }), null, "idle expiry locks the session");
assert.equal(storage.raw.size, 0, "idle expiry clears all session entries");

// Corrupted ciphertext is discarded, not thrown.
assert.equal(await store.save(unlock), true);
const [cipherKey] = [...storage.raw.keys()].filter((key) => key.includes(":v2:"));
storage.setItem(cipherKey, JSON.stringify({ v: 2, iv: "AAAA", ct: "AAAA" }));
assert.equal(await store.read({ accountId: unlock.accountId }), null);
assert.equal(storage.getItem(cipherKey), null);

// Legacy v1 plaintext entries are purged on read and by clearOthers.
storage.setItem(`tasknode:wallet-unlocked-session:v1:${unlock.accountId}`, JSON.stringify(unlock));
assert.equal(await store.read({ accountId: unlock.accountId }), null);
assert.equal(storage.getItem(`tasknode:wallet-unlocked-session:v1:${unlock.accountId}`), null);

// clearOthers keeps only the current account's entry and purges legacy keys.
assert.equal(await store.save(unlock), true);
assert.equal(await store.save({ ...unlock, accountId: "acct_other" }), true);
storage.setItem("tasknode:wallet-unlocked-session:v1:acct_stale", JSON.stringify(unlock));
store.clearOthers({ keepAccountId: unlock.accountId });
assert.ok(await store.read({ accountId: unlock.accountId }), "kept account survives the sweep");
assert.equal(await store.read({ accountId: "acct_other" }), null, "other account entry swept");
assert.equal(storage.getItem("tasknode:wallet-unlocked-session:v1:acct_stale"), null, "legacy entry swept");

// clear() targets one account; clearAll() removes everything including activity.
assert.equal(await store.save({ ...unlock, accountId: "acct_other" }), true);
store.clear({ accountId: "acct_other" });
assert.equal(await store.read({ accountId: "acct_other" }), null);
assert.ok(await store.read({ accountId: unlock.accountId }));
store.clearAll();
assert.equal(await store.read({ accountId: unlock.accountId }), null);
assert.equal(storage.raw.size, 0);

// --- Regression: the unlock must survive a reload (key co-located with envelope) ---
// The AES key now lives in the SAME storage as the encrypted envelope, so a
// fresh store + fresh key store reading that storage (the reload analog) can
// still decrypt. Previously the key lived in IndexedDB while the envelope lived
// in sessionStorage; when IndexedDB was partitioned/evicted on reload (Windows
// Edge Tracking Prevention, Chrome storage partitioning, InPrivate/incognito),
// the key was lost and every reload forced a full seed re-entry.
const reloadStorage = fakeStorage();
const reloadStoreA = createUnlockedWalletSessionStore({
  storage: reloadStorage,
  keyStore: createSessionStorageKeyStore(reloadStorage),
});
assert.equal(await reloadStoreA.save(unlock), true);
assert.ok(
  reloadStorage.getItem("tasknode:wallet-unlocked-session:aes-key"),
  "AES key is co-located in storage with the envelope"
);
// Fresh store + fresh key store, same storage == page reload.
const reloadStoreB = createUnlockedWalletSessionStore({
  storage: reloadStorage,
  keyStore: createSessionStorageKeyStore(reloadStorage),
});
assert.deepEqual(
  await reloadStoreB.read({ accountId: unlock.accountId, expectedAddress: unlock.address }),
  unlock,
  "unlock survives a reload within the idle window"
);
reloadStoreB.clearAll();
assert.equal(
  reloadStorage.getItem("tasknode:wallet-unlocked-session:aes-key"),
  null,
  "clearAll also drops the co-located AES key"
);

// --- Idle auto-lock can be disabled with 0 / "0" (previously 0 fell back to 30) ---
assert.equal(walletUnlockIdleLockMs(0), 0, "0 disables the idle lock");
assert.equal(walletUnlockIdleLockMs("0"), 0, '"0" disables the idle lock');
const idleStorage = fakeStorage();
let idleNow = Date.parse("2026-06-09T00:00:00.000Z");
const idleStore = createUnlockedWalletSessionStore({
  storage: idleStorage,
  keyStore: createSessionStorageKeyStore(idleStorage),
  now: () => idleNow,
});
assert.equal(await idleStore.save(unlock), true);
idleNow += 10 * 24 * 60_000; // far past any idle window
assert.deepEqual(
  await idleStore.read({ accountId: unlock.accountId, expectedAddress: unlock.address, idleLockMs: 0 }),
  unlock,
  "idle disabled (0) keeps the session alive indefinitely"
);
assert.equal(
  await idleStore.read({ accountId: unlock.accountId, idleLockMs: walletUnlockIdleLockMs() }),
  null,
  "default idle window still locks an idle session"
);

// --- A null restored session surfaces as the wallet gate the UI shows ---
const { evaluateTaskSigningUnlockPolicy } = await import("../src/features/tasks/task-request-unlock-policy.js");
const lockedPolicy = evaluateTaskSigningUnlockPolicy({
  accountId: unlock.accountId,
  linkedWalletAddress: unlock.address,
  walletSecret: null,
  walletVault: { available: true, unlocked: true, address: unlock.address },
});
assert.equal(lockedPolicy.allowed, false);
assert.ok(
  ["unlock", "open_wallet"].includes(lockedPolicy.action),
  `locked session offers a wallet action (got ${lockedPolicy.action})`
);

console.log("wallet unlocked session smoke ok");
