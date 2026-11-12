import { useState } from 'react';
import { pftInputAtoms } from './lib/tx-builder.js';
import { formatBalance } from './lib/utils.js';
import { rpcResult } from './lib/rpc-client.js';
export default function Send({ client }) {
  const [to, setTo] = useState(''); const [amount, setAmount] = useState('');
  const [review, setReview] = useState(null); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [result, setResult] = useState(null);
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
  return <div style={{ display: 'grid', gap: 12, maxWidth: 680 }}>
    <label>Recipient pf address<input aria-label="Recipient pf address" value={to} disabled={busy} onChange={e => { setTo(e.target.value); setReview(null); }} /></label>
    <label>PFT amount<input aria-label="PFT amount" inputMode="decimal" value={amount} disabled={busy} onChange={e => { setAmount(e.target.value); setReview(null); }} /></label>
    <button type="button" disabled={busy} onClick={quote}>Review fee</button>
    {review && <div><p>Send {formatBalance(review.intent.amount)} PFT to {review.intent.to}</p><p>Fee: {formatBalance(review.quote.minimum_fee)} PFT</p><button type="button" disabled={busy} onClick={send}>Confirm and send PFT</button></div>}
    {busy && <p role="status">Waiting for wallet operation…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div><p>Accepted execution receipt: {result.txId}</p>{result.pendingBalances ? <p>Receipt accepted; balance changes still unverified.</p> : <><p>Sender change: {result.senderDelta} atoms</p><p>Recipient change: {result.receiverDelta} atoms</p><p>{result.receiverDelta === result.amount && result.senderDelta === String(-BigInt(result.amount) - BigInt(result.fee)) ? 'Both balance changes match the payment and fee.' : 'Balance changes differ from the expected payment; inspect activity.'}</p></>}</div>}
  </div>;
}
