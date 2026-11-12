import { useState } from "react";
import { units } from "./amounts.js";
import { buildCancel, buildOffer, offerProgress, snapshot, verifyOffer } from "./model.js";
import { ActionReview, useNavcoin, WalletNotice } from "./ui.jsx";
function Offers({ title, report, config, cancel }) {
  return <section className="nc-card"><h3>{title}</h3>{report.truncated && <p>Showing the first {report.limit} offers; this is a partial book.</p>}
    {!report.offers?.length ? <p>No offers in this view.</p> : <div className="nc-table-wrap"><table><thead><tr><th>Side</th><th>Original B23</th><th>Remaining B23</th><th>Remaining PFUSDC</th><th>Fill / state</th>{cancel && <th>Action</th>}</tr></thead>
      <tbody>{report.offers.map(offer => { const sell = offer.taker_gets_asset_id === config.b23_asset_id, progress = offerProgress(offer); return <tr key={offer.offer_id} title={offer.offer_id}>
        <td>{sell ? "Sell" : "Buy"}</td><td>{units(sell ? offer.original_taker_gets_amount : offer.original_taker_pays_amount)}</td>
        <td>{units(sell ? offer.taker_gets_amount_remaining : offer.taker_pays_amount_remaining)}</td><td>{units(sell ? offer.taker_pays_amount_remaining : offer.taker_gets_amount_remaining)}</td>
        <td>{progress.label} / {offer.state}</td>{cancel && <td><button type="button" disabled={offer.state !== "open"} onClick={() => cancel(offer)}>Cancel remainder</button></td>}</tr>; })}</tbody></table></div>}</section>;
}
export default function MarketTab({ client }) {
  const { data, error, loading, refresh } = useNavcoin(client, true);
  const [side, setSide] = useState("buy"), [quantity, setQuantity] = useState(""), [total, setTotal] = useState(""), [expiration, setExpiration] = useState("0");
  const [request, setRequest] = useState(null), [actionError, setActionError] = useState("");
  function review(intent, description) {
    setRequest({ id: crypto.randomUUID(), accountId: client.accountId, address: client.address, intent, description,
      read: () => snapshot(client, data.config), verify: (intent, before, after, receipt) => verifyOffer(intent, before, after, data.config, receipt) });
  }
  function create(event) {
    event.preventDefault(); setActionError(""); setRequest(null);
    try { review(buildOffer(data.config, client.address, side, quantity, total, expiration, data.state), side === "buy" ? "Pay up to the entered PFUSDC total for B23 on the order book. A crossing offer can fill partly or remain open. This does not mint B23." : "Offer B23 from your holder wallet for the entered PFUSDC total. Existing crossing bids may fill immediately; the unfilled remainder stays open."); }
    catch (e) { setActionError(e.message); }
  }
  function cancel(offer) { setActionError(""); setRequest(null); try { review(buildCancel(client.address, offer), "Cancel only the unfilled remainder. Prior fills remain final."); } catch (e) { setActionError(e.message); } }
  return <div className="nc"><h2>B23 / PFUSDC market</h2>
    <ol className="nc-steps" aria-label="Bob journey"><li>Connect MetaMask in the Bridge tab.</li><li>Convert USDC to PFUSDC in the Bridge tab and verify the credited balance.</li><li>Buy B23 here from the order book.</li></ol>
    <p>Alice step 3: use the separate holder wallet to post a sell offer after minting and funding in Issuer.</p>
    <WalletNotice client={client} error={error} loading={loading} refresh={refresh} />
    {data && <><section className="nc-card"><h3>{side === "buy" ? "Buy B23" : "Post sell offer"}</h3><p>Enter B23 quantity and the total PFUSDC consideration. A buy crosses asks at or below this limit price; a fill is not guaranteed. The unfilled offered amount stays locked until filled or cancelled.</p>
      <form onSubmit={create} onChange={() => setRequest(null)}><label>Action<select value={side} onChange={e => setSide(e.target.value)}><option value="buy">Buy B23</option><option value="sell">Post sell offer</option></select></label>
        <label>B23 quantity<input inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} required /></label>
        <label>PFUSDC total<input inputMode="decimal" value={total} onChange={e => setTotal(e.target.value)} required /></label>
        <label>Expiration height (0 = none)<input inputMode="numeric" value={expiration} onChange={e => setExpiration(e.target.value)} required /></label>
        <button type="submit">Review {side === "buy" ? "buy offer" : "sell offer"}</button></form></section>
      <Offers title="Sell offers (asks)" report={data.book.asks} config={data.config} /><Offers title="Buy offers (bids)" report={data.book.bids} config={data.config} />
      <Offers title="Your offers and remainders" report={data.book.mine} config={data.config} cancel={cancel} /></>}
    {actionError && <p role="alert">{actionError}</p>}
    {request && request.accountId === client.accountId && request.address === client.address && client.unlocked && <ActionReview key={request.id} client={client} request={request} onComplete={refresh} />}
  </div>;
}
