// B23 at-a-glance panel. Reads nothing itself except the public opening-plan
// artifact, used only to show the Schwab cutoff when it matches the live NAV.
import { useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import { Amount, Badge, Card, CardHead, Details, KV, Mono, Skeleton } from "./ui.jsx";
import { amount, dateTime, percentFromBps, usd, valueAt } from "./format.js";

export function useEquityCutoff(nav) {
  const [packet, setPacket] = useState(null);
  const hash = nav?.reserve_packet_hash;
  useEffect(() => {
    if (!hash) return undefined;
    let active = true;
    fetch("/api/l1/navcoin/equity", { credentials: "same-origin", cache: "no-store" })
      .then(response => response.ok ? response.json() : null)
      .then(body => { if (active) setPacket(body?.packet || null); })
      .catch(() => { if (active) setPacket(null); });
    return () => { active = false; };
  }, [hash]);
  return packet && packet.packet_hash === hash && packet.cutoff_at_utc ? packet.cutoff_at_utc : null;
}

export function feeBps(pool) {
  return Number.isSafeInteger(pool?.redeem_multiplier_bps) ? 10000 - pool.redeem_multiplier_bps : null;
}

export function navValue(state) {
  if (!state?.nav) return null;
  const reported = state.nav.verified_net_assets;
  return reported != null && /^[0-9]+$/.test(String(reported)) && BigInt(reported) > 0n ? BigInt(reported) : valueAt(state.supply, state.nav.nav_per_unit);
}

export default function B23Facts({ state, config, error, compact = false }) {
  const cutoff = useEquityCutoff(state?.nav);
  if (!state) return <Card className="l1-facts">
    <CardHead eyebrow="B23 · NAVCoin" />
    {error ? <p className="l1-muted">B23 market data is unavailable right now.</p> : <div style={{ display: "grid", gap: 10 }}><Skeleton width="45%" height={30} /><Skeleton height={56} /><Skeleton width="80%" /><Skeleton width="70%" /></div>}
  </Card>;
  const pool = state.pool, nav = state.nav, fee = feeBps(pool);
  const value = navValue(state);
  return <Card className="l1-facts" aria-label="B23 summary">
    <CardHead eyebrow="B23 · NAVCoin">{nav ? <Badge tone="accent" dot>NAV final</Badge> : <Badge tone="warning">NAV pending</Badge>}</CardHead>
    <div className="l1-facts-nav">
      <strong>{nav ? `$${amount(nav.nav_per_unit, { min: 2 })}` : "—"}</strong>
      <span className="l1-muted">NAV per B23{nav ? ` · epoch ${nav.epoch}` : ""}</span>
    </div>
    <div className="l1-facts-backing"><Landmark size={16} aria-hidden /><div>
      <strong>Backed by a Schwab brokerage account.</strong>{" "}
      {nav ? <>Priced at the account&rsquo;s reported net asset value{cutoff ? <> as of {dateTime(cutoff)}</> : <>, finalized on Post Fiat{nav.submitted_at_height ? ` at block ${Number(nav.submitted_at_height).toLocaleString()}` : ""}</>}.</> : "The next NAV is being finalized."}
    </div></div>
    <KV rows={[
      ["B23 outstanding", <Amount atoms={state.supply} />],
      value != null && ["Net assets at last NAV", usd(value)],
      ["Reserve for cash-ins", <Amount atoms={pool.settlement_reserve_atoms} unit="PFUSDC" />],
      !compact && ["Cash-in fee", fee == null ? "—" : percentFromBps(fee)],
      !compact && pool.min_order_atoms != null && ["Per cash-in", `${amount(pool.min_order_atoms, { min: 0 })} – ${amount(pool.max_order_atoms, { min: 0 })} B23`],
    ]} />
    {!compact && <Details summary="On-chain details">
      <KV className="is-tight" rows={[
        ["Supply check", pool.invariant_holds === true ? "Balanced" : pool.invariant_holds === false ? "Mismatch" : "Unavailable"],
        ["Route", <Mono value={pool.route_id} />],
        ["Route epoch / policy", `${pool.route_epoch} / ${pool.policy_epoch}`],
        nav && ["Reserve packet", <Mono value={nav.reserve_packet_hash} />],
        ["B23 asset", <Mono value={config?.b23_asset_id} />],
        ["Issuer", <Mono value={config?.issuer_address} />],
      ]} />
    </Details>}
  </Card>;
}
