import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { memoRead } from './rpc.js';
import { setTimeout as pause } from 'node:timers/promises';
const iface = new Interface(['function receiptVerifier() view returns (address)', 'function verifyAndAccept(bytes publicValues,bytes proofBytes)', 'event ReceiptAccepted(bytes32 indexed receiptCommitment,bytes32 indexed packetDigest,bytes32 indexed proofNullifier,address recipient,uint256 mintAmountAtoms,uint64 finalizedHeight)']);
export async function readPublicationRpc(method, params, fetcher = fetch) {
  let failure;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetcher('https://ethereum-rpc.publicnode.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const value = await response.json();
      // Public RPC backends intermittently return null for indexed, mined receipts.
      // An incomplete read is never a negative publication result to cache.
      if (!response.ok || value.error || value.result == null) throw Error(`Ethereum history ${method} unavailable`);
      return value.result;
    } catch (error) { failure = error; if (attempt < 4) await pause(100 * (attempt + 1)); }
  }
  throw failure;
}
const rpc = readPublicationRpc;
export function publicationAccepted(tx, receipt, txId, verifier) {
  if (!tx || !receipt || tx.hash?.toLowerCase() !== txId.toLowerCase() || receipt.transactionHash?.toLowerCase() !== txId.toLowerCase() || !receipt.blockHash || receipt.blockHash !== tx.blockHash) throw Error('Ethereum publication response is incomplete or inconsistent');
  return receipt.status === '0x1' && tx.to?.toLowerCase() === verifier.toLowerCase() && receipt.logs.some(log => log.address.toLowerCase() === verifier.toLowerCase() && log.topics[0] === iface.getEvent('ReceiptAccepted').topicHash);
}
export function decodePublication(input, coin, packet) {
  const parsed = iface.parseTransaction({ data: input }); if (parsed?.name !== 'verifyAndAccept') return false;
  const bytes = parsed.args[0];
  // The V1 and V2 receipt schemas share these 35 static ABI words. Match all
  // bindings, rather than attaching an arbitrary export to a NAV snapshot.
  if ((bytes.length - 2) / 2 !== 35 * 32) return false;
  const word = n => `0x${bytes.slice(2 + n * 64, 2 + (n + 1) * 64)}`;
  const commitment = value => keccak256(`0x${value}`);
  return word(13) === commitment(coin.asset_id) && BigInt(word(15)) === BigInt(packet.epoch) && word(16) === commitment(packet.reserve_packet_hash) && word(10) === keccak256(toUtf8Bytes(coin.route_id));
}
const publications = memoRead(async controller => {
  const result = await rpc('eth_call', [{ to: controller, data: iface.encodeFunctionData('receiptVerifier') }, 'latest']);
  const verifier = iface.decodeFunctionResult('receiptVerifier', result)[0], rows = [], seen = new Set();
  let params = new URLSearchParams({ filter: 'to' }), pages = 0;
  do {
    // Explorer results only discover transaction IDs. Every included link is
    // independently checked against Ethereum RPC calldata and accepted logs.
    const response = await fetch(`https://eth.blockscout.com/api/v2/addresses/${verifier}/transactions?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Ethereum transaction index unavailable');
    const page = await response.json();
    if (!Array.isArray(page.items)) throw Error('Ethereum transaction index incomplete');
    for (const item of page.items) {
      if (item.method !== iface.getFunction('verifyAndAccept').selector && !item.raw_input?.startsWith(iface.getFunction('verifyAndAccept').selector)) continue;
      if (!/^0x[0-9a-f]{64}$/i.test(item.hash) || seen.has(item.hash)) continue;
      seen.add(item.hash);
      const tx = await rpc('eth_getTransactionByHash', [item.hash]);
      const receipt = await rpc('eth_getTransactionReceipt', [item.hash]);
      if (!publicationAccepted(tx, receipt, item.hash, verifier)) continue;
      rows.push({ tx_id: item.hash, input: tx.input, block: Number(BigInt(receipt.blockNumber)) });
    }
    params = page.next_page_params ? new URLSearchParams({ ...page.next_page_params, filter: 'to' }) : null;
    pages++;
    if (params && pages >= 50) throw Error('Ethereum publication index exceeded the available page window');
  } while (params);
  return rows;
}, 60 * 60 * 1000);
export async function ethereumSnapshotTransactions(coin, packet, route) {
  if (coin.retired || route?.ethereum_chain_id !== 1) return [];
  return (await publications(route.handoff_controller)).filter(row => decodePublication(row.input, coin, packet)).map(row => row.tx_id);
}
