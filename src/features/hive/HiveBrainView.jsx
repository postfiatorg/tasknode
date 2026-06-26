import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, GitBranch, RefreshCw } from "lucide-react";
import { requestJson } from "../../api";
import "./hive.css";

const reportTypeOptions = [
  { value: "", label: "All reports" },
  { value: "operative", label: "Operative" },
  { value: "rewarded_task", label: "Rewarded Task" },
  { value: "kol", label: "KOL" },
  { value: "development", label: "Development" },
  { value: "qa", label: "QA" },
  { value: "executive", label: "Executive" },
];

const decisionActionOptions = [
  { value: "all", label: "All decisions" },
  { value: "create_task", label: "Create task" },
  { value: "message_user", label: "Message user" },
  { value: "cancel_task", label: "Cancel task" },
  { value: "create_board", label: "Create board" },
  { value: "archive_board", label: "Archive board" },
  { value: "do_nothing", label: "Do nothing" },
];

function formatTime(value = "") {
  if (!value) return "unknown";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function formatBytes(value = 0) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function CollapsibleSection({ children, defaultOpen = false, number = "", subtitle = "", title = "" }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="hive-section hive-brain-section">
      <button
        className="hive-brain-section-toggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? <ChevronDown size={16} strokeWidth={1.8} /> : <ChevronRight size={16} strokeWidth={1.8} />}
        {number && <span className="hive-layer">{number}</span>}
        <span>
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </span>
      </button>
      {open && <div className="hive-brain-section-body">{children}</div>}
    </section>
  );
}

function ReportDocument({ detail, loading }) {
  if (loading && !detail) return <div className="hive-card hive-brain-empty">Loading report detail.</div>;
  if (!detail?.ok) return <div className="hive-card hive-brain-empty">Select a Hive report to inspect.</div>;
  const report = detail.report || {};
  return (
    <div className="hive-report-document">
      <div className="hive-report-meta">
        <span>{report.label || report.type}</span>
        <strong>{formatTime(report.generatedAt)}</strong>
        <small>{report.model || "model unknown"} · {formatBytes(report.bodyBytes)}</small>
      </div>
      <pre className="hive-report-body">{report.bodyMarkdown || "Report body unavailable."}</pre>
      <CollapsibleSection
        defaultOpen={false}
        subtitle={`${detail.verifications?.length || 0} phases`}
        title="Verification Phases"
      >
        <div className="hive-report-verifications">
          {(detail.verifications || []).map((verification) => (
            <article className="hive-card" key={verification.id}>
              <div>
                <strong>{verification.phase}</strong>
                <small>{verification.agent} · {formatTime(verification.verifiedAt)}</small>
              </div>
              <pre>{verification.resultSummary}</pre>
            </article>
          ))}
          {!detail.verifications?.length && <p>No verification phases recorded.</p>}
        </div>
      </CollapsibleSection>
    </div>
  );
}

function ReportsPanel() {
  const [reports, setReports] = useState([]);
  const [selectedReportId, setSelectedReportId] = useState("");
  const [detail, setDetail] = useState(null);
  const [reportType, setReportType] = useState("");
  const [listStatus, setListStatus] = useState("loading");
  const [detailStatus, setDetailStatus] = useState("idle");

  const loadReports = useCallback(async () => {
    setListStatus("loading");
    try {
      const params = new URLSearchParams({ limit: "36" });
      if (reportType) params.set("type", reportType);
      const result = await requestJson(`/api/hive/reports?${params.toString()}`);
      if (!result.ok) throw new Error(result.body?.message || `Hive reports failed with HTTP ${result.status}`);
      const nextReports = result.body?.reports || [];
      setReports(nextReports);
      setSelectedReportId((current) => current || nextReports[0]?.id || "");
      setListStatus("ready");
    } catch {
      setListStatus("error");
    }
  }, [reportType]);

  useEffect(() => {
    setSelectedReportId("");
    setDetail(null);
    loadReports();
  }, [loadReports]);

  useEffect(() => {
    if (!selectedReportId) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    setDetailStatus("loading");
    requestJson(`/api/hive/reports/${encodeURIComponent(selectedReportId)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `Hive report failed with HTTP ${result.status}`);
        setDetail(result.body || null);
        setDetailStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setDetailStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedReportId]);

  const latestByType = useMemo(() => {
    const entries = new Map();
    for (const report of reports) {
      if (report?.type && !entries.has(report.type)) entries.set(report.type, report);
    }
    return entries;
  }, [reports]);

  return (
    <section className="hive-section hive-brain-primary-reports">
      <div className="hive-section-heading">
        <div>
          <h2>Hive Reports</h2>
          <p>Human-readable Hive v2 reports. These six markdown reports are the primary Hive Brain surface.</p>
        </div>
        <FileText size={18} strokeWidth={1.8} />
      </div>
      <div className="hive-report-type-grid">
        {reportTypeOptions.filter((option) => option.value).map((option) => {
          const latest = latestByType.get(option.value);
          return (
            <button
              className={`hive-report-type-card ${reportType === option.value ? "is-active" : ""}`}
              key={option.value}
              onClick={() => {
                setReportType(option.value);
                if (latest?.id) setSelectedReportId(latest.id);
              }}
              type="button"
            >
              <strong>{option.label}</strong>
              <small>{latest ? formatTime(latest.generatedAt) : "missing"}</small>
              <span>{latest ? `${formatBytes(latest.bodyBytes)} markdown` : "No report generated yet"}</span>
            </button>
          );
        })}
      </div>
      <div className="hive-brain-controls hive-report-controls">
        <label>
          <span>Type</span>
          <select value={reportType} onChange={(event) => setReportType(event.target.value)}>
            {reportTypeOptions.map((option) => (
              <option key={option.value || "all"} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button className="hive-brain-icon-button" onClick={loadReports} title="Refresh reports" type="button">
          <RefreshCw size={16} strokeWidth={1.8} />
        </button>
      </div>
      <div className="hive-report-grid">
        <div className="hive-brain-timeline" role="list">
          {reports.map((report) => (
            <button
              className={`hive-brain-run hive-report-row ${selectedReportId === report.id ? "is-active" : ""}`}
              key={report.id}
              onClick={() => setSelectedReportId(report.id)}
              type="button"
            >
              <span className="hive-brain-run-time">{formatTime(report.generatedAt)}</span>
              <strong>{report.label || report.type}</strong>
              <small>{report.verificationCount || 0} phases · {formatBytes(report.bodyBytes)}</small>
              {report.bodyExcerpt && <em>{report.bodyExcerpt}</em>}
            </button>
          ))}
          {listStatus === "loading" && !reports.length && <div className="hive-card hive-brain-empty">Loading reports.</div>}
          {listStatus === "error" && <div className="hive-card hive-brain-empty">Report list failed to load.</div>}
          {listStatus === "ready" && !reports.length && <div className="hive-card hive-brain-empty">No reports have been generated yet.</div>}
        </div>
        <ReportDocument detail={detail} loading={detailStatus === "loading"} />
      </div>
    </section>
  );
}

function DecisionAgentDetail({ detail, loading }) {
  if (loading && !detail) return <div className="hive-card hive-brain-empty">Loading Decision Agent run.</div>;
  if (!detail?.ok) return <div className="hive-card hive-brain-empty">Select a shadow Decision Agent run to inspect.</div>;
  const run = detail.run || {};
  const guardrail = run.guardrailResult || {};
  const reasons = Array.isArray(guardrail.reasons) ? guardrail.reasons : [];
  const result = run.result || {};
  const execution = result.executionResult || result;
  const resultText = [
    guardrail.ok ? "Guardrails passed." : guardrail.blocked ? "Guardrails blocked execution." : "Guardrail status is unknown.",
    reasons.length ? `Reasons: ${reasons.join(", ")}.` : "",
    execution.executed === false ? "No mutation executed." : execution.executed === true ? "Mutation executed through the guarded action adapter." : "",
    execution.reason ? `Result reason: ${execution.reason}.` : "",
  ].filter(Boolean).join(" ");
  return (
    <div className="hive-decision-detail">
      <div className="hive-report-meta">
        <span>{run.selectedAction || "pending"}</span>
        <strong>{formatTime(run.startedAt)}</strong>
        <small>{run.model || "model unknown"} · shadow</small>
      </div>
      <article className="hive-card hive-decision-explanation">
        <h3>Explanation</h3>
        <p>{run.reasoningText || "No explanation recorded."}</p>
      </article>
      <article className="hive-card hive-decision-explanation">
        <h3>Result</h3>
        <p>{resultText || "No result recorded."}</p>
      </article>
      <div className="hive-brain-chips">
        <span className="hive-brain-chip">
          <small>Guardrail</small>
          <strong>{guardrail.ok ? "ok" : guardrail.blocked ? "blocked" : "unknown"}</strong>
        </span>
        <span className="hive-brain-chip">
          <small>Reports</small>
          <strong>{run.inputReportIds?.length || 0}</strong>
        </span>
        <span className="hive-brain-chip">
          <small>Idle candidates</small>
          <strong>{run.taskStatusSnapshot?.idleEligibleContributorCount || 0}</strong>
        </span>
      </div>
      <CollapsibleSection defaultOpen title="Options Considered">
        <div className="hive-decision-options">
          {(run.optionsConsidered || []).map((option, index) => (
            <article className="hive-card" key={`${option.action}-${index}`}>
              <strong>{option.action}</strong>
              <p>{option.summary}</p>
              <small>{option.rejectedBecause}</small>
            </article>
          ))}
          {!run.optionsConsidered?.length && <p>No options recorded.</p>}
        </div>
      </CollapsibleSection>
    </div>
  );
}

function DecisionAgentPanel() {
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [detail, setDetail] = useState(null);
  const [action, setAction] = useState("all");
  const [listStatus, setListStatus] = useState("loading");
  const [detailStatus, setDetailStatus] = useState("idle");

  const loadRuns = useCallback(async () => {
    setListStatus("loading");
    try {
      const params = new URLSearchParams({ limit: "12", action });
      const result = await requestJson(`/api/hive/decision/runs?${params.toString()}`);
      if (!result.ok) throw new Error(result.body?.message || `Decision Agent runs failed with HTTP ${result.status}`);
      const nextRuns = result.body?.runs || [];
      setRuns(nextRuns);
      setSelectedRunId((current) => current || nextRuns[0]?.id || "");
      setListStatus("ready");
    } catch {
      setListStatus("error");
    }
  }, [action]);

  useEffect(() => {
    setSelectedRunId("");
    setDetail(null);
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    setDetailStatus("loading");
    requestJson(`/api/hive/decision/run/${encodeURIComponent(selectedRunId)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `Decision Agent run failed with HTTP ${result.status}`);
        setDetail(result.body || null);
        setDetailStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setDetailStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  return (
    <section className="hive-section">
      <div className="hive-section-heading">
        <div>
          <h2>Decision Agent</h2>
          <p>Hive v2 shadow decisions from reports, live task state, and board discussions. No mutations execute in Phase 2.</p>
        </div>
        <GitBranch size={18} strokeWidth={1.8} />
      </div>
      <div className="hive-brain-controls hive-report-controls">
        <label>
          <span>Action</span>
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            {decisionActionOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button className="hive-brain-icon-button" onClick={loadRuns} title="Refresh Decision Agent runs" type="button">
          <RefreshCw size={16} strokeWidth={1.8} />
        </button>
      </div>
      <div className="hive-report-grid">
        <div className="hive-brain-timeline" role="list">
          {runs.map((run) => (
            <button
              className={`hive-brain-run hive-report-row ${selectedRunId === run.id ? "is-active" : ""}`}
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
              type="button"
            >
              <span className="hive-brain-run-time">{formatTime(run.startedAt)}</span>
              <strong>{run.selectedAction || run.status}</strong>
              <small>{run.guardrailResult?.ok ? "guardrail ok" : run.guardrailResult?.blocked ? "blocked" : run.status}</small>
              {run.reasoningText && <em>{run.reasoningText}</em>}
            </button>
          ))}
          {listStatus === "loading" && !runs.length && <div className="hive-card hive-brain-empty">Loading Decision Agent runs.</div>}
          {listStatus === "error" && <div className="hive-card hive-brain-empty">Decision Agent runs failed to load.</div>}
          {listStatus === "ready" && !runs.length && <div className="hive-card hive-brain-empty">No shadow Decision Agent runs have been recorded yet.</div>}
        </div>
        <DecisionAgentDetail detail={detail} loading={detailStatus === "loading"} />
      </div>
    </section>
  );
}

export function HiveBrainView() {
  return (
    <div className="route-scroll hive-route">
      <div className="hive-shell hive-brain-shell">
        <header className="hive-header">
          <div>
            <div className="hive-live-kicker">
              <span />
              Operator audit
            </div>
            <h1>Hive Brain</h1>
            <p>Human-readable reports and Decision Agent summaries for understanding the live Hive system.</p>
          </div>
          <div className="hive-stats">
            <div className="hive-stat">
              <span>Primary</span>
              <strong>Reports</strong>
            </div>
            <div className="hive-stat">
              <span>Format</span>
              <strong>Markdown</strong>
            </div>
          </div>
        </header>

        <ReportsPanel />
        <DecisionAgentPanel />
      </div>
    </div>
  );
}
