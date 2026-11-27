import { useCallback, useEffect, useRef, useState } from "react";
import { Amount, Card, CardHead, KV, Notice, Spinner } from "../ui.jsx";
import SolanaPayout from "./SolanaPayout.jsx";
import { monotonicNow, readinessOrder, received, windowTextAt } from "./proving-window.js";
import { useProvingWindowClock } from "./use-proving-window.js";
import { checkRecipient, destinationRef, isBurnId, phantomAddress, savedBurn, submitBurn, UNAVAILABLE, walletBurns, withdrawalAtoms, withdrawalIntent, withdrawalSnapshot } from "./solana-withdrawal.js";

// Burns read from this wallet's chain history, so a withdrawal made in another browser can be tracked here.
function WalletBurns({ client, onTrack }) {
  const [burns, setBurns] = useState(null);
  useEffect(() => {
    let active = true;
    walletBurns(client).then(rows => { if (active) setBurns(rows); }, () => { if (active) setBurns([]); });
    return () => { active = false; };
  }, [client]);
  if (!burns?.length) return null;
  return <div className="l1-stack">
    <b>Recent burns from this wallet</b>
    {burns.map(row => <div key={row.id} className="l1-row">
      <span className="l1-mono" style={{ overflowWrap: "anywhere" }}>{row.id}</span>
      <button type="button" className="l1-btn" onClick={() => onTrack(row.id)}>Track this payout</button>
    </div>)}
  </div>;
}

// Thrown by a Review or Confirm that a newer answer or operation superseded: it stops without a message.
const OBSOLETE = Error("superseded");
// Said when a Review or Confirm read twice and each read was superseded by a newer answer.
const CHANGED = "Withdrawal availability changed while it was checked. Review the withdrawal again.";
// A pending claim of the shared slot. Once a window is involved it names its operation, so a cleanup
// can tell its own claim from one another tab made since; without a window it stays as before.
const claimFor = named => (named ? `submitting:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}` : "submitting");

export default function SolanaWithdraw({ client, storageKey }) {
  const [snapshot, setSnapshot] = useState(undefined), [error, setError] = useState("");
  const [recipient, setRecipient] = useState(""), [amount, setAmount] = useState("");
  const [review, setReview] = useState(null), [busy, setBusy] = useState(false);
  const [burn, setBurn] = useState(() => savedBurn(storageKey)), [create, setCreate] = useState(false);
  const [recovery, setRecovery] = useState(""), [provingWindow, setProvingWindow] = useState(undefined);
  const submitting = useRef(false);
  // Every readiness request, from refresh, Review and Confirm, is numbered when it is made, and every
  // write of its completion (the window, the snapshot after the balance reads, the error) goes
  // through may(): nothing is written once a newer request's answer has been applied (see
  // readinessOrder). A failed read with no answer keeps the last window and its clock and only drops "open".
  const order = useRef(null);
  order.current ??= readinessOrder();
  const request = useCallback((operation = false) => {
    const n = operation ? order.current.begin() : order.current.next();
    let carries = false;
    const may = () => order.current.apply(n, carries);
    // After every later await of Review and Confirm: still the newest operation, and no newer answer said closed.
    const still = () => order.current.current(n, carries);
    const onWindow = value => {
      carries = Boolean(value.window);
      if (order.current.apply(n, carries, value.open)) setProvingWindow(previous => value.answered === false && previous?.window ? { ...previous, open: false, unknown: true, failed_at: monotonicNow() } : received(value));
    };
    // The snapshot of this request, or its failure; the failure of an answer older than one already
    // applied stops the operation without a message.
    const read = () => withdrawalSnapshot(client, onWindow).catch(failure => { throw may() ? failure : OBSOLETE; });
    return { n, may, still, onWindow, read, carries: () => carries };
  }, [client]);
  // The operation's own snapshot. An answer older than one already applied is not written; when
  // only a newer open answer superseded the read (no newer closed answer, no newer operation), the
  // operation reads once more instead of stopping, and says so if that read is superseded too.
  const operationRead = useCallback(async (use) => {
    for (let attempt = 0; ; attempt++) {
      const op = request(true); use(op);
      let fresh = OBSOLETE;
      try { fresh = await op.read(); } catch (failure) { if (failure !== OBSOLETE) throw failure; }
      if (!op.still()) throw OBSOLETE;
      if (fresh !== OBSOLETE && op.may()) return fresh;
      if (attempt) throw Error(CHANGED);
    }
  }, [request]);
  const refresh = useCallback(async () => {
    const { may, onWindow } = request();
    try { const value = await withdrawalSnapshot(client, onWindow); if (may()) setSnapshot(value); }
    catch (failure) { if (may()) { setSnapshot(null); setError(`${failure.message} No funds moved.`); } }
  }, [client, request]);
  useEffect(() => { if (!burn) void refresh(); }, [refresh, burn]);
  useEffect(() => {
    const sync = event => {
      if (event.storageArea === localStorage && event.key === storageKey) {
        setReview(null); setCreate(false); setBurn(event.newValue || "");
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [storageKey]);

  const phantom = window.phantom?.solana || (window.solana?.isPhantom && window.solana);
  async function usePhantom() {
    setBusy(true); setError(""); setReview(null);
    try {
      setRecipient(await phantomAddress(phantom));
    } catch (failure) { setError(`Could not use your Phantom address. ${failure.message} No funds moved.`); }
    finally { setBusy(false); }
  }
  let recipientError, amountError;
  if (recipient) {
    try { destinationRef("", recipient); } catch (failure) { recipientError = failure.message; }
  }
  if (amount && snapshot) {
    try { withdrawalAtoms(amount, snapshot.held, snapshot.outstanding, snapshot.minimum); } catch (failure) { amountError = failure.message; }
  }
  async function prepare(event) {
    event.preventDefault();
    setBusy(true); setReview(null); setError("");
    let op = null;
    const still = () => !op || op.still();
    try {
      const fresh = await operationRead(next => { op = next; });
      setSnapshot(fresh);
      if (!fresh) { setError("Review stopped before signing. No funds moved."); return; }
      await checkRecipient(recipient);
      if (!still()) throw OBSOLETE;
      const intent = withdrawalIntent(client, fresh, amount, recipient);
      const quote = await client.quote(intent);
      if (!still()) throw OBSOLETE;
      setReview({ intent, quote, made: op.n, carries: op.carries() });
    } catch (failure) { if (failure !== OBSOLETE && still()) setError(`${failure.message} No funds moved.`); } finally { setBusy(false); }
  }

  function track(id, register) {
    setCreate(register); setBurn(id);
    try { localStorage.setItem(storageKey, id); }
    catch { setError("Your browser could not save the burn ID. Copy it before leaving to recover the payout."); }
  }
  // This operation's own burn (mine: the record it holds in the slot). It replaces only that record
  // or an empty slot; a record another tab saved meanwhile is kept, and this burn ID is shown instead.
  function keep(id, mine) {
    setCreate(true); setBurn(id);
    try {
      const current = localStorage.getItem(storageKey);
      if (current && current !== mine && current !== id) { setError(`Another tab saved a different withdrawal here. Copy this burn ID to track its payout: ${id}`); return; }
      localStorage.setItem(storageKey, id);
    } catch { setError("Your browser could not save the burn ID. Copy it before leaving to recover the payout."); }
  }
  async function confirm() {
    if (!review || submitting.current) return;
    submitting.current = true; setBusy(true); setError(""); setReview(null);
    // sent: the burn may have left this browser. mine: the record this operation holds in the slot.
    let sent = false, mine = "", op = null;
    const still = () => !op || op.still();
    try {
      const fresh = await operationRead(next => { op = next; });
      setSnapshot(fresh);
      if (!fresh) { setError("Confirmation stopped before signing. No funds moved."); return; }
      await checkRecipient(recipient);
      if (!still()) throw OBSOLETE;
      const current = withdrawalIntent(client, fresh, amount, recipient);
      if (Object.keys(current.operation).some(field => current.operation[field] !== review.intent.operation[field])) {
        throw Error("The reserve changed. Review the updated withdrawal.");
      }
      // Once a window is involved, the transport asks this operation once more, after its connection is
      // established and just before the burn leaves; without one the burn counts as sent from here, as before.
      const guarded = order.current.seen || op.carries();
      // Claim this account's slot across tabs before signing. Leave a marker until the receipt arrives.
      const claim = claimFor(guarded);
      const existing = await navigator.locks.request(storageKey, () => {
        const prior = localStorage.getItem(storageKey);
        if (!prior) localStorage.setItem(storageKey, claim);
        return prior;
      });
      if (!existing) mine = claim;
      if (!still()) throw OBSOLETE;
      if (existing) { setBurn(existing); return; }
      const signed = await client.sign(review.intent, review.quote);
      if (!still()) throw OBSOLETE;  // signed, never sent
      const guard = guarded ? () => (sent = still()) : undefined;
      sent = !guard;
      const result = await submitBurn(client, signed, storageKey, { mine: () => mine, onSaved: id => { mine = id; }, guard });
      if (!isBurnId(result.txId)) throw Error("Missing burn ID.");
      keep(result.txId, mine);
    } catch (failure) {
      if (sent && failure.code !== "l1_execution_rejected") {
        if (isBurnId(failure.txId)) keep(failure.txId, mine); else setBurn(mine || "submitting");
        setError(failure.message);
      } else {
        // Nothing was burned: stopped before the send, or the chain rejected the burn. Only this
        // operation's own record is removed.
        if (mine) { try { if (localStorage.getItem(storageKey) === mine) localStorage.removeItem(storageKey); } catch { setBurn(mine); } }
        // The outcome of a sent burn is always shown; before the send, a stop by a newer answer says nothing.
        if (sent || (failure !== OBSOLETE && failure.code !== "l1_not_dispatched" && still())) setError(`${failure.message} No PFUSDC was burned.`);
      }
    } finally { submitting.current = false; setBusy(false); }
  }
  function reset() {
    try {
      // Clears only the record this screen shows; one another tab saved since is kept and shown.
      const current = localStorage.getItem(storageKey);
      if (current && current !== burn) { setCreate(false); setBurn(current); return; }
      localStorage.removeItem(storageKey);
    } catch { setError("Your browser could not clear the saved withdrawal. No new funds moved."); return; }
    setBurn(""); setCreate(false); setAmount(""); setRecovery(""); setError(""); setSnapshot(undefined);
  }
  const tick = useProvingWindowClock(provingWindow?.window, provingWindow?.received_at, burn ? undefined : refresh, provingWindow?.open === true, provingWindow);
  const hours = windowTextAt(provingWindow?.window, { kind: "withdrawal", open: provingWindow?.open === true, unknown: provingWindow?.unknown, receivedAt: provingWindow?.received_at, at: tick });
  // A review is offered only while its operation is current: a newer closed answer withdraws it.
  const offered = review && order.current.current(review.made, review.carries) ? review : null;
  return <section aria-label="Solana USDC withdrawal" className="l1-view l1-split is-ticket"><Card className="l1-ticket">
    <CardHead eyebrow="Withdraw to Solana" title="PFUSDC to USDC" />
    {isBurnId(burn) ? <SolanaPayout burn={burn} owner={client.address} create={create} onDone={reset} /> : burn ? <div className="l1-stack">
      <Notice tone="warning" title="Check your burn in Post Fiat Activity">A submission is pending or its receipt was lost. Your PFUSDC may have been burned. Enter the accepted burn ID to track the payout.</Notice>
      <label className="l1-field">Post Fiat burn ID<input value={recovery} onChange={event => setRecovery(event.target.value.trim())} /></label>
      <button type="button" className="l1-btn" disabled={!isBurnId(recovery)} onClick={() => { setError(""); track(recovery, false); }}>Track this burn</button>
      <button type="button" className="l1-btn" onClick={reset}>I verified that no burn was accepted</button>
      <WalletBurns client={client} onTrack={id => { setError(""); track(id, false); }} />
    </div> : snapshot === undefined ? <p role="status"><Spinner size={14} /> Loading your withdrawable balance…</p>
      : !snapshot ? <><Notice tone="warning">{UNAVAILABLE}{hours && provingWindow?.open !== true && <>. {hours}</>}</Notice><WalletBurns client={client} onTrack={id => { setError(""); track(id, false); }} /></> : <>
        {hours && <p className="l1-muted" role="status">{hours}</p>}
        <p>You can withdraw up to <b><Amount atoms={snapshot.held} unit="PFUSDC" /></b> to Solana {snapshot.options.length > 1 ? "in one withdrawal" : "right now"}.</p>
        {snapshot.options.length > 1 && <p className="l1-muted">You hold <Amount atoms={snapshot.total} unit="PFUSDC" /> from Solana in {snapshot.options.length} deposit batches. One withdrawal draws from one batch, so withdraw the rest in a second withdrawal.</p>}
        {Array.isArray(snapshot.ready.buckets)
          ? <p className="l1-muted">Every Solana deposit can be withdrawn to Solana.{snapshot.minimum > 1n && <> The smallest withdrawal is <Amount atoms={snapshot.minimum} unit="USDC" />.</>} PFUSDC from Ethereum deposits is withdrawn under Ethereum.</p>
          : <p className="l1-muted">Only PFUSDC from the Solana deposit series that is open for payouts counts here. PFUSDC from later Solana deposits is not withdrawable to Solana yet, and PFUSDC from Ethereum deposits is withdrawn under Ethereum.</p>}
        {!offered && <form className="l1-stack" onSubmit={prepare}>
          <label className="l1-field">PFUSDC amount<input inputMode="decimal" placeholder="0.00" value={amount} disabled={busy} onChange={event => setAmount(event.target.value.trim())} /></label>
          {amountError && <span className="is-danger">{amountError}</span>}
          <label className="l1-field">Solana recipient<input className="l1-mono-input" autoComplete="off" spellCheck={false} value={recipient} disabled={busy} onChange={event => setRecipient(event.target.value.trim())} /></label>
          {recipientError && <span className="is-danger">{recipientError}</span>}
          {phantom && <button type="button" className="l1-link" disabled={busy} onClick={usePhantom}>Use my Phantom address</button>}
          <button className="l1-btn is-primary" disabled={busy || !amount || !recipient || !!amountError || !!recipientError}>Review withdrawal</button>
          {!busy && (!amount || !recipient) && <span className="l1-muted">Enter an amount and a Solana wallet address to continue.</span>}
        </form>}
        {offered && <div className="l1-stack">
          <KV rows={[
            ["You burn", <Amount atoms={offered.intent.operation.amount_atoms} unit="PFUSDC" />],
            ["You receive on Solana", <Amount atoms={offered.intent.operation.amount_atoms} unit="USDC" />],
            ["Recipient", <span className="l1-mono" style={{ overflowWrap: "anywhere" }}>{recipient}</span>],
            ["Network fee", <Amount atoms={offered.quote.minimum_fee} unit="PFT" />],
          ]} />
          <p>Your L1 wallet signs one burn. The bridge sends USDC to this address on Solana mainnet.</p>
          <div className="l1-two"><button type="button" className="l1-btn" onClick={() => setReview(null)}>Edit withdrawal</button>
            <button type="button" className="l1-btn is-primary" onClick={confirm}>Confirm and burn</button></div>
        </div>}
        {busy && <p role="status"><Spinner size={14} /> Working…</p>}
        {!offered && !busy && <WalletBurns client={client} onTrack={id => { setError(""); track(id, false); }} />}
      </>}
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
  </Card></section>;
}
