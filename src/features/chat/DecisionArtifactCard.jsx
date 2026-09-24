import { Copy, Download, FileText } from "lucide-react";
import { decisionTier } from "./decisions-client.js";

const STAGES = {
  starting: "Starting", framing: "Defining five options", planning_research: "Planning the research",
  researching: "Researching the options", voting: "Collecting votes", drafting: "Writing the report",
  mini_tih: "Reviewing the draft", rewriting: "Final rewrite",
};
const RESEARCH = {
  planning: "Planning the research.", searching: "Finding sources.", reading_sources: "Reading sources.",
  synthesizing: "Writing the research report.", finalizing: "Finishing the research report.",
  waiting_for_capacity: "Waiting for model capacity; your work is saved.",
};

export function DecisionArtifactCard({ decision, onCopy, onDownload }) {
  if (!decision) return null;
  const { status, stage, jobId, selected, voteCounts = {}, markdown = "" } = decision;
  const tier = decisionTier(decision.mode);
  const base = `/api/decisions/jobs/${encodeURIComponent(jobId || "")}`;
  const snapshot = decision.contextSnapshot;
  const memories = (snapshot?.deepMemoryCount || 0) + (snapshot?.recentMemoryCount || 0);
  const context = [(snapshot ? snapshot.document : decision.contextIncluded) && "your context document",
    memories && `${memories} ${memories === 1 ? "memory" : "memories"}`].filter(Boolean).join(" and ");
  const packet = jobId && <a href={`${base}/packet`} download><FileText size={15} strokeWidth={1.8} />Packet</a>;

  if (status === "completed") {
    const votes = Object.values(voteCounts).reduce((sum, count) => sum + Number(count || 0), 0);
    return (
      <section className="decision-card" aria-label="Decision report">
        <header><strong>Recommendation: Option {selected}</strong><span>{tier.label}</span></header>
        <p>{voteCounts[selected] || 0} of {votes} votes{context ? ` · Used ${context}` : ""}</p>
        <div className="decision-card-actions">
          {markdown && <>
            <button type="button" onClick={() => onCopy(markdown)}><Copy size={15} strokeWidth={1.8} />Copy</button>
            <button type="button" onClick={() => onDownload({ filename: `decision-${jobId}.md`, text: markdown })}><Download size={15} strokeWidth={1.8} />Markdown</button>
            <a href={`${base}/pdf`} download><Download size={15} strokeWidth={1.8} />PDF</a>
          </>}
          {packet}
        </div>
      </section>
    );
  }
  if (status === "failed") {
    return (
      <section className="decision-card is-failed">
        <header><strong>Decision stopped</strong><span>{tier.label}</span></header>
        <p>{decision.error || "This decision did not complete."} Completed work is saved in the packet.</p>
        {packet && <div className="decision-card-actions">{packet}</div>}
      </section>
    );
  }
  const done = decision.completedCalls || 0, total = decision.totalCalls || tier.totalCalls;
  const research = stage === "researching" ? RESEARCH[decision.researchProgress?.find(report => report.status !== "COMPLETED")?.stage] : "";
  return (
    <section className="decision-card" aria-live="polite">
      <header><strong>{STAGES[stage] || "Working"}</strong><span>{tier.label} · {done}/{total}</span></header>
      <div className="decision-card-progress" role="progressbar" aria-label="Decision progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ width: `${Math.max(3, (100 * done) / total)}%` }} />
      </div>
      <p>{research ? `${research} ` : ""}You can leave; Corbanu keeps working{context ? ` with ${context}` : ""}.</p>
    </section>
  );
}
