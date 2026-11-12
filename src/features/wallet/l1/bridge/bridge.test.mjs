import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeController, amountAtoms } from './controller.js';
import * as api from './bridge-relay.js';
import { handleBridgeRoutes } from '../../../../../server/l1/bridge-routes.js';
import { address, owner, memoryStorage, routeReport, readyPayload } from './fixtures.mjs';
function setup(overrides = {}) {
  const sent = [];
  const client = { address, accountId: 'bob', unlocked: true, call: async () => routeReport() };
  const ethereum = { connectMetaMask: async () => owner, ensureEthereumMainnet: async () => {},
    getEvmBalance: async () => owner, getEthereumUsdcBalance: async () => 10000000n,
    getEthereumUsdcAllowance: async () => 10000000n, assertContractCodeHash: async () => {},
    approveEthereumUsdc: async () => sent.push('approve'), depositToEthereumBridge: async () => sent.push('deposit') };
  const service = { ...api, loadBridgeReadiness: async () => readyPayload(), ...overrides };
  return { sent, client, model: new BridgeController(client, { ethereum, service, storage: memoryStorage() }) };
}
test('B7 connect shows the unlocked pf recipient and mainnet USDC balance/allowance', async () => {
  const { model } = setup();
  await model.readiness(); await model.connect();
  assert.equal(model.address, address); assert.equal(model.state.owner, owner);
  assert.equal(model.state.balance, 10000000n); assert.equal(model.state.allowance, 10000000n);
});
test('B10 missing anchor and unreachable readiness prevent ALL sends, even invoked directly', async () => {
  for (const loadBridgeReadiness of [async () => ({ ok: true, ready: false, message: 'No authenticated anchor' }),
    async () => { throw new Error('Offline'); }, async () => ({ ...readyPayload(), beacon_anchor_authenticated: false })]) {
    const { model, sent } = setup({ loadBridgeReadiness });
    await model.connect();
    await assert.rejects(() => model.approve('1'));
    await assert.rejects(() => model.deposit('1'));
    assert.equal(model.state.ready, false); assert.deepEqual(sent, []);
  }
});
test('stale readiness and account switch are rechecked before signing', async () => {
  const { model, client, sent } = setup();
  await model.readiness(); await model.connect();
  model.service.loadBridgeReadiness = async () => { throw new Error('Offline'); };
  await assert.rejects(() => model.approve('1'));
  client.accountId = 'alice';
  await assert.rejects(() => model.deposit('1'));
  assert.deepEqual(sent, []);
});
test('amount input rejects overflow, negative, exponent, zero and precision loss', () => {
  for (const amount of ['0', '-1', '1e6', '1.0000001', '18446744073710']) assert.equal(amountAtoms(amount), null);
  assert.equal(amountAtoms('1.000001'), 1000001n);
});
test('gateway rejects unauthenticated, cross-origin and custody fields; upstream failure is closed', async () => {
  const responses = [];
  const context = { req: { method: 'POST', headers: { host: 'localhost', origin: 'http://localhost' } }, res: { setHeader() {} },
    url: new URL('http://localhost/api/l1/bridge/jobs'), session: null, json: (_res, status, body) => responses.push({ status, body }),
    readJson: async () => ({ seed: 'synthetic' }), proxyUrl: 'http://127.0.0.1:1' };
  await handleBridgeRoutes(context); assert.equal(responses.at(-1).status, 401);
  context.session = { accountId: 'bob' }; context.req.headers.origin = 'http://evil.test';
  await handleBridgeRoutes(context); assert.equal(responses.at(-1).status, 403);
  context.req.headers.origin = 'http://localhost';
  await handleBridgeRoutes(context); assert.equal(responses.at(-1).status, 400);
  context.req.method = 'GET'; context.url.pathname = '/api/l1/bridge/readiness';
  await handleBridgeRoutes(context); assert.equal(responses.at(-1).body.ready, false);
  assert.equal(responses.at(-1).status, 502);
});
