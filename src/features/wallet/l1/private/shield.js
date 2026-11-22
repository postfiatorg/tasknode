import { CHAIN_ID, GENESIS_HASH, PROTOCOL_VERSION } from '../lib/utils.js';

// The sole adapter between transferd's prepared funding object and native wallet signing.
// Without a signer it returns the fee for review. With a signer it produces /finish authorization.
export function shieldAuthorization(prepared, terms, signFields) {
  const u = prepared?.unsigned_burn;
  if (!u || u.operation !== 'asset_burn' || u.transaction_kind !== 'asset_burn' ||
      u.chain_id !== CHAIN_ID || u.genesis_hash !== GENESIS_HASH || u.protocol_version !== PROTOCOL_VERSION ||
      u.source !== terms.account || u.owner !== terms.account || u.asset_id !== terms.asset || u.issuer !== terms.issuer ||
      u.amount !== terms.amount || u.address_namespace !== 'postfiat.address.v1' || u.signature_algorithm_id !== 'ML-DSA-65' ||
      !Number.isSafeInteger(u.fee) || u.fee < 1 || !Number.isSafeInteger(u.sequence) || u.sequence < 1) {
    throw Error('The prepared funding authorization does not match this wallet and amount.');
  }
  if (!signFields) return { fee: u.fee };
  const { chain_id, genesis_hash, protocol_version, source, fee, sequence, operation, owner, issuer, asset_id, amount } = u;
  const signed = signFields({ chain_id, genesis_hash, protocol_version, source, fee, sequence, operation: { operation, owner, issuer, asset_id, amount } });
  if (!signed?.unsigned || Object.keys(signed.unsigned).length !== Object.keys(u).length ||
      Object.entries(u).some(([key, value]) => signed.unsigned[key] !== value)) throw Error('The wallet could not sign the exact prepared terms.');
  return { signed_burn: signed };
}
