import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clipboard, Clock3, Flag, LoaderCircle, X } from "lucide-react";
import { requestJson } from "../../api";
import { taskStatusColor, taskStatusLabel } from "../../../shared/task-lifecycle";
import { formatTaskDeadline, formatTaskTimestamp } from "../../../shared/task-time-format";

function taskIdentity(task = {}) {
  return String(task.taskId || task.fullId || task.id || "").trim();
}

function taskError(result, fallback) {
  return result?.body?.error || fallback;
}

function displayText(value, fallback = "Not provided") {
  const text = String(value || "").trim();
  return text || fallback;
}

function taskReward(task = {}) {
  const reward = Number(task.pft || 0);
  return Number.isFinite(reward) ? reward : 0;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Some browsers block Clipboard API even after a direct button press.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function TaskDetailSection({ children, title }) {
  return (
    <section className="team-task-popout-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function TeamTaskDetailPopout({ member, onClose, task }) {
  const closeRef = useRef(null);
  const taskId = taskIdentity(task);
  const requestKey = `${member?.accountId || "member"}:${taskId}`;
  const [detailState, setDetailState] = useState({ data: null, error: "", key: requestKey, loading: true });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const previousActive = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      previousActive?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    let active = true;
    setDetailState({ data: null, error: "", key: requestKey, loading: true });
    requestJson(`/api/team/${encodeURIComponent(member.accountId)}/tasks/${encodeURIComponent(taskId)}`)
      .then((result) => {
        if (!active) return;
        setDetailState({
          data: result.ok ? result.body : null,
          error: result.ok ? "" : taskError(result, "Could not load task details."),
          key: requestKey,
          loading: false,
        });
      })
      .catch((error) => {
        if (!active) return;
        setDetailState({ data: null, error: error.message || "Could not load task details.", key: requestKey, loading: false });
      });
    return () => { active = false; };
  }, [member.accountId, requestKey, taskId]);

  const detail = detailState.key === requestKey ? detailState.data : null;
  const displayTask = useMemo(() => ({ ...task, ...(detail?.task || {}) }), [detail, task]);
  const statusKey = displayTask.statusKey || displayTask.status;
  const statusLabel = displayTask.status && displayTask.status !== statusKey
    ? displayTask.status
    : taskStatusLabel(statusKey);
  const deadline = formatTaskDeadline(displayTask.deadlineAt || displayTask.dueAt, { locale: "en-US" });
  const updated = formatTaskTimestamp(displayTask.updatedAt || displayTask.lastEventAt, { locale: "en-US" });
  const steps = Array.isArray(displayTask.steps) ? displayTask.steps.filter(Boolean) : [];
  const evidenceRequirement = displayTask.verification?.body || displayTask.submissionRequirement?.criteria;
  const submissions = Array.isArray(detail?.submission?.summaries) ? detail.submission.summaries.slice(0, 3) : [];
  const currentReview = detail?.currentVerificationRequest;
  const rewardOutcome = detail?.rewardOutcome;

  async function copyTaskId() {
    if (!taskId) return;
    const copySucceeded = await copyText(taskId);
    if (!copySucceeded) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="team-task-popout-layer">
      <button className="team-task-popout-wash" aria-label="Close task details" onClick={onClose} type="button" />
      <aside
        aria-labelledby="team-task-popout-title"
        aria-modal="true"
        className="team-task-popout"
        role="dialog"
      >
        <header className="team-task-popout-header">
          <div>
            <span><Flag size={13} />Teammate task</span>
            <small>{member.identity?.displayName || "Task Node teammate"}</small>
          </div>
          <button aria-label="Close task details" onClick={onClose} ref={closeRef} type="button"><X size={18} /></button>
        </header>

        <div className="team-task-popout-body">
          <div className="team-task-popout-title-row">
            <div>
              <span className="team-task-popout-status" style={{ color: taskStatusColor(statusKey) }}>{statusLabel}</span>
              <h2 id="team-task-popout-title">{displayText(displayTask.title, "Untitled task")}</h2>
            </div>
            <strong>{taskReward(displayTask).toLocaleString()} <small>PFT</small></strong>
          </div>

          <div className="team-task-popout-meta">
            <span><Clock3 size={14} /><small>Deadline</small><strong>{deadline}</strong></span>
            <span><Clock3 size={14} /><small>Updated</small><strong>{updated || "Not available"}</strong></span>
          </div>

          {detailState.loading && (
            <div className="team-task-popout-loading"><LoaderCircle size={18} />Loading full task details…</div>
          )}
          {detailState.error && <p className="collab-error">{detailState.error}</p>}

          <TaskDetailSection title="Task brief">
            <p>{displayText(displayTask.description, "No task brief was indexed.")}</p>
          </TaskDetailSection>

          {steps.length > 0 && (
            <TaskDetailSection title="What needs to be done">
              <ol>{steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}</ol>
            </TaskDetailSection>
          )}

          <TaskDetailSection title="Evidence required">
            <p>{displayText(evidenceRequirement, "No evidence requirement was indexed.")}</p>
          </TaskDetailSection>

          {(currentReview?.body || rewardOutcome || submissions.length > 0) && (
            <TaskDetailSection title="Latest activity">
              <div className="team-task-popout-activity">
                {currentReview?.body && <article><strong>Verification request</strong><p>{currentReview.body}</p></article>}
                {rewardOutcome && <article><strong>Reward outcome</strong><p>{displayText(rewardOutcome.summary || rewardOutcome.reason, `${taskReward(displayTask).toLocaleString()} PFT recorded`)}</p></article>}
                {submissions.map((submission, index) => (
                  <article key={submission.eventId || submission.cid || index}>
                    <strong>{submission.label || `Submission ${index + 1}`}</strong>
                    <p>{displayText(submission.summary || submission.description || submission.text, "Evidence submission indexed.")}</p>
                  </article>
                ))}
              </div>
            </TaskDetailSection>
          )}

          <footer className="team-task-popout-id">
            <span><small>Task ID</small><code>{taskId}</code></span>
            <button onClick={copyTaskId} type="button">{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? "Copied" : "Copy"}</button>
          </footer>
        </div>
      </aside>
    </div>
  );
}
