// Wallet HTTP contract and the single adapter for the Solana relay service.
import bs58 from 'bs58';
import { buildVaultDeposit, DepositError, readVault, vaultSettings } from './solana-vault.js';

const JOB = /^\/solana\/jobs\/0x[0-9a-f]{64}$/;
export const solanaPath = path => ['/solana/readiness', '/solana/intent', '/solana/jobs'].includes(path) || JOB.test(path);

function b58(value, size) {
  if (typeof value !== 'string' || value.length > 88) return false;
  try { return bs58.decode(value).length === size; } catch { return false; }
}
function validBody(path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort().join(',');
  if (path === '/solana/jobs') return keys === 'signature' && b58(body.signature, 64);
  return keys === 'amount_atoms,owner,pftl_recipient' && b58(body.owner, 32) &&
    typeof body.pftl_recipient === 'string' && /^pf[0-9a-f]{40}$/.test(body.pftl_recipient) &&
    typeof body.amount_atoms === 'string' && /^[1-9][0-9]{0,19}$/.test(body.amount_atoms) && BigInt(body.amount_atoms) < 2n ** 64n;
}

async function upstream(base, path, body, token, origin) {
  const url = new URL(path, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error();
  const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }), ...(origin && { Origin: origin }) },
    ...(body && { body: JSON.stringify(body) }) });
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (token && JSON.stringify(payload).includes(token))) throw Error();
  return { status: response.status, payload };
}

export async function handleSolana({ req, res, json, readJson, fail, suffix, env, bridgeProxyUrl, proxyToken, proxyOrigin, withdrawViaRelay }) {
  const post = suffix === '/solana/intent' || suffix === '/solana/jobs';
  if (!solanaPath(suffix) || req.method !== (post ? 'POST' : 'GET')) return fail(404, 'bridge_route_not_found', 'Unknown bridge endpoint.');
  let body;
  if (post) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { return fail(403, 'bridge_origin_required', 'Same-origin request required.'); }
    if (origin.host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'bridge_origin_mismatch', 'Same-origin request required.');
    try { body = await readJson(req, 4096); } catch { /* reject invalid or oversized JSON */ }
    if (!validBody(suffix, body)) return fail(400, 'invalid_solana_request', 'Invalid Solana deposit request.');
  }
  try {
    let result;
    if (withdrawViaRelay) {
      result = await upstream(bridgeProxyUrl, '/api/l1/bridge' + suffix, body, proxyToken, proxyOrigin);
    } else {
      const service = env.L1_SOLANA_RELAY_URL;
      if (!service) throw new DepositError(503, 'The Solana proof relay is awaiting configuration.');
      const jobService = (path, request) => upstream(service, '/api/bridge/solana' + path, request);
      if (suffix === '/solana/intent' || suffix === '/solana/readiness') {
        const settings = vaultSettings(env);
        const health = await jobService('/readiness');
        if (health.status !== 200 || health.payload.ok !== true || health.payload.ready !== true) {
          throw new DepositError(503, 'The Solana proof relay is unavailable.');
        }
        const ready = await readVault(settings, health.payload);
        result = { status: 200, payload: body ? await buildVaultDeposit(settings, ready, body) : ready };
      } else {
        result = await jobService(suffix.slice('/solana'.length), body);
      }
    }
    json(res, result.status, result.payload);
    return true;
  } catch (error) {
    return fail(error instanceof DepositError ? error.status : 502, 'solana_bridge_unavailable',
      error instanceof DepositError ? error.message : 'The Solana vault or proof relay is unreachable.');
  }
}
