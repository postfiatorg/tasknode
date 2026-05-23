import React, { useCallback, useEffect, useState } from "react";
import { Clock3, RefreshCw, Search } from "lucide-react";
import { requestJson } from "../../api";
import { isSignedInSession } from "../../session";
import "./memory.css";

function formatMemoryDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.valueOf())) return "Pending";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function MemoryView({ session }) {
  const [entries, setEntries] = useState([]);
  const [deepMemories, setDeepMemories] = useState([]);
  const [turnMemories, setTurnMemories] = useState([]);
  const [queueHealth, setQueueHealth] = useState(null);
  const [networkProfile, setNetworkProfile] = useState(null);
  const [networkStatus, setNetworkStatus] = useState("idle");
  const [networkMessage, setNetworkMessage] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const signedIn = isSignedInSession(session);
  const deepEntries = deepMemories.length > 0
    ? deepMemories
    : entries.filter((entry) => entry.kind === "deep_memory").slice(0, 3);
  const memoryEntries = turnMemories.length > 0
    ? turnMemories
    : entries.filter((entry) => entry.kind !== "deep_memory").slice(0, 36);
  const failedJobCount =
    Number(queueHealth?.turnJobs?.failed || 0) + Number(queueHealth?.deepJobs?.failed || 0);

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

  useEffect(() => {
    if (!signedIn) return undefined;
    const handle = window.setTimeout(() => loadMemory(query), query.trim() ? 300 : 0);
    return () => window.clearTimeout(handle);
  }, [loadMemory, query, signedIn]);

  useEffect(() => loadNetworkProfile(), [loadNetworkProfile]);

  if (!signedIn) {
    return (
      <div className="memory-view">
        <section className="memory-empty">
          <strong>Memory</strong>
          <p>Sign in to inspect compressed chat memory.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="memory-view">
      <header className="memory-header">
        <div>
          <small>More</small>
          <h1>Memory</h1>
        </div>
        <button className="memory-refresh" onClick={loadAll} type="button">
          <RefreshCw size={15} strokeWidth={1.8} />
          Refresh
        </button>
      </header>

      <div className="memory-search">
        <Search size={16} strokeWidth={1.75} />
        <input
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="Search memory"
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
      {status === "loading" && entries.length === 0 && <div className="memory-status">Loading memory</div>}
      {status !== "loading" && networkStatus !== "loading" && deepEntries.length === 0 && memoryEntries.length === 0 && !message && !networkProfile && (
        <section className="memory-empty">
          <strong>No memory yet</strong>
          <p>Completed chat responses will appear here after background compression.</p>
        </section>
      )}

      {(deepEntries.length > 0 || memoryEntries.length > 0 || networkProfile) && (
        <div className="memory-sections" aria-label="Chat memory records">
          {networkProfile && (
            <NetworkTaskProfileCard
              onRefresh={() => loadNetworkProfile({ refresh: true })}
              profileState={networkProfile}
              status={networkStatus}
            />
          )}

          {deepEntries.length > 0 && (
            <MemorySection
              count={deepEntries.length}
              description="Last 3 deep memories. These preserve user, assistant, and memory summaries."
              title="Deep Memory"
            >
              {deepEntries.map((entry) => (
                <MemoryRow detail="deep" entry={entry} key={entry.id} />
              ))}
            </MemorySection>
          )}

          {memoryEntries.length > 0 && (
            <MemorySection
              count={memoryEntries.length}
              description="Last 36 memory records. These show date and memory only."
              title="Memory"
            >
              {memoryEntries.map((entry) => (
                <MemoryRow detail="memory" entry={entry} key={entry.id} />
              ))}
            </MemorySection>
          )}
        </div>
      )}
    </div>
  );
}

function NetworkTaskProfileCard({ onRefresh, profileState, status }) {
  const profile = profileState?.profile || null;
  const output = profile?.output || {};
  const job = profileState?.job || null;
  const source = profileState?.sourcePacket || {};
  const context = profileState?.networkContextInputs || {};
  const counts = context.counts || {};
  const pending = job && ["pending", "processing"].includes(String(job.status || ""));
  const currentFocus = Array.isArray(output.current_focus) ? output.current_focus.slice(0, 6) : [];
  const contribution = Array.isArray(output.primary_contribution_ability) ? output.primary_contribution_ability.slice(0, 6) : [];
  const domain = Array.isArray(output.domain_expertise) ? output.domain_expertise.slice(0, 10) : [];
  const hasDiagnosticSections = currentFocus.length > 0 || contribution.length > 0 || domain.length > 0;

  return (
    <section className="memory-section network-profile-section">
      <div className="memory-section-header">
        <div>
          <h2>Network Diagnostic Report</h2>
          <p>Generated profile plus the live network context inputs it is built from.</p>
        </div>
        <div className="network-report-actions">
          <span>{counts.total || 0} task inputs</span>
          <button
            className="memory-refresh memory-profile-refresh"
            disabled={status === "loading"}
            onClick={onRefresh}
            type="button"
          >
            <RefreshCw size={14} strokeWidth={1.8} />
            Refresh
          </button>
        </div>
      </div>

      <article className="memory-row network-profile-card">
        <div className="memory-row-meta">
          <span>
            <Clock3 size={13} strokeWidth={1.8} />
            {profile?.completedAt ? `Generated ${formatMemoryDate(profile.completedAt)}` : pending ? `Queued ${formatMemoryDate(job.createdAt)}` : "Not generated yet"}
          </span>
          <em>
            <b>{pending ? job.status : profile ? "Profile" : "Pending"}</b>
            {profile?.model || "DeepSeek ZDR memory route"}
          </em>
        </div>

        {profile ? (
          <>
            <section>
              <small>Diagnostic report</small>
              <h3>{output.profile_title || "Network Task Profile"}</h3>
            </section>

            {hasDiagnosticSections ? (
              <div className="network-profile-grid">
                <ProfileList title="Current focus" items={currentFocus} />
                <ProfileList title="Primary contribution ability" items={contribution} />
                <ProfileList title="Companies this User Would Move the Needle At" items={domain} wide />
              </div>
            ) : (
              <p className="network-profile-stale">
                This profile was generated with an older format. Refresh to create the diagnostic report.
              </p>
            )}

            <div className="network-profile-meta">
              <span>{profile.promptVersion || "network_task_profile"}</span>
              <span>Packet {String(profile.sourcePacketDigest || "").slice(0, 12) || "pending"}</span>
            </div>
          </>
        ) : (
          <section>
            <small>Profile</small>
            <p>
              {pending
                ? "A profile generation job is queued. Network context inputs below are already current."
                : "Open Memory or refresh to queue the first generated Network Task Profile."}
            </p>
          </section>
        )}

        <section className="network-context-panel">
          <div className="network-context-heading">
            <div>
              <small>Network context inputs</small>
              <p>Live profile facts and task state used by the diagnostic report. This is not model output.</p>
            </div>
            <span>{counts.total || 0} shown</span>
          </div>
          <pre>{context.text || "No network context inputs are available for this account yet."}</pre>
        </section>

        <details className="network-source-packet">
          <summary>View full source packet</summary>
          <pre>{source.text || "No source packet was built yet."}</pre>
        </details>
      </article>
    </section>
  );
}

function ProfileList({ items, title, wide = false }) {
  const values = items.map((item) => String(item || "").trim()).filter(Boolean);
  return (
    <section className={wide ? "network-profile-wide" : ""}>
      <small>{title}</small>
      {values.length ? (
        <ul className="memory-bullets">
          {values.map((item, index) => <li key={`${title}:${index}:${item}`}>{item}</li>)}
        </ul>
      ) : (
        <p>No signal yet.</p>
      )}
    </section>
  );
}

function MemorySection({ children, count, description, title }) {
  return (
    <section className="memory-section">
      <div className="memory-section-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span>{count}</span>
      </div>
      <div className="memory-list">
        {children}
      </div>
    </section>
  );
}

function MemoryRow({ detail, entry }) {
  const deepMemory = detail === "deep";

  return (
    <article className={`memory-row${deepMemory ? " is-deep-memory" : ""}`}>
      <div className="memory-row-meta">
        <span>
          <Clock3 size={13} strokeWidth={1.8} />
          {formatMemoryDate(entry.createdAt)}
        </span>
        {deepMemory && (
          <em>
            <b>Deep memory</b>
            {entry.conversationTitle || "New chat"}
          </em>
        )}
      </div>
      {deepMemory && (
        <>
          <section>
            <small>User</small>
            <MemoryText text={entry.userRequestSummary} />
          </section>
          <section>
            <small>Assistant</small>
            <MemoryText text={entry.systemResponseSummary} />
          </section>
        </>
      )}
      <section>
        <small>Memory</small>
        <MemoryText text={entry.memoryText} />
      </section>
    </article>
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
