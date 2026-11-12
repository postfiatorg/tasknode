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

test('B8 reload resumes identical job and displays seven persisted stages', async () => {
  const { stageRows, STAGES } = await import('./stages.js');
  const { jobId, depositTx, asset } = await import('./fixtures.mjs');
  const storage = memoryStorage();
  const { model: original, client } = setup();
  original.storage = storage;
  await original.readiness();
  const pending = { recipient: address, route: original.route, owner, amountAtoms: '1000000', tx: depositTx, jobId };
  original.save(pending); original.dispose();
  const requested = [];
  const job = { job_id: jobId, asset_id: asset, status: 'proving', retryable: true,
    request: { pftl_recipient: address, deposit_tx_hash: depositTx, amount_atoms: '1000000', route_id: 'ethereum-mainnet-usdc-v1', depositor: owner },
    stage_history: STAGES.slice(0, 4).map(([stage], index) => ({ stage, status: index < 3 ? 'complete' : 'running', started_at_unix: 100 + index, completed_at_unix: index < 3 ? 101 + index : null })) };
  const resumed = new BridgeController(client, { storage, service: { loadBridgeJob: async (id) => { requested.push(id); return job; } } });
  await resumed.resume();
  assert.deepEqual(requested, [jobId]);
  const rows = stageRows(resumed.state.job);
  assert.equal(rows.length, 7); assert.equal(rows[0].completed, 101); assert.equal(rows[3].status, 'running'); assert.equal(rows[6].status, 'pending');
  const other = new BridgeController({ ...client, accountId: 'alice' }, { storage });
  assert.equal(other.state.pending, null);
  job.request.pftl_recipient = `pf${'99'.repeat(20)}`;
  await assert.rejects(() => resumed.poll(), /does not match/);
});
test('B9 exact child asset read, zero truth, unavailable/missing/malformed balance stays unverified', async () => {
  const { creditedBalance } = await import('./balance.js');
  const { asset, jobId, depositTx } = await import('./fixtures.mjs');
  const family = 'ff'.repeat(48);
  assert.equal(creditedBalance({ ok: true, result: { assets: [{ asset_id: asset, balance: '0' }] } }, asset).atoms, '0');
  assert.deepEqual(creditedBalance({ ok: true, result: { assets: [
    { asset_id: family, balance: '99000000' }, { asset_id: asset, balance: '2000000' },
  ] } }, asset), { assetId: asset, atoms: '2000000' });
  for (const response of [{ ok: false }, { ok: true, result: { assets: [{ asset_id: family, balance: '999' }] } },
    { ok: true, result: { assets: [{ asset_id: asset, balance: 9007199254740992 }] } }]) assert.throws(() => creditedBalance(response, asset));
  const { model, client } = setup();
  await model.readiness();
  model.save({ route: model.route, recipient: address, owner, amountAtoms: '1000000', tx: depositTx, jobId });
  const job = { status: 'accepted', receipt_code: 'ACCEPTED', receipt_id: 'aa'.repeat(48), job_id: jobId, credited_asset_id: asset, asset_id: model.route.profile.asset_id,
    request: { pftl_recipient: address, deposit_tx_hash: depositTx, amount_atoms: '1000000', route_id: 'ethereum-mainnet-usdc-v1', depositor: owner } };
  model.service.loadBridgeJob = async () => job;
  client.call = async () => { throw new Error('Balance RPC offline'); };
  await assert.rejects(() => model.poll(), /offline/); assert.equal(model.state.result.balancePending, true);
  client.call = async () => ({ ok: true, result: { assets: [{ asset_id: asset, balance: '2000000' }] } });
  await model.poll(); assert.equal(model.state.result.atoms, '2000000'); assert.equal(model.state.result.balancePending, false);
  job.receipt_code = 'REJECTED'; await assert.rejects(() => model.poll(), /accepted receipt/);
  job.receipt_code = 'ACCEPTED'; delete job.credited_asset_id; await assert.rejects(() => model.poll(), /identity is unverified/);
  assert.equal(model.state.result, null);
});
