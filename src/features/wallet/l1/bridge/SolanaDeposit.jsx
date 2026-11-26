import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, FileCheck, Landmark, Wallet } from "lucide-react";
import { amountAtoms } from "./controller.js";
import { advanceDeposit, checkEarlier, pollDelay, readSaved, RECOVERY_POLL_MS, sendDeposit, setAside, solanaReadiness } from "./solana-session.js";
import { Amount, Details, IdChip, KV, Mono, Notice, Spinner } from "../ui.jsx";
import { readinessAnswer, readinessRefusal, windowTextAt } from "./proving-window.js";
import { useProvingWindowClock } from "./use-proving-window.js";
import { ACTIVE, AmountField, Credited, DepositForm, DepositProgress, elapsedText, holdsForm, NotSent, phaseState } from "./DepositView.jsx";

const stages = [["finality", "Solana finality"], ["capture", "Capture deposit"], ["witness", "Build witness"], ["proof", "Generate proof"],
  ["sign", "Sign Post Fiat transaction"], ["submit", "Submit proof"], ["credit", "Credit on Post Fiat"]];
// Deposits set aside while they can still land; the card keeps checking them.
const readList = key => { try { const list = readSaved(key); return Array.isArray(list) ? list : []; } catch { return []; } };
const PHASES = [
  { title: "Solana deposit", hint: "Confirmed and final", stages: [0], icon: Wallet },
  { title: "Proof", hint: "Proven and verified", stages: [1, 2, 3], icon: FileCheck },
  { title: "Credited on Post Fiat", hint: "PFUSDC in this wallet", stages: [4, 5, 6], icon: Landmark },
];
// What this saved deposit is to the form (see holdsForm).
const outcome = deposit => !deposit ? null : deposit.terminal === "credited" ? "credited" : deposit.terminal === "expired" ? "not-sent"
  : deposit.terminal ? "failed" : "in-flight";

function Progress({ deposit, owner, recipient, reset, retry, earlier = false }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!deposit || deposit.terminal) return undefined;
    const clock = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(clock);
  }, [deposit, deposit?.terminal]);
  const job = deposit?.job, terminal = deposit?.terminal, credited = terminal === "credited";
  const open = Boolean(deposit?.lapsed && !deposit.signature);
  const rows = stages.map(([stage, label]) => {
    const row = job?.stage_history?.findLast(item => item.stage === stage);
    const status = row?.status || "pending", start = row?.started_at_unix, end = row?.completed_at_unix;
    return { key: stage, label, status, time: Number.isFinite(start) && Number.isFinite(end) ? elapsedText(end - start)
      : Number.isFinite(start) && status === "running" && !terminal ? `${elapsedText(now / 1000 - start)}…` : "" };
  });
  const phases = PHASES.map(phase => ({ ...phase, state: phaseState(rows, phase, credited) }));
  if (deposit && !terminal && !job) phases[0].state = "active";
  const current = rows.findIndex(row => ACTIVE.has(row.status));
  let headline, detail;
  if (!deposit) { headline = "No deposit in progress"; detail = "Once you deposit, each stage appears here as it completes."; }
  else if (credited) { headline = "Deposit credited"; detail = "The deposit is proven on Post Fiat and the PFUSDC is in this wallet."; }
  else if (terminal === "failed") { headline = "The bridge could not finish this deposit"; detail = job?.message || job?.code || "The proof relay could not credit this deposit."; }
  else if (terminal === "lapsed") { headline = "Deposit not recorded"; detail = "Solana had not recorded this deposit after 24 hours, so this page stopped checking. Check Phantom's activity before you deposit again."; }
  else if (open) { headline = "Deposit not recorded yet"; detail = "Solana has not recorded this deposit yet, but it can still go through. This page checks again every 30 seconds for 24 hours and shows the credit if it arrives."; }
  else if (!job) { headline = deposit.signature ? "Deposit received by the bridge" : "Waiting for Solana to confirm your deposit"; detail = deposit.signature ? "Queued for proving." : "This page keeps checking; you can leave and come back."; }
  else if (current >= 0) { headline = rows[current].label; detail = `Stage ${current + 1} of ${rows.length}. ${rows[current].key === "proof" ? "Proof generation is the longest step, usually about a minute." : "Progress updates every few seconds."}`; }
  else { headline = "Deposit received by the bridge"; detail = "Queued for proving."; }
  return <DepositProgress label={earlier ? "Earlier Solana deposit" : "Solana deposit progress"} source="Solana" glyph="◎" title={earlier ? "Earlier deposit" : "Deposit progress"}
    owner={deposit?.owner || owner} amountAtoms={deposit?.amount_atoms} recipient={deposit?.pftl_recipient || recipient} phases={phases} rows={rows} stagesLabel="Solana deposit stages"
    headline={headline} detail={detail} running={Boolean(deposit) && !terminal} credited={credited} clockTestId="solana-clock"
    seconds={deposit ? ((deposit.finished ?? now) - deposit.started) / 1000 : null}
    action={<>
      {terminal === "failed" && job?.retryable && <button type="button" className="l1-btn is-sm" onClick={retry}>Retry proof job</button>}
      {deposit && (earlier ? terminal : open || (terminal && !credited)) && <button type="button" className="l1-btn is-sm" onClick={reset}>{earlier ? "Dismiss" : "Set this deposit aside"}</button>}
    </>}
    details={deposit && <Details summary="Deposit details"><KV className="is-tight" rows={[
      deposit.signature && ["Solana deposit", <IdChip value={deposit.signature} label="transaction signature" />],
      job?.receipt_id && ["Post Fiat receipt", <IdChip value={job.receipt_id} label="credit receipt" />],
      ["Recipient", <Mono value={deposit.pftl_recipient} />],
    ]} /></Details>}>
    {credited && <Credited amountAtoms={deposit.amount_atoms} />}
  </DepositProgress>;
}

export default function SolanaDeposit({ client, onBusy }) {
  const key = `tn:l1:solana-vault:v1:${client.accountId}:${client.address}`, earlierKey = key + ":earlier";
  const [deposit, setDeposit] = useState(() => { try { return readSaved(key); } catch { return null; } });
  const [earlier, setEarlier] = useState(() => readList(earlierKey));
  const [ready, setReady] = useState(null), [owner, setOwner] = useState("");
  const [amount, setAmount] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef(false);
  const provider = window.phantom?.solana?.isPhantom ? window.phantom.solana : null;
  useEffect(() => {
    active.current = true;
    const sync = event => {
      if (event.key === key || event.key === null) setDeposit(readSaved(key));
      if (event.key === earlierKey || event.key === null) setEarlier(readList(earlierKey));
    };
    const changed = pubkey => setOwner(pubkey?.toString() || "");
    const disconnected = () => setOwner("");
    window.addEventListener("storage", sync);
    provider?.on?.("accountChanged", changed);
    provider?.on?.("disconnect", disconnected);
    return () => {
      active.current = false;
      window.removeEventListener("storage", sync);
      provider?.removeListener?.("accountChanged", changed);
      provider?.removeListener?.("disconnect", disconnected);
    };
  }, [key, earlierKey, provider]);
  const save = useCallback(record => {
    if (record) localStorage.setItem(key, JSON.stringify(record));
    else localStorage.removeItem(key);
    if (active.current) setDeposit(record);
  }, [key]);
  // Replace one set-aside deposit by nonce (null removes it), under the list's own lock.
  const updateEarlier = useCallback((nonce, change) => navigator.locks.request(earlierKey, () => {
    const list = readList(earlierKey).flatMap(row => row.nonce === nonce ? [change(row)].filter(Boolean) : [row]);
    if (list.length) localStorage.setItem(earlierKey, JSON.stringify(list));
    else localStorage.removeItem(earlierKey);
    if (active.current) setEarlier(list);
  }), [earlierKey]);
  useEffect(() => {
    let stopped = false, timer;
    async function refresh() {
      try {
        const route = await solanaReadiness();
        if (!stopped) setReady(readinessAnswer(route));
      } catch (failure) { if (!stopped) setReady(readinessRefusal(failure, failure.message)); }
      if (!stopped) timer = setTimeout(refresh, 15000);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  // The screen re-reads readiness every 15 seconds; the clock only advances the text in between.
  const tick = useProvingWindowClock(ready?.proving_window, ready?.received_at, undefined, Boolean(ready?.ready));

  useEffect(() => {
    if (!deposit || busy || deposit.terminal) return undefined;
    let stopped = false, timer;
    async function poll() {
      try {
        const next = await advanceDeposit(deposit, client);
        if (stopped) return;
        setError("");
        if (JSON.stringify(next) !== JSON.stringify(deposit)) {
          await navigator.locks.request(key, async () => {
            if (stopped) return;
            const current = readSaved(key);
            // Another tab may have received Phantom's reply, or finished this job.
            if (JSON.stringify(current) === JSON.stringify(deposit)) save(next);
            else setDeposit(current);
          });
          return;
        }
      } catch (failure) { if (!stopped) setError(failure.message); }
      if (!stopped) timer = setTimeout(poll, pollDelay(deposit));
    }
    // Advance immediately between recovery, job creation and the first status read.
    timer = setTimeout(poll, deposit.job && !deposit.terminal ? 1000 : 0);
    return () => { stopped = true; clearTimeout(timer); };
  }, [deposit, busy, save, key, client]);

  useEffect(() => {
    if (!earlier.some(row => !row.terminal)) return undefined;
    let stopped = false, timer;
    async function poll() {
      for (const row of earlier.filter(item => !item.terminal)) {
        const next = await checkEarlier(row, client);
        if (stopped) return;
        if (JSON.stringify(next) !== JSON.stringify(row)) {
          await updateEarlier(row.nonce, current => JSON.stringify(current) === JSON.stringify(row) ? next : current);
        }
      }
      if (!stopped) timer = setTimeout(poll, RECOVERY_POLL_MS);
    }
    timer = setTimeout(poll, RECOVERY_POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [earlier, client, updateEarlier]);

  const unfinished = outcome(deposit) === "in-flight";
  useEffect(() => { onBusy?.(unfinished); }, [unfinished, onBusy]);

  const atoms = amountAtoms(amount);
  const available = /^[0-9]{1,20}$/.test(ready?.available_atoms) ? BigInt(ready.available_atoms) : 0n;
  async function run(action) {
    setBusy(true); setError("");
    try { await action(); } catch (failure) { if (active.current) setError(failure.message); }
    finally { if (active.current) setBusy(false); }
  }
  // The next send replaces a saved deposit that does not hold the form.
  const state = outcome(deposit), locked = holdsForm(state);
  const send = () => run(async () => {
    await navigator.locks.request(key, () => { const current = readSaved(key); if (current && !holdsForm(outcome(current))) save(null); });
    await sendDeposit({ key, provider, request: { owner, amount_atoms: String(atoms), pftl_recipient: client.address },
      ready, save, active: () => active.current && client.unlocked });
  });
  const steps = [
    { title: "Connect Phantom", done: Boolean(owner), body: <>
      {owner ? <div className="l1-row"><IdChip value={owner} label="Solana address" testId="solana-owner" /></div>
        : provider ? <p className="l1-small l1-muted">Use the Solana account that holds your USDC. Nothing is sent until you confirm in Phantom.</p>
        : <p className="l1-small l1-muted">Phantom was not detected in this browser. <a href="https://phantom.com/download" target="_blank" rel="noreferrer">Install Phantom</a>, then reload.</p>}
      {provider && <div><button type="button" className={`l1-btn ${owner ? "is-sm" : "is-primary"}`} disabled={busy} onClick={() => run(async () => setOwner((await provider.connect()).publicKey.toString()))}>{owner ? "Reconnect" : "Connect Phantom"}</button></div>}
    </> },
    { title: "Choose an amount", done: Boolean(atoms), body: <AmountField label="Solana USDC amount" value={amount} onChange={setAmount} disabled={busy || locked}
      hint={atoms ? <>You receive <Amount atoms={atoms} unit="PFUSDC" /> on Post Fiat</> : "1 USDC becomes 1 PFUSDC."}
      note={atoms && atoms > available ? "Over the deposit limit" : ready?.ready ? <>Limit <Amount atoms={available} unit="USDC" /></> : ""} /> },
    { title: "Send with Phantom", done: Boolean(deposit?.signature) && locked, body: <>
      <p className="l1-small l1-muted">Press Send and confirm once in Phantom. Allow about two minutes for PFUSDC to arrive; timing can vary. Phantom also needs about 0.003 SOL for the Solana fee and storage.</p>
      <div><button type="button" className="l1-btn is-primary" data-testid="solana-send" onClick={send}
        disabled={!provider || busy || locked || !owner || !ready?.ready || !atoms || atoms > available}><ArrowUpRight size={16} aria-hidden />Send with Phantom</button></div>
      {busy && <p className="l1-status-line" role="status"><Spinner size={14} />Working… confirm in Phantom if it asks.</p>}
    </> },
  ];
  const hours = ready && windowTextAt(ready.proving_window, { kind: "deposit", open: Boolean(ready.ready), receivedAt: ready.received_at, at: tick });
  return <section aria-label="Solana USDC deposit" className="l1-view l1-split is-ticket">
    <div className="l1-stack">
      <DepositForm source="Solana" ready={Boolean(ready?.ready)} checking={ready === null} readyText={ready?.ready ? "Bridge ready" : "Bridge unavailable"} steps={steps}
        notices={<>
          {ready && !ready.ready && <div style={{ marginBottom: 16 }}><Notice tone="warning" title="Deposits are paused">{ready.message} Sending stays off until the bridge reports ready.{hours && <> {hours}</>}</Notice></div>}
          {ready?.ready && hours && <p className="l1-muted" role="status">{hours}</p>}
          {state === "not-sent" && <div style={{ marginBottom: 16 }}><NotSent source="Solana" /></div>}
          {state === "in-flight" && <div style={{ marginBottom: 16 }}><Notice tone="warning" title="A deposit is still in progress">Your deposit of <Amount atoms={deposit.amount_atoms} unit="USDC" /> has not finished. The amount box unlocks when it is credited. Follow it under Deposit progress.</Notice></div>}
          {state === "failed" && <div style={{ marginBottom: 16 }}><Notice tone="danger" title="Your last deposit needs attention">See Deposit progress. Retry it there, or set it aside to send another.</Notice></div>}
          {state === "credited" && <div style={{ marginBottom: 16 }}><Notice tone="success" title="Your last deposit is complete">Enter an amount to start another.</Notice></div>}
        </>}>
        {ready?.ready && <Details summary="Vault details"><KV rows={[
          ["Vault program", <Mono value={ready.vault_program_id} />], ["Light-client epoch", ready.light_client_epoch],
          ["Per-deposit cap", <Amount atoms={ready.per_deposit_cap_atoms} unit="USDC" />],
          ["Total vault cap", <Amount atoms={ready.total_cap_atoms} unit="USDC" />],
        ]} /></Details>}
      </DepositForm>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </div>
    <div className="l1-stack">
    <Progress deposit={state === "not-sent" ? null : deposit} owner={owner} recipient={client.address}
      retry={() => run(() => navigator.locks.request(key, () => {
        const current = readSaved(key);
        if (current?.nonce === deposit.nonce && current.terminal === "failed") {
          save({ ...current, terminal: undefined, finished: undefined, jobId: undefined, job: undefined });
        }
      }))}
      reset={() => run(() => navigator.locks.request(key, async () => {
        const current = readSaved(key);
        // A deposit that can still land is set aside and still checked.
        if (current?.nonce === deposit.nonce && !current.terminal && current.lapsed && !current.signature) {
          await navigator.locks.request(earlierKey, () => {
            const list = setAside(readList(earlierKey), current);
            localStorage.setItem(earlierKey, JSON.stringify(list));
            if (active.current) setEarlier(list);
          });
          save(null);
        }
        if (current?.nonce === deposit.nonce && current.terminal) save(null);
        setAmount("");
      }))} />
      {earlier.map(row => <Progress key={row.nonce} deposit={row} earlier
      retry={() => run(() => updateEarlier(row.nonce, current => current.terminal === "failed"
        ? { ...current, terminal: undefined, finished: undefined, jobId: undefined, job: undefined } : current))}
      reset={() => run(() => updateEarlier(row.nonce, current => current.terminal ? null : current))} />)}
    </div>
  </section>;
}
