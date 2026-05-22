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
  const [networkProfile, setNetworkProfile] = useState(null);
  const [networkStatus, setNetworkStatus] = useState("idle");
  const [networkMessage, setNetworkMessage] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const signedIn = isSignedInSession(session);
  const deepEntries = entries.filter((entry) => entry.kind === "deep_memory").slice(0, 3);
  const memoryEntries = entries.filter((entry) => entry.kind !== "deep_memory").slice(0, 36);

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

  useEffect(() => loadAll(), [loadAll]);

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

      {message && <div className="memory-status error">{message}</div>}
      {networkMessage && <div className="memory-status error">{networkMessage}</div>}
      {status === "loading" && entries.length === 0 && <div className="memory-status">Loading memory</div>}
      {status !== "loading" && networkStatus !== "loading" && entries.length === 0 && !message && !networkProfile && (
        <section className="memory-empty">
          <strong>No memory yet</strong>
          <p>Completed chat responses will appear here after background compression.</p>
        </section>
      )}

      {(entries.length > 0 || networkProfile) && (
        <div className="memory-sections" aria-label="Chat memory records">
          {networkProfile && (
            <>
              <NetworkTaskProfileCard
                onRefresh={() => loadNetworkProfile({ refresh: true })}
                profileState={networkProfile}
                status={networkStatus}
              />
              <NetworkContextInputs profileState={networkProfile} />
            </>
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
  const pending = job && ["pending", "processing"].includes(String(job.status || ""));
  const best = Array.isArray(output.best_task_types) ? output.best_task_types.slice(0, 5) : [];
  const avoid = Array.isArray(output.avoid_task_types) ? output.avoid_task_types.slice(0, 5) : [];
  const reasons = Array.isArray(output.routing_reasons) ? output.routing_reasons.slice(0, 5) : [];
  const caveats = Array.isArray(output.user_visible_caveats) ? output.user_visible_caveats.slice(0, 5) : [];

  return (
    <section className="memory-section network-profile-section">
      <div className="memory-section-header">
        <div>
          <h2>Generated Network Task Profile</h2>
          <p>Async routing profile generated from context, memory, profile, and task state.</p>
        </div>
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
              <small>Profile</small>
              <h3>{output.profile_title || "Network Task Profile"}</h3>
              <MemoryText text={output.routing_summary || profile.outputText} />
            </section>

            <div className="network-profile-grid">
              <ProfileList title="Best task types" items={best} />
              <ProfileList title="Avoid right now" items={avoid} />
              <ProfileList title="Routing reasons" items={reasons} />
              <ProfileList title="Caveats" items={caveats} />
            </div>

            <div className="network-profile-meta">
              <span>Capacity: {output.current_capacity_signal || "unknown"}</span>
              <span>Confidence: {output.confidence || "unknown"}</span>
              <span>Packet {String(profile.sourcePacketDigest || "").slice(0, 12) || "pending"}</span>
            </div>
          </>
        ) : (
          <section>
            <small>Profile</small>
            <p>
              {pending
                ? "A profile generation job is queued. Live task context below is already current."
                : "Open Memory or refresh to queue the first generated Network Task Profile."}
            </p>
          </section>
        )}

        <details className="network-source-packet">
          <summary>View source packet</summary>
          <pre>{source.text || "No source packet was built yet."}</pre>
        </details>
      </article>
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
        <p>No signal yet.</p>
      )}
    </section>
  );
}

function NetworkContextInputs({ profileState }) {
  const context = profileState?.networkContextInputs || {};
  const counts = context.counts || {};
  return (
    <MemorySection
      count={counts.total || 0}
      description="Real-time profile and task state inputs used for network routing."
      title="Network Context Inputs"
    >
      <article className="memory-row live-task-context">
        <pre>{context.text || "No network context inputs are available for this account yet."}</pre>
      </article>
    </MemorySection>
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
