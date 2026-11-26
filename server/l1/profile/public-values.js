// Canonical PFNAV001 layout: crates/types/src/nav_reserve_public_values.rs.
// In the Nitro NAV program, observation_not_before/after are BLOCK HEIGHTS.
// The reading's Unix time and PCRs are private witness data committed by roots.
export function decodePublicValues(input) {
  if (!input?.length) return null;
  if (!Array.isArray(input) || input.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw Error('Invalid public-value bytes');
  const bytes = Buffer.from(input);
  if (bytes.length !== 584 || bytes.subarray(0, 8).toString() !== 'PFNAV001' || bytes.readUInt32BE(8) !== 1) throw Error('Unsupported public-value schema');
  let offset = 12;
  const hex = n => { const v = bytes.subarray(offset, offset + n).toString('hex'); offset += n; return v; };
  const u64 = () => { const v = bytes.readBigUInt64BE(offset).toString(); offset += 8; return v; };
  const u32 = () => { const v = bytes.readUInt32BE(offset); offset += 4; return v; };
  const v = { schema: 'postfiat.nav_reserve_public_values.v1', pftl_genesis_hash: hex(48), nav_asset_id: hex(48), proof_profile_id: hex(48), valuation_policy_hash: hex(32), source_manifest_hash: hex(48), valuation_unit_id: hex(48) };
  for (const key of ['valuation_scale', 'observation_epoch', 'observation_not_before', 'observation_not_after']) v[key] = u64();
  v.source_observation_root = hex(48);
  for (const key of ['gross_assets', 'total_liabilities', 'verified_net_assets', 'cryptographically_verified_value', 'attested_value', 'controlled_value']) v[key] = u64();
  v.source_count = u32();
  for (const key of ['quantity_trust_counts', 'valuation_trust_counts']) v[key] = { cryptographic: u32(), attested: u32(), controlled: u32() };
  for (const key of ['quantity_trust_root', 'valuation_trust_root', 'source_disclosure_root']) v[key] = hex(48);
  const n = key => BigInt(v[key]);
  if (offset !== bytes.length || n('valuation_scale') === 0n || n('observation_epoch') === 0n || n('observation_not_before') > n('observation_not_after') || v.source_count < 1 || v.source_count > 64 ||
      [v.quantity_trust_counts, v.valuation_trust_counts].some(c => c.cryptographic + c.attested + c.controlled !== v.source_count) ||
      n('gross_assets') - n('total_liabilities') !== n('verified_net_assets') || n('cryptographically_verified_value') + n('attested_value') + n('controlled_value') !== n('verified_net_assets')) throw Error('Inconsistent public values');
  return v;
}

export function boundPublicValues(operation, genesisHash) {
  const bytes = operation?.sp1_public_values;
  if (bytes?.length && Buffer.from(bytes.slice(0, 8)).toString() !== 'PFNAV001') return null;
  const v = decodePublicValues(operation?.sp1_public_values);
  if (v && (v.nav_asset_id !== operation.asset_id || v.proof_profile_id !== operation.proof_profile || v.pftl_genesis_hash !== genesisHash)) throw Error('Public values do not match the submitted asset, profile or genesis');
  return v;
}
