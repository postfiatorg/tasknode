import { readFile } from 'node:fs/promises';
import { exactFields, lowerHex, validFunding, validFundingAuthorization } from '../../shared/private-funding.js';
import { privatePaths, poolAddress, assetId, isU64, operationStates, refusalMessage, missingDraft, restoreMessage } from '../../shared/private-payment.js';
import { findCustodyMaterial } from '../../src/features/wallet/l1/lib/custody-boundary.js';
import { privatePaymentsEnabled } from './release-config.js';

export const unavailable = 'The private prover is unavailable. After a restart it takes about five minutes to get ready.';
export class PrivateError extends Error {
  constructor(status, message, unchanged = false) {
    super(message);
    this.status = status;
    this.unchanged = unchanged;
  }
}
const refusals = new Set([
  'insufficient available private balance', 'insufficient spendable public asset balance', 'invalid shielded recipient',
  'cannot exit to asset issuer', 'destination account does not exist', 'destination cannot receive asset',
  'public transfer edge requires a confirmed ungoverned policy', 'node cannot admit a transfer at the next height',
  'finalized tip changed; retry request', 'funding quote changed; prepare again', 'another shield reserves this funding sequence',
  'burn fee or pending sequence prevents execution', 'unknown asset', 'transfer inactive on this chain',
  'invalid funding signature', 'signed funding authorization differs from prepared terms',
  'this prepare predates transfer funding authorizations; prepare again',
]);
const cancellationUnknown = 'Delivery may already have started. Check the original transfer for settlement.';
export async function privatePost(origin, path, body, token, viaRelay = false) {
  const timeout = ['address', 'balance', 'receipt'].includes(path) ? 15000 : 50000;
  const response = await fetch(origin + (viaRelay ? '/private/' : '/') + path, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout + (viaRelay ? 5000 : 0)),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body, (key, v) => !viaRelay && ['amount','fee','sequence'].includes(key) && typeof v === 'string' && isU64(v) ? JSON.rawJSON(v) : v),
  });
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > (path === 'balance' ? 12 * 1024 * 1024 : 1024 * 1024)) throw Error(unavailable);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  if (raw.includes(token)) throw Error(unavailable);
  // Preserve exact integer tokens when crossing the daemon boundary.
  const value = JSON.parse(raw, (_k, v, ctx) => typeof v === 'number' && !Number.isSafeInteger(v) ? ctx.source : v);
  if (!response.ok) {
    const message = value?.error;
    if (message === restoreMessage || message === 'known wallet is missing its seed; restore the original seed file' ||
        message === 'seed does not match registered wallet' || (!viaRelay && ['address','balance'].includes(path) && response.status === 404 && message?.startsWith('No such file or directory'))) {
      throw new PrivateError(400, restoreMessage, true);
    }
    const policy = typeof message === 'string' && refusalMessage(message.match(/\basset_orchard_[a-z_]+\b/)?.[0] || message);
    if (policy) throw new PrivateError(400, policy, true);
    if (path === 'abandon' && body.pending_id && response.status === 400 && [missingDraft, 'unknown shield draft'].includes(message)) {
      throw new PrivateError(400, missingDraft, true);
    }
    if (message === 'operation may be in admission; retry the original request to reconcile' || message === cancellationUnknown) throw new PrivateError(400, cancellationUnknown);
    if (response.status === 400 && refusals.has(message)) throw new PrivateError(400, value.error, true);
    if (response.status === 429) throw new PrivateError(429, 'The private prover is busy. Try again shortly.', true);
    throw Error(unavailable);
  }
  return value;
}
function validMap(map) {
  return map && typeof map === 'object' && !Array.isArray(map) && Object.entries(map).every(([asset, amount]) =>
    assetId.test(asset) && isU64(amount));
}
function project(path, value, body) {
  if (['balance','address','wallet/create'].includes(path)) {
    if (!poolAddress.test(value.address)) throw Error(unavailable);
    if (path !== 'balance') return { address: value.address };
    if (!validMap(value.balances) || !validMap(value.available) ||
        Object.entries(value.available).some(([id, amount]) => BigInt(amount) > BigInt(value.balances[id] ?? 0))) throw Error(unavailable);
    const s = value.snapshot;
    if (!Number.isSafeInteger(s?.height) || s.height < 0 || typeof s.chain_id !== 'string' ||
        !lowerHex(s.genesis_hash, 96) || typeof value.privacy_label !== 'string' || value.privacy_label.length > 128) throw Error(unavailable);
    return { address: value.address, balances: value.balances, available: value.available, privacy_label: value.privacy_label,
      snapshot: { chain_id: s.chain_id, genesis_hash: s.genesis_hash, height: s.height, block_hash: s.block_hash, state_root: s.state_root, pool_root: s.pool_root } };
  }
  if (path === 'shield/prepare') {
    if (!exactFields(value, ['pending_id', 'private_address', 'unsigned_funding', 'signing_digest_hex']) || !lowerHex(value.pending_id, 64) ||
        !poolAddress.test(value.private_address) || !lowerHex(value.signing_digest_hex, 96) || !validFunding(value.unsigned_funding)) throw Error(unavailable);
    const { source, amount, asset_id } = value.unsigned_funding.terms;
    if (source !== body.account || String(amount) !== String(body.amount) || asset_id !== body.asset) throw Error(unavailable);
    return value;
  }
  if (path === 'abandon') {
    const key = value.pending_id ? 'pending_id' : 'intent_id';
    if (value.state !== 'abandoned' || typeof value.exported_action_may_still_settle !== 'boolean' ||
        !lowerHex(value[key], key === 'pending_id' ? 64 : 96) ||
        (key === 'pending_id' && value[key] !== body.pending_id) || (body.intent_id && value.intent_id !== body.intent_id)) throw Error(unavailable);
    return { [key]: value[key], state: value.state, exported_action_may_still_settle: value.exported_action_may_still_settle };
  }
  if (!lowerHex(value.intent_id, 96) || !operationStates.has(value.state)) throw Error(unavailable);
  const result = { intent_id: value.intent_id, state: value.state };
  if (path === 'receipt') {
    const c = value.contract_receipt;
    if (value.intent_id !== body.intent_id || (c && (c.intent_id !== body.intent_id || c.state !== value.state))) throw Error(unavailable);
    result.contract_receipt = c ? Object.fromEntries(['schema','intent_id','state','action_hash','batch_id','transaction_id',
      'inclusion_height','block_hash','state_root','accepted','code','fee','finality'].map(k => [k, c[k]])) : null;
  } else {
    const expected = path === 'shield/finish' ? 'shield' : path;
    if (value.operation !== expected && !(value.operation === 'merge' && ['pay','exit'].includes(path))) throw Error(unavailable);
    result.operation = value.operation;
    if (typeof value.action_json === 'string') result.action_json = value.action_json;
    if (typeof value.code === 'string' && /^[a-z0-9_]{1,96}$/.test(value.code)) result.code = value.code;
    if (value.admission === 'not_reserved') result.admission = value.admission;
  }
  return result;
}

// Lives only on the authenticated relay. No configurable URL may leave loopback.
export function privateRelayHandler(env) {
  let active = 0;
  return async (path, req, res, readJson, json) => {
    if (!privatePaymentsEnabled(env) || !privatePaths.has(path) || req.method !== 'POST') return json(res, 404, { error: 'unavailable' });
    if (active >= 4) return json(res, 429, { error: 'busy' });
    active++;
    try {
      const url = new URL(env.L1_PRIVATE_PROVER_URL || 'http://127.0.0.1:8786');
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.href !== url.origin + '/') throw Error(unavailable);
      const token = env.L1_PRIVATE_PROVER_TOKEN_FILE ? (await readFile(env.L1_PRIVATE_PROVER_TOKEN_FILE, 'utf8')).trimEnd() : env.L1_PRIVATE_PROVER_TOKEN;
      if (typeof token !== 'string' || !/^[!-~]{32,256}$/.test(token)) throw Error(unavailable);
      const body = await readJson(req, 32768);
      if (findCustodyMaterial(body).length) return json(res, 400, { error: 'invalid request' });
      if (path === 'shield/finish' && (!exactFields(body, ['pending_id', 'funding_authorization']) ||
          !lowerHex(body.pending_id, 64) || !validFundingAuthorization(body.funding_authorization))) {
        return json(res, 400, { error: 'invalid request' });
      }
      const result = project(path, await privatePost(url.origin, path, body, token), body);
      json(res, 200, result);
    } catch (error) {
      json(res, error instanceof PrivateError ? error.status : 503, { error: error instanceof PrivateError ? error.message : unavailable });
    } finally { active--; }
  };
}
