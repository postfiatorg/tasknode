import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Copy } from "lucide-react";
import { researchRequest } from "./research-client.js";
import { ManualValidatorConnect } from "./ManualValidatorConnect.jsx";
import "./research.css";

export function ValidatorSettings({ onAppStateChange }) {
  const [status, setStatus] = useState(null);
  const [connect, setConnect] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
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
          await refresh(); await onAppStateChange?.(); return;
        }
        if (next.status === "expired") { setConnect(null); setMessage("This command expired. Generate a new command."); return; }
      } catch (error) { if (active) setMessage(error.message); }
      if (active) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [connectionId, refresh, onAppStateChange]);
  async function act(work) {
    setBusy(true); setMessage("");
    try { await work(); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  const origin = window.location.origin;
  const command = connect ? `curl -fsSL ${origin}/validator.sh | sh -s -- ${connect.token}` : "";
  const inspect = connect ? `curl -fsSLO ${origin}/validator.sh\ncat validator.sh\nsh validator.sh ${connect.token}` : "";
  const bound = Boolean(status?.bindings?.length);
  return <div className="research-panel validator-connect-panel">
    {bound && !connect ? <strong className="validator-badge"><CheckCircle2 size={20} /> Validator connected</strong> : <h3>Connect your validator</h3>}
    <p>Unlock GoodAlexander models, at-cost Deep Research in chat, and $20 monthly credit when eligible.</p>
    {connect && <section className="research-card" aria-label="Connect with one command">
      <strong>Run this on your validator host</strong>
      <pre className="research-wrap validator-command">{command}</pre>
      <button type="button" onClick={() => act(async () => { await navigator.clipboard.writeText(command); setMessage("Command copied. Run it on your validator host; this page will connect automatically."); })}><Copy size={15} /> Copy command</button>
      <small>Finds your existing key and signs locally. Your private key stays on the host. Expires at {new Date(connect.expiresAt).toLocaleTimeString()}.</small>
      <p role="status">Waiting for your validator…</p>
      <details><summary>Download and inspect first</summary><pre className="research-wrap">{inspect}</pre><a href="/validator.sh" download>Download validator.sh</a></details>
    </section>}
    {!connect && <button type="button" disabled={busy} onClick={() => act(async () => setConnect(await researchRequest("/api/validators/connect", { method: "POST", body: {} })))}>{bound ? "Connect another validator" : "Generate connect command"}</button>}
    {bound && <a href="/api/research/bundles/ga-models/index.html" target="_blank" rel="noreferrer">GoodAlexander models</a>}
    {status?.bindings?.map(binding => <article className="research-card" key={binding.id}>
      <strong>{binding.network}</strong><code className="research-wrap">{binding.master_public_key}</code>
      <p>{binding.uptime ? `${binding.uptime.meanAgreement === null ? "No agreement data" : `${(binding.uptime.meanAgreement * 100).toFixed(3)}% mean agreement`} · ${binding.uptime.daysReported}/30 days reported` : binding.uptimeError}</p>
      <small>Next reward: {status.nextRewardDate.slice(0, 10)} UTC. Eligibility is checked then.</small>
    </article>)}
    <details><summary>Rewards and research billing</summary>
      <p>Earn $20 per eligible key on the first UTC day of each month: at least 95% mean agreement in the preceding 30 complete UTC days, with at least 25 reported days. November 1 pays for payout month November.</p>
      <p>Choose Deep Research in chat. Your credit is charged at provider cost rounded up to $0.000001 once per job. At least $0.50 available is required; pending jobs reserve their maximum cost and failed jobs may incur provider cost.</p>
    </details>
    <details><summary>Advanced</summary>
      <p>The signature proves control of your master key and binds it to this account. Nothing is submitted to the ledger. To select a file, append <code>--keyfile /existing/path/validator-keys.json</code> to the command.</p>
      <ManualValidatorConnect onConnected={async () => { setConnect(null); await refresh(); await onAppStateChange?.(); }} />
      {status?.bindings?.map(binding => <button key={binding.id} type="button" disabled={busy} onClick={() => act(async () => { await researchRequest(`/api/validators/${binding.id}`, { method: "DELETE", body: {} }); await refresh(); await onAppStateChange?.(); })}>Unbind {binding.network} validator</button>)}
    </details>
    <p role="status">{message}</p>
  </div>;
}
