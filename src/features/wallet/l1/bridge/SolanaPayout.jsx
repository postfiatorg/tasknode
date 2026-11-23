import { useEffect, useState } from "react";
import { Amount, KV, Notice, Spinner } from "../ui.jsx";
import { payoutJob, STAGES } from "./solana-withdrawal.js";

export default function SolanaPayout({ burn, create, onDone }) {
  const [job, setJob] = useState(null), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true, timer;
    async function poll(register) {
      try {
        let value;
        try { value = await payoutJob(burn, register); }
        catch (failure) {
          if (register || failure.status !== 404) throw failure;
          value = await payoutJob(burn, true);
        }
        if (!active) return;
        setJob(value); setError("");
        if (value.stage === "paid" || value.stage === "failed") return;
      } catch (failure) {
        if (!active) return;
        setError(failure.message);
      }
      timer = setTimeout(() => void poll(false), 8000);
    }
    void poll(create || retry > 0);
    return () => { active = false; clearTimeout(timer); };
  }, [burn, create, retry]);
  return <div className="l1-stack">
    {job?.stage === "paid" ? <Notice tone="success" title={STAGES.paid}>
      {job.amount_atoms ? <Amount atoms={job.amount_atoms} unit="USDC" /> : "USDC"} was sent{job.recipient && ` to ${job.recipient}`}.
      {" "}<a href={`https://explorer.solana.com/tx/${job.solana_tx}`} target="_blank" rel="noreferrer">View Solana transaction</a>
    </Notice> : job?.stage === "failed" ? <Notice tone="danger" title={STAGES.failed}>
      {job.error || job.detail || "The payout service stopped."} Your PFUSDC burn is recorded. Solana payment is unconfirmed. Retry the payout with this burn.
    </Notice> : <p className="l1-status-line" role="status"><Spinner size={14} />{STAGES[job?.stage] || "Registering your payout"}…</p>}
    <KV rows={[[ "Burn on Post Fiat", <span className="l1-mono" style={{ overflowWrap: "anywhere" }}>{burn}</span> ]]} />
    {error && <Notice tone="warning" role="alert">{error} The burn ID is recorded. Payout status is unknown. Checking again in eight seconds.</Notice>}
    {job?.stage === "failed" && <button type="button" className="l1-btn" onClick={() => { setJob(null); setRetry(n => n + 1); }}>Retry payout</button>}
    {job?.stage === "paid" && <button type="button" className="l1-btn" onClick={onDone}>Start another withdrawal</button>}
  </div>;
}
