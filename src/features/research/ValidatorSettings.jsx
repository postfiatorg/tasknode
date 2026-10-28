import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { researchRequest } from "./research-client.js";
import { validatorSigningCommands } from "./validator-signing.js";
import "./research.css";

export function ValidatorSettings() {
  const [status, setStatus] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [key, setKey] = useState("");
  const [signature, setSignature] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => setStatus(await researchRequest("/api/validators")), []);
  useEffect(() => { refresh().catch((error) => setMessage(error.message)); }, [refresh]);
  const act = async (fn) => {
    setBusy(true); setMessage("");
    try { await fn(); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };
  return <div className="research-panel">
    <p>Your signature proves control of a devnet or testnet validator master key and binds it to this Task Node account. It signs a one-time challenge; nothing is submitted to the ledger. Your private key stays on the validator host.</p>
    <p>Earn $20 per eligible validator key on the first UTC day of each month: at least 95% mean daily agreement across the preceding 30 complete UTC days, with at least 25 reported days. Rewards use the payout month; a November 1 payout is labeled November.</p>
    <p>Research uses your Task Node USD credit at the reported provider cost, rounded up to $0.000001 once per job. At least $0.50 available credit is required. Pending jobs reserve their maximum cost; failed jobs may still incur provider costs.</p>
    {status?.badge && <strong className="validator-badge"><ShieldCheck size={18} /> Validator</strong>}
    {status?.bindings?.map((binding) => <article className="research-card" key={binding.id}>
      <strong>{binding.network}</strong><code className="research-wrap">{binding.master_public_key}</code>
      <p>{binding.uptime ? `${binding.uptime.meanAgreement === null ? "No agreement data" : `${(binding.uptime.meanAgreement * 100).toFixed(3)}% mean agreement`} · ${binding.uptime.daysReported}/30 days reported` : binding.uptimeError}</p>
      <p>Next reward: {status.nextRewardDate.slice(0, 10)} UTC. Eligibility is checked on that date.</p>
      <button type="button" disabled={busy} onClick={() => act(async () => {
        await researchRequest(`/api/validators/${binding.id}`, { method: "DELETE", body: {} }); await refresh();
      })}>Unbind validator</button>
    </article>)}
    <button type="button" disabled={busy} onClick={() => act(async () => setChallenge(await researchRequest("/api/validators/challenge", { method: "POST", body: {} })))}>Create signing challenge</button>
    {challenge && <form onSubmit={(event) => { event.preventDefault(); void act(async () => {
      await researchRequest("/api/validators/bind", { method: "POST", body: { master_public_key: key.trim(), signature: signature.trim(), challenge: challenge.challenge } });
      setChallenge(null); setSignature(""); await refresh(); setMessage("Validator bound successfully.");
    }); }}>
      <p>Choose the command that matches where your existing validator key file lives. Run it on that validator host.</p>
      {validatorSigningCommands(challenge.challenge).map((option) => <section className="research-card" key={option.id} aria-label={option.title}>
        <strong>{option.title}</strong>
        <pre className="research-wrap">{option.command}</pre>
        <button type="button" onClick={() => act(() => navigator.clipboard.writeText(option.command))}>Copy {option.id} command</button>
      </section>)}
      <p>For the host command, replace <code>/path/to/validator-keys.json</code> with the existing file path and <code>{"<postfiatd image>"}</code> with the Post Fiat image already used on that host. It mounts the key read-only and disables container networking.</p>
      <p>Paste only the master public key and returned signature below. Never paste the key file or a validator token. This challenge expires {new Date(challenge.expiresAt).toLocaleTimeString()} and can be used once.</p>
      <label>Validator master public key (nH…)<input value={key} onChange={(event) => setKey(event.target.value)} required autoComplete="off" /></label>
      <label>Signature<textarea value={signature} onChange={(event) => setSignature(event.target.value)} required rows={3} /></label>
      <button type="submit" disabled={busy}>Bind validator</button>
    </form>}
    <p role="status">{message}</p>
  </div>;
}
