import { useEffect, useState } from 'react';
import { rpcResult } from './lib/rpc-client.js';
export default function Activity({ client }) {
  const [rows, setRows] = useState(null); const [error, setError] = useState('');
  useEffect(() => {
    if (!client.unlocked) return undefined;
    let active = true;
    client.call('account_tx', { address: client.address, limit: 100 }).then(response => {
      const result = rpcResult(response);
      if (active) setRows(Array.isArray(result) ? result : result?.rows || result?.transactions || []);
    }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [client]);
  if (!client.unlocked) return <p>Unlock your L1 wallet to see activity.</p>;
  return <div>{error && <p role="alert">{error}</p>}{rows === null && !error && <p>Loading activity…</p>}{rows?.length === 0 && <p>No account transactions.</p>}
    {rows?.map((row, index) => <article key={row.tx_id || index} style={{ overflowWrap: 'anywhere', marginBottom: 16 }}><strong>{row.kind || row.transaction_kind || 'Transaction'}</strong><p>{row.tx_id}</p><p>{row.accepted === true ? 'Accepted' : row.accepted === false ? `Rejected: ${row.reject_reason || row.code || 'execution rejected'}` : 'Receipt unverified'}</p><p>{row.from || row.source} → {row.to || row.destination}</p><p>{row.amount != null ? `${row.amount} atoms` : ''}</p></article>)}
  </div>;
}
