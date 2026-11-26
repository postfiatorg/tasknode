import { useEffect, useMemo, useState } from "react";
import { Amount, KV, Notice, Spinner } from "../ui.jsx";
import { payoutJob, payoutPace, STAGES, trackedSince } from "./solana-withdrawal.js";

export default function SolanaPayout({ burn, owner, create, onDone }) {
  const [job, setJob] = useState(null), [error, setError] = useState("");
  const [retry, setRetry] = useState(0), [now, setNow] = useState(() => Date.now());
  const since = useMemo(() => trackedSince(burn), [burn]);
  useEffect(() => {
    let active = true, timer, stage;
    async function poll(register) {
      try {
        let value;
        try { value = await payoutJob(burn, register, owner); }
        catch (failure) {
          if (register || failure.status !== 404) throw failure;
          value = await payoutJob(burn, true, owner);
        }
        if (!active) return;
        setJob(value); setError(""); setNow(Date.now());
        if (value.stage === "paid" || value.stage === "failed") return;
        stage = value.stage;
      } catch (failure) {
        if (!active) return;
        // An answer from the service is shown as it is. A timeout or lost connection says nothing about the payout.
        setError(failure.status ? failure.message : "Still waiting for the payout service to answer."); setNow(Date.now());
      }
      timer = setTimeout(() => void poll(false), payoutPace(since, Date.now(), stage).delay);
    }
    void poll(create || retry > 0);
    return () => { active = false; clearTimeout(timer); };
  }, [burn, owner, create, retry, since]);
  const { late } = payoutPace(since, now, job?.stage);
  return <div className="l1-stack">
    {job?.stage === "paid" ? <Notice tone="success" title={STAGES.paid}>
      {job.amount_atoms ? <Amount atoms={job.amount_atoms} unit="USDC" /> : "USDC"} was sent{job.recipient && ` to ${job.recipient}`}.
      {" "}<a href={`https://explorer.solana.com/tx/${job.solana_tx}`} target="_blank" rel="noreferrer">View Solana transaction</a>
    </Notice> : job?.stage === "failed" ? <Notice tone="danger" title={STAGES.failed}>
      {job.error || job.detail || "The payout service stopped."} Your PFUSDC burn is recorded. Solana payment is unconfirmed. Retry the payout with this burn.
    </Notice> : <><p className="l1-status-line" role="status"><Spinner size={14} />{STAGES[job?.stage] || "Registering your payout"}…</p>
      <p className="l1-muted">A payout usually takes 6 to 10 minutes. It continues whether or not this screen stays open.</p></>}
    {late && <Notice tone="warning" title="This is taking longer than usual">
      Your burn is recorded on Post Fiat, but the USDC payout has not completed after 30 minutes. This screen keeps checking once a minute. If you ask for help, quote burn ID {burn}.
    </Notice>}
    <KV rows={[[ "Burn on Post Fiat", <span className="l1-mono" style={{ overflowWrap: "anywhere" }}>{burn}</span> ]]} />
    {error && job?.stage !== "paid" && <Notice tone="info" role="status">{error} Your burn is recorded on Post Fiat and the payout is not affected. Checking again in {late ? "a minute" : "eight seconds"}.</Notice>}
    {job?.stage === "failed" && <button type="button" className="l1-btn" onClick={() => { setJob(null); setRetry(n => n + 1); }}>Retry payout</button>}
    {job?.stage === "paid" && <button type="button" className="l1-btn" onClick={onDone}>Start another withdrawal</button>}
  </div>;
}
