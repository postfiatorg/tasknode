import { integer, resultOf, safeInteger } from './amounts.js';
import { lineBalance } from './model.js';

export function accountLine(state, id) {
  const report = resultOf(state.balances.assets);
  if (!Array.isArray(report?.lines) || report.truncated) throw new Error('Complete asset balances are unavailable');
  return report.lines.find(line => line.asset_id === id);
}
function neededLimit(state, operation, id) {
  if (state.offers.truncated) throw new Error('Complete open offers are needed to review receiving capacity');
  const reserved = state.offers.offers.filter(offer => offer.state === 'open' && offer.taker_pays_asset_id === id)
    .reduce((sum, offer) => sum + integer(offer.taker_pays_amount_remaining), 0n);
  const receive = operation.taker_pays_asset_id === id ? integer(operation.taker_pays_amount) : 0n;
  const required = lineBalance(state.balances.assets, id) + reserved + receive;
  return required > 0n ? required : integer(operation.taker_gets_amount);
}
export function assertMarketFunds(config, operation, state) {
  const balance = lineBalance(state.balances.assets, operation.taker_gets_asset_id);
  if (operation.taker_gets_asset_id === config.market_quote_asset_id && balance === 0n && lineBalance(state.balances.assets, config.pfusdc_asset_id) > 0n) {
    throw new Error(`Your PFUSDC came from the cash-in reserve. To buy ${config.symbol || "B23"}, use Add funds to convert Ethereum USDC into PFUSDC for this market. Reserve PFUSDC cannot be converted here.`);
  }
  if (balance < integer(operation.taker_gets_amount)) throw new Error(`Not enough ${operation.taker_gets_asset_id === config.b23_asset_id ? (config.symbol || 'B23') : 'PFUSDC'} available for this offer. Add funds before signing.`);
}
export async function planOfferSetup(client, config, intent, state) {
  const op = intent.operation;
  if (op.operation !== 'offer_create') return [];
  // A reserve-only balance needs guidance before any setup transaction.
  if (op.taker_gets_asset_id === config.market_quote_asset_id && lineBalance(state.balances.assets, config.market_quote_asset_id) === 0n && lineBalance(state.balances.assets, config.pfusdc_asset_id) > 0n) assertMarketFunds(config, op, state);
  const plans = [];
  for (const id of [config.b23_asset_id, config.market_quote_asset_id]) {
    const line = accountLine(state, id), limit = neededLimit(state, op, id);
    if (line?.frozen) throw new Error('A required asset balance is frozen; contact its issuer before trading.');
    if (line && integer(line.limit, 'Trust-line limit') >= limit) continue;
    const { asset } = resultOf(await client.call('asset_info', { asset_id: id }));
    if (asset?.asset_id !== id || !/^pf[0-9a-f]{40}$/.test(asset.issuer || '') || asset.precision !== 6
      || (id === config.market_quote_asset_id && asset.asset_family_id !== config.pfusdc_asset_id)) throw new Error('Asset identity does not match the reviewed market configuration');
    if (asset.issuer === client.address) throw new Error('Use a holder wallet to trade these assets.');
    if (asset.requires_authorization && line?.authorized !== true) throw new Error('The asset issuer must authorize this wallet before trading.');
    plans.push({ unit: id === config.b23_asset_id ? (config.symbol || 'B23') : 'PFUSDC', intent: { kind: 'asset', operation: {
      operation: 'trust_set', account: client.address, issuer: asset.issuer, asset_id: id,
      limit: safeInteger(limit), authorized: false, frozen: false, reserve_paid: 10,
    } } });
  }
  return plans;
}
export function offerPreflight(config, intent, state) {
  if (intent.operation.operation !== 'offer_create') return;
  assertMarketFunds(config, intent.operation, state);
  for (const id of [config.b23_asset_id, config.market_quote_asset_id]) {
    const line = accountLine(state, id);
    if (!line || line.frozen || integer(line.limit, 'Trust-line limit') < neededLimit(state, intent.operation, id)) throw new Error('Asset setup changed; review this offer again before signing.');
  }
}
export function trustPreflight(intent, current, reviewed) {
  const id = intent.operation.asset_id;
  const before = accountLine(reviewed, id), now = accountLine(current, id);
  for (const key of ['issuer', 'limit', 'authorized', 'frozen']) {
    if (before?.[key] !== now?.[key]) throw new Error('Asset setup changed; review the required limit again.');
  }
  if (Boolean(before) !== Boolean(now)) throw new Error('Asset setup changed; review again.');
}
export function verifyTrust(intent, before, after) {
  const op = intent.operation, line = accountLine(after, op.asset_id);
  if (!line || line.issuer !== op.issuer || line.frozen || integer(line.limit) < integer(op.limit)) throw new Error('Asset setup is not yet verified on the chain');
  if (lineBalance(before.balances.assets, op.asset_id) !== lineBalance(after.balances.assets, op.asset_id)
    || integer(before.supply) !== integer(after.supply) || (before.pool || after.pool) && integer(before.pool?.settlement_reserve_atoms) !== integer(after.pool?.settlement_reserve_atoms)) throw new Error('Asset setup changed balances, NAVCoin supply or the reserve');
  return { message: 'Asset receiving limit verified. No assets were bought or converted.' };
}
