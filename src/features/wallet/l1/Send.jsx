import { useEffect, useState } from 'react';
import { CircleCheck, Send as SendIcon, TriangleAlert } from 'lucide-react';
import { pftInputAtoms } from './lib/tx-builder.js';
import { isValidAddress } from './lib/utils.js';
import { rpcResult } from './lib/rpc-client.js';
import { Amount, Card, CardHead, Empty, IdChip, Mono, Notice, Spinner } from './ui.jsx';
export default function Send({ client }) {
  const [to, setTo] = useState(''); const [amount, setAmount] = useState('');
  const [review, setReview] = useState(null); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [result, setResult] = useState(null);
  const [available, setAvailable] = useState(null);
  useEffect(() => {
    if (!client.unlocked) return undefined;
    let active = true;
    client.getBalances().then(value => { if (active) setAvailable((value.pft?.account || value.pft)?.balance ?? null); }).catch(() => {});
    return () => { active = false; };
  }, [client, result]);
  async function quote() {
    setBusy(true); setError(''); setResult(null); setReview(null);
    try { const intent = { kind: 'transfer', to: to.trim(), amount: pftInputAtoms(amount) }; setReview({ intent, quote: await client.quote(intent) }); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function send() {
    if (!review || busy) return;
    setBusy(true); setError('');
    const approved = review; setReview(null);
    try {
      const before = await client.getBalances();
      const receiverBefore = rpcResult(await client.call('account', { address: approved.intent.to }));
      const signed = await client.sign(approved.intent, approved.quote);
      const receipt = await client.submit(signed);
      setResult({ ...receipt, pendingBalances: true });
      const after = await client.getBalances();
      const receiverAfter = rpcResult(await client.call('account', { address: approved.intent.to }));
      const balance = value => BigInt((value.account || value).balance);
      setResult({ ...receipt, senderDelta: String(balance(after.pft) - balance(before.pft)), receiverDelta: String(balance(receiverAfter) - balance(receiverBefore)), amount: approved.intent.amount, fee: String(approved.quote.minimum_fee) });
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  if (!client.unlocked) return <p>Unlock your L1 wallet to send PFT.</p>;
  const recipientLooksWrong = to.trim() && !isValidAddress(to.trim());
  const matched = result && !result.pendingBalances && result.receiverDelta === result.amount && result.senderDelta === String(-BigInt(result.amount) - BigInt(result.fee));
  return <div className="l1-view l1-split is-even">
    <Card className="l1-ticket">
      <CardHead eyebrow="Transfer" title="Send PFT" />
      <form style={{ display: 'grid', gap: 14 }} onSubmit={event => { event.preventDefault(); if (!busy) void quote(); }}>
        <label className="l1-field"><span>Recipient</span><input aria-label="Recipient pf address" placeholder="pf…" spellCheck={false} autoComplete="off" className="l1-mono-input" value={to} disabled={busy} onChange={e => { setTo(e.target.value); setReview(null); }} />
          {recipientLooksWrong && <span className="l1-field-hint is-danger">A Post Fiat address starts with pf followed by 40 hex characters.</span>}</label>
        <label className="l1-field"><span>Amount</span><span className="l1-input-wrap"><input aria-label="PFT amount" inputMode="decimal" placeholder="0.00" value={amount} disabled={busy} onChange={e => { setAmount(e.target.value); setReview(null); }} /><span className="l1-input-suffix">PFT</span></span>
          <span className="l1-field-hint"><span>{available != null ? <>Available <Amount atoms={available} unit="PFT" /></> : ''}</span><span>Fee quoted before you confirm</span></span></label>
        <button type="submit" className="l1-btn is-primary is-lg is-block" disabled={busy}>Review transfer</button>
      </form>
      {error && <div style={{ marginTop: 14 }}><Notice tone="danger" role="alert">{error}</Notice></div>}
    </Card>
    <div className="l1-stack">
      {!review && !result && !busy && <Card><Empty icon={SendIcon} title="Review before anything is signed">Enter a recipient and amount. You will see the network fee and the total before confirming.</Empty></Card>}
      {busy && !result && <Card><p className="l1-status-line" role="status"><Spinner />Waiting for wallet operation…</p></Card>}
      {review && <Card className="l1-review" aria-label="Review transfer">
        <CardHead eyebrow="Send PFT" title="Review and confirm"><button type="button" className="l1-btn is-sm is-ghost" onClick={() => setReview(null)} disabled={busy}>Discard</button></CardHead>
        <dl className="l1-summary">
          <div><dt>To</dt><dd><Mono value={review.intent.to} head={8} tail={6} /></dd></div>
          <div><dt>Amount</dt><dd><Amount atoms={review.intent.amount} unit="PFT" /></dd></div>
          <div><dt>Network fee</dt><dd><Amount atoms={review.quote.minimum_fee} unit="PFT" /></dd></div>
          <div className="is-total"><dt>Total from your balance</dt><dd><Amount atoms={BigInt(review.intent.amount) + BigInt(review.quote.minimum_fee)} unit="PFT" /></dd></div>
        </dl>
        <button type="button" className="l1-btn is-primary is-lg is-block" disabled={busy} onClick={send}>Confirm and send PFT</button>
      </Card>}
      {result && <Card className="l1-review" aria-label="Transfer result"><div className="l1-outcome">
        <div className="l1-outcome-head">
          <span className={`l1-outcome-icon ${result.pendingBalances || !matched ? 'is-warning' : ''}`}>{result.pendingBalances ? <Spinner size={22} /> : matched ? <CircleCheck size={22} aria-hidden /> : <TriangleAlert size={22} aria-hidden />}</span>
          <div><h4>{result.pendingBalances ? 'Accepted — checking balances' : 'Sent'}</h4><p>Accepted execution receipt from the chain.</p></div>
        </div>
        {result.pendingBalances ? <p className="l1-muted">Receipt accepted; balance changes still unverified.</p> : <>
          <div className="l1-deltas">
            <div className="l1-delta is-down"><small>Your balance</small><span><Amount atoms={result.senderDelta} unit="PFT" sign /></span></div>
            <div className="l1-delta is-up"><small>Recipient balance</small><span><Amount atoms={result.receiverDelta} unit="PFT" sign /></span></div>
          </div>
          <Notice tone={matched ? 'success' : 'warning'}>{matched ? 'Both balance changes match the payment and fee.' : 'Balance changes differ from the expected payment; inspect activity.'}</Notice>
        </>}
        <div className="l1-row"><span className="l1-muted l1-small">Receipt</span><IdChip value={result.txId} label="transaction id" /></div>
      </div></Card>}
    </div>
  </div>;
}
