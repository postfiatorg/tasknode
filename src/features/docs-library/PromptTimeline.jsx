import { useEffect, useState } from "react";
import { History, RefreshCw, X } from "lucide-react";
import { formatActiveTime, formatEventTime } from "./prompt-format";
import { readPromptHistory } from "./prompt-library";

const eventNames = {
  created: "Prompt created",
  version_saved: "Version saved",
  agent_edit: "Agent edited the prompt",
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

  const versionNumbers = new Map(
    events
      .filter((event) => event.kind === "version_saved")
      .reverse()
      .map((event, index) => [event.eventId, index + 1]),
  );
  const actor = (event) => (event.by === "agent" ? "your agent" : "you");
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
              <time dateTime={event.at}>{formatEventTime(event.at)}</time>
              {event.kind === "version_saved" ? (
                <>
                  <div className="prompt-version-row">
                    <strong>Version {versionNumbers.get(event.eventId)}</strong>
                    <small>saved by {actor(event)}</small>
                    <button
                      className="prompt-version-button"
                      type="button"
                      aria-expanded={selected === event.eventId}
                      onClick={() => setSelected(selected === event.eventId ? "" : event.eventId)}
                    >
                      {selected === event.eventId ? "Hide" : "Read"}
                    </button>
                  </div>
                  {selected === event.eventId && (
                    <pre className="prompt-saved-version" role="region" aria-label="Saved version text">
                      {event.text}
                    </pre>
                  )}
                </>
              ) : (
                <strong>
                  {event.kind === "created" ? `Prompt created by ${actor(event)}` : eventNames[event.kind] || "Prompt activity"}
                </strong>
              )}
              {event.kind === "edit_session" && <small>{formatActiveTime(event.activeSeconds)} of typing</small>}
              {event.kind === "tih_run" && (
                <small>
                  {event.before} → {event.after}
                </small>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
