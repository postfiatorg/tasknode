import { useState } from "react";
import { ChartCandlestick } from "lucide-react";
import { resultOf, units } from "../market/amounts.js";
import { lineBalance, snapshot } from "../market/model.js";
import { ActionReview, PoolState, useNavcoin, WalletNotice } from "../market/ui.jsx";
import { Amount, Card, CardHead, Notice, Skeleton } from "../ui.jsx";
import { amount, percentFromBps, plainError } from "../format.js";
import { buildRedeem, redeemPreflight, redemptionQuote, verifyRedeem } from "./model.js";
const plain = atoms => units(atoms).replace(/\.?0+$/, "") || "0";
export default function RedeemTab({ client, onNavigate }) {
  const { data, error, loading, refresh } = useNavcoin(client);
  const symbol = data?.config?.symbol || "NAVCoin";
  const [quantity, setQuantity] = useState(""), [request, setRequest] = useState(null), [estimate, setEstimate] = useState(null), [actionError, setActionError] = useState("");
  function review(event) {
    event.preventDefault(); setActionError(""); setRequest(null); setEstimate(null);
    try {
      const { intent, quote } = buildRedeem(data.config, client.address, data.state, quantity);
      setEstimate(quote);
      setRequest({ id: crypto.randomUUID(), accountId: client.accountId, address: client.address, intent,
        title: "Cash in at NAV", symbol,
        successText: `${symbol} was retired at NAV and PFUSDC paid to this wallet from the reserve. Both credits and the reserve change match the receipt.`,
        summary: [["You cash in", <Amount atoms={quote.amount} unit={symbol} />], ["Value at NAV", <Amount atoms={quote.gross} unit="PFUSDC" />], [`Cash-in fee (${percentFromBps(quote.feeBps)})`, <>−<Amount atoms={quote.management} unit="PFUSDC" /></>], ["You receive", <Amount atoms={quote.holder} unit="PFUSDC" />, true]],
        description: `${amount(quote.amount)} ${symbol} is retired. ${amount(quote.holder)} PFUSDC is paid to this wallet and the ${amount(quote.management)} PFUSDC fee to the ${symbol} manager, in one transaction.`,
        read: () => snapshot(client, data.config, { management: true }),
        preflight: (intent, current, prepared) => redeemPreflight(data.config, intent, current, prepared),
        verify: async (intent, before, after, receipt, txId) => {
          // The generic receipt carries no payout detail; the facility receipt read holds both credits.
          let settlement = receipt.redemption_settlement;
          if (!settlement && txId) {
            const facility = resultOf(await client.call("pftl_uniswap_receipt", { tx_id: txId }));
            if (facility?.tx_id !== txId || facility.accepted !== true || facility.owner !== client.address) throw new Error("Cash-in receipt does not match this transaction");
            settlement = facility.consensus_receipt?.redemption_settlement;
          }
          return verifyRedeem(data.config, intent, before, after, { ...receipt, redemption_settlement: settlement });
        },
      });
    } catch (e) { setActionError(e.message); }
  }
  const visibleRequest = request?.accountId === client.accountId && request?.address === client.address && client.unlocked;
  let held = null, preview = null, previewError = "";
  if (data) {
    try { held = lineBalance(data.balances.assets, data.config.b23_asset_id); } catch { held = null; }
    if (quantity.trim()) { try { preview = redemptionQuote(data.config, data.state, quantity); } catch (e) { previewError = e.message; } }
  }
  const pool = data?.state?.pool;
  const capacity = pool ? [BigInt(pool.available_redeem_atoms ?? 0), BigInt(pool.max_order_atoms ?? 0), held ?? BigInt(pool.available_redeem_atoms ?? 0)].reduce((a, b) => a < b ? a : b) : null;
  const overReserve = data && preview === null && previewError && /capacity|Reserve cannot cover/i.test(previewError);
  // Display-only arithmetic so an over-reserve request still shows what it would be worth.
  if (overReserve && data.state?.nav) {
    const typed = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(quantity.trim());
    if (typed) { const atoms = BigInt(typed[1]) * 1000000n + BigInt((typed[2] || "").padEnd(6, "0")); const gross = atoms * BigInt(data.state.nav.nav_per_unit) / 1000000n, holder = gross * BigInt(data.state.pool.redeem_multiplier_bps) / 10000n; preview = { gross, holder, management: gross - holder, estimateOnly: true }; }
  }
  const nav = data?.state?.nav?.nav_per_unit;
  const fee = pool && Number.isSafeInteger(pool.redeem_multiplier_bps) ? 10000 - pool.redeem_multiplier_bps : null;
  if (data?.config.redemption_mode === "unsupported") return <div className="l1-view l1-stack">
    <WalletNotice client={client} error={error} loading={loading} refresh={refresh} data={data} />
    <Card><CardHead title={`Cash in ${symbol}`} /><Notice title="Native cash-in is not available in this wallet">This route does not currently support a verified native cash-in for these holdings. You can sell {symbol} on the order book when a buyer is available.</Notice>
      <p className="l1-section-gap">Route terms: create at NAV +{percentFromBps((pool?.issue_multiplier_bps ?? data.config.issue_multiplier_bps ?? 10000) - 10000)}; cash in at NAV −{percentFromBps(10000 - (pool?.redeem_multiplier_bps ?? data.config.redeem_multiplier_bps ?? 10000))}. These terms do not guarantee redemption availability or the market price.</p>
      <button className="l1-btn" onClick={() => onNavigate("Market")}>Open {symbol} market</button></Card>
  </div>;
  return <div className="l1-view">
    <WalletNotice client={client} error={error} loading={loading} refresh={refresh} data={data} />
    <div className="l1-split">
      <div className="l1-stack">
        {!data ? <Card>{loading ? <Skeleton height={300} /> : <p className="l1-muted">Refresh to read the reserve and NAV.</p>}</Card> : <Card className="l1-ticket">
          <CardHead eyebrow="Cash in" title={`Cash in ${symbol} at NAV`} />
          <form onSubmit={review}>
            <label className="l1-field"><span>{symbol} to cash in</span><span className="l1-input-wrap"><input aria-label={`${symbol} to cash in`} inputMode="decimal" placeholder="0.00" value={quantity} onChange={e => { setQuantity(e.target.value); setRequest(null); setEstimate(null); }} required /><span className="l1-input-suffix">{capacity !== null && capacity > 0n && <button type="button" className="l1-max" onClick={() => { setQuantity(plain(capacity)); setRequest(null); setEstimate(null); }}>Max</button>}{symbol}</span></span>
              <span className="l1-field-hint"><span>{held === null ? "" : <>You hold <Amount atoms={held} unit={symbol} /></>}</span><span className={overReserve ? "is-danger" : ""}>Up to <Amount atoms={pool.available_redeem_atoms} unit={symbol} /> now</span></span></label>
            <dl className="l1-summary" aria-label="Cash-in preview">
              <div><dt>NAV per {symbol}</dt><dd>{nav != null ? `$${amount(nav, { min: 2 })}` : "—"}</dd></div>
              <div><dt>Value at NAV</dt><dd>{preview ? <Amount atoms={preview.gross} unit="PFUSDC" /> : "—"}</dd></div>
              <div><dt>Cash-in fee{fee != null ? ` (${percentFromBps(fee)})` : ""}</dt><dd>{preview ? <>−<Amount atoms={preview.management} unit="PFUSDC" /></> : "—"}</dd></div>
              <div className="is-total"><dt>You receive</dt><dd>{preview ? <Amount atoms={preview.holder} unit="PFUSDC" /> : "—"}</dd></div>
            </dl>
            {overReserve && <Notice tone="danger" title="More than the reserve can pay right now">Cash-ins are paid in full or not at all. Up to <Amount atoms={pool.available_redeem_atoms} unit={symbol} /> can be cashed in at the moment{BigInt(pool.max_order_atoms ?? 0) < BigInt(pool.available_redeem_atoms ?? 0) ? <>, at most <Amount atoms={pool.max_order_atoms} unit={symbol} /> per cash-in</> : ""}.</Notice>}
            {previewError && !overReserve && data.config.g1_passed && <p className="l1-field-hint is-danger">{plainError(previewError)}</p>}
            <button type="submit" className="l1-btn is-primary is-lg is-block" disabled={!data.config.g1_passed || Boolean(overReserve)}>Review cash-in</button>
          </form>
          <p className="l1-small l1-muted" style={{ marginTop: 14 }}>Cash-in pays PFUSDC from the reserve at NAV minus the fee. Selling on the market is a separate process at a price set by buyers{onNavigate ? <> — <button type="button" className="l1-link" onClick={() => onNavigate("Market")}><ChartCandlestick size={13} aria-hidden />open the market</button></> : ""}.</p>
          {estimate && visibleRequest && <p className="l1-small l1-muted" style={{ marginTop: 8 }}>Quote valid until block {Number(estimate.expiry).toLocaleString()}.</p>}
        </Card>}
        {actionError && <Notice tone="danger" role="alert">{plainError(actionError)}</Notice>}
        {visibleRequest && <ActionReview key={request.id} client={client} request={request} onComplete={refresh} onCancel={() => setRequest(null)} />}
      </div>
      {data ? <PoolState state={data.state} config={data.config} /> : <Card>{loading ? <Skeleton height={300} /> : null}</Card>}
    </div>
  </div>;
}
