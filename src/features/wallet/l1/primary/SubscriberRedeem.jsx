import { useState } from 'react';
import { ActionReview, PoolState } from '../market/ui.jsx';
import { snapshot } from '../market/model.js';
import { units } from '../market/amounts.js';
import { Amount, Card, CardHead, Notice } from '../ui.jsx';
import { percentFromBps } from '../format.js';
import { subscriberQuote, subscriberRedeem, trackedBalance, verifyPrimary } from './model.js';
export default function SubscriberRedeem({ client, data, refresh, onNavigate }) {
  const { config } = data, symbol = config.symbol;
  const [quantity, setQuantity] = useState(''), [request, setRequest] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  let tracked = 0n, preview = null, previewError = '';
  try { tracked = trackedBalance(data.state, client.address); if (quantity) preview = subscriberQuote(config, { ...data.state, balances: data.balances }, quantity, client.address); } catch (e) { previewError = e.message; }
  async function review(e) {
    e.preventDefault(); setError(''); setBusy(true); setRequest(null);
    try {
      const before = await snapshot(client, config), { intent, quote } = subscriberRedeem(config, before, quantity, client.address);
      const step = { kind: 'redeem', intent }, plan = { quote };
      setRequest({ id: crypto.randomUUID(), address: client.address, accountId: client.accountId, intent, symbol, title: `Cash in subscribed ${symbol}`,
        summary: [['You cash in', <Amount atoms={quote.amount} unit={symbol} />], ['Value at NAV', <Amount atoms={quote.gross} unit="PFUSDC" />], [`Cash-in fee (${percentFromBps(quote.feeBps)})`, <>−<Amount atoms={quote.fee} unit="PFUSDC" /></>], ['You receive PFUSDC (S)', <Amount atoms={quote.holder} unit="PFUSDC" />, true]],
        description: `Retire your tracked subscription coins and receive market PFUSDC (S) from the matching reserve. The ${percentFromBps(quote.feeBps)} fee stays in route custody outside NAV. No Schwab withdrawal or Ethereum transfer occurs.`,
        successText: 'Cash-in verified: subscribed coins retired, PFUSDC (S) credited, and the fee retained outside NAV. Supply, tracked holdings and source reserve all match.',
        read: () => snapshot(client, config),
        preflight: (op, current) => {
          const fresh = subscriberQuote(config, current, units(quote.amount), client.address);
          for (const key of ['route_epoch', 'policy_epoch', 'policy_hash', 'pricing_nav_epoch', 'pricing_reserve_packet_hash']) if (current.pool[key] !== intent.operation[key]) throw new Error('Cash-in policy changed; review again');
          if (fresh.holder !== quote.holder || current.proof.current_height >= quote.expiry) throw new Error('Cash-in quote changed or expired');
        },
        verify: (op, prior, after, receipt, txId) => verifyPrimary(client, config, plan, step, prior, after, receipt, txId),
      });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="l1-split"><div className="l1-stack"><Card><CardHead title={`Cash in subscribed ${symbol}`} />
    <p>Your tracked subscription balance: <Amount atoms={tracked} unit={symbol} />. Coins bought on the book or received by transfer do not gain cash-in eligibility. Selling or sending coins does not transfer the route's subscription record to the recipient.</p>
    <form onSubmit={review}><label className="l1-field"><span>{symbol} to cash in</span><input aria-label={`${symbol} to cash in`} value={quantity} onChange={e => { setQuantity(e.target.value); setRequest(null); }} required inputMode="decimal" /></label>
      {preview && <dl className="l1-summary" aria-label="Cash-in preview"><div><dt>Value at NAV</dt><dd><Amount atoms={preview.gross} unit="PFUSDC" /></dd></div><div><dt>Cash-in fee ({percentFromBps(preview.feeBps)})</dt><dd>−<Amount atoms={preview.fee} unit="PFUSDC" /></dd></div><div className="is-total"><dt>You receive PFUSDC (S)</dt><dd><Amount atoms={preview.holder} unit="PFUSDC" /></dd></div></dl>}
      {previewError && <Notice tone="warning">{previewError}</Notice>}
      <button className="l1-btn is-primary" disabled={busy || !preview}>Review cash-in</button></form>
      <p className="l1-small l1-muted">Cash-in depends on the matching PFUSDC source reserve and current NAV policy. Book holdings can be sold when a buyer is available.</p><button className="l1-btn" onClick={() => onNavigate('Market')}>Open {symbol} market</button>
    </Card>{error && <Notice tone="danger">{error}</Notice>}
    {request && <ActionReview key={request.id} client={client} request={request} onCancel={() => setRequest(null)} onComplete={() => { /* Keep accepted evidence visible; Refresh re-reads the page. */ }} />}
    {request && <button className="l1-btn" onClick={refresh}>Refresh holdings</button>}
  </div><PoolState state={data.state} config={config} /></div>;
}
