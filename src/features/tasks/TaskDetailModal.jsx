import React, { useEffect, useRef, useState } from "react";
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
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { requestJson } from "../../api";
import {
  normalizeTaskStatus,
  statusSlug,
  taskIsTerminal,
  taskRequiresRefresh,
  taskStatusColor,
} from "../../../shared/task-lifecycle";
import { formatTaskTimestamp } from "../../../shared/task-time-format";
import { truncateCid } from "../context/context-view-utils.jsx";
import { publishTaskLifecycleAction } from "./task-actions.js";
import {
  processTaskEvidenceFile,
  publishTaskEvidenceSubmission,
  readEvidenceFile,
} from "./task-submission-actions.js";
import { buildTaskCopyPayloads, copyPreview } from "./task-copy-format.js";
import { TaskForensicsPanel } from "./TaskForensicsPanel.jsx";
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

function TaskStatusGlyph({ statusKey }) {
  const normalized = normalizeTaskStatus(statusKey);
  if (["refused", "rejected", "cancelled"].includes(normalized)) {
    return (
      <svg className="task-status-x" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
        <path d="M2 2 L9 9 M9 2 L2 9" strokeLinecap="round" />
      </svg>
    );
  }
  return <span className={`task-status-glyph is-${statusSlug(normalized)}`} aria-hidden="true" />;
}

function TaskSection({ children, last, title }) {
  return (
    <section className={last ? "task-section last" : "task-section"}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function formatPftValue(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toLocaleString(undefined, {
    maximumFractionDigits: parsed % 1 === 0 ? 0 : 6,
    minimumFractionDigits: 0,
  });
}

function formatReviewMetric(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  return String(value);
}

function TaskRewardOutcome({ outcome }) {
  if (!outcome) return null;
  const rewardPft = Number(outcome.rewardPft || 0);
  const offeredPft = Number(outcome.offeredPft || 0);
  const rows = [
    ["Decision", outcome.decision],
    ["Reward decision", `${formatPftValue(rewardPft)} PFT`],
    offeredPft > 0 && offeredPft !== rewardPft
      ? ["Original offer", `${formatPftValue(offeredPft)} PFT`]
      : null,
    ["Completion", formatReviewMetric(outcome.completion)],
    ["Evidence quality", formatReviewMetric(outcome.evidenceQuality)],
  ].filter((row) => row && Boolean(String(row[1] || "").trim()));

  return (
    <section className={`task-reward-outcome is-${statusSlug(outcome.status)}`}>
      <div className="task-reward-outcome-head">
        <span>Reward outcome</span>
        <strong>{outcome.title || "Reward decision"}</strong>
        <p>{outcome.summary || "The reward decision has been indexed on-chain."}</p>
      </div>
      {rows.length > 0 && (
        <dl className="task-reward-outcome-grid">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {outcome.reason && (
        <div className="task-reward-outcome-text">
          <span>Verifier reason</span>
          <p>{outcome.reason}</p>
        </div>
      )}
      {outcome.userFeedback && (
        <div className="task-reward-outcome-text">
          <span>What to fix</span>
          <p>{outcome.userFeedback}</p>
        </div>
      )}
    </section>
  );
}

function TaskOverviewPanel({
  copiedValue,
  detail,
  displayTask,
  loading,
  onLifecycleAction,
  onCopyTaskBrief,
  onWalletUnlock,
  steps,
  verification,
  walletVault,
}) {
  const actions = detail?.actions || {};
  return (
    <>
      <div className="task-modal-divider" />
      <TaskLifecycleActionPanel
        actions={actions}
        loading={loading}
        onLifecycleAction={onLifecycleAction}
        onWalletUnlock={onWalletUnlock}
        walletVault={walletVault}
      />
      <TaskBriefCopyCard
        copied={copiedValue === "task-brief"}
        detail={detail}
        onCopy={onCopyTaskBrief}
        task={displayTask}
      />
      <TaskRewardOutcome outcome={detail?.rewardOutcome} />
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

function TaskBriefCopyCard({ copied, detail, onCopy, task }) {
  const payloads = buildTaskCopyPayloads(task, detail);
  return (
    <section className="task-brief-copy-card">
      <div>
        <span>Codex handoff</span>
        <strong>Copy task brief</strong>
        <p>Description, steps, verification requirement, task ID, reward, and current verification request when present.</p>
      </div>
      <button className={copied ? "is-copied" : ""} onClick={() => onCopy?.(payloads.codex)} type="button">
        {copied ? <Check size={14} strokeWidth={1.9} /> : <Copy size={14} strokeWidth={1.75} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{copyPreview(payloads.codex, 520)}</pre>
    </section>
  );
}

const evidenceMethodByStructuredType = {
  code: "code",
  file: "file",
  github_commit: "commit",
  mixed: "text",
  screenshot: "screenshot",
  text: "text",
  url: "url",
};

const MAX_TASK_EVIDENCE_ITEMS = 2;

function createEvidenceDraft(method = "text") {
  return {
    id: globalThis.crypto?.randomUUID?.() || `evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    code: "",
    commit: "",
    file: null,
    fileName: "",
    method,
    screenshotFile: null,
    screenshot: "",
    text: "",
    url: "",
  };
}

function evidenceMethodFromContract(task = {}, verification = {}) {
  const structuredTypes = [
    task?.submissionRequirement?.type,
    task?.submission_type,
    task?.submissionType,
    task?.metadata?.submissionType,
    verification?.submissionRequirement?.type,
    verification?.policy?.verification_type,
    verification?.policy?.type,
  ];
  for (const value of structuredTypes) {
    const method = evidenceMethodByStructuredType[String(value || "").trim()];
    if (method) return method;
  }
  return "text";
}

function evidenceValueForDraft(draft = {}) {
  return {
    code: draft.code,
    commit: draft.commit,
    file: draft.fileName,
    screenshot: draft.screenshot,
    text: draft.text,
    url: draft.url,
  }[draft.method] || "";
}

function evidenceFileForDraft(draft = {}) {
  return draft.method === "screenshot" ? draft.screenshotFile : draft.method === "file" ? draft.file : null;
}

function TaskLifecycleActionPanel({
  actions,
  loading,
  onLifecycleAction,
  onWalletUnlock,
  walletVault,
}) {
  const [reason, setReason] = useState("");
  const [state, setState] = useState({ error: "", pending: false, pendingLabel: "", result: "" });
  if (!actions?.canAccept && !actions?.canCancel) return null;

  const vaultUnlocked = Boolean(walletVault?.unlocked);
  const actionLabel = actions.stopLabel || "Cancel task";
  const helper = actions.canAccept
    ? "Accepting signs a PFTL task update and puts this task on your plate. Refusing closes the offer."
    : vaultUnlocked
      ? "Publishes a signed TASK_UPDATE pointer. The task will move after the chain cache indexes it."
      : "Unlock the local seed vault to sign this task update. The seed stays in this browser.";
  const stopDisabled = loading || state.pending;
  const acceptDisabled = stopDisabled;
  const stopCopy = vaultUnlocked ? actionLabel : "Unlock wallet";
  const acceptCopy = vaultUnlocked ? "Accept task" : "Unlock wallet";
  const title = actions.canAccept ? "Accept or refuse task" : actionLabel;
  const resultAction = state.resultAction ? `${state.resultAction}: ` : "";
  const pendingAction = state.pendingAction || "";
  const stopPending = state.pending && pendingAction !== "accept";
  const acceptPending = state.pending && pendingAction === "accept";
  const reasonLabel = actions.canAccept ? "Refusal note" : "Reason";
  const reasonPlaceholder = actions.canAccept
    ? "Optional note if you refuse this task."
    : "Optional note for the task audit trail.";

  async function submitLifecycleAction(taskAction) {
    if (!vaultUnlocked) {
      onWalletUnlock?.();
      return;
    }
    setState({ error: "", pending: true, pendingAction: taskAction, result: "", resultAction: "" });
    try {
      const result = await onLifecycleAction?.({
        reason: taskAction === "accept" ? "" : reason,
        taskAction,
      });
      setState({
        error: "",
        pending: false,
        pendingAction: "",
        result: result?.txHash ? `Published ${truncateCid(result.txHash)}` : "Published",
        resultAction: taskAction === "accept" ? "Accepted" : actionLabel,
      });
    } catch (error) {
      setState({
        error: error?.message || "Task action could not be published.",
        pending: false,
        pendingAction: "",
        result: "",
        resultAction: "",
      });
    }
  }

  return (
    <div className="task-lifecycle-action">
      <div>
        <h4>{title}</h4>
        <p>{helper}</p>
      </div>
      <label>
        {reasonLabel}
        <textarea
          disabled={state.pending}
          onChange={(event) => setReason(event.target.value)}
          placeholder={reasonPlaceholder}
          rows={3}
          value={reason}
        />
      </label>
      <div className="task-lifecycle-buttons">
        {actions.canAccept && (
          <button
            className="dark-pill"
            disabled={acceptDisabled}
            onClick={() => submitLifecycleAction("accept")}
            type="button"
          >
            {acceptPending ? "Publishing" : acceptCopy}
            <ArrowRight size={14} strokeWidth={2} />
          </button>
        )}
        {actions.canCancel && (
          <button
            className="light-pill"
            disabled={stopDisabled}
            onClick={() => submitLifecycleAction(actions.stopAction || "cancel")}
            type="button"
          >
            {stopPending ? "Publishing" : stopCopy}
            <ArrowRight size={14} strokeWidth={2} />
          </button>
        )}
      </div>
      {state.error && <p className="task-action-message is-error">{state.error}</p>}
      {state.result && <p className="task-action-message">{resultAction}{state.result}</p>}
    </div>
  );
}

function TaskSubmitPanel({
  accountId,
  detail,
  linkedWalletAddress,
  loading,
  onEvidenceSubmitted,
  onWalletUnlock,
  task,
  verification,
  walletSecret,
  walletVault,
}) {
  const defaultEvidenceMethod = evidenceMethodFromContract(task, verification);
  const taskId = task?.taskId || task?.fullId || task?.id || detail?.task?.taskId || detail?.task?.fullId || "";
  const [evidenceDrafts, setEvidenceDrafts] = useState(() => [createEvidenceDraft(defaultEvidenceMethod)]);
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState({ error: "", pending: false, pendingLabel: "", result: "" });
  const [notes, setNotes] = useState("");
  const actions = detail?.actions || {};
  const verificationRequest = detail?.currentVerificationRequest || null;
  const submissionOpen = Boolean(actions.canSubmitInitialEvidence || actions.canSubmitVerificationEvidence);
  const submissionModeKey = actions.canSubmitVerificationEvidence
    ? `verification:${verificationRequest?.eventId || verificationRequest?.body || taskId}`
    : actions.canSubmitInitialEvidence
      ? `initial:${taskId}`
      : `closed:${task?.statusKey || task?.status || taskId}`;
  const summaries = Array.isArray(detail?.submission?.summaries) ? detail.submission.summaries : [];
  const signingEnabled = Boolean(actions.browserSubmissionEnabled);
  const vaultUnlocked = Boolean(walletVault?.unlocked);
  const evidenceItems = evidenceDrafts.map((draft) => ({
    file: evidenceFileForDraft(draft),
    method: draft.method,
    notes,
    value: evidenceValueForDraft(draft),
  }));
  const readyEvidenceItems = evidenceItems.filter((item) => item.value.trim());
  const canPrepareEvidence = Boolean(
    readyEvidenceItems.length === evidenceDrafts.length &&
      evidenceDrafts.length > 0 &&
      !loading &&
      !state.pending &&
      signingEnabled &&
      confirmed
  );
  const helperText = signingEnabled
    ? vaultUnlocked
      ? "Evidence is encrypted in this browser, pinned to IPFS, and published as a signed PFTL task pointer."
      : "Unlock the local seed vault to sign evidence. The seed stays in this browser."
    : "This task state is not accepting evidence right now.";
  const methods = [
    { key: "text", label: "Text", icon: FileText },
    { key: "url", label: "URL", icon: ExternalLink },
    { key: "screenshot", label: "Screenshot", icon: Eye },
    { key: "code", label: "Code", icon: FileText },
    { key: "commit", label: "Commit", icon: Github },
    { key: "file", label: "File", icon: Paperclip },
  ];

  useEffect(() => {
    setEvidenceDrafts([createEvidenceDraft(defaultEvidenceMethod)]);
    setNotes("");
    setConfirmed(false);
    setState({ error: "", pending: false, pendingLabel: "", result: "" });
  }, [defaultEvidenceMethod, submissionModeKey]);

  function updateEvidenceDraft(id, key, value) {
    setState({ error: "", pending: false, pendingLabel: "", result: "" });
    setEvidenceDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, [key]: value } : draft))
    );
  }

  function addEvidenceDraft() {
    setEvidenceDrafts((current) =>
      current.length >= MAX_TASK_EVIDENCE_ITEMS
        ? current
        : [...current, createEvidenceDraft(defaultEvidenceMethod)]
    );
    setState({ error: "", pending: false, pendingLabel: "", result: "" });
  }

  function removeEvidenceDraft(id) {
    setEvidenceDrafts((current) => {
      if (current.length <= 1) return current;
      return current.filter((draft) => draft.id !== id);
    });
    setState({ error: "", pending: false, pendingLabel: "", result: "" });
  }

  async function updateEvidenceFile(id, key, fileKey, file) {
    if (!file) {
      updateEvidenceDraft(id, key, "");
      updateEvidenceDraft(id, fileKey, null);
      return;
    }
    setState({
      error: "",
      pending: true,
      pendingLabel: key === "screenshot" ? "Reading screenshot" : "Reading file",
      result: "",
    });
    try {
      const readFile = await readEvidenceFile(file);
      const processedFile = await processTaskEvidenceFile({
        file: readFile,
        method: key === "screenshot" ? "screenshot" : "file",
        taskId,
        value: file.name,
        verificationCriteria: verification?.body || verification?.title || "",
      });
      setEvidenceDrafts((current) =>
        current.map((draft) =>
          draft.id === id
            ? { ...draft, [key]: file.name, [fileKey]: processedFile }
            : draft
        )
      );
      setState({
        error: "",
        pending: false,
        pendingLabel: "",
        result: key === "screenshot" ? "Screenshot read and compacted" : "",
      });
    } catch (error) {
      setState({
        error: error?.message || "Evidence file could not be read.",
        pending: false,
        pendingLabel: "",
        result: "",
      });
    }
  }

  async function submitEvidence() {
    if (!vaultUnlocked) {
      onWalletUnlock?.();
      return;
    }
    setState({ error: "", pending: true, pendingLabel: "Publishing evidence", result: "" });
    try {
      const result = await publishTaskEvidenceSubmission({
        accountId,
        detail,
        linkedWalletAddress,
        method: evidenceItems[0]?.method || "text",
        notes,
        onProgress: (label) => {
          setState((current) => ({
            ...current,
            error: "",
            pending: true,
            pendingLabel: label,
            result: "",
          }));
        },
        task,
        value: evidenceItems[0]?.value || "",
        evidenceItems,
        walletSecret,
        file: evidenceItems[0]?.file || null,
      });
      setState({
        error: "",
        pending: false,
        pendingLabel: "",
        result: result?.txHash ? `Published ${truncateCid(result.txHash)}` : "Evidence published",
      });
      setEvidenceDrafts([createEvidenceDraft(defaultEvidenceMethod)]);
      setNotes("");
      setConfirmed(false);
      Promise.resolve(onEvidenceSubmitted?.(result)).catch(() => {});
    } catch (error) {
      setState({
        error: error?.message || "Task evidence could not be published.",
        pending: false,
        pendingLabel: "",
        result: "",
      });
    }
  }

  return (
    <div className="task-submit-panel">
      <div className="task-submit-head">
        <div>
          <h3>{actions.canSubmitVerificationEvidence ? "Submit verification evidence" : "Submit task evidence"}</h3>
          <p>
            {actions.canSubmitVerificationEvidence
              ? verificationRequest?.body || "Respond to the indexed verification request."
              : verification.body || "Submit evidence that satisfies this task."}
          </p>
          {actions.canSubmitVerificationEvidence && verificationRequest?.reason && (
            <small>{verificationRequest.reason}</small>
          )}
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

      <div className="task-evidence-list">
        {evidenceDrafts.map((draft, index) => (
          <div className="task-evidence-card" key={draft.id}>
            <div className="task-evidence-card-head">
              <strong>Evidence {index + 1}</strong>
              {evidenceDrafts.length > 1 && (
                <button
                  className="task-evidence-remove"
                  onClick={() => removeEvidenceDraft(draft.id)}
                  type="button"
                >
                  <Trash2 size={13} strokeWidth={1.85} />
                  Remove
                </button>
              )}
            </div>
            <div className="task-evidence-methods" role="tablist" aria-label={`Evidence ${index + 1} type`}>
              {methods.map(({ key, label, icon: Icon }) => (
                <button
                  aria-selected={draft.method === key}
                  className={draft.method === key ? "active" : ""}
                  key={key}
                  onClick={() => updateEvidenceDraft(draft.id, "method", key)}
                  role="tab"
                  type="button"
                >
                  <Icon size={14} strokeWidth={1.85} />
                  {label}
                </button>
              ))}
            </div>

            {draft.method === "text" && (
              <label>
                Evidence body
                <textarea
                  onChange={(event) => updateEvidenceDraft(draft.id, "text", event.target.value)}
                  placeholder="Describe the completed work and include any relevant artifact references."
                  rows={7}
                  value={draft.text}
                />
              </label>
            )}
            {draft.method === "url" && (
              <label>
                Public URL
                <input
                  onChange={(event) => updateEvidenceDraft(draft.id, "url", event.target.value)}
                  placeholder="https://..."
                  type="url"
                  value={draft.url}
                />
              </label>
            )}
            {draft.method === "screenshot" && (
              <div className="task-file-drop">
                <Eye size={18} strokeWidth={1.75} />
                <label>
                  Screenshot file
                  <input
                    accept="image/*"
                    onChange={(event) => updateEvidenceFile(draft.id, "screenshot", "screenshotFile", event.target.files?.[0] || null)}
                    type="file"
                  />
                </label>
                <span>{draft.screenshot || "No screenshot selected"}</span>
                {draft.screenshotFile?.description && (
                  <p className="task-evidence-processed">{draft.screenshotFile.description}</p>
                )}
              </div>
            )}
            {draft.method === "code" && (
              <label>
                Code sample
                <textarea
                  className="task-code-input"
                  onChange={(event) => updateEvidenceDraft(draft.id, "code", event.target.value)}
                  placeholder="Paste the relevant code or command output."
                  rows={8}
                  value={draft.code}
                />
              </label>
            )}
            {draft.method === "commit" && (
              <label>
                Commit or PR URL
                <input
                  onChange={(event) => updateEvidenceDraft(draft.id, "commit", event.target.value)}
                  placeholder="https://github.com/org/repo/commit/..."
                  type="url"
                  value={draft.commit}
                />
              </label>
            )}
            {draft.method === "file" && (
              <div className="task-file-drop">
                <Paperclip size={18} strokeWidth={1.75} />
                <label>
                  Evidence file
                  <input
                    onChange={(event) => updateEvidenceFile(draft.id, "fileName", "file", event.target.files?.[0] || null)}
                    type="file"
                  />
                </label>
                <span>{draft.fileName || "No file selected"}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {evidenceDrafts.length < MAX_TASK_EVIDENCE_ITEMS && (
        <button className="light-pill task-add-evidence" onClick={addEvidenceDraft} type="button">
          <Plus size={14} strokeWidth={2} />
          Add evidence
        </button>
      )}

      <div className="task-evidence-card">
        <label className="task-evidence-notes">
          Notes
          <textarea
            onChange={(event) => {
              setNotes(event.target.value);
              setState({ error: "", pending: false, pendingLabel: "", result: "" });
            }}
            placeholder="Add context for the verifier."
            rows={3}
            value={notes}
          />
        </label>
      </div>

      <button
        className="dark-pill task-submit-button"
        disabled={!canPrepareEvidence}
        onClick={submitEvidence}
        type="button"
      >
        {state.pending ? state.pendingLabel || "Working" : vaultUnlocked ? "Submit evidence" : "Unlock wallet"}
        <ArrowRight size={14} strokeWidth={2} />
      </button>
      {signingEnabled && (
        <label className="task-submit-confirm">
          <input
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            type="checkbox"
          />
          This evidence is ready to submit.
        </label>
      )}
      {state.error && <p className="task-action-message is-error">{state.error}</p>}
      {state.result && !state.pending && <p className="task-action-message">{state.result}</p>}
      <div className="task-inline-warning">
        <AlertTriangle size={15} strokeWidth={1.8} />
        <span>{helperText}</span>
      </div>
    </div>
  );
}

export function TaskDetailModal({
  accountId = "",
  escapeDisabled = false,
  linkedWalletAddress = "",
  onClose,
  onTaskChanged,
  onWalletUnlock,
  task,
  walletSecret = null,
  walletVault = null,
}) {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [detailState, setDetailState] = useState({ data: null, error: "", loading: true });
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [copiedValue, setCopiedValue] = useState("");
  const aliveRef = useRef(true);
  const displayTask = detailState.data?.task || task;
  const steps = Array.isArray(displayTask.steps) ? displayTask.steps : [];
  const verification = displayTask.verification || {};
  const rewardPft = Number(displayTask.pft || 0);
  const taskId = displayTask.taskId || displayTask.fullId || task.taskId || task.fullId || task.id || "";
  const forensicsCount = detailState.data?.forensics?.timeline?.length || displayTask.metadata?.eventCount || 0;

  useEffect(() => {
    aliveRef.current = true;
    const id = requestAnimationFrame(() => setMounted(true));
    const onKey = (event) => {
      if (event.key === "Escape" && !escapeDisabled) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      aliveRef.current = false;
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [escapeDisabled, onClose]);

  async function refreshTaskDetail({ showLoading = true } = {}) {
    if (showLoading) setDetailState((current) => ({ ...current, loading: true }));
    try {
      const result = await requestJson(`/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`);
      if (!aliveRef.current) return null;
      if (result.ok && result.body?.ok) {
        setDetailState({ data: result.body, error: "", loading: false });
        return result.body;
      }
      setDetailState({
        data: null,
        error: result.body?.error || "task_detail_unavailable",
        loading: false,
      });
      return null;
    } catch {
      if (!aliveRef.current) return null;
      setDetailState({
        data: null,
        error: "Task detail could not be loaded.",
        loading: false,
      });
      return null;
    }
  }

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
            error: result.body?.error || "task_detail_unavailable",
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
  }, [detailRefreshKey, taskId]);

  function applyOptimisticEvidenceState(result = {}) {
    const schema = result?.submissionPayload?.schema || "";
    const verificationResponse = schema === "pf.task.verification_response.v1";
    const nextTaskStatus = verificationResponse
      ? { status: "Awaiting review", statusKey: "verification_response_submitted" }
      : { status: "Submitted", statusKey: "submitted" };
    setDetailState((current) => {
      const data = current.data;
      if (!data?.task) return current;
      return {
        ...current,
        data: {
          ...data,
          task: {
            ...data.task,
            ...nextTaskStatus,
            metadata: {
              ...(data.task.metadata || {}),
              optimisticLastTxHash: result?.txHash || "",
            },
          },
          actions: {
            ...(data.actions || {}),
            canSubmitInitialEvidence: false,
            canSubmitVerificationEvidence: false,
            browserSubmissionEnabled: false,
          },
        },
      };
    });
  }

  async function pollTaskDetailForSubmittedTx(result = {}) {
    const txHash = String(result?.txHash || "").trim();
    const verificationResponse = result?.submissionPayload?.schema === "pf.task.verification_response.v1";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      if (!aliveRef.current) return;
      const detail = await refreshTaskDetail({ showLoading: false });
      await onTaskChanged?.();
      if (!detail?.task) continue;
      const lastTx = detail?.forensics?.lastEventTxHash || "";
      const hasSubmittedTx = txHash && (
        lastTx === txHash ||
        (Array.isArray(detail?.forensics?.timeline) && detail.forensics.timeline.some((event) => event?.txHash === txHash))
      );
      const statusKey = normalizeTaskStatus(detail.task.statusKey || detail.task.status);
      const terminal = taskIsTerminal(statusKey);
      if (terminal) return;
      if (!verificationResponse && (statusKey === "verification_requested" || (hasSubmittedTx && !taskRequiresRefresh(statusKey)))) {
        return;
      }
      applyOptimisticEvidenceState(result);
    }
  }

  async function handleEvidenceSubmitted(result = {}) {
    applyOptimisticEvidenceState(result);
    await onTaskChanged?.();
    pollTaskDetailForSubmittedTx(result);
  }

  async function copyTaskValue(label, value) {
    const ok = await copyText(value);
    if (!ok) return;
    setCopiedValue(label);
    window.setTimeout(() => setCopiedValue((current) => (current === label ? "" : current)), 1400);
  }

  async function handleLifecycleAction({ reason = "", taskAction = "cancel" } = {}) {
    const result = await publishTaskLifecycleAction({
      accountId,
      linkedWalletAddress,
      walletSecret,
      task: displayTask,
      detail: detailState.data,
      taskAction,
      reason,
    });
    setDetailRefreshKey((key) => key + 1);
    await onTaskChanged?.();
    return result;
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
                <TaskStatusGlyph statusKey={displayTask.statusKey || displayTask.status} />
                <strong style={{ color: displayTask.statusColor || taskStatusColor(displayTask.statusKey) }}>
                  {displayTask.status}
                </strong>
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
              copiedValue={copiedValue}
              detail={detailState.data}
              displayTask={displayTask}
              loading={detailState.loading}
              onLifecycleAction={handleLifecycleAction}
              onCopyTaskBrief={(payload) => copyTaskValue("task-brief", payload)}
              onWalletUnlock={onWalletUnlock}
              steps={steps}
              verification={verification}
              walletVault={walletVault}
            />
          )}
          {activeTab === "submit" && (
            <TaskSubmitPanel
              accountId={accountId}
              detail={detailState.data}
              linkedWalletAddress={linkedWalletAddress}
              loading={detailState.loading}
              onEvidenceSubmitted={async (result) => {
                await handleEvidenceSubmitted(result);
              }}
              onWalletUnlock={onWalletUnlock}
              task={displayTask}
              verification={verification}
              walletSecret={walletSecret}
              walletVault={walletVault}
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
      </section>
    </div>
  );
}
