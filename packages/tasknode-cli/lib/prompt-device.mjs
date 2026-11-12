import sodium from "libsodium-wrappers";
import { fromBase64, toBase64 } from "./prompt-crypto.mjs";
export async function createPromptDevice() {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return {
    deviceId: crypto.randomUUID(),
    publicKey: toBase64(pair.publicKey),
    privateKey: toBase64(pair.privateKey),
    pairSecret: toUrl(toBase64(crypto.getRandomValues(new Uint8Array(16)))),
  };
}

const toUrl = (text) =>
  text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrl = (text) =>
  text.replace(/-/g, "+").replace(/_/g, "/") +
  "=".repeat((4 - (text.length % 4)) % 4);

// One-click pairing. The sign-in link carries the device public key and a one-time secret in its fragment, which
// browsers never send to a server. The browser wraps the library key to that key and proves it holds the secret.
export function pairingFragment(device) {
  return `p=${toUrl(device.publicKey)}.${device.pairSecret}`;
}
export function parsePairingFragment(hash) {
  const match =
    /(?:^|[#&])p=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})(?:&|$)/.exec(
      String(hash || ""),
    );
  return match ? { publicKey: fromUrl(match[1]), secret: match[2] } : null;
}
export async function pairingMac(secret, code) {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(fromUrl(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`tasknode.prompt.link-pairing.v1:${code}`),
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function deviceFingerprint(publicKey) {
  const digest = await crypto.subtle.digest("SHA-256", fromBase64(publicKey));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
// Same X25519/XChaCha20 envelope as Docs access grants; only the key is wrapped.
async function unwrapCandidate(envelope, device) {
  await sodium.ready;
  if (envelope?.version !== 1 || envelope.enc !== "ENC_X25519_XCHACHA20P1305")
    throw new Error("Invalid device envelope");
  const shard = envelope.recipients.find(
    (row) => row.recipient_id === device.fingerprint,
  );
  if (!shard) throw new Error("Device key not present");
  const key = sodium.crypto_box_open_easy(
    fromBase64(shard.encrypted_file_key),
    fromBase64(shard.wrap_nonce),
    fromBase64(shard.ephemeral_pubkey),
    fromBase64(device.privateKey),
  );
  const text = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromBase64(envelope.ciphertext),
    null,
    fromBase64(envelope.nonce),
    key,
  );
  const payload = JSON.parse(new TextDecoder().decode(text));
  if (
    payload.deviceId !== device.deviceId ||
    payload.fingerprint !== device.fingerprint ||
    payload.accountId !== device.accountId
  )
    throw new Error("Device approval identity mismatch");
  return payload;
}

// Compare this commitment out of band from the unlocked browser to the local
// agent. Public enrollment fields alone cannot authenticate a relay envelope.
export async function promptPairingCode(key, device) {
  const binding = JSON.stringify([
    "tasknode.prompt.pairing.v1",
    device.accountId,
    device.deviceId,
    device.publicKey,
    key,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(binding),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function pairPromptDevice(envelope, device, browserCode) {
  const { key } = await unwrapCandidate(envelope, device);
  const commitment = await promptPairingCode(key, device);
  if (!/^[a-f0-9]{64}$/.test(browserCode) || commitment !== browserCode) {
    throw new Error("Pairing code does not match the unlocked browser");
  }
  if (device.keyCommitment && device.keyCommitment !== commitment) {
    throw new Error("Library key changed; enroll a new device to pair again");
  }
  return { ...device, keyCommitment: commitment };
}

export async function unwrapPromptDevice(envelope, device) {
  if (!device.keyCommitment)
    throw new Error(
      "Finish pairing with the code from unlocked Docs before using prompt tools",
    );
  const { key } = await unwrapCandidate(envelope, device);
  if ((await promptPairingCode(key, device)) !== device.keyCommitment) {
    throw new Error("Prompt library key does not match the paired browser");
  }
  return key;
}

// Pair without a pasted code: accept the wrapped key only if the browser proved it holds this device's link secret.
export async function autoPairPromptDevice(envelope, device) {
  if (!device.pairSecret)
    throw new Error("This device has no pairing link secret");
  const payload = await unwrapCandidate(envelope, device);
  const code = await promptPairingCode(payload.key, device);
  if (
    typeof payload.mac !== "string" ||
    payload.mac !== (await pairingMac(device.pairSecret, code))
  ) {
    throw new Error("Approval was not made from this device's sign-in link");
  }
  return pairPromptDevice(envelope, device, code);
}
