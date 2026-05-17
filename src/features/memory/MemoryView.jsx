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
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const signedIn = isSignedInSession(session);

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

  useEffect(() => loadMemory(), [loadMemory]);

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
        <button className="memory-refresh" onClick={() => loadMemory()} type="button">
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
      {status === "loading" && entries.length === 0 && <div className="memory-status">Loading memory</div>}
      {status !== "loading" && entries.length === 0 && !message && (
        <section className="memory-empty">
          <strong>No memory yet</strong>
          <p>Completed chat responses will appear here after background compression.</p>
        </section>
      )}

      {entries.length > 0 && (
        <div className="memory-list" aria-label="Chat memory records">
          {entries.map((entry) => (
            <MemoryRow entry={entry} key={entry.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryRow({ entry }) {
  const deepMemory = entry.kind === "deep_memory";

  return (
    <article className={`memory-row${deepMemory ? " is-deep-memory" : ""}`}>
      <div className="memory-row-meta">
        <span>
          <Clock3 size={13} strokeWidth={1.8} />
          {formatMemoryDate(entry.createdAt)}
        </span>
        <em>
          {deepMemory && <b>Deep memory</b>}
          {entry.conversationTitle || "New chat"}
        </em>
      </div>
      <section>
        <small>User request</small>
        <MemoryText text={entry.userRequestSummary} />
      </section>
      <section>
        <small>System response</small>
        <MemoryText text={entry.systemResponseSummary} />
      </section>
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
