import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { researchRequest } from "./research-client.js";
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
    <p>Prove control of a devnet or testnet validator to unlock research and financial models.</p>
    <p>Earn $20 in Task Node credit each month with at least 95% mean daily agreement and 25 reported days in the preceding 30-day window.</p>
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
      <p>Run this command on your validator host. Keep the key file on that host.</p>
      <pre className="research-wrap">{challenge.signCommand}</pre>
      <button type="button" onClick={() => act(() => navigator.clipboard.writeText(challenge.signCommand))}>Copy command</button>
      <p>Expires {new Date(challenge.expiresAt).toLocaleTimeString()}.</p>
      <label>Validator master public key (nH…)<input value={key} onChange={(event) => setKey(event.target.value)} required autoComplete="off" /></label>
      <label>Signature<textarea value={signature} onChange={(event) => setSignature(event.target.value)} required rows={3} /></label>
      <button type="submit" disabled={busy}>Bind validator</button>
    </form>}
    <p role="status">{message}</p>
  </div>;
}
