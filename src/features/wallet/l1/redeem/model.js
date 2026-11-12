import { SCALE } from "../market/constants.js";
import { atoms, integer, safeInteger, nonce } from "../market/amounts.js";
import { balanceDeltas, lineBalance } from "../market/model.js";
export function facilityReady(config, state) {
  if (!config.g1_passed) throw new Error("Redemption facility is blocked until G1 deployment is verified");
  if (!config.management_address || state.pool.spread_recipient !== config.management_address) throw new Error("Management recipient is not installed on the live route");
  if (!state.pool.live_value_enabled || state.pool.paused || state.pool.invariant_holds !== true) throw new Error("Redemption facility is unavailable or its supply invariant is not verified");
}
export function redemptionQuote(config, state, quantity) {
  facilityReady(config, state);
  if (!config.management_address || state.pool.spread_recipient !== config.management_address) throw new Error("Live management recipient has not been verified");
  if (!state.nav) throw new Error("Finalized NAV matching the route policy is unavailable");
  const amount = BigInt(atoms(quantity, "B23 redemption")), pool = state.pool;
  const nav = integer(state.nav.nav_per_unit, "NAV"), bps = integer(pool.redeem_multiplier_bps, "Redemption multiplier");
  if (nav === 0n || bps < 9500n || bps > 10000n) throw new Error("Invalid NAV or redemption fee");
  if (amount > integer(pool.available_redeem_atoms) || amount > integer(pool.max_order_atoms) || amount < integer(pool.min_order_atoms)) throw new Error("Amount is outside the currently redeemable capacity and order bounds");
  const gross = amount * nav / SCALE, holder = gross * bps / 10000n, management = gross - holder;
  if (gross > integer(pool.settlement_reserve_atoms) || holder === 0n) throw new Error("Reserve cannot cover this redemption");
  const height = integer(state.proof.current_height), expiry = integer(pool.policy_expires_at_height);
  if (height < integer(pool.policy_valid_from_height) || height >= expiry - 1n) throw new Error("Redemption policy is inactive or expired");
  return { amount: safeInteger(amount), gross: safeInteger(gross), holder: safeInteger(holder), management: safeInteger(management), feeBps: Number(10000n - bps), expiry: safeInteger(height + 100n < expiry ? height + 100n : expiry - 1n) };
}
export function buildRedeem(config, address, state, quantity, redemptionNonce = nonce()) {
  const quote = redemptionQuote(config, state, quantity), pool = state.pool;
  return { quote, intent: { kind: "asset", operation: {
    operation: "pftl_uniswap_primary_redeem", owner: address, settlement_recipient: address,
    route_id: config.route_id, redemption_nonce: redemptionNonce, nav_amount_atoms: quote.amount,
    min_settlement_value_atoms: quote.holder, route_epoch: safeInteger(pool.route_epoch), policy_epoch: safeInteger(pool.policy_epoch),
    policy_hash: pool.policy_hash, pricing_nav_epoch: safeInteger(pool.pricing_nav_epoch), pricing_reserve_packet_hash: pool.pricing_reserve_packet_hash,
    expires_at_height: quote.expiry,
  } } };
}
export function redeemPreflight(config, intent, current, prepared) {
  facilityReady(config, current);
  for (const key of ["route_epoch", "policy_epoch", "policy_hash", "pricing_nav_epoch", "pricing_reserve_packet_hash", "spread_recipient"]) {
    if (current.pool[key] !== prepared.pool[key]) throw new Error("Redemption policy changed; review a new quote");
  }
  if (integer(current.proof.current_height) >= integer(intent.operation.expires_at_height)) throw new Error("Redemption quote expired");
  if (integer(current.pool.available_redeem_atoms) < integer(intent.operation.nav_amount_atoms)) throw new Error("Redemption capacity fell; review a new quote");
}
export function verifyRedeem(config, intent, before, after, receipt) {
  const op = intent.operation, credit = receipt.redemption_settlement;
  if (!credit) throw new Error("Accepted receipt lacks the two-credit redemption settlement");
  if (credit.settlement_recipient !== op.settlement_recipient || credit.spread_recipient !== config.management_address || credit.settlement_asset_id !== config.pfusdc_asset_id) throw new Error("Redemption credit recipients or payout asset mismatch");
  const holder = integer(credit.settlement_value_atoms), management = integer(credit.spread_value_atoms), gross = holder + management;
  const expectedGross = integer(op.nav_amount_atoms) * integer(before.nav.nav_per_unit) / SCALE;
  const expectedHolder = expectedGross * integer(before.pool.redeem_multiplier_bps) / 10000n;
  if (gross !== expectedGross || holder !== expectedHolder || holder < integer(op.min_settlement_value_atoms)) throw new Error("Receipt credits do not match the reviewed NAV-minus-fee quote");
  const deltas = balanceDeltas(before, after, config);
  const managerDelta = lineBalance(after.managementLines, credit.settlement_asset_id) - lineBalance(before.managementLines, credit.settlement_asset_id);
  const walletCredit = op.settlement_recipient === config.management_address ? gross : holder;
  const expectedManagerDelta = op.settlement_recipient === config.management_address ? gross : management;
  if (BigInt(deltas.B23) !== -integer(op.nav_amount_atoms) || BigInt(deltas.PFUSDC) !== walletCredit || managerDelta !== expectedManagerDelta) throw new Error("Both actual payout balances and B23 debit must match the receipt");
  if (integer(before.supply) - integer(after.supply) !== integer(op.nav_amount_atoms) || integer(before.pool.settlement_reserve_atoms) - integer(after.pool.settlement_reserve_atoms) !== gross) throw new Error("Redemption supply or reserve delta mismatch");
  return { deltas, credits: credit, managementDelta: String(managerDelta), message: "Redemption verified: holder and management credits, B23 burn, and reserve decrease match." };
}
