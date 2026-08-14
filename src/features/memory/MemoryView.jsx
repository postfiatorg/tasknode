import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { requestJson } from "../../api";
import { isSignedInSession } from "../../session";
import "./memory.css";

function formatMemoryDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return "Pending";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function compactText(value = "", max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

export function MemoryView({ session }) {
  const [entries, setEntries] = useState([]);
  const [deepMemories, setDeepMemories] = useState([]);
  const [turnMemories, setTurnMemories] = useState([]);
  const [queueHealth, setQueueHealth] = useState(null);
  const [memoryCounts, setMemoryCounts] = useState(null);
  const [networkProfile, setNetworkProfile] = useState(null);
  const [networkStatus, setNetworkStatus] = useState("idle");
  const [networkMessage, setNetworkMessage] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [activeTab, setActiveTab] = useState("memory");
  const [reportOpen, setReportOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(false);
  const [companiesOpen, setCompaniesOpen] = useState(false);
  const [expandedEntries, setExpandedEntries] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleteStatus, setDeleteStatus] = useState("idle");
  const signedIn = isSignedInSession(session);
  const deepEntries = deepMemories.length > 0
    ? deepMemories
    : entries.filter((entry) => entry.kind === "deep_memory").slice(0, 3);
  const memoryEntries = turnMemories.length > 0
    ? turnMemories
    : entries.filter((entry) => entry.kind !== "deep_memory").slice(0, 36);
  const deepMemoryTotal = Number(memoryCounts?.deepMemoryTotal ?? deepEntries.length);
  const turnMemoryTotal = Number(memoryCounts?.turnMemoryTotal ?? memoryEntries.length);
  const failedJobCount =
    Number(queueHealth?.turnJobs?.failed || 0) +
    Number(queueHealth?.rewardedTaskJobs?.failed || 0) +
    Number(queueHealth?.deepJobs?.failed || 0);
  const deepTabCount = deepMemoryTotal + turnMemoryTotal;

  const loadNetworkProfile = useCallback(({ refresh = false } = {}) => {
    if (!signedIn) return undefined;
    let active = true;
    setNetworkStatus("loading");
    setNetworkMessage("");

    requestJson("/api/memory/network-task-profile", {
      method: refresh ? "POST" : "GET",
    })
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          throw new Error(result.body?.message || `Network task profile returned HTTP ${result.status}.`);
        }
        setNetworkProfile(result.body || null);
        setNetworkStatus("ready");
      })
      .catch((error) => {
        if (!active) return;
        setNetworkMessage(error?.message || "Network task profile is unavailable.");
        setNetworkStatus("error");
      });

    return () => {
      active = false;
    };
  }, [signedIn]);

  const loadMemory = useCallback((nextQuery = query) => {
    if (!signedIn) return undefined;
    let active = true;
    const search = String(nextQuery || "").trim();
    const params = new URLSearchParams({ limit: "100" });
    if (search) params.set("q", search);
    setStatus("loading");

    requestJson(`/api/memory?${params.toString()}`)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          throw new Error(result.body?.message || `Memory returned HTTP ${result.status}.`);
        }
        setEntries(result.body?.entries || []);
        setDeepMemories(result.body?.deepMemories || []);
        setTurnMemories(result.body?.memories || []);
        setQueueHealth(result.body?.queue || null);
        setMemoryCounts(result.body?.counts || null);
        setMessage("");
        setStatus("ready");
      })
      .catch((error) => {
        if (!active) return;
        setMessage(error?.message || "Memory is unavailable.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [query, signedIn]);

  const loadAll = useCallback(() => {
    loadMemory();
    loadNetworkProfile();
  }, [loadMemory, loadNetworkProfile]);

  const toggleEntry = useCallback((entryId) => {
    setExpandedEntries((current) => ({
      ...current,
      [entryId]: !current[entryId],
    }));
  }, []);

  const performDelete = useCallback(async () => {
    if (!confirmDelete) return;
    setDeleteStatus("loading");
    setActionMessage("");

    const payload = deletePayload(confirmDelete);
    const result = await requestJson("/api/memory", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!result.ok) {
      setDeleteStatus("error");
      setActionMessage(result.body?.message || `Memory delete returned HTTP ${result.status}.`);
      return;
    }

    setConfirmDelete(null);
    setDeleteStatus("idle");
    setExpandedEntries({});
    setActionMessage(result.body?.message || "Memory updated.");
    loadMemory(query);
    if (payload.action === "reset_network_profile") loadNetworkProfile();
  }, [confirmDelete, loadMemory, loadNetworkProfile, query]);

  useEffect(() => {
    if (!signedIn) return undefined;
    const handle = window.setTimeout(() => loadMemory(query), query.trim() ? 300 : 0);
    return () => window.clearTimeout(handle);
  }, [loadMemory, query, signedIn]);

  useEffect(() => loadNetworkProfile(), [loadNetworkProfile]);

  const emptyState = useMemo(() => {
    if (activeTab === "memory") {
      return !networkProfile && networkStatus !== "loading";
    }
    return deepEntries.length === 0 && memoryEntries.length === 0 && status !== "loading";
  }, [activeTab, deepEntries.length, memoryEntries.length, networkProfile, networkStatus, status]);

  if (!signedIn) {
    return (
      <div className="memory-view">
        <section className="memory-empty">
          <strong>Memory</strong>
          <p>Sign in to inspect what Task Node remembers for future chats and routing.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="memory-view">
      <header className="memory-header">
        <div>
          <h1>Memory</h1>
          <p>What the system remembers about you.</p>
        </div>
        <button className="memory-refresh" onClick={loadAll} type="button">
          <RefreshCw size={14} strokeWidth={1.8} />
          Refresh
        </button>
      </header>

      <div className="memory-tabs" role="tablist" aria-label="Memory views">
        <TabButton active={activeTab === "memory"} onClick={() => setActiveTab("memory")}>
          Memory
        </TabButton>
        <TabButton active={activeTab === "deep"} count={deepTabCount} onClick={() => setActiveTab("deep")}>
          Deep Memory
        </TabButton>
      </div>

      <div className="memory-search">
        <Search size={15} strokeWidth={1.75} />
        <input
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder={activeTab === "memory" ? "Search memory" : "Search deep memory"}
          type="search"
          value={query}
        />
      </div>

      {failedJobCount > 0 && (
        <div className="memory-status error" role="status">
          {failedJobCount} background memory job{failedJobCount === 1 ? "" : "s"} failed after retries.
          New chat memory may be missing until an operator requeues failed jobs.
        </div>
      )}

      {message && <div className="memory-status error">{message}</div>}
      {networkMessage && <div className="memory-status error">{networkMessage}</div>}
      {actionMessage && <div className={`memory-status${deleteStatus === "error" ? " error" : ""}`}>{actionMessage}</div>}
      {status === "loading" && activeTab === "deep" && deepTabCount === 0 && <div className="memory-status">Loading memory</div>}
      {networkStatus === "loading" && activeTab === "memory" && !networkProfile && <div className="memory-status">Loading memory</div>}

      {emptyState && !message && (
        <section className="memory-empty">
          <strong>{activeTab === "memory" ? "No diagnostic report yet" : "No deep memory yet"}</strong>
          <p>
            {activeTab === "memory"
              ? "Open Memory or refresh to queue the first generated report."
              : "Completed chat responses will appear here after background compression."}
          </p>
        </section>
      )}

      {activeTab === "memory" && (
        <div className="memory-tab-panel">
          <NetworkTaskProfilePanel
            companiesOpen={companiesOpen}
            contextOpen={contextOpen}
            onCompaniesToggle={() => setCompaniesOpen((value) => !value)}
            onContextToggle={() => setContextOpen((value) => !value)}
            onRefresh={() => loadNetworkProfile({ refresh: true })}
            onReportToggle={() => setReportOpen((value) => !value)}
            onReset={() => setConfirmDelete({ type: "reset_network_profile" })}
            profileState={networkProfile}
            reportOpen={reportOpen}
            status={networkStatus}
          />
        </div>
      )}

      {activeTab === "deep" && (
        <div className="memory-tab-panel">
          <div className="memory-tab-intro">
            <p>Summaries pulled from past conversations.</p>
          </div>

          {deepEntries.length > 0 && (
            <MemoryListSection
              actionLabel="Clear all"
              count={deepMemoryTotal}
              onAction={() => setConfirmDelete({ type: "clear_deep_memory" })}
              title="Deep Memory"
              visibleCount={deepEntries.length}
            >
              {deepEntries.map((entry) => (
                <MemoryCard
                  detail="deep"
                  entry={entry}
                  expanded={Boolean(expandedEntries[entry.id])}
                  key={entry.id}
                  onDelete={() => setConfirmDelete({ type: "entry", entry })}
                  onToggle={() => toggleEntry(entry.id)}
                />
              ))}
            </MemoryListSection>
          )}

          {memoryEntries.length > 0 && (
            <MemoryListSection
              actionLabel="Clear recent"
              count={turnMemoryTotal}
              onAction={() => setConfirmDelete({ type: "clear_turn_memory" })}
              title="Recent Memory"
              visibleCount={memoryEntries.length}
            >
              {memoryEntries.map((entry) => (
                <MemoryCard
                  detail="memory"
                  entry={entry}
                  expanded={Boolean(expandedEntries[entry.id])}
                  key={entry.id}
                  onDelete={() => setConfirmDelete({ type: "entry", entry })}
                  onToggle={() => toggleEntry(entry.id)}
                />
              ))}
            </MemoryListSection>
          )}
        </div>
      )}

      {confirmDelete && (
        <DeleteConfirmation
          deleteStatus={deleteStatus}
          intent={confirmDelete}
          onCancel={() => {
            setConfirmDelete(null);
            setDeleteStatus("idle");
          }}
          onConfirm={performDelete}
        />
      )}
    </div>
  );
}

function deletePayload(intent = {}) {
  if (intent.type === "entry") return { action: "delete_entry", id: intent.entry?.id || "" };
  if (intent.type === "clear_deep_memory") return { action: "clear_deep_memory" };
  if (intent.type === "clear_turn_memory") return { action: "clear_turn_memory" };
  if (intent.type === "reset_network_profile") return { action: "reset_network_profile" };
  return { action: "unknown" };
}

function TabButton({ active, children, count = null, onClick }) {
  return (
    <button
      aria-selected={active}
      className={`memory-tab-button${active ? " active" : ""}`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {children}
      {count !== null && <span>{count}</span>}
    </button>
  );
}

function NetworkTaskProfilePanel({
  companiesOpen,
  contextOpen,
  onCompaniesToggle,
  onContextToggle,
  onRefresh,
  onReportToggle,
  onReset,
  profileState,
  reportOpen,
  status,
}) {
  const profile = profileState?.profile || null;
  const output = profile?.output || {};
  const job = profileState?.job || null;
  const context = profileState?.networkContextInputs || {};
  const counts = context.counts || {};
  const pending = job && ["pending", "processing"].includes(String(job.status || ""));
  const currentFocus = Array.isArray(output.current_focus) ? output.current_focus.slice(0, 6) : [];
  const contribution = Array.isArray(output.primary_contribution_ability) ? output.primary_contribution_ability.slice(0, 6) : [];
  const domain = Array.isArray(output.domain_expertise) ? output.domain_expertise.slice(0, 10) : [];
  const hasDiagnosticSections = currentFocus.length > 0 || contribution.length > 0 || domain.length > 0;
  const reportMeta = profile?.completedAt
    ? formatMemoryDate(profile.completedAt)
    : pending ? "Queued" : "Not generated yet";

  return (
    <>
      <CollapsibleSection
        icon={<Sparkles size={15} strokeWidth={1.8} />}
        meta={reportMeta}
        onToggle={onReportToggle}
        open={reportOpen}
        title="Network Diagnostic Report"
      >
        {profile ? (
          <div className="memory-report-body">
            <div>
              <h2>{output.profile_title || "Network Task Profile"}</h2>
              <p>
                A compact routing profile generated from your Memory, Context, Profile,
                and current Task state.
              </p>
            </div>

            {hasDiagnosticSections ? (
              <div className="memory-profile-grid">
                <ProfileList title="Current focus" items={currentFocus} />
                <ProfileList title="Primary contribution" items={contribution} />
              </div>
            ) : (
              <p className="memory-muted">
                This report was generated with an older format. Refresh to create the current version.
              </p>
            )}

            {domain.length > 0 && (
              <div className="memory-companies">
                <button className="memory-text-button" onClick={onCompaniesToggle} type="button">
                  {companiesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  Companies where this profile applies
                  <span>{domain.length}</span>
                </button>
                {companiesOpen && (
                  <ul className="memory-bullets memory-company-list">
                    {domain.map((item, index) => <CompanyItem item={item} key={`${index}:${item}`} />)}
                  </ul>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="memory-report-body">
            <p className="memory-muted">
              {pending
                ? "A diagnostic report generation job is queued. The live inputs below are already current."
                : "Open Memory or refresh to queue the first generated report."}
            </p>
          </div>
        )}

        <div className="memory-section-footer">
          <button
            className="memory-refresh memory-profile-refresh"
            disabled={status === "loading"}
            onClick={onRefresh}
            type="button"
          >
            <RefreshCw size={14} strokeWidth={1.8} />
            Refresh report
          </button>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        icon={<Database size={15} strokeWidth={1.8} />}
        meta={`${counts.total || 0} inputs`}
        onToggle={onContextToggle}
        open={contextOpen}
        title="Network Context Inputs"
      >
        <p className="memory-muted">
          Live profile facts and task state used by the diagnostic report. This is not model output.
        </p>
        <pre className="memory-context-pre">{context.text || "No network context inputs are available for this account yet."}</pre>
      </CollapsibleSection>

      <div className="memory-reset-row">
        <div>
          <strong>Reset diagnostic report</strong>
          <p>Deletes generated reports and queued refreshes. Deep Memory is not affected.</p>
        </div>
        <button className="memory-danger-text" onClick={onReset} type="button">
          Reset
        </button>
      </div>
    </>
  );
}

function CollapsibleSection({ children, icon, meta, onToggle, open, title }) {
  return (
    <section className="memory-collapsible">
      <button className="memory-collapsible-trigger" onClick={onToggle} type="button">
        <span>
          {icon}
          <strong>{title}</strong>
          {meta && <em>{meta}</em>}
        </span>
        <ChevronDown className={open ? "" : "collapsed"} size={15} strokeWidth={1.8} />
      </button>
      {open && <div className="memory-collapsible-body">{children}</div>}
    </section>
  );
}

function ProfileList({ items, title }) {
  const values = items.map((item) => String(item || "").trim()).filter(Boolean);
  return (
    <section>
      <small>{title}</small>
      {values.length ? (
        <ul className="memory-bullets">
          {values.map((item, index) => <li key={`${title}:${index}:${item}`}>{item}</li>)}
        </ul>
      ) : (
        <p className="memory-muted">No signal yet.</p>
      )}
    </section>
  );
}

function CompanyItem({ item }) {
  const value = String(item || "").trim();
  const splitIndex = value.indexOf(":");
  if (splitIndex <= 0) return <li>{value}</li>;
  return (
    <li>
      <strong>{value.slice(0, splitIndex)}</strong>
      <span>{value.slice(splitIndex + 1)}</span>
    </li>
  );
}

function MemoryListSection({ actionLabel, children, count, onAction, title, visibleCount = count }) {
  const total = Math.max(0, Number(count || 0));
  const visible = Math.max(0, Number(visibleCount || 0));
  const summary = visible < total
    ? `Showing ${visible} of ${total} stored summaries`
    : `${total} stored summar${total === 1 ? "y" : "ies"}`;

  return (
    <section className="memory-list-section">
      <div className="memory-list-heading">
        <div>
          <h2>{title}</h2>
          <p>{summary}</p>
        </div>
        {total > 0 && (
          <button className="memory-danger-text" onClick={onAction} type="button">
            {actionLabel}
          </button>
        )}
      </div>
      <ul className="memory-card-list">
        {children}
      </ul>
    </section>
  );
}

function MemoryCard({ detail, entry, expanded, onDelete, onToggle }) {
  const deepMemory = detail === "deep";
  const summary = deepMemory
    ? entry.memoryText || entry.userRequestSummary || entry.conversationTitle
    : entry.memoryText || entry.userRequestSummary;

  return (
    <li className="memory-card">
      <div className="memory-card-main">
        <button className="memory-card-copy" onClick={onToggle} type="button">
          <span>
            <Clock3 size={13} strokeWidth={1.8} />
            {formatMemoryDate(entry.createdAt)}
          </span>
          <p>{compactText(summary, deepMemory ? 320 : 260)}</p>
        </button>
        <div className="memory-card-actions">
          <button aria-label="Delete memory" onClick={onDelete} title="Delete memory" type="button">
            <Trash2 size={14} strokeWidth={1.8} />
          </button>
          <button aria-label={expanded ? "Collapse memory" : "Expand memory"} onClick={onToggle} title={expanded ? "Collapse" : "Expand"} type="button">
            <ChevronDown className={expanded ? "expanded" : ""} size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="memory-card-detail">
          <DetailGroup label="User" text={entry.userRequestSummary} />
          <DetailGroup label="Assistant" text={entry.systemResponseSummary} />
          <DetailGroup label={deepMemory ? "Synthesis" : "Memory"} text={entry.memoryText} />
        </div>
      )}
    </li>
  );
}

function DetailGroup({ label, text }) {
  const value = String(text || "").trim();
  if (!value) return null;
  return (
    <section>
      <small>{label}</small>
      <MemoryText text={value} />
    </section>
  );
}

function MemoryText({ text }) {
  const value = String(text || "").trim();
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bulletLines = lines.filter((line) => line.startsWith("- "));

  if (bulletLines.length >= 2 && bulletLines.length === lines.length) {
    return (
      <ul className="memory-bullets">
        {bulletLines.map((line, index) => (
          <li key={`${index}:${line}`}>{line.slice(2).trim()}</li>
        ))}
      </ul>
    );
  }

  return <p>{value}</p>;
}

function DeleteConfirmation({ deleteStatus, intent, onCancel, onConfirm }) {
  const copy = deleteCopy(intent);
  return (
    <div className="memory-modal-backdrop" onClick={onCancel} role="presentation">
      <div className="memory-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="memory-delete-title">
        <div className="memory-modal-head">
          <div>
            <h2 id="memory-delete-title">{copy.title}</h2>
            <p>{copy.body}</p>
          </div>
          <button aria-label="Close delete confirmation" onClick={onCancel} type="button">
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>
        <div className="memory-modal-actions">
          <button className="memory-cancel-button" disabled={deleteStatus === "loading"} onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="memory-confirm-button" disabled={deleteStatus === "loading"} onClick={onConfirm} type="button">
            {deleteStatus === "loading" ? "Working" : copy.action}
          </button>
        </div>
      </div>
    </div>
  );
}

function deleteCopy(intent = {}) {
  if (intent.type === "clear_deep_memory") {
    return {
      title: "Clear all deep memories?",
      body: "All deep memory summaries will be permanently removed. Recent Memory is not affected.",
      action: "Clear all",
    };
  }
  if (intent.type === "clear_turn_memory") {
    return {
      title: "Clear recent memories?",
      body: "All recent turn memories will be permanently removed. Deep Memory is not affected.",
      action: "Clear recent",
    };
  }
  if (intent.type === "reset_network_profile") {
    return {
      title: "Reset diagnostic report?",
      body: "Generated diagnostic reports and queued refreshes will be deleted. Deep Memory is not affected.",
      action: "Reset",
    };
  }
  return {
    title: "Delete this memory?",
    body: "This memory will be permanently removed. This action cannot be undone.",
    action: "Delete",
  };
}
