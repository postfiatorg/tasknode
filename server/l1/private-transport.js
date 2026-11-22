import { readFile } from 'node:fs/promises';
import { privatePaths, poolAddress, assetId } from '../../shared/private-payment.js';
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
  'transfer exit requires a confirmed ungoverned policy', 'node cannot admit a transfer at the next height',
  'finalized tip changed; retry request', 'burn quote changed; prepare again', 'another shield reserves this burn sequence',
  'burn fee or pending sequence prevents execution', 'unknown asset', 'transfer inactive on this chain',
  'invalid burn signature', 'signed burn differs from prepared terms',
]);
export async function privatePost(origin, path, body, token, viaRelay = false) {
  const response = await fetch(origin + (viaRelay ? '/private/' : '/') + path, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(viaRelay ? 55000 : 50000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
  // Preserve large u64 balances exactly. Transaction amounts are limited to safe JS integers.
  const value = JSON.parse(raw, (_k, v, ctx) => typeof v === 'number' && !Number.isSafeInteger(v) ? ctx.source : v);
  if (!response.ok) {
    if (response.status === 400 && refusals.has(value?.error)) throw new PrivateError(400, value.error, true);
    if (response.status === 429) throw new PrivateError(429, 'The private prover is busy. Try again shortly.', true);
    throw Error(unavailable);
  }
  return value;
}
function validMap(map) {
  return map && typeof map === 'object' && !Array.isArray(map) && Object.entries(map).every(([asset, amount]) =>
    assetId.test(asset) && ['number', 'string'].includes(typeof amount) && /^\d{1,20}$/.test(String(amount)));
}
function project(path, value) {
  if (path === 'balance' || path === 'address') {
    if (!poolAddress.test(value.address)) throw Error(unavailable);
    if (path === 'address') return { address: value.address };
    if (!validMap(value.balances) || !validMap(value.available)) throw Error(unavailable);
    return { address: value.address, balances: value.balances, available: value.available };
  }
  if (path === 'shield/prepare') {
    if (!/^[a-f0-9]{64}$/.test(value.pending_id) || findCustodyMaterial(value).length) throw Error(unavailable);
    return value;
  }
  if (!assetId.test(value.intent_id) || !['built','accepted','queued','dispatched','pending_unknown','unknown','rejected','abandoned'].includes(value.state)) throw Error(unavailable);
  const result = { intent_id: value.intent_id, state: value.state };
  if (path !== 'receipt') {
    const expected = path === 'shield/finish' ? 'shield' : path;
    if (value.operation !== expected && !(value.operation === 'merge' && ['pay','exit'].includes(path))) throw Error(unavailable);
    result.operation = value.operation;
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
      const result = project(path, await privatePost(url.origin, path, body, token));
      json(res, 200, result);
    } catch (error) {
      json(res, error instanceof PrivateError ? error.status : 503, { error: error instanceof PrivateError ? error.message : unavailable });
    } finally { active--; }
  };
}
