// One deposit flow for every source chain. A source supplies how its wallet connects and signs
// and how its status is read; the form, the progress panel and the rules below are shared.
import { ArrowRight, Check, CircleAlert, Clock, RefreshCw } from "lucide-react";
import { Amount, AssetAvatar, Badge, Card, CardHead, Mono, Notice, Spinner } from "../ui.jsx";
import { duration } from "../format.js";

export const ACTIVE = new Set(["running", "retrying"]);
export const BAD = new Set(["failed", "unverified"]);

// What the saved deposit is to the form. Only an unfinished deposit, or one whose USDC is in the
// vault without a credit, holds the form. A credited deposit and one that was never sent do not.
export const holdsForm = outcome => outcome === "in-flight" || outcome === "failed";

// Seconds as text: tenths while short, minutes after.
export const elapsedText = seconds => !Number.isFinite(seconds) || seconds < 0 ? ""
  : seconds < 120 ? `${seconds.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s` : duration(seconds);

// rows: [{ status }] in stage order; phase.stages indexes into it.
export function phaseState(rows, phase, credited) {
  const states = phase.stages.map(index => rows[index].status);
  if (credited || states.every(status => status === "complete")) return "done";
  if (states.some(status => BAD.has(status))) return "failed";
  if (states.some(status => ACTIVE.has(status)) || states.some(status => status === "complete")) return "active";
  return "pending";
}

function Step({ number, done, title, children }) {
  return <div className={`l1-bridge-step ${done ? "is-done" : ""}`}>
    <span className="l1-step-num">{done ? <Check size={13} aria-hidden /> : number}</span>
    <div className="l1-bridge-step-body"><b>{title}</b>{children}</div>
  </div>;
}

// The form: readiness, notices, then the same three steps for every source.
export function DepositForm({ source, ready, checking, readyText, onRefresh, refreshDisabled, notices, steps, children }) {
  return <Card className="l1-ticket">
    <CardHead eyebrow={`Deposit from ${source}`} title="USDC to PFUSDC">
      {checking ? <Badge><Spinner size={12} />Checking</Badge> : <Badge tone={ready ? "success" : "warning"} dot>{readyText}</Badge>}
      {onRefresh && <button type="button" className="l1-icon-btn" aria-label="Check readiness" title="Check readiness" disabled={refreshDisabled} onClick={onRefresh}><RefreshCw size={14} aria-hidden /></button>}
    </CardHead>
    {notices}
    <div className="l1-bridge-steps">{steps.map((step, index) => <Step key={step.title} number={index + 1} done={step.done} title={step.title}>{step.body}</Step>)}</div>
    {children}
  </Card>;
}

// The amount box, the same for every source.
export function AmountField({ label, value, onChange, disabled, max, hint, note }) {
  return <label className="l1-field"><span className="l1-sr">{label}</span><span className="l1-input-wrap">
    <input aria-label={label} inputMode="decimal" placeholder="0.00" value={value} disabled={disabled} onChange={event => onChange(event.target.value)} />
    <span className="l1-input-suffix">{max ? <button type="button" className="l1-max" disabled={disabled} onClick={() => onChange(max)}>Max</button> : null}USDC</span></span>
    <span className="l1-field-hint"><span>{hint}</span><span>{note}</span></span></label>;
}

// The progress panel: route, three phases, one status line, the measured stages, then the outcome.
export function DepositProgress({ label, source, glyph, title = "Deposit progress", owner, amountAtoms, recipient, recipientTestId, phases, rows, stagesLabel,
  headline, detail, action, running, credited, seconds, clockTestId, children, details }) {
  return <Card className="l1-track-card" aria-label={label}>
    <CardHead eyebrow={`${source} → Post Fiat`} title={title}>
      {running && seconds !== null && <span className="l1-clock"><Clock size={14} aria-hidden /><span data-testid={clockTestId}>{elapsedText(seconds)}</span></span>}
      {!running && seconds !== null && (credited ? <Badge tone="success">Done in <span data-testid={clockTestId}>{elapsedText(seconds)}</span></Badge>
        : <span className="l1-clock"><Clock size={14} aria-hidden /><span data-testid={clockTestId}>{elapsedText(seconds)}</span></span>)}
    </CardHead>
    <div className="l1-route" style={{ marginBottom: 22 }}>
      <div className="l1-route-end"><span className="l1-chain-eth" aria-hidden>{glyph}</span><div><small>From {source}</small><b>{amountAtoms ? <Amount atoms={amountAtoms} unit="USDC" /> : "USDC"}</b>{owner && <small><Mono value={owner} /></small>}</div></div>
      <span className="l1-route-arrow" aria-hidden><ArrowRight size={16} /></span>
      <div className="l1-route-end"><AssetAvatar code="PFUSDC" /><div><small>To this wallet</small><b>{amountAtoms ? <Amount atoms={amountAtoms} unit="PFUSDC" /> : "PFUSDC"}</b><small><Mono value={recipient} testId={recipientTestId} /></small></div></div>
    </div>
    <div className="l1-phases">{phases.map(phase => <div key={phase.title} className={`l1-phase is-${phase.state}`}>
      <span className="l1-phase-node">{phase.state === "done" ? <Check size={20} aria-hidden /> : phase.state === "failed" ? <CircleAlert size={20} aria-hidden /> : phase.state === "active" ? <Spinner size={20} /> : <phase.icon size={18} aria-hidden />}</span>
      <b>{phase.title}</b><small>{phase.state === "done" ? phase.hint : phase.state === "active" ? "In progress" : phase.state === "failed" ? "Needs attention" : "Waiting"}</small>
    </div>)}</div>
    <div className="l1-track-status" role="status"><div><b>{headline}</b><small>{detail}</small></div>{action}</div>
    <ol aria-label={stagesLabel} className="l1-stages">
      {rows.map(row => <li key={row.key} className={`l1-stage is-${row.status}`} title={row.title}>
        <span className="l1-stage-dot">{row.status === "complete" ? <Check size={12} aria-hidden /> : ACTIVE.has(row.status) ? <Spinner size={12} /> : BAD.has(row.status) ? <CircleAlert size={12} aria-hidden /> : null}</span>
        <span><b>{row.label}</b>{row.status !== "pending" && row.status !== "complete" && <small className="l1-muted"> · {row.status}</small>}{row.status === "unverified" && <span className="l1-small" style={{ color: "var(--l1-danger)" }}> · receipt unverified</span>}</span>
        <span className="l1-stage-time">{row.time}</span>
      </li>)}
    </ol>
    {children}
    {details}
  </Card>;
}

// The outcome boxes, worded the same for every source.
export function Credited({ amountAtoms, children }) {
  return <div className="l1-credit" role="status">
    <span className="l1-eyebrow">Credited on Post Fiat</span>
    <strong>{amountAtoms ? <>+<Amount atoms={amountAtoms} unit="PFUSDC" /></> : "PFUSDC credited"}</strong>
    {children}
  </div>;
}
export const NotSent = ({ source }) => <Notice tone="warning" title="Your last deposit was not sent">{source} never recorded it, and it can no longer go through. No USDC left your wallet. You can send again below.</Notice>;
