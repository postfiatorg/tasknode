import sodium from 'libsodium-wrappers';
import { fromBase64, toBase64 } from './prompt-crypto.mjs';
export async function createPromptDevice() {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return { deviceId: crypto.randomUUID(), publicKey: toBase64(pair.publicKey), privateKey: toBase64(pair.privateKey) };
}
export async function deviceFingerprint(publicKey) {
  const digest = await crypto.subtle.digest('SHA-256', fromBase64(publicKey));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
// Same X25519/XChaCha20 envelope as Docs access grants; only the key is wrapped.
export async function unwrapPromptDevice(envelope, device) {
  await sodium.ready;
  if (envelope?.version !== 1 || envelope.enc !== 'ENC_X25519_XCHACHA20P1305') throw new Error('Invalid device envelope');
  const shard = envelope.recipients.find(row => row.recipient_id === device.fingerprint);
  if (!shard) throw new Error('Device key not present');
  const key = sodium.crypto_box_open_easy(fromBase64(shard.encrypted_file_key), fromBase64(shard.wrap_nonce), fromBase64(shard.ephemeral_pubkey), fromBase64(device.privateKey));
  const text = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromBase64(envelope.ciphertext), null, fromBase64(envelope.nonce), key);
  const payload = JSON.parse(new TextDecoder().decode(text));
  if (payload.deviceId !== device.deviceId || payload.fingerprint !== device.fingerprint || payload.accountId !== device.accountId) throw new Error('Device approval identity mismatch');
  return payload.key;
}
