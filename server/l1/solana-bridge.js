// Wallet HTTP contract and the single adapter for the Solana relay service.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import bs58 from 'bs58';
import { knownRefusal, RELOAD_DEPOSIT } from '../../src/features/wallet/l1/bridge/solana-refusal.js';
import { DEPOSIT_CHECK_VERSION, validLayout } from '../../src/features/wallet/l1/bridge/solana-shape.js';
import { walletBuildId } from '../wallet-build.js';
import { buildVaultDeposit, DepositError, readVault, recoverDeposit, releaseDeposit, sendDeposit, USDC, vaultSettings } from './solana-vault.js';

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
export const solanaPath = path => ['/solana/readiness', '/solana/intent', '/solana/recovery', '/solana/jobs', '/solana/send', '/solana/release'].includes(path) || JOB.test(path);
// The signed-in account that holds a nonce lease. The Task Node server forwards it to the relay host.
const HOLDER = /^[A-Za-z0-9:_@.-]{1,128}$/;

function b58(value, size) {
  if (typeof value !== 'string' || value.length > 88) return false;
  try { return bs58.decode(value).length === size; } catch { return false; }
}
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function validBody(path, body) {
  if (!object(body)) return false;
  const keys = Object.keys(body).sort().join(',');
  const hex32 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  // A layout is a diagnostic: one outside the schema is not logged, and never blocks the release.
  if (path === '/solana/release') return hex32(body.nonce) && (keys === 'nonce' ||
    (['nonce,reason', 'layout,nonce,reason'].includes(keys) && knownRefusal(body.reason)));
  // A durable-nonce deposit also names the nonce account and the value it signed.
  if (path === '/solana/recovery') return ['last_valid_block_height,nonce,vault_program_id', 'before,last_valid_block_height,nonce,vault_program_id']
    .some(base => keys === base || keys === [...base.split(','), 'nonce_account', 'nonce_value'].sort().join(',')) &&
    (!('nonce_account' in body) || (b58(body.nonce_account, 32) && b58(body.nonce_value, 32))) &&
    b58(body.vault_program_id, 32) && (!('before' in body) || b58(body.before, 64)) && typeof body.nonce === 'string' &&
    /^[0-9a-f]{64}$/.test(body.nonce) && Number.isSafeInteger(body.last_valid_block_height) && body.last_valid_block_height > 0;
  if (path === '/solana/jobs') return keys === 'signature' && b58(body.signature, 64);
  if (path === '/solana/send') return keys === 'nonce,transaction_b64' && typeof body.nonce === 'string' && /^[0-9a-f]{64}$/.test(body.nonce) &&
    typeof body.transaction_b64 === 'string' && /^[A-Za-z0-9+/]{88,1644}={0,2}$/.test(body.transaction_b64);
  return keys === 'amount_atoms,owner,pftl_recipient' && b58(body.owner, 32) &&
    typeof body.pftl_recipient === 'string' && /^pf[0-9a-f]{40}$/.test(body.pftl_recipient) &&
    typeof body.amount_atoms === 'string' && /^[1-9][0-9]{0,19}$/.test(body.amount_atoms) && BigInt(body.amount_atoms) < 2n ** 64n;
}

async function upstream(base, path, body, token, origin, holder) {
  const url = new URL(path, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error();
  const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }), ...(origin && { Origin: origin }), ...(holder && { 'X-Tasknode-Account': holder }) },
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

// Deposits are open only while the relay reports ready for the configured vault and verifier.
// It closes them ahead of planned maintenance, so an intent prepared now cannot be broadcast
// into a window where it would not be credited.
function assertOpen(config, settings, { status, payload }) {
  if (status !== 200 || payload.ok !== true || payload.ready !== true) {
    // Its own code: the wallet drops its pending deposit, since nothing reached Solana.
    throw new DepositError(503, 'Solana deposits are closed right now. Nothing was sent; please try again later.', 'solana_deposits_closed');
  }
  // The vault stores the binding written at initialization; the governed route pins the same value.
  if (config.route_binding !== settings.binding || payload.route_id !== ROUTE ||
      payload.ledger !== 'node' || payload.observer_attestor_enabled !== false ||
      payload.source_proof_kind !== 'sp1-solana-alpenglow-finality-v1' || !config.deposit_vkey ||
      payload.program_vkey !== config.deposit_vkey || config.vault_program !== Buffer.from(bs58.decode(settings.program)).toString('hex')) {
    throw new DepositError(503, 'The Solana proof relay does not match the configured vault and verifier.');
  }
}

// Broadcast a signed deposit only while deposits are open: a durable-nonce transaction signed
// earlier stays valid for minutes and must not land after the relay has closed deposits. The
// background re-send loop asks again as it goes and stops once they close.
async function sendWhenOpen(env, body) {
  const { config } = await relayConfig(env);
  const settings = vaultSettings(env);
  const readiness = () => upstream(env.L1_SOLANA_RELAY_URL || 'http://127.0.0.1:8187', '/api/bridge/readiness?route=' + ROUTE);
  assertOpen(config, settings, await readiness());
  const open = async () => { try { assertOpen(config, settings, await readiness()); return true; } catch { return false; } };
  return { status: 200, payload: await sendDeposit(settings, body, { open }) };
}

// The vault program and mint the browser checks, pinned by the Task Node server's own settings.
// The relay host builds the transaction, so its readiness and intent must name exactly these.
function pinned(env) {
  if (!env.L1_SOLANA_VAULT_PROGRAM_ID) throw new DepositError(503, 'The Solana vault is awaiting configuration.');
  return { program: env.L1_SOLANA_VAULT_PROGRAM_ID, mint: env.L1_SOLANA_USDC_MINT || USDC };
}

async function localRoute(env, suffix, body, holder) {
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
  assertOpen(config, settings, health);
  let epoch;
  try { epoch = JSON.parse(await readFile(path(config.state + '/epoch.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; epoch = config.current_epoch; }
  const ready = await readVault(settings, { ready: true, vault_program_id: settings.program, light_client_epoch: epoch });
  // This host co-signs on /send: readiness names the shape check it runs there.
  return { status: 200, payload: body ? await buildVaultDeposit(settings, ready, body, holder) : { ...ready, check_version: DEPOSIT_CHECK_VERSION } };
}

export async function handleSolana({ req, res, json, readJson, fail, suffix, env, session, bridgeProxyUrl, proxyToken, proxyOrigin, withdrawViaRelay }) {
  const post = ['/solana/intent', '/solana/jobs', '/solana/recovery', '/solana/send', '/solana/release'].includes(suffix);
  const forwarded = req.headers?.['x-tasknode-account'];
  const holder = session?.accountId === 'relay-service' ? (HOLDER.test(forwarded || '') ? forwarded : null)
    : session?.accountId ? String(session.accountId).replace(/[^A-Za-z0-9:_@.-]/g, '_').slice(0, 128) : null;
  let body, valid = false;
  // Keep only public, validated tracking fields. Never log raw bodies, transaction bytes, RPC
  // errors, headers, or relay replies. The nonce correlates intent, refusal, send and recovery.
  // layout: the public layout of a refused transaction, from the relay's own decode or a release.
  // reason: a fixed diagnostic of the relay's own, where the message carries outside text.
  // A release's reason and layout come from the caller: logged only when it gave back its own lease.
  function log(status, code, payload, message, layout = undefined, reason = undefined) {
    const step = JOB.test(suffix) ? 'job-status' : suffix.slice(8);
    const released = suffix === '/solana/release' && payload ? payload.released === true : undefined;
    const caller = valid && released ? body : {};
    const nonce = body?.nonce ?? payload?.nonce;
    const signature = body?.signature ?? payload?.signature;
    const job = JOB.test(suffix) ? suffix.split('/').at(-1) : payload?.job_id;
    console.log('solana ' + step + ' ' + JSON.stringify({ status, code,
      nonce: typeof nonce === 'string' && /^[0-9a-f]{64}$/.test(nonce) ? nonce : undefined,
      signature: b58(signature, 64) ? signature : undefined, job: typeof job === 'string' && /^0x[0-9a-f]{64}$/.test(job) ? job : undefined,
      durable: suffix === '/solana/intent' && status === 200 ? Boolean(payload?.nonce_account) : undefined,
      released, reason: reason ?? (knownRefusal(message) ? message : knownRefusal(caller.reason) ? caller.reason : undefined),
      layout: [layout, caller.layout].find(validLayout) }));
  }
  const reject = (status, code, message, layout, reason) => { log(status, code, undefined, message, layout, reason); return fail(status, code, message); };
  if (!solanaPath(suffix)) return fail(404, 'bridge_route_not_found', 'Unknown bridge endpoint.');
  if (req.method !== (post ? 'POST' : 'GET')) return reject(404, 'bridge_route_not_found', 'Unknown bridge endpoint.');
  if (post) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { return reject(403, 'bridge_origin_required', 'Same-origin request required.'); }
    if (origin.host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') return reject(403, 'bridge_origin_mismatch', 'Same-origin request required.');
    try { body = await readJson(req, 4096); } catch { /* reject invalid or oversized JSON */ }
    if (!validBody(suffix, body)) return reject(400, 'invalid_solana_request', 'Invalid Solana deposit request.');
    valid = true;
  }
  try {
    // The authenticated proxy has already checked its own page. Its upstream relay can be
    // installed independently and need not serve that web bundle.
    const pageRequest = session?.accountId !== 'relay-service' && ['/solana/readiness', '/solana/intent'].includes(suffix);
    const build = pageRequest && walletBuildId(env);
    if (pageRequest && req.headers?.['x-tasknode-build'] !== build) return reject(409, 'wallet_reload_required', RELOAD_DEPOSIT);
    let result;
    if (withdrawViaRelay) {
      const pin = ['/solana/readiness', '/solana/intent'].includes(suffix) && pinned(env);
      result = await upstream(bridgeProxyUrl, '/api/l1/bridge' + suffix, body, proxyToken, proxyOrigin, holder);
      if (pin && result.status === 200 && (result.payload.vault_program_id !== pin.program ||
          (suffix === '/solana/readiness' && result.payload.mint !== pin.mint))) {
        throw new DepositError(503, 'The Solana proof relay does not match the configured vault and verifier.');
      }
    } else if (suffix === '/solana/release') {
      result = { status: 200, payload: releaseDeposit(holder, body.nonce) };
    } else if (suffix === '/solana/send') {
      result = await sendWhenOpen(env, body);
    } else if (suffix === '/solana/recovery') {
      result = { status: 200, payload: await recoverDeposit(vaultSettings(env), body) };
    } else {
      result = await localRoute(env, suffix, body, holder);
    }
    if (pageRequest && result.status === 200) result.payload.build_id = build;
    const failure = result.status >= 400 ? 'upstream_failure' : result.payload.status === 'failed' ? 'proof_failed' : undefined;
    if (post || failure) log(result.status, failure, result.payload, result.payload.message);
    json(res, result.status, result.payload);
    return true;
  } catch (error) {
    const known = error instanceof DepositError;
    return reject(known ? error.status : 502, known ? error.code : 'solana_bridge_unavailable',
      known ? error.message : 'The Solana vault or proof relay is unreachable.', known ? error.layout : undefined, known ? error.reason : undefined);
  }
}
