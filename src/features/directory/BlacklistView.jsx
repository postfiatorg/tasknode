import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { requestJson } from "../../api";
import { formatCompactPft } from "../hive/HiveView.jsx";
import "./directory.css";

const REASON_LABELS = {
  value_accountability_rejected: "No checkable contribution",
  value_accountability_refused: "Refused value check",
  value_accountability_deadline_missed: "No response to value check",
  operator_blacklist: "Operator decision",
};

function reasonLabel(code = "") {
  return REASON_LABELS[code] || code.replace(/_/g, " ");
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function BlacklistView() {
  const [status, setStatus] = useState("loading");
  const [document, setDocument] = useState({ entries: [], policy: "", count: 0 });

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const result = await requestJson("/api/directory/blacklist");
      setDocument({ entries: result.entries || [], policy: result.policy || "", count: result.count || 0 });
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="directory-view" aria-labelledby="blacklist-title">
      <header className="directory-header">
        <div>
          <h1 id="blacklist-title">Blacklist</h1>
          <p className="directory-subtitle">{document.policy}</p>
        </div>
        <button type="button" className="icon-button" onClick={load} aria-label="Refresh blacklist">
          <RefreshCw size={16} strokeWidth={1.75} />
        </button>
      </header>
      {status === "loading" && <div className="directory-empty">Loading blacklist.</div>}
      {status === "error" && <div className="directory-empty">The blacklist could not be loaded.</div>}
      {status === "ready" && document.entries.length === 0 && (
        <div className="directory-empty">No accounts are blacklisted.</div>
      )}
      {status === "ready" && document.entries.length > 0 && (
        <div className="directory-table-wrap">
          <table className="directory-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Reason</th>
                <th scope="col">Flagged tasks</th>
                <th scope="col">Flagged PFT</th>
                <th scope="col">Since</th>
              </tr>
            </thead>
            <tbody>
              {document.entries.map((entry) => (
                <tr key={`${entry.handle}-${entry.blacklisted_at}`}>
                  <td>{entry.handle}</td>
                  <td title={entry.reason}>{reasonLabel(entry.reason_code)}</td>
                  <td>{entry.flagged_task_count || "—"}</td>
                  <td>{entry.flagged_pft ? formatCompactPft(entry.flagged_pft) : "—"}</td>
                  <td>{formatDate(entry.blacklisted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
