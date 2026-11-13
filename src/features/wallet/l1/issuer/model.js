import { atoms, integer, safeInteger, nonce } from "../market/amounts.js";
import { balanceDeltas, lineBalance } from "../market/model.js";
import { facilityReady } from "../redeem/model.js";
// The chain accepts a funding only when it carries the last successful funding sequence + 1.
function nextFundingSequence(state) {
  const last = state?.pool?.funding_sequence ?? 0;
  if (!Number.isSafeInteger(last) || last < 0) throw new Error("Reserve funding sequence is unavailable; refresh the route state");
  return last + 1;
}
export function buildFund(config, address, state, quantity, fundingNonce = nonce()) {
  facilityReady(config, state);
  return { kind: "asset", operation: { operation: "pftl_uniswap_redemption_fund", funder: address, route_id: config.route_id, settlement_asset_id: config.pfusdc_asset_id, funding_nonce: fundingNonce, amount_atoms: atoms(quantity, "PFUSDC funding"), funding_sequence: nextFundingSequence(state) } };
}
export function verifyFund(config, intent, before, after) {
  const amount = integer(intent.operation.amount_atoms), deltas = balanceDeltas(before, after, config);
  if (BigInt(deltas.PFUSDC) !== -amount || BigInt(deltas.B23) !== 0n || integer(before.supply) !== integer(after.supply) || integer(after.pool.settlement_reserve_atoms) - integer(before.pool.settlement_reserve_atoms) !== amount) throw new Error("Funding must increase reserve by the payment and mint no B23");
  return { deltas, message: "Reserve funding verified. No B23 was minted.", capacityBefore: before.pool.available_redeem_atoms, capacityAfter: after.pool.available_redeem_atoms };
}
export function validateEquityPlan(plan, config, now = Date.now()) {
  const p = plan?.packet;
  if (!p || p.schema !== "postfiat.b23.account_equity.v1" || p.valuation_unit !== "usd_1e6" || p.scale_atoms_per_usd !== 1000000 || p.source_field !== "securitiesAccount.currentBalances.liquidationValue" || !Array.isArray(p.adjustments) || p.adjustments.length) throw new Error("An unadjusted Schwab account-equity packet in usd_1e6 is required");
  if (!config.proof_profile) throw new Error("B23's existing proof profile is not configured");
  if (plan.pfdep_retired !== true) throw new Error("Opening mint blocked: PFDEP retirement is not verified");
  const target = integer(plan.target_supply_atoms), current = integer(plan.current_supply_atoms), additional = integer(plan.additional_mint_atoms);
  if (target !== integer(p.liquidation_value_atoms) || target <= current || additional !== target - current) throw new Error("Opening supply must count the existing B23 and wire once");
  if (BigInt(atoms(p.liquidation_value_usd)) !== target) throw new Error("Schwab decimal and atomic values disagree");
  if (!p.cutoff_at_utc || !p.observed_at_utc || !/^[0-9a-f]{96}$/.test(p.packet_hash || "")) throw new Error("Account-equity cutoff or packet commitment is missing");
  const cutoff = Date.parse(p.cutoff_at_utc), observed = Date.parse(p.observed_at_utc);
  if (!Number.isFinite(cutoff) || !Number.isFinite(observed) || observed < cutoff || observed - cutoff > 60000 || cutoff > now + 60000 || now - cutoff >= 86400000) throw new Error("Account-equity packet is outside its cutoff window or older than one day");
  if (!/^[0-9a-f]{64}$/.test(p.account_commitment_sha256 || "")) throw new Error("Account identity commitment is unavailable");
  const ops = plan.operations;
  if (!Array.isArray(ops) || ops.length !== 3 || ops.map(op => op.operation).join(",") !== "nav_reserve_submit,nav_epoch_finalize,nav_mint_at_nav") throw new Error("Expected reserve submit, epoch finalize, and mint operations");
  const [reserve, finalize, mint] = ops;
  for (const op of ops) {
    if (op.issuer !== config.issuer_address || op.asset_id !== config.b23_asset_id || op.reserve_packet_hash !== p.packet_hash || op.epoch !== reserve.epoch) throw new Error("Opening operations do not bind the configured B23 packet and epoch");
  }
  if (reserve.proof_profile !== config.proof_profile || reserve.nav_per_unit !== 1000000 || integer(reserve.verified_net_assets) !== target || integer(reserve.circulating_supply) !== target || integer(mint.amount) !== additional || mint.to !== config.alice_holder_address || reserve.submitter !== config.issuer_address) throw new Error("Opening operations disagree with equity or existing B23 proof settings");
  safeInteger(finalize.epoch);
  return plan;
}
export function mintPreflight(plan, config, intent, state) {
  validateEquityPlan(plan, config);
  if (integer(state.supply) !== integer(plan.current_supply_atoms)) throw new Error("B23 supply changed; obtain an updated opening plan");
  const op = intent.operation;
  if (op.operation === "nav_reserve_submit" && state.proof.packets.some(p => p.epoch >= op.epoch)) throw new Error("Reserve epoch already exists; inspect its state and continue from the confirmed step");
  if (op.operation === "nav_mint_at_nav") {
    facilityReady(config, state);
    if (state.pool.pricing_nav_epoch !== op.epoch || state.pool.pricing_reserve_packet_hash !== op.reserve_packet_hash) throw new Error("Install the route policy for the new finalized NAV before the opening top-up");
  }
  if (op.operation !== "nav_reserve_submit") {
    const packet = state.proof.packets.find(p => p.epoch === op.epoch && p.reserve_packet_hash === op.reserve_packet_hash);
    if (!packet || (op.operation === "nav_mint_at_nav" && packet.state !== "finalized")) throw new Error("Previous opening step is not confirmed on chain");
  }
}
export function verifyMint(config, intent, before, after) {
  const op = intent.operation, deltas = balanceDeltas(before, after, config);
  if (op.operation === "nav_mint_at_nav") {
    const from = before.recipientLines || before.balances.assets, to = after.recipientLines || after.balances.assets;
    if (integer(after.supply) - integer(before.supply) !== integer(op.amount) || lineBalance(to, config.b23_asset_id) - lineBalance(from, config.b23_asset_id) !== integer(op.amount)) throw new Error("Opening mint supply and holder credit are not verified");
  } else {
    const packet = after.proof.packets.find(p => p.epoch === op.epoch && p.reserve_packet_hash === op.reserve_packet_hash);
    if (!packet || (op.operation === "nav_epoch_finalize" && packet.state !== "finalized")) throw new Error("Reserve packet state is not verified");
    if (integer(before.supply) !== integer(after.supply)) throw new Error("Reserve submission/finalization unexpectedly changed supply");
  }
  return { deltas, message: `${op.operation} accepted and its state change verified.` };
}
export function validateFeeOperation(operation, config, state, bps) {
  facilityReady(config, state);
  const x = safeInteger(bps, "Redemption fee");
  if (x > 500) throw new Error("Redemption fee must be between 0 and 500 bps");
  const p = operation?.next_primary_market_policy;
  if (operation?.operation !== "pftl_uniswap_route_epoch_advance" || operation.route_id !== config.route_id || operation.operator !== config.issuer_address || operation.prior_route_epoch !== state.pool.route_epoch || operation.next_route_epoch !== state.pool.route_epoch + 1 || !operation.live_value_enabled || !p || p.policy_epoch !== state.pool.policy_epoch + 1 || p.redeem_multiplier_bps !== 10000 - x || p.spread_recipient !== config.management_address || !p.spread_recipient) throw new Error("Prepared fee operation does not match the requested route, epoch, recipient, and fee");
  if (p.pricing_nav_epoch !== state.pool.pricing_nav_epoch || p.pricing_reserve_packet_hash !== state.pool.pricing_reserve_packet_hash || !/^[0-9a-f]{96}$/.test(p.policy_hash) || !/^[0-9a-f]{96}$/.test(operation.next_route_config_digest)) throw new Error("Prepared fee operation has stale NAV or missing policy commitments");
  if (integer(state.pool.active_reservation_count) || integer(state.pool.export_entitlement_count)) throw new Error("Finish active reservations and export entitlements before changing the fee");
  return { kind: "asset", operation };
}
export function verifyFee(config, intent, before, after) {
  const op = intent.operation, deltas = balanceDeltas(before, after, config);
  if (after.pool.route_epoch !== op.next_route_epoch || after.pool.policy_hash !== op.next_primary_market_policy.policy_hash || after.pool.redeem_multiplier_bps !== op.next_primary_market_policy.redeem_multiplier_bps || after.pool.spread_recipient !== config.management_address) throw new Error("New fee policy is not visible on the live route");
  if (integer(before.supply) !== integer(after.supply) || integer(before.pool.settlement_reserve_atoms) !== integer(after.pool.settlement_reserve_atoms) || BigInt(deltas.B23) || BigInt(deltas.PFUSDC)) throw new Error("Fee change unexpectedly moved assets");
  return { deltas, message: "New redemption fee verified on the advanced route epoch. No redeploy was required." };
}
