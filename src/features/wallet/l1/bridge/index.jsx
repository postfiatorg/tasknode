import { useEffect, useState } from "react";
import { useL1Wallet } from "../client.jsx";
import { BridgeController, amountAtoms } from "./controller.js";
import { atomsToUsdc } from "./evm.js";

function BridgeSession({ client }) {
  const [view, setView] = useState(null);
  const [controller, setController] = useState(null);
  const [amount, setAmount] = useState("");
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
    const timer = setInterval(() => {
      if (model.state.busy || model.state.error) return;
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
  if (!view || !controller) return <p>Loading bridge…</p>;
  const atoms = amountAtoms(amount);
  const enabled = view.ready && !!view.owner && !!atoms && !view.busy && !view.pending;
  const tx = view.pending?.tx;
  return <section aria-label="USDC bridge" style={{ display: "grid", gap: 16, maxWidth: 860 }}>
    <h2>Ethereum USDC → PFUSDC</h2>
    <p>Recipient on Post Fiat: <code>{client.address}</code></p>
    <div role="status" style={{ padding: 16, border: "1px solid currentColor", borderRadius: 8 }}>
      <strong>{view.ready ? "Bridge ready" : "Bridge blocked"}</strong>
      {view.blocked && <p>{view.blocked}</p>}
      <button disabled={view.busy} onClick={() => controller.run(async () => { await controller.readiness(); await controller.refreshEthereum(); })}>Check readiness</button>
    </div>
    <div>
      <button disabled={view.busy} onClick={() => controller.run(() => controller.connect())}>Connect MetaMask</button>
      <p>Ethereum mainnet: {view.owner || "Not connected"}</p>
      <p>USDC balance: {view.balance === null ? "Unavailable" : atomsToUsdc(view.balance)}</p>
      <p>Vault allowance: {view.allowance === null ? "Unavailable" : atomsToUsdc(view.allowance)} USDC</p>
    </div>
    <label>USDC amount <input inputMode="decimal" value={amount} disabled={!!view.pending || view.busy} onChange={(event) => setAmount(event.target.value)} /></label>
    <div style={{ display: "flex", gap: 12 }}>
      <button disabled={!enabled} onClick={() => controller.run(() => controller.approve(amount))}>Approve</button>
      <button disabled={!enabled || view.allowance === null || view.allowance < atoms} onClick={() => controller.run(() => controller.deposit(amount))}>Deposit</button>
    </div>
    {view.approvalTx && <a href={`https://etherscan.io/tx/${view.approvalTx}`} target="_blank" rel="noreferrer">Ethereum approval</a>}
    {tx && <a href={`https://etherscan.io/tx/${tx}`} target="_blank" rel="noreferrer">Ethereum deposit: {tx}</a>}
    {view.pending && <button disabled={view.busy} onClick={() => controller.run(() => controller.resume())}>Resume deposit / refresh result</button>}
    {view.job && <p>Relay: {view.job.status}</p>}
    {view.result && <p>PFTL accepted receipt: <code>{view.result.receipt}</code>. Checking credited balance.</p>}
    {view.error && <p role="alert">{view.error}</p>}
  </section>;
}
export default function BridgeTab() {
  const client = useL1Wallet();
  if (!client.unlocked || !client.address) return <p>Unlock your Post Fiat wallet to bridge USDC.</p>;
  return <BridgeSession key={`${client.accountId}:${client.address}`} client={client} />;
}
