import { Download, Copy, FileText, Lightbulb } from "lucide-react";
import { decisionTier } from "./decisions-client.js";

const stageKeys = ["framing", "planning_research", "researching", "voting", "drafting", "mini_tih", "rewriting"];

export function DecisionArtifactCard({ decision, onCopy, onDownload }) {
  if (!decision) return null;
  const { status, stage, jobId, selected, voteCounts = {}, markdown = "", contextIncluded } = decision;
  const tier = decisionTier(decision.mode);
  const [define, research, vote, review, rewrite] = tier.steps;
  const stages = stageKeys.map((key, i) => [key, [define, "Plan research", research, vote, "Write the draft", review, rewrite][i]]);
  const completed = status === "completed";
  const failed = status === "failed";
  const snapshot = decision.contextSnapshot;
  const memoryCount = (snapshot?.deepMemoryCount || 0) + (snapshot?.recentMemoryCount || 0);
  const contextSources = [
    (snapshot ? snapshot.document : contextIncluded) ? "saved context document" : "",
    memoryCount ? `${memoryCount} conversation ${memoryCount === 1 ? "memory" : "memories"}` : "",
  ].filter(Boolean);
  const current = stages.findIndex(([key]) => key === stage);
  const researchStage = decision.researchProgress?.find(report => report.status !== "COMPLETED")?.stage;
  const researchDetail = {
    planning: "Planning the research.", searching: "Finding sources.",
    reading_sources: "Reading and analyzing sources.",
    synthesizing: "Writing and reviewing the research report.",
    finalizing: "Finishing the research report.",
    waiting_for_capacity: "Waiting for model capacity. Your work is saved and will resume automatically.",
  }[researchStage];
  const base = `/api/decisions/jobs/${encodeURIComponent(jobId || "")}`;
  return (
    <div className={`deep-research-card decision-card is-${status || "running"}`}>
      <div className="deep-research-card-head">
        <span className="deep-research-icon"><Lightbulb size={16} strokeWidth={1.8} /></span>
        <div>
          <strong>{completed ? `Decision report · Option ${selected}` : `Decisions · ${tier.label}`}</strong>
          <small>{failed ? decision.error || "This decision did not complete." : completed
            ? tier.summary
            : `${decision.completedCalls || 0} of ${tier.totalCalls} steps complete · You can leave and return`}</small>
        </div>
      </div>
      {!completed && !failed && stage === "researching" && researchDetail && (
        <p className="deep-research-privacy" role="status">{researchDetail}</p>
      )}
      {!completed && (
        <ol className="deep-research-trace">
          {stages.map(([key, label], index) => (
            <li className={current > index ? "is-completed" : current === index ? failed ? "is-failed" : "is-running" : "is-queued"} key={key}>
              <span className="deep-research-trace-dot" aria-hidden="true" /><span>{label}</span>
            </li>
          ))}
        </ol>
      )}
      {selected && <p className="decision-votes">{tier.votes}: {Object.entries(voteCounts).map(([option, count]) => `${option}: ${count}`).join(" · ")}</p>}
      <div className="deep-research-privacy">{contextSources.length ? `Includes your ${contextSources.join(" and ")}. ` : ""}Processed by Corbanu and its model and research providers.</div>
      <div className="deep-research-card-actions">
        {completed && markdown && <>
          <button type="button" onClick={() => onCopy(markdown)}><Copy size={14} />Copy Markdown</button>
          <button type="button" onClick={() => onDownload({ filename: `decision-${jobId}.md`, text: markdown })}><Download size={14} />Download .md</button>
          <a href={`${base}/pdf`} download><Download size={14} />Download PDF</a>
        </>}
        {jobId && <a href={`${base}/packet`} download><FileText size={14} />Full packet</a>}
      </div>
    </div>
  );
}
