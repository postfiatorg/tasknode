export const config = { b23_asset_id: "a".repeat(96), pfusdc_asset_id: "b".repeat(96), proof_profile: "c".repeat(96), route_id: "synthetic-b23-route", issuer_address: "pf" + "1".repeat(40), alice_holder_address: "pf" + "2".repeat(40), management_address: "pf" + "3".repeat(40), g1_passed: true };
export const bob = "pf" + "4".repeat(40);
export function lines(b23 = 100_000_000, pfusdc = 200_000_000) { return { truncated: false, lines: [{ asset_id: config.b23_asset_id, balance: b23 }, { asset_id: config.pfusdc_asset_id, balance: pfusdc }] }; }
export function state() {
  const nav = { state: "finalized", epoch: 2, reserve_packet_hash: "d".repeat(96), nav_per_unit: 1_000_000 };
  return { supply: 1_000_000_000, nav, proof: { asset_id: config.b23_asset_id, current_height: 100, packets: [nav] },
    pool: { route_id: config.route_id, native_nav_asset_id: config.b23_asset_id, settlement_asset_id: config.pfusdc_asset_id, live_value_enabled: true, paused: false, invariant_holds: true,
      settlement_reserve_atoms: 500_000_000, available_redeem_atoms: 500_000_000, min_order_atoms: 1, max_order_atoms: 1_000_000_000,
      redeem_multiplier_bps: 9980, spread_recipient: config.management_address, pricing_nav_epoch: 2, pricing_reserve_packet_hash: nav.reserve_packet_hash,
      route_epoch: 2, policy_epoch: 2, policy_hash: "e".repeat(96), policy_valid_from_height: 1, policy_expires_at_height: 10000, active_reservation_count: 0, export_entitlement_count: 0 },
    balances: { address: bob, pft: { balance: 500000 }, assets: lines() }, offers: { offers: [], truncated: false }, managementLines: lines(0, 0), recipientLines: null,
  };
}
export function equityPlan() {
  const packet = { schema: "postfiat.b23.account_equity.v1", source_field: "securitiesAccount.currentBalances.liquidationValue", valuation_unit: "usd_1e6", scale_atoms_per_usd: 1000000, adjustments: [], liquidation_value_atoms: 2_000_000_000, liquidation_value_usd: "2000.00", cutoff_at_utc: "2026-11-12T18:15:00Z", observed_at_utc: "2026-11-12T18:15:06Z", account_commitment_sha256: "f".repeat(64), packet_hash: "f".repeat(96) };
  const base = { issuer: config.issuer_address, asset_id: config.b23_asset_id, epoch: 3, reserve_packet_hash: packet.packet_hash };
  return { packet, pfdep_retired: true, current_supply_atoms: 1_000_000_000, target_supply_atoms: 2_000_000_000, additional_mint_atoms: 1_000_000_000, operations: [
    { ...base, operation: "nav_reserve_submit", submitter: config.issuer_address, nav_per_unit: 1000000, circulating_supply: 2_000_000_000, verified_net_assets: 2_000_000_000, proof_profile: config.proof_profile, source_root: "a".repeat(96), attestor_root: "b".repeat(96), reserve_accounts: [], sp1_proof_bytes: [], sp1_public_values: [] },
    { ...base, operation: "nav_epoch_finalize" }, { ...base, operation: "nav_mint_at_nav", to: config.alice_holder_address, amount: 1_000_000_000 },
  ] };
}
