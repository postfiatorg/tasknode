import { assetSymbols } from './market/constants.js';

// Label current and historical assets by ID; a reused ticker is not identity.
export function labelActivity(rows, config) {
  if (!config) return rows;
  const symbols = assetSymbols(config);
  const routes = { [config.route_id]: config.symbol, ...Object.fromEntries(config.retired_assets.filter(coin => coin.route_id).map(coin => [coin.route_id, coin.symbol])) };
  return rows.map(row => {
    const next = { ...row }, kind = row.kind || row.transaction_kind;
    if (symbols[row.asset_id]) next.unit = symbols[row.asset_id];
    if (['pftl_uniswap_primary_redeem', 'pftl_uniswap_order_reserve', 'pftl_uniswap_primary_subscribe_v2', 'pftl_uniswap_order_release'].includes(kind) && routes[row.route_id]) next.unit = routes[row.route_id];
    if (kind === 'offer_create') {
      const buying = symbols[row.taker_pays_asset_id], selling = symbols[row.taker_gets_asset_id];
      if (buying && buying !== 'PFUSDC') { next.market_side = 'buy'; next.market_symbol = buying; }
      else if (selling && selling !== 'PFUSDC') { next.market_side = 'sell'; next.market_symbol = selling; }
    }
    return next;
  });
}
