import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import vectors from '../../scripts/private-wallet/funding-vectors.json' with { type: 'json' };
import { fundingDigest } from '../../src/features/wallet/l1/private/shield.js';
import { privateMessage, privateSignatureContext } from '../../shared/private-payment.js';
import { readValidatedJson } from '../request-validation.js';
import { registerL1Gateway } from './gateway.js';
import { createRelayServer } from './relay.js';

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; }
const close = server => new Promise(resolve => server.close(resolve));
const credential = () => randomBytes(32).toString('hex');
test('private routes authenticate both hops, derive the account, scope references, bound requests and survive a prover outage', async () => {
  const bearer = credential(), asset = '1'.repeat(96), recipient = 'pfs1' + '0'.repeat(158);
  const pending = '2'.repeat(64), intent = '3'.repeat(96), seen = [];
  const prover = createServer(async (req, res) => {
    assert.ok(req.headers.authorization === 'Bearer ' + bearer);
    const body = await readValidatedJson(req); seen.push([req.url, body]);
    const unsigned = structuredClone(vectors[0].unsigned_funding);
    Object.assign(unsigned.terms, { owner: body.account, source: body.account, amount: body.amount, asset_id: body.asset });
    const result = { '/address': { address: recipient }, '/balance': { address: recipient, balances: { [asset]: 8 }, available: { [asset]: 6 }, notes: [] },
      '/shield/prepare': { pending_id: pending, unsigned_funding: unsigned,
        signing_digest_hex: req.url === '/shield/prepare' ? Buffer.from(fundingDigest(unsigned)).toString('hex') : '' }, '/shield/finish': { operation: 'shield', state: 'queued', intent_id: intent }, '/pay': { operation: 'pay', state: 'built', intent_id: intent, action_json: 'offline' },
      '/receipt': { state: 'accepted', intent_id: intent } };
    json(res, 200, result[req.url]);
  });
  const proverUrl = await listen(prover);
  const env = { TASKNODE_L1_PRIVATE_PAYMENTS_ENABLED: 'true', L1_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1',
    L1_PRIVATE_PROVER_URL: proverUrl, L1_PRIVATE_PROVER_TOKEN: bearer, L1_RELAY_TOKEN: credential(),
    L1_WALLET_PROXY_URL: 'ws://127.0.0.1:1', L1_WALLET_PROXY_ORIGIN: 'http://127.0.0.1', L1_WALLET_PROXY_TOKEN: credential() };
  const relay = createRelayServer(env, async () => ({}));
  env.L1_RELAY_URL = await listen(relay);
  const server = createServer();
  const gateway = registerL1Gateway(server, { env, cookieValue: req => req.headers.cookie, getSession: async accountId => ({ accountId, authenticated: Boolean(accountId) }), json, readJson: readValidatedJson });
  const origin = await listen(server);
  const call = (path, payload, cookie = 'alice', site = origin) => fetch(origin + '/api/l1/private/' + path, {
    method: 'POST', headers: { cookie, origin: site, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const keys = ml_dsa65.keygen();
  const address = 'pf' + createHash('sha3-384').update('postfiat.address.v1\0').update(keys.publicKey).digest('hex').slice(0,40);
  const signed = (path, body = {}, id = 'alice', pair = keys) => {
    const expires = Date.now() + 60000;
    const signature = ml_dsa65.sign(privateMessage(id, path, body, expires), pair.secretKey, { context: privateSignatureContext });
    return { body, proof: { expires, signature: Buffer.from(signature).toString('hex'), publicKey: Buffer.from(pair.publicKey).toString('hex') } };
  };
  try {
    assert.equal((await call('balance', {}, '')).status, 401);
    assert.equal((await call('balance', {}, 'alice', 'https://foreign.invalid')).status, 403);
    assert.equal((await fetch(env.L1_RELAY_URL + '/private/address', { method: 'POST' })).status, 401);
    env.TASKNODE_L1_PRIVATE_PAYMENTS_ENABLED = 'false';
    assert.equal((await call('balance', {})).status, 404);
    env.TASKNODE_L1_PRIVATE_PAYMENTS_ENABLED = 'true';
    assert.equal((await call('balance', signed('balance'), 'bob')).status, 403);
    assert.equal((await call('balance', signed('address'))).status, 403);
    assert.equal((await call('balance', signed('balance', { wallet_id: address }))).status, 400);
    assert.equal((await call('address', signed('address'))).status, 200);
    assert.deepEqual(seen.at(-1), ['/address', { wallet_id: address }]);
    const balances = await (await call('balance', signed('balance'))).json();
    assert.equal(balances.available[asset], 6); assert.equal(balances.notes, undefined);
    const terms = { asset, amount: 1 };
    const prepared = await (await call('shield/prepare', signed('shield/prepare', terms))).json();
    assert.deepEqual(seen.at(-1)[1], { ...terms, account: address, wallet_id: address });
    const before = seen.length;
    const finish = { pending_id: pending, owner_tag: prepared.owner_tag, funding_authorization: {
      unsigned: prepared.unsigned_funding, algorithm_id: 'ML-DSA-65', public_key_hex: Buffer.from(keys.publicKey).toString('hex'),
      signature_hex: Buffer.from(ml_dsa65.sign(Buffer.from(prepared.signing_digest_hex, 'hex'), keys.secretKey,
        { context: Buffer.from('postfiat-l1-v2/tx/v1') })).toString('hex'),
    } };
    assert.equal((await call('shield/finish', signed('shield/finish', finish, 'bob'), 'bob')).status, 403);
    assert.equal((await call('shield/finish', signed('shield/finish', finish, 'alice', ml_dsa65.keygen()))).status, 403);
    const injected = { ...finish, funding_authorization: { ...finish.funding_authorization, pending_id: '0'.repeat(64) } };
    assert.equal((await call('shield/finish', signed('shield/finish', injected))).status, 400);
    const pay = { ...terms, recipient, request_id: 'p1' };
    for (const invalid of [{ amount: 0 }, { amount: 1.1 }, { asset: 'bad' }, { recipient: address }, { request_id: 'bad/id' }]) {
      assert.equal((await call('pay', signed('pay', { ...pay, ...invalid }))).status, 400);
    }
    assert.equal((await call('pay', { padding: 'x'.repeat(33000) })).status, 413);
    assert.equal(seen.length, before);
    assert.equal((await call('shield/finish', signed('shield/finish', finish))).status, 200);
    assert.deepEqual(seen.at(-1), ['/shield/finish', { pending_id: pending, funding_authorization: finish.funding_authorization }]);
    const action = await (await call('pay', signed('pay', pay))).json();
    assert.equal(action.state, 'built'); assert.equal(action.action_json, undefined);
    const receipt = { intent_id: action.intent_id, owner_tag: action.owner_tag };
    assert.equal((await call('receipt', signed('receipt', receipt, 'bob'), 'bob')).status, 403);
    assert.equal((await call('receipt', signed('receipt', receipt))).status, 200);
    assert.deepEqual(seen.at(-1), ['/receipt', { intent_id: intent }]);
    await close(prover);
    const down = await call('balance', signed('balance')); assert.equal(down.status, 503); assert.match((await down.json()).error, /five minutes/);
    let last;
    for (let n = 0; n < 13; n++) last = await call('pay', {}, 'bob');
    assert.equal(last.status, 429);
  } finally { gateway.close(); await close(server); await close(relay); if (prover.listening) await close(prover); }
});
