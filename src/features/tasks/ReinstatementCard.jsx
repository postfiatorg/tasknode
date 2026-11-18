import "./reinstatement.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../../api.js";

const path = "/api/me/reinstatement";
const localTime = value => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });

function message(entry) {
  switch (entry.stage) {
    case "waiting": {
      const remaining = new Date(entry.eligible_at) - new Date(entry.server_time);
      if (remaining > 0) return `Your reinstatement task will be available ${localTime(entry.eligible_at)} (in ${Math.ceil(remaining / 60000)} min).`;
      return remaining < -60000 ? "Delivery is delayed. We’ll retry automatically." : "Your reinstatement task is being prepared.";
    }
    case "offered": return "Your reinstatement task is ready.";
    case "working": return entry.feedback || "Reinstatement in progress.";
    case "paused": return "Your task is paused. Resume whenever you’re ready.";
    case "submitted": return `Awaiting board review. Submitted ${localTime(entry.submitted_at)}.${entry.review_escalated_at ? " Your submission has been escalated for backup review." : ""}`;
    case "resolved": return `Access restored ${localTime(entry.lifted_at)} by ${entry.resolved_via === "task" ? "task completion" : "three operator approvals"}.`;
    default: return "";
  }
}

export function ReinstatementCard({ view, navigate, onResolved }) {
  const [entry, setEntry] = useState(null);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const previous = useRef(null);
  const resolvedCallback = useRef(onResolved);
  resolvedCallback.current = onResolved;
  const load = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const result = await requestJson(path);
      if (version !== sequence.current) return;
      if (!result.ok) throw new Error("Could not refresh reinstatement status.");
      const next = result.body.entry;
      if (previous.current?.id !== next?.id) setEvidence("");
      if (previous.current?.status === "active" && next?.status === "lifted") resolvedCallback.current?.();
      previous.current = next;
      setEntry(next);
      setError("");
    } catch {
      if (version === sequence.current) setError("Status could not be refreshed.");
    }
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  useEffect(() => {
    let interval = entry?.status === "active" ? 15000 : 120000;
    const untilDue = new Date(entry?.eligible_at) - new Date(entry?.server_time);
    if (entry?.stage === "waiting" && untilDue > 0) interval = Math.min(interval, untilDue);
    const timer = setInterval(load, Math.max(1000, interval));
    return () => clearInterval(timer);
  }, [entry, load]);
  async function act(action) {
    setBusy(true);
    try {
      const result = await requestJson(action === "submit" ? "/api/tasks/submission" : "/api/tasks/action", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: entry.task_id, phase: "submit", taskAction: action, reinstatementRevision: entry.revision, ...(action === "submit" ? { summary: evidence } : {}) }) });
      await load();
      if (!result.ok) throw new Error(result.body?.error || "Action failed");
      if (action === "submit") setEvidence("");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  if (!entry && error && view === "tasks") return <p role="status">{error} <button onClick={load}>Retry status</button></p>;
  if (entry?.wallet_restricted && entry.status !== "active") return <section className="reinstatement-card" aria-label="Wallet restriction">
    <h2>Wallet restricted</h2><p role="status">Your linked wallet matches an active blacklist entry. An operator can review ownership in the blacklist directory.</p>
  </section>;
  if (!entry || (entry.stage === "resolved" && view !== "tasks")) return null;
  return <section className="reinstatement-card" aria-label="Account reinstatement">
    <h2>{entry.stage === "resolved" ? "Reinstated" : "Account blacklisted"}</h2>
    {entry.status === "active" && <p>{entry.reason} · Since {localTime(entry.created_at)}. Ordinary network tasks and task rewards are paused.</p>}
    <p role="status">{message(entry)}</p>
    {entry.wallet_restricted && <p>This wallet has a separate restriction. You can complete your own reinstatement task.</p>}
    {entry.override_id && <p>Manual review · {entry.approvals} of 3 approvals</p>}
    {error && <p role="alert">{error} <button onClick={load}>Refresh</button></p>}
    {view !== "tasks" ? <button onClick={() => navigate("tasks")}>View reinstatement</button> :
      <fieldset disabled={busy}>
        {entry.stage === "offered" && <button onClick={() => act("accept")}>Open task</button>}
        {entry.stage === "paused" && <button onClick={() => act("resume")}>Resume task</button>}
        {entry.stage === "working" && <form onSubmit={event => { event.preventDefault(); act("submit"); }}>
          <label>Evidence of your contribution
            <textarea required maxLength={12000} value={evidence} onChange={event => setEvidence(event.target.value)} />
          </label>
          <p>Provide checkable evidence of your own work and explain how it helped Post Fiat or addressed the blacklist reason. Work outside Task Node qualifies. This task pays 0 PFT.</p>
          <button disabled={!evidence.trim()}>Submit for review</button>
        </form>}
        {["offered","working"].includes(entry.stage) && <button onClick={() => act("pause")}>Pause task</button>}
      </fieldset>}
  </section>;
}
