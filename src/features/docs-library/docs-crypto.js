const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createDocsRootKey() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

async function importRootKey(rootKey) {
  return globalThis.crypto.subtle.importKey(
    "raw",
    base64ToBytes(rootKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptDocsMetadata(value, rootKey) {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importRootKey(rootKey),
    encoder.encode(JSON.stringify(value))
  );
  return {
    version: 1,
    enc: "AES-256-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptDocsMetadata(envelope, rootKey) {
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
    await importRootKey(rootKey),
    base64ToBytes(envelope.ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}
