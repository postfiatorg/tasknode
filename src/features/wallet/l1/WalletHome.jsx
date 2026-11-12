import { useCallback, useEffect, useState } from 'react';
import { formatBalance } from './lib/utils.js';
export default function WalletHome({ client }) {
  const [balances, setBalances] = useState(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setBalances(await client.getBalances()); setError(''); }
    catch (failure) { setError(failure.message); }
  }, [client]);
  useEffect(() => {
    if (!client.unlocked) return undefined;
    let active = true, off;
    void refresh();
    client.subscribe(() => { if (active) void refresh(); }).then(unsubscribe => { if (active) off = unsubscribe; else unsubscribe(); }).catch(() => {});
    return () => { active = false; off?.(); };
  }, [client, refresh]);
  if (!client.unlocked) return <p>Unlock your L1 wallet to see balances.</p>;
  const account = balances?.pft?.account || balances?.pft;
  const lines = Array.isArray(balances?.assets) ? balances.assets : balances?.assets?.lines || [];
  return <div>
    <button type="button" onClick={refresh}>Refresh balances</button>
    {error && <p role="alert">{error} {balances && 'Last displayed balances may be stale.'}</p>}
    <p>PFT balance: <strong>{account?.balance != null ? formatBalance(account.balance) : 'Loading…'}</strong></p>
    {balances && <table><thead><tr><th>Asset</th><th>Balance (atoms)</th></tr></thead><tbody>{lines.map((line, index) => <tr key={line.asset_id || index}><td style={{ overflowWrap: 'anywhere' }}>{line.asset_code || line.currency || line.asset_id}</td><td>{String(line.balance ?? line.balance_atoms ?? 'Unknown')}</td></tr>)}</tbody></table>}
    {balances && !lines.length && <p>No issued asset balances.</p>}
  </div>;
}
