import { useCallback, useRef, useEffect, useState } from 'react';
import { ArrowDownToLine, ChartCandlestick, Check, ChevronRight, HandCoins, History, RefreshCw, Send as SendIcon } from 'lucide-react';
import { useNavcoin } from './market/ui.jsx';
import B23Facts from './B23Facts.jsx';
import { ActivityRows, useActivity } from './Activity.jsx';
import { Amount, AssetAvatar, Card, CardHead, Details, Empty, Notice, Skeleton, Spinner } from './ui.jsx';
import { amount, amountParts, usd, valueAt } from './format.js';
import { classifyLines } from './portfolio.js';
import { useGallery } from './gallery/useGallery.js';
import { heldNavValues } from './gallery/model.js';

function JourneyCard({ held, onNavigate, loaded }) {
  const hasCash = held.pfusdc > 0n, hasB23 = held.b23 > 0n;
  const done = loaded ? [hasCash || hasB23, hasCash || hasB23, hasB23] : [false, false, false];
  const next = loaded ? done.findIndex(value => !value) : -2;
  const steps = [
    ['Bridge', 'Connect MetaMask', 'Link the Ethereum account that holds your USDC.'],
    ['Bridge', 'Convert USDC to PFUSDC', 'Deposit on Ethereum; credited here once proven.'],
    ['Market', 'Buy B23', 'Pay with PFUSDC on the order book.'],
  ];
  return <Card className="l1-journey">
    <CardHead eyebrow={next === -2 ? 'Three steps' : next < 0 ? 'All set' : `Step ${next + 1} of 3`} title={next === -1 ? 'You hold B23' : 'Get started'} />
    <nav aria-label="Bob journey"><ol>{steps.map(([target, title, hint], index) => <li key={title}>
      <button type="button" aria-label={`${index + 1} ${title}`} className={`l1-journey-step ${done[index] ? 'is-done' : index === next ? 'is-next' : ''}`} onClick={() => onNavigate(target)}>
        <span className="l1-step-num">{done[index] ? <Check size={13} aria-hidden /> : index + 1}</span>
        <span><b>{title}</b><small>{hint}</small></span>
        <ChevronRight size={16} className="l1-chev" aria-hidden />
      </button>
    </li>)}</ol></nav>
  </Card>;
}

function AssetRow({ code, name, sub, atoms, value, note, loading }) {
  return <div className="l1-asset">
    <AssetAvatar code={code} />
    <div className="l1-asset-name"><span>{code}</span><small>{name}{sub ? ` · ${sub}` : ''}</small></div>
    <div className="l1-asset-val">
      {loading ? <Skeleton width="84px" height={16} /> : <Amount atoms={atoms ?? 0} />}
      {value !== undefined && <small>{value === null ? '—' : usd(value)}</small>}
    </div>
    {note && <div className="l1-asset-sub">{note}</div>}
  </div>;
}

export default function WalletHome({ client, onNavigate = () => {} }) {
  const [balances, setBalances] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const navcoin = useNavcoin(client);
  const gallery = useGallery(client);
  const navcoinRef = useRef(navcoin); navcoinRef.current = navcoin;
  const activity = useActivity(client, 5);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    if (!navcoinRef.current.data && !navcoinRef.current.loading) void navcoinRef.current.refresh();
    try { setBalances(await client.getBalances()); setError(''); }
    catch (failure) { setError(failure.message); }
    finally { setRefreshing(false); }
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
  const config = navcoin.data?.config || null, state = navcoin.data?.state || null;
  const held = classifyLines(lines, config);
  const navHoldings = gallery.coins ? heldNavValues(lines, gallery.coins) : null;
  const b23Holding = navHoldings?.find(item => item.coin.asset_id === config?.b23_asset_id);
  const nav = b23Holding?.coin.latest?.nav_per_unit ?? null;
  const pfusdcValue = config && held.pfusdc != null ? held.pfusdc : config ? 0n : null;
  const b23Value = nav != null ? valueAt(held.b23 ?? 0n, nav) : null;
  const total = balances && config && navHoldings && navHoldings.every(item => item.value !== null) ? (pfusdcValue ?? 0n) + navHoldings.reduce((sum, item) => sum + item.value, 0n) : null;
  const [whole, fraction] = amountParts(total ?? 0n, { min: 2, max: 2 });
  const loading = !balances && !error;
  const others = held.others.filter(item => item.balance > 0n && !gallery.coins?.some(coin => coin.asset_id === item.id));
  return <div className="l1-view l1-home">
    <div className="l1-stack">
      <Card className="l1-portfolio">
        <div className="l1-row" style={{ justifyContent: 'space-between' }}>
          <div className="l1-eyebrow">Total value</div>
          <button type="button" className="l1-btn is-sm is-ghost" onClick={() => { void refresh(); gallery.refresh(); }} disabled={refreshing} aria-label="Refresh balances">{refreshing ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden />}Refresh</button>
        </div>
        <div className="l1-total" aria-live="polite">
          {total === null ? (loading || navcoin.loading || gallery.loading ? <Skeleton width="260px" height={48} /> : <span style={{ fontSize: 28, color: 'var(--l1-muted)', fontWeight: 600 }}>Value unavailable</span>)
            : <><span className="l1-total-cur">$</span>{whole}<span className="l1-amt-frac">{fraction}</span></>}
        </div>
        <p className="l1-total-note">PFUSDC counted at 1 USDC. Each listed NAVCoin uses its own latest finalized NAV. PFT and unlisted assets are not included.{navHoldings?.some(item => item.balance > 0n && item.coin.freshness?.stale) ? ' Includes stale NAV readings.' : ''}</p>
        <div className="l1-actions">
          <button type="button" className="l1-btn is-primary" onClick={() => onNavigate('Bridge')}><ArrowDownToLine size={16} aria-hidden />Add funds</button>
          <button type="button" className="l1-btn" onClick={() => onNavigate('Market')}><ChartCandlestick size={16} aria-hidden />Buy B23</button>
          <button type="button" className="l1-btn" onClick={() => onNavigate('Redeem')}><HandCoins size={16} aria-hidden />Cash in at NAV</button>
          <button type="button" className="l1-btn" onClick={() => onNavigate('Send')}><SendIcon size={16} aria-hidden />Send PFT</button>
        </div>
        {error && <div style={{ marginBottom: 16 }}><Notice tone="danger" role="alert" title="Balances could not be refreshed">{error} {balances && 'Last displayed balances may be stale.'}</Notice></div>}
        <div className="l1-assets" aria-label="Balances">
          <AssetRow code="PFT" name="Post Fiat" sub="pays network fees" atoms={account?.balance} loading={loading} />
          <AssetRow code="PFUSDC" name="USDC on Post Fiat" sub="1:1" atoms={held.pfusdc} loading={loading} value={config ? (pfusdcValue ?? 0n) : undefined} />
          <AssetRow code="B23" name="NAVCoin" sub={nav != null ? `NAV $${amount(nav, { min: 2 })}` : 'Schwab-backed'} atoms={held.b23} loading={loading} value={nav != null ? b23Value : undefined} />
          {navHoldings?.filter(item => item.coin.asset_id !== config?.b23_asset_id && item.balance > 0n).map(item => <AssetRow key={item.coin.asset_id} code={item.coin.name} name="NAVCoin" sub={item.coin.latest ? `NAV $${amount(item.coin.latest.nav_per_unit)}` : 'NAV unavailable'} atoms={item.balance} value={item.value} loading={loading} note={item.coin.freshness?.stale ? 'Stale NAV reading' : undefined} />)}
        </div>
        {others.length > 0 && <div className="l1-asset-more"><Details summary={`Other assets (${others.length})`}>
          {others.map(item => <div key={item.id} className="l1-row" style={{ justifyContent: 'space-between' }}><span>{item.code || 'Asset'} <span className="l1-muted l1-small">{item.id?.slice(0, 10)}…</span></span><Amount atoms={item.balance} precision={item.precision} /></div>)}
        </Details></div>}
      </Card>
      <Card>
        <CardHead eyebrow="Recent" title="Activity"><button type="button" className="l1-link" onClick={() => onNavigate('Activity')}>View all<ChevronRight size={14} aria-hidden /></button></CardHead>
        {activity.rows === null && !activity.error && <div style={{ display: 'grid', gap: 10 }}><Skeleton width="60%" /><Skeleton width="45%" /></div>}
        {activity.error && <p className="l1-muted">History is unavailable right now.</p>}
        {activity.rows?.length === 0 && <Empty icon={History} title="No transactions yet">Your first deposit, order or payment will show here.</Empty>}
        {activity.rows?.length > 0 && <ActivityRows rows={activity.rows.slice(0, 4)} address={client.address} />}
      </Card>
    </div>
    <div className="l1-stack">
      <JourneyCard held={{ pfusdc: held.pfusdc ?? 0n, b23: held.b23 ?? 0n }} onNavigate={onNavigate} loaded={Boolean(balances)} />
      <B23Facts state={state && b23Holding?.coin.latest ? { ...state, nav: b23Holding.coin.latest } : state} config={config} error={navcoin.error} onNavigate={onNavigate} />
    </div>
  </div>;
}
