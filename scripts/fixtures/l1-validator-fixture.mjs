import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { L1_BINDING_CONTEXT, L1_CHAIN_ID, L1_NETWORK } from '../../server/l1-validator-identity.js';

export function l1Fixture(now = new Date(), seed) {
  const keys = ml_dsa65.keygen(seed);
  const spare = ml_dsa65.keygen();
  const publicKey = Buffer.from(keys.publicKey).toString('hex');
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0);
  const participation = { time_basis: 'observer_brackets', available: false, historical_clock_available: false, eligible: false,
    window_start: new Date(end - 30 * 86400000).toISOString(), window_end: end.toISOString(), daily: [] };
  const registry = { schema: 'postfiat-tasknode-l1-registry-v1', network: L1_NETWORK, chain_id: L1_CHAIN_ID,
    genesis_hash: 'a'.repeat(96), registry_root: 'b'.repeat(96), generated_at: now.toISOString(), height: 10,
    validators: [{ validator_id: 'validator-0', ml_dsa_public_key: publicKey, active: true, participation },
      { validator_id: 'validator-1', ml_dsa_public_key: Buffer.from(spare.publicKey).toString('hex'), active: true, participation }],
    latest_commit: { height: 10, block_hash: 'c'.repeat(96), precommit_signers: ['validator-0', 'validator-1'] },
    source_heights: ['validator-0', 'validator-1'].map(validator_id => ({ validator_id, height: 10, registry_root: 'b'.repeat(96), block_hash: 'c'.repeat(96) })) };
  return { registry, publicKey, sign: (challenge, context = L1_BINDING_CONTEXT) => Buffer.from(ml_dsa65.sign(new TextEncoder().encode(challenge), keys.secretKey, { context: new TextEncoder().encode(context) })).toString('hex') };
}
