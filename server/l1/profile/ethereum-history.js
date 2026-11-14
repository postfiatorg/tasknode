import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { memoRead } from './rpc.js';
const rpcUrl = 'https://eth.drpc.org';
const iface = new Interface(['function receiptVerifier() view returns (address)', 'function verifyAndAccept(bytes publicValues,bytes proofBytes)', 'event ReceiptAccepted(bytes32 indexed receiptCommitment,bytes32 indexed packetDigest,bytes32 indexed proofNullifier,address recipient,uint256 mintAmountAtoms,uint64 finalizedHeight)']);
async function rpc(method, params) {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); if (!response.ok || value.error || value.result === undefined) throw Error('Ethereum historical publication read unavailable'); return value.result;
}
const hex = n => `0x${n.toString(16)}`;
const deploymentBlock = memoRead(async (address, tip) => {
  let low = 0, high = tip;
  while (low < high) { const middle = Math.floor((low + high) / 2); const code = await rpc('eth_getCode', [address, hex(middle)]); if (code === '0x') low = middle + 1; else high = middle; }
  return low;
}, 24 * 60 * 60 * 1000);
export function decodePublication(input, coin, packet) {
  const parsed = iface.parseTransaction({ data: input }); if (parsed?.name !== 'verifyAndAccept') return false;
  const bytes = parsed.args[0];
  // The legacy V1 receipt schema is 35 static ABI words. Match all three
  // bindings, rather than attaching an arbitrary export to a NAV snapshot.
  if ((bytes.length - 2) / 2 !== 35 * 32) return false;
  const word = n => `0x${bytes.slice(2 + n * 64, 2 + (n + 1) * 64)}`;
  const commitment = value => keccak256(`0x${value}`);
  return word(13) === commitment(coin.asset_id) && BigInt(word(15)) === BigInt(packet.epoch) && word(16) === commitment(packet.reserve_packet_hash) && word(10) === keccak256(toUtf8Bytes(coin.route_id));
}
const publications = memoRead(async route => {
  const result = await rpc('eth_call', [{ to: route.handoff_controller, data: iface.encodeFunctionData('receiptVerifier') }, 'latest']);
  const verifier = iface.decodeFunctionResult('receiptVerifier', result)[0];
  const tip = Number(BigInt(await rpc('eth_blockNumber', []))), start = await deploymentBlock(verifier, tip), rows = [];
  for (let from = start; from <= tip; from += 10000) {
    const logs = await rpc('eth_getLogs', [{ address: verifier, topics: [iface.getEvent('ReceiptAccepted').topicHash], fromBlock: hex(from), toBlock: hex(Math.min(tip, from + 9999)) }]);
    for (const log of logs) {
      if (log.removed) continue;
      const tx = await rpc('eth_getTransactionByHash', [log.transactionHash]);
      const receipt = await rpc('eth_getTransactionReceipt', [log.transactionHash]);
      if (receipt?.status !== '0x1' || receipt.blockHash !== log.blockHash || tx?.to?.toLowerCase() !== verifier.toLowerCase()) continue;
      rows.push({ tx_id: log.transactionHash, input: tx.input, block: Number(BigInt(log.blockNumber)) });
    }
  }
  return rows;
}, 60 * 60 * 1000);
export async function ethereumSnapshotTransactions(coin, packet, route) {
  if (!['a666', 'bmnrc'].includes(coin.slug) || route?.ethereum_chain_id !== 1) return [];
  return (await publications(route)).filter(row => decodePublication(row.input, coin, packet)).map(row => row.tx_id);
}
