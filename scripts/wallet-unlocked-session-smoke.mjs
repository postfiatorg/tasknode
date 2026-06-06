import assert from "node:assert/strict";

import {
  clearUnlockedWalletSession,
  readUnlockedWalletSession,
  saveUnlockedWalletSession,
} from "../src/features/wallet/wallet-unlocked-session.js";

const store = new Map();
globalThis.sessionStorage = {
  getItem(key) {
    return store.has(key) ? store.get(key) : null;
  },
  removeItem(key) {
    store.delete(key);
  },
  setItem(key, value) {
    store.set(key, String(value));
  },
};

const unlock = {
  accountId: "acct_session_smoke",
  address: "rSessionWallet",
  publicKey: "public-key",
  derivationPath: "m/44'/144'/0'/0/0",
  mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  unlockedAt: "2026-06-06T00:00:00.000Z",
};

assert.equal(readUnlockedWalletSession({ accountId: unlock.accountId }), null);
assert.equal(saveUnlockedWalletSession({ ...unlock, mnemonic: "" }), false);
assert.equal(saveUnlockedWalletSession(unlock), true);

assert.deepEqual(readUnlockedWalletSession({
  accountId: unlock.accountId,
  expectedAddress: unlock.address,
}), unlock);

assert.equal(readUnlockedWalletSession({
  accountId: unlock.accountId,
  expectedAddress: "rOtherWallet",
}), null);
assert.equal(readUnlockedWalletSession({ accountId: unlock.accountId }), null);

assert.equal(saveUnlockedWalletSession(unlock), true);
assert.equal(clearUnlockedWalletSession({ accountId: unlock.accountId }), true);
assert.equal(readUnlockedWalletSession({ accountId: unlock.accountId }), null);

console.log("wallet unlocked session smoke ok");
