import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { envelopeKey, newer, setup, synthetic, walletSession } from "./wallet-session-test-fixtures.mjs";

for (const replacement of ["lock-and-new-save", "lock", "new-save"]) {
  for (const rejectDecrypt of [true, false]) {
    const test = setup();
    assert.equal(await test.store.save(synthetic), true);
    const gate = test.arm("decrypt", { rejectDecrypt });
    const pending = test.store.read({ accountId: synthetic.accountId });
    await gate.entered;
    if (replacement !== "new-save") test.store.clearAll();
    if (replacement !== "lock") assert.equal(await test.store.save(newer), true);
    const expectedEnvelope = test.storage.getItem(envelopeKey);
    gate.release();
    assert.equal(await pending, null, "old reads never return replaced or locked sessions");
    assert.equal(test.storage.getItem(envelopeKey), expectedEnvelope, "old failures cannot delete new envelopes");
    if (replacement !== "lock") {
      const reloaded = walletSession.createUnlockedWalletSessionStore({ storage: test.storage, cryptoObj: webcrypto });
      assert.deepEqual(await reloaded.read({ accountId: synthetic.accountId }), newer);
    }
  }
}

// A genuinely corrupt current envelope is still removed rather than retained.
{
  const test = setup(); await test.store.save(synthetic);
  const envelope = JSON.parse(test.storage.getItem(envelopeKey));
  const ciphertext = Buffer.from(envelope.ct, "base64"); ciphertext[ciphertext.length - 1] ^= 1;
  test.storage.setItem(envelopeKey, JSON.stringify({ ...envelope, ct: ciphertext.toString("base64") }));
  assert.equal(await test.store.read({ accountId: synthetic.accountId }), null);
  assert.equal(test.storage.getItem(envelopeKey), null);
  assert.equal(await test.store.save(newer), true);
  assert.deepEqual(await test.store.read({ accountId: synthetic.accountId }), newer);
}
console.log("wallet read lock race smoke ok: success/error, explicit lock, replacement, corruption and fresh reload");
