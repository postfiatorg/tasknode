import { useCallback, useEffect, useRef, useState } from "react";
import { Amount, Card, CardHead, KV, Notice, Spinner } from "../ui.jsx";
import SolanaPayout from "./SolanaPayout.jsx";
import { provingWindowText } from "./proving-window.js";
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

export default function SolanaWithdraw({ client, storageKey }) {
  const [snapshot, setSnapshot] = useState(undefined), [error, setError] = useState("");
  const [recipient, setRecipient] = useState(""), [amount, setAmount] = useState("");
  const [review, setReview] = useState(null), [busy, setBusy] = useState(false);
  const [burn, setBurn] = useState(() => savedBurn(storageKey)), [create, setCreate] = useState(false);
  const [recovery, setRecovery] = useState(""), [provingWindow, setProvingWindow] = useState(undefined);
  const submitting = useRef(false);
  const refresh = useCallback(async () => {
    try { setSnapshot(await withdrawalSnapshot(client, setProvingWindow)); }
    catch (failure) { setSnapshot(null); setError(`${failure.message} No funds moved.`); }
  }, [client]);
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
    try {
      const fresh = await withdrawalSnapshot(client);
      setSnapshot(fresh);
      if (!fresh) { setError("Review stopped before signing. No funds moved."); return; }
      await checkRecipient(recipient);
      const intent = withdrawalIntent(client, fresh, amount, recipient);
      setReview({ intent, quote: await client.quote(intent) });
    } catch (failure) { setError(`${failure.message} No funds moved.`); } finally { setBusy(false); }
  }

  function track(id, register) {
    setCreate(register); setBurn(id);
    try { localStorage.setItem(storageKey, id); }
    catch { setError("Your browser could not save the burn ID. Copy it before leaving to recover the payout."); }
  }
  async function confirm() {
    if (!review || submitting.current) return;
    submitting.current = true; setBusy(true); setError(""); setReview(null);
    let submitted = false, marked = false;
    try {
      const fresh = await withdrawalSnapshot(client);
      setSnapshot(fresh);
      if (!fresh) { setError("Confirmation stopped before signing. No funds moved."); return; }
      await checkRecipient(recipient);
      const current = withdrawalIntent(client, fresh, amount, recipient);
      if (Object.keys(current.operation).some(field => current.operation[field] !== review.intent.operation[field])) {
        throw Error("The reserve changed. Review the updated withdrawal.");
      }
      // Claim this account's slot across tabs before signing. Leave a marker until the receipt arrives.
      const existing = await navigator.locks.request(storageKey, () => {
        const prior = localStorage.getItem(storageKey);
        if (!prior) localStorage.setItem(storageKey, "submitting");
        return prior;
      });
      if (existing) { setBurn(existing); return; }
      marked = true;
      const signed = await client.sign(review.intent, review.quote);
      submitted = true;
      const result = await submitBurn(client, signed, storageKey);
      if (!isBurnId(result.txId)) throw Error("Missing burn ID.");
      track(result.txId, true);
    } catch (failure) {
      if (submitted && failure.code !== "l1_execution_rejected") {
        if (isBurnId(failure.txId)) track(failure.txId, true); else setBurn("submitting");
        setError(failure.message);
      } else {
        if (marked) { try { localStorage.removeItem(storageKey); } catch { setBurn("submitting"); } }
        setError(`${failure.message} No PFUSDC was burned.`);
      }
    } finally { submitting.current = false; setBusy(false); }
  }
  function reset() {
    try { localStorage.removeItem(storageKey); }
    catch { setError("Your browser could not clear the saved withdrawal. No new funds moved."); return; }
    setBurn(""); setCreate(false); setAmount(""); setRecovery(""); setError(""); setSnapshot(undefined);
  }
  const hours = provingWindowText(provingWindow?.window, { kind: "withdrawal", open: provingWindow?.open === true });
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
        {!review && <form className="l1-stack" onSubmit={prepare}>
          <label className="l1-field">PFUSDC amount<input inputMode="decimal" placeholder="0.00" value={amount} disabled={busy} onChange={event => setAmount(event.target.value.trim())} /></label>
          {amountError && <span className="is-danger">{amountError}</span>}
          <label className="l1-field">Solana recipient<input className="l1-mono-input" autoComplete="off" spellCheck={false} value={recipient} disabled={busy} onChange={event => setRecipient(event.target.value.trim())} /></label>
          {recipientError && <span className="is-danger">{recipientError}</span>}
          {phantom && <button type="button" className="l1-link" disabled={busy} onClick={usePhantom}>Use my Phantom address</button>}
          <button className="l1-btn is-primary" disabled={busy || !amount || !recipient || !!amountError || !!recipientError}>Review withdrawal</button>
          {!busy && (!amount || !recipient) && <span className="l1-muted">Enter an amount and a Solana wallet address to continue.</span>}
        </form>}
        {review && <div className="l1-stack">
          <KV rows={[
            ["You burn", <Amount atoms={review.intent.operation.amount_atoms} unit="PFUSDC" />],
            ["You receive on Solana", <Amount atoms={review.intent.operation.amount_atoms} unit="USDC" />],
            ["Recipient", <span className="l1-mono" style={{ overflowWrap: "anywhere" }}>{recipient}</span>],
            ["Network fee", <Amount atoms={review.quote.minimum_fee} unit="PFT" />],
          ]} />
          <p>Your L1 wallet signs one burn. The bridge sends USDC to this address on Solana mainnet.</p>
          <div className="l1-two"><button type="button" className="l1-btn" onClick={() => setReview(null)}>Edit withdrawal</button>
            <button type="button" className="l1-btn is-primary" onClick={confirm}>Confirm and burn</button></div>
        </div>}
        {busy && <p role="status"><Spinner size={14} /> Working…</p>}
        {!review && !busy && <WalletBurns client={client} onTrack={id => { setError(""); track(id, false); }} />}
      </>}
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
  </Card></section>;
}
