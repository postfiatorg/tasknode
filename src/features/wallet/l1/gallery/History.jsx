import { Card, CardHead, Details } from "../ui.jsx";
import { amount, usd } from "../format.js";

function Plot({ readings, field, label }) {
  const values = readings.map(p => BigInt(p[field]));
  const low = values.reduce((a, b) => a < b ? a : b), high = values.reduce((a, b) => a > b ? a : b);
  const heights = readings.map(p => BigInt(p.submitted_at_height));
  const minHeight = heights.reduce((a, b) => a < b ? a : b), maxHeight = heights.reduce((a, b) => a > b ? a : b);
  const points = values.map((v, i) => ({
    x: maxHeight === minHeight ? 280 : 90 + Number((heights[i] - minHeight) * 400n / (maxHeight - minHeight)),
    y: high === low ? 80 : 135 - Number((v - low) * 110n / (high - low)),
  }));
  return <figure className="l1-nav-plot">
    <figcaption>{label}<strong>{usd(values.at(-1), field === "nav_per_unit" ? { max: 6 } : {})}</strong></figcaption>
    <svg viewBox="0 0 520 180" role="img" aria-label={`${label} across ${readings.length} finalized readings; exact values in the reading table`}>
      <line x1="90" x2="490" y1="135" y2="135" className="l1-chart-grid" />
      <line x1="90" x2="490" y1="25" y2="25" className="l1-chart-grid" />
      <text x="82" y="29" textAnchor="end">{usd(high)}</text>
      <text x="82" y="139" textAnchor="end">{usd(low)}</text>
      <polyline points={points.map(p => `${p.x},${p.y}`).join(" ")} className="l1-chart-line" />
      {points.map((p, i) => <circle key={readings[i].epoch} cx={p.x} cy={p.y} r="4" className="l1-chart-point"><title>Epoch {readings[i].epoch}, block {readings[i].submitted_at_height}: {usd(values[i], { max: 6 })}</title></circle>)}
      <text x="90" y="167">Block {String(minHeight)}</text><text x="490" y="167" textAnchor="end">{String(maxHeight)}</text>
    </svg>
  </figure>;
}

export default function NavHistory({ coin }) {
  const readings = coin.history || [];
  return <Card aria-label="NAV history">
    <CardHead eyebrow="Finalized on Post Fiat" title="NAV history" />
    <p className="l1-small l1-muted">{readings.length} finalized reading{readings.length === 1 ? "" : "s"}. The wallet RPC does not provide historical block timestamps, so this history uses submission heights, not dates.</p>
    {readings.length > 0 ? <>
      <div className="l1-nav-plots"><Plot readings={readings} field="nav_per_unit" label="NAV per coin" /><Plot readings={readings} field="verified_net_assets" label="Total value (TVL)" /></div>
      <Details summary="Every finalized reading">
        <div className="l1-table-wrap"><table className="l1-history-table"><thead><tr><th>Reading</th><th>Submitted at block</th><th>NAV per coin</th><th>Total value</th><th>Coins at reading</th></tr></thead>
          <tbody>{[...readings].reverse().map(p => <tr key={p.epoch}><td>Epoch {p.epoch}</td><td>{Number(p.submitted_at_height).toLocaleString()}</td><td>{usd(p.nav_per_unit, { max: 6 })}</td><td>{usd(p.verified_net_assets)}</td><td>{amount(p.circulating_supply)}</td></tr>)}</tbody>
        </table></div>
      </Details>
    </> : <p className="l1-muted">No finalized readings are available.</p>}
  </Card>;
}
