import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, CircleAlert, Clock } from "lucide-react";
import { amountAtoms } from "./controller.js";
import { bridgeJson } from "./bridge-relay.js";
import { advanceDeposit, pollDelay, readSaved, RECOVERY_POLL_MS, sendDeposit, setAside } from "./solana-session.js";
import { Amount, Badge, Card, CardHead, Details, IdChip, KV, Mono, Notice, Spinner } from "../ui.jsx";

const stages = [["finality", "Solana finality"], ["capture", "Capture deposit"], ["witness", "Build witness"], ["proof", "Generate proof"],
  ["sign", "Sign Post Fiat transaction"], ["submit", "Submit proof"], ["credit", "Credit on Post Fiat"]];
// Deposits set aside while they can still land; the card keeps checking them.
const readList = key => { try { const list = readSaved(key); return Array.isArray(list) ? list : []; } catch { return []; } };
const elapsed = ms => (Math.max(0, ms) / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 }) + " s";

function Progress({ deposit, reset, retry, earlier = false }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (deposit.terminal) return undefined;
    const clock = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(clock);
  }, [deposit.terminal]);
  const { job, terminal } = deposit;
  const open = deposit.lapsed && !deposit.signature;
  return <Card className="l1-track-card" aria-label="Solana bridge progress">
    <CardHead eyebrow="Solana → Post Fiat" title={earlier ? "Earlier deposit" : "Deposit progress"}>
      <span className="l1-clock"><Clock size={14} aria-hidden /> <span data-testid="solana-clock">{elapsed((deposit.finished ?? now) - deposit.started)}</span></span>
    </CardHead>
    <ol className="l1-stages" aria-label="Solana deposit stages">{stages.map(([stage, label]) => {
      const row = job?.stage_history?.findLast(item => item.stage === stage);
      const status = row?.status || "pending";
      const start = row?.started_at_unix, end = row?.completed_at_unix;
      const time = Number.isFinite(start) && Number.isFinite(end) ? elapsed((end - start) * 1000)
        : Number.isFinite(start) && status === "running" && !terminal ? elapsed(now - start * 1000) : "";
      return <li key={stage} className={`l1-stage is-${status}`}>
        <span className="l1-stage-dot">{status === "complete" ? <Check size={12} /> : status === "running" ? <Spinner size={12} /> : status === "failed" ? <CircleAlert size={12} /> : null}</span>
        <span><b>{label}</b><small className="l1-muted"> · {status}</small></span><span className="l1-stage-time">{time}</span>
      </li>;
    })}</ol>
    {terminal === "credited" && <Notice tone="success" title="Solana deposit credited">+<Amount atoms={deposit.amount_atoms} unit="PFUSDC" /> in this wallet.</Notice>}
    {terminal === "failed" && <Notice tone="danger" title="Solana deposit failed">{job.message || job.code || "The proof relay could not credit this deposit."}</Notice>}
    {terminal === "expired" && <Notice tone="warning" title="Deposit expired">{deposit.nonce_account
      ? "Solana did not record this deposit, and it can no longer go through. No USDC left your wallet."
      : "The blockhash expired without a vault receipt."}</Notice>}
    {!terminal && open && <Notice tone="warning" title="Deposit not recorded yet">Solana has not recorded this deposit yet, but it can still go through. While this page is open, it checks again every 30 seconds for 24 hours and shows the credit if it arrives. Starting another deposit does not cancel this one.</Notice>}
    {terminal === "lapsed" && <Notice tone="warning" title="Deposit not recorded">Solana had not recorded this deposit after 24 hours, so this page stopped checking. Check Phantom&apos;s activity before you deposit again.</Notice>}
    {!terminal && !job && <p className="l1-status-line" role="status"><Spinner size={14} />{deposit.signature ? "Opening the proof job…" : "Waiting for the Solana transaction…"}</p>}
    <KV className="is-tight" rows={[
      ["Recipient", <Mono value={deposit.pftl_recipient} />],
      deposit.signature && ["Solana transaction", <IdChip value={deposit.signature} label="transaction signature" />],
      job?.receipt_id && ["Post Fiat receipt", <IdChip value={job.receipt_id} label="credit receipt" />],
    ]} />
    {terminal === "failed" && job.retryable && <button type="button" className="l1-btn" onClick={retry}>Retry proof job</button>}
    {(terminal || (open && !earlier)) && <button type="button" className="l1-btn is-sm" onClick={reset}>{earlier ? "Dismiss" : "Start another Solana deposit"}</button>}
  </Card>;
}

export default function SolanaDeposit({ client }) {
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
        const route = await bridgeJson("/solana/readiness");
        if (!stopped) setReady(route);
      } catch (failure) { if (!stopped) setReady({ ready: false, message: failure.message }); }
      if (!stopped) timer = setTimeout(refresh, 15000);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

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
        const next = await advanceDeposit(row, client).catch(() => row);
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

  const atoms = amountAtoms(amount);
  const available = /^[0-9]{1,20}$/.test(ready?.available_atoms) ? BigInt(ready.available_atoms) : 0n;
  async function run(action) {
    setBusy(true); setError("");
    try { await action(); } catch (failure) { if (active.current) setError(failure.message); }
    finally { if (active.current) setBusy(false); }
  }
  const send = () => run(() => sendDeposit({ key, provider, request: { owner, amount_atoms: String(atoms), pftl_recipient: client.address },
    ready, save, active: () => active.current && client.unlocked }));
  return <section aria-label="Solana USDC deposit" className="l1-view l1-split is-ticket">
    <Card className="l1-ticket">
      <CardHead eyebrow="Deposit from Solana" title="USDC to PFUSDC">
        <Badge tone={ready?.ready ? "success" : "neutral"}>{ready === null ? "Checking vault…" : ready.ready ? "Vault ready" : "Vault unavailable"}</Badge>
      </CardHead>
      <p className="l1-small">Confirm one vault deposit in Phantom. Post Fiat verifies the proof and credits PFUSDC to this wallet, usually in about two minutes. Phantom also needs about 0.003 SOL for the Solana fee and storage.</p>
      {ready && !ready.ready && <Notice tone="warning">{ready.message}</Notice>}
      {!deposit && <>
        {provider ? <div className="l1-row">
          {owner && <IdChip value={owner} label="Solana address" testId="solana-owner" />}
          <button type="button" className="l1-btn" disabled={busy} onClick={() => run(async () => setOwner((await provider.connect()).publicKey.toString()))}>{owner ? "Reconnect Phantom" : "Connect Phantom"}</button>
        </div> : <a href="https://phantom.com/download" target="_blank" rel="noreferrer">Install Phantom to deposit USDC</a>}
        <label className="l1-field"><span>Solana USDC amount</span><span className="l1-input-wrap"><input aria-label="Solana USDC amount" inputMode="decimal" value={amount} disabled={busy}
          onChange={e => setAmount(e.target.value)} placeholder="0.00" /><span className="l1-input-suffix">USDC</span></span>
          {ready?.ready && <span className="l1-field-hint">Available to deposit · <Amount atoms={available} unit="USDC" /></span>}</label>
        <KV rows={[["Recipient", <Mono value={client.address} />]]} />
        <button type="button" className="l1-btn is-primary" data-testid="solana-send" onClick={send}
          disabled={!provider || busy || !owner || !ready?.ready || !atoms || atoms > available}><ArrowUpRight size={16} aria-hidden />Send with Phantom</button>
      </>}
      {ready?.ready && <Details summary="Vault details"><KV rows={[
        ["Vault program", <Mono value={ready.vault_program_id} />], ["Light-client epoch", ready.light_client_epoch],
        ["Per-deposit cap", <Amount atoms={ready.per_deposit_cap_atoms} unit="USDC" />],
        ["Total vault cap", <Amount atoms={ready.total_cap_atoms} unit="USDC" />],
      ]} /></Details>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </Card>
    {deposit && <Progress deposit={deposit}
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
      }))} />}
    {earlier.map(row => <Progress key={row.nonce} deposit={row} earlier
      retry={() => run(() => updateEarlier(row.nonce, current => current.terminal === "failed"
        ? { ...current, terminal: undefined, finished: undefined, jobId: undefined, job: undefined } : current))}
      reset={() => run(() => updateEarlier(row.nonce, current => current.terminal ? null : current))} />)}
  </section>;
}
