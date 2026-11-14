import { PUBLISHED_CONFIG, validateConfig } from '../market/constants.js';
export const address = 'pf' + '2'.repeat(40);
export const config = validateConfig({ ...PUBLISHED_CONFIG, b23_asset_id: '5'.repeat(96), symbol: 'B24', slug: 'b24', g1_passed: true, redemption_mode: 'subscription', creation_enabled: true, issue_multiplier_bps: 10050, redeem_multiplier_bps: 9995, subscription_recipient: '0x' + '3'.repeat(40) });
export function fixture() {
  const nav = { state: 'finalized', epoch: 1, reserve_packet_hash: '6'.repeat(96), submitted_at_height: 1, nav_per_unit: 1000000 };
  const pool = { route_id: config.route_id, native_nav_asset_id: config.b23_asset_id, settlement_asset_id: config.pfusdc_asset_id, live_value_enabled: true, paused: false, invariant_holds: true, spread_recipient: null, route_epoch: 2, policy_epoch: 2, policy_hash: '7'.repeat(96), pricing_nav_epoch: 1, pricing_reserve_packet_hash: nav.reserve_packet_hash, policy_valid_from_height: 1, policy_expires_at_height: 10000, max_nav_age_blocks: 1000, min_order_atoms: 1000000, max_order_atoms: 1000000000, available_issue_atoms: 1000000000, available_redeem_atoms: 20000000, issue_multiplier_bps: 10050, redeem_multiplier_bps: 9995, settlement_reserve_atoms: 20000000, non_nav_spread_atoms: 0, active_reservation_count: 0, export_entitlement_count: 0, native_spendable_balances: [], native_spendable_balances_truncated: false, source_settlement_custody: [{ asset_id: config.market_quote_asset_id, enabled_for_issue: true, principal_atoms: 0, spread_atoms: 0 }] };
  const state = { pool, proof: { asset_id: config.b23_asset_id, current_height: 10, packets: [nav] }, nav, supply: 100000000, offers: { offers: [] }, balances: { address, account: { balance: 1000000 }, assets: { lines: [config.b23_asset_id, config.market_quote_asset_id].map(id => ({ asset_id: id, issuer: config.issuer_address, limit: 100000000, balance: id === config.b23_asset_id ? 0 : 10000000, frozen: false, authorized: true })) } } };
  const history = [], receipts = new Map(), reservations = new Map();
  const asset = id => ({ asset_id: id, precision: 6, issuer: config.issuer_address, asset_family_id: config.pfusdc_asset_id, outstanding_supply: state.supply });
  const client = { address, accountId: 'fixture', chainId: 'synthetic', unlocked: true,
    getBalances: async () => structuredClone(state.balances),
    call: async (method, params) => {
      if (method === 'navcoin_bridge_supply_status') return structuredClone(pool);
      if (method === 'nav_reserve_proof_status') return structuredClone(state.proof);
      if (method === 'asset_info') return { asset: asset(params.asset_id) };
      if (method === 'account_offers') return { offers: [] };
      if (method === 'book_offers') return { offers: params.taker_gets_asset_id === config.b23_asset_id ? [{ offer_id: '8'.repeat(96), taker_gets_asset_id: config.b23_asset_id, taker_pays_asset_id: config.market_quote_asset_id, taker_gets_amount_remaining: 2000000, taker_pays_amount_remaining: 2000000 }] : [] };
      if (method === 'tx') return { tx_id: params.tx_id, confirmed: true, receipt: receipts.get(params.tx_id) };
      throw Error(`Unexpected ${method}`);
    },
    quote: async intent => { history.push('quote:' + intent.operation.operation); return { minimum_fee: 23 }; },
    sign: async intent => { history.push('sign:' + intent.operation.operation); return intent; },
    submit: async intent => {
      const op = intent.operation, cash = state.balances.assets.lines[1], coin = state.balances.assets.lines[0], bucket = pool.source_settlement_custody[0];
      history.push('submit:' + op.operation);
      if (client.uncertain) throw Error('Synthetic uncertain transport; inspect Activity before retrying');
      if (op.operation === 'trust_set') state.balances.assets.lines.find(row => row.asset_id === op.asset_id).limit = op.limit;
      if (op.operation === 'pftl_uniswap_order_reserve') { cash.balance -= op.max_settlement_value_atoms; pool.active_reservation_count++; reservations.set(op.reservation_id, { ...op, subscribed: false }); }
      if (op.operation === 'pftl_uniswap_primary_subscribe_v2') {
        const r = reservations.get(op.reservation_id), gross = r.mint_amount_atoms, fee = op.settlement_value_atoms - gross; r.subscribed = true;
        coin.balance += gross; state.supply += gross; pool.settlement_reserve_atoms += gross; pool.non_nav_spread_atoms += fee; bucket.principal_atoms += gross; bucket.spread_atoms += fee;
        pool.native_spendable_balances = [{ wallet: address, amount_atoms: gross }]; pool.active_reservation_count--; pool.export_entitlement_count++;
      }
      if (op.operation === 'pftl_uniswap_order_release') { const r = reservations.get(op.reservation_id); if (r.subscribed) pool.export_entitlement_count--; else { cash.balance += r.max_settlement_value_atoms; pool.active_reservation_count--; } reservations.delete(op.reservation_id); }
      if (op.operation === 'pftl_uniswap_primary_redeem') { const gross = op.nav_amount_atoms, holder = Math.floor(gross * 9995 / 10000), fee = gross - holder; coin.balance -= gross; cash.balance += holder; state.supply -= gross; pool.settlement_reserve_atoms -= gross; pool.non_nav_spread_atoms += fee; bucket.principal_atoms -= gross; bucket.spread_atoms += fee; pool.native_spendable_balances[0].amount_atoms -= gross; }
      state.proof.current_height++;
      const txId = String(state.proof.current_height).padStart(96, '0'), receipt = { tx_id: txId, accepted: true, code: 'accepted' }; receipts.set(txId, receipt);
      return { txId, receipt, finality: { confirmed: true } };
    },
  };
  return { client, state, history };
}
