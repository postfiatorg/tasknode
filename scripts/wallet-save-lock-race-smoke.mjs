import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { newer, setup, synthetic, walletSession } from "./wallet-session-test-fixtures.mjs";

const legacyCase = process.env.RACE_CASE;
const operations = legacyCase
  ? [{ operation: legacyCase === "export" ? "exportKey" : legacyCase }]
  : ["generateKey", "importKey", "exportKey", "encrypt"].map(operation => ({ operation })).concat({ operation: "exportKey", rejectExport: true });
for (const { operation, rejectExport = false } of operations) {
  const test = setup();
  let store = test.store;
  if (operation === "importKey") {
    await store.save(synthetic);
    store = walletSession.createUnlockedWalletSessionStore({ storage: test.storage, cryptoObj: test.cryptoObj });
  }
  const gate = test.arm(operation, { rejectExport });
  const pending = store.save(synthetic);
  await gate.entered;
  store.clearAll();
  assert.equal(test.values.size, 0, `${operation}: lock clears cache synchronously`);
  gate.release();
  assert.equal(await pending, false, `${operation}: pre-lock save is canceled`);
  assert.equal(test.values.size, 0, `${operation}: no late key, envelope or activity write`);
  assert.equal(await test.keyStore.get(), null, `${operation}: failed stale export must not revive a memory key`);
  const lockedReload = walletSession.createUnlockedWalletSessionStore({ storage: test.storage, cryptoObj: webcrypto });
  assert.equal(await lockedReload.read({ accountId: synthetic.accountId }), null);
  assert.equal(await store.save(newer), true);
  const freshReload = walletSession.createUnlockedWalletSessionStore({ storage: test.storage, cryptoObj: webcrypto });
  assert.deepEqual(await freshReload.read({ accountId: synthetic.accountId }), newer);
}
console.log("wallet save lock race smoke ok: key generate/import/export, encryption and intentional later unlock/reload");
