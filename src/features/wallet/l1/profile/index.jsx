import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, RefreshCw } from 'lucide-react';
import { Badge, Card, CardHead, Details, KV, Notice, Spinner } from '../ui.jsx';
import { Verification } from '../gallery/Verification.jsx';
import { verificationSplit } from '../gallery/model.js';
import './profile.css';
export function profileLocation(hash = window.location.hash) {
  const match = hash.match(/^#\/?l1-wallet\/navcoins(?:\/([a-z0-9-]+)(?:\/snapshots\/([1-9][0-9]*))?)?\/?$/);
  return match ? { slug: match[1] || null, epoch: match[2] || null } : null;
}
export function useProfileLocation() {
  const [route, setRoute] = useState(() => profileLocation());
  useEffect(() => { const update = () => setRoute(profileLocation()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  return route;
}
const missing = 'Not available';
const number = (value, decimals = 6, max = 6) => value == null ? missing : (Number(value) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: max });
const dollars = (value, decimals = 6) => value == null ? missing : `$${number(value, decimals)}`;
const cash = value => value == null ? missing : Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
const link = slug => `#l1-wallet/navcoins/${slug}`;
function External({ href, children }) { return <a href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={12} aria-hidden /></a>; }
function Identifier({ value, href }) { return value ? href ? <External href={href}><code>{value}</code></External> : <code className="profile-id">{value}</code> : missing; }
function useRead(path) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer;
    async function update() {
      try {
        const response = await fetch(path, { signal: controller.signal, cache: 'no-store' });
        const data = await response.json(); if (!response.ok) throw Error(data.error || 'Live data unavailable');
        setState({ data, error: '', loading: false, path });
      } catch (error) { if (!controller.signal.aborted) setState({ data: null, error: error.message, loading: false, path }); }
      if (!controller.signal.aborted) timer = setTimeout(update, 60000);
    }
    setState({ data: null, error: '', loading: true, path }); void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, revision]);
  return { ...(state.path === path ? state : { data: null, error: '', loading: true }), refresh: () => setRevision(value => value + 1) };
}
function NavChart({ history, decimals }) {
  if (!history.length) return null;
  const values = history.map(p => Number(p.nav_per_unit) / 10 ** decimals), lo = Math.min(...values), hi = Math.max(...values);
  const points = values.map((value, i) => ({ x: history.length === 1 ? 300 : 70 + i * 500 / (history.length - 1), y: hi === lo ? 80 : 140 - (value - lo) * 110 / (hi - lo) }));
  return <figure className="profile-chart"><figcaption>NAV per coin · consecutive finalized readings</figcaption><svg viewBox="0 0 600 175" role="img" aria-label={`NAV chart with ${history.length} finalized readings; exact values in the table`}><line x1="70" x2="570" y1="140" y2="140" className="l1-chart-grid" /><text x="62" y="35" textAnchor="end">{cash(hi)}</text><text x="62" y="143" textAnchor="end">{cash(lo)}</text><polyline className="l1-chart-line" points={points.map(p => `${p.x},${p.y}`).join(' ')} />{points.map((point, i) => <circle key={history[i].epoch} cx={point.x} cy={point.y} r="4" className="l1-chart-point"><title>Epoch {history[i].epoch}: {cash(values[i])}</title></circle>)}<text x="70" y="166">Epoch {history[0].epoch}</text><text x="570" y="166" textAnchor="end">Epoch {history.at(-1).epoch}</text></svg></figure>;
}
function History({ data }) {
  const d = data.coin.valuation_decimals ?? 6;
  return <Card><CardHead eyebrow="Recorded on Post Fiat" title="Historical NAV snapshots" /><p className="l1-small l1-muted">Every finalized reading has its own verification page. Wall-clock reading and block times are not available from the chain archive; heights identify the readings.</p><NavChart history={data.history} decimals={d} /><div className="l1-table-wrap"><table className="l1-history-table"><thead><tr><th>Epoch / time</th><th>NAV</th><th>Net assets</th><th>Supply at reading</th><th>Verification</th><th>Evidence</th></tr></thead><tbody>{[...data.history].reverse().map(p => <tr key={p.epoch}><td><strong>{p.epoch}</strong><small>Time not available</small><small>Submitted h{p.submitted_at_height}</small></td><td>{dollars(p.nav_per_unit, d)}</td><td>{dollars(p.verified_net_assets, d)}</td><td>{number(p.circulating_supply, data.asset?.precision ?? 6)}</td><td><Verification split={verificationSplit(p, { verifier_kind: p.cryptographically_verified_value || p.attested_value ? 'packet-trust-values' : 'placeholder' })} /></td><td><a className="l1-link" href={p.verification_url} aria-label={`Verify ${data.coin.name} epoch ${p.epoch}`}>Verify →</a></td></tr>)}</tbody></table></div></Card>;
}
function Pools({ data }) {
  const { coin, route, order_book: book, ethereum: eth } = data, d = coin.valuation_decimals ?? 6;
  const nav = data.latest ? Number(data.latest.nav_per_unit) / 10 ** d : null;
  return <Card><CardHead title="Liquidity pools" /><h3>Native order book</h3><KV rows={[
    ['Coins for sale', book.asks ? `${book.asks.partial ? 'At least ' : ''}${number(book.asks.coin_atoms, data.asset?.precision ?? 6)} ${coin.name}` : missing],
    ['Asking value', book.asks ? `${number(book.asks.quote_atoms)} PFUSDC (S)` : missing],
    ['Coins wanted', book.bids ? `${book.bids.partial ? 'At least ' : ''}${number(book.bids.coin_atoms, data.asset?.precision ?? 6)} ${coin.name}` : missing],
    ['Buy offer value', book.bids ? `${number(book.bids.quote_atoms)} PFUSDC (S)` : missing],
    ['Native cash-in reserve', route ? `${number(route.settlement_reserve_atoms)} PFUSDC` : missing],
  ]} /><p className="l1-small l1-muted">Offers are not guaranteed fills. Cash-in depends on the holder’s route eligibility, matching reserve, current NAV and policy. The reserve is separate from order-book and Ethereum liquidity.</p>
  <h3 className="l1-section-gap">Ethereum / Uniswap v4</h3>{!eth?.available ? <Notice title={eth?.deployed === false ? eth.note : 'Live Ethereum data not available'}>{eth?.error}</Notice> : <>
    <Badge tone={eth.liquidity === '0' ? 'warning' : 'neutral'}>{eth.liquidity === '0' ? 'Deployed · no active liquidity' : 'Pool deployed'}</Badge>
    <KV rows={[
      ['Pool coin balance (principal)', `${number(eth.coin_balance, 0)} w${coin.name}`], ['Pool USDC balance (principal)', cash(eth.usdc_balance)],
      ['Pool spot price', `${cash(eth.price_usdc)} USDC`], ['Pool price vs NAV', nav > 0 ? `${((eth.price_usdc / nav - 1) * 100).toFixed(2)}%` : missing],
      ['New Ethereum minting', eth.mint_paused === null ? missing : eth.mint_paused ? 'Paused' : 'Enabled'],
      ['Ethereum reading', <External href={`https://etherscan.io/block/${eth.block_number}`}>Block {eth.block_number}</External>],
    ]} /><p className="l1-small l1-muted">{eth.balance_basis} A pool price with no active liquidity is not an executable quote. New minting and swaps of existing coins are separate operations.</p>
    <Details summary="Token and pool addresses"><KV rows={[
      ['Wrapped token', <Identifier value={eth.token} href={`https://etherscan.io/token/${eth.token}`} />], ['Pool manager', <Identifier value={eth.pool_manager} href={`https://etherscan.io/address/${eth.pool_manager}`} />],
      ['Pool identifier', <Identifier value={eth.pool_id} href={`https://app.uniswap.org/explore/pools/ethereum/${eth.pool_id}`} />],
      ['Controller', <Identifier value={eth.controller} href={`https://etherscan.io/address/${eth.controller}`} />], ['Refreshed', `${eth.observed_at} · cached up to 60 seconds`],
    ]} /><p className="l1-small l1-muted">V4 pools share a contract address. The pool identifier selects this coin’s pool within the linked manager.</p></Details>
  </>}</Card>;
}
function Fees({ data }) {
  const route = data.route, eth = data.ethereum;
  const fee = (value, direction) => value == null ? missing : `NAV ${direction === 'create' ? '+' : '−'} ${((direction === 'create' ? value - 10000 : 10000 - value) / 100).toFixed(2)}%`;
  const protocol = eth?.available ? [eth.protocol_fee & 4095, eth.protocol_fee >> 12] : [];
  return <Card><CardHead title="Advertised fees" /><KV rows={[
    ['Create', fee(route?.issue_multiplier_bps, 'create')], ['Cash in', fee(route?.redeem_multiplier_bps, 'redeem')],
    ['Uniswap liquidity provider fee', eth?.available ? `${(eth.lp_fee / 10000).toFixed(2)}%` : missing],
    ['Uniswap protocol fee', protocol.length ? protocol.map(v => `${(v / 10000).toFixed(4)}%`).join(' / ') + ' by swap direction' : missing],
  ]} /><p className="l1-small l1-muted">Native terms are read from the on-chain route. These advertised terms do not guarantee availability. Order-book prices come from traders. Separate PFT network fees apply to native transactions; Ethereum transactions require ETH gas. Pool price impact is additional.</p>{route && <p className="l1-small l1-muted">{data.coin.retired || route.paused || !route.live_value_enabled ? 'This route is not currently available.' : Number(route.policy_expires_at_height) < Number(data.proof.current_height) ? 'The advertised native policy has expired.' : 'Check current eligibility and capacity before creating or cashing in.'}</p>}</Card>;
}
function CoinProfile({ data }) {
  const { coin, latest, proof } = data, d = coin.valuation_decimals ?? 6, profile = proof.active_profile;
  const age = latest ? Number(proof.current_height) - Number(latest.submitted_at_height) : null;
  const limits = [profile?.max_snapshot_age_blocks, profile?.max_epoch_gap_blocks].filter(n => n > 0), limit = limits.length ? Math.min(...limits) : null;
  return <><header className="profile-head"><div><div className="l1-eyebrow">Post Fiat · devnet-2 · NAVCoin profile</div><h1>{coin.name}{coin.retired ? ' · Retired' : ''}</h1><p>{coin.description}</p></div><a className="l1-btn" href="#l1-wallet">Open wallet</a></header>{coin.retired && <Notice tone="warning" title="Historical profile">This coin is retired. Its last NAV is not a current cash-in price.</Notice>}
    <div className="profile-summary"><Card><CardHead title={coin.retired ? 'Last finalized NAV' : 'Current finalized NAV'} /><div className="profile-nav">{dollars(latest?.nav_per_unit, d)}</div><span className="l1-small l1-muted">per {coin.name}</span><KV rows={[
      ['Latest reading', latest ? `Epoch ${latest.epoch} · submitted h${latest.submitted_at_height}` : missing], ['Reading time', missing],
      ['Reading age / limit', age == null ? missing : `${age} / ${limit ?? 'no configured limit'} blocks`],
      ['Finalized net assets', dollars(latest?.verified_net_assets, d)], ['Supply at reading', number(latest?.circulating_supply, data.asset?.precision ?? 6)], ['Outstanding now', number(data.asset?.outstanding_supply, data.asset?.precision ?? 6)],
    ]} />{age !== null && limit !== null && age > limit && <Badge tone="warning">Stale reading</Badge>}</Card><Card><CardHead title="What supports this reading" /><Verification split={verificationSplit(latest, profile)} detail /><p className="l1-small">{coin.methodology}</p>{latest && <a className="l1-link" href={latest.verification_url}>Verify the latest snapshot →</a>}</Card></div>
    <History data={data} /><div className="profile-summary"><Pools data={data} /><Fees data={data} /></div><Card><Details summary="Asset, route and proof identifiers"><KV rows={[
      ['Asset', <Identifier value={coin.asset_id} />], ['Cash-in route', coin.route_id || missing], ['Proof profile', <Identifier value={profile?.profile_id} />], ['Valuation scale', `${10 ** d} units per USD`], ['Native read height', proof.current_height],
    ]} /></Details></Card>{data.errors?.length > 0 && <Notice tone="warning">{data.errors.join(' · ')}</Notice>}</>;
}
function Snapshot({ data }) {
  const d = data.coin.valuation_decimals ?? 6;
  return <><a className="l1-link" href={link(data.coin.slug)}><ArrowLeft size={14} />Back to {data.coin.name}</a><header className="profile-head"><div><div className="l1-eyebrow">Check the finalized record</div><h1>{data.coin.name} · Snapshot {data.packet.epoch}</h1></div><Badge tone={data.verified ? 'success' : 'warning'}>{data.verified ? 'Accepted submit and finalize receipts' : 'Evidence incomplete'}</Badge></header><Card><CardHead title="Snapshot" /><KV rows={[
    ['NAV per coin', dollars(data.packet.nav_per_unit, d)], ['Net assets', dollars(data.packet.verified_net_assets, d)], ['Supply at reading', number(data.packet.circulating_supply)],
    ['Reading time', data.reading_time || missing], ['Finalized time', data.finalized_time || missing], ['Reserve packet hash', <Identifier value={data.packet.reserve_packet_hash} />],
  ]} /><Verification split={verificationSplit(data.packet, data.proof_profile)} detail /><p className="l1-small l1-muted">{data.source} Accepted means the network accepted the operation under its rules. This page does not independently rerun the proof or establish that all assets exist.</p></Card>
  {['submit', 'finalize'].map(kind => <Card key={kind}><CardHead title={kind === 'submit' ? 'Submit transaction' : 'Finalize transaction'} />{data[kind] ? <><KV rows={[
    ['Transaction ID', <Identifier value={data[kind].tx_id} />], ['Block height', data[kind].block.height], ['Block hash', <Identifier value={data[kind].block.block_hash} />], ['Accepted', String(data[kind].receipt.accepted)], ['Confirmed', String(data[kind].confirmed)], ['Receipt code', data[kind].receipt.code],
  ]} /><Details summary="Literal on-chain receipt"><pre>{JSON.stringify(data[kind].receipt, null, 2)}</pre></Details></> : <p>{missing}</p>}</Card>)}
  <Card><CardHead title="Proof and attestation" /><KV rows={[
    ['Proof profile ID', <Identifier value={data.proof_profile_id} />], ['Proof program key', <Identifier value={data.proof_program_key} />],
    ['Proof SHA-256', <Identifier value={data.proof_sha256} />], ['Public values SHA-256', <Identifier value={data.public_values_sha256} />],
    ['Enclave PCRs', data.attestation.pcrs || missing], ['Enclave image hash', data.attestation.image_sha256 || missing], ['Enclave reading timestamp', data.attestation.reading_timestamp || missing],
  ]} /><p className="l1-small l1-muted">{data.attestation.note} SHA-256 hashes above are calculated from the proof and public-value bytes in the archived signed transaction.</p><Details summary="Proof profile and finalized packet"><pre>{JSON.stringify({ proof_profile: data.proof_profile, packet: data.packet }, null, 2)}</pre></Details></Card>
  <Card><CardHead title="Ethereum publication" />{data.ethereum_transactions.length ? data.ethereum_transactions.map(tx => <p key={tx}><External href={`https://etherscan.io/tx/${tx}`}>{tx}</External></p>) : <p>{data.ethereum_note}</p>}</Card><p><a className="l1-link" href={data.packet.evidence_url} target="_blank" rel="noreferrer">Open raw verification JSON →</a></p></>;
}
export default function Profile({ slug = 'b24', epoch = null }) {
  const state = useRead(`/api/l1/navcoin/profiles/${slug}${epoch ? `/snapshots/${epoch}` : ''}`);
  return <div className="route-scroll"><main className="l1w navcoin-profile"><nav className="profile-coins" aria-label="NAVCoin profiles">{['b24', 'a666', 'bmnrc', 'b23'].map(id => <a key={id} href={link(id)} aria-current={id === slug ? 'page' : undefined}>{id.toUpperCase()}{id === 'b23' ? ' · Retired' : ''}</a>)}</nav><div className="l1-toolbar"><span>Public profile · no wallet unlock needed</span><button className="l1-btn is-sm" type="button" onClick={state.refresh} disabled={state.loading}><RefreshCw size={14} />Refresh</button></div>{state.loading && <Card><p role="status"><Spinner /> Reading finalized chain data…</p></Card>}{state.error && <Notice tone="danger" title="Live data could not be read">{state.error}</Notice>}{state.data && <>{epoch ? <Snapshot data={state.data} /> : <CoinProfile data={state.data} />}<p className="l1-small l1-muted">Read {state.data.observed_at || state.data.read_at}. Refreshes every minute. Native network: devnet-2; Ethereum pools: mainnet.</p></>}</main></div>;
}
