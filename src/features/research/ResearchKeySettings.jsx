import { useCallback, useEffect, useState } from "react";
import { researchRequest } from "./research-client.js";
import "./research.css";
export function ResearchKeySettings() {
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => setKeys((await researchRequest("/api/research/keys")).keys), []);
  useEffect(() => { refresh().catch((error) => setMessage(error.message)); }, [refresh]);
  const act = async (fn) => { setBusy(true); setMessage(""); try { await fn(); } catch (error) { setMessage(error.message); } finally { setBusy(false); } };
  return <div className="research-panel">
    <p>Research keys use your Task Node credit at the actual provider cost. Bind a validator before creating a key.</p>
    <form onSubmit={(event) => { event.preventDefault(); void act(async () => {
      const created = await researchRequest("/api/research/keys", { method: "POST", body: { name } }); setNewKey(created.key); await refresh();
    }); }}>
      <label>Key name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="My research client" /></label>
      <button type="submit" disabled={busy}>Create API key</button>
    </form>
    {newKey && <div className="research-card"><strong>Copy your key now. It is shown only once.</strong><code className="research-wrap">{newKey}</code>
      <button type="button" onClick={() => act(() => navigator.clipboard.writeText(newKey))}>Copy key</button>
      <button type="button" onClick={() => setNewKey("")}>Dismiss key</button></div>}
    {keys.map((key) => <article className="research-card" key={key.id}><strong>{key.name || "Research key"}</strong><code>{key.key_prefix}…</code>
      <span>{key.revoked_at ? "Revoked" : "Active"} · research:run</span>
      {!key.revoked_at && <button type="button" disabled={busy} onClick={() => act(async () => {
        await researchRequest(`/api/research/keys/${key.id}`, { method: "DELETE", body: {} }); setNewKey(""); await refresh();
      })}>Revoke</button>}</article>)}
    <p role="status">{message}</p>
  </div>;
}
