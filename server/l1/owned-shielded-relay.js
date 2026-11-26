// Transport for the owned six-validator Mac acceptance network.
import { findCustodyMaterial } from '../../src/features/wallet/l1/lib/custody-boundary.js';

const ownedGenesis = '540f5ffbf795db1b6188e1c475b6818016f21fa5fb37cb1a3de4f8a27a947b19b17e9ead32e9501cf4c234a8f8e2f1f0';
const prefix = '/api/l1/shielded/';
const coordinator = 'http://127.0.0.1:32761';
const digest = /^[0-9a-f]{96}$/;

function owned(page) {
  const point = page?.read?.point;
  return point?.domain?.chain_id === 'postfiat-wan-devnet-2'
    && point.domain.genesis_hash === ownedGenesis && point.domain.protocol_version === 1
    && point.pool_id === 'asset-orchard-v1';
}
async function readPublicResponse(response) {
  if (!response.ok) throw Error('Upstream unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw Error('Oversized response');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString());
  if (findCustodyMaterial(result).length) throw Error('Unsafe response');
  return result;
}
function finished(batch) {
  if (!digest.test(batch?.batch_id) || Object.keys(batch).sort().join() !== 'actions,batch_id'
      || !Array.isArray(batch.actions) || batch.actions.length !== 1 || findCustodyMaterial(batch).length) return false;
  const action = batch.actions[0];
  if (action?.kind !== 'asset_orchard_transfer_v1' || typeof action.transfer_json !== 'string'
      || !['kind,transfer_json','burn_transaction,kind,transfer_json'].includes(Object.keys(action).sort().join())) return false;
  const transfer = JSON.parse(action.transfer_json);
  const keys = ['version','schema','pool_id','proof_system_id','circuit_id','pool_domain','anchor','nullifiers',
    'randomized_verification_keys','output_commitments','encrypted_outputs','entry_binding_hash','exit_binding_hash',
    'action_binding_hash','proof','spend_authorization_signatures'];
  if (transfer.entry) keys.push('entry');
  if (transfer.exit) keys.push('exit');
  const only = (object, expected) => object && Object.keys(object).sort().join() === expected.sort().join();
  const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
  const pair = (v,n) => Array.isArray(v) && v.length === 2 && v.every(item => hex(item,n));
  if (!only(transfer, keys) || Boolean(transfer.entry) !== Boolean(action.burn_transaction) || (transfer.entry && transfer.exit)) return false;
  if (transfer.entry && (!only(transfer.entry,['from','asset_id','amount','burn_transaction_id']) ||
      !only(action.burn_transaction,['unsigned','algorithm_id','public_key_hex','signature_hex']) ||
      !only(action.burn_transaction.unsigned,['chain_id','genesis_hash','protocol_version','address_namespace','transaction_kind',
        'signature_algorithm_id','source','fee','sequence','operation','owner','issuer','asset_id','amount']) ||
      action.burn_transaction.unsigned.genesis_hash !== ownedGenesis || action.burn_transaction.unsigned.operation !== 'asset_burn')) return false;
  if (transfer.exit && !only(transfer.exit,['to','amount','asset_id'])) return false;
  if (transfer.version !== 1 || transfer.schema !== 'postfiat-asset-orchard-transfer-action-v1' ||
      transfer.proof_system_id !== 'postfiat.privacy.asset-orchard-halo2.v1' || transfer.circuit_id !== 'asset_orchard.transfer.v1' ||
      ![transfer.pool_domain,transfer.anchor].every(v => hex(v,64)) || ![transfer.entry_binding_hash,transfer.exit_binding_hash,transfer.action_binding_hash].every(v => hex(v,128)) ||
      ![transfer.nullifiers,transfer.randomized_verification_keys,transfer.output_commitments].every(v => pair(v,64)) ||
      !pair(transfer.encrypted_outputs,1160) || !pair(transfer.spend_authorization_signatures,128) || !hex(transfer.proof,15360)) return false;
  return transfer.pool_id === 'asset-orchard-v1';
}

export function ownedShieldedRelay(env, json, transport = fetch) {
  let active = 0;
  let submissions = [];
  const token = env.TASKNODE_OWNED_SHIELDED_TOKEN;
  return function handle(req, res) {
    if (!req.url.startsWith(prefix)) return false;
    if (!token || token.length < 32) { json(res, 503, { error: 'shielded_network_unavailable' }); return true; }
    if (active >= 2) { json(res, 429, { error: 'shielded_relay_busy' }); return true; }
    active++;
    void (async () => {
      const url = new URL(req.url, 'http://localhost');
      const options = { redirect: 'error', signal: AbortSignal.timeout(120000) };
      if (url.pathname === prefix + 'outputs' && req.method === 'GET') {
        const params = url.searchParams;
        if (!params.has('start') || [...params].some(([k,v]) => !['start','previous'].includes(k)
          || params.getAll(k).length !== 1 || !/^(0|[1-9][0-9]{0,15})$/.test(v))) {
          json(res, 400, { error: 'invalid_pool_cursor' }); return;
        }
        const page = await readPublicResponse(await transport(coordinator + '/pool?' + params, options));
        if (!owned(page)) throw Error('Unexpected network');
        json(res, 200, page); return;
      }
      if (req.url !== prefix + 'submit' || req.method !== 'POST') { json(res, 404, { error: 'shielded_route_not_found' }); return; }
      if (req.headers['content-type'] !== 'application/json') { json(res, 415, { error: 'json_required' }); return; }
      let batch, bytes;
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1048576) throw Error('Oversized action');
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
        batch = JSON.parse(bytes.toString());
        if (!finished(batch)) throw Error('Invalid action');
      } catch { json(res, 400, { error: 'invalid_finished_action' }); return; }
      const now = Date.now();
      submissions = submissions.filter(t => now - t < 60000);
      if (submissions.length >= 10) { json(res, 429, { error: 'shielded_submission_limit' }); return; }
      submissions.push(now);
      const check = await readPublicResponse(await transport(coordinator + '/pool?start=0', options));
      if (!owned(check)) throw Error('Unexpected network');
      const result = await readPublicResponse(await transport(coordinator + '/submit', {
        ...options, method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: bytes,
      }));
      if (result?.batch_id !== batch.batch_id) throw Error('Uncertain submission');
      json(res, 200, { batch_id: batch.batch_id });
    })().catch(() => { if (!res.headersSent) json(res, 502, { error: 'shielded_outcome_unavailable' }); else res.destroy(); })
      .finally(() => { active--; });
    return true;
  };
}
