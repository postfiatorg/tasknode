import { marketReady } from "./constants.js";
import { useRef, useState } from "react";
import { ArrowDownToLine, BookOpen, ListOrdered } from "lucide-react";
import { units } from "./amounts.js";
import { buildCancel, buildOffer, lineBalance, offerProgress, snapshot, verifyOffer } from "./model.js";
import { useNavcoin, WalletNotice } from "./ui.jsx";
import { Amount, Badge, Card, CardHead, Details, Empty, Notice, Skeleton } from "../ui.jsx";
import { amount, plainError, unitPrice } from "../format.js";

import OfferReview from './OfferReview.jsx';
import { planOfferSetup, offerPreflight } from './offer-setup.js';
import { priceSource, quantityForTotal, totalForQuantity, versusNav } from "./pricing.js";

// Plain decimal string for inputs ("10.5"), from atoms.
const plain = atoms => units(atoms).replace(/\.?0+$/, "") || "0";
const toAtoms = value => { const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(String(value).trim()); return match ? BigInt(match[1]) * 1000000n + BigInt((match[2] || "").padEnd(6, "0")) : null; };

function levels(report, config, side) {
  return (report?.offers || []).map(offer => {
    const sell = offer.taker_gets_asset_id === config.b23_asset_id;
    const size = BigInt(sell ? offer.taker_gets_amount_remaining : offer.taker_pays_amount_remaining);
    const total = BigInt(sell ? offer.taker_pays_amount_remaining : offer.taker_gets_amount_remaining);
    return { id: offer.offer_id, side, size, total, price: unitPrice(total, size) };
  }).filter(level => level.size > 0n && level.price !== null)
    .sort((a, b) => side === "ask" ? (a.price < b.price ? -1 : a.price > b.price ? 1 : 0) : (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));
}

// One decimal count for the whole book so the price column lines up.
function bookDecimals(prices) {
  let decimals = 2;
  for (const price of prices) { const fraction = String(price % 1000000n).padStart(6, "0").replace(/0+$/, ""); decimals = Math.max(decimals, Math.min(fraction.length, 6)); }
  return decimals;
}
function Book({ book, config, nav, onPick }) {
  const symbol = config.symbol || "B23";
  const asks = levels(book.asks, config, "ask"), bids = levels(book.bids, config, "bid");
  const places = bookDecimals([...asks, ...bids].map(level => level.price));
  const px = value => amount(value, { min: places, max: places });
  const maxSize = [...asks, ...bids].reduce((max, level) => level.size > max ? level.size : max, 1n);
  const width = size => `${Math.max(4, Number((size * 1000n) / maxSize) / 10)}%`;
  const Row = ({ level, best }) => <button type="button" className={`l1-level is-${level.side} ${best ? (level.side === "ask" ? "is-best" : "is-best-bid") : ""}`} onClick={() => onPick(level)} title={level.side === "ask" ? "Buy this offer" : "Sell into this bid"}>
    <span className="l1-level-price">{px(level.price)}</span><span><Amount atoms={level.size} /></span><span><Amount atoms={level.total} /></span>
    <span className="l1-level-bar" style={{ width: width(level.size) }} aria-hidden />
  </button>;
  const bestAsk = asks[0], bestBid = bids[0];
  return <Card className="l1-book" aria-label="Order book">
    <CardHead eyebrow={`${symbol} / PFUSDC`} title="Order book">{(book.asks.truncated || book.bids.truncated) && <Badge tone="warning">Partial view</Badge>}</CardHead>
    <div className="l1-book-cols"><span>Price</span><span>Size {symbol}</span><span>Total PFUSDC</span></div>
    {asks.length ? [...asks].reverse().map(level => <Row key={level.id} level={level} best={level === bestAsk} />) : <p className="l1-book-empty">No one is selling {symbol} right now.</p>}
    <div className="l1-spread">
      <span className="l1-muted">{bestAsk ? "Best ask" : "NAV reference"}</span>
      <strong>{bestAsk ? px(bestAsk.price) : nav ? `$${amount(nav, { min: 2 })}` : "—"}</strong>
      <span className="l1-muted">{bestAsk && nav ? `NAV $${amount(nav, { min: 2 })}` : bestAsk ? "" : "No sell offers"}{bestAsk && bestBid ? ` · spread ${px(bestAsk.price - bestBid.price)}` : ""}</span>
    </div>
    {bids.length ? bids.map(level => <Row key={level.id} level={level} best={level === bestBid} />) : <p className="l1-book-empty">No buy offers resting.</p>}
    <p className="l1-book-foot">{asks.length ? `Tap an offer to load it into the ticket. Prices are PFUSDC per ${symbol}.` : "Place a buy offer at your price. It rests on the book and fills when a seller meets it."}</p>
  </Card>;
}

function Orders({ report, config, cancel }) {
  const symbol = config.symbol || "B23";
  const offers = report.offers || [];
  return <Card aria-label="Your offers">
    <CardHead eyebrow="Yours" title="Open offers and history">{report.truncated && <Badge tone="warning">First {report.limit}</Badge>}</CardHead>
    {!offers.length ? <Empty icon={ListOrdered} title="No offers from this wallet">Buy and sell offers you place appear here with their fill progress.</Empty> : <div className="l1-orders">{offers.map(offer => {
      const sell = offer.taker_gets_asset_id === config.b23_asset_id, progress = offerProgress(offer);
      const original = BigInt(sell ? offer.original_taker_gets_amount : offer.original_taker_pays_amount);
      const remaining = BigInt(sell ? offer.taker_gets_amount_remaining : offer.taker_pays_amount_remaining);
      const gets = BigInt(offer.original_taker_gets_amount), filledShare = gets > 0n ? Number(((gets - BigInt(offer.taker_gets_amount_remaining)) * 1000n) / gets) / 10 : 0;
      const price = unitPrice(sell ? offer.original_taker_pays_amount : offer.original_taker_gets_amount, original);
      return <div key={offer.offer_id} className="l1-order" title={offer.offer_id}>
        <span className={`l1-order-side ${sell ? "is-sell" : "is-buy"}`}>{sell ? "Sell" : "Buy"}</span>
        <div className="l1-order-main">
          <div><b><Amount atoms={original} unit={symbol} /></b><span className="l1-muted l1-small">at {price === null ? "—" : amount(price, { min: 2 })} PFUSDC · <Amount atoms={remaining} /> left</span></div>
          <div className="l1-progress" aria-hidden><span style={{ width: `${filledShare}%` }} /></div>
          <span className="l1-small l1-muted">{progress.label} · {offer.state}</span>
        </div>
        {cancel && <button type="button" className="l1-btn is-sm" disabled={offer.state !== "open"} onClick={() => cancel(offer)}>Cancel remainder</button>}
      </div>;
    })}</div>}
  </Card>;
}

export default function MarketTab({ client, onNavigate, marketConfig = null, compact = false }) {
  const navcoin = useNavcoin(client, true, marketConfig);
  const symbol = marketConfig?.symbol || navcoin.data?.config?.symbol || "NAVCoin";
  const { data, error, loading, refresh } = navcoin;
  const [side, setSide] = useState("buy"), [quantity, setQuantity] = useState(""), [total, setTotal] = useState(""), [expiration, setExpiration] = useState("0"), [custom, setCustom] = useState("");
  const [request, setRequest] = useState(null), [actionError, setActionError] = useState(""), [planning, setPlanning] = useState(false);
  const revision = useRef(0), latest = useRef(client); latest.current = client;
  function review(intent, description, extra) {
    setRequest({ id: crypto.randomUUID(), accountId: client.accountId, address: client.address, intent, description, symbol, ...extra,
      read: () => snapshot(client, data.config, { recipient: data.config.alice_holder_address }), preflight: (intent, current) => offerPreflight(data.config, intent, current), verify: (intent, before, after, receipt) => verifyOffer(intent, before, after, data.config, receipt) });
  }
  const qtyAtoms = toAtoms(quantity), totalAtoms = toAtoms(total);
  const limit = qtyAtoms && totalAtoms ? unitPrice(totalAtoms, qtyAtoms) : null;
  async function create(event) {
    event.preventDefault(); setActionError(""); setRequest(null); setPlanning(true);
    const ticket = ++revision.current, identity = { accountId: client.accountId, address: client.address };
    try {
      const intent = buildOffer(data.config, client.address, side, quantity, total, expiration, data.state);
      const before = await snapshot(client, data.config, { recipient: data.config.alice_holder_address });
      const setup = await planOfferSetup(client, data.config, intent, before);
      if (ticket !== revision.current || !latest.current.unlocked || identity.address !== latest.current.address || identity.accountId !== latest.current.accountId) return;
      review(intent, side === "buy" ? `A buy offer crosses sell offers at or below your price; a fill is not guaranteed. Any unfilled PFUSDC stays locked in the offer until it fills or you cancel it. This does not create ${symbol}.` : "Existing buy offers at or above your price may fill immediately; the unfilled remainder stays open until filled or cancelled.", {
        setup, title: side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`,
        lockedUnit: side === "buy" ? "PFUSDC" : symbol,
        successText: effects => {
          const filled = BigInt(effects?.received || 0), locked = BigInt(effects?.locked || 0);
          if (side === "buy") return locked > 0n ? `${amount(filled)} ${symbol} bought now. ${amount(locked)} PFUSDC waits on the book until a seller meets your price.` : `${amount(filled)} ${symbol} bought. Fills were checked against your balances.`;
          return locked > 0n ? `${amount(locked)} ${symbol} is offered on the book${BigInt(effects?.received || 0) > 0n ? `; ${amount(effects.received)} PFUSDC received from fills so far` : ""}.` : "Sell offer filled and checked against your balances.";
        },
        summary: side === "buy"
          ? [["You buy", <Amount atoms={qtyAtoms} unit={symbol} />], ["Limit price", limit === null ? "—" : `${amount(limit, { min: 2 })} PFUSDC per ${symbol}`], ["You pay at most", <Amount atoms={totalAtoms} unit="PFUSDC" />, true]]
          : [["You sell", <Amount atoms={qtyAtoms} unit={symbol} />], ["Limit price", limit === null ? "—" : `${amount(limit, { min: 2 })} PFUSDC per ${symbol}`], ["You receive at least", <Amount atoms={totalAtoms} unit="PFUSDC" />, true]],
      });
    } catch (e) { if (ticket === revision.current) setActionError(e.message); }
    finally { setPlanning(false); }
  }
  function cancel(offer) {
    revision.current++;
    setActionError(""); setRequest(null);
    try { review(buildCancel(client.address, offer), "Cancels only the unfilled remainder; earlier fills stay final.", { title: "Cancel offer", successText: "The unfilled remainder was cancelled and refunded to this wallet.", summary: [["Offer", <span className="l1-mono">{String(offer.offer_id).slice(0, 14)}…</span>], ["Refund", <Amount atoms={offer.taker_gets_amount_remaining} unit={offer.taker_gets_asset_id === data.config.b23_asset_id ? symbol : "PFUSDC"} />, true]] }); }
    catch (e) { setActionError(e.message); }
  }
  function pick(level) {
    revision.current++;
    setRequest(null);
    setSide(level.side === "ask" ? "buy" : "sell");
    setCustom(""); setQuantity(plain(level.size)); setTotal(plain(level.total));
  }
  let available = null;
  try { if (data) available = lineBalance(data.balances.assets, side === "buy" ? data.config.market_quote_asset_id : data.config.b23_asset_id); } catch { available = null; }
  const asks = data ? levels(data.book.asks, data.config, "ask") : [];
  const tradingOpen = data && marketReady(data.config, data.state);
  const bids = data ? levels(data.book.bids, data.config, "bid") : [];
  const buying = side === "buy", facing = buying ? asks : bids;
  let navAtoms = null; try { navAtoms = data?.state?.nav ? BigInt(data.state.nav.nav_per_unit) : null; } catch { navAtoms = null; }
  const source = priceSource(facing, toAtoms(custom), navAtoms);
  const shown = limit ?? source.price, versus = versusNav(shown, navAtoms);
  const depth = facing.reduce((sum, level) => sum + level.size, 0n);
  const px = value => amount(value, { min: 2 });
  // The two amounts are linked: type either one and the other follows the price.
  function typeQuantity(value) { setQuantity(value); const result = totalForQuantity(toAtoms(value), facing, source); if (result) setTotal(plain(result.total)); else if (!value) setTotal(""); }
  function typeTotal(value) { setTotal(value); const result = quantityForTotal(toAtoms(value), facing, source); if (result !== null) setQuantity(plain(result)); else if (!value) setQuantity(""); }
  function typeCustom(value) { setCustom(value); const next = priceSource(facing, toAtoms(value), navAtoms), result = totalForQuantity(qtyAtoms, facing, next); if (result) setTotal(plain(result.total)); }
  function useMax() { if (available === null || available <= 0n) return; revision.current++; setRequest(null); if (buying) typeTotal(plain(available)); else typeQuantity(plain(available)); }
  const beyondBook = source.kind === "book" && qtyAtoms && qtyAtoms > depth;
  const short = available !== null && (buying ? totalAtoms : qtyAtoms) && (buying ? totalAtoms : qtyAtoms) > available;
  const Max = <button type="button" className="l1-max" disabled={available === null || available <= 0n} onClick={useMax} title="Use everything available">Max</button>;
  const balanceHint = available === null ? "" : <span className={short ? "is-danger" : ""}>Available <Amount atoms={available} unit={buying ? "PFUSDC" : symbol} /></span>;
  const quantityField = <label className="l1-field"><span>{buying ? "You receive" : "You sell"}</span><span className="l1-input-wrap"><input aria-label={`${symbol} quantity`} inputMode="decimal" placeholder="0.00" value={quantity} onChange={e => typeQuantity(e.target.value)} required /><span className="l1-input-suffix">{!buying && Max}{symbol}</span></span>
    {!buying && <span className="l1-field-hint"><span /><span>{balanceHint}</span></span>}</label>;
  const totalField = <label className="l1-field"><span>{buying ? "You pay" : "You receive"}</span><span className="l1-input-wrap"><input aria-label="PFUSDC total" inputMode="decimal" placeholder="0.00" value={total} onChange={e => typeTotal(e.target.value)} required /><span className="l1-input-suffix">{buying && Max}PFUSDC</span></span>
    {buying && <span className="l1-field-hint"><span /><span>{balanceHint}</span></span>}</label>;
  const visible = request && request.accountId === client.accountId && request.address === client.address && client.unlocked;
  return <div className="l1-view">
    <WalletNotice client={client} error={error} loading={loading} refresh={refresh} data={data} />
    <div className={compact ? "l1-stack" : "l1-split is-ticket"}>
      <div className="l1-stack">
        {!data ? <Card>{loading ? <Skeleton height={300} /> : <Empty icon={BookOpen} title="Market not loaded">Refresh to read the {symbol} order book.</Empty>}</Card> : <Card className="l1-ticket">
          <CardHead eyebrow="Order ticket" title={side === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`} />
          <form onSubmit={create} onChange={() => { revision.current++; setRequest(null); }}>
            <div className="l1-seg" role="radiogroup" aria-label="Market action">
              <label><input type="radio" name="market-side" value="buy" checked={side === "buy"} onChange={() => setSide("buy")} />Buy</label>
              <label><input type="radio" name="market-side" value="sell" checked={side === "sell"} onChange={() => setSide("sell")} />Sell</label>
            </div>
            <div className="l1-price-head">
              <small>{symbol} price</small>
              <div><strong>{shown === null ? "—" : px(shown)}</strong><span>PFUSDC per {symbol}</span>{versus && <Badge tone={versus.tone}>{versus.label}</Badge>}</div>
              <small>{navAtoms ? `NAV $${px(navAtoms)} per ${symbol}` : "NAV not reported yet"}{source.kind === "book" ? <> · <Amount atoms={depth} unit={symbol} /> {buying ? "for sale" : "wanted"} now</> : source.kind === "nav" ? ` · no ${buying ? "sellers" : "buyers"} right now, so this starts at NAV` : source.kind === "custom" ? " · your own price" : ""}</small>
            </div>
            {buying ? <>{totalField}{quantityField}</> : <>{quantityField}{totalField}</>}
            <div className="l1-ticket-lines">
              <div><span>Price</span><b>{limit === null ? "—" : `1 ${symbol} = ${px(limit)} PFUSDC`}</b></div>
              <div><span>{buying ? "Most you pay" : "Least you receive"}</span><b>{totalAtoms ? <Amount atoms={totalAtoms} unit="PFUSDC" /> : "—"}</b></div>
              <div><span>Network fee</span><b>Paid in PFT, shown before you sign</b></div>
            </div>
            {beyondBook && <p className="l1-small l1-muted">Only <Amount atoms={depth} unit={symbol} /> is {buying ? "for sale" : "wanted"} right now. The rest of your order waits on the book at this price.</p>}
            {source.kind !== "book" && limit !== null && <p className="l1-small l1-muted">Your offer waits on the book until a {buying ? "seller" : "buyer"} accepts this price. You can cancel it any time.</p>}
            <Details summary="Advanced"><label className="l1-field"><span>Set my own price (PFUSDC per {symbol})</span><input aria-label="Own price" inputMode="decimal" placeholder={shown === null ? "0.00" : px(shown)} value={custom} onChange={e => typeCustom(e.target.value)} /></label><label className="l1-field"><span>Expires at block (0 = never)</span><input inputMode="numeric" value={expiration} onChange={e => setExpiration(e.target.value)} required /></label></Details>
            {!tradingOpen && <Notice tone="warning" title="Market offers are switched off on this network">Order entry opens once the operator enables the {symbol} market.</Notice>}
            <button type="submit" className="l1-btn is-primary is-lg is-block" disabled={!tradingOpen || planning}>Review {side === "buy" ? "buy offer" : "sell offer"}</button>
          </form>
          {onNavigate && <p className="l1-small l1-muted" style={{ marginTop: 14 }}>Need PFUSDC? <button type="button" className="l1-link" onClick={() => onNavigate("Bridge")}><ArrowDownToLine size={13} aria-hidden />Add PFUSDC from Ethereum</button></p>}
        </Card>}
        {actionError && <Notice tone="danger" role="alert">{plainError(actionError)}</Notice>}
        {visible && <OfferReview key={request.id} client={client} request={request} onComplete={refresh} onCancel={() => setRequest(null)} />}
      </div>
      {!compact && <div className="l1-stack">
        {data ? <>
          <Book book={data.book} config={data.config} nav={data.state?.nav?.nav_per_unit} onPick={pick} />
          <Orders report={data.book.mine} config={data.config} cancel={cancel} />
        </> : <Card>{loading ? <Skeleton height={300} /> : null}</Card>}
      </div>}
    </div>
  </div>;
}
