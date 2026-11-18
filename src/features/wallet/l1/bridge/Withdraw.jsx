import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { bridgeJson } from "./bridge-relay.js";
import { amountAtoms } from "./controller.js";
import { lineBalance } from "../market/model.js";
import { Amount, Badge, Card, CardHead, KV, Mono, Notice, Spinner } from "../ui.jsx";
import { plainError } from "../format.js";
import { canDiscardBurn, resendBurn, stalledAction, withdrawalStalled } from "./withdraw-recovery.js";

// PFUSDC -> USDC on Ethereum. The wallet signs one burn; the payout job needs no further signature.
const STAGES = { queued: "Waiting to start", reading: "Reading your burn from the network", catching_up: "Bringing the Ethereum checker up to date", proving: "Building the withdrawal proof", paying: "Sending USDC on Ethereum", paid: "USDC paid", failed: "Stopped" };
const key = (client) => `l1-withdrawal:${client.accountId}:${client.address}`;
const stored = (client) => { try { const value = localStorage.getItem(key(client)); return /^[0-9a-f]{96}$/.test(value || "") ? value : ""; } catch { return ""; } };

export default function Withdraw({ client }) {
  const [ready, setReady] = useState(null), [held, setHeld] = useState(null);
  const [amount, setAmount] = useState(""), [recipient, setRecipient] = useState("");
  const [review, setReview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [burn, setBurn] = useState(() => stored(client)), [job, setJob] = useState(null);
  const [since, setSince] = useState(() => Date.now()), [now, setNow] = useState(() => Date.now()), [stall, setStall] = useState(null), [confirmDiscard, setConfirmDiscard] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const value = await bridgeJson("/withdrawals/readiness", { signal: AbortSignal.timeout(45000) });
      setReady(value);
      if (value.ready) { const balances = await client.getBalances(); setHeld(lineBalance(balances.assets, value.series_asset_id)); }
    } catch (failure) { setReady({ ready: false, message: plainError(failure.message) }); }
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!burn) return undefined;
    let active = true;
    const poll = async () => {
      try {
        let value;
        try { value = await bridgeJson(`/withdrawals/${burn}`); }
        catch { value = await bridgeJson("/withdrawals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ burn_tx_id: burn }) }); }
        if (active) setJob(value);
      } catch (failure) { if (active) setError(plainError(failure.message)); }
      if (active) setNow(Date.now());
    };
    void poll();
    const timer = setInterval(() => { if (job?.stage !== "paid") void poll(); }, 8000);
    return () => { active = false; clearInterval(timer); };
  }, [burn, job?.stage]);
  const stalled = withdrawalStalled(burn, job, since, now);
  useEffect(() => {
    if (!stalled) return undefined;
    let active = true;
    stalledAction(client, burn).then((action) => { if (active) setStall(action); }, () => {});
    return () => { active = false; };
  }, [stalled, burn, client, now]);
  async function useMetaMask() {
    setError("");
    try { const [account] = await window.ethereum.request({ method: "eth_requestAccounts" }); if (account) setRecipient(account); }
    catch (failure) { setError(plainError(failure.message)); }
  }
  const atoms = amountAtoms(amount);
  const to = recipient.trim().toLowerCase();
  const validTo = /^0x[0-9a-f]{40}$/.test(to);
  const tooMuch = atoms && held !== null && atoms > held;
  async function prepare(event) {
    event.preventDefault(); setError(""); setReview(null); setBusy(true);
    try {
      const fresh = await bridgeJson("/withdrawals/readiness", { signal: AbortSignal.timeout(45000) });
      if (!fresh.ready) throw new Error(fresh.message || "Withdrawals are unavailable.");
      if (atoms > BigInt(fresh.bucket_outstanding_atoms)) throw new Error("This is more than the bridge currently holds for this deposit series.");
      const intent = { kind: "asset", operation: { operation: "vault_bridge_burn_to_redeem", owner: client.address, issuer: fresh.issuer, asset_id: fresh.asset_id, bucket_id: fresh.bucket_id, amount_atoms: Number(atoms), epoch: fresh.epoch, reserve_packet_hash: fresh.reserve_packet_hash, destination_ref: `${fresh.destination_prefix}${to}` } };
      setReview({ intent, quote: await client.quote(intent), atoms, to });
    } catch (failure) { setError(plainError(failure.message)); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!review || busy) return;
    const approved = review; setReview(null); setBusy(true); setError("");
    try {
      const signed = await client.sign(approved.intent, approved.quote);
      const result = await client.submit(signed);
      try { localStorage.setItem(key(client), result.txId); } catch { /* tracking still works this session */ }
      setJob(null); setStall(null); setSince(Date.now()); setBurn(result.txId); setAmount("");
      await bridgeJson("/withdrawals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ burn_tx_id: result.txId }) });
      void refresh();
    } catch (failure) { setError(plainError(failure.message)); } finally { setBusy(false); }
  }
  function another() { try { localStorage.removeItem(key(client)); } catch { /* ignore */ } setBurn(""); setJob(null); setStall(null); setConfirmDiscard(false); setError(""); void refresh(); }
  function tryAgain() { setError(""); void resendBurn(burn).then(setJob).catch((failure) => setError(plainError(failure.message))); }
  async function discard() {
    setConfirmDiscard(false); setError("");
    try { await canDiscardBurn(client, burn); another(); } catch (failure) { setError(plainError(failure.message)); }
  }
  const tracking = Boolean(burn);
  return <section aria-label="USDC withdrawal" className="l1-view l1-split is-ticket">
    <div className="l1-stack">
      <Card className="l1-ticket">
        <CardHead eyebrow="Convert" title="PFUSDC to USDC">
          {ready === null ? <Badge><Spinner size={12} />Checking</Badge> : <Badge tone={ready.ready ? "success" : "warning"} dot>{ready.ready ? "Withdrawals ready" : "Withdrawals unavailable"}</Badge>}
        </CardHead>
        {ready && !ready.ready && <Notice tone="warning" title="Withdrawals are paused">{ready.message || "The payout service is not ready."}</Notice>}
        {!tracking && <form onSubmit={prepare} style={{ display: "grid", gap: 14 }}>
          <label className="l1-field"><span>PFUSDC to withdraw</span><span className="l1-input-wrap"><input aria-label="PFUSDC amount" inputMode="decimal" placeholder="0.00" value={amount} disabled={busy} onChange={(event) => { setAmount(event.target.value); setReview(null); }} /><span className="l1-input-suffix">PFUSDC</span></span>
            <span className="l1-field-hint"><span>{held === null ? "" : <>You hold <Amount atoms={held} unit="PFUSDC" /></>}</span><span className={tooMuch ? "is-danger" : ""}>{tooMuch ? "More than you hold" : "1 PFUSDC becomes 1 USDC."}</span></span></label>
          <label className="l1-field"><span>Ethereum address that receives USDC</span><input aria-label="Ethereum recipient" className="l1-mono-input" spellCheck={false} autoComplete="off" placeholder="0x…" value={recipient} disabled={busy} onChange={(event) => { setRecipient(event.target.value); setReview(null); }} />
            <span className="l1-field-hint"><span>{recipient && !validTo ? <span className="is-danger">Enter a 0x address with 40 hex characters.</span> : "Ethereum mainnet. The address cannot be changed after you confirm."}</span>{typeof window !== "undefined" && window.ethereum ? <button type="button" className="l1-link" onClick={useMetaMask}>Use my MetaMask address</button> : null}</span></label>
          <button type="submit" className="l1-btn is-primary is-lg is-block" disabled={busy || !ready?.ready || !atoms || !validTo || Boolean(tooMuch)}>Review withdrawal</button>
        </form>}
        {review && <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          <KV className="is-tight" rows={[
            ["You burn", <Amount atoms={review.atoms} unit="PFUSDC" />],
            ["You receive on Ethereum", <Amount atoms={review.atoms} unit="USDC" />],
            ["To", <Mono value={review.to} />],
            ["Network fee", <Amount atoms={review.quote.minimum_fee} unit="PFT" />],
          ]} />
          <p className="l1-small l1-muted">Your PFUSDC is burned as soon as you confirm. The USDC is then released by proof from the bridge vault, usually within {ready?.minutes_estimate || 12} minutes. No MetaMask confirmation is needed.</p>
          <div className="l1-two"><button type="button" className="l1-btn" disabled={busy} onClick={() => setReview(null)}>Discard</button><button type="button" className="l1-btn is-primary" disabled={busy} onClick={confirm}>Confirm and burn</button></div>
        </div>}
        {busy && <p className="l1-status-line" role="status"><Spinner size={14} />Working…</p>}
        {tracking && <div style={{ display: "grid", gap: 12 }}>
          {job?.stage === "paid" ? <Notice tone="success" title="USDC paid on Ethereum">{job.amount_atoms ? <><Amount atoms={job.amount_atoms} unit="USDC" /> was sent to </> : "USDC was sent to "}<Mono value={job.recipient || ""} />.</Notice>
            : job?.stage === "failed" ? <Notice tone="danger" title="Withdrawal stopped">{job.error || job.detail || "The payout job failed."} Your burn is recorded on the network and the payout can be retried.</Notice>
            : <p className="l1-status-line" role="status"><Spinner size={14} />{STAGES[job?.stage] || "Starting withdrawal"}{job?.detail && job.stage === "catching_up" ? `: ${job.detail}` : "…"}</p>}
          <KV className="is-tight" rows={[
            ["Burn on Post Fiat", <Mono value={burn} />],
            job?.amount_atoms && ["Amount", <Amount atoms={job.amount_atoms} unit="USDC" />],
            job?.recipient && ["Recipient", <Mono value={job.recipient} />],
            job?.ethereum_tx && ["Ethereum payout", <a href={`https://etherscan.io/tx/${job.ethereum_tx}`} target="_blank" rel="noreferrer">View on Etherscan<ExternalLink size={12} aria-hidden /></a>],
          ].filter(Boolean)} />
          {stalled && stall === "retry" && <Notice tone="warning" title="The payout service has not taken this burn" action={<button type="button" className="l1-btn is-primary" onClick={tryAgain}>Try again</button>}>Burn <Mono value={burn} /> is accepted on the chain. Try again sends this same burn id to the service; nothing is burned again.</Notice>}
          {stalled && stall === "discard" && <Notice tone="warning" title="This burn is not on the chain" action={confirmDiscard
            ? <div className="l1-two"><button type="button" className="l1-btn" onClick={() => setConfirmDiscard(false)}>Keep it</button><button type="button" className="l1-btn is-primary" onClick={discard}>Discard</button></div>
            : <button type="button" className="l1-btn" onClick={() => setConfirmDiscard(true)}>Discard this withdrawal</button>}>The chain has no accepted burn <Mono value={burn} />, so no PFUSDC was burned for it. Discarding clears only this pending withdrawal.</Notice>}
          <div className="l1-two">
            {job?.stage === "failed" && <button type="button" className="l1-btn is-primary" disabled={busy} onClick={() => { setError(""); void bridgeJson("/withdrawals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ burn_tx_id: burn }) }).then(setJob).catch((failure) => setError(plainError(failure.message))); }}>Retry payout</button>}
            {(job?.stage === "paid" || job?.stage === "failed") && <button type="button" className="l1-btn" onClick={another}>Start another withdrawal</button>}
          </div>
        </div>}
      </Card>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </div>
  </section>;
}
