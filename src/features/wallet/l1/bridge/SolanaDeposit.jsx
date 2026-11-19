import { useCallback, useEffect, useRef, useState } from "react";
import { bridgeJson } from "./bridge-relay.js";
import { amountAtoms } from "./controller.js";
import { Amount, Badge, Card, CardHead, IdChip, Notice, Spinner } from "../ui.jsx";

// Solana USDC -> PFUSDC pilot. The server builds the transfer; Phantom signs and sends it;
// the pilot float pays PFUSDC once Solana reports the transfer final.
const saved = (client) => `tn:l1:solana:v1:${client.accountId}:${client.address}`;
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const phantom = () => (typeof window !== "undefined" && window.phantom?.solana?.isPhantom ? window.phantom.solana : null);

async function sendWithPhantom(provider, intent) {
  try {
    const sent = await provider.request({ method: "signAndSendTransaction", params: { message: intent.message_b58 } });
    if (sent?.signature) return sent.signature;
    throw new Error("Phantom returned no signature");
  } catch (error) {
    if (error?.code === 4001) throw new Error("You rejected the request in Phantom.");
    // Older builds take a transaction object. Give them the same unsigned bytes.
    const message = bytes(intent.message_b64);
    const sent = await provider.signAndSendTransaction({
      serializeMessage: () => message,
      serialize: () => Uint8Array.from([1, ...new Uint8Array(64), ...message]),
    });
    if (!sent?.signature) throw error;
    return sent.signature;
  }
}

export default function SolanaDeposit({ client }) {
  const [ready, setReady] = useState(null), [owner, setOwner] = useState("");
  const [amount, setAmount] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [deposit, setDeposit] = useState(() => { try { return JSON.parse(localStorage.getItem(saved(client))); } catch { return null; } });
  const [now, setNow] = useState(Date.now());
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const refresh = useCallback(async () => {
    try { const value = await bridgeJson("/solana/readiness"); if (active.current) setReady(value); }
    catch (failure) { if (active.current) setReady({ ready: false, message: failure.message }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const keep = useCallback((value) => {
    if (value) localStorage.setItem(saved(client), JSON.stringify(value)); else localStorage.removeItem(saved(client));
    setDeposit(value);
  }, [client]);
  const open = deposit && deposit.status !== "paid" && deposit.status !== "refused";
  useEffect(() => {
    if (!open) return undefined;
    let stop = false, timer;
    const poll = async () => {
      try {
        const record = await bridgeJson("/solana/advances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signature: deposit.signature }), signal: AbortSignal.timeout(45000) });
        if (stop) return;
        if (record.status === "paid" || record.status === "refused") { keep({ ...deposit, ...record, finishedAt: Date.now() }); void refresh(); return; }
        setError("");
      } catch (failure) { if (!stop) setError(failure.message); }
      if (!stop) timer = setTimeout(poll, 2000);
    };
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 500);
    return () => { stop = true; clearTimeout(timer); clearInterval(clock); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deposit?.signature]);

  const atoms = amountAtoms(amount);
  const provider = phantom();
  const connect = async () => {
    setBusy(true); setError("");
    try { const connected = await provider.connect(); setOwner(connected.publicKey.toString()); }
    catch (failure) { setError(failure?.code === 4001 ? "You rejected the request in Phantom." : failure.message); }
    finally { setBusy(false); }
  };
  const send = async () => {
    setBusy(true); setError("");
    try {
      const intent = await bridgeJson("/solana/intent", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, amount_atoms: String(atoms), pftl_account: client.address }), signal: AbortSignal.timeout(45000) });
      if (intent.pftl_account !== client.address || intent.amount_atoms !== String(atoms)) throw new Error("The prepared transfer does not match your request.");
      const signature = await sendWithPhantom(provider, intent);
      keep({ signature, amount_atoms: intent.amount_atoms, sentAt: Date.now(), status: "sent" });
      setAmount("");
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const seconds = deposit ? Math.max(0, Math.round(((deposit.finishedAt || now) - deposit.sentAt) / 100) / 10) : 0;
  const available = ready?.available_atoms ? BigInt(ready.available_atoms) : 0n;
  return <section aria-label="Solana USDC deposit" className="l1-view">
    <Card className="l1-ticket">
      <CardHead eyebrow="Pilot · Solana" title="USDC on Solana to PFUSDC in seconds">
        {ready === null ? <Badge><Spinner size={12} />Checking</Badge> : <Badge tone={ready.ready ? "success" : "warning"} dot>{ready.ready ? "Pilot ready" : "Pilot unavailable"}</Badge>}
      </CardHead>
      <p className="l1-small l1-muted">Send USDC from Phantom. A pilot float pays the same amount of PFUSDC to this wallet as soon as Solana finalizes the transfer. This pilot relies on Post Fiat's own watcher, not a proof, and is limited to small amounts.</p>
      {ready && !ready.ready && <Notice tone="warning" title="Solana deposits are paused">{ready.message || "The pilot is not ready."}</Notice>}
      {!provider ? <p className="l1-small l1-muted">Phantom was not detected in this browser. <a href="https://phantom.com/download" target="_blank" rel="noreferrer">Install Phantom</a>, then reload.</p> : <>
        <div className="l1-row" style={{ justifyContent: "space-between", margin: "12px 0" }}>
          {owner ? <IdChip value={owner} label="Solana address" testId="solana-owner" /> : <span className="l1-small l1-muted">Use the Phantom account that holds your USDC.</span>}
          <button type="button" className={`l1-btn ${owner ? "is-sm" : "is-primary"}`} disabled={busy} onClick={connect}>{owner ? "Reconnect" : "Connect Phantom"}</button>
        </div>
        <label className="l1-field"><span className="l1-sr">Solana USDC amount</span><span className="l1-input-wrap"><input aria-label="Solana USDC amount" inputMode="decimal" placeholder="0.00" value={amount} disabled={open} onChange={(event) => setAmount(event.target.value)} /><span className="l1-input-suffix">USDC</span></span>
          <span className="l1-field-hint"><span>{ready?.ready ? <>Up to <Amount atoms={available} unit="USDC" /> right now.</> : "1 USDC becomes 1 PFUSDC."}</span></span></label>
        <div style={{ marginTop: 12 }}><button type="button" className="l1-btn is-primary" data-testid="solana-send" disabled={busy || open || !owner || !atoms || !ready?.ready || atoms > available} onClick={send}>Send with Phantom</button></div>
      </>}
      {busy && <p className="l1-status-line" role="status"><Spinner size={14} />Working… confirm in Phantom if it asks.</p>}
      {deposit && <div className="l1-credit" role="status" style={{ marginTop: 16 }}>
        {deposit.status === "paid" ? <><span className="l1-eyebrow">Paid on Post Fiat</span><strong data-testid="solana-paid">+<Amount atoms={deposit.amount_atoms} unit="PFUSDC" /> in {seconds} s</strong></>
          : deposit.status === "refused" ? <Notice tone="danger" title="This deposit was not paid">Reason: {deposit.code}. Your USDC is held in the pilot account and will be refunded by the operator.</Notice>
          : <p className="l1-status-line"><Spinner size={14} />Sent. Waiting for Solana to finalize and the float to pay… {seconds} s</p>}
        <div className="l1-row" style={{ marginTop: 6 }}><span className="l1-muted l1-small">Solana transaction</span><a href={`https://solscan.io/tx/${deposit.signature}`} target="_blank" rel="noreferrer"><IdChip value={deposit.signature} label="Solana signature" /></a></div>
        {deposit.payment_tx_id && <div className="l1-row" style={{ marginTop: 6 }}><span className="l1-muted l1-small">Post Fiat payment</span><IdChip value={deposit.payment_tx_id} label="payment id" /></div>}
        {!open && <div style={{ marginTop: 8 }}><button type="button" className="l1-btn is-sm" onClick={() => keep(null)}>Start another</button></div>}
      </div>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </Card>
  </section>;
}
