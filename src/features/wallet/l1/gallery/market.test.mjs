import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOffer, readPool, verifyOffer } from '../market/model.js';
import { verifyTrust } from '../market/offer-setup.js';
import { config, bob, state, lines } from '../market/fixtures.mjs';
import { handleNavcoinRoutes } from '../../../../../server/l1/navcoin-routes.js';

test('peer market reads its own asset without a B23 reserve and binds precision and issuer', async () => {
  const peer = { ...config, symbol: 'A666', market_only: true, route_id: null, alice_holder_address: null };
  const fixture = state(), calls = [];
  const client = { call: async method => {
    calls.push(method);
    if (method === 'nav_reserve_proof_status') return fixture.proof;
    if (method === 'asset_info') return { asset: { asset_id: peer.b23_asset_id, precision: 6, issuer: peer.issuer_address, outstanding_supply: fixture.supply } };
    throw Error('Unexpected reserve access');
  } };
  const read = await readPool(client, peer);
  assert.equal(read.pool, null);
  assert.equal(read.nav.epoch, 2);
  assert.deepEqual(calls, ['nav_reserve_proof_status', 'asset_info']);
  const offer = buildOffer(peer, bob, 'buy', '2', '3', '0', read);
  assert.equal(offer.operation.taker_pays_asset_id, peer.b23_asset_id);
  assert.equal(offer.operation.taker_gets_asset_id, peer.market_quote_asset_id);
  assert.throws(() => buildOffer({ ...config, g1_passed: false }, bob, 'buy', '2', '3', '0', read), /G1/);
  assert.throws(() => buildOffer(peer, peer.issuer_address, 'buy', '2', '3', '0', read), /issuer/);
});
test('peer fills verify exact balances and unchanged supply with no cash-in reserve', () => {
  const peer = { ...config, symbol: 'A666', market_only: true, route_id: null, alice_holder_address: null };
  const intent = buildOffer(peer, bob, 'buy', '2', '3', '0', { pool: null });
  const before = { ...state(), pool: null }, after = structuredClone(before);
  after.balances.assets = lines(102000000, 200000000, 197000000);
  const receipt = { offer_fills: [{ taker: bob, maker_owner: config.alice_holder_address, taker_sends_asset_id: peer.market_quote_asset_id, maker_sends_asset_id: peer.b23_asset_id, taker_sends_amount: 3000000, maker_sends_amount: 2000000 }] };
  assert.equal(verifyOffer(intent, before, after, peer, receipt).received, '2000000');
  after.supply++;
  assert.throws(() => verifyOffer(intent, before, after, peer, receipt), /supply/);
  assert.ok(verifyTrust({ operation: { asset_id: config.b23_asset_id, issuer: config.issuer_address, limit: 1 } }, before, before));
});
test('registry is authenticated, read-only and returns metadata without fabricated financial values', async () => {
  let result;
  const request = { req: { method: 'GET' }, res: { setHeader() {} }, url: new URL('https://example.invalid/api/l1/navcoin/registry'), session: { accountId: 'fixture' }, json: (_res, status, body) => { result = { status, body }; } };
  await handleNavcoinRoutes(request);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.coins.map(c => c.name), ['B23', 'A666']);
  assert.equal(result.body.coins[0].nav_per_unit, undefined);
  assert.equal(result.body.coins[1].route_id, null);
  await handleNavcoinRoutes({ ...request, session: null });
  assert.equal(result.status, 401);
  await handleNavcoinRoutes({ ...request, req: { method: 'POST' } });
  assert.equal(result.status, 405);
});
