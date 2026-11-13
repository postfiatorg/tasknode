import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import { Amount, AssetAvatar, Badge, Card, CardHead, Details, IdChip, KV, Notice, Skeleton, Spinner, ViewHeader } from "../ui.jsx";
import { amount, percentFromBps, usd } from "../format.js";
import { loadConfig } from "../market/constants.js";
import Market from "../market/index.jsx";
import { versusNav } from "../market/pricing.js";
import { useGallery } from "./useGallery.js";
import { Freshness, Verification } from "./Verification.jsx";
import NavHistory from "./History.jsx";

function Change({ value }) {
  return value === null || value === undefined ? <span className="l1-muted">No prior NAV</span> : <span>{value > 0n ? "+" : value < 0n ? "−" : ""}{percentFromBps(value < 0n ? -value : value)}</span>;
}

function GalleryRows({ coins, onSelect }) {
  return <Card className="l1-gallery-card">
    <div className="l1-gallery-row is-heading" aria-hidden><span>NAVCoin</span><span>Total value / TVL</span><span>NAV / change</span><span>Verification</span><span>Latest reading</span><span>For sale now</span><span /></div>
    {coins.map(coin => <article key={coin.asset_id} className="l1-gallery-row" aria-label={`${coin.name} NAVCoin`}>
      <div className="l1-gallery-name"><AssetAvatar code={coin.name} /><div><button type="button" className="l1-link" onClick={() => onSelect(coin.slug)}>{coin.name}<ArrowUpRight size={13} aria-hidden /></button><p>{coin.description}</p></div></div>
      <div data-label="TVL"><strong>{usd(coin.latest?.verified_net_assets)}</strong><small>Latest finalized value</small></div>
      <div data-label="NAV per coin"><strong title={usd(coin.latest?.nav_per_unit, { max: 6 })}>{usd(coin.latest?.nav_per_unit)}</strong><small><Change value={coin.change} />{coin.change != null ? " vs prior" : ""}</small></div>
      <div data-label="Verification"><Verification split={coin.split} />{coin.split?.reportedOnly && <small>No independent proof yet</small>}</div>
      <div data-label="Latest reading"><Freshness value={coin.freshness} /></div>
      <div data-label="For sale now"><strong>{coin.depth ? `${coin.depth.partial ? "≥ " : ""}${amount(coin.depth.amount, { min: 0 })}` : "Unavailable"}</strong><small>{coin.name}{coin.depth?.partial ? " · partial book" : ""}</small></div>
      <button type="button" className="l1-btn is-sm" onClick={() => onSelect(coin.slug)} aria-label={`Buy ${coin.name}`}>Buy</button>
      {coin.errors?.length > 0 && <p className="l1-gallery-error l1-small">{coin.errors.join(" · ")}</p>}
    </article>)}
  </Card>;
}

function CoinPage({ coin, client, config, onNavigate, onBack }) {
  const profile = coin.proof?.active_profile, nav = coin.latest;
  const premium = versusNav(coin.depth?.best, nav?.nav_per_unit != null ? BigInt(nav.nav_per_unit) : null);
  const isB23 = coin.asset_id === config?.b23_asset_id;
  const issuer = coin.asset?.issuer;
  const epoch = nav?.epoch;
  const marketConfig = useMemo(() => !config || !issuer ? null : isB23 ? { ...config, reading_epoch: epoch } : {
    ...config, symbol: coin.name, b23_asset_id: coin.asset_id, market_quote_asset_id: coin.market_quote_asset_id,
    route_id: coin.route_id, issuer_address: issuer, alice_holder_address: null, market_only: true, reading_epoch: epoch,
  }, [config, isB23, coin.name, coin.asset_id, coin.market_quote_asset_id, coin.route_id, issuer, epoch]);
  return <>
    <button type="button" className="l1-link l1-gallery-back" onClick={onBack}><ArrowLeft size={15} aria-hidden />All NAVCoins</button>
    <ViewHeader eyebrow="NAVCoin" title={coin.name} subtitle={coin.description} />
    <div className="l1-coin-layout">
      <div className="l1-stack">
        <Card className="l1-coin-price">
          <div className="l1-eyebrow">NAV per {coin.name}</div><strong className="l1-coin-nav">{usd(nav?.nav_per_unit, { max: 6 })}</strong>
          <p className="l1-muted l1-small"><Change value={coin.change} />{coin.change != null ? " since the previous finalized reading" : ""}</p>
          {coin.history.length > 1 && BigInt(coin.history.at(-2).circulating_supply ?? 0) === 0n && <p className="l1-small l1-muted">The previous reading had no coins outstanding; this change is not an investment return.</p>}
          <div className="l1-coin-best"><span>Best price to buy now</span><b>{coin.depth?.best != null ? `${amount(coin.depth.best)} PFUSDC` : coin.depth ? "No sell offers" : "Order book unavailable"}</b>{premium && <Badge tone={premium.tone}>{premium.label}</Badge>}</div>
          <Freshness value={coin.freshness} />
          {coin.freshness?.stale && <Notice tone="warning" title="This NAV reading is stale">It is older than the active proof setting allows. NAV may no longer reflect the current backing value.</Notice>}
          {coin.split?.reportedOnly && <Notice tone="warning" title="No independent proof yet — the operator posts this value" />}
        </Card>
        <Card>
          <CardHead title="What it is" /><p>{coin.description} Each coin represents a portion of the value in its NAV reading. Market prices can differ from NAV.</p>
          <h3 className="l1-section-gap">Methodology</h3><p>{coin.methodology}</p>
        </Card>
        <Card>
          <CardHead title="Verification" /><Verification split={coin.split} detail />
          <KV rows={[
            ["Proof setting", profile?.verifier_kind || "Unavailable"],
            ["Signatures required", profile?.min_attestations ?? "Unavailable"],
            ["Sources in latest packet", nav?.source_count ?? "Unavailable"],
            ["Latest reading", nav ? `Epoch ${nav.epoch} · submitted at block ${Number(nav.submitted_at_height).toLocaleString()}` : "Unavailable"],
            ["Snapshot age limit", profile?.max_snapshot_age_blocks != null ? Number(profile.max_snapshot_age_blocks) === 0 ? "Not set" : `${Number(profile.max_snapshot_age_blocks).toLocaleString()} blocks` : "Unavailable"],
            ["Epoch gap limit", profile?.max_epoch_gap_blocks != null ? Number(profile.max_epoch_gap_blocks) === 0 ? "Not set" : `${Number(profile.max_epoch_gap_blocks).toLocaleString()} blocks` : "Unavailable"],
          ]} />
          <p className="l1-small l1-muted">{profile?.verifier_kind === "placeholder" ? "Placeholder means the chain accepts an operator-posted value without independent proof." : profile?.verifier_kind === "multi-fetch-quorum" ? "A multi-fetch quorum setting uses attestations; the setting alone does not establish attested coverage in this packet." : profile?.verifier_kind?.includes("sp1") ? "This setting uses a zero-knowledge proof verifier. Only the value credited as cryptographically verified is counted as Proven." : "The proof setting describes the verification mechanism. The split above comes from this finalized packet’s trust values."} Finalized means recorded on the chain; it does not by itself prove the assets exist.</p>
        </Card>
        <NavHistory coin={coin} />
      </div>
      <div className="l1-stack">
        {marketConfig ? <Market key={coin.asset_id} client={client} marketConfig={marketConfig} onNavigate={onNavigate} compact /> : <Card><Notice title="Buy ticket unavailable">Market configuration or asset information could not be read.</Notice></Card>}
        <Card>
          <CardHead title="Size and availability" />
          <KV rows={[
            ["Total value (TVL)", usd(nav?.verified_net_assets)],
            ["Coins outstanding now", coin.asset ? <Amount atoms={coin.asset.outstanding_supply} unit={coin.name} precision={coin.asset.precision} /> : "Unavailable"],
            ["Coins at latest NAV reading", nav ? <Amount atoms={nav.circulating_supply} unit={coin.name} /> : "Unavailable"],
            [coin.depth?.partial ? "On offer (partial book)" : "On offer now", coin.depth ? <Amount atoms={coin.depth.amount} unit={coin.name} /> : "Unavailable"],
            coin.route_id && ["Cash-in reserve", coin.pool ? <Amount atoms={coin.pool.settlement_reserve_atoms} unit="PFUSDC" /> : "Unavailable"],
          ]} />
          <p className="l1-small l1-muted">TVL is the latest finalized reading’s net assets. It is not market liquidity or a promise of independent verification. Current supply can change after a reading.</p>
          {isB23 && coin.route_id ? <button type="button" className="l1-link l1-section-gap" onClick={() => onNavigate("Redeem")}>Cash in {coin.name} at NAV<ArrowUpRight size={14} aria-hidden /></button> : <div className="l1-section-gap"><button type="button" className="l1-btn is-sm" disabled>Cash in {coin.name}</button><p className="l1-small l1-muted">{coin.pool?.live_value_enabled === false || coin.pool?.paused ? "This coin’s cash-in route is disabled on the chain." : "Cash in is not supported for this coin in this wallet."}</p></div>}
        </Card>
        <Card><Details summary="Asset and source identifiers"><KV rows={[
          ["Asset", <IdChip value={coin.asset_id} label="asset id" />],
          ["Market quote asset", <IdChip value={coin.market_quote_asset_id} label="quote asset id" />],
          coin.route_id && ["Cash-in route", coin.route_id],
          profile && ["Profile", <IdChip value={profile.profile_id} label="profile id" />],
          profile && ["Source", profile.source_class],
          nav && ["Reserve packet", <IdChip value={nav.reserve_packet_hash} label="packet hash" />],
        ]} /></Details></Card>
      </div>
    </div>
    {coin.errors?.length > 0 && <Notice tone="warning" title="Some live data is unavailable">{coin.errors.join(" · ")}</Notice>}
  </>;
}

export default function Gallery({ client, onNavigate, selectedCoin = null, onSelectCoin }) {
  const gallery = useGallery(client);
  const [config, setConfig] = useState(null);
  useEffect(() => { let active = true; loadConfig().then(value => { if (active) setConfig(value); }).catch(() => {}); return () => { active = false; }; }, []);
  const coin = gallery.coins?.find(item => item.slug === selectedCoin);
  return <div className="l1-view l1-gallery">
    {!selectedCoin && <ViewHeader eyebrow="Discover" title="NAVCoins" subtitle="See the value behind each coin, how it is verified, and what you can buy." />}
    <div className="l1-toolbar"><span>{gallery.loading ? <><Spinner size={14} />Reading chain state…</> : gallery.readAt ? `Live chain data · read ${new Date(gallery.readAt).toLocaleTimeString()} · refreshes every 15 seconds` : "Live chain data"}</span><button type="button" className="l1-btn is-sm is-ghost" onClick={gallery.refresh} disabled={gallery.loading}><RefreshCw size={14} aria-hidden />Refresh NAVCoins</button></div>
    {gallery.error && <Notice tone="danger" role="alert">{gallery.error}</Notice>}
    {!gallery.coins && !gallery.error && <Card><Skeleton height={240} /></Card>}
    {coin ? <CoinPage coin={coin} client={client} config={config} onNavigate={onNavigate} onBack={() => onSelectCoin(null)} /> : gallery.coins && <>
      <div className="l1-gallery-intro"><p><b>NAV</b> is the reported net asset value per coin. <b>TVL</b> is the total net assets in its latest finalized reading. Sorted by largest TVL.</p><p>Proven = cryptographic verification · Attested = signed statements · Reported = no independent proof credited. Finalized does not mean proven.</p></div>
      <GalleryRows coins={gallery.coins} onSelect={onSelectCoin} />
      <p className="l1-small l1-muted l1-section-gap">Changes compare consecutive finalized readings, not daily returns. Ages use block heights; historical block timestamps are unavailable from the wallet RPC. Availability is sell offers in each coin’s PFUSDC market.</p>
    </>}
  </div>;
}
