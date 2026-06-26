import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { requestJson } from "../../api";
import "./hive.css";

const reportTabs = [
  { id: "operative", type: "operative", label: "Operative", title: "Operative report", cadence: "24h" },
  { id: "rewarded", type: "rewarded_task", label: "Rewarded tasks", title: "Rewarded task report", cadence: "20m" },
  { id: "kol", type: "kol", label: "KOL", title: "KOL report", cadence: "daily" },
  { id: "dev", type: "development", label: "Development", title: "Development report", cadence: "24h" },
  { id: "qa", type: "qa", label: "QA", title: "QA report", cadence: "24h" },
  { id: "exec", type: "executive", label: "Executive", title: "Executive report", cadence: "24h" },
];

const tabs = [{ id: "overview", label: "Overview" }, ...reportTabs];

const decisionActions = [
  "create_task",
  "message_user",
  "cancel_task",
  "create_board",
  "archive_board",
  "do_nothing",
];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatAction(value = "") {
  return String(value || "pending")
    .split("_")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

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

function relativeTime(value = "") {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value ? formatTime(value) : "unknown";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatBytes(value = 0) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function compactNumber(value = 0) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "0";
  if (Math.abs(numeric) >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (Math.abs(numeric) >= 1_000) return `${(numeric / 1_000).toFixed(1)}K`;
  return String(Math.round(numeric));
}

function parseMarkdownBlocks(markdown = "") {
  const lines = String(markdown || "").split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (!list?.items?.length) return;
    blocks.push(list);
    list = null;
  };
  const flushCode = () => {
    if (!code) return;
    blocks.push({ type: "code", text: code.lines.join("\n") });
    code = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      if (code) flushCode();
      else code = { lines: [] };
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 4), text: heading[2] });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (bullet || ordered) {
      flushParagraph();
      const type = ordered ? "ordered" : "unordered";
      if (!list || list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((bullet || ordered)[1]);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  flushCode();
  return blocks;
}

function Badge({ children, variant = "gray" }) {
  return <span className={`hive-brain-badge is-${variant}`}>{children}</span>;
}

function Status({ children, type = "" }) {
  const normalized = String(type || children || "").toLowerCase().replace(/_/g, "-");
  return <span className={`hive-brain-status is-${normalized}`}>{children}</span>;
}

function Kpi({ accent = false, label, sub = "", value }) {
  return (
    <div className="hive-brain-kpi">
      <div className="hive-brain-kpi-label">{label}</div>
      <div className={`hive-brain-kpi-value ${accent ? "is-accent" : ""}`}>{value}</div>
      {sub && <div className="hive-brain-kpi-sub">{sub}</div>}
    </div>
  );
}

function MarkdownReportBody({ markdown = "" }) {
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);
  if (!blocks.length) {
    return <div className="hive-report-body hive-report-markdown"><p>Report body unavailable.</p></div>;
  }
  return (
    <div className="hive-report-body hive-report-markdown">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Heading = `h${Math.min(Math.max(block.level + 1, 3), 5)}`;
          return <Heading key={`${block.type}-${index}`}>{block.text}</Heading>;
        }
        if (block.type === "code") return <pre key={`${block.type}-${index}`}>{block.text}</pre>;
        if (block.type === "ordered") {
          return (
            <ol key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{item}</li>)}
            </ol>
          );
        }
        if (block.type === "unordered") {
          return (
            <ul key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{item}</li>)}
            </ul>
          );
        }
        return <p key={`${block.type}-${index}`}>{block.text}</p>;
      })}
    </div>
  );
}

function reportExcerpt(report = {}) {
  return report.bodyExcerpt || report.bodyMarkdownExcerpt || "Open the report for the full markdown briefing.";
}

function decisionSummary(detail = null) {
  const run = detail?.run || {};
  const guardrail = run.guardrailResult || {};
  const result = run.result || {};
  const execution = result.executionResult || result;
  if (run.reasoningText) return run.reasoningText;
  if (execution.reason) return execution.reason;
  if (guardrail.blocked) return "Guardrails blocked this action before mutation.";
  if (guardrail.ok) return "Guardrails passed for this decision.";
  return "The Decision Agent has not recorded a plain-English summary for this run yet.";
}

function decisionResult(detail = null) {
  const run = detail?.run || {};
  const guardrail = run.guardrailResult || {};
  const reasons = safeArray(guardrail.reasons);
  const result = run.result || {};
  const execution = result.executionResult || result;
  return [
    guardrail.ok ? "Guardrails passed." : guardrail.blocked ? "Guardrails blocked execution." : "Guardrail status unknown.",
    reasons.length ? `Reasons: ${reasons.join(", ")}.` : "",
    execution.executed === true ? "Mutation executed through the guarded adapter." : "",
    execution.executed === false ? "No mutation executed." : "",
    execution.reason ? `Result reason: ${execution.reason}.` : "",
  ].filter(Boolean).join(" ");
}

function flattenLiveTasks(projectDocument = null) {
  const projects = projectDocument?.projects || {};
  return Object.values(projects)
    .flatMap((project) =>
      safeArray(project.tasks).map((task) => ({
        ...task,
        project: project.name || project.id || "Project",
      }))
    )
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""))
    .slice(0, 7);
}

function DecisionCard({ detail, loading }) {
  const run = detail?.run || {};
  const action = run.selectedAction || run.status || "pending";
  const options = safeArray(run.optionsConsidered);
  const chips = [
    `Guardrail · ${run.guardrailResult?.ok ? "ok" : run.guardrailResult?.blocked ? "blocked" : "unknown"}`,
    `Reports · ${safeArray(run.inputReportIds).length}`,
    `Candidates · ${run.taskStatusSnapshot?.idleEligibleContributorCount || 0}`,
  ];
  return (
    <div className="hive-brain-card hive-brain-decision-card">
      <div className="hive-brain-decision-top">
        <Badge variant="action">Board manager · decision</Badge>
        <Badge variant={run.guardrailResult?.blocked ? "amber" : "blue"}>{formatAction(action)}</Badge>
        <span className="hive-brain-grow" />
        <span>{loading ? "Loading run" : `Cycle · ${relativeTime(run.startedAt)}`}</span>
      </div>
      <div className="hive-brain-decision-body">
        <h2>{run.selectedAction ? `${formatAction(run.selectedAction)} selected` : "Latest Decision Agent run"}</h2>
        <div className="hive-brain-who">
          {run.model || "model unknown"} · {run.shadow ? "shadow" : "active"} · {formatTime(run.startedAt)}
        </div>
        <p>{decisionSummary(detail)}</p>
        <p>{decisionResult(detail)}</p>
        <div className="hive-brain-stat-row">
          {chips.map((chip) => <span className="hive-brain-pill" key={chip}>{chip}</span>)}
        </div>
        <div className="hive-brain-actions">
          <span className="hive-brain-action-label">Decision space</span>
          {decisionActions.map((item) => (
            <span className={`hive-brain-action ${item === run.selectedAction ? "is-chosen" : ""}`} key={item}>
              {formatAction(item)}{item === run.selectedAction ? " ✓" : ""}
            </span>
          ))}
        </div>
        {options.length > 0 && (
          <div className="hive-brain-option-strip">
            {options.slice(0, 4).map((option, index) => (
              <article key={`${option.action || "option"}-${index}`}>
                <strong>{formatAction(option.action || `Option ${index + 1}`)}</strong>
                <span>{option.summary || option.rejectedBecause || "No option summary recorded."}</span>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DecisionLog({ runs = [], selectedRunId = "", onSelectRun }) {
  return (
    <div className="hive-brain-card hive-brain-pad hive-brain-log">
      <div className="hive-brain-section-label">Recent decisions</div>
      <div className="hive-brain-section-sub">Every Decision Agent action, auditable.</div>
      {runs.map((run) => (
        <button
          className={`hive-brain-log-row ${selectedRunId === run.id ? "is-active" : ""}`}
          key={run.id}
          onClick={() => onSelectRun(run.id)}
          type="button"
        >
          <span>{relativeTime(run.startedAt)}</span>
          <strong>{formatAction(run.selectedAction || run.status)}</strong>
          <em>{run.reasoningText || (run.guardrailResult?.blocked ? "blocked by guardrail" : run.status)}</em>
        </button>
      ))}
      {!runs.length && <div className="hive-brain-empty">No Decision Agent runs have been recorded yet.</div>}
    </div>
  );
}

function LiveTaskTable({ projectDocument = null, status = "loading" }) {
  const tasks = useMemo(() => flattenLiveTasks(projectDocument), [projectDocument]);
  return (
    <div className="hive-brain-card">
      <div className="hive-brain-table-head">
        <div className="hive-brain-section-label">Live task status</div>
        <div className="hive-brain-section-sub">Real-time task rows from the Hive project document.</div>
      </div>
      <div className="hive-brain-table-wrap">
        <table className="hive-brain-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Operative</th>
              <th>Project</th>
              <th>Status</th>
              <th className="is-num">Reward</th>
              <th className="is-num">When</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id || task.taskId}>
                <td>{task.title || task.taskId || "Untitled task"}</td>
                <td>{task.assigneeHandle || task.assigneeDisplayName || task.assignee || "Unassigned"}</td>
                <td className="is-muted">{task.project}</td>
                <td><Status type={task.state}>{formatAction(task.state)}</Status></td>
                <td className="is-pft">{compactNumber(task.pft)}</td>
                <td className="is-num is-muted">{task.age || relativeTime(task.updatedAt || task.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {status === "loading" && <div className="hive-brain-empty">Loading live task status.</div>}
        {status === "error" && <div className="hive-brain-empty">Live task status is unavailable.</div>}
        {status === "ready" && !tasks.length && <div className="hive-brain-empty">No live task rows are available.</div>}
      </div>
    </div>
  );
}

function ReportsGrid({ latestByType, onOpenReport }) {
  return (
    <div>
      <div className="hive-brain-section-label">Reports & generations</div>
      <div className="hive-brain-section-sub">Six human-readable reports feed the Decision Agent. Click any report to read it.</div>
      <div className="hive-brain-report-grid">
        {reportTabs.map((tab) => {
          const report = latestByType.get(tab.type);
          return (
            <button className="hive-brain-report-card" key={tab.id} onClick={() => onOpenReport(tab.id)} type="button">
              <div className="hive-brain-report-card-top">
                <span>{tab.title}</span>
                <Badge variant={report ? "gray" : "red"}>{report ? tab.cad : "missing"}</Badge>
              </div>
              <div className="hive-brain-report-take">
                {report ? reportExcerpt(report) : "No report generated yet."}
              </div>
              <div className="hive-brain-report-foot">
                <span>{report ? `Updated ${relativeTime(report.generatedAt)}` : "Not generated"}</span>
                <strong>Open →</strong>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OverviewPanel({
  decisionDetail,
  decisionLoading,
  latestByType,
  onOpenReport,
  projectDocument,
  projectStatus,
  runs,
  selectedRunId,
  onSelectRun,
}) {
  return (
    <section className="hive-brain-panel">
      <div className="hive-brain-stack">
        <DecisionCard detail={decisionDetail} loading={decisionLoading} />
        <div className="hive-brain-grid2">
          <DecisionLog runs={runs} selectedRunId={selectedRunId} onSelectRun={onSelectRun} />
          <div className="hive-brain-card hive-brain-pad">
            <div className="hive-brain-section-label">Board discussion → decisions</div>
            <div className="hive-brain-section-sub">Live operator context is now consumed through reports, not raw JSON packets.</div>
            <p className="hive-brain-body-copy">
              Hive Brain shows the decision layer in plain English: the latest report set, the Decision Agent action,
              guardrail result, and the live task state it is routing against.
            </p>
            <div className="hive-brain-tag-row">
              <span>Reports first</span>
              <span>Guarded actions</span>
              <span>No raw packet view</span>
            </div>
          </div>
        </div>
        <LiveTaskTable projectDocument={projectDocument} status={projectStatus} />
        <ReportsGrid latestByType={latestByType} onOpenReport={onOpenReport} />
      </div>
    </section>
  );
}

function VerificationPipe({ detail }) {
  const verifications = safeArray(detail?.verifications);
  const phases = verifications.length
    ? verifications.slice(0, 3).map((verification, index) => ({
        number: index + 1,
        title: verification.phase || `Phase ${index + 1}`,
        meta: verification.agent || "verification agent",
        stamp: verification.verifiedAt ? `Recorded ${relativeTime(verification.verifiedAt)}` : "Recorded",
      }))
    : [
        { number: 1, title: "Initial report", meta: "Human-readable markdown generated from live Hive data.", stamp: "Generated" },
        { number: 2, title: "Agent verification", meta: "Verifier output is recorded when available.", stamp: "Pending" },
        { number: 3, title: "Final report", meta: "Report feeds the Decision Agent.", stamp: "Active" },
      ];
  return (
    <div className="hive-brain-pipe">
      {phases.map((phase) => (
        <div className="hive-brain-step" key={`${phase.number}-${phase.title}`}>
          <span>{phase.number}</span>
          <strong>{phase.title}</strong>
          <small>{phase.meta}</small>
          <em>{phase.stamp}</em>
        </div>
      ))}
    </div>
  );
}

function ReportPanel({ detail, loading, tab }) {
  const report = detail?.report || {};
  return (
    <section className="hive-brain-panel">
      <div className="hive-brain-panel-head">
        <h2>{tab.title}</h2>
        <div>
          <Badge variant="gray">Every {tab.cadence}</Badge>
          <span>Generated {report.generatedAt ? relativeTime(report.generatedAt) : "unknown"}</span>
          <span>{report.bodyBytes ? `${formatBytes(report.bodyBytes)} markdown` : "markdown report"}</span>
        </div>
      </div>
      <VerificationPipe detail={detail} />
      <div className="hive-brain-card hive-brain-report-document">
        {loading && !detail ? (
          <div className="hive-brain-empty">Loading report detail.</div>
        ) : detail?.ok ? (
          <>
            <div className="hive-brain-table-head">
              <div className="hive-brain-section-label">Final report → Decision Agent</div>
              <div className="hive-brain-section-sub">{report.model || "model unknown"} · {formatTime(report.generatedAt)}</div>
            </div>
            <MarkdownReportBody markdown={report.bodyMarkdown || ""} />
          </>
        ) : (
          <div className="hive-brain-empty">No {tab.title.toLowerCase()} is available yet.</div>
        )}
      </div>
    </section>
  );
}

export function HiveBrainView() {
  const [activeTab, setActiveTab] = useState("overview");
  const [reports, setReports] = useState([]);
  const [reportDetail, setReportDetail] = useState(null);
  const [reportStatus, setReportStatus] = useState("loading");
  const [reportDetailStatus, setReportDetailStatus] = useState("idle");
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [decisionDetail, setDecisionDetail] = useState(null);
  const [decisionDetailStatus, setDecisionDetailStatus] = useState("idle");
  const [projectDocument, setProjectDocument] = useState(null);
  const [projectStatus, setProjectStatus] = useState("loading");

  const latestByType = useMemo(() => {
    const entries = new Map();
    for (const report of reports) {
      if (report?.type && !entries.has(report.type)) entries.set(report.type, report);
    }
    return entries;
  }, [reports]);
  const activeReportTab = reportTabs.find((tab) => tab.id === activeTab) || null;
  const activeReport = activeReportTab ? latestByType.get(activeReportTab.type) : null;
  const readyTypeCount = reportTabs.filter((tab) => latestByType.has(tab.type)).length;
  const newestReport = reports[0] || null;
  const latestRun = runs[0] || {};
  const projectStats = projectDocument?.stats || {};

  const loadReports = useCallback(async () => {
    setReportStatus("loading");
    try {
      const result = await requestJson("/api/hive/reports?limit=60");
      if (!result.ok) throw new Error(result.body?.message || `Hive reports failed with HTTP ${result.status}`);
      setReports(result.body?.reports || []);
      setReportStatus("ready");
    } catch {
      setReports([]);
      setReportStatus("error");
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const result = await requestJson("/api/hive/decision/runs?limit=12&action=all");
      if (!result.ok) throw new Error(result.body?.message || `Decision Agent runs failed with HTTP ${result.status}`);
      const nextRuns = result.body?.runs || [];
      setRuns(nextRuns);
      setSelectedRunId((current) => current || nextRuns[0]?.id || "");
    } catch {
      setRuns([]);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectStatus("loading");
    try {
      const result = await requestJson("/api/hive/projects");
      if (!result.ok) throw new Error(result.body?.message || `Hive projects failed with HTTP ${result.status}`);
      setProjectDocument(result.body?.document || null);
      setProjectStatus("ready");
    } catch {
      setProjectDocument(null);
      setProjectStatus("error");
    }
  }, []);

  const refreshAll = useCallback(() => {
    loadReports();
    loadRuns();
    loadProjects();
  }, [loadReports, loadProjects, loadRuns]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!selectedRunId) {
      setDecisionDetail(null);
      return undefined;
    }
    let cancelled = false;
    setDecisionDetailStatus("loading");
    requestJson(`/api/hive/decision/run/${encodeURIComponent(selectedRunId)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `Decision Agent run failed with HTTP ${result.status}`);
        setDecisionDetail(result.body || null);
        setDecisionDetailStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setDecisionDetail(null);
          setDecisionDetailStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!activeReport?.id) {
      setReportDetail(null);
      return undefined;
    }
    let cancelled = false;
    setReportDetailStatus("loading");
    requestJson(`/api/hive/reports/${encodeURIComponent(activeReport.id)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `Hive report failed with HTTP ${result.status}`);
        setReportDetail(result.body || null);
        setReportDetailStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setReportDetail(null);
          setReportDetailStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeReport?.id]);

  const openTab = useCallback((tabId) => {
    setActiveTab(tabId);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <div className="route-scroll hive-route">
      <div className="hive-brain-page">
        <div className="hive-brain-toolbar">
          <span>Synced {newestReport ? relativeTime(newestReport.generatedAt) : "unknown"}</span>
          <button className="hive-brain-refresh" onClick={refreshAll} type="button">
            <RefreshCw size={13} strokeWidth={2.2} />
            Refresh
          </button>
        </div>

        <header className="hive-brain-head">
          <div>
            <div className="hive-brain-eyebrow"><span />Live · Auditable</div>
            <h1>Hive Brain</h1>
            <p>
              The decision layer for the network. Reports flow up from every role, the Decision Agent reads them,
              and routes work with every action shown in plain English.
            </p>
          </div>
          <div className="hive-brain-head-meta">
            <div>Decision Agent <b>{latestRun.startedAt ? `ran ${relativeTime(latestRun.startedAt)}` : "not loaded"}</b></div>
            <div>Latest action <b>{formatAction(latestRun.selectedAction || latestRun.status)}</b></div>
            <div>Report set <b>{readyTypeCount}/6 ready</b></div>
          </div>
        </header>

        <div className="hive-brain-kpis">
          <Kpi label="Report types" sub={reportStatus === "error" ? "load failed" : "primary inputs"} value={`${readyTypeCount}/6`} />
          <Kpi label="Recent reports" sub="loaded" value={reports.length} />
          <Kpi label="Active projects" sub={projectStatus === "error" ? "unavailable" : "routing boards"} value={projectStatus === "ready" ? projectStats.activeProjects || 0 : "—"} />
          <Kpi label="Open tasks" sub="live rows" value={projectStatus === "ready" ? projectStats.tasksInFlight || 0 : "—"} />
          <Kpi accent label="PFT routed" sub="project total" value={projectStatus === "ready" ? compactNumber(projectStats.pftRouted) : "—"} />
          <Kpi label="Decisions loaded" sub={latestRun.startedAt ? relativeTime(latestRun.startedAt) : "none"} value={runs.length} />
        </div>

        <nav className="hive-brain-tabs" aria-label="Hive Brain reports">
          {tabs.map((tab) => (
            <button
              className={`hive-brain-tab ${activeTab === tab.id ? "is-active" : ""}`}
              key={tab.id}
              onClick={() => openTab(tab.id)}
              type="button"
            >
              {tab.label}
              {tab.cadence && <span>{tab.cadence}</span>}
            </button>
          ))}
        </nav>

        {activeTab === "overview" ? (
          <OverviewPanel
            decisionDetail={decisionDetail}
            decisionLoading={decisionDetailStatus === "loading"}
            latestByType={latestByType}
            onOpenReport={openTab}
            onSelectRun={setSelectedRunId}
            projectDocument={projectDocument}
            projectStatus={projectStatus}
            runs={runs}
            selectedRunId={selectedRunId}
          />
        ) : (
          <ReportPanel
            detail={reportDetail}
            loading={reportDetailStatus === "loading"}
            tab={activeReportTab}
          />
        )}
      </div>
    </div>
  );
}
