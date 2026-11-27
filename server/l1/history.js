// Read-only recovery for nodes whose account_tx index rejects duplicate receipts.
// Reads committed blocks and their archived transactions; never edits node data.
import { localRpc } from './read-rpc.js';
import { getNavcoinRegistry } from './navcoin-registry.js';
import { assetSymbols, routeSymbols } from '../../src/features/wallet/l1/market/constants.js';
import { CONTENT_KIND, addressFromPublicKey, decodeAnyPointerMemo } from './message-protocol.js';
const GROUPS = ['transactions', 'payments_v2', 'asset_transactions', 'atomic_swap_transactions', 'escrow_transactions', 'nft_transactions', 'offer_transactions'];
const ADDRESS_FIELDS = ['source', 'from', 'to', 'owner', 'account', 'recipient', 'native_recipient', 'settlement_recipient', 'spread_recipient'];

function addressFromHexPubkey(pubkeyHex = '') {
  const hex = String(pubkeyHex || '').trim();
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return '';
  return addressFromPublicKey(Buffer.from(hex, 'hex'));
}

function projectFastPayEffects(block, address, rows) {
  const effects = Array.isArray(block?.fastpay_pre_state_effects) ? block.fastpay_pre_state_effects : [];
  effects.forEach((fence, effectIndex) => {
    const decision = fence?.decision;
    const confirmed = decision?.Confirmed || (decision?.kind === 'confirmed' ? decision : null);
    const cert = fence?.certificate;
    if (!confirmed || !cert || !cert.order) return;
    const orderHash = confirmed.order_digest || confirmed.order_hash || '';
    const certificateDigest = confirmed.certificate_digest || '';
    if (!orderHash) return;
    const from = cert.owner_account || addressFromHexPubkey(cert.owner_pubkey_hex);
    const memos = Array.isArray(cert.order.memos) ? cert.order.memos : [];
    const pointer = memos.map(decodeAnyPointerMemo).find(Boolean) || null;
    const isUnwrap = Boolean(cert.order.to_address && !Array.isArray(cert.order.outputs));
    if (isUnwrap) {
      const to = cert.order.to_address;
      if (from !== address && to !== address) return;
      rows.push({
        tx_id: orderHash, order_hash: orderHash, certificate_digest: certificateDigest || undefined,
        fastpay_lock_id: fence.lock_id, block_height: block.header.height, batch_kind: 'fastpay',
        batch_id: fence.lock_id, transaction_index: effectIndex, transaction_kind: 'owned_unwrap_v3',
        from, to, amount: cert.order.amount, fee: cert.order.fee, sequence: cert.order.nonce,
        memos, tx_role: 'fastpay_unwrap', accepted: true, receipt_code: 'accepted',
        ...(pointer ? { pointer_version: pointer.version, pointer_cid: pointer.cid, pointer_kind: pointer.kindLabel, task_id: pointer.taskId || undefined } : {}),
      });
      return;
    }
    const outputs = Array.isArray(cert.order.outputs) ? cert.order.outputs : [];
    outputs.forEach((output, outputIndex) => {
      const to = output.owner_account || addressFromHexPubkey(output.owner_pubkey_hex);
      if (from !== address && to !== address) return;
      rows.push({
        tx_id: orderHash, order_hash: orderHash, certificate_digest: certificateDigest || undefined,
        fastpay_lock_id: fence.lock_id, block_height: block.header.height, batch_kind: 'fastpay',
        batch_id: fence.lock_id, transaction_index: effectIndex, fill_index: outputIndex,
        transaction_kind: 'owned_transfer_v3', from, to, amount: output.value,
        fee: outputIndex === 0 ? cert.order.fee : 0, sequence: cert.order.nonce, memos,
        tx_role: from === to ? 'fastpay_self_transfer' : 'fastpay_transfer', accepted: true, receipt_code: 'accepted',
        ...(pointer ? {
          pointer_version: pointer.version, pointer_cid: pointer.cid, pointer_kind: pointer.kindLabel,
          task_id: pointer.taskId || undefined,
          ...(pointer.kind === CONTENT_KIND.REWARD && pointer.visibility === 'private' ? { reward_memo_private: true } : {}),
        } : {}),
      });
    });
  });
}

// A Solana deposit is credited by the bridge's proof transaction, not by the wallet, so the
// wallet's address appears only inside the proof's public values: an 8-byte tag, a 227-byte
// header ending in a little-endian count, then one 156-byte record per deposit (deposit id 32,
// 32, recipient 20, amount u64 little-endian, 32, depositor 32). Any other shape yields no rows.
export function solanaDepositCredits(publicValues, address) {
  if (!Array.isArray(publicValues) || publicValues.length < 235) return [];
  const bytes = Buffer.from(publicValues);
  if (bytes.subarray(0, 8).toString('latin1') !== 'PFSOLDP1') return [];
  const count = bytes.readUInt32LE(231);
  if (bytes.length !== 235 + 156 * count) return [];
  const credits = [];
  for (let i = 0; i < count; i++) {
    const record = bytes.subarray(235 + 156 * i, 235 + 156 * (i + 1));
    if (`pf${record.subarray(64, 84).toString('hex')}` !== address) continue;
    credits.push({ deposit_id: record.subarray(0, 32).toString('hex'), amount: record.readBigUInt64LE(84).toString() });
  }
  return credits;
}

const canonical = value => JSON.stringify(value, Object.keys(value).sort());
export function projectHistory({ blocks, archives, receipts }, address, limit = 100, symbols = {}, routes = {}) {
  const batches = new Map(archives.map(entry => [`${entry.batch_kind}:${entry.batch_id}`, entry]));
  const byTx = new Map(), conflicts = new Set();
  for (const receipt of receipts) {
    if (byTx.has(receipt.tx_id) && canonical(byTx.get(receipt.tx_id)) !== canonical(receipt)) conflicts.add(receipt.tx_id);
    byTx.set(receipt.tx_id, receipt);
  }
  const rows = [];
  for (const block of blocks) {
    projectFastPayEffects(block, address, rows);
    if (block.header.batch_kind !== 'transparent') continue;
    const entry = batches.get(`transparent:${block.header.batch_id}`);
    if (!entry) throw Error('History archive is incomplete for this block window');
    const batch = JSON.parse(entry.payload_json);
    if (batch.batch_id !== block.header.batch_id) throw Error('History batch does not match its block');
    const transactions = GROUPS.flatMap(key => batch[key] || []);
    if (transactions.length !== block.receipt_ids.length) throw Error('History transaction count does not match its block');
    transactions.forEach((transaction, index) => {
      const unsigned = transaction.unsigned;
      if (!unsigned) throw Error('History transaction has no signed fields');
      const op = typeof unsigned.operation === 'object' ? { ...unsigned, ...unsigned.operation } : unsigned;
      const txId = block.receipt_ids[index], receipt = byTx.get(txId);
      if (op.transaction_kind === 'solana_bridge_proof_v1') {
        solanaDepositCredits(op.public_values, address).forEach((credit, part) => rows.push({ tx_id: txId, block_height: block.header.height,
          transaction_index: index, fill_index: part, transaction_kind: 'solana_deposit', to: address, amount: credit.amount, unit: 'PFUSDC',
          deposit_id: credit.deposit_id, accepted: conflicts.has(txId) ? null : receipt?.accepted ?? null,
          receipt_code: conflicts.has(txId) ? 'conflicting_receipts' : receipt?.code }));
        return;
      }
      if (!ADDRESS_FIELDS.some(key => op[key] === address)) return;
      const kind = op.transaction_kind === 'transparent_transfer' ? 'transfer' : op.transaction_kind || op.operation || 'transfer';
      const from = op.from || op.source || op.owner;
      const to = op.to || op.recipient || op.native_recipient || op.settlement_recipient;
      const row = { tx_id: txId, block_height: block.header.height, transaction_index: index, transaction_kind: kind,
        from, to, fee: op.fee, sequence: op.sequence, asset_id: op.asset_id,
        unit: symbols[op.asset_id],
        accepted: conflicts.has(txId) ? null : receipt?.accepted ?? null,
        receipt_code: conflicts.has(txId) ? 'conflicting_receipts' : receipt?.code };
      if (['transfer', 'payment', 'payment_v2', 'issued_payment'].includes(kind)) row.amount = op.amount;
      if (kind === 'vault_bridge_burn_to_redeem') {
        row.amount = op.amount_atoms; row.unit = 'PFUSDC'; row.to = undefined;
        row.withdraw_chain = String(op.destination_ref || '').startsWith('solana-spl:') ? 'Solana' : 'Ethereum';
      }
      if (kind === 'pftl_uniswap_primary_redeem') { row.amount = op.nav_amount_atoms; row.unit = routes[op.route_id]; }
      if (['pftl_uniswap_order_reserve', 'pftl_uniswap_primary_subscribe_v2', 'pftl_uniswap_order_release'].includes(kind)) row.unit = routes[op.route_id];
      if (kind === 'offer_create') {
        const buying = symbols[op.taker_pays_asset_id], selling = symbols[op.taker_gets_asset_id];
        if (buying && buying !== 'PFUSDC') { row.market_side = 'buy'; row.market_symbol = buying; }
        else if (selling && selling !== 'PFUSDC') { row.market_side = 'sell'; row.market_symbol = selling; }
      }
      rows.push(row);
    });
  }
  rows.sort((a, b) => b.block_height - a.block_height || b.transaction_index - a.transaction_index);
  return { rows: rows.slice(0, limit), source: 'committed_archive', from_height: blocks.at(0)?.header.height,
    to_height: blocks.at(-1)?.header.height, truncated: rows.length > limit || (blocks.at(0)?.header.height || 0) > 1,
    coverage: 'Signed transactions and direct payments. Older activity, fills of resting orders and indirect credits may be missing.' };
}
export function createHistoryReader(env = process.env, injectedRpc) {
  if (!env.L1_HISTORY_RPC_URL && !env.L1_RELAY_URL) return null;
  const rpc = injectedRpc || localRpc(env);

  let cached = null, pending = null;
  async function snapshot() {
    const status = await rpc('status', {});
    if (cached?.tip === status.block_tip_hash) return cached;
    // Certificates make each block large; 16-block pages stay below the node's
    // 4 MiB transport frame cap. Only fetch new blocks after the first read.
    const tipHeight = Number(status.block_height), firstHeight = Math.max(1, tipHeight - 63);
    let blocks = cached?.blocks.filter(block => block.header.height >= firstHeight) || [];
    const start = blocks.length ? blocks.at(-1).header.height + 1 : firstHeight;
    for (let height = start; height <= tipHeight; height += 16) {
      blocks.push(...(await rpc('blocks', { from_height: height, limit: Math.min(16, tipHeight - height + 1) })).filter(block => block.header.height <= tipHeight));
    }
    if (blocks.length !== tipHeight - firstHeight + 1 || blocks.some((block, i) => block.header.height !== firstHeight + i || (i && block.header.parent_hash !== blocks[i - 1].header.block_hash))) throw Error('History block window is not contiguous');
    const archives = await rpc('batch_archive', { limit: 80 });
    const receipts = await rpc('receipts', { limit: 128 });
    if (blocks.at(-1)?.header.block_hash !== status.block_tip_hash) throw Error('History changed while reading; refresh to read the new block');
    cached = { tip: status.block_tip_hash, blocks, archives, receipts };
    return cached;
  }
  return async (address, limit = 100) => {
    if (!/^pf[0-9a-f]{40}$/.test(address)) throw Error('Invalid history address');
    if (!pending) pending = snapshot().finally(() => { pending = null; });
    const history = await pending;
    const coins = await getNavcoinRegistry();
    const symbols = assetSymbols(coins), routes = routeSymbols(coins);
    return projectHistory(history, address, Math.max(1, Math.min(100, Number(limit) || 100)), symbols, routes);
  };
}
