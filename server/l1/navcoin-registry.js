import { readFile } from 'node:fs/promises';
import { localRpc } from './read-rpc.js';
import { validateConfig } from '../../src/features/wallet/l1/market/constants.js';
import { primaryReady } from '../../src/features/wallet/l1/primary/model.js';
const activeOffers = (book, height) => (book?.offers || []).filter(o => o.state === 'open' && (!o.expiration_height || o.expiration_height > height));
const capability = (available, reason = '') => ({ available, reason: available ? '' : reason });
export async function discoverRegistry(rpc, metadata) {
  const status = await rpc('status', {}), routes = (await rpc('navcoin_bridge_routes', { limit: 100 })).routes;
  if (!Array.isArray(routes)) throw Error('Route registry unavailable');
  const coins = [];
  // Sequential coins, bounded read groups: avoid overwhelming the local RPC.
  for (const entry of metadata) {
    if (!/^[0-9a-f]{96}$/.test(entry.asset_id || '') || !/^[a-z0-9-]+$/.test(entry.slug || '')) throw Error('Invalid registry identity');
    if (!status.active_nav_profiles.some(p => p.asset_id === entry.asset_id)) continue;
    const asset = (await rpc('asset_info', { asset_id: entry.asset_id })).asset;
    const proof = await rpc('nav_reserve_proof_status', { asset_id: entry.asset_id });
    if (asset.asset_id !== entry.asset_id || proof.asset_id !== entry.asset_id) throw Error('Registry asset identity mismatch');
    const matches = routes.filter(r => r.native_nav_asset_id === entry.asset_id);
    // Ambiguous route selection is read-only until explicitly resolved on chain.
    const route = matches.length === 1 ? matches[0] : null;
    const pool = route ? await rpc('navcoin_bridge_supply_status', { route_id: route.route_id }) : null;
    if (pool && (pool.route_id !== route.route_id || pool.native_nav_asset_id !== entry.asset_id || pool.settlement_asset_id !== route.settlement_asset_id)) throw Error('Registry route identity mismatch');
    const sources = pool?.source_settlement_custody || [];
    const markets = [];
    for (const source of sources) {
      const quote = (await rpc('asset_info', { asset_id: source.asset_id })).asset;
      if (quote.asset_id !== source.asset_id || quote.asset_family_id !== pool.settlement_asset_id || quote.precision !== 6) continue;
      const asks = await rpc('book_offers', { taker_gets_asset_id: asset.asset_id, taker_pays_asset_id: source.asset_id, limit: 100 });
      const bids = await rpc('book_offers', { taker_gets_asset_id: source.asset_id, taker_pays_asset_id: asset.asset_id, limit: 100 });
      if (asks.taker_gets_asset_id !== asset.asset_id || asks.taker_pays_asset_id !== source.asset_id || bids.taker_gets_asset_id !== source.asset_id || bids.taker_pays_asset_id !== asset.asset_id) throw Error('Registry book identity mismatch');
      markets.push({ asset_id: source.asset_id, symbol: quote.code, enabled: source.enabled_for_issue, asks, bids, offers: activeOffers(asks, proof.current_height).length + activeOffers(bids, proof.current_height).length });
    }
    const market = markets.find(m => m.offers > 0) || markets.find(m => m.enabled) || markets[0];
    const nav = proof.packets?.find(p => p.state === 'finalized' && p.epoch === pool?.pricing_nav_epoch && p.reserve_packet_hash === pool?.pricing_reserve_packet_hash);
    const ethereum = { available: false, chain_id: route?.ethereum_chain_id ?? null, wrapped_token: route?.wrapped_navcoin_token ?? null, controller: route?.handoff_controller ?? null,
      reason: route?.ethereum_chain_id === 1 ? 'An Ethereum token is registered on the native route. This wallet has not verified live pool liquidity or a supported Ethereum trade; use the token identifier to check its deployment.' : 'No mainnet Ethereum route is registered.' };
    const base = { nav_asset_id: asset.asset_id, symbol: asset.code, slug: entry.slug, description: entry.description || '', methodology: entry.methodology || '', retired: entry.retired === true,
      issuer_address: asset.issuer, route_id: route?.route_id ?? null, pfusdc_asset_id: pool?.settlement_asset_id ?? null, market_quote_asset_id: market?.asset_id ?? null,
      pfusdc_source_asset_ids: sources.map(s => s.asset_id), management_address: pool?.spread_recipient ?? null, proof_profile: proof.active_profile?.profile_id ?? null,
      issue_multiplier_bps: pool?.issue_multiplier_bps ?? null, redeem_multiplier_bps: pool?.redeem_multiplier_bps ?? null, ethereum,
      // Native creation always releases this unused export entitlement; no export is signed.
      subscription_recipient: pool?.handoff_controller, creation_enabled: Boolean(pool && market?.enabled), redemption_mode: 'subscription', g1_passed: true,
      cash_in_note: 'Only tracked subscription holdings can cash in against their matching PFUSDC reserve. Book purchases must be sold to a market buyer.' };
    let reason = entry.retired ? 'This NAVCoin is retired; its readings and balances are historical.' : !route ? matches.length ? 'Multiple routes exist; no unambiguous native route is selected.' : 'No native route is registered.' : !market ? 'No governed PFUSDC quote source is registered.' : asset.precision !== 6 ? 'This wallet supports six-decimal native markets only.' : '';
    if (!reason) { try { primaryReady(base, { pool, proof, nav }); } catch (e) { reason = e.message; } }
    const primary = !reason;
    const book = !entry.retired && asset.precision === 6 && Boolean(market && (market.offers > 0 || primary));
    const bookReason = entry.retired ? 'This NAVCoin is retired.' : !market ? 'No native PFUSDC quote market was discovered.' : 'No live native offers were found. ' + reason;
    const capabilities = { book: capability(book, bookReason), create: capability(primary, reason), cash_in: { ...capability(primary, reason), mode: primary ? 'subscription' : 'unsupported' }, ethereum };
    const config = validateConfig({ ...base, creation_enabled: primary, redemption_mode: primary ? 'subscription' : 'unsupported', market_only: !primary, capabilities });
    coins.push({ ...config, valuation_decimals: entry.valuation_decimals ?? 6, market_quote_symbol: market?.symbol ?? null, asset_id: asset.asset_id, name: entry.name || asset.code, capabilities, chain: { asset: { asset }, proof, pool, book: market?.asks ?? null, bids: market?.bids ?? null }, read_at: new Date().toISOString() });
  }
  if (new Set(coins.map(c => c.slug)).size !== coins.length || new Set(coins.map(c => c.asset_id)).size !== coins.length) throw Error('Duplicate registry identity');
  const end = await rpc('status', {});
  if (status.block_tip_hash !== end.block_tip_hash) throw Error('Chain changed during registry read; refresh to read the new state.');
  return coins;
}
let cached, pending;
export async function getNavcoinRegistry() {
  if (cached && Date.now() - cached.at < 15000) return cached.coins;
  if (!pending) pending = (async () => {
    const metadata = JSON.parse(await readFile(new URL('./navcoin-metadata.json', import.meta.url), 'utf8'));
    const coins = await discoverRegistry(localRpc(), metadata);
    cached = { coins, at: Date.now() }; return coins;
  })().finally(() => { pending = null; });
  return pending;
}
