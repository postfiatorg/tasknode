import { useCallback, useEffect, useRef, useState } from 'react';
import { Amount, Card, CardHead, IdChip, Notice, Spinner } from '../ui.jsx';
import { resultOf } from '../market/amounts.js';
import { advance, makeJob, walletAssets } from './flow.js';

const labels = { shield: 'Move to private', pay: 'Send privately', exit: 'Move to public' };

export default function PrivateWallet({ client }) {
  const [wallet, setWallet] = useState(null), [job, setJob] = useState(null);
  const [lines, setLines] = useState([]), [snapshot, setSnapshot] = useState(null);
  const [readError, setReadError] = useState(''), [publicError, setPublicError] = useState('');
  const [progress, setProgress] = useState(''), [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('shield'), [assetId, setAssetId] = useState(''), [quantity, setQuantity] = useState('');
  const [metadata, setMetadata] = useState({}), [quantityUnit, setQuantityUnit] = useState('');
  const [recipient, setRecipient] = useState(''), [destination, setDestination] = useState(client.address);
  const lifecycle = useRef(null), readVersion = useRef(0);
  const refresh = useCallback(async (session, signal) => {
    const version = ++readVersion.current;
    const current = () => !signal.aborted && version === readVersion.current;
    await Promise.all([
      session.request('balance', {}, signal).then(value => {
        if (current()) { setSnapshot(value); setReadError(''); }
      }).catch(error => {
        if (current()) { setSnapshot(null); setReadError(error.message + ' Checking balances moves no funds.'); }
      }),
      client.getBalances().then(({ assets }) => {
        if (current()) { setLines(Array.isArray(assets) ? assets : assets?.lines || assets?.assets || []); setPublicError(''); }
      }).catch(() => {
        if (current()) { setLines([]); setPublicError('Public balances could not load. You can still use your available private funds.'); }
      }),
    ]);
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
  // Resolve private-only assets from public ledger metadata. Unrecognized IDs stay usable in atoms.
  useEffect(() => {
    let active = true;
    async function readMissing() {
      const known = new Set(lines.map(line => line.asset_id));
      for (const id of Object.keys(snapshot?.balances || {})) {
        if (!active) break;
        if (known.has(id) || Object.hasOwn(metadata, id)) continue;
        let info;
        try { info = resultOf(await client.call('asset_info', { asset_id: id })).asset; } catch { /* Use atoms when metadata is unavailable. */ }
        if (active) setMetadata(previous => ({ ...previous, [id]: info?.asset_id === id ? info : null }));
        break;
      }
    }
    void readMissing();
    return () => { active = false; };
  }, [client, snapshot, lines, metadata]);
  const assets = walletAssets(lines, snapshot, metadata);
  const pendingIntent = job?.action?.intent_id;
  useEffect(() => {
    if (wallet && pendingIntent) void refresh(wallet, lifecycle.current.signal);
  }, [wallet, pendingIntent, refresh]);
  const reviewedAsset = assets.find(a => a.id === job?.terms?.asset);
  const asset = assets.find(a => a.id === assetId) || assets[0];
  const unit = asset?.id + ':' + asset?.precision;
  const enteredAmount = quantityUnit === unit ? quantity : '';
  async function run(resume = false, dismiss = false) {
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
        if (dismiss) {
          if (['prepare','review'].includes(existing?.phase)) {
            await wallet.save(null); setJob(null);
            setProgress('Unsigned request closed. No funds moved. The prover may reserve the same funding amount for your next review.');
          }
          return;
        }
        const save = async value => { signal.throwIfAborted(); await wallet.save(value); if (!signal.aborted) setJob(value); };
        let current = existing;
        try {
          if (!current) {
            current = makeJob(mode, asset, enteredAmount, mode === 'pay' ? recipient : destination, client.address);
            await save(current);
          }
          const confirm = existing?.phase === 'review' && job?.prepared?.pending_id === existing.prepared.pending_id &&
            job.fee === existing.fee && job.prepared.signing_digest_hex === existing.prepared.signing_digest_hex;
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
        if (!signal.aborted) void refresh(wallet, signal);
      });
    } catch {
      if (!signal.aborted) setProgress('Transfer status is unconfirmed. The wallet could not access its recovery record. Check the existing request and balances before trying again.');
    } finally { if (!signal.aborted) setBusy(false); }
  }
  return <div className="l1-view l1-split is-even">
    <Card className="l1-stack"><CardHead title="Private balance" />
      {snapshot && <><p>Your private address</p><IdChip value={snapshot.address} label="private address" />
        {assets.length ? <dl className="l1-kv">{assets.map(a => <div key={a.id}><dt title={a.id}>{a.label} · {a.id.slice(0, 8)}</dt>
          <dd><span><Amount atoms={a.available} precision={a.precision} /> available</span><small><Amount atoms={a.reserved} precision={a.precision} /> pending / reserved</small></dd></div>)}</dl> : <p>No private funds yet.</p>}</>}
      {!snapshot && !readError && <p><Spinner /> Loading private balance…</p>}
      {(readError || publicError) && <Notice role="alert" tone="warning">{readError || publicError}</Notice>}
      <button type="button" className="l1-btn is-sm" disabled={!wallet || busy} onClick={() => refresh(wallet, lifecycle.current.signal)}>Refresh balances</button>
      <p>Moving in or out shows the amount and public account on chain. Private payments hide the asset, amount, sender and recipient. Privacy is weaker while few people use the pool.</p>
      <p>The trusted prover holds the keys to your private balance.</p>
    </Card>
    <Card className="l1-ticket l1-stack"><CardHead title="Private payments" />
      {job ? <><p>{labels[job.mode]} · {job.phase === 'review' ? 'Ready to sign' : 'Pending request'}</p>
        {job.phase === 'review' && <p>Move <Amount atoms={job.terms.amount} precision={reviewedAsset?.precision ?? 0} unit={reviewedAsset?.label || "asset atoms"} /> to private. Funding fee <Amount atoms={job.fee} unit="PFT" />.</p>}
        <button type="button" className="l1-btn is-primary" disabled={busy || !wallet} onClick={() => run(true)}>{job.phase === 'review' ? 'Sign and move to private' : 'Resume and check status'}</button>
        {['prepare','review'].includes(job.phase) && <button type="button" className="l1-btn" disabled={busy} onClick={() => run(true, true)}>Close unsigned request</button>}</> :
        <form onSubmit={e => { e.preventDefault(); run(); }}>
          <label className="l1-field"><span>Action</span><select aria-label="Action" value={mode} disabled={busy} onChange={e => setMode(e.target.value)}>{Object.entries(labels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label className="l1-field"><span>Asset</span><select aria-label="Asset" value={asset?.id || ''} disabled={busy} onChange={e => setAssetId(e.target.value)}>
            {!assets.length && <option value="">No assets available</option>}{assets.map(a => <option key={a.id} value={a.id}>{a.label} · {a.id.slice(0,12)}</option>)}</select></label>
          <label className="l1-field"><span>Amount</span><input aria-label="Amount" value={enteredAmount} inputMode="decimal" maxLength={40} disabled={busy} onChange={e => { setQuantityUnit(unit); setQuantity(e.target.value); }} />
            {asset && <small>Available {mode === 'shield' ? 'public' : 'private'} balance <Amount atoms={mode === 'shield' ? asset.publicBalance : asset.available} precision={asset.precision} unit={asset.label} /></small>}</label>
          {mode === 'pay' && <label className="l1-field"><span>Recipient private address</span><input value={recipient} maxLength={162} placeholder="pfs1…" disabled={busy} onChange={e => setRecipient(e.target.value)} /></label>}
          {mode === 'exit' && <label className="l1-field"><span>Public destination</span><input value={destination} maxLength={42} disabled={busy} onChange={e => setDestination(e.target.value)} /></label>}
          <button type="submit" className="l1-btn is-primary" disabled={!snapshot || busy || !asset || !enteredAmount}>{mode === 'shield' ? 'Review move to private' : labels[mode]}</button>
        </form>}
      {progress && <Notice role="status">{busy && <Spinner />} {progress}</Notice>}
    </Card>
  </div>;
}
