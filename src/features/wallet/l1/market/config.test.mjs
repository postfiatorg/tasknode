import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLISHED_CONFIG, validateConfig, deploymentConfig, assetSymbols, marketReady } from './constants.js';
import { navcoinRegistry } from '../../../../../server/l1/navcoin-registry.js';
import { projectHistory } from '../../../../../server/l1/history.js';
import { heldNavValues, sortByTvl } from '../gallery/model.js';
import { buildOffer, readPool } from './model.js';
import { buildRedeem } from '../redeem/model.js';
const b24 = '5'.repeat(96), owner = 'pf' + '4'.repeat(40);
const config = validateConfig({ ...PUBLISHED_CONFIG, nav_asset_id: b24, symbol: 'B24', slug: 'b24', route_id: 'b24-route',
  g1_passed: true, redemption_mode: 'unsupported', issue_multiplier_bps: 10050, redeem_multiplier_bps: 9995,
  retired_assets: [{ asset_id: PUBLISHED_CONFIG.b23_asset_id, symbol: 'B23', slug: 'b23', route_id: PUBLISHED_CONFIG.route_id }],
});
test('one config switches identity, orders, fees and registry while preserving retired B23', async () => {
  assert.equal(config.b23_asset_id, b24);
  assert.equal(config.nav_asset_id, b24);
  assert.equal(config.issue_multiplier_bps, 10050);
  assert.equal(config.redeem_multiplier_bps, 9995);
  assert.deepEqual(navcoinRegistry(config).map(c => [c.name, Boolean(c.retired)]), [['B24', false], ['B23', true], ['A666', false]]);
  const seen = [];
  await readPool({ call: async (method, args) => {
    seen.push([method, args]);
    if (method === 'navcoin_bridge_supply_status') return { route_id: config.route_id, native_nav_asset_id: b24, settlement_asset_id: config.pfusdc_asset_id };
    if (method === 'nav_reserve_proof_status') return { asset_id: b24, packets: [] };
    return { asset: { asset_id: b24, outstanding_supply: 1 } };
  } }, config);
  assert.equal(seen[0][1].route_id, 'b24-route');
  assert.equal(seen[1][1].asset_id, b24);
  assert.equal(seen[2][1].asset_id, b24);
  assert.equal(buildOffer(config, owner, 'buy', '1', '1').operation.taker_pays_asset_id, b24);
  assert.equal(buildOffer(config, owner, 'sell', '1', '1').operation.taker_gets_asset_id, b24);
});
test('legacy market permission does not imply cash-in support or waive the deployment gate', () => {
  assert.equal(marketReady(config, {}), true);
  assert.equal(marketReady({ ...config, g1_passed: false }, {}), false);
  assert.equal(marketReady({ ...config, redemption_mode: 'two-credit' }, {}), false);
  assert.throws(() => buildRedeem(config, owner, {}, '1'), /not supported/);
});
test('B23 default and old env remain compatible, new config is projected without private fields', () => {
  assert.equal(deploymentConfig().symbol, 'B23');
  assert.equal(deploymentConfig().redemption_mode, 'two-credit');
  assert.equal(deploymentConfig({ B23_NAVCOIN_CONFIG_JSON: '{"g1_passed":true}' }).g1_passed, true);
  const result = deploymentConfig({ NAVCOIN_CONFIG_JSON: JSON.stringify({ ...config, private_key: 'NEVER_PUBLIC' }) });
  assert.equal(result.symbol, 'B24');
  assert.equal(result.private_key, undefined);
  assert.equal(result.b23_asset_id, b24);
});
test('predicted contracts and partial deployment never appear as available Ethereum liquidity', () => {
  const token = '0x' + '1'.repeat(40), pool = '0x' + '2'.repeat(40);
  for (const ethereum of [{}, { wrapped_token: token, pool }, { available: true, wrapped_token: token }, { available: true, wrapped_token: token, pool: 'invalid' }]) {
    assert.deepEqual(validateConfig({ ...config, ethereum }).ethereum, { available: false, wrapped_token: null, pool: null });
  }
  assert.equal(validateConfig({ ...config, ethereum: { available: true, wrapped_token: token, pool } }).ethereum.pool, pool);
});
test('retired balance remains visible but historical NAV cannot inflate current portfolio value', () => {
  const coins = navcoinRegistry(config).map(c => ({ ...c, latest: { nav_per_unit: 1000000, verified_net_assets: c.retired ? 999999999999 : 1 } }));
  const result = heldNavValues([{ asset_id: PUBLISHED_CONFIG.b23_asset_id, balance: 1000000 }], coins);
  assert.equal(result.find(c => c.coin.retired).balance, 1000000n);
  assert.equal(result.find(c => c.coin.retired).value, null);
  assert.equal(sortByTvl(coins).at(-1).name, 'B23');
});
test('activity distinguishes active B24 buys and retired B23 cash-ins using config', () => {
  const op = { owner, operation: 'offer_create', taker_pays_asset_id: b24, taker_gets_asset_id: config.market_quote_asset_id };
  const fixture = { blocks: [{ header: { height: 1, batch_kind: 'transparent', batch_id: 'batch' }, receipt_ids: ['buy', 'cash'] }],
    archives: [{ batch_kind: 'transparent', batch_id: 'batch', payload_json: JSON.stringify({ batch_id: 'batch', offer_transactions: [{ unsigned: op }], asset_transactions: [{ unsigned: { owner, operation: 'pftl_uniswap_primary_redeem', route_id: PUBLISHED_CONFIG.route_id, nav_amount_atoms: 1000000 } }] }) }], receipts: [] };
  const result = projectHistory(fixture, owner, 100, assetSymbols(config), { [PUBLISHED_CONFIG.route_id]: 'B23' });
  const buy = result.rows.find(r => r.transaction_kind === 'offer_create'), cash = result.rows.find(r => r.transaction_kind === 'pftl_uniswap_primary_redeem');
  assert.equal(buy.market_side, 'buy'); assert.equal(buy.market_symbol, 'B24'); assert.equal(cash.unit, 'B23');
});
