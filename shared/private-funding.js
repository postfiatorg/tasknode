import { assetId, publicAccount, isU64 } from './private-payment.js';

export const fundingAlgorithm = 'ML-DSA-65';
export const exactFields = (obj, names) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === names.length && names.every(name => Object.hasOwn(obj, name));
export const lowerHex = (value, length) => typeof value === 'string' && value.length === length && !/[^0-9a-f]/.test(value);
export const termFields = ['chain_id', 'genesis_hash', 'protocol_version', 'address_namespace', 'transaction_kind',
  'signature_algorithm_id', 'source', 'fee', 'sequence', 'operation', 'owner', 'issuer', 'asset_id', 'amount'];
export const intentFields = ['output_commitments', 'ciphertext_hashes', 'nullifiers'];
const positive = n => Number.isSafeInteger(n) && n > 0;

export function validFunding(unsigned) {
  if (!exactFields(unsigned, ['terms', 'intent'])) return false;
  const { terms: t, intent } = unsigned;
  return exactFields(t, termFields) && exactFields(intent, intentFields) &&
    typeof t.chain_id === 'string' && t.chain_id.length > 0 && !/[\r\n]/.test(t.chain_id) &&
    lowerHex(t.genesis_hash, 96) && positive(t.protocol_version) &&
    t.address_namespace === 'postfiat.address.v1' && t.signature_algorithm_id === fundingAlgorithm &&
    t.operation === 'asset_burn' && t.transaction_kind === t.operation &&
    typeof t.source === 'string' && publicAccount.test(t.source) && t.owner === t.source &&
    typeof t.issuer === 'string' && publicAccount.test(t.issuer) && typeof t.asset_id === 'string' && assetId.test(t.asset_id) &&
    [t.amount, t.fee, t.sequence].every(n => isU64(n) && BigInt(n) > 0n) && intentFields.every(field => {
      const pair = intent[field], length = field === 'ciphertext_hashes' ? 96 : 64;
      return Array.isArray(pair) && pair.length === 2 && lowerHex(pair[0], length) && lowerHex(pair[1], length);
    });
}

export function validFundingAuthorization(auth) {
  return exactFields(auth, ['unsigned', 'algorithm_id', 'public_key_hex', 'signature_hex']) &&
    validFunding(auth.unsigned) && auth.algorithm_id === fundingAlgorithm &&
    lowerHex(auth.public_key_hex, 3904) && lowerHex(auth.signature_hex, 6618);
}
