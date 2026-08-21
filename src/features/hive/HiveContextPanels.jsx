import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  formatContextTime,
  formatPft,
  projectTypeLabel,
  shortHash,
  shortId,
} from "./hive-view-utils.jsx";

export function HiveContextPanel({ boardManager, context, expanded, onToggle, status, secretary }) {
  const [activeTab, setActiveTab] = useState("context");
  const [rawOpen, setRawOpen] = useState(false);
  const groups = context?.groups || [];
  const entryCount = Number(context?.entryCount || 0);
  const userCount = Number(context?.userCount || groups.length || 0);
  const hasEntries = entryCount > 0;
  const report = secretary?.report || null;
  const reportOutput = report?.output || {};
  const pending = secretary?.job && ["pending", "processing"].includes(secretary.job.status);
  const statusText = status === "loading"
    ? "Loading"
    : status === "error"
      ? "Could not load"
      : hasEntries
        ? `${entryCount} ${entryCount === 1 ? "entry" : "entries"} from ${userCount} ${userCount === 1 ? "user" : "users"}`
        : "No Hive chat entries yet";

  return (
    <div className="hive-card hive-context-panel">
      <button className="hive-context-toggle" onClick={onToggle} type="button">
        <span>
          <strong>Hive Context</strong>
          <small>{statusText}</small>
        </span>
        <ChevronDown className={expanded ? "is-open" : ""} size={16} strokeWidth={1.8} />
      </button>
      {expanded && (
        <div className="hive-context-body">
          <div className="hive-context-tabs" role="tablist" aria-label="Hive context views">
            <button
              aria-selected={activeTab === "context"}
              className={activeTab === "context" ? "is-active" : ""}
              onClick={() => setActiveTab("context")}
              role="tab"
              type="button"
            >
              Hive Context
            </button>
            <button
              aria-selected={activeTab === "agent"}
              className={activeTab === "agent" ? "is-active" : ""}
              onClick={() => setActiveTab("agent")}
              role="tab"
              type="button"
            >
              Hive Mind Agent
            </button>
          </div>
          {activeTab === "context" ? (
            <HiveContextInputs
              groups={groups}
              hasEntries={hasEntries}
              pending={pending}
              rawOpen={rawOpen}
              report={report}
              reportOutput={reportOutput}
              setRawOpen={setRawOpen}
              status={status}
              userCount={userCount}
              entryCount={entryCount}
            />
          ) : (
            <HiveMindAgentPanel boardManager={boardManager} />
          )}
        </div>
      )}
    </div>
  );
}

export function HiveContextInputs({
  entryCount,
  groups,
  hasEntries,
  pending,
  rawOpen,
  report,
  reportOutput,
  setRawOpen,
  status,
  userCount,
}) {
  return (
    <>
      {!hasEntries && status !== "loading" && (
        <p className="hive-context-empty">Use the default Hive chat to add network context.</p>
      )}
      {(report || pending || hasEntries) && (
        <section className="hive-secretary">
          <header>
            <span>
              <strong>Hive Secretary</strong>
              <small>
                {report?.completedAt
                  ? `Updated ${formatContextTime(report.completedAt)}`
                  : pending
                    ? "Updating from validated wallet inputs"
                    : "Waiting for validated wallet inputs"}
              </small>
            </span>
            {report?.model && <code>{report.model}</code>}
          </header>
          {report ? (
            <div className="hive-secretary-report">
              <h3>{reportOutput.title || "Hive Secretary Report"}</h3>
              {reportOutput.summary && <p>{reportOutput.summary}</p>}
              {Array.isArray(reportOutput.projectSignals) && reportOutput.projectSignals.length > 0 && (
                <HiveSecretaryList
                  items={reportOutput.projectSignals.map((item) => [
                    item.projectType ? `${projectTypeLabel(item.projectType)}: ` : "",
                    item.signal || item.reason || "",
                  ].join(""))}
                  title="Project signals"
                />
              )}
              <HiveSecretaryList items={reportOutput.networkImplications} title="Network implications" />
              <HiveSecretaryList items={reportOutput.openQuestions} title="Open questions" />
              <HiveSecretaryList items={reportOutput.nextSystemFocus} title="Next system focus" />
            </div>
          ) : (
            <p className="hive-context-empty">
              The Secretary report is generated asynchronously from linked-wallet Hive chat entries.
            </p>
          )}
        </section>
      )}
      {hasEntries && (
        <section className="hive-context-raw">
          <button className="hive-context-raw-toggle" onClick={() => setRawOpen((open) => !open)} type="button">
            <span>
              <strong>Raw inputs</strong>
              <small>{entryCount} {entryCount === 1 ? "entry" : "entries"} from {userCount} {userCount === 1 ? "user" : "users"}</small>
            </span>
            <ChevronDown className={rawOpen ? "is-open" : ""} size={15} strokeWidth={1.8} />
          </button>
          {rawOpen && groups.map((group) => (
            <section className="hive-context-user" key={group.accountId || group.displayName}>
              <header>
                <strong>{group.displayName || "Unknown user"}</strong>
                <small>{group.entryCount} {group.entryCount === 1 ? "entry" : "entries"}</small>
              </header>
              <div className="hive-context-entries">
                {(group.entries || []).map((entry) => (
                  <article className="hive-context-entry" key={entry.id}>
                    <p>{entry.body}</p>
                    <footer>
                      <time>{formatContextTime(entry.createdAt)}</time>
                      {entry.walletValidated && <span>validated wallet</span>}
                    </footer>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </section>
      )}
    </>
  );
}

export function HiveMindAgentPanel({ boardManager }) {
  const feed = boardManager?.feed || [];
  const logMode = boardManager?.logMode || "summary";
  return (
    <section className="hive-agent-panel">
      <header className="hive-agent-heading">
        <span>
          <strong>Hive Mind Agent</strong>
          <small>
            {feed.length ? `${feed.length} recent ${feed.length === 1 ? "run" : "runs"}` : "No agent runs recorded"}
            {logMode === "full" ? " · full logs available" : ""}
          </small>
        </span>
      </header>
      <div className="hive-agent-feed">
        {feed.length ? feed.map((entry) => (
          <HiveAgentRun entry={entry} key={entry.id || entry.runId} />
        )) : (
          <p className="hive-context-empty">Board Manager runs will appear here after the agent evaluates Hive state.</p>
        )}
      </div>
    </section>
  );
}

export function HiveAgentRun({ entry }) {
  const [logsOpen, setLogsOpen] = useState(false);
  const target = [entry.targetType, entry.targetId].filter(Boolean).join(" · ");
  const resultCount = entry.actionResults?.length || 0;
  const decisionReason = entry.reason && entry.reason !== entry.summary ? entry.reason : "";
  const resultSummary = entry.actionResults?.find((result) => result.summary || result.error)?.summary || "";
  const details = entry.details || null;
  const hasDetails = Boolean(details);
  const decisionBasis = buildDecisionBasis({ entry, details });
  const auditSummary = buildAgentAuditSummary({ entry, details });
  return (
    <article className={`hive-agent-run is-${entry.state || "recorded"}`}>
      <div className="hive-agent-run-top">
        <span className={`hive-agent-state is-${entry.state || "recorded"}`}>{entry.label || "No decision"}</span>
        <time>{formatContextTime(entry.completedAt || entry.startedAt)}</time>
      </div>
      <p>{entry.summary || entry.reason || "No summary recorded."}</p>
      {decisionReason && (
        <div className="hive-agent-audit-block">
          <span>Decision reason</span>
          <p>{decisionReason}</p>
        </div>
      )}
      {resultSummary && (
        <div className="hive-agent-audit-block">
          <span>Action result</span>
          <p>{resultSummary}</p>
        </div>
      )}
      {decisionBasis.nextCheck && (
        <div className="hive-agent-audit-block">
          <span>Next check</span>
          <p>{decisionBasis.nextCheck}</p>
        </div>
      )}
      <div className="hive-agent-audit-row">
        {Number.isFinite(entry.confidence) && entry.confidence > 0 && <span>Confidence {Math.round(entry.confidence * 100)}%</span>}
        {entry.runId && <span>Run {shortId(entry.runId)}</span>}
        {entry.sourcePacketDigest && <span>Source {shortHash(entry.sourcePacketDigest)}</span>}
        {entry.sessionMode && <span>{entry.sessionMode}</span>}
      </div>
      <footer>
        {target && <span>{target}</span>}
        {entry.dryRun && <span>dry run</span>}
        {resultCount > 0 && <span>{resultCount} {resultCount === 1 ? "result" : "results"}</span>}
        {entry.trigger && <span>{entry.trigger}</span>}
      </footer>
      <button
        aria-expanded={logsOpen}
        className="hive-agent-log-toggle"
        onClick={() => setLogsOpen((open) => !open)}
        type="button"
      >
        <span>Full logs</span>
        <ChevronDown className={logsOpen ? "is-open" : ""} size={15} strokeWidth={1.8} />
      </button>
      {logsOpen && (
        <div className="hive-agent-full-logs">
          {hasDetails ? (
            <>
              <DecisionBasisPanel basis={decisionBasis} />
              <AgentAuditSummary summary={auditSummary} />
              <AgentLogSection title="Raw Scheduler Job JSON" value={details.job} />
              <AgentLogSection title="Raw Decision JSON" value={details.decision} />
              <AgentLogSection title="Raw Action Payload JSON" value={details.actionPayload} />
              <AgentLogSection title="Raw Action Result JSON" value={details.actionResults} />
              <AgentLogSection title="Provider Output" value={details.outputText} empty="No provider output text was stored for this run." />
              <AgentLogSection title="Micro Summary" value={details.microSummaryText || details.microSummary} />
              <AgentLogSection title="Raw Source Snapshot JSON" value={details.sourcePacket} />
            </>
          ) : (
            <p className="hive-agent-log-empty">Full logs were not attached to this feed response.</p>
          )}
        </div>
      )}
    </article>
  );
}

export function AgentAuditSummary({ summary }) {
  const rows = Array.isArray(summary?.rows) ? summary.rows.filter((row) => row?.value) : [];
  if (!rows.length) return null;
  return (
    <section className="hive-agent-audit-summary">
      <h4>Audit Summary</h4>
      <dl>
        {rows.map((row) => (
          <React.Fragment key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

export function DecisionBasisPanel({ basis }) {
  return (
    <section className="hive-agent-basis-panel">
      <h4>Decision Basis</h4>
      <DecisionBasisList items={basis.sourceFacts} title="Source facts" />
      <DecisionBasisList items={basis.tradeoffs} title="Tradeoffs" />
      <DecisionBasisRejected items={basis.rejectedActions} />
      <DecisionBasisList items={basis.riskNotes} title="Risk notes" />
      {basis.nextCheck && (
        <div className="hive-agent-basis-next">
          <strong>Next check</strong>
          <p>{basis.nextCheck}</p>
        </div>
      )}
    </section>
  );
}

export function DecisionBasisList({ items = [], title }) {
  const normalized = items.filter(Boolean);
  if (!normalized.length) return null;
  return (
    <div className="hive-agent-basis-list">
      <strong>{title}</strong>
      <ul>
        {normalized.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

export function DecisionBasisRejected({ items = [] }) {
  const normalized = items.filter((item) => item?.action || item?.reason);
  if (!normalized.length) return null;
  return (
    <div className="hive-agent-basis-list">
      <strong>Rejected actions</strong>
      <ul>
        {normalized.map((item, index) => (
          <li key={`${item.action || "action"}-${index}`}>
            {item.action ? <span>{item.action}: </span> : null}
            {item.reason || "No reason recorded."}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AgentLogSection({ empty = "No value recorded.", title, value }) {
  const rendered = formatLogValue(value);
  const isRaw = /^Raw\b/.test(title);
  if (isRaw) {
    return (
      <details className="hive-agent-log-section is-raw">
        <summary>{title}</summary>
        {rendered ? <pre>{rendered}</pre> : <p>{empty}</p>}
      </details>
    );
  }
  return (
    <section className="hive-agent-log-section">
      <h4>{title}</h4>
      {rendered ? <pre>{rendered}</pre> : <p>{empty}</p>}
    </section>
  );
}

export function formatLogValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.length === 0) return "";
  if (typeof value === "object" && !Object.keys(value).length) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || "").trim();
  }
}

export function buildAgentAuditSummary({ entry = {}, details = null } = {}) {
  const job = details?.job || {};
  const decision = details?.decision || {};
  const actionPayload = details?.actionPayload || {};
  const sourcePacket = details?.sourcePacket || {};
  const pressureSummary = sourcePacket.boardActionPressure?.summary || {};
  const routingAccounts = Array.isArray(sourcePacket.routingConstraints?.accounts)
    ? sourcePacket.routingConstraints.accounts
    : [];
  const actionResults = Array.isArray(details?.actionResults) ? details.actionResults : [];
  const firstResult = actionResults[0]?.result || {};
  const action = entry.action || decision.action || actionPayload.action || "";
  const target = [entry.targetType || decision.target_type, entry.targetId || decision.target_id].filter(Boolean).join(" / ");
  const routingConstraintText = routingAccounts.length
    ? routingAccounts.slice(0, 4).map((account) => {
        const minPft = account.reservationRate?.minPft;
        return `${account.accountId || "account"} min ${formatPft(minPft)} PFT`;
      }).join("; ")
    : "No explicit reservation-rate constraints in this source packet.";
  const boardState = [
    pressureSummary.motionState ? `motion=${pressureSummary.motionState}` : "",
    pressureSummary.eligibleCandidateCount !== undefined ? `eligible=${pressureSummary.eligibleCandidateCount}` : "",
    pressureSummary.projectsWithoutLiveTasks !== undefined ? `projects_without_live_tasks=${pressureSummary.projectsWithoutLiveTasks}` : "",
    pressureSummary.openFollowupCount !== undefined ? `open_followups=${pressureSummary.openFollowupCount}` : "",
  ].filter(Boolean).join("; ");
  const actionOutcome = [
    firstResult.reason || firstResult.error || actionResults[0]?.summary || "",
    firstResult.executed === false || firstResult.skipped ? "skipped" : "",
    firstResult.followupId ? `followup=${shortId(firstResult.followupId)}` : "",
    firstResult.taskId ? `task=${shortId(firstResult.taskId)}` : "",
    firstResult.allocationId ? `allocation=${shortId(firstResult.allocationId)}` : "",
  ].filter(Boolean).join("; ");
  return {
    rows: [
      { label: "Trigger", value: job.trigger || entry.trigger || "manual/unknown" },
      { label: "Job state", value: job.id ? `${shortId(job.id)} is ${job.status || entry.status || "pending"}` : (entry.status || entry.state || "") },
      { label: "Timing", value: [
        job.runAfter ? `run_after=${formatContextTime(job.runAfter)}` : "",
        job.claimedAt ? `claimed=${formatContextTime(job.claimedAt)}` : "",
        entry.completedAt || entry.startedAt ? `run=${formatContextTime(entry.completedAt || entry.startedAt)}` : "",
      ].filter(Boolean).join("; ") },
      { label: "Decision", value: action ? `${action}${target ? ` -> ${target}` : ""}` : "" },
      { label: "Board state", value: boardState },
      { label: "Routing constraints", value: routingConstraintText },
      { label: "Action outcome", value: actionOutcome || entry.summary || entry.reason || "" },
      { label: "Source digest", value: sourcePacket.sourcePacketDigest || entry.sourcePacketDigest || "" },
    ],
  };
}

export function buildDecisionBasis({ entry = {}, details = null } = {}) {
  const decision = details?.decision || {};
  const structured = normalizeDecisionBasis(decision.decision_basis || decision.decisionBasis || entry.decisionBasis || {});
  if (structured.hasAny) return structured;
  if (details?.job) return buildSchedulerJobBasis({ entry, job: details.job });
  const sourcePacket = details?.sourcePacket || {};
  const actionResults = details?.actionResults || [];
  if (entry.action === "daily_airdrop") {
    return buildDailyAirdropBasis({ entry, sourcePacket, actionResults });
  }
  return buildSourceSnapshotBasis({ entry, sourcePacket, actionResults });
}

export function normalizeDecisionBasis(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceFacts = stringList(input.source_facts || input.sourceFacts, 8);
  const tradeoffs = stringList(input.tradeoffs, 6);
  const rejectedActions = Array.isArray(input.rejected_actions || input.rejectedActions)
    ? (input.rejected_actions || input.rejectedActions).slice(0, 8).map((item) => ({
        action: String(item?.action || "").trim(),
        reason: String(item?.reason || "").trim(),
      })).filter((item) => item.action || item.reason)
    : [];
  const riskNotes = stringList(input.risk_notes || input.riskNotes, 6);
  const nextCheck = String(input.next_check || input.nextCheck || "").trim();
  return {
    sourceFacts,
    tradeoffs,
    rejectedActions,
    riskNotes,
    nextCheck,
    hasAny: Boolean(sourceFacts.length || tradeoffs.length || rejectedActions.length || riskNotes.length || nextCheck),
  };
}

export function buildSchedulerJobBasis({ entry = {}, job = {} } = {}) {
  const attempts = Number(job.attemptCount || 0);
  const maxAttempts = Number(job.maxAttempts || 0);
  return {
    sourceFacts: [
      `Scheduler job ${job.id || entry.id || "unknown"} is ${job.status || entry.status || "pending"}.`,
      job.trigger ? `Trigger is ${job.trigger}.` : "",
      job.reason ? `Reason: ${job.reason}` : "",
      Number.isFinite(attempts) && maxAttempts ? `Attempt ${attempts.toLocaleString("en-US")} of ${maxAttempts.toLocaleString("en-US")}.` : "",
      job.claimedBy ? `Claimed by ${job.claimedBy}.` : "The job has not recorded a worker claim yet.",
    ].filter(Boolean),
    tradeoffs: ["This is a scheduler job waiting for, or currently inside, a Board Manager run. Decision JSON is not available until the run is started and persisted."],
    rejectedActions: [],
    riskNotes: job.lastError ? [job.lastError] : [],
    nextCheck: "Wait for the matching Board Manager run to complete, or inspect this scheduler job for stale claimed_at/run_after timestamps if it stays pending.",
    hasAny: true,
  };
}

export function buildDailyAirdropBasis({ sourcePacket = {}, actionResults = [] } = {}) {
  const result = actionResults?.[0]?.result || {};
  const candidateCount = Number(sourcePacket.candidateCount ?? result.candidateCount ?? 0);
  const scoredCount = Number(sourcePacket.scoredCount ?? result.scoredCount ?? 0);
  const issuedCount = Number(sourcePacket.issuedCount ?? result.userCount ?? 0);
  const failedCount = Number(sourcePacket.failedCount ?? result.failedCount ?? 0);
  const totalPft = Number(sourcePacket.totalPft ?? result.totalPft ?? 0);
  const sourceFacts = [
    `${candidateCount.toLocaleString("en-US")} candidate ${candidateCount === 1 ? "account was" : "accounts were"} loaded for this daily airdrop tick.`,
    `${scoredCount.toLocaleString("en-US")} candidate ${scoredCount === 1 ? "account was" : "accounts were"} scored.`,
    `${issuedCount.toLocaleString("en-US")} payout ${issuedCount === 1 ? "was" : "were"} submitted, totaling ${formatPft(totalPft)} PFT.`,
  ];
  if (failedCount) sourceFacts.push(`${failedCount.toLocaleString("en-US")} candidate ${failedCount === 1 ? "failed" : "accounts failed"} during scoring or issuance.`);
  return {
    sourceFacts,
    tradeoffs: ["This is a deterministic worker audit card, not a model-selected Hive board decision."],
    rejectedActions: [],
    riskNotes: failedCount ? ["Failed accounts should be inspected before retrying issuance."] : [],
    nextCheck: totalPft > 0
      ? "Inspect action-result JSON for issuance ids, recipient wallets, and transaction hashes."
      : "Inspect scored account rows to confirm why eligible accounts received 0 PFT.",
    hasAny: true,
  };
}

export function buildSourceSnapshotBasis({ entry = {}, sourcePacket = {}, actionResults = [] } = {}) {
  const pressure = sourcePacket.boardActionPressure || {};
  const summary = pressure.summary || {};
  const signals = Array.isArray(pressure.signals) ? pressure.signals : [];
  const sourceFacts = [];
  if (summary.motionState) sourceFacts.push(`Board motion state was ${summary.motionState}.`);
  if (summary.activeProjectCount !== undefined) sourceFacts.push(`${Number(summary.activeProjectCount || 0).toLocaleString("en-US")} active project ${Number(summary.activeProjectCount || 0) === 1 ? "was" : "were"} in the source packet.`);
  if (summary.projectsWithoutLiveTasks !== undefined) sourceFacts.push(`${Number(summary.projectsWithoutLiveTasks || 0).toLocaleString("en-US")} active project ${Number(summary.projectsWithoutLiveTasks || 0) === 1 ? "had" : "had"} no live task movement.`);
  if (summary.eligibleCandidateCount !== undefined) sourceFacts.push(`${Number(summary.eligibleCandidateCount || 0).toLocaleString("en-US")} eligible Network Task candidate ${Number(summary.eligibleCandidateCount || 0) === 1 ? "was" : "were"} available after capacity blockers.`);
  signals.slice(0, 4).forEach((signal) => {
    const reasons = Array.isArray(signal.reasons) ? signal.reasons.join("; ") : "";
    sourceFacts.push(`${signal.projectId || "project"}: ${reasons || signal.pressure || "pressure signal recorded"}.`);
  });
  const result = actionResults?.[0]?.result || {};
  if (result.error) sourceFacts.push(`Action hook reported error: ${result.error}.`);
  return {
    sourceFacts: sourceFacts.length ? sourceFacts : [entry.reason || entry.summary || "No structured source facts were stored for this run."],
    tradeoffs: entry.reason ? [entry.reason] : [],
    rejectedActions: [],
    riskNotes: result.error ? [result.error] : [],
    nextCheck: "Open Source Snapshot JSON to inspect boardActionPressure, candidates, open follow-ups, and project task state for this run.",
    hasAny: true,
  };
}

export function stringList(value, max = 6) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, max)
    : [];
}

export function HiveSecretaryList({ items = [], title }) {
  const normalized = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!normalized.length) return null;
  return (
    <section className="hive-secretary-list">
      <h4>{title}</h4>
      <ul>
        {normalized.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
