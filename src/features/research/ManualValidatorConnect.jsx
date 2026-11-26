import { useState } from "react";
import { researchRequest } from "./research-client.js";
import { validatorSigningCommands } from "./validator-signing.js";

export function ManualValidatorConnect({ onConnected }) {
  const [challenge, setChallenge] = useState(null);
  const [key, setKey] = useState("");
  const [signature, setSignature] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(work) {
    setBusy(true); setMessage("");
    try { await work(); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  return <div className="research-panel">
    <button type="button" disabled={busy} onClick={() => act(async () => setChallenge(await researchRequest("/api/validators/challenge", { method: "POST", body: {} })))}>Create manual signing challenge</button>
    {challenge && <form onSubmit={event => { event.preventDefault(); void act(async () => {
      await researchRequest("/api/validators/bind", { method: "POST", body: { master_public_key: key.trim(), signature: signature.trim(), challenge: challenge.challenge } });
      setChallenge(null); setSignature(""); await onConnected?.();
    }); }}>
      {validatorSigningCommands(challenge.challenge).map(option => <section className="research-card" key={option.id} aria-label={option.title}>
        <strong>{option.title}</strong><pre className="research-wrap">{option.command}</pre>
        <button type="button" onClick={() => act(() => navigator.clipboard.writeText(option.command))}>Copy {option.id} command</button>
      </section>)}
      <p>For the host command, use the existing key file path and Post Fiat image. Paste only the public key and signature, never the key file or validator token. Challenge expires {new Date(challenge.expiresAt).toLocaleTimeString()}.</p>
      <label>Validator master public key (nH…)<input value={key} onChange={event => setKey(event.target.value)} required autoComplete="off" /></label>
      <label>Signature<textarea value={signature} onChange={event => setSignature(event.target.value)} required rows={3} /></label>
      <button type="submit" disabled={busy}>Bind validator</button>
    </form>}
    <p role="status">{message}</p>
  </div>;
}
