// Public receipt and checkpoint used by the loopback prover and gateway tests.
import { CHAIN_ID, GENESIS_HASH } from '../../src/features/wallet/l1/lib/utils.js';

export const snapshot = { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH, height: 41,
  block_hash: '1'.repeat(96), state_root: '2'.repeat(96), pool_root: '3'.repeat(64) };

export function receiptFor(intent_id) {
  const { height, block_hash, state_root } = snapshot;
  return { intent_id, state: 'accepted', contract_receipt: { intent_id, state: 'accepted', accepted: true,
    inclusion_height: height, block_hash, state_root, finality: { kind: 'validator_quorum_block_certificate_v1',
      height, block_hash, state_root, quorum: 2, validator_count: 2, certificate_json: '{"quorum":2}' } } };
}
