import { useCallback, useEffect, useRef, useState } from 'react';
import { Amount, Card, CardHead, IdChip, Notice, Spinner } from '../ui.jsx';
import { advance, makeJob, walletAssets } from './flow.js';

const labels = { shield: 'Move to private', pay: 'Send privately', exit: 'Move to public' };

export default function PrivateWallet({ client }) {
  const [wallet, setWallet] = useState(null), [job, setJob] = useState(null);
  const [lines, setLines] = useState([]), [snapshot, setSnapshot] = useState(null);
  const [readError, setReadError] = useState(''), [progress, setProgress] = useState(''), [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('shield'), [assetId, setAssetId] = useState(''), [quantity, setQuantity] = useState('');
  const [recipient, setRecipient] = useState(''), [destination, setDestination] = useState(client.address);
  const lifecycle = useRef(null);
  const refresh = useCallback(async (session, signal) => {
    const [priv, pub] = await Promise.allSettled([session.request('balance', {}, signal), client.getBalances()]);
    if (signal.aborted) return;
    setSnapshot(priv.status === 'fulfilled' ? priv.value : null);
    const assets = pub.status === 'fulfilled' ? pub.value.assets : [];
    setLines(Array.isArray(assets) ? assets : assets?.lines || assets?.assets || []);
    setReadError(priv.status === 'rejected' ? priv.reason.message + ' Checking balances moves no funds.' :
      pub.status === 'rejected' ? 'Public balances could not load. You can still use your available private balance.' : '');
  }, [client]);
  useEffect(() => {
    const controller = new AbortController(), { signal } = controller;
    lifecycle.current = controller;
    let opened;
    async function load() {
      opened = await client.openPrivateWallet();
      if (signal.aborted) { opened.close(); return; }
      const pending = await opened.load();
      if (signal.aborted) return;
      setWallet(opened); setJob(pending);
      await refresh(opened, signal);
    }
    load().catch(() => { if (!signal.aborted) setReadError('The wallet could not open its private payment record. Unlock the wallet again to recover its status.'); });
    const changed = e => {
      if (opened && e.key === opened.storageKey) opened.load().then(value => { if (!signal.aborted) setJob(value); }).catch(() => {});
    };
    window.addEventListener('storage', changed);
    return () => { controller.abort(); opened?.close(); window.removeEventListener('storage', changed); };
  }, [client, refresh]);
  const assets = walletAssets(lines, snapshot);
  const asset = assets.find(a => a.id === assetId) || assets[0];
  async function run(resume = false) {
    if (!wallet || busy) return;
    const { signal } = lifecycle.current;
    setBusy(true); setProgress('');
    try {
      await navigator.locks.request(wallet.storageKey, { ifAvailable: true }, async lock => {
        if (!lock) { setProgress('This wallet is processing the transfer in another tab. Check its status there.'); return; }
        const existing = await wallet.load();
        if (signal.aborted) return;
        setJob(existing);
        if (existing && !resume) { setProgress('A previous request is pending. Check its status before starting another.'); return; }
        if (!existing && resume) { setProgress('This request is no longer pending in this browser. Refresh balances.'); return; }
        const save = async value => { signal.throwIfAborted(); await wallet.save(value); if (!signal.aborted) setJob(value); };
        let current = existing;
        try {
          if (!current) {
            current = makeJob(mode, asset, quantity, mode === 'pay' ? recipient : destination, client.address);
            await save(current);
          }
          const confirm = existing?.phase === 'review' && job?.prepared?.pending_id === existing.prepared.pending_id;
          const message = await advance(wallet, current, { confirm, progress: value => { if (!signal.aborted) setProgress(value); }, save, signal });
          if (!signal.aborted) { setProgress(message); setQuantity(''); }
        } catch (failure) {
          if (signal.aborted) return;
          const pending = await wallet.load();
          if (failure.refused) await save(null);
          const beforeSubmit = !pending || ['prepare','review'].includes(pending.phase);
          setProgress(failure.message + (failure.refused || beforeSubmit ? ' The requested transfer did not move funds.' :
            ' Transfer status is unconfirmed. Resume this same request to check whether funds moved.'));
        }
        if (!signal.aborted) await refresh(wallet, signal);
      });
    } catch {
      if (!signal.aborted) setProgress('The wallet could not read or save the recovery record. Check the existing request and balances before trying again.');
    } finally { if (!signal.aborted) setBusy(false); }
  }
  return <div className="l1-view l1-split is-even">
    <Card className="l1-stack"><CardHead title="Private balance" />
      {snapshot && <><p>Your private address</p><IdChip value={snapshot.address} label="private address" />
        {assets.length ? <dl className="l1-kv">{assets.map(a => <div key={a.id}><dt>{a.label}<small>{a.id.slice(0, 12)}</small></dt>
          <dd><Amount atoms={a.available} precision={a.precision} /> available<small><Amount atoms={a.reserved} precision={a.precision} /> pending / reserved</small></dd></div>)}</dl> : <p>No private funds yet.</p>}</>}
      {!wallet && !readError && <p><Spinner /> Opening private wallet…</p>}
      {readError && <Notice role="alert" tone="warning">{readError}</Notice>}
      <button type="button" className="l1-btn is-sm" disabled={!wallet || busy} onClick={() => refresh(wallet, lifecycle.current.signal)}>Refresh balances</button>
      <p>Moving in or out shows the amount and public account on chain. Private payments hide the asset, amount, sender and recipient. Privacy is weaker while few people use the pool.</p>
      <p>The trusted prover holds the keys to your private balance.</p>
    </Card>
    <Card className="l1-ticket l1-stack"><CardHead title="Private payments" />
      {job ? <><p>{labels[job.mode]} · {job.phase === 'review' ? 'Ready to sign' : 'Pending request'}</p>
        {job.phase === 'review' && <p>Move {job.terms.amount} asset atoms to private. Funding fee: <Amount atoms={job.fee} unit="PFT" />.</p>}
        <button type="button" className="l1-btn is-primary" disabled={busy || !wallet} onClick={() => run(true)}>{job.phase === 'review' ? 'Sign and move to private' : 'Resume and check status'}</button></> :
        <form onSubmit={e => { e.preventDefault(); run(); }}>
          <label className="l1-field"><span>Action</span><select aria-label="Action" value={mode} disabled={busy} onChange={e => setMode(e.target.value)}>{Object.entries(labels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label className="l1-field"><span>Asset</span><select aria-label="Asset" value={asset?.id || ''} disabled={busy} onChange={e => setAssetId(e.target.value)}>
            {!assets.length && <option value="">No assets available</option>}{assets.map(a => <option key={a.id} value={a.id}>{a.label} · {a.id.slice(0,12)}</option>)}</select></label>
          <label className="l1-field"><span>Amount</span><input aria-label="Amount" value={quantity} inputMode="decimal" maxLength={40} disabled={busy} onChange={e => setQuantity(e.target.value)} />
            {asset && <small>Available {mode === 'shield' ? 'public' : 'private'} balance <Amount atoms={mode === 'shield' ? asset.publicBalance : asset.available} precision={asset.precision} unit={asset.label} /></small>}</label>
          {mode === 'pay' && <label className="l1-field"><span>Recipient private address</span><input value={recipient} maxLength={162} placeholder="pfs1…" disabled={busy} onChange={e => setRecipient(e.target.value)} /></label>}
          {mode === 'exit' && <label className="l1-field"><span>Public destination</span><input value={destination} maxLength={42} disabled={busy} onChange={e => setDestination(e.target.value)} /></label>}
          <button type="submit" className="l1-btn is-primary" disabled={!snapshot || busy || !asset || !quantity}>{mode === 'shield' ? 'Review move to private' : labels[mode]}</button>
        </form>}
      {progress && <Notice role="status">{busy && <Spinner />} {progress}</Notice>}
    </Card>
  </div>;
}
