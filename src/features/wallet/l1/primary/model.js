import { atoms, integer, nonce, resultOf, safeInteger } from '../market/amounts.js';
import { balanceDeltas, lineBalance, snapshot } from '../market/model.js';
import { accountLine, planOfferSetup, trustPreflight, verifyTrust } from '../market/offer-setup.js';
const ceil = (a, b) => (a + b - 1n) / b;
const bindings = ['route_epoch', 'policy_epoch', 'policy_hash', 'pricing_nav_epoch', 'pricing_reserve_packet_hash'];
export function primaryReady(config, state) {
  const p = state.pool;
  if (!config.creation_enabled || !config.g1_passed || config.market_only || !p?.live_value_enabled || p.paused || p.invariant_holds !== true || p.spread_recipient) throw new Error('Native creation is unavailable on this route');
  if (!state.nav || state.nav.epoch !== p.pricing_nav_epoch || state.nav.reserve_packet_hash !== p.pricing_reserve_packet_hash) throw new Error('The active policy has no matching finalized NAV');
  const height = integer(state.proof.current_height);
  if (height < integer(p.policy_valid_from_height) || height + 3n >= integer(p.policy_expires_at_height) || height - integer(state.nav.submitted_at_height) >= integer(p.max_nav_age_blocks)) throw new Error('The route policy or NAV is stale; wait for a new reading');
  if (!p.source_settlement_custody?.some(row => row.asset_id === config.market_quote_asset_id && row.enabled_for_issue)) throw new Error('Market PFUSDC is not enabled for this subscription route');
}
export function creationQuote(config, state, quantity) {
  primaryReady(config, state);
  const amount = BigInt(atoms(quantity)), p = state.pool;
  if (amount < integer(p.min_order_atoms) || amount > integer(p.max_order_atoms) || amount > integer(p.available_issue_atoms)) throw new Error('Creation amount exceeds current route capacity or order bounds');
  const gross = ceil(amount * integer(state.nav.nav_per_unit), 1000000n), bps = integer(p.issue_multiplier_bps);
  if (bps < 10000n || bps > 10500n) throw new Error('Invalid creation multiplier');
  const due = ceil(gross * bps, 10000n), height = integer(state.proof.current_height), end = integer(p.policy_expires_at_height) - 1n;
  return { amount: safeInteger(amount), gross: safeInteger(gross), due: safeInteger(due), fee: safeInteger(due - gross), feeBps: Number(bps - 10000n), expiry: safeInteger(height + 100n < end ? height + 100n : end) };
}
export function defaultBuyMode(quantityAtoms, depth, enabled, truncated = false) {
  return enabled && !truncated && quantityAtoms != null && quantityAtoms > depth ? 'create' : 'book';
}
export function trackedBalance(state, address) {
  if (state.pool.native_spendable_balances_truncated) throw new Error('Complete subscription balances are unavailable');
  return integer(state.pool.native_spendable_balances?.find(row => row.wallet === address)?.amount_atoms ?? 0);
}
export function sourceCustody(config, state) {
  const row = state.pool.source_settlement_custody?.find(row => row.asset_id === config.market_quote_asset_id);
  if (!row) throw new Error('The source PFUSDC reserve is unavailable');
  return row;
}
export async function createPlan(client, config, quantity) {
  const before = await snapshot(client, config), quote = creationQuote(config, before, quantity);
  if (lineBalance(before.balances.assets, config.market_quote_asset_id) < BigInt(quote.due)) {
    const line = accountLine(before, config.market_quote_asset_id);
    if (!line || integer(line.limit) < BigInt(quote.due)) {
      const { asset } = resultOf(await client.call('asset_info', { asset_id: config.market_quote_asset_id }));
      if (asset?.asset_id !== config.market_quote_asset_id || asset.asset_family_id !== config.pfusdc_asset_id || asset.precision !== 6 || line?.frozen || (asset.requires_authorization && !line?.authorized)) throw new Error('PFUSDC receiving setup is unavailable');
      return { version: 1, address: client.address, route: config.route_id, quote, fundingOnly: true, steps: [{ kind: 'setup', unit: 'PFUSDC', intent: { kind: 'asset', operation: { operation: 'trust_set', account: client.address, issuer: asset.issuer, asset_id: config.market_quote_asset_id, limit: quote.due, authorized: false, frozen: false, reserve_paid: 10 } } }] };
    }
    throw new Error('Not enough market PFUSDC (S). Add funds before creating coins.');
  }
  const setup = await planOfferSetup(client, config, { operation: { operation: 'offer_create', taker_gets_asset_id: config.market_quote_asset_id, taker_gets_amount: quote.due, taker_pays_asset_id: config.b23_asset_id, taker_pays_amount: quote.amount } }, before);
  const id = nonce() + nonce().slice(0, 32), p = before.pool;
  const release = { kind: 'asset', operation: { operation: 'pftl_uniswap_order_release', releaser: client.address, route_id: config.route_id, reservation_id: id } };
  return { version: 1, address: client.address, route: config.route_id, quote, binding: Object.fromEntries(bindings.map(k => [k, p[k]])),
    steps: [...setup.map(row => ({ kind: 'setup', unit: row.unit, intent: row.intent })),
      { kind: 'reserve', intent: { kind: 'asset', operation: { operation: 'pftl_uniswap_order_reserve', subscriber: client.address, route_id: config.route_id, reservation_id: id, ethereum_recipient: config.subscription_recipient, route_epoch: p.route_epoch, policy_epoch: p.policy_epoch, policy_hash: p.policy_hash, mint_amount_atoms: quote.amount, max_settlement_value_atoms: quote.due, expires_at_height: quote.expiry, settlement_source_asset_id: config.market_quote_asset_id } } },
      { kind: 'subscribe', intent: { kind: 'asset', operation: { operation: 'pftl_uniswap_primary_subscribe_v2', subscriber: client.address, route_id: config.route_id, reservation_id: id, subscription_nonce: nonce(), settlement_asset_id: config.pfusdc_asset_id, settlement_value_atoms: quote.due, pricing_nav_epoch: p.pricing_nav_epoch, pricing_reserve_packet_hash: p.pricing_reserve_packet_hash } } },
      { kind: 'release', intent: release }], release };
}
export function primaryPreflight(config, plan, step, current, reviewed) {
  if (step.kind === 'setup') return trustPreflight(step.intent, current, reviewed);
  if (step.kind === 'release' || step.kind === 'cancel') return;
  primaryReady(config, current);
  for (const key of bindings) if (current.pool[key] !== plan.binding[key]) throw new Error('NAV or route policy changed; cancel the reservation and review again');
  if (integer(current.proof.current_height) + 1n >= BigInt(plan.quote.expiry)) throw new Error('Reservation expired; release it and review again');
  const line = accountLine(current, config.b23_asset_id);
  if (!line || line.frozen || integer(line.limit) < lineBalance(current.balances.assets, config.b23_asset_id) + BigInt(plan.quote.amount)) throw new Error('Receiving limit is insufficient for creation');
  if (step.kind === 'reserve' && lineBalance(current.balances.assets, config.market_quote_asset_id) < BigInt(plan.quote.due)) throw new Error('Insufficient market PFUSDC for the reservation');
}
export async function verifyPrimary(client, config, plan, step, before, after, receipt, txId) {
  if (step.kind === 'setup') return verifyTrust(step.intent, before, after);
  // The legacy facility-detail RPC opens the live database and can fail with
  // Database already open. The committed tx proof supplies literal execution
  // acceptance; the exact signed operation and independent deltas bind effects.
  const committed = resultOf(await client.call('tx', { tx_id: txId }));
  if (receipt.accepted !== true || receipt.tx_id !== txId || committed.tx_id !== txId || committed.confirmed !== true || committed.receipt?.accepted !== true || committed.receipt.tx_id !== txId) throw new Error('Committed execution receipt is not accepted and confirmed for this transaction');
  const q = plan.quote, delta = balanceDeltas(before, after, config, config.market_quote_asset_id);
  const d = key => integer(after.pool[key]) - integer(before.pool[key]);
  const custodyDelta = key => integer(sourceCustody(config, after)[key]) - integer(sourceCustody(config, before)[key]);
  const amt = BigInt(q.amount), gross = BigInt(q.gross), fee = BigInt(q.fee), due = BigInt(q.due ?? 0);
  const expectedCoin = step.kind === 'subscribe' ? amt : step.kind === 'redeem' ? -amt : 0n;
  const expectedCash = step.kind === 'reserve' ? -due : step.kind === 'cancel' ? due : step.kind === 'redeem' ? BigInt(q.holder) : 0n;
  const expectedReserve = step.kind === 'subscribe' ? gross : step.kind === 'redeem' ? -gross : 0n;
  const expectedSpread = ['subscribe', 'redeem'].includes(step.kind) ? fee : 0n;
  if (BigInt(delta.B23) !== expectedCoin || BigInt(delta.PFUSDC) !== expectedCash || integer(after.supply) - integer(before.supply) !== expectedCoin || d('settlement_reserve_atoms') !== expectedReserve || d('non_nav_spread_atoms') !== expectedSpread || custodyDelta('principal_atoms') !== expectedReserve || custodyDelta('spread_atoms') !== expectedSpread || trackedBalance(after, client.address) - trackedBalance(before, client.address) !== expectedCoin) throw new Error('Subscription balances, supply, tracked inventory or source reserve do not match the accepted receipt');
  const reservations = step.kind === 'reserve' ? 1n : ['subscribe', 'cancel'].includes(step.kind) ? -1n : 0n;
  const entitlements = step.kind === 'subscribe' ? 1n : step.kind === 'release' ? -1n : 0n;
  if (d('active_reservation_count') !== reservations || d('export_entitlement_count') !== entitlements || after.pool.invariant_holds !== true) throw new Error('Reservation lifecycle or supply invariant did not verify');
  return { deltas: delta, message: 'Accepted execution receipt, source PFUSDC balances, tracked inventory, supply and reserve verified.', feeRetained: String(expectedSpread), confirmedTxId: txId };
}
export function subscriberQuote(config, state, quantity, address) {
  primaryReady(config, state);
  const amount = BigInt(atoms(quantity)), p = state.pool;
  if (amount > trackedBalance(state, address) || amount > lineBalance(state.balances.assets, config.b23_asset_id)) throw new Error('Only your tracked subscription holdings can be cashed in. Book purchases must be sold on the market.');
  const gross = ceil(amount * integer(state.nav.nav_per_unit), 1000000n), bps = integer(p.redeem_multiplier_bps);
  if (bps < 9500n || bps > 10000n) throw new Error('Invalid cash-in multiplier');
  if (amount < integer(p.min_order_atoms) || amount > integer(p.max_order_atoms) || amount > integer(p.available_redeem_atoms) || gross > integer(sourceCustody(config, state).principal_atoms)) throw new Error('The matching PFUSDC reserve or route capacity cannot cover this cash-in');
  const holder = gross * bps / 10000n, line = accountLine(state, config.market_quote_asset_id);
  if (!line || line.frozen || integer(line.limit) < lineBalance(state.balances.assets, config.market_quote_asset_id) + holder) throw new Error('Increase the PFUSDC receiving limit before cashing in');
  const height = integer(state.proof.current_height), end = integer(p.policy_expires_at_height) - 1n;
  return { amount: safeInteger(amount), gross: safeInteger(gross), holder: safeInteger(holder), fee: safeInteger(gross - holder), feeBps: Number(10000n - bps), expiry: safeInteger(height + 100n < end ? height + 100n : end) };
}
export function subscriberRedeem(config, state, quantity, address) {
  const quote = subscriberQuote(config, state, quantity, address), p = state.pool;
  const intent = { kind: 'asset', operation: { operation: 'pftl_uniswap_primary_redeem', owner: address, settlement_recipient: address, route_id: config.route_id, redemption_nonce: nonce(), nav_amount_atoms: quote.amount, min_settlement_value_atoms: quote.holder, route_epoch: p.route_epoch, policy_epoch: p.policy_epoch, policy_hash: p.policy_hash, pricing_nav_epoch: p.pricing_nav_epoch, pricing_reserve_packet_hash: p.pricing_reserve_packet_hash, expires_at_height: quote.expiry, settlement_source_asset_id: config.market_quote_asset_id } };
  return { quote, intent };
}
