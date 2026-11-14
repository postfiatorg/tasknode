import { createHash } from 'node:crypto';
// Same canonical profile ID preimage as types/market_nav_asset_types.rs.
export function proofProfileId(profile) {
  const common = 'verifier_kind source_class max_snapshot_age_blocks challenge_window_blocks max_epoch_gap_blocks settle_deadline_blocks min_challenge_bond min_attestations tolerance_bp'.split(' ');
  const sp1 = 'sp1_program_vkey sp1_proof_encoding max_proof_bytes max_public_values_bytes'.split(' ');
  const v2 = profile.verifier_kind === 'sp1-nav-reserve-v1';
  const keys = v2 ? [...common, 'bridge_observer_min_confirmations', 'valuation_policy_hash', 'vault_bridge_route_policy_hash', ...sp1, 'public_values_schema', 'source_manifest_hash', 'valuation_unit_id', 'max_observation_span_blocks', 'allow_controlled_sources'] : [...common, 'valuation_policy_hash', ...sp1];
  if (!v2 && profile.bridge_observer_min_confirmations) keys.push('bridge_observer_min_confirmations');
  if (!v2 && profile.vault_bridge_route_policy_hash) keys.push('vault_bridge_route_policy_hash');
  const strings = new Set('verifier_kind source_class valuation_policy_hash vault_bridge_route_policy_hash sp1_program_vkey sp1_proof_encoding public_values_schema source_manifest_hash valuation_unit_id'.split(' '));
  const preimage = keys.map(key => `${key}=${profile[key] ?? (strings.has(key) ? '' : key === 'allow_controlled_sources' ? false : 0)}\n`).join('');
  return createHash('sha3-384').update(`postfiat.nav_proof_profile_id.v${v2 ? 2 : 1}\0`).update(preimage).digest('hex');
}
