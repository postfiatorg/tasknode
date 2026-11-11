import { createHash } from 'node:crypto';
import { query } from '../db/pool.js';
import { promptFailure, promptUuid } from './prompt-history.js';
export async function registerPromptDevice(accountId, sessionId, { deviceId, publicKey, label } = {}) {
  if (!promptUuid(deviceId) || typeof publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey) || Buffer.from(publicKey,'base64').length !== 32 || typeof label !== 'string' || !label.trim() || label.length > 100) return promptFailure('device_invalid');
  const fingerprint = createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('hex');
  const { rows } = await query(`INSERT INTO prompt_devices(device_id,account_id,session_id,public_key,fingerprint,label)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING device_id`, [deviceId,accountId,sessionId,publicKey,fingerprint,label]);
  return rows.length ? {ok:true, deviceId,fingerprint} : promptFailure('device_exists',409);
}
export async function listPromptDevices(accountId) {
  const { rows } = await query(`SELECT device_id AS "deviceId", public_key AS "publicKey", fingerprint, label, approved_at AS "approvedAt", revoked_at AS "revokedAt"
    FROM prompt_devices WHERE account_id=$1 ORDER BY created_at DESC`, [accountId]);
  return {ok:true, devices: rows};
}
function validGrant(envelope, fingerprint) {
  if (!envelope || envelope.version !== 1 || envelope.enc !== 'ENC_X25519_XCHACHA20P1305' || Object.keys(envelope).some(k => !['version','enc','nonce','ciphertext','content_hash','recipients'].includes(k))) return false;
  const bytes = (s, n) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s,'base64').length === n;
  if (!bytes(envelope.nonce,24) || !/^[a-f0-9]{64}$/.test(envelope.content_hash || '') || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext) || Buffer.from(envelope.ciphertext,'base64').length < 16 || envelope.ciphertext.length > 4000 || !Array.isArray(envelope.recipients) || envelope.recipients.length !== 1) return false;
  const shard = envelope.recipients[0];
  return Object.keys(shard).length === 4 && shard.recipient_id === fingerprint && bytes(shard.ephemeral_pubkey,32) && bytes(shard.wrap_nonce,24) && bytes(shard.encrypted_file_key,48);
}
export async function approvePromptDevice(accountId, deviceId, envelope) {
  if (!promptUuid(deviceId)) return promptFailure('device_invalid');
  const { rows } = await query('SELECT fingerprint FROM prompt_devices WHERE device_id=$1 AND account_id=$2 AND approved_at IS NULL AND revoked_at IS NULL',[deviceId,accountId]);
  if (!rows.length || !validGrant(envelope, rows[0].fingerprint)) return promptFailure('device_approval_invalid');
  const result = await query(`UPDATE prompt_devices SET encrypted_key_envelope=$3::jsonb,approved_at=now()
    WHERE device_id=$1 AND account_id=$2 AND approved_at IS NULL AND revoked_at IS NULL RETURNING device_id`,[deviceId,accountId,JSON.stringify(envelope)]);
  return result.rows.length ? {ok:true} : promptFailure('device_approval_conflict',409);
}
export async function revokePromptDevice(accountId,deviceId) {
  if (!promptUuid(deviceId)) return promptFailure('device_invalid');
  await query('UPDATE prompt_devices SET revoked_at=now(),encrypted_key_envelope=NULL WHERE account_id=$1 AND device_id=$2',[accountId,deviceId]);
  return {ok:true};
}
export async function authorizePromptDevice(accountId,sessionId,deviceId) {
  if (!promptUuid(deviceId)) return null;
  const { rows } = await query('SELECT encrypted_key_envelope FROM prompt_devices WHERE account_id=$1 AND session_id=$2 AND device_id=$3 AND approved_at IS NOT NULL AND revoked_at IS NULL',[accountId,sessionId,deviceId]);
  return rows[0]?.encrypted_key_envelope || null;
}
