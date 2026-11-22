import { sha3_384 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { intentFields, termFields, validFunding } from '../../../../../shared/private-funding.js';
import { CHAIN_ID, GENESIS_HASH, PROTOCOL_VERSION } from '../lib/utils.js';

const utf8 = new TextEncoder();
export const fundingContext = utf8.encode('postfiat-l1-v2/tx/v1');

export function fundingDigest(unsigned) {
  if (!validFunding(unsigned)) throw Error('Invalid shield funding terms or intent.');
  const { terms, intent } = unsigned;
  const lines = ['postfiat.asset_transaction.v1', ...termFields.map(field => field + '=' + terms[field])];
  const hash = sha3_384.create().update(utf8.encode('postfiat.asset_orchard.transfer.funding.v1\0'));
  for (const field of [lines.join('\n') + '\n', ...intentFields.flatMap(name => intent[name])]) {
    const bytes = utf8.encode(field), length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length), true);
    hash.update(length).update(bytes);
  }
  return hash.digest();
}

export function shieldAuthorization(prepared, requested, signDigest) {
  const unsigned = prepared?.unsigned_funding, terms = unsigned?.terms;
  if (!validFunding(unsigned) || terms.chain_id !== CHAIN_ID || terms.genesis_hash !== GENESIS_HASH ||
      terms.protocol_version !== PROTOCOL_VERSION || terms.source !== requested.account ||
      terms.issuer !== requested.issuer || terms.asset_id !== requested.asset || terms.amount !== requested.amount ||
      (signDigest && terms.fee !== requested.fee)) {
    throw Error('The prepared funding authorization does not match the requested terms.');
  }
  const digest = fundingDigest(unsigned);
  if (bytesToHex(digest) !== prepared.signing_digest_hex) throw Error('The prepared funding digest does not match.');
  if (!signDigest) return { fee: terms.fee };
  return { unsigned, ...signDigest(digest) };
}
