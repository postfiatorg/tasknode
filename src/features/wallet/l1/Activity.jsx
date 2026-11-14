import { loadConfig } from './market/constants.js';
import { labelActivity } from './activity-model.js';
import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ArrowLeftRight, CircleX, History, RefreshCw } from 'lucide-react';
import { rpcResult } from './lib/rpc-client.js';
import { Amount, Badge, Card, CopyButton, Empty, Mono, Notice, Skeleton, Spinner } from './ui.jsx';

const TITLES = {
  pftl_uniswap_primary_redeem: 'Cash in at NAV', pftl_uniswap_redemption_fund: 'Cash-in reserve funded', pftl_uniswap_route_epoch_advance: 'Cash-in fee changed',
  nav_mint_at_nav: 'Mint at NAV', nav_reserve_submit: 'Reserve packet submitted', nav_epoch_finalize: 'NAV epoch finalized',
};
export function titleFor(row, incoming) {
  const kind = String(row.kind || row.transaction_kind || 'transaction');
  if (['transfer', 'transparent_transfer', 'payment', 'payment_v2'].includes(kind)) return incoming ? 'Received PFT' : 'Sent PFT';
  if (TITLES[kind]) return `${TITLES[kind]}${row.unit ? ` · ${row.unit}` : ''}`;
  if (kind === 'issued_payment') return incoming ? 'Asset deposit received' : 'Asset sent';
  if (kind.startsWith('vault_bridge')) return 'Bridge deposit';
  if (kind.startsWith('offer')) return kind === 'offer_cancel' ? 'Order cancelled' : row.market_side === 'buy' ? `Market buy${row.market_symbol ? ` · ${row.market_symbol}` : ''}` : row.market_side === 'sell' ? `Market sell${row.market_symbol ? ` · ${row.market_symbol}` : ''}` : 'Market order';
  const words = kind.replace(/^pftl_uniswap_/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function useActivity(client, limit = 100) {
  const [rows, setRows] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [coverage, setCoverage] = useState('');
  const load = useCallback(async active => {
    setLoading(true);
    try {
      let result;
      try { result = rpcResult(await client.call('account_tx', { address: client.address, limit })); }
      catch (failure) {
        if (!/duplicate tx_id/.test(failure.message)) throw failure;
        const response = await fetch(`/api/l1/history?address=${encodeURIComponent(client.address)}&limit=${limit}`, { cache: 'no-store' });
        result = await response.json();
        if (!response.ok) throw Error(result.error || 'History recovery unavailable');
      }
      const config = await loadConfig().catch(() => null);
      if (active()) {
        setRows(labelActivity(Array.isArray(result) ? result : result?.rows || result?.transactions || [], config)); setError('');
        setCoverage(result?.source === 'committed_archive' ? `Recent history from blocks ${result.from_height}–${result.to_height}. ${result.coverage}` : '');
      }
    } catch (failure) { if (active()) setError(failure.message); }
    finally { if (active()) setLoading(false); }
  }, [client, limit]);
  useEffect(() => {
    if (!client.unlocked) return undefined;
    let active = true;
    void load(() => active);
    return () => { active = false; };
  }, [client, load]);
  return { rows, error, loading, coverage, reload: () => load(() => true) };
}

export function ActivityRows({ rows, address }) {
  return <div className="l1-activity-list">{rows.map((row, index) => {
    const from = row.from || row.source, to = row.to || row.destination;
    const incoming = to === address && from !== address;
    const rejected = row.accepted === false;
    const kind = String(row.kind || row.transaction_kind || '');
    const isTransfer = ['transfer', 'transparent_transfer', 'payment', 'payment_v2'].includes(kind);
    const Icon = rejected ? CircleX : isTransfer ? (incoming ? ArrowDownLeft : ArrowUpRight) : ArrowLeftRight;
    const counterparty = incoming ? from : to;
    return <article key={`${row.tx_id || index}:${row.block_height || ''}:${row.transaction_index ?? index}:${row.tx_role || ''}:${row.fill_index ?? ''}`} className="l1-tx">
      <span className={`l1-tx-icon ${rejected ? 'is-rejected' : incoming ? 'is-in' : ''}`}><Icon size={17} aria-hidden /></span>
      <div className="l1-tx-main">
        <b>{titleFor(row, incoming)}</b>
        <div className="l1-tx-meta">
          {counterparty && <span>{incoming ? 'From' : 'To'} <Mono value={counterparty} /></span>}
          {row.tx_id && <span className="l1-row" style={{ gap: 2 }}><Mono value={row.tx_id} /><CopyButton value={row.tx_id} label="transaction id" /></span>}
        </div>
        {rejected && <span className="l1-small" style={{ color: 'var(--l1-danger)' }}>Rejected: {row.reject_reason || row.code || 'execution rejected'}</span>}
      </div>
      <div className="l1-tx-side">
        {row.amount != null ? <span className={incoming ? 'is-in' : ''}>{incoming ? '+' : isTransfer ? '−' : ''}<Amount atoms={row.amount} unit={isTransfer ? 'PFT' : row.unit} /></span> : <span />}
        {row.accepted === true ? <Badge tone="success">Accepted</Badge> : rejected ? <Badge tone="danger">Rejected</Badge> : <Badge>Receipt unverified</Badge>}
      </div>
    </article>;
  })}</div>;
}

export default function Activity({ client }) {
  const { rows, error, loading, coverage, reload } = useActivity(client);
  if (!client.unlocked) return <p>Unlock your L1 wallet to see activity.</p>;
  return <div className="l1-view l1-stack">
    <div className="l1-toolbar">
      <div>{loading ? <><Spinner size={14} />Reading transactions…</> : rows ? `${rows.length} transaction${rows.length === 1 ? '' : 's'}` : ''}</div>
      <button type="button" className="l1-btn is-sm is-ghost" onClick={reload} disabled={loading}><RefreshCw size={14} aria-hidden />Refresh</button>
    </div>
    {error && <Notice tone="danger" role="alert" title="Activity could not be read from the chain">{error}</Notice>}
    {coverage && <p className="l1-small l1-muted">{coverage}</p>}
    <Card>
      {rows === null && !error && <div style={{ display: 'grid', gap: 18 }}>{[0, 1, 2].map(i => <div key={i} className="l1-row" style={{ gap: 14 }}><Skeleton width="38px" height={38} /><div style={{ flex: 1, display: 'grid', gap: 6 }}><Skeleton width="40%" /><Skeleton width="65%" height={11} /></div></div>)}</div>}
      {rows?.length === 0 && <Empty icon={History} title="No transactions yet">Payments, market orders and cash-ins from this wallet will appear here with their receipts.</Empty>}
      {rows === null && error && <Empty icon={History} title="Nothing to show">The chain did not return this wallet&rsquo;s history. Try again shortly.</Empty>}
      {rows?.length > 0 && <ActivityRows rows={rows} address={client.address} />}
    </Card>
  </div>;
}
