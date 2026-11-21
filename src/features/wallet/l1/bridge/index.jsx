import { useCallback, useEffect, useState } from "react";
import { Check, ChartCandlestick, ExternalLink, FileCheck, Landmark, RefreshCw, Wallet } from "lucide-react";
import { useL1Wallet } from "../client.jsx";
import { BridgeController, amountAtoms, needsRecovery } from "./controller.js";
import { atomsToUsdc } from "./evm.js";
import { stageRows, timestamp } from "./stages.js";
import { Amount, Badge, Card, Details, IdChip, KV, Mono, Notice, Spinner } from "../ui.jsx";
import { ACTIVE, AmountField, Credited, DepositForm, DepositProgress, elapsedText, holdsForm, phaseState } from "./DepositView.jsx";
import Withdraw from "./Withdraw.jsx";
import SolanaDeposit from "./SolanaDeposit.jsx";

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
function useNow(enabled) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function Track({ view, controller, client, onNavigate, symbol }) {
  const job = view.job, pending = view.pending, result = view.result;
  const rows = stageRows(job);
  const credited = Boolean(result && !result.balancePending);
  const inFlight = Boolean(pending) && !credited && job?.status !== "failed";
  const now = useNow(inFlight);
  const phases = PHASES.map(phase => ({ ...phase, state: phaseState(rows, phase, credited) }));
  if (pending?.tx && !job && !credited && view.checked) phases[0].state = "active";
  const currentIndex = rows.findIndex(row => ACTIVE.has(row.status));
  const started = job?.created_at_unix || rows.find(row => row.started)?.started || null;
  const finished = credited ? Math.max(...rows.map(row => row.completed || 0)) || null : null;
  const elapsed = started ? (finished || now / 1000) - started : null;
  let headline, detail;
  if (credited) { headline = "Deposit credited"; detail = "The deposit is proven on Post Fiat and the PFUSDC is in this wallet."; }
  else if (result?.balancePending) { headline = "Claim accepted"; detail = "Reading the credited balance from the chain."; }
  else if (job?.status === "failed") { headline = "The bridge could not finish this deposit"; detail = job.message || job.code || "Claim failed."; }
  else if (pending && !pending.tx && view.busy && !view.quiet) { headline = "Confirm the deposit in MetaMask"; detail = "Waiting for you to confirm in MetaMask."; }
  else if (pending && !pending.tx) { headline = "Deposit broadcast was interrupted"; detail = "Enter the Ethereum transaction hash below to recover it."; }
  else if (pending?.tx && !job && !view.checked) { headline = "Checking your last deposit"; detail = "Reading its status from the bridge."; }
  else if (pending?.tx && !job) { headline = "Waiting for Ethereum to confirm your deposit"; detail = "This page keeps checking; you can leave and come back."; }
  else if (job && currentIndex >= 0) { headline = LABELS[rows[currentIndex].stage]; detail = `Stage ${currentIndex + 1} of ${rows.length}. ${rows[currentIndex].stage === "proving" ? "Proof generation is the longest step and can take several minutes." : "Progress updates every few seconds."}${rows[currentIndex].status === "retrying" ? " Retrying after a temporary error." : ""}`; }
  else if (job) { headline = "Deposit received by the bridge"; detail = "Queued for proving."; }
  else { headline = "No deposit in progress"; detail = "Once you deposit, each stage appears here as it completes."; }
  const list = rows.map(row => {
    const running = ACTIVE.has(row.status);
    return { key: row.stage, label: LABELS[row.stage] || row.label, status: row.status, title: `Started ${timestamp(row.started)} · Completed ${timestamp(row.completed)}`,
      time: row.completed && row.started ? elapsedText(row.completed - row.started) : running && row.started ? `${elapsedText(now / 1000 - row.started)}…` : "" };
  });
  return <DepositProgress label="Ethereum deposit progress" source="Ethereum" glyph="Ξ" owner={view.owner} amountAtoms={pending?.amountAtoms}
    recipient={client.address} recipientTestId="bridge-recipient" phases={phases} rows={list} stagesLabel="Ethereum deposit stages"
    headline={headline} detail={detail} running={inFlight} credited={credited} seconds={elapsed}
    action={pending && !credited && <button type="button" className="l1-btn is-sm" disabled={view.busy} onClick={() => controller.run(() => controller.resume())}><RefreshCw size={14} aria-hidden />Refresh progress</button>}
    details={<Details summary="Deposit details">
      <KV className="is-tight" rows={[
        job && ["Bridge job", <span data-testid="bridge-job"><Mono value={job.job_id} /> · {job.status}{job.code ? ` (${job.code})` : ""}</span>],
        pending?.tx && ["Ethereum deposit", <Mono value={pending.tx} />],
        result && !result.balancePending && ["Credited asset", <Mono value={result.assetId} testId="bridge-credited-asset" />],
        ["Recipient", <Mono value={client.address} />],
      ]} />
      <div style={{ marginTop: 10 }}><button type="button" className="l1-btn is-sm" data-testid="bridge-diagnostics" onClick={() => navigator.clipboard?.writeText(JSON.stringify(controller.diagnostics(), null, 2))}>Copy diagnostics</button></div>
    </Details>}>
    {result?.balancePending && <div className="l1-credit" role="status"><p>Claim accepted; credited balance is unverified. Refresh the result.</p>
      <div className="l1-row" style={{ marginTop: 6 }}><span className="l1-muted l1-small">Post Fiat receipt</span><IdChip value={result.receipt} label="receipt id" /></div></div>}
    {credited && <Credited amountAtoms={pending?.amountAtoms}>
      <span className="l1-muted">Bridged PFUSDC balance now <Amount atoms={result.atoms} unit="PFUSDC" testId="bridge-credited-balance" /></span>
      <div className="l1-row" style={{ marginTop: 6 }}><span className="l1-muted l1-small">Post Fiat receipt</span><IdChip value={result.receipt} label="receipt id" /></div>
      <div className="l1-row" style={{ marginTop: 8 }}>
        {onNavigate && <button type="button" className="l1-btn is-primary" onClick={() => onNavigate("Market")}><ChartCandlestick size={16} aria-hidden />Buy {symbol} with PFUSDC</button>}
      </div>
    </Credited>}
  </DepositProgress>;
}

function BridgeSession({ client, onNavigate, symbol, onBusy }) {
  const [view, setView] = useState(null);
  const [controller, setController] = useState(null);
  const [amount, setAmount] = useState("");
  const [recoveryTx, setRecoveryTx] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const pendingRecord = view?.pending;
  useEffect(() => setDiscarding(false), [pendingRecord]);
  useEffect(() => {
    const model = new BridgeController(client, { changed: setView });
    setController(model);
    setView({ ...model.state });
    void model.run(async () => {
      try { await model.readiness(); } catch { /* blocked reason is visible */ }
      if (model.state.pending?.tx) await model.resume();
    }, { quiet: true });
    const changed = () => model.providerChanged();
    window.ethereum?.on?.("accountsChanged", changed);
    window.ethereum?.on?.("chainChanged", changed);
    let lastReadiness = Date.now();
    const timer = setInterval(() => {
      if (model.state.busy) return;
      if (Date.now() - lastReadiness > 15000) {
        lastReadiness = Date.now();
        void model.run(async () => { try { await model.readiness(); } catch { /* fail closed */ } }, { quiet: true });
        return;
      }
      if (model.state.error) return;
      if (model.state.pending?.jobId && model.state.job?.status !== "accepted" && model.state.job?.status !== "failed") {
        void model.run(() => model.poll(), { quiet: true });
      }
    }, 3000);
    return () => {
      clearInterval(timer);
      model.dispose();
      window.ethereum?.removeListener?.("accountsChanged", changed);
      window.ethereum?.removeListener?.("chainChanged", changed);
    };
  }, [client]);
  const unfinished = Boolean(view?.pending) && !(view.result && !view.result.balancePending);
  useEffect(() => { onBusy?.(unfinished); }, [unfinished, onBusy]);
  if (!view || !controller) return <p className="l1-status-line"><Spinner />Loading bridge…</p>;
  const atoms = amountAtoms(amount);
  // A credited deposit does not lock the form; only one that is still unresolved does.
  const credited = Boolean(view.pending && view.result && !view.result.balancePending);
  const locked = holdsForm(!view.pending ? null : credited ? "credited" : view.job?.status === "failed" ? "failed" : "in-flight");
  const working = view.busy && !view.quiet;
  // Until the first check of a saved deposit returns, its state is unknown: say so instead of "in progress".
  const checkingSaved = locked && Boolean(view.pending.tx) && !view.job && !view.checked;
  const enabled = view.ready && !!view.owner && !!atoms && !view.busy && !locked;
  const tx = view.pending?.tx;
  const approved = view.allowance !== null && atoms && view.allowance >= atoms;
  const checking = !view.ready && view.blocked === "Checking bridge readiness.";
  const hasProvider = typeof window !== "undefined" && typeof window.ethereum !== "undefined";
  const steps = [
    { title: "Connect MetaMask", done: Boolean(view.owner), body: <>
      {view.owner ? <div className="l1-row" style={{ justifyContent: "space-between" }}>
        <span className="l1-row" style={{ gap: 8 }}><IdChip value={view.owner} label="Ethereum address" testId="bridge-owner" /><Badge>Ethereum mainnet</Badge></span>
        <span className="l1-small l1-muted">{view.balance === null ? "USDC balance unavailable" : <>Balance <b style={{ color: "var(--l1-text)" }}><Amount atoms={view.balance} unit="USDC" /></b></>}</span>
      </div> : hasProvider ? <p className="l1-small l1-muted">Use the Ethereum account that holds your USDC. Nothing is sent until you approve and deposit.</p>
        : <p className="l1-small l1-muted">MetaMask was not detected in this browser. <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">Install MetaMask</a>, then reload.</p>}
      <div><button type="button" className={`l1-btn ${view.owner ? "is-sm" : "is-primary"}`} disabled={working} onClick={() => controller.run(() => controller.connect())}>{view.owner ? "Reconnect" : "Connect MetaMask"}</button></div>
    </> },
    { title: "Choose an amount", done: Boolean(atoms), body: <AmountField label="USDC amount" value={amount} onChange={setAmount} disabled={locked} max={view.balance ? atomsToUsdc(view.balance) : null}
      hint={atoms ? <>You receive <Amount atoms={atoms} unit="PFUSDC" /> on Post Fiat</> : "1 USDC becomes 1 PFUSDC."} note={amount && !atoms ? "Up to six decimals" : ""} /> },
    { title: "Approve, then deposit", done: Boolean(tx), body: <>
      <p className="l1-small l1-muted">First press Approve USDC and confirm in MetaMask. After approval, you must press Deposit (step 2) and confirm again in MetaMask. Approval alone does not deposit your USDC. Allow about 25 minutes after depositing for PFUSDC to arrive; timing can vary.{view.allowance !== null ? <> Approved so far: <Amount atoms={view.allowance} unit="USDC" />.</> : ""}</p>
      <div className="l1-two">
        <button type="button" className={`l1-btn ${approved ? "" : "is-primary"}`} disabled={!enabled} onClick={() => controller.run(() => controller.approve(amount))}>{approved ? <Check size={15} aria-hidden /> : null}Approve USDC</button>
        <button type="button" className={`l1-btn ${approved ? "is-primary" : ""}`} disabled={!enabled || view.allowance === null || view.allowance < atoms} onClick={() => controller.run(() => controller.deposit(amount))}>Deposit</button>
      </div>
      {(view.approvalTx || tx) && <div className="l1-ethlinks">
        {view.approvalTx && <a href={`https://etherscan.io/tx/${view.approvalTx}`} target="_blank" rel="noreferrer">Approval on Etherscan<ExternalLink size={12} aria-hidden /></a>}
        {tx && <a href={`https://etherscan.io/tx/${tx}`} target="_blank" rel="noreferrer">Deposit on Etherscan<ExternalLink size={12} aria-hidden /></a>}
      </div>}
      {working && <p className="l1-status-line" role="status"><Spinner size={14} />Working… confirm in MetaMask if it asks.</p>}
    </> },
  ];
  return <section aria-label="Ethereum USDC deposit" className="l1-view l1-split is-ticket">
    <div className="l1-stack">
      <DepositForm source="Ethereum" ready={view.ready} checking={checking} readyText={view.ready ? "Bridge ready" : "Bridge unavailable"} refreshDisabled={view.busy}
        onRefresh={() => controller.run(async () => { await controller.readiness(); await controller.refreshEthereum(); })} steps={steps}
        notices={<>
          {!view.ready && !checking && view.blocked && <div style={{ marginBottom: 16 }}><Notice tone="warning" title="Deposits are paused">{view.blocked} Approve and deposit stay off until the bridge reports ready.</Notice></div>}
          {checkingSaved && <p className="l1-status-line" role="status"><Spinner size={14} />Checking your last deposit…</p>}
          {locked && view.pending.tx && !checkingSaved && <div style={{ marginBottom: 16 }}><Notice tone="warning" title="A deposit is still in progress">Your deposit of <Amount atoms={view.pending.amountAtoms} unit="USDC" /> has not finished. The amount box unlocks when it is credited. Follow it under Deposit progress.</Notice></div>}
          {credited && <div style={{ marginBottom: 16 }}><Notice tone="success" title="Your last deposit is complete">Enter an amount to start another.</Notice></div>}
        </>}>
        {!working && needsRecovery(view.pending, view.checkFailed) && <div style={{ marginTop: 18, display: "grid", gap: 10 }}>
          {!tx && <Notice tone="warning" title="Deposit broadcast was interrupted">If MetaMask sent the deposit, paste its Ethereum transaction hash to resume tracking it.</Notice>}
          <label className="l1-field"><span>Interrupted broadcast: Ethereum transaction hash</span><input className="l1-mono" value={recoveryTx} onChange={(event) => setRecoveryTx(event.target.value)} placeholder="0x…" /></label>
          <div className="l1-row"><button type="button" className="l1-btn" disabled={view.busy} onClick={() => controller.run(() => controller.recoverHash(recoveryTx))}>Recover deposit</button>
            {!discarding && <button type="button" className="l1-btn is-ghost" disabled={view.busy} onClick={() => setDiscarding(true)}>Discard this unfinished deposit</button>}</div>
          {discarding && <Notice tone="warning" title="Discard this unfinished deposit?">
            Open MetaMask and check the activity of <Mono value={view.pending.owner} /> for a deposit of <Amount atoms={view.pending.amountAtoms} unit="USDC" />. If MetaMask shows no transaction, nothing was sent and you can discard this record and start again. If it shows a confirmed deposit, do not discard it; paste its transaction hash above instead.
            <div className="l1-row" style={{ marginTop: 10 }}>
              <button type="button" className="l1-btn is-danger" disabled={view.busy} onClick={() => controller.run(() => { controller.discard(); setRecoveryTx(""); })}>Discard deposit</button>
              <button type="button" className="l1-btn" disabled={view.busy} onClick={() => setDiscarding(false)}>Keep it</button>
            </div>
          </Notice>}
        </div>}
      </DepositForm>
      {view.error && <Notice tone="danger" role="alert">{view.error}</Notice>}
    </div>
    <Track view={view} controller={controller} client={client} onNavigate={onNavigate} symbol={symbol} />
  </section>;
}
// One deposit form at a time. Both stay mounted, so a deposit on the other source keeps being
// tracked while it is hidden; its option says so.
const SOURCES = [["ethereum", "Ethereum", "MetaMask"], ["solana", "Solana", "Phantom"]];
const SOURCE_KEY = "l1.bridge.deposit-source";
const savedSource = () => { try { const value = localStorage.getItem(SOURCE_KEY); return SOURCES.some(([id]) => id === value) ? value : null; } catch { return null; } };

export default function BridgeTab({ onNavigate, assetConfig } = {}) {
  const client = useL1Wallet();
  const [chosen, setChosen] = useState(savedSource);
  const [busy, setBusy] = useState({});
  const ethereumBusy = useCallback(value => setBusy(current => ({ ...current, ethereum: value })), []);
  const solanaBusy = useCallback(value => setBusy(current => ({ ...current, solana: value })), []);
  if (!client.unlocked || !client.address) return <p>Unlock your Post Fiat wallet to bridge USDC.</p>;
  // Until the user picks, open on a source with an unfinished deposit.
  const source = chosen || (busy.solana && !busy.ethereum ? "solana" : "ethereum");
  const choose = id => { setChosen(id); try { localStorage.setItem(SOURCE_KEY, id); } catch { /* the choice lasts for this visit */ } };
  return <>
    <Card as="div" className="l1-view l1-source">
      <span className="l1-eyebrow">Deposit USDC from</span>
      <div className="l1-seg" role="radiogroup" aria-label="Deposit source">
        {SOURCES.map(([id, chain, wallet]) => <label key={id}><input type="radio" name="bridge-source" value={id} checked={source === id} onChange={() => choose(id)} />
          <span>{chain} <small>· {wallet}</small>{busy[id] && source !== id && <small className="l1-source-busy"> · deposit in progress</small>}</span></label>)}
      </div>
    </Card>
    <div className="l1-source-pane" hidden={source !== "ethereum"}><BridgeSession key={`${client.accountId}:${client.address}`} client={client} onNavigate={onNavigate} symbol={assetConfig?.symbol || "NAVCoins"} onBusy={ethereumBusy} /></div>
    <div className="l1-source-pane" hidden={source !== "solana"}><SolanaDeposit key={`s:${client.accountId}:${client.address}`} client={client} onBusy={solanaBusy} /></div>
    <Withdraw key={`w:${client.accountId}:${client.address}`} client={client} />
  </>;
}
