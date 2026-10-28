import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Copy } from "lucide-react";
import { researchRequest } from "./research-client.js";
import { ManualValidatorConnect } from "./ManualValidatorConnect.jsx";
import "./research.css";

export function ValidatorSettings({ onAppStateChange }) {
  const onAppStateChangeRef = useRef(onAppStateChange);
  useEffect(() => { onAppStateChangeRef.current = onAppStateChange; }, [onAppStateChange]);
  const [status, setStatus] = useState(null);
  const [connect, setConnect] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [network, setNetwork] = useState("ledger");
  const refresh = useCallback(async () => {
    const next = await researchRequest("/api/validators"); setStatus(next); return next;
  }, []);
  useEffect(() => {
    let active = true;
    async function start() {
      try {
        const next = await refresh();
        if (active && !next.bindings.length) {
          const command = await researchRequest("/api/validators/connect", { method: "POST", body: {} });
          if (active) setConnect(command);
        }
      } catch (error) { if (active) setMessage(error.message); }
    }
    void start();
    return () => { active = false; };
  }, [refresh]);
  const connectionId = connect?.id;
  useEffect(() => {
    if (!connectionId) return undefined;
    let active = true;
    let timer;
    async function poll() {
      try {
        const next = await researchRequest(`/api/validators/connect/status?id=${encodeURIComponent(connectionId)}`);
        if (!active) return;
        if (next.status === "connected") {
          setConnect(null); setMessage("Validator connected. You can return to chat.");
          await refresh(); await onAppStateChangeRef.current?.(); return;
        }
        if (next.status === "expired") { setConnect(null); setMessage("This command expired. Generate a new command."); return; }
      } catch (error) { if (active) setMessage(error.message); }
      if (active) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [connectionId, refresh]);
  async function act(work) {
    setBusy(true); setMessage("");
    try { await work(); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  const origin = window.location.origin;
  const script = network === "l1-devnet" ? "l1-validator.sh" : "validator.sh";
  const command = connect ? `curl -fsSL ${origin}/${script} | sh -s -- ${connect.token}` : "";
  const inspect = connect ? `curl -fsSLO ${origin}/${script}\ncat ${script}\nsh ${script} ${connect.token}` : "";
  const bound = Boolean(status?.bindings?.length);
  return <div className="research-panel validator-connect-panel">
    {bound && !connect ? <strong className="validator-badge"><CheckCircle2 size={20} /> Validator connected</strong> : <h3>Connect your validator</h3>}
    <p>Connect for GoodAlexander models, research API keys, and $20 monthly credit when eligible. Chat research is available to every signed-in account with sufficient balance.</p>
    {connect && <section className="research-card" aria-label="Connect with one command">
      <label>Validator network <select value={network} onChange={event => setNetwork(event.target.value)}>
        <option value="ledger">PFT Ledger devnet / testnet</option>
        <option value="l1-devnet">Post Fiat L1 devnet</option>
      </select></label>
      <strong>Run this on your validator host</strong>
      <pre className="research-wrap validator-command">{command}</pre>
      <button type="button" onClick={() => act(async () => { await navigator.clipboard.writeText(command); setMessage("Command copied. Run it on your validator host; this page will connect automatically."); })}><Copy size={15} /> Copy command</button>
      <small>{network === "l1-devnet" ? "Run as root on a Linux x86_64 L1 validator host. Signs locally with the running node’s configured key, with networking disabled."
        : "Uses your running validator token to sign locally. Your master key can stay offline."} Expires at {new Date(connect.expiresAt).toLocaleTimeString()}.</small>
      {network === "l1-devnet" && <p>Models and research API access start when connected. L1 monthly credit waits for at least 25 observed days out of the last 30 complete UTC days, with at least 95% mean participation.</p>}
      <p role="status">Waiting for your validator…</p>
      <details><summary>Download and inspect first</summary>{network === "l1-devnet" && <p>The verified signer and validator registry are served by <code>research.goodalexander.com:18443</code>.</p>}<pre className="research-wrap">{inspect}</pre><a href={`/${script}`} download>Download {script}</a></details>
    </section>}
    {!connect && <button type="button" disabled={busy} onClick={() => act(async () => setConnect(await researchRequest("/api/validators/connect", { method: "POST", body: {} })))}>{bound ? "Connect another validator" : "Generate connect command"}</button>}
    {bound && <a href="/api/research/bundles/ga-models/index.html" target="_blank" rel="noreferrer">GoodAlexander models</a>}
    {status?.bindings?.map(binding => <article className="research-card" key={binding.id}>
      <strong>{binding.network === "l1-devnet" ? "Post Fiat L1 devnet" : binding.network}</strong><code className="research-wrap">{binding.validator_id || binding.master_public_key}</code>
      {binding.network === "l1-devnet" ? <>
        <p>{binding.uptime?.available ? `${(binding.uptime.meanAgreement * 100).toFixed(3)}% mean participation · ${binding.uptime.daysReported}/30 days observed` : binding.uptime ? `${binding.uptime.daysReported}/30 complete UTC days observed. Participation history is building.` : binding.uptimeError}</p>
        <small>L1 monthly credit requires at least 25 observed days out of the last 30 complete UTC days and at least 95% mean participation. Next check: {status.nextRewardDate.slice(0, 10)} UTC. Your research API and models access is active.</small>
        <details><summary>Public validator identity</summary><p>{binding.chain_id}</p><code className="research-wrap">{binding.ml_dsa_public_key}</code></details>
      </> : <>
        <p>{binding.uptime ? `${binding.uptime.meanAgreement === null ? "No agreement data" : `${(binding.uptime.meanAgreement * 100).toFixed(3)}% mean agreement`} · ${binding.uptime.daysReported}/30 days reported` : binding.uptimeError}</p>
        <small>Next reward: {status.nextRewardDate.slice(0, 10)} UTC. Eligibility is checked then.</small>
      </>}
    </article>)}
    <details><summary>Rewards and research billing</summary>
      <p>Earn $20 per eligible key on the first UTC day of each month: at least 95% mean daily agreement (Ledger) or participation (L1) in the preceding 30 complete UTC days, with at least 25 reported days. L1 observations started on October 28, 2026; credit waits until at least 25 complete days are observed. Days without verifiable committed blocks do not count.</p>
      <p>Deep Research uses the GoodAlexander API at <code>research.goodalexander.com:18443</code>. Choose Deep Research in chat. Your credit is charged at provider cost rounded up to $0.000001 once per job. At least $0.50 available is required; pending jobs reserve their maximum cost and failed jobs may incur provider cost.</p>
    </details>
    <details><summary>Advanced</summary>
      <p>The command proves control of your running validator. Nothing is submitted to either chain. For PFT Ledger master-key signing, append <code>--keyfile /existing/path/validator-keys.json</code> to the Ledger command. The manual flow below is for PFT Ledger validators.</p>
      <ManualValidatorConnect onConnected={async () => { setConnect(null); await refresh(); await onAppStateChange?.(); }} />
      {status?.bindings?.map(binding => <button key={binding.id} type="button" disabled={busy} onClick={() => act(async () => { await researchRequest(`/api/validators/${binding.id}`, { method: "DELETE", body: {} }); await refresh(); await onAppStateChange?.(); })}>Unbind {binding.network} validator</button>)}
    </details>
    <p role="status">{message}</p>
  </div>;
}
