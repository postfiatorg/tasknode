import assert from "node:assert/strict";
import {
  createPromptDevice,
  deviceFingerprint,
  unwrapPromptDevice,
  pairPromptDevice,
  promptPairingCode,
} from "../packages/tasknode-cli/lib/prompt-device.mjs";
import {
  newLibraryKey,
  encryptPrompt,
  decryptPrompt,
} from "../packages/tasknode-cli/lib/prompt-crypto.mjs";
import { encryptTaskNodePayload } from "../src/wallet-core.js";
const device = {
  ...(await createPromptDevice()),
  accountId: "synthetic-device-smoke",
};
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
const paired = await pairPromptDevice(
  envelope,
  device,
  await promptPairingCode(key, device),
);
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
await assert.rejects(
  pairPromptDevice(substituted, device, await promptPairingCode(key, device)),
  /does not match/,
);
await assert.rejects(unwrapPromptDevice(substituted, paired), /does not match/);
await assert.rejects(
  pairPromptDevice(
    substituted,
    paired,
    await promptPairingCode(operatorKey, device),
  ),
  /Library key changed/,
);
assert.ok(!JSON.stringify(envelope).includes(key));
await assert.rejects(
  unwrapPromptDevice(envelope, {
    ...paired,
    privateKey: (await createPromptDevice()).privateKey,
  }),
);
await assert.rejects(
  unwrapPromptDevice(envelope, { ...paired, accountId: "other" }),
);
const tampered = structuredClone(envelope);
tampered.ciphertext =
  (tampered.ciphertext[0] === "A" ? "B" : "A") + tampered.ciphertext.slice(1);
await assert.rejects(unwrapPromptDevice(tampered, paired));
console.log(
  "PASS prompt device wrap: Docs grant envelope, root wrapping, correct device, wrong key/account and tamper rejection",
);

// One-click link pairing: the browser proves it holds the secret from the sign-in link's fragment.
{
  const {
    autoPairPromptDevice,
    pairingFragment,
    parsePairingFragment,
    pairingMac,
  } = await import("../packages/tasknode-cli/lib/prompt-device.mjs");
  const linked = {
    ...(await createPromptDevice()),
    accountId: "synthetic-link-smoke",
  };
  linked.fingerprint = await deviceFingerprint(linked.publicKey);
  const parsed = parsePairingFragment(`#${pairingFragment(linked)}`);
  assert.equal(parsed.publicKey, linked.publicKey);
  assert.equal(parsed.secret, linked.pairSecret);
  assert.equal(parsePairingFragment("#docs"), null);
  const wrap = async (libraryKey, mac) =>
    encryptTaskNodePayload({
      plaintext: JSON.stringify({
        key: libraryKey,
        deviceId: linked.deviceId,
        fingerprint: linked.fingerprint,
        accountId: linked.accountId,
        ...(mac ? { mac } : {}),
      }),
      recipientPublicKeys: [parsed.publicKey],
    });
  const code = await promptPairingCode(key, linked);
  const good = await wrap(key, await pairingMac(parsed.secret, code));
  const autoPaired = await autoPairPromptDevice(good, linked);
  assert.equal(await unwrapPromptDevice(good, autoPaired), key);
  // A relay that swaps in its own library key cannot produce the proof without the link secret.
  const relayKey = newLibraryKey();
  const relayCode = await promptPairingCode(relayKey, linked);
  await assert.rejects(
    autoPairPromptDevice(await wrap(relayKey), linked),
    /sign-in link/,
  );
  await assert.rejects(
    autoPairPromptDevice(
      await wrap(
        relayKey,
        await pairingMac(
          linked.pairSecret.split("").reverse().join(""),
          relayCode,
        ),
      ),
      linked,
    ),
    /sign-in link/,
  );
  await assert.rejects(
    autoPairPromptDevice(
      await wrap(relayKey, await pairingMac(parsed.secret, code)),
      linked,
    ),
    /sign-in link/,
  );
  // A device enrolled without a link secret never auto-pairs.
  const { pairSecret: _pairSecret, ...manual } = linked;
  await assert.rejects(
    autoPairPromptDevice(good, manual),
    /no pairing link secret/,
  );
  console.log(
    "prompt link pairing smoke ok: fragment round trip, auto-pair, substituted key and forged proof rejected",
  );
}
