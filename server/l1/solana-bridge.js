// Wallet HTTP contract and the single adapter for the Solana relay service.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import bs58 from 'bs58';
import { buildVaultDeposit, DepositError, readVault, recoverDeposit, sendDeposit, vaultSettings } from './solana-vault.js';

const ROUTE = 'solana-mainnet-usdc-v1';
const STAGES = { finality_seen: 'finality', capture_done: 'capture', witness_built: 'witness', proof_done: 'proof',
  signed: 'sign', submitted: 'submit', credited: 'credit' };

function jobView(job) {
  const request = job.request;
  if (request?.route_id !== ROUTE || request.kind !== 'deposit' || !b58(request.deposit_tx_hash, 64) ||
      job.ledger !== 'node' || job.observer_attestor_enabled !== false || !Array.isArray(job.stage_history)) {
    throw new DepositError(502, 'The proof relay returned a job outside the active deposit route.');
  }
  // Return only public tracking fields. Prefer the fractional timestamps from the worker.
  const history = job.stage_history.map(row => ({ stage: STAGES[row.stage], status: row.status,
    started_at_unix: row.started_at ?? row.started_at_unix, completed_at_unix: row.ended_at ?? row.completed_at_unix }));
  const receipts = (job.receipts || []).map(({ program_id, depositor, nonce, pftl_recipient, amount_atoms }) => {
    if (![program_id, depositor, nonce].every(hex => typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex))) throw Error();
    return { vault_program_id: bs58.encode(Buffer.from(program_id, 'hex')), owner: bs58.encode(Buffer.from(depositor, 'hex')),
      nonce, pftl_recipient, amount_atoms };
  });
  return { ok: true, job_id: job.job_id, signature: request.deposit_tx_hash, status: job.status, retryable: job.retryable === true,
    stage_history: history, updated_at_unix: history.at(-1)?.completed_at_unix ?? job.updated_at_unix,
    receipt_code: job.receipt_code, receipt_id: job.receipt_id, receipts,
    // The Post Fiat transaction that carried the proof: the wallet reads its ledger receipt by this ID.
    ledger_tx_id: typeof job.tx_id === 'string' && /^[0-9a-f]{96}$/.test(job.tx_id) ? job.tx_id : undefined,
    message: job.status === 'failed' ? 'The proof relay could not complete this deposit.' : undefined };
}
const JOB = /^\/solana\/jobs\/0x[0-9a-f]{64}$/;
export const solanaPath = path => ['/solana/readiness', '/solana/intent', '/solana/recovery', '/solana/jobs', '/solana/send'].includes(path) || JOB.test(path);

function b58(value, size) {
  if (typeof value !== 'string' || value.length > 88) return false;
  try { return bs58.decode(value).length === size; } catch { return false; }
}
function validBody(path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort().join(',');
  if (path === '/solana/recovery') return ['last_valid_block_height,nonce,vault_program_id', 'before,last_valid_block_height,nonce,vault_program_id'].includes(keys) &&
    b58(body.vault_program_id, 32) && (!('before' in body) || b58(body.before, 64)) && typeof body.nonce === 'string' &&
    /^[0-9a-f]{64}$/.test(body.nonce) && Number.isSafeInteger(body.last_valid_block_height) && body.last_valid_block_height > 0;
  if (path === '/solana/jobs') return keys === 'signature' && b58(body.signature, 64);
  if (path === '/solana/send') return keys === 'nonce,transaction_b64' && typeof body.nonce === 'string' && /^[0-9a-f]{64}$/.test(body.nonce) &&
    typeof body.transaction_b64 === 'string' && /^[A-Za-z0-9+/]{88,1644}={0,2}$/.test(body.transaction_b64);
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

// sol/relay serves the Ethereum-shaped job API. Its follow command publishes epoch.json
// only after a handoff completes. Before the first handoff it uses the configured anchor.
async function relayConfig(env) {
  if (!env.L1_SOLANA_RELAY_CONFIG) throw new DepositError(503, 'The Solana proof relay is awaiting configuration.');
  const file = env.L1_SOLANA_RELAY_CONFIG;
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (config.ledger !== 'node') throw new DepositError(503, 'Solana deposits require a Post Fiat node relay.');
  return { config, path: name => resolve(dirname(file), name) };
}

async function localRoute(env, suffix, body) {
  const base = env.L1_SOLANA_RELAY_URL || 'http://127.0.0.1:8187';
  const { config, path } = await relayConfig(env);
  const token = body ? (await readFile(path(config.http_token_file), 'utf8')).trim() : '';
  if (body && !token) throw Error();
  if (suffix === '/solana/jobs') {
    const request = { route_id: ROUTE, deposit_tx_hash: body.signature, idempotency_key: body.signature };
    const { status, payload } = await upstream(base, '/api/bridge/jobs', request, token);
    if (status !== 202 || payload.request?.deposit_tx_hash !== body.signature || payload.request?.route_id !== ROUTE ||
        payload.ledger !== 'node' || !/^0x[0-9a-f]{64}$/.test(payload.job_id)) throw new DepositError(502, 'The proof relay could not register this deposit.');
    return { status, payload: { ok: true, job_id: payload.job_id } };
  }
  if (JOB.test(suffix)) {
    const result = await upstream(base, '/api/bridge' + suffix.slice('/solana'.length));
    if (result.status === 200) result.payload = jobView(result.payload);
    return result;
  }
  const settings = vaultSettings(env);
  const [health, session] = await Promise.all([
    upstream(base, '/api/bridge/readiness?route=' + ROUTE),
    body && upstream(base, '/api/bridge/jobs?recipient=' + body.pftl_recipient + '&limit=1', undefined, token),
  ]);
  if (body && (session.status !== 200 || session.payload.ok !== true)) throw new DepositError(503, 'The proof relay cannot register deposits.');
  const { status, payload } = health;
  // The vault stores the binding written at initialization; the governed route pins the same value.
  const binding = config.route_binding;
  if (binding !== settings.binding || status !== 200 || payload.ok !== true || payload.ready !== true || payload.route_id !== ROUTE ||
      payload.ledger !== 'node' || payload.observer_attestor_enabled !== false ||
      payload.source_proof_kind !== 'sp1-solana-alpenglow-finality-v1' || !config.deposit_vkey ||
      payload.program_vkey !== config.deposit_vkey || config.vault_program !== Buffer.from(bs58.decode(settings.program)).toString('hex')) {
    throw new DepositError(503, 'The Solana proof relay does not match the configured vault and verifier.');
  }
  let epoch;
  try { epoch = JSON.parse(await readFile(path(config.state + '/epoch.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; epoch = config.current_epoch; }
  const ready = await readVault(settings, { ready: true, vault_program_id: settings.program, light_client_epoch: epoch });
  return { status: 200, payload: body ? await buildVaultDeposit(settings, ready, body) : ready };
}

export async function handleSolana({ req, res, json, readJson, fail, suffix, env, bridgeProxyUrl, proxyToken, proxyOrigin, withdrawViaRelay }) {
  const post = ['/solana/intent', '/solana/jobs', '/solana/recovery', '/solana/send'].includes(suffix);
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
    } else if (suffix === '/solana/send') {
      result = { status: 200, payload: await sendDeposit(vaultSettings(env), body) };
    } else if (suffix === '/solana/recovery') {
      result = { status: 200, payload: await recoverDeposit(vaultSettings(env), body) };
    } else {
      result = await localRoute(env, suffix, body);
    }
    json(res, result.status, result.payload);
    return true;
  } catch (error) {
    return fail(error instanceof DepositError ? error.status : 502, 'solana_bridge_unavailable',
      error instanceof DepositError ? error.message : 'The Solana vault or proof relay is unreachable.');
  }
}
