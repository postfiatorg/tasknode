import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Flag,
  Github,
  Paperclip,
  RefreshCw,
  X,
} from "lucide-react";
import { requestJson } from "../../api";
import { truncateCid } from "../context/context-view-utils.jsx";
import "./task-detail.css";

async function copyText(text) {
  const value = String(text || "");
  if (!value) return false;

  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back to a temporary textarea for browsers that block Clipboard API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  return copied;
}

function statusSlug(status = "") {
  return String(status || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function taskStatusColor(status) {
  return {
    Proposed: "#7a5a1f",
    Accepted: "#4a5934",
    Refused: "#7c3c2e",
    Rewarded: "#6e5223",
    "Verification requested": "#5b4b8a",
    "Verification submitted": "#4a5934",
  }[status] || "#3d3d38";
}

function TaskStatusGlyph({ status }) {
  if (status === "Refused") {
    return (
      <svg className="task-status-x" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
        <path d="M2 2 L9 9 M9 2 L2 9" strokeLinecap="round" />
      </svg>
    );
  }
  return <span className={`task-status-glyph is-${statusSlug(status)}`} aria-hidden="true" />;
}

function TaskSection({ children, last, title }) {
  return (
    <section className={last ? "task-section last" : "task-section"}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function TaskOverviewPanel({ displayTask, steps, verification }) {
  return (
    <>
      <div className="task-modal-divider" />
      <TaskSection title="Description">
        <p>{displayTask.description}</p>
      </TaskSection>
      {steps.length > 0 && (
        <TaskSection title="Steps">
          <ol>
            {steps.map((step, index) => (
              <li key={`${index}-${step}`}>
                <span>{index + 1}</span>
                <p>{step}</p>
              </li>
            ))}
          </ol>
        </TaskSection>
      )}
      <TaskSection last title="Verification">
        <strong>{verification.title || "Submit evidence"}</strong>
        <p>{verification.body || "Submit evidence that satisfies the task requirement."}</p>
      </TaskSection>
    </>
  );
}

function TaskSubmitPanel({ detail, loading, task, verification }) {
  const [method, setMethod] = useState("text");
  const [confirmed, setConfirmed] = useState(false);
  const [draft, setDraft] = useState({
    code: "",
    commit: "",
    fileName: "",
    notes: "",
    screenshot: "",
    text: "",
    url: "",
  });
  const actions = detail?.actions || {};
  const submissionOpen = Boolean(actions.canSubmitInitialEvidence || actions.canSubmitVerificationEvidence);
  const summaries = Array.isArray(detail?.submission?.summaries) ? detail.submission.summaries : [];
  const disabledReason = loading
    ? "Loading task projection state."
    : actions.submissionReason || "Live submission requires browser-side PFTL signing.";
  const methods = [
    { key: "text", label: "Text", icon: FileText },
    { key: "url", label: "URL", icon: ExternalLink },
    { key: "screenshot", label: "Screenshot", icon: Eye },
    { key: "code", label: "Code", icon: FileText },
    { key: "commit", label: "Commit", icon: Github },
    { key: "file", label: "File", icon: Paperclip },
  ];

  function updateDraft(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="task-submit-panel">
      <div className="task-submit-head">
        <div>
          <h3>{actions.canSubmitVerificationEvidence ? "Submit verification evidence" : "Submit task evidence"}</h3>
          <p>{verification.body || "Submit evidence that satisfies this task."}</p>
        </div>
        <span className={submissionOpen ? "task-submit-state is-open" : "task-submit-state"}>
          {submissionOpen ? "Open" : task.status}
        </span>
      </div>

      {summaries.length > 0 && (
        <div className="task-submission-history">
          <h4>Indexed submissions</h4>
          {summaries.map((summary, index) => (
            <p key={`${index}-${summary?.summary || summary?.type || "submission"}`}>
              <strong>{summary?.type || `Submission ${index + 1}`}</strong>
              {summary?.summary || summary?.description || "Submission indexed from PFTL replay."}
            </p>
          ))}
        </div>
      )}

      <div className="task-evidence-methods" role="tablist" aria-label="Evidence type">
        {methods.map(({ key, label, icon: Icon }) => (
          <button
            aria-selected={method === key}
            className={method === key ? "active" : ""}
            key={key}
            onClick={() => setMethod(key)}
            role="tab"
            type="button"
          >
            <Icon size={14} strokeWidth={1.85} />
            {label}
          </button>
        ))}
      </div>

      <div className="task-evidence-card">
        {method === "text" && (
          <label>
            Evidence body
            <textarea
              onChange={(event) => updateDraft("text", event.target.value)}
              placeholder="Describe the completed work and include any relevant artifact references."
              rows={7}
              value={draft.text}
            />
          </label>
        )}
        {method === "url" && (
          <label>
            Public URL
            <input
              onChange={(event) => updateDraft("url", event.target.value)}
              placeholder="https://..."
              type="url"
              value={draft.url}
            />
          </label>
        )}
        {method === "screenshot" && (
          <div className="task-file-drop">
            <Eye size={18} strokeWidth={1.75} />
            <label>
              Screenshot file
              <input
                accept="image/*"
                onChange={(event) => updateDraft("screenshot", event.target.files?.[0]?.name || "")}
                type="file"
              />
            </label>
            <span>{draft.screenshot || "No screenshot selected"}</span>
          </div>
        )}
        {method === "code" && (
          <label>
            Code sample
            <textarea
              className="task-code-input"
              onChange={(event) => updateDraft("code", event.target.value)}
              placeholder="Paste the relevant code or command output."
              rows={8}
              value={draft.code}
            />
          </label>
        )}
        {method === "commit" && (
          <label>
            Commit or PR URL
            <input
              onChange={(event) => updateDraft("commit", event.target.value)}
              placeholder="https://github.com/org/repo/commit/..."
              type="url"
              value={draft.commit}
            />
          </label>
        )}
        {method === "file" && (
          <div className="task-file-drop">
            <Paperclip size={18} strokeWidth={1.75} />
            <label>
              Evidence file
              <input
                onChange={(event) => updateDraft("fileName", event.target.files?.[0]?.name || "")}
                type="file"
              />
            </label>
            <span>{draft.fileName || "No file selected"}</span>
          </div>
        )}
        <label className="task-evidence-notes">
          Notes
          <textarea
            onChange={(event) => updateDraft("notes", event.target.value)}
            placeholder="Add context for the verifier."
            rows={3}
            value={draft.notes}
          />
        </label>
      </div>

      <label className="task-submit-confirm">
        <input
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          type="checkbox"
        />
        This evidence is ready to be published as a signed PFTL task submission.
      </label>
      <div className="task-inline-warning">
        <AlertTriangle size={15} strokeWidth={1.8} />
        <span>{disabledReason}</span>
      </div>
      <button className="dark-pill task-submit-button" disabled type="button">
        Publish signed evidence
        <ArrowRight size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

function TaskForensicsPanel({ copiedValue, detail, error, loading, onCopy }) {
  const forensics = detail?.forensics || {};
  const timeline = Array.isArray(forensics.timeline) ? forensics.timeline : [];
  const cids = Array.isArray(forensics.cids) ? forensics.cids : [];
  const transactions = Array.isArray(forensics.transactions) ? forensics.transactions : [];
  const reducerEvents = Array.isArray(forensics.reducerEvents) ? forensics.reducerEvents : [];

  if (loading) {
    return (
      <div className="task-empty-panel">
        <RefreshCw size={18} strokeWidth={1.8} />
        Loading indexed task events.
      </div>
    );
  }

  if (error) {
    return (
      <div className="task-empty-panel is-error">
        <AlertTriangle size={18} strokeWidth={1.8} />
        {error}
      </div>
    );
  }

  return (
    <div className="task-forensics-panel">
      <div className="task-forensics-summary">
        <TaskAuditValue label="Request bundle CID" name="request-cid" onCopy={onCopy} value={forensics.requestBundleCid} copiedValue={copiedValue} />
        <TaskAuditValue label="Context CID" name="context-cid" onCopy={onCopy} value={forensics.contextCid} copiedValue={copiedValue} />
        <TaskAuditValue label="Last transaction" name="last-tx" onCopy={onCopy} value={forensics.lastEventTxHash} copiedValue={copiedValue} />
      </div>

      <section className="task-forensics-section">
        <h3>Action timeline</h3>
        {timeline.length > 0 ? (
          <div className="task-forensics-list">
            {timeline.map((event, index) => (
              <TaskForensicsEvent
                copiedValue={copiedValue}
                event={event}
                index={index}
                key={event.id || `${event.schema}-${event.txHash}-${index}`}
                onCopy={onCopy}
              />
            ))}
          </div>
        ) : (
          <p className="task-forensics-empty">No pointer events were indexed for this task.</p>
        )}
      </section>

      <section className="task-forensics-section">
        <h3>CIDs</h3>
        <div className="task-audit-grid">
          {cids.map((entry) => (
            <TaskAuditValue
              copiedValue={copiedValue}
              key={`${entry.label}-${entry.cid}`}
              label={entry.label}
              name={`cid-${entry.label}`}
              onCopy={onCopy}
              value={entry.cid}
            />
          ))}
        </div>
      </section>

      <section className="task-forensics-section">
        <h3>Transactions</h3>
        <div className="task-audit-grid">
          {transactions.map((entry) => (
            <TaskAuditValue
              copiedValue={copiedValue}
              key={`${entry.label}-${entry.txHash}`}
              label={entry.label}
              name={`tx-${entry.label}`}
              onCopy={onCopy}
              value={entry.txHash}
            />
          ))}
        </div>
      </section>

      {reducerEvents.length > 0 && (
        <section className="task-forensics-section">
          <h3>Projection reducer</h3>
          <div className="task-reducer-events">
            {reducerEvents.map((event, index) => (
              <span key={event.id || `${event.schema}-${index}`}>
                {event.label}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function TaskForensicsEvent({ copiedValue, event, index, onCopy }) {
  return (
    <article className="task-forensics-row">
      <div className="task-forensics-index">{index + 1}</div>
      <div className="task-forensics-copy">
        <header>
          <strong>{event.label}</strong>
          <span>{event.schema}</span>
        </header>
        <TaskAuditValue label="CID" name={`event-cid-${index}`} onCopy={onCopy} value={event.cid} copiedValue={copiedValue} />
        <TaskAuditValue label="Transaction" name={`event-tx-${index}`} onCopy={onCopy} value={event.txHash} copiedValue={copiedValue} />
        {event.eventDigest && (
          <TaskAuditValue label="Digest" name={`event-digest-${index}`} onCopy={onCopy} value={event.eventDigest} copiedValue={copiedValue} />
        )}
      </div>
    </article>
  );
}

function TaskAuditValue({ copiedValue, label, name, onCopy, value }) {
  const text = String(value || "");
  if (!text) return null;
  return (
    <button className="task-audit-value" onClick={() => onCopy(name, text)} type="button">
      <span>{label}</span>
      <code title={text}>{truncateCid(text)}</code>
      {copiedValue === name ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
    </button>
  );
}

export function TaskDetailModal({ onClose, task }) {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [detailState, setDetailState] = useState({ data: null, error: "", loading: true });
  const [copiedValue, setCopiedValue] = useState("");
  const displayTask = detailState.data?.task || task;
  const steps = Array.isArray(displayTask.steps) ? displayTask.steps : [];
  const verification = displayTask.verification || {};
  const rewardPft = Number(displayTask.pft || 0);
  const taskId = displayTask.taskId || displayTask.fullId || task.taskId || task.fullId || task.id || "";
  const forensicsCount = detailState.data?.forensics?.timeline?.length || displayTask.metadata?.eventCount || 0;

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    let active = true;
    setDetailState({ data: null, error: "", loading: true });
    requestJson(`/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`)
      .then((result) => {
        if (!active) return;
        if (result.ok && result.body?.ok) {
          setDetailState({ data: result.body, error: "", loading: false });
        } else {
          setDetailState({
            data: null,
            error: result.body?.message || "Task detail is not available for this linked wallet.",
            loading: false,
          });
        }
      })
      .catch(() => {
        if (!active) return;
        setDetailState({
          data: null,
          error: "Task detail could not be loaded.",
          loading: false,
        });
      });
    return () => {
      active = false;
    };
  }, [taskId]);

  async function copyTaskValue(label, value) {
    const ok = await copyText(value);
    if (!ok) return;
    setCopiedValue(label);
    window.setTimeout(() => setCopiedValue((current) => (current === label ? "" : current)), 1400);
  }

  return (
    <div className="task-modal-layer">
      <div
        className={`task-modal-wash${mounted ? " is-mounted" : ""}`}
        onClick={onClose}
        role="presentation"
      />
      <section
        className={`task-modal${mounted ? " is-mounted" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-title"
      >
        <header className="task-modal-header">
          <div className="task-modal-kicker">
            <Flag size={12} strokeWidth={1.75} />
            {displayTask.kind}
          </div>
          <button className="task-modal-close" onClick={onClose} type="button">
            <X size={14} strokeWidth={1.75} />
            Close
          </button>
        </header>
        <div className="task-modal-body">
          <h2 id="task-title">{displayTask.title}</h2>
          <button
            className="task-id-link"
            onClick={() => copyTaskValue("task-id", taskId)}
            type="button"
          >
            {taskId}
            {copiedValue === "task-id" ? <Check size={11} strokeWidth={1.75} /> : <Copy size={11} strokeWidth={1.75} />}
          </button>
          <div className="task-modal-stats">
            <div>
              <small>Status</small>
              <span className="task-status-inline">
                <TaskStatusGlyph status={displayTask.status} />
                <strong style={{ color: taskStatusColor(displayTask.status) }}>{displayTask.status}</strong>
              </span>
            </div>
            <div>
              <small>Deadline</small>
              <span>{displayTask.fullDue}</span>
            </div>
            <div>
              <small>Reward</small>
              <span className="task-modal-reward">
                {rewardPft.toLocaleString()}
                <em>PFT</em>
              </span>
            </div>
            <div>
              <small>Indexed events</small>
              <span>{forensicsCount.toLocaleString()}</span>
            </div>
          </div>
          <div className="task-modal-tabs" role="tablist" aria-label="Task detail sections">
            {[
              ["overview", "Overview"],
              ["submit", "Submit"],
              ["forensics", "Forensics"],
            ].map(([key, label]) => (
              <button
                aria-selected={activeTab === key}
                className={activeTab === key ? "active" : ""}
                key={key}
                onClick={() => setActiveTab(key)}
                role="tab"
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          {activeTab === "overview" && (
            <TaskOverviewPanel
              displayTask={displayTask}
              steps={steps}
              verification={verification}
            />
          )}
          {activeTab === "submit" && (
            <TaskSubmitPanel
              detail={detailState.data}
              loading={detailState.loading}
              task={displayTask}
              verification={verification}
            />
          )}
          {activeTab === "forensics" && (
            <TaskForensicsPanel
              copiedValue={copiedValue}
              detail={detailState.data}
              error={detailState.error}
              loading={detailState.loading}
              onCopy={copyTaskValue}
            />
          )}
        </div>
        <footer className="task-modal-footer">
          <button
            className="danger-text"
            disabled={!detailState.data?.actions?.canRefuse}
            type="button"
          >
            Refuse task
          </button>
          <div className="task-modal-actions">
            <button className="light-pill" onClick={() => setActiveTab("forensics")} type="button">Audit trail</button>
            <button className="dark-pill" onClick={() => setActiveTab("submit")} type="button">
              Submit evidence
              <ArrowRight size={14} strokeWidth={2} />
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
