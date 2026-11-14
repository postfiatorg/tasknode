import { useEffect, useState } from "react";
import { ArrowRight, Check, ChartCandlestick, CircleAlert, Clock, ExternalLink, FileCheck, Landmark, RefreshCw, Wallet } from "lucide-react";
import { useL1Wallet } from "../client.jsx";
import { BridgeController, amountAtoms } from "./controller.js";
import { atomsToUsdc } from "./evm.js";
import { stageRows, timestamp } from "./stages.js";
import { Amount, AssetAvatar, Badge, Card, CardHead, Details, IdChip, KV, Mono, Notice, Spinner } from "../ui.jsx";
import { duration } from "../format.js";

// Presentation labels for the relay's wire stages (contract: UI labels may differ).
const LABELS = {
  confirming_deposit: "Confirm deposit on Ethereum",
  waiting_for_ethereum_finality: "Wait for Ethereum finality",
  capturing_state_proof: "Capture deposit proof",
  proving: "Generate proof",
  verifying: "Verify proof on Post Fiat",
  growing_backed_cap: "Finalize PFUSDC backing",
  claiming: "Credit PFUSDC",
};
const PHASES = [
  { title: "Ethereum deposit", hint: "Confirmed and final", stages: [0, 1], icon: Wallet },
  { title: "Proof", hint: "Proven and verified", stages: [2, 3, 4], icon: FileCheck },
  { title: "Credited on Post Fiat", hint: "PFUSDC in this wallet", stages: [5, 6], icon: Landmark },
];
const ACTIVE = new Set(["running", "retrying"]);
const BAD = new Set(["failed", "unverified"]);

function useNow(enabled) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function phaseState(rows, phase, credited) {
  const states = phase.stages.map(index => rows[index].status);
  if (credited || states.every(status => status === "complete")) return "done";
  if (states.some(status => BAD.has(status))) return "failed";
  if (states.some(status => ACTIVE.has(status)) || (states.some(status => status === "complete"))) return "active";
  return "pending";
}

function Track({ view, controller, client, onNavigate, symbol }) {
  const job = view.job, pending = view.pending, result = view.result;
  const rows = stageRows(job);
  const credited = Boolean(result && !result.balancePending);
  const inFlight = Boolean(pending) && !credited && job?.status !== "failed";
  const now = useNow(inFlight);
  const phases = PHASES.map(phase => ({ ...phase, state: phaseState(rows, phase, credited) }));
  if (pending?.tx && !job && !credited) phases[0].state = "active";
  const currentIndex = rows.findIndex(row => ACTIVE.has(row.status));
  const started = job?.created_at_unix || rows.find(row => row.started)?.started || null;
  const finished = credited ? Math.max(...rows.map(row => row.completed || 0)) || null : null;
  const elapsed = started ? (finished || now / 1000) - started : null;
  let headline, detail;
  if (credited) { headline = "PFUSDC credited"; detail = "The deposit is proven on Post Fiat and the PFUSDC is in this wallet."; }
  else if (result?.balancePending) { headline = "Claim accepted"; detail = "Reading the credited balance from the chain."; }
  else if (job?.status === "failed") { headline = "The bridge could not finish this deposit"; detail = job.message || job.code || "Claim failed."; }
  else if (pending && !pending.tx) { headline = "Deposit broadcast was interrupted"; detail = "Enter the Ethereum transaction hash below to recover it."; }
  else if (pending?.tx && !job) { headline = "Waiting for Ethereum to confirm your deposit"; detail = "This page keeps checking; you can leave and come back."; }
  else if (job && currentIndex >= 0) { headline = LABELS[rows[currentIndex].stage]; detail = `Stage ${currentIndex + 1} of ${rows.length}. ${rows[currentIndex].stage === "proving" ? "Proof generation is the longest step and can take several minutes." : "Progress updates every few seconds."}${rows[currentIndex].status === "retrying" ? " Retrying after a temporary error." : ""}`; }
  else if (job) { headline = "Deposit received by the bridge"; detail = "Queued for proving."; }
  else { headline = "No deposit in progress"; detail = "Once you deposit, each stage appears here as it completes."; }
  return <Card className="l1-track-card" aria-label="Bridge progress">
    <CardHead eyebrow="Ethereum → Post Fiat" title="Bridge progress">{inFlight && elapsed !== null && <span className="l1-clock"><Clock size={14} aria-hidden />{duration(elapsed)}</span>}{credited && elapsed !== null && <Badge tone="success">Done in {duration(elapsed)}</Badge>}</CardHead>
    <div className="l1-route" style={{ marginBottom: 22 }}>
      <div className="l1-route-end"><span className="l1-chain-eth" aria-hidden>Ξ</span><div><small>From Ethereum</small><b>{pending?.amountAtoms ? <Amount atoms={pending.amountAtoms} unit="USDC" /> : "USDC"}</b>{view.owner && <small><Mono value={view.owner} /></small>}</div></div>
      <span className="l1-route-arrow" aria-hidden><ArrowRight size={16} /></span>
      <div className="l1-route-end"><AssetAvatar code="PFUSDC" /><div><small>To this wallet</small><b>{pending?.amountAtoms ? <Amount atoms={pending.amountAtoms} unit="PFUSDC" /> : "PFUSDC"}</b><small><Mono value={client.address} testId="bridge-recipient" /></small></div></div>
    </div>
    <div className="l1-phases">{phases.map(phase => <div key={phase.title} className={`l1-phase is-${phase.state}`}>
      <span className="l1-phase-node">{phase.state === "done" ? <Check size={20} aria-hidden /> : phase.state === "failed" ? <CircleAlert size={20} aria-hidden /> : phase.state === "active" ? <Spinner size={20} /> : <phase.icon size={18} aria-hidden />}</span>
      <b>{phase.title}</b><small>{phase.state === "done" ? phase.hint : phase.state === "active" ? "In progress" : phase.state === "failed" ? "Needs attention" : "Waiting"}</small>
    </div>)}</div>
    <div className="l1-track-status" role="status"><div><b>{headline}</b><small>{detail}</small></div>
      {pending && !credited && <button type="button" className="l1-btn is-sm" disabled={view.busy} onClick={() => controller.run(() => controller.resume())}><RefreshCw size={14} aria-hidden />Refresh progress</button>}
    </div>
    <ol aria-label="Relay stages" className="l1-stages">
      {rows.map(row => {
        const running = ACTIVE.has(row.status);
        const time = row.completed && row.started ? duration(row.completed - row.started) : running && row.started ? `${duration(now / 1000 - row.started)}…` : "";
        return <li key={row.stage} className={`l1-stage is-${row.status}`} title={`Started ${timestamp(row.started)} · Completed ${timestamp(row.completed)}`}>
          <span className="l1-stage-dot">{row.status === "complete" ? <Check size={12} aria-hidden /> : running ? <Spinner size={12} /> : BAD.has(row.status) ? <CircleAlert size={12} aria-hidden /> : null}</span>
          <span><b>{LABELS[row.stage] || row.label}</b>{row.status === "retrying" && <span className="l1-muted l1-small"> · retrying</span>}{row.status === "unverified" && <span className="l1-small" style={{ color: "var(--l1-danger)" }}> · receipt unverified</span>}</span>
          <span className="l1-stage-time">{time}</span>
        </li>;
      })}
    </ol>
    {result && <div className="l1-credit" role="status">
      {result.balancePending ? <p>Claim accepted; credited balance is unverified. Refresh the result.</p> : <>
        <span className="l1-eyebrow">Credited on Post Fiat</span>
        <strong>{pending?.amountAtoms ? <>+<Amount atoms={pending.amountAtoms} unit="PFUSDC" /></> : "PFUSDC credited"}</strong>
        <span className="l1-muted">Bridged PFUSDC balance now <Amount atoms={result.atoms} unit="PFUSDC" testId="bridge-credited-balance" /></span>
      </>}
      <div className="l1-row" style={{ marginTop: 6 }}><span className="l1-muted l1-small">Post Fiat receipt</span><IdChip value={result.receipt} label="receipt id" /></div>
      {!result.balancePending && <div className="l1-row" style={{ marginTop: 8 }}>
        {onNavigate && <button type="button" className="l1-btn is-primary" onClick={() => onNavigate("Market")}><ChartCandlestick size={16} aria-hidden />Buy {symbol} with PFUSDC</button>}
        <button type="button" className="l1-btn" disabled={view.busy} onClick={() => controller.run(() => controller.newDeposit())}>Start another deposit</button>
      </div>}
    </div>}
    <Details summary="Bridge details">
      <KV className="is-tight" rows={[
        job && ["Bridge job", <span data-testid="bridge-job"><Mono value={job.job_id} /> · {job.status}{job.code ? ` (${job.code})` : ""}</span>],
        pending?.tx && ["Ethereum deposit", <Mono value={pending.tx} />],
        result && !result.balancePending && ["Credited asset", <Mono value={result.assetId} testId="bridge-credited-asset" />],
        ["Recipient", <Mono value={client.address} />],
      ]} />
    </Details>
  </Card>;
}

function BridgeSession({ client, onNavigate, symbol }) {
  const [view, setView] = useState(null);
  const [controller, setController] = useState(null);
  const [amount, setAmount] = useState("");
  const [recoveryTx, setRecoveryTx] = useState("");
  useEffect(() => {
    const model = new BridgeController(client, { changed: setView });
    setController(model);
    setView({ ...model.state });
    void model.run(async () => {
      try { await model.readiness(); } catch { /* blocked reason is visible */ }
      if (model.state.pending?.tx) await model.resume();
    });
    const changed = () => model.providerChanged();
    window.ethereum?.on?.("accountsChanged", changed);
    window.ethereum?.on?.("chainChanged", changed);
    let lastReadiness = Date.now();
    const timer = setInterval(() => {
      if (model.state.busy) return;
      if (Date.now() - lastReadiness > 15000) {
        lastReadiness = Date.now();
        void model.run(async () => { try { await model.readiness(); } catch { /* fail closed */ } });
        return;
      }
      if (model.state.error) return;
      if (model.state.pending?.jobId && model.state.job?.status !== "accepted" && model.state.job?.status !== "failed") {
        void model.run(() => model.poll());
      }
    }, 3000);
    return () => {
      clearInterval(timer);
      model.dispose();
      window.ethereum?.removeListener?.("accountsChanged", changed);
      window.ethereum?.removeListener?.("chainChanged", changed);
    };
  }, [client]);
  if (!view || !controller) return <p className="l1-status-line"><Spinner />Loading bridge…</p>;
  const atoms = amountAtoms(amount);
  const enabled = view.ready && !!view.owner && !!atoms && !view.busy && !view.pending;
  const tx = view.pending?.tx;
  const approved = view.allowance !== null && atoms && view.allowance >= atoms;
  const checking = !view.ready && view.blocked === "Checking bridge readiness.";
  const hasProvider = typeof window !== "undefined" && typeof window.ethereum !== "undefined";
  return <section aria-label="USDC bridge" className="l1-view l1-split is-ticket">
    <div className="l1-stack">
      <Card className="l1-ticket">
        <CardHead eyebrow="Convert" title="USDC to PFUSDC">
          {checking ? <Badge><Spinner size={12} />Checking</Badge> : <Badge tone={view.ready ? "success" : "warning"} dot>{view.ready ? "Bridge ready" : "Bridge unavailable"}</Badge>}
          <button type="button" className="l1-icon-btn" aria-label="Check readiness" title="Check readiness" disabled={view.busy} onClick={() => controller.run(async () => { await controller.readiness(); await controller.refreshEthereum(); })}><RefreshCw size={14} aria-hidden /></button>
        </CardHead>
        {!view.ready && !checking && view.blocked && <div style={{ marginBottom: 16 }}><Notice tone="warning" title="Deposits are paused">{view.blocked} Approve and deposit stay off until the bridge reports ready.</Notice></div>}
        <div className="l1-bridge-steps">
          <div className={`l1-bridge-step ${view.owner ? "is-done" : ""}`}>
            <span className="l1-step-num">{view.owner ? <Check size={13} aria-hidden /> : 1}</span>
            <div className="l1-bridge-step-body">
              <b>Connect MetaMask</b>
              {view.owner ? <div className="l1-row" style={{ justifyContent: "space-between" }}>
                <span className="l1-row" style={{ gap: 8 }}><IdChip value={view.owner} label="Ethereum address" testId="bridge-owner" /><Badge>Ethereum mainnet</Badge></span>
                <span className="l1-small l1-muted">{view.balance === null ? "USDC balance unavailable" : <>Balance <b style={{ color: "var(--l1-text)" }}><Amount atoms={view.balance} unit="USDC" /></b></>}</span>
              </div> : hasProvider ? <p className="l1-small l1-muted">Use the Ethereum account that holds your USDC. Nothing is sent until you approve and deposit.</p>
                : <p className="l1-small l1-muted">MetaMask was not detected in this browser. <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">Install MetaMask</a>, then reload.</p>}
              <div><button type="button" className={`l1-btn ${view.owner ? "is-sm" : "is-primary"}`} disabled={view.busy} onClick={() => controller.run(() => controller.connect())}>{view.owner ? "Reconnect" : "Connect MetaMask"}</button></div>
            </div>
          </div>
          <div className={`l1-bridge-step ${atoms ? "is-done" : ""}`}>
            <span className="l1-step-num">{atoms ? <Check size={13} aria-hidden /> : 2}</span>
            <div className="l1-bridge-step-body">
              <b>Choose an amount</b>
              <label className="l1-field"><span className="l1-sr">USDC amount</span><span className="l1-input-wrap"><input aria-label="USDC amount" inputMode="decimal" placeholder="0.00" value={amount} disabled={!!view.pending || view.busy} onChange={(event) => setAmount(event.target.value)} /><span className="l1-input-suffix">{view.balance ? <button type="button" className="l1-max" disabled={!!view.pending || view.busy} onClick={() => setAmount(atomsToUsdc(view.balance))}>Max</button> : null}USDC</span></span>
                <span className="l1-field-hint"><span>{atoms ? <>You receive <Amount atoms={atoms} unit="PFUSDC" /> on Post Fiat</> : "1 USDC becomes 1 PFUSDC."}</span><span>{amount && !atoms ? "Up to six decimals" : ""}</span></span></label>
            </div>
          </div>
          <div className={`l1-bridge-step ${tx ? "is-done" : ""}`}>
            <span className="l1-step-num">{tx ? <Check size={13} aria-hidden /> : 3}</span>
            <div className="l1-bridge-step-body">
              <b>Approve, then deposit</b>
              <p className="l1-small l1-muted">First press Approve USDC and confirm in MetaMask. After approval, you must press Deposit (step 2) and confirm again in MetaMask. Approval alone does not deposit your USDC. Allow about 25 minutes after depositing for PFUSDC to arrive; timing can vary.{view.allowance !== null ? <> Approved so far: <Amount atoms={view.allowance} unit="USDC" />.</> : ""}</p>
              <div className="l1-two">
                <button type="button" className={`l1-btn ${approved ? "" : "is-primary"}`} disabled={!enabled} onClick={() => controller.run(() => controller.approve(amount))}>{approved ? <Check size={15} aria-hidden /> : null}Approve USDC</button>
                <button type="button" className={`l1-btn ${approved ? "is-primary" : ""}`} disabled={!enabled || view.allowance === null || view.allowance < atoms} onClick={() => controller.run(() => controller.deposit(amount))}>Deposit</button>
              </div>
              {(view.approvalTx || tx) && <div className="l1-ethlinks">
                {view.approvalTx && <a href={`https://etherscan.io/tx/${view.approvalTx}`} target="_blank" rel="noreferrer">Approval on Etherscan<ExternalLink size={12} aria-hidden /></a>}
                {tx && <a href={`https://etherscan.io/tx/${tx}`} target="_blank" rel="noreferrer">Deposit on Etherscan<ExternalLink size={12} aria-hidden /></a>}
              </div>}
              {view.busy && <p className="l1-status-line" role="status"><Spinner size={14} />Working… confirm in MetaMask if it asks.</p>}
            </div>
          </div>
        </div>
        {view.pending && !tx && <div style={{ marginTop: 18, display: "grid", gap: 10 }}>
          <Notice tone="warning" title="Deposit broadcast was interrupted">If MetaMask sent the deposit, paste its Ethereum transaction hash to resume tracking it.</Notice>
          <label className="l1-field"><span>Interrupted broadcast: Ethereum transaction hash</span><input className="l1-mono" value={recoveryTx} onChange={(event) => setRecoveryTx(event.target.value)} placeholder="0x…" /></label>
          <div><button type="button" className="l1-btn" disabled={view.busy} onClick={() => controller.run(() => controller.recoverHash(recoveryTx))}>Recover deposit</button></div>
        </div>}
      </Card>
      {view.error && <Notice tone="danger" role="alert">{view.error}</Notice>}
    </div>
    <Track view={view} controller={controller} client={client} onNavigate={onNavigate} symbol={symbol} />
  </section>;
}
export default function BridgeTab({ onNavigate, assetConfig } = {}) {
  const client = useL1Wallet();
  if (!client.unlocked || !client.address) return <p>Unlock your Post Fiat wallet to bridge USDC.</p>;
  return <BridgeSession key={`${client.accountId}:${client.address}`} client={client} onNavigate={onNavigate} symbol={assetConfig?.symbol || "NAVCoins"} />;
}
