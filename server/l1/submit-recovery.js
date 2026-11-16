import { isDeepStrictEqual } from 'node:util';
import { localRpc } from './read-rpc.js';

const FIELDS = {
  mempool_submit_signed_transfer_finality: 'signed_transfer_json',
  mempool_submit_signed_asset_transaction_finality: 'signed_asset_transaction_json',
  mempool_submit_signed_offer_transaction_finality: 'signed_offer_transaction_json',
};
const GROUPS = ['transactions', 'payments_v2', 'asset_transactions', 'atomic_swap_transactions', 'escrow_transactions', 'nft_transactions', 'offer_transactions'];

// A transport error can follow admission. Recover by reading an exact public
// signed envelope from a committed single-transaction batch. Never resubmit.
export function createSubmitRecovery(env = process.env, injectedRpc) {
  if (!env.L1_HISTORY_RPC_URL && !env.L1_RELAY_URL) return null;
  const rpc = injectedRpc || localRpc(env, 15000);
  return async request => {
    const field = FIELDS[request.method];
    if (!field || typeof request.params[field] !== 'string') return null;
    const signed = JSON.parse(request.params[field]);
    if (!signed?.unsigned || !signed.public_key_hex || !signed.signature_hex) return null;
    const status = await rpc('status', {});
    const domain = ['chain_id', 'genesis_hash', 'protocol_version'];
    if (domain.some(key => signed.unsigned[key] !== status[key])) return null;
    const height = Number(status.block_height), first = Math.max(1, height - 7);
    const blocks = await rpc('blocks', { from_height: first, limit: 8 });
    if (blocks.length !== height - first + 1 || blocks.at(-1)?.header.block_hash !== status.block_tip_hash
      || blocks.some((block, i) => block.header.height !== first + i || (i && block.header.parent_hash !== blocks[i - 1].header.block_hash))) return null;
    const archives = await rpc('batch_archive', { limit: 16 });
    const matches = [];
    for (const block of blocks) {
      if (block.header.batch_kind !== 'transparent' || block.receipt_ids.length !== 1) continue;
      const entries = archives.filter(entry => entry.batch_kind === 'transparent' && entry.batch_id === block.header.batch_id);
      if (entries.length !== 1) continue;
      const batch = JSON.parse(entries[0].payload_json);
      const transactions = GROUPS.flatMap(group => batch[group] || []);
      // No inferred ordering between transaction groups or multi-receipt batches.
      if (batch.batch_id === block.header.batch_id && transactions.length === 1 && isDeepStrictEqual(transactions[0], signed)) matches.push(block);
    }
    if (matches.length !== 1) return null;
    const block = matches[0], txId = block.receipt_ids[0];
    const finality = await rpc('tx', { tx_id: txId });
    // The native hot path verifies the selected block; false here means the
    // entire historical log was not replayed. Preserve that fact in the report.
    const verifiedMode = (finality.verification_mode === 'selected-block-hot-path' && finality.block_log_verified === false)
      || (finality.verification_mode === 'full-block-replay' && finality.block_log_verified === true);
    if (finality.confirmed !== true || !verifiedMode || finality.tx_id !== txId
      || finality.receipt?.tx_id !== txId || typeof finality.receipt?.accepted !== 'boolean'
      || !isDeepStrictEqual(finality.block, block) || finality.receipt_index !== 0 || finality.receipt_count !== 1
      || domain.some(key => finality[key] !== signed.unsigned[key])) return null;
    return { tx_id: txId, finality, recovery: 'exact_signed_envelope_committed_archive' };
  };
}
