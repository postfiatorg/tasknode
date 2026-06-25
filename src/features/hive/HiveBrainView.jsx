import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Brain, ChevronDown, ChevronRight, FileText, RefreshCw, Search } from "lucide-react";
import { requestJson } from "../../api";
import "./hive.css";

const actionOptions = [
  { value: "all", label: "All actions" },
  { value: "do_nothing", label: "Do nothing" },
  { value: "initiate_network_task", label: "Initiate task" },
  { value: "message_user", label: "Message user" },
  { value: "create_project", label: "Create project" },
  { value: "error", label: "Errors" },
];

const reportTypeOptions = [
  { value: "", label: "All reports" },
  { value: "operative", label: "Operative" },
  { value: "rewarded_task", label: "Rewarded Task" },
  { value: "kol", label: "KOL" },
  { value: "development", label: "Development" },
  { value: "qa", label: "QA" },
  { value: "executive", label: "Executive" },
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

function displayAction(run = {}) {
  if (run.error || run.status === "failed") return "error";
  return run.selectedAction || "pending";
}

function JsonBlock({ value }) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return <pre className="hive-brain-json">{text || "null"}</pre>;
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

function HighlightChips({ highlights = {} }) {
  const chips = [
    ["requiresAction", highlights.requiresAction],
    ["motionState", highlights.motionState],
    ["eligibleCandidateCount", highlights.eligibleCandidateCount],
    ["projectsWithoutLiveTasks", highlights.projectsWithoutLiveTasks],
    ["outstandingNetworkTaskCount", highlights.outstandingNetworkTaskCount],
    ["openFollowupCount", highlights.openFollowupCount],
  ];
  return (
    <div className="hive-brain-chips">
      {chips.map(([label, value]) => (
        <span className="hive-brain-chip" key={label}>
          <small>{label}</small>
          <strong>{String(value ?? "unknown")}</strong>
        </span>
      ))}
    </div>
  );
}

function Timeline({ loading, onSelect, runs = [], selectedRunId = "" }) {
  if (loading && !runs.length) {
    return <div className="hive-card hive-brain-empty">Loading Board Manager runs.</div>;
  }
  if (!runs.length) {
    return <div className="hive-card hive-brain-empty">No Board Manager runs match this filter.</div>;
  }
  return (
    <div className="hive-brain-timeline" role="list">
      {runs.map((run) => (
        <button
          className={`hive-brain-run ${selectedRunId === run.id ? "is-active" : ""}`}
          key={run.id}
          onClick={() => onSelect(run.id)}
          type="button"
        >
          <span className="hive-brain-run-time">{formatTime(run.startedAt || run.createdAt)}</span>
          <strong>{displayAction(run)}</strong>
          <small>{formatBytes(run.sourcePacketBytes)} packet · {run.status}</small>
          {run.error && <em>{run.error}</em>}
        </button>
      ))}
    </div>
  );
}

function LiveOutputPanel({ live = {}, status = "connecting" }) {
  const run = live.run || {};
  return (
    <section className="hive-section">
      <div className="hive-section-heading">
        <div>
          <h2>Live Output</h2>
          <p>Real-time Board Manager model output from the current or latest run.</p>
        </div>
      </div>
      <div className="hive-brain-live-panel">
        <div className="hive-brain-live-meta">
          <span>{status}</span>
          <strong>{run.id || run.runId || "no active run"}</strong>
          <small>{run.status || "idle"} · {formatBytes(run.outputBytes)}</small>
        </div>
        <pre>{run.outputText || "Waiting for Board Manager output."}</pre>
      </div>
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
      const params = new URLSearchParams({ limit: "18" });
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

  return (
    <section className="hive-section">
      <div className="hive-section-heading">
        <div>
          <h2>Reports</h2>
          <p>Human-readable Hive v2 reports. These are stored markdown documents, not JSON packets.</p>
        </div>
        <FileText size={18} strokeWidth={1.8} />
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

function SourcePacketSection({ detail }) {
  return (
    <CollapsibleSection defaultOpen number="01" subtitle={`${formatBytes(detail?.run?.sourcePacketBytes)} source packet`} title="Source Packet">
      <HighlightChips highlights={detail?.highlights || {}} />
      <div className="hive-brain-grid">
        <div>
          <h3>Projects and tasks</h3>
          <JsonBlock value={detail?.sourceSections?.projectsAndTasks || {}} />
        </div>
        <div>
          <h3>Candidate rows and badges</h3>
          <JsonBlock value={detail?.sourceSections?.candidateRows || {}} />
        </div>
        <div>
          <h3>Hive context and directives</h3>
          <JsonBlock value={detail?.sourceSections?.hiveContext || {}} />
        </div>
        <div>
          <h3>Recent runs and badge eligibility</h3>
          <JsonBlock
            value={{
              recentRuns: detail?.sourceSections?.recentRuns || [],
              badgeEligibility: detail?.sourceSections?.badgeEligibility || {},
            }}
          />
        </div>
      </div>
      <details className="hive-brain-raw">
        <summary>Full source packet JSON</summary>
        <JsonBlock value={detail?.sourcePacket || {}} />
      </details>
    </CollapsibleSection>
  );
}

function RunDetail({ detail, loading }) {
  if (loading && !detail) return <div className="hive-card hive-brain-empty">Loading run detail.</div>;
  if (!detail?.ok) return <div className="hive-card hive-brain-empty">Select a Board Manager run to inspect.</div>;
  return (
    <>
      <SourcePacketSection detail={detail} />
      <CollapsibleSection defaultOpen number="02" subtitle={detail.secretaryReport?.status || "secretary packet"} title="Secretary Report">
        <JsonBlock
          value={{
            metadata: {
              id: detail.secretaryReport?.id,
              sourceDigest: detail.secretaryReport?.sourceDigest,
              packetDigest: detail.secretaryReport?.packetDigest,
              provider: detail.secretaryReport?.provider,
              model: detail.secretaryReport?.model,
              createdAt: detail.secretaryReport?.createdAt,
              usage: detail.secretaryReport?.usage,
            },
            packetJson: detail.secretaryReport?.packetJson || {},
            packetText: detail.secretaryReport?.packetText || "",
          }}
        />
      </CollapsibleSection>
      <CollapsibleSection defaultOpen number="03" subtitle={detail.decision?.selectedAction || "no action"} title="Decision">
        <JsonBlock value={detail.decision || {}} />
      </CollapsibleSection>
      <CollapsibleSection defaultOpen number="04" subtitle={`${detail.result?.status || "unknown"} · ${detail.result?.durationMs || 0}ms`} title="Result">
        <JsonBlock value={detail.result || {}} />
      </CollapsibleSection>
    </>
  );
}

export function HiveBrainView() {
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [detail, setDetail] = useState(null);
  const [action, setAction] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [queryText, setQueryText] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [listStatus, setListStatus] = useState("loading");
  const [detailStatus, setDetailStatus] = useState("idle");
  const [live, setLive] = useState({ run: null });
  const [liveStatus, setLiveStatus] = useState("connecting");
  const [accessError, setAccessError] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPage(1);
      setQueryText(searchText.trim());
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchText]);

  const loadRuns = useCallback(async () => {
    setListStatus("loading");
    try {
      const params = new URLSearchParams({
        limit: "24",
        page: String(page),
        action,
      });
      if (queryText) params.set("q", queryText);
      const result = await requestJson(`/api/hive/brain/runs?${params.toString()}`);
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) setAccessError(result.body?.message || "Operator access required.");
        throw new Error(result.body?.message || `Hive Brain runs failed with HTTP ${result.status}`);
      }
      const nextRuns = result.body?.runs || [];
      setRuns(nextRuns);
      setHasMore(Boolean(result.body?.hasMore));
      setListStatus("ready");
      setAccessError("");
      setSelectedRunId((current) => current || nextRuns[0]?.id || "");
    } catch {
      setListStatus("error");
    }
  }, [action, page, queryText]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    setDetailStatus("loading");
    requestJson(`/api/hive/brain/run/${encodeURIComponent(selectedRunId)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `Hive Brain run failed with HTTP ${result.status}`);
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

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.EventSource !== "function") {
      setLiveStatus("unavailable");
      return undefined;
    }
    const source = new window.EventSource("/api/hive/brain/live");
    const applySnapshot = (event) => {
      try {
        const body = JSON.parse(event.data);
        setLive(body);
        setLiveStatus("connected");
      } catch {
        setLiveStatus("error");
      }
    };
    const applyDelta = (event) => {
      try {
        const body = JSON.parse(event.data);
        setLive((current) => {
          const currentRun = current?.run || {};
          if ((currentRun.id || currentRun.runId || "") !== body.runId) {
            return {
              run: {
                id: body.runId,
                runId: body.runId,
                status: "running",
                outputText: body.delta || "",
                outputBytes: body.outputBytes || 0,
                updatedAt: body.updatedAt || "",
              },
            };
          }
          return {
            ...current,
            run: {
              ...currentRun,
              outputText: `${currentRun.outputText || ""}${body.delta || ""}`,
              outputBytes: body.outputBytes || 0,
              updatedAt: body.updatedAt || currentRun.updatedAt,
            },
          };
        });
        setLiveStatus("connected");
      } catch {
        setLiveStatus("error");
      }
    };
    source.addEventListener("snapshot", applySnapshot);
    source.addEventListener("run_status", applySnapshot);
    source.addEventListener("run_started", applySnapshot);
    source.addEventListener("run_completed", applySnapshot);
    source.addEventListener("run_failed", applySnapshot);
    source.addEventListener("output_delta", applyDelta);
    source.onerror = () => setLiveStatus("disconnected");
    return () => source.close();
  }, []);

  const latestRun = useMemo(() => runs[0] || null, [runs]);
  const listLoading = listStatus === "loading";

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
            <p>Read-only audit trail for Board Manager source packets, secretary reasoning, decisions, execution results, and live model output.</p>
          </div>
          <div className="hive-stats">
            <div className="hive-stat">
              <span>Latest</span>
              <strong>{latestRun ? formatTime(latestRun.startedAt || latestRun.createdAt) : "—"}</strong>
            </div>
            <div className="hive-stat">
              <span>Action</span>
              <strong>{latestRun ? displayAction(latestRun) : "—"}</strong>
            </div>
          </div>
        </header>

        {accessError && (
          <div className="hive-card hive-brain-access">
            <AlertTriangle size={16} strokeWidth={1.8} />
            <span>{accessError}</span>
          </div>
        )}

        <ReportsPanel />

        <section className="hive-section">
          <div className="hive-section-heading">
            <div>
              <h2>Run Timeline</h2>
              <p>Recent Board Manager runs. Search loads full packet/decision matches server-side.</p>
            </div>
          </div>
          <div className="hive-brain-controls">
            <label>
              <span>Filter</span>
              <select value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }}>
                {actionOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="hive-brain-search">
              <Search size={15} strokeWidth={1.8} />
              <input
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search run id, action, error, model output"
                type="search"
                value={searchText}
              />
            </label>
            <button className="hive-brain-icon-button" onClick={loadRuns} title="Refresh runs" type="button">
              <RefreshCw size={16} strokeWidth={1.8} />
            </button>
          </div>
          <Timeline loading={listLoading} onSelect={setSelectedRunId} runs={runs} selectedRunId={selectedRunId} />
          <div className="hive-brain-pagination">
            <button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} type="button">
              Previous
            </button>
            <span>Page {page}</span>
            <button disabled={!hasMore} onClick={() => setPage((value) => value + 1)} type="button">
              Next
            </button>
          </div>
        </section>

        <LiveOutputPanel live={live} status={liveStatus} />

        <section className="hive-section">
          <div className="hive-section-heading">
            <div>
              <h2>Run Inspect</h2>
              <p>{selectedRunId || "Select a run"} {detailStatus === "error" ? "· detail load failed" : ""}</p>
            </div>
            <Brain size={18} strokeWidth={1.8} />
          </div>
          <RunDetail detail={detail} loading={detailStatus === "loading"} />
        </section>
      </div>
    </div>
  );
}
