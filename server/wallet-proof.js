import * as keypairs from "ripple-keypairs";

const textEncoder = new TextEncoder();

export function messageToHex(message) {
  return Array.from(textEncoder.encode(String(message || "")))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function verifyWalletSignature({ message, signature, publicKey, address } = {}) {
  if (!message || !signature || !publicKey || !address) return false;

  try {
    if (keypairs.deriveAddress(publicKey) !== address) return false;
    return keypairs.verify(messageToHex(message), signature, publicKey);
  } catch {
    return false;
  }
}
