// Read-only recovery for nodes whose account_tx index rejects duplicate receipts.
// Reads committed blocks and their archived transactions; never edits node data.
import { connect } from 'node:net';
import { deploymentConfig, assetSymbols } from '../../src/features/wallet/l1/market/constants.js';
const GROUPS = ['transactions', 'payments_v2', 'asset_transactions', 'atomic_swap_transactions', 'escrow_transactions', 'nft_transactions', 'offer_transactions'];
const ADDRESS_FIELDS = ['source', 'from', 'to', 'owner', 'account', 'recipient', 'native_recipient', 'settlement_recipient', 'spread_recipient'];
function readRpc(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    let chunks = [], size = 0, complete = false;
    const fail = error => { socket.destroy(); reject(error); };
    socket.setTimeout(60000, () => fail(Error('History read timed out')));
    socket.on('error', fail);
    socket.on('close', () => { if (!complete) reject(Error(`History ${method} connection ended before a complete response`)); });
    socket.on('connect', () => socket.write(JSON.stringify({ version: 'postfiat-local-rpc-v1', id: 'wallet-history', method, params }) + '\n'));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { fail(Error('History response too large')); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      complete = true;
      socket.destroy();
      try { const response = JSON.parse(Buffer.concat(chunks).toString().split('\n')[0]); chunks = [];
        if (response.ok !== true) throw Error(`History ${method} could not be read`);
        resolve(response.result);
      } catch (error) { reject(error); }
    });
  });
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
      if (!ADDRESS_FIELDS.some(key => op[key] === address)) return;
      const txId = block.receipt_ids[index], receipt = byTx.get(txId);
      const kind = op.transaction_kind === 'transparent_transfer' ? 'transfer' : op.transaction_kind || op.operation || 'transfer';
      const from = op.from || op.source || op.owner;
      const to = op.to || op.recipient || op.native_recipient || op.settlement_recipient;
      const row = { tx_id: txId, block_height: block.header.height, transaction_index: index, transaction_kind: kind,
        from, to, fee: op.fee, sequence: op.sequence, asset_id: op.asset_id,
        unit: symbols[op.asset_id],
        accepted: conflicts.has(txId) ? null : receipt?.accepted ?? null,
        receipt_code: conflicts.has(txId) ? 'conflicting_receipts' : receipt?.code };
      if (['transfer', 'payment', 'payment_v2', 'issued_payment'].includes(kind)) row.amount = op.amount;
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
  if (!env.L1_HISTORY_RPC_URL) return null;
  const endpoint = new URL(env.L1_HISTORY_RPC_URL);
  if (endpoint.protocol !== 'tcp:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || !endpoint.port || endpoint.username || endpoint.password) throw Error('History RPC must be a loopback TCP endpoint');
  const rpc = injectedRpc || ((method, params) => readRpc(endpoint, method, params));
  const config = deploymentConfig(env), symbols = assetSymbols(config);
  const routes = { [config.route_id]: config.symbol, ...Object.fromEntries(config.retired_assets.filter(coin => coin.route_id).map(coin => [coin.route_id, coin.symbol])) };
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
    return projectHistory(await pending, address, Math.max(1, Math.min(100, Number(limit) || 100)), symbols, routes);
  };
}
