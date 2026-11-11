import assert from "node:assert/strict";
import {
  createPromptDevice,
  deviceFingerprint,
  unwrapPromptDevice,
  pairPromptDevice,
  promptPairingCode,
} from "../packages/tasknode-cli/lib/prompt-device.mjs";
import { newLibraryKey, encryptPrompt, decryptPrompt } from "../packages/tasknode-cli/lib/prompt-crypto.mjs";
import { encryptTaskNodePayload } from "../src/wallet-core.js";
const device = { ...(await createPromptDevice()), accountId: "synthetic-device-smoke" };
device.fingerprint = await deviceFingerprint(device.publicKey);
const key = newLibraryKey();
const root = newLibraryKey();
const wrappedLibrary = await encryptPrompt({ key }, root);
assert.equal((await decryptPrompt(wrappedLibrary, root)).key, key);
await assert.rejects(decryptPrompt(wrappedLibrary, newLibraryKey()));
const envelope = await encryptTaskNodePayload({
  plaintext: JSON.stringify({
    key,
    deviceId: device.deviceId,
    fingerprint: device.fingerprint,
    accountId: device.accountId,
  }),
  recipientPublicKeys: [device.publicKey],
});
await assert.rejects(unwrapPromptDevice(envelope, device), /Finish pairing/);
const paired = await pairPromptDevice(envelope, device, await promptPairingCode(key, device));
assert.equal(await unwrapPromptDevice(envelope, paired), key);
const operatorKey = newLibraryKey();
const substituted = await encryptTaskNodePayload({
  plaintext: JSON.stringify({
    key: operatorKey,
    deviceId: device.deviceId,
    fingerprint: device.fingerprint,
    accountId: device.accountId,
  }),
  recipientPublicKeys: [device.publicKey],
});
await assert.rejects(pairPromptDevice(substituted, device, await promptPairingCode(key, device)), /does not match/);
await assert.rejects(unwrapPromptDevice(substituted, paired), /does not match/);
await assert.rejects(
  pairPromptDevice(substituted, paired, await promptPairingCode(operatorKey, device)),
  /Library key changed/,
);
assert.ok(!JSON.stringify(envelope).includes(key));
await assert.rejects(unwrapPromptDevice(envelope, { ...paired, privateKey: (await createPromptDevice()).privateKey }));
await assert.rejects(unwrapPromptDevice(envelope, { ...paired, accountId: "other" }));
const tampered = structuredClone(envelope);
tampered.ciphertext = (tampered.ciphertext[0] === "A" ? "B" : "A") + tampered.ciphertext.slice(1);
await assert.rejects(unwrapPromptDevice(tampered, paired));
console.log(
  "PASS prompt device wrap: Docs grant envelope, root wrapping, correct device, wrong key/account and tamper rejection",
);
