import { vaultBridgeRouteProfileHash } from './bridge-route.js';
import { governedRouteBinding } from './evm.js';
export const address = `pf${'33'.repeat(20)}`;
export const owner = `0x${'44'.repeat(20)}`;
export const asset = '6e'.repeat(48);
export const profile = {
  schema: 'postfiat.vault_bridge.route_profile.v1', route_id: 'ethereum-mainnet-usdc-v1', asset_id: asset,
  source_chain_id: 1, vault_address: `0x${'11'.repeat(20)}`,
  vault_runtime_code_hash: '0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d',
  token_address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  token_runtime_code_hash: '0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d',
  route_epoch: 12, verifier_kind: 'sp1-groth16', evidence_tier: 'receipt-proven', verifier_policy_hash: 'aa'.repeat(32),
  verifier_program_vkey: `0x${'6b'.repeat(32)}`, verifier_proof_encoding: 'groth16',
  max_proof_bytes: 10000, max_public_values_bytes: 10000, max_snapshot_age_blocks: 100,
  challenge_window_blocks: 1, max_epoch_gap_blocks: 10, settle_deadline_blocks: 20, min_challenge_bond: 0,
  min_attestations: 0, minimum_confirmations: 0, activation_height: 1, expires_at_height: 10000,
};
export function routeReport() {
  const hash = vaultBridgeRouteProfileHash(profile);
  return { ok: true, result: {
    schema: 'postfiat.vault_bridge.route_report.v1', active: true,
    chain_id: 'postfiat-wan-devnet-2',
    genesis_hash: 'ce22ca8c932da0998b484483a09647138a30e0bf44408dd49a8d6d452787ad25521aff3ed334da07e150a7233a3e90a9',
    current_height: 100, profile, profile_hash: hash, nav_profile_policy_hash: hash, governance_route_epoch: 12,
    route_binding: governedRouteBinding(hash, 12).slice(2), nav_profile_verifier_kind: 'sp1-groth16',
  } };
}
export function readyPayload() {
  return { ok: true, ready: true, route_id: profile.route_id, source_chain_id: 1, source_proof_kind: 'sp1-ethereum-finality-v1',
    route_profile_hash: vaultBridgeRouteProfileHash(profile), asset_id: asset, vault_address: profile.vault_address,
    token_address: profile.token_address, vault_runtime_code_hash: profile.vault_runtime_code_hash,
    token_runtime_code_hash: profile.token_runtime_code_hash, program_vkey: profile.verifier_program_vkey,
    observer_attestor_enabled: false, prover_authenticated: true, prover_healthy: true,
    beacon_anchor_authenticated: true, beacon_anchor_route_profile_hash: vaultBridgeRouteProfileHash(profile),
    beacon_anchor_route_epoch: 12, route_epoch: 12 };
}
export const jobId = `0x${'ab'.repeat(32)}`;
export const depositTx = `0x${'cd'.repeat(32)}`;
export function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}
