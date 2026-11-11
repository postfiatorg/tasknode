import { useEffect, useState } from "react";
import { History, RefreshCw, X } from "lucide-react";
import { readPromptHistory } from "./prompt-library";

const eventNames = {
  created: "Prompt created",
  version_saved: "Version saved",
  agent_edit: "Agent edit",
  edit_session: "Editing session",
  tih_run: "Text improvement scores",
};

export function PromptTimeline({ documentId, libraryKey, onClose }) {
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    readPromptHistory(libraryKey, { signal: controller.signal })
      .then((history) => {
        if (!active) return;
        setEvents(history.filter((event) => event.documentId === documentId).reverse());
      })
      .catch(() => {
        if (active) setError("Could not unlock this prompt’s history. Refresh to retry.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [documentId, libraryKey, revision]);

  const version = events.find((event) => event.eventId === selected && event.kind === "version_saved");
  return (
    <aside className="prompt-timeline" aria-label="Prompt timeline">
      <header className="prompt-section-heading">
        <h2>
          <History size={16} />
          Prompt timeline
        </h2>
        <div className="prompt-timeline-actions">
          <button
            type="button"
            className="docs-refresh-button"
            aria-label="Refresh timeline"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={15} />
          </button>
          <button type="button" className="docs-refresh-button" aria-label="Close timeline" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </header>
      <p className="prompt-section-note">Your saved versions and activity, unlocked on this device.</p>
      {error && (
        <p className="docs-library-notice error" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Unlocking history…</p>}
      {!loading && !error && !events.length && <p>No activity yet. Save a version to keep its text here.</p>}
      {!error && (
        <ol className="prompt-timeline-events">
          {events.map((event) => (
            <li key={event.eventId}>
              <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
              {event.kind === "version_saved" ? (
                <button
                  className="prompt-version-button"
                  type="button"
                  aria-pressed={selected === event.eventId}
                  onClick={() => setSelected(event.eventId)}
                >
                  Read saved version
                </button>
              ) : (
                <strong>{eventNames[event.kind] || "Prompt activity"}</strong>
              )}
              {event.kind === "edit_session" && <small>{event.activeSeconds} active seconds</small>}
              {event.kind === "tih_run" && (
                <small>
                  {event.before} → {event.after}
                </small>
              )}
            </li>
          ))}
        </ol>
      )}
      {!error && version && (
        <section className="prompt-saved-version" aria-label="Saved version text">
          <h3>Saved version</h3>
          <time dateTime={version.at}>{new Date(version.at).toLocaleString()}</time>
          <pre>{version.text}</pre>
        </section>
      )}
    </aside>
  );
}
