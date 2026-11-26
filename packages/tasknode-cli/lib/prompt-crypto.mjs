const enc = new TextEncoder();
const dec = new TextDecoder();
export const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export const newLibraryKey = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));
async function aes(key) {
  return crypto.subtle.importKey("raw", fromBase64(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptPrompt(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(key), enc.encode(JSON.stringify(value))),
  );
  // Avoid spreading a full snapshot onto the JS stack.
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { version: 1, enc: "AES-256-GCM", iv: toBase64(iv), ciphertext: btoa(binary) };
}
export async function decryptPrompt(envelope, key) {
  if (envelope?.version !== 1 || envelope.enc !== "AES-256-GCM") throw new Error("Invalid prompt envelope");
  return JSON.parse(
    dec.decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(envelope.iv) },
        await aes(key),
        fromBase64(envelope.ciphertext),
      ),
    ),
  );
}
