// Where a transaction stands on the chain, read from its committed `tx` record the way verifyPrimary reads it.
// Only the node's typed rpc_tx_not_found answer means missing; any other failure throws, so a recovery
// control never acts on a guess. A record that is not confirmed yet reads as unconfirmed.
export async function chainTxStatus(client, txId) {
  const response = await client.call('tx', { tx_id: txId });
  if (response?.error?.code === 'rpc_tx_not_found') return 'missing';
  if (response?.error || response?.ok === false) throw new Error(response.error?.message || 'L1 read failed');
  const tx = response?.result ?? response;
  if (tx?.tx_id !== txId || tx.confirmed !== true || tx.receipt?.tx_id !== txId || typeof tx.receipt.accepted !== 'boolean') return 'unconfirmed';
  return tx.receipt.accepted ? 'accepted' : 'rejected';
}
