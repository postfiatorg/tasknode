import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { bridgeJson } from "./bridge-relay.js";
import { amountAtoms } from "./controller.js";
import { lineBalance } from "../market/model.js";
import { Amount, Badge, Card, CardHead, KV, Mono, Notice, Spinner } from "../ui.jsx";
import { answerExpiry, EXPIRED, monotonicNow, readinessAnswer, readinessOrder, readinessRefusal, windowTextAt } from "./proving-window.js";
import { useProvingWindowClock } from "./use-proving-window.js";
import { plainError } from "../format.js";

// Thrown by a Review that a newer answer or operation superseded: it stops without a message.
const OBSOLETE = Error("superseded");
// Said when a Review or Confirm read twice and each read was superseded by a newer answer.
const CHANGED = "Withdrawal availability changed while it was checked. Review the withdrawal again.";

// PFUSDC -> USDC on Ethereum. The wallet signs one burn; the payout job needs no further signature.
const STAGES = { queued: "Waiting to start", reading: "Reading your burn from the network", catching_up: "Bringing the Ethereum checker up to date", proving: "Building the withdrawal proof", paying: "Sending USDC on Ethereum", paid: "USDC paid", failed: "Stopped" };
const key = (client) => `l1-withdrawal:${client.accountId}:${client.address}`;
const stored = (client) => { try { const value = localStorage.getItem(key(client)); return /^[0-9a-f]{96}$/.test(value || "") ? value : ""; } catch { return ""; } };

export default function EthereumWithdraw({ client }) {
  const [ready, setReady] = useState(null), [held, setHeld] = useState(null);
  const [amount, setAmount] = useState(""), [recipient, setRecipient] = useState("");
  const [review, setReview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [burn, setBurn] = useState(() => stored(client)), [job, setJob] = useState(null);
  // Every readiness request is numbered when it is made, and every write of its completion (the
  // readiness, the balance read after it) goes through order.apply: nothing is written once a newer
  // request's answer has been applied (see readinessOrder).
  const order = useRef(null);
  order.current ??= readinessOrder();
  const store = useCallback((made, carries, next, open) => {
    if (!order.current.apply(made, carries, open)) return false;
    setReady(next);
    return true;
  }, []);
  const refresh = useCallback(async (attempts = 3) => {
    const made = order.current.next();
    let carries = false;
    try {
      // The payout service's chain read can fail briefly under a burst of page-load requests; retry before saying paused.
      let value;
      for (let attempt = 0; ; attempt++) {
        try { value = await bridgeJson("/withdrawals/readiness", { signal: AbortSignal.timeout(45000) }); if (value.ready || attempt >= attempts - 1) break; }
        catch (failure) { if (attempt >= attempts - 1) throw failure; }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      carries = Boolean(value.proving_window);
      if (!store(made, carries, () => readinessAnswer(value), Boolean(value.ready))) return;
      if (value.ready) {
        const balances = await client.getBalances();
        if (order.current.apply(made, carries)) setHeld(lineBalance(balances.assets, value.series_asset_id));
      }
    } catch (failure) {
      store(made, carries || Boolean(failure.payload?.proving_window), previous => readinessRefusal(failure, plainError(failure.message), monotonicNow(), previous), false);
    }
  }, [client, store]);
  // The window's automatic reads ask once; the scheduler in useProvingWindowClock spaces them.
  const autoRefresh = useCallback(() => refresh(1), [refresh]);
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
    };
    void poll();
    const timer = setInterval(() => { if (job?.stage !== "paid") void poll(); }, 8000);
    return () => { active = false; clearInterval(timer); };
  }, [burn, job?.stage]);
  async function useMetaMask() {
    setError("");
    try { const [account] = await window.ethereum.request({ method: "eth_requestAccounts" }); if (account) setRecipient(account); }
    catch (failure) { setError(plainError(failure.message)); }
  }
  const atoms = amountAtoms(amount);
  const to = recipient.trim().toLowerCase();
  const validTo = /^0x[0-9a-f]{40}$/.test(to);
  const tooMuch = atoms && held !== null && atoms > held;
  // One readiness read of a Review or Confirm, as a new operation (op.made). Once this screen has
  // applied a window, its answer, also a refusal, replaces the stored one through the same ordering;
  // an answer older than one already applied is not written and comes back as OBSOLETE. A screen
  // that never had a window keeps its earlier readiness.
  // op.expires: when its answer stops permitting a burn, counted from when the request started (see answerExpiry).
  async function operationRead(op) {
    op.made = order.current.begin(); op.carries = false;
    const started = monotonicNow();
    try {
      const fresh = await bridgeJson("/withdrawals/readiness", { signal: AbortSignal.timeout(45000) });
      op.carries = Boolean(fresh.proving_window); op.expires = answerExpiry(fresh.proving_window, started);
      return (order.current.seen || op.carries) && !store(op.made, op.carries, () => readinessAnswer(fresh), Boolean(fresh.ready)) ? OBSOLETE : fresh;
    } catch (failure) {
      op.carries = Boolean(failure.payload?.proving_window);
      if ((order.current.seen || op.carries) && !store(op.made, op.carries, previous => readinessRefusal(failure, plainError(failure.message), monotonicNow(), previous), false)) return OBSOLETE;
      throw failure;
    }
  }
  async function prepare(event) {
    event.preventDefault(); setError(""); setReview(null); setBusy(true);
    // The operation goes on after each await only while it is current (order.current).
    const op = { made: 0, carries: false };
    const still = () => order.current.current(op.made, op.carries);
    try {
      let fresh = await operationRead(op);
      // Only a newer open answer superseded the read: read once more instead of dropping the Review.
      if (fresh === OBSOLETE && still()) fresh = await operationRead(op);
      if (!still()) throw OBSOLETE;
      if (fresh === OBSOLETE) throw new Error(CHANGED);
      if (!fresh.ready) throw new Error(fresh.message || "Withdrawals are unavailable.");
      if (atoms > BigInt(fresh.bucket_outstanding_atoms)) throw new Error("This is more than the bridge currently holds for this deposit series.");
      const intent = { kind: "asset", operation: { operation: "vault_bridge_burn_to_redeem", owner: client.address, issuer: fresh.issuer, asset_id: fresh.asset_id, bucket_id: fresh.bucket_id, amount_atoms: Number(atoms), epoch: fresh.epoch, reserve_packet_hash: fresh.reserve_packet_hash, destination_ref: `${fresh.destination_prefix}${to}` } };
      const quote = await client.quote(intent);
      if (!still()) throw OBSOLETE;
      setReview({ intent, quote, atoms, to, made: op.made, carries: op.carries, expires: op.expires });
    } catch (failure) { if (failure !== OBSOLETE && still()) setError(plainError(failure.message)); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!review || busy) return;
    // Confirm goes on with the Review's operation: it stops quietly once that is no longer current.
    const approved = review; setReview(null);
    const op = { made: approved.made, carries: approved.carries };
    const still = () => order.current.current(op.made, op.carries);
    if (!still()) return;
    setBusy(true); setError("");
    // Once a window is involved, the transport asks this operation once more, after its connection is
    // established and just before the burn leaves; without one the burn counts as sent from here, as before.
    const guarded = order.current.seen || op.carries;
    // expires: when the answer this burn rests on stops permitting it (see answerExpiry).
    let sent = false, expired = false, expires = approved.expires;
    try {
      // The Review's answer is not trusted past the window's next boundary or once stale: read again.
      if (guarded && monotonicNow() >= expires) {
        const fresh = await operationRead(op);
        if (!still()) return;
        if (fresh === OBSOLETE) throw new Error(CHANGED);
        if (!fresh.ready) throw new Error(fresh.message || "Withdrawals are unavailable.");
        const { operation } = approved.intent;
        if (["issuer", "asset_id", "bucket_id", "epoch", "reserve_packet_hash"].some(field => fresh[field] !== operation[field])
            || operation.destination_ref !== `${fresh.destination_prefix}${approved.to}` || approved.atoms > BigInt(fresh.bucket_outstanding_atoms)) {
          throw new Error("The reserve changed. Review the withdrawal again.");
        }
        // An answer already expired when it arrives permits nothing.
        expires = op.expires;
        if (monotonicNow() >= expires) { expired = true; throw new Error(EXPIRED); }
      }
      const signed = await client.sign(approved.intent, approved.quote);
      if (!still()) return;  // signed, never sent
      // Checked last before the bytes leave: the operation is current and its answer has not expired.
      const guard = guarded ? () => (sent = still() && !(expired = monotonicNow() >= expires)) : undefined;
      sent = !guard;
      const result = await (guard ? client.submit(signed, { guard }) : client.submit(signed));
      try { localStorage.setItem(key(client), result.txId); } catch { /* tracking still works this session */ }
      setJob(null); setBurn(result.txId); setAmount("");
      await bridgeJson("/withdrawals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ burn_tx_id: result.txId }) });
      void refresh();
    } catch (failure) { if (expired) setError(EXPIRED); else if (sent || (failure.code !== "l1_not_dispatched" && still())) setError(plainError(failure.message)); } finally { setBusy(false); }
  }
  function another() { try { localStorage.removeItem(key(client)); } catch { /* ignore */ } setBurn(""); setJob(null); setError(""); void refresh(); }
  const tracking = Boolean(burn);
  const tick = useProvingWindowClock(ready?.proving_window, ready?.received_at, autoRefresh, Boolean(ready?.ready), ready);
  const hours = ready && windowTextAt(ready.proving_window, { kind: "withdrawal", open: Boolean(ready.ready), unknown: ready.unknown, receivedAt: ready.received_at, at: tick });
  // A review is offered only while its operation is current: a newer closed answer withdraws it.
  const offered = review && order.current.current(review.made, review.carries) ? review : null;
  return <section aria-label="USDC withdrawal" className="l1-view l1-split is-ticket">
    <div className="l1-stack">
      <Card className="l1-ticket">
        <CardHead eyebrow="Convert" title="PFUSDC to USDC">
          {ready === null ? <Badge><Spinner size={12} />Checking</Badge> : <Badge tone={ready.ready ? "success" : "warning"} dot>{ready.ready ? "Withdrawals ready" : "Withdrawals unavailable"}</Badge>}
        </CardHead>
        {ready && !ready.ready && <Notice tone="warning" title="Withdrawals are paused">{ready.message || "The payout service is not ready."}{hours && <> {hours}</>}</Notice>}
        {ready?.ready && hours && <p className="l1-small l1-muted" role="status">{hours}</p>}
        {!tracking && <form onSubmit={prepare} style={{ display: "grid", gap: 14 }}>
          <label className="l1-field"><span>PFUSDC to withdraw</span><span className="l1-input-wrap"><input aria-label="PFUSDC amount" inputMode="decimal" placeholder="0.00" value={amount} disabled={busy} onChange={(event) => { setAmount(event.target.value); setReview(null); }} /><span className="l1-input-suffix">PFUSDC</span></span>
            <span className="l1-field-hint"><span>{held === null ? "" : <>Available from Ethereum deposits: <Amount atoms={held} unit="PFUSDC" /></>}</span><span className={tooMuch ? "is-danger" : ""}>{tooMuch ? "More than you hold" : "1 PFUSDC becomes 1 USDC."}</span></span></label>
          <label className="l1-field"><span>Ethereum address that receives USDC</span><input aria-label="Ethereum recipient" className="l1-mono-input" spellCheck={false} autoComplete="off" placeholder="0x…" value={recipient} disabled={busy} onChange={(event) => { setRecipient(event.target.value); setReview(null); }} />
            <span className="l1-field-hint"><span>{recipient && !validTo ? <span className="is-danger">Enter a 0x address with 40 hex characters.</span> : "Ethereum mainnet. The address cannot be changed after you confirm."}</span>{typeof window !== "undefined" && window.ethereum ? <button type="button" className="l1-link" onClick={useMetaMask}>Use my MetaMask address</button> : null}</span></label>
          <button type="submit" className="l1-btn is-primary is-lg is-block" disabled={busy || !ready?.ready || !atoms || !validTo || Boolean(tooMuch)}>Review withdrawal</button>
        </form>}
        {offered && <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          <KV className="is-tight" rows={[
            ["You burn", <Amount atoms={offered.atoms} unit="PFUSDC" />],
            ["You receive on Ethereum", <Amount atoms={offered.atoms} unit="USDC" />],
            ["To", <Mono value={offered.to} />],
            ["Network fee", <Amount atoms={offered.quote.minimum_fee} unit="PFT" />],
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
