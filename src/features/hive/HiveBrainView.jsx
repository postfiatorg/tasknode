import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { requestJson } from "../../api";
import "./hive.css";

// Hive Brain v2: a read-only window onto each board manager's terminal
// session. One reasoning stream per board, mirrored (secret-scrubbed) from
// the live PfTerminal tmux session. The old report/decision surfaces are
// retired; this is the audit view.

const BOARDS = [
  { id: "board_community_promotion", label: "Community & Promotion" },
  { id: "board_pf_terminal", label: "PF Terminal" },
  { id: "board_postfiat_l1v2", label: "PostfiatL1V2" },
  { id: "board_ai_l1_governance", label: "AI L1 Governance" },
  { id: "board_tasknode_fixes", label: "Task Node Fixes" },
  { id: "board_capital_markets", label: "Capital Markets" },
];

const POLL_MS = 30000;

export function HiveBrainView() {
  const [boardId, setBoardId] = useState(BOARDS[0].id);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id) => {
    setLoading(true);
    setError("");
    try {
      const data = await requestJson(`/api/hive/bm-transcript?board=${encodeURIComponent(id)}&limit=1`);
      setSnapshot(data?.snapshots?.[0] || null);
    } catch (loadError) {
      setError(loadError?.message || "transcript unavailable");
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(boardId);
    const timer = setInterval(() => load(boardId), POLL_MS);
    return () => clearInterval(timer);
  }, [boardId, load]);

  return (
    <div className="hive-view hive-brain-view">
      <header className="hive-header">
        <div>
          <h1>Hive Brain</h1>
          <p className="hive-subtitle">
            The live reasoning stream of each board manager agent. This is a
            read-only, secret-scrubbed mirror of the agent&apos;s terminal
            session — the network&apos;s audit view of how tasks are
            generated, reviewed, and rewarded.
          </p>
        </div>
        <button
          type="button"
          className="hive-refresh-button"
          onClick={() => load(boardId)}
          disabled={loading}
          aria-label="Refresh transcript"
        >
          <RefreshCw size={16} className={loading ? "hive-spin" : undefined} />
          Refresh
        </button>
      </header>

      <nav className="hive-brain-tabs" aria-label="Boards">
        {BOARDS.map((board) => (
          <button
            key={board.id}
            type="button"
            className={board.id === boardId ? "hive-brain-tab is-active" : "hive-brain-tab"}
            onClick={() => setBoardId(board.id)}
          >
            {board.label}
          </button>
        ))}
      </nav>

      {error ? <div className="hive-error">{error}</div> : null}

      {snapshot ? (
        <section className="hive-brain-transcript">
          <div className="hive-brain-meta">
            <span>{snapshot.session_name || boardId}</span>
            <span>
              captured {snapshot.captured_at ? new Date(snapshot.captured_at).toLocaleString() : "unknown"}
            </span>
          </div>
          <pre className="hive-brain-pre">{snapshot.content}</pre>
        </section>
      ) : !error ? (
        <div className="hive-brain-empty">
          No transcript yet for this board. The board manager session may be
          idle or not yet started; transcripts appear once the agent is
          running.
        </div>
      ) : null}
    </div>
  );
}
