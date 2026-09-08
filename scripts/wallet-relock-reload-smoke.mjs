import assert from "node:assert/strict";

import {
  createUnlockedWalletSessionStore,
  createSessionStorageKeyStore,
} from "../src/features/wallet/wallet-unlocked-session.js";

// Regression: after the vault locks (clearAll — idle expiry or an explicit
// lock) the NEXT unlock must re-persist a fresh AES key so the re-encrypted
// envelope still survives a reload. clearAll() wipes the key from storage; if
// the in-memory key handle is NOT also dropped, the re-unlock re-encrypts with
// a key that no longer exists in storage, and the reload cannot decrypt it —
// forcing a full 24-word seed re-entry. This is the lock -> re-unlock -> reload
// path the existing wallet-unlocked-session smoke never exercised (it only
// reloads from a fresh store, never after a clearAll).

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

const unlock = {
  accountId: "acct_relock_reload",
  address: "rRelockReloadWallet",
  publicKey: "public-key",
  derivationPath: "m/44'/144'/0'/0/0",
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  unlockedAt: "2026-06-06T00:00:00.000Z",
};

// One shared storage represents a single tab's sessionStorage across reloads.
const storage = fakeStorage();

// First unlock generates + persists the key next to the envelope.
const storeA = createUnlockedWalletSessionStore({
  storage,
  keyStore: createSessionStorageKeyStore(storage),
});
assert.equal(await storeA.save(unlock), true);
assert.ok(
  storage.getItem("tasknode:wallet-unlocked-session:aes-key"),
  "first unlock persists the AES key"
);

// The vault locks (what lockWalletVault / idle expiry do): clearAll wipes the
// envelope AND the key from storage.
storeA.clearAll();
assert.equal(storage.raw.size, 0, "clearAll clears the storage");

// Re-unlock on the SAME live store (the user unlocks again without reloading).
assert.equal(await storeA.save(unlock), true);
assert.ok(
  storage.getItem("tasknode:wallet-unlocked-session:aes-key"),
  "re-unlock after lock must re-persist a fresh AES key"
);

// Reload: a fresh store + fresh key store reading the same storage.
const storeB = createUnlockedWalletSessionStore({
  storage,
  keyStore: createSessionStorageKeyStore(storage),
});
assert.deepEqual(
  await storeB.read({ accountId: unlock.accountId, expectedAddress: unlock.address }),
  unlock,
  "unlock survives a reload after a lock + re-unlock (no forced seed re-entry)"
);

console.log("wallet relock reload smoke ok");
