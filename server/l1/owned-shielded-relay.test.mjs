import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { ownedShieldedRelay } from './owned-shielded-relay.js';

const genesis = '540f5ffbf795db1b6188e1c475b6818016f21fa5fb37cb1a3de4f8a27a947b19b17e9ead32e9501cf4c234a8f8e2f1f0';
const page = { read: { point: { domain: { genesis_hash: genesis, chain_id: 'postfiat-wan-devnet-2', protocol_version: 1 }, pool_id: 'asset-orchard-v1' } } };
const batch = { batch_id: 'a'.repeat(96), actions: [{ kind: 'asset_orchard_transfer_v1', transfer_json: JSON.stringify({
  version:1, schema:'postfiat-asset-orchard-transfer-action-v1', pool_id:'asset-orchard-v1',
  proof_system_id:'postfiat.privacy.asset-orchard-halo2.v1', circuit_id:'asset_orchard.transfer.v1',
  anchor:'0'.repeat(64),pool_domain:'0'.repeat(64),proof:'0'.repeat(15360),
  ...Object.fromEntries(['entry_binding_hash','exit_binding_hash','action_binding_hash'].map(k => [k,'0'.repeat(128)])),
  ...Object.fromEntries([['nullifiers',64],['randomized_verification_keys',64],['output_commitments',64],['encrypted_outputs',1160],['spend_authorization_signatures',128]].map(([k,n]) => [k,Array(2).fill('0'.repeat(n))])) ,
}) }] };
test('owned routes authenticate via relay, bind the network, and forward original bytes once', async t => {
  const sent = [];
  let snapshot = page;
  const send = async (url, opts) => {
    sent.push({ url, opts });
    return Response.json(url.endsWith('/submit') ? { batch_id: batch.batch_id } : snapshot);
  };
  const json = (r, code, data) => { r.writeHead(code, { 'content-type': 'application/json' }); r.end(JSON.stringify(data)); };
  const routes = ownedShieldedRelay({ TASKNODE_OWNED_SHIELDED_TOKEN: 'f'.repeat(32) }, json, send);
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer test-service') { json(res,401,{}); return; }
    if (!routes(req,res)) json(res,404,{});
  }).listen(0,'127.0.0.1');
  await once(server,'listening'); t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port + '/api/l1/shielded/';
  const headers = { Authorization:'Bearer test-service', 'Content-Type':'application/json' };
  assert.equal((await fetch(url+'outputs?start=0')).status,401);
  assert.equal((await fetch(url+'outputs?start=0&previous=4',{headers})).status,200);
  assert.equal((await fetch(url+'outputs?start=0&start=1',{headers})).status,400);
  const body = JSON.stringify(batch,null,2);
  assert.equal((await fetch(url+'submit',{method:'POST',headers,body})).status,200);
  const submitted = sent.filter(r => r.url.endsWith('/submit'));
  assert.equal(submitted.length,1); assert.equal(submitted[0].opts.body.toString(),body);
  assert.equal(submitted[0].opts.headers.Authorization,'Bearer '+'f'.repeat(32));
  const opened = structuredClone(batch);
  opened.actions[0].transfer_json = JSON.stringify({viewing_key:'synthetic'});
  assert.equal((await fetch(url+'submit',{method:'POST',headers,body:JSON.stringify(opened)})).status,400);
  snapshot = {};
  assert.equal((await fetch(url+'submit',{method:'POST',headers,body})).status,502);
  assert.equal(sent.filter(r => r.url.endsWith('/submit')).length,1);
});
