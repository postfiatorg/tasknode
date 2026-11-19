import { useCallback, useEffect, useState } from "react";
import { requestJson } from "../../api.js";

const base = "/api/operator/blacklist";
export function ReinstatementOverrides({ accountId, refreshDirectory }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState({});
  const load = useCallback(async () => {
    const result = await requestJson(base);
    if (result.ok) setRows(result.body.entries);
    else if (result.status === 403) setRows([]);
    else throw new Error("Could not load operator requests");
  }, []);
  useEffect(() => { load().catch(err => setError(err.message)); }, [load]);
  async function act(row, action) {
    setBusy(true);
    try {
      const suffix = action ? "/" + row.request_id + "/" + action : "";
      const result = await requestJson(base + "/" + encodeURIComponent(row.id) + "/overrides" + suffix,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action ? {} : { reason: reasons[row.id] }) });
      await load();
      if (!result.ok) throw new Error(result.body?.error || "Request failed");
      setError("");
      await refreshDirectory();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  if (!rows.length && !error) return null;
  return <section className="reinstatement-card"><h2>Manual reinstatement</h2>
    {error && <p role="alert">{error}</p>}
    {rows.map(row => <fieldset key={row.id} disabled={busy || row.account_id === accountId}>
      <legend>{row.public_handle || row.account_id} · {new Date(row.created_at).toLocaleString()}</legend>
      <p>{row.reason}</p>
      {row.wallet_reviews.map(item => <p key={item.wallet}>Wallet ownership review · {item.account} · {item.wallet} · Due {new Date(item.due).toLocaleString()}. Verify the link before proposing a lift.</p>)}
      {!row.quorum_available && <p>Manual approval unavailable. Enroll three eligible operators to reach quorum.</p>}
      {row.request_id ? <>
        <p>{row.rationale} · {row.approvals} of 3 approvals</p>
        <button onClick={() => act(row, row.voted ? "withdraw" : "approve")}>{row.voted ? "Withdraw my approval" : "Approve reinstatement"}</button>
        {row.opened_by === accountId && <button onClick={() => act(row, "cancel")}>Cancel request</button>}
      </> : <form onSubmit={event => { event.preventDefault(); act(row, ""); }}>
        <label>Reason for lifting this entry <input required maxLength={2000} value={reasons[row.id] || ""}
          onChange={event => setReasons({ ...reasons, [row.id]: event.target.value })} /></label>
        <button>Open override request</button>
      </form>}
    </fieldset>)}
  </section>;
}
