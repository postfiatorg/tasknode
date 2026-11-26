export const SCALE = 1_000_000n;
const assetId = value => /^[0-9a-f]{96}$/.test(value || '');
const FIELDS = 'nav_asset_id pfusdc_asset_id market_quote_asset_id route_id issuer_address alice_holder_address management_address proof_profile pfusdc_source_asset_ids g1_passed symbol slug description methodology redemption_mode cash_in_note issue_multiplier_bps redeem_multiplier_bps ethereum retired_assets creation_enabled subscription_recipient capabilities retired market_only'.split(' ');
// A selected registry entry, never an implicit deployment or ticker default.
export function validateConfig(input) {
  const config = Object.fromEntries(FIELDS.map(key => [key, input?.[key]]));
  if (!assetId(config.nav_asset_id)) throw new Error('Choose a NAVCoin from the registry');
  config.symbol ??= 'NAVCoin'; config.slug ??= config.symbol.toLowerCase();
  if (!/^[a-zA-Z0-9]{2,12}$/.test(config.symbol) || !/^[a-z0-9-]+$/.test(config.slug)) throw new Error('Invalid NAVCoin name');
  for (const key of ['description', 'methodology', 'cash_in_note']) {
    config[key] ??= '';
    if (typeof config[key] !== 'string' || config[key].length > 4000) throw new Error('Invalid NAVCoin description');
  }
  config.redemption_mode ??= 'unsupported';
  if (!['two-credit', 'subscription', 'unsupported'].includes(config.redemption_mode)) throw new Error('Unsupported redemption mode');
  for (const key of ['pfusdc_asset_id', 'market_quote_asset_id', 'proof_profile']) if (config[key] != null && !assetId(config[key])) throw new Error(`Invalid ${key}`);
  if (config.market_quote_asset_id && [config.nav_asset_id, config.pfusdc_asset_id].includes(config.market_quote_asset_id)) throw new Error('NAVCoin and quote must differ');
  for (const key of ['issuer_address', 'alice_holder_address', 'management_address']) if (config[key] != null && !/^pf[0-9a-f]{40}$/.test(config[key])) throw new Error(`Invalid ${key}`);
  config.pfusdc_source_asset_ids ??= [];
  if (!Array.isArray(config.pfusdc_source_asset_ids) || config.pfusdc_source_asset_ids.some(id => !assetId(id))) throw new Error('Invalid PFUSDC sources');
  for (const key of ['issue_multiplier_bps', 'redeem_multiplier_bps']) if (config[key] != null && (!Number.isSafeInteger(config[key]) || config[key] < 9500 || config[key] > 10500)) throw new Error('Invalid route terms');
  config.creation_enabled = config.creation_enabled === true && !config.retired;
  if (config.creation_enabled && (config.redemption_mode !== 'subscription' || !/^0x[0-9a-f]{40}$/.test(config.subscription_recipient || '') || /^0x0{40}$/.test(config.subscription_recipient))) throw new Error('Native creation requires a route recipient binding');
  config.retired_assets ??= [];
  config.ethereum ??= { available: false, reason: 'Ethereum liquidity has not been verified.' };
  return Object.freeze(config);
}
export async function loadConfig(assetId, fetcher = fetch) {
  if (!/^[0-9a-f]{96}$/.test(assetId || '')) throw new Error('Choose a NAVCoin first');
  const response = await fetcher(`/api/l1/navcoin/config?asset_id=${assetId}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Selected NAVCoin is unavailable');
  const config = validateConfig(await response.json());
  if (config.nav_asset_id !== assetId) throw new Error('Selected NAVCoin identity mismatch');
  return config;
}
export function marketReady(config, state) {
  if (!config || config.retired) return false;
  if (config.capabilities) return config.capabilities.book.available === true;
  return Boolean(config.market_only || (config.g1_passed && ((config.redemption_mode || 'two-credit') !== 'two-credit' || (config.management_address && state?.pool?.spread_recipient === config.management_address))));
}
export function assetSymbols(registry) {
  const coins = Array.isArray(registry) ? registry : registry ? [registry, ...(registry.retired_assets || [])] : [];
  const result = {};
  for (const coin of coins) {
    for (const id of [coin.pfusdc_asset_id, coin.market_quote_asset_id, ...(coin.pfusdc_source_asset_ids || [])].filter(Boolean)) result[id] = 'PFUSDC';
    result[coin.nav_asset_id || coin.asset_id] = coin.symbol || coin.name;
  }
  return result;
}
export function routeSymbols(registry) {
  const coins = Array.isArray(registry) ? registry : registry ? [registry, ...(registry.retired_assets || [])] : [];
  return Object.fromEntries(coins.filter(c => c.route_id).map(c => [c.route_id, c.symbol || c.name]));
}
