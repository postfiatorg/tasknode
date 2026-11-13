import { Badge, Notice } from "../ui.jsx";

export const pct = bps => `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;
const labels = ["Proven", "Attested", "Reported"];
export function Verification({ split, detail = false }) {
  if (!split?.available) return <p className="l1-muted l1-small">Verification split unavailable: no positive finalized value.</p>;
  return <div className="l1-verification">
    <div className="l1-verification-bar" role="img" aria-label={labels.map((label, i) => `${label} ${pct(split.bps[i])}`).join(", ")}>
      {labels.map((label, i) => <span key={label} className={`is-${label.toLowerCase()}`} style={{ width: `${split.bps[i] / 100}%` }} />)}
    </div>
    <div className="l1-verification-key">{labels.map((label, i) => <span key={label}><i className={`is-${label.toLowerCase()}`} /><b>{pct(split.bps[i])}</b> {label}</span>)}</div>
    {detail && <>
      <ul className="l1-verification-meanings">
        <li><b>Proven:</b> value the chain packet credits to cryptographic verification under its proof setting; this is not a guarantee of the whole account.</li>
        <li><b>Attested:</b> value the packet credits to signed attestations; signatures are statements by attestors, not a zero-knowledge proof.</li>
        <li><b>Reported:</b> the remaining value, including operator-reported or controlled assets with no independent proof credited in the packet.</li>
      </ul>
      {split.reportedOnly && <Notice tone="warning" title="No independent proof yet — the operator posts this value" />}
      {split.reason && <Notice tone="warning">{split.reason}</Notice>}
    </>}
  </div>;
}

export function Freshness({ value }) {
  if (!value || value.age === null) return <span className="l1-muted">Age unavailable</span>;
  return <div className="l1-reading-age">
    <Badge tone={value.stale ? "warning" : "neutral"}>{value.stale ? "STALE" : value.stale === null ? "Limit unknown" : value.limit === null ? "No age limit" : "Within limit"}</Badge>
    <small>{value.age.toLocaleString()} blocks old{value.limit !== null ? ` · limit ${value.limit.toLocaleString()}` : ""}</small>
  </div>;
}
