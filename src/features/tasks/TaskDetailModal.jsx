import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
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
  taskLifecycleActions,
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
import { buildTaskCopyPayloads } from "./task-copy-format.js";
import {
  optimisticEvidenceStateFromSubmission,
  overlayTaskDetailWithOptimisticEvidence,
  shouldRetainOptimisticEvidenceState,
} from "./task-detail-optimistic-state.js";
import {
  taskDetailControlsBlocked,
  taskDetailDisplayData,
  taskDetailRefreshErrorState,
} from "./task-detail-loading-state.js";
import {
  overlayTaskDetailWithVisibleState,
  shouldRetainVisibleTaskDetailState,
  visibleTaskStateFromActionReceipt,
  visibleTaskStateFromTask,
} from "./task-visible-state.js";
import {
  taskActionReceiptFromEvidenceResult,
  taskActionReceiptFromLifecycleResult,
  taskActionReceiptFromObservedTask,
} from "./task-action-receipts.js";
import {
  addUserRequestedEvidenceDraft,
  evidenceDraftStateHasUserInput,
  evidenceFileForDraft,
  evidenceMethodFromContract,
  evidenceValueForDraft,
  MAX_TASK_EVIDENCE_ITEMS,
  restoreEvidenceDraftState,
  resetEvidenceDrafts,
  serializeEvidenceDraftState,
  taskEvidenceDraftStorageKey,
} from "./task-evidence-drafts.js";
import { TaskForensicsPanel } from "./TaskForensicsPanel.jsx";
import {
  evaluateTaskSigningUnlockPolicy,
  TASK_REQUEST_UNLOCK_STATES,
} from "./task-request-unlock-policy.js";
import "./task-detail.css";

function signingButtonLabel(
  policy,
  { ready = "Continue", locked = "Unlock wallet", vault = "Open wallet", pending = "Unlocking" } = {}
) {
  if (policy.state === TASK_REQUEST_UNLOCK_STATES.UNLOCK_PENDING) return pending;
  if (policy.allowed) return ready;
  if (
    policy.state === TASK_REQUEST_UNLOCK_STATES.NEEDS_LOCAL_VAULT ||
    policy.state === TASK_REQUEST_UNLOCK_STATES.NEEDS_WALLET
  ) {
    return vault;
  }
  return locked;
}

function handleSigningUnlockAction(policy, onWalletUnlock) {
  if (["unlock", "open_wallet", "wait"].includes(policy.action)) onWalletUnlock?.();
}

function recordClientObservabilityEvent(payload = {}) {
  requestJson("/api/user-observability/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

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

function taskDetailCacheKey({
  accountId = "",
  linkedWalletAddress = "",
  task = {},
  taskVersion = "",
} = {}) {
  const taskId = taskIdentityKey(task);
  if (!taskId || typeof window === "undefined") return "";
  return [
    "tasknode.taskDetail.v1",
    accountId || "account",
    linkedWalletAddress || "wallet",
    taskId,
    taskVersion || "version",
  ].join(":");
}

function cachedTaskDetailFromTask(task = {}, {
  linkedWalletAddress = "",
} = {}) {
  if (!task?.taskId && !task?.fullId && !task?.id) return null;
  return {
    ok: true,
    partial: true,
    source: "task_list_projection",
    task,
    wallets: {
      user: linkedWalletAddress || "",
      authority: task?.metadata?.authorityWallet || "",
      allocation: task?.metadata?.allocationWallet || "",
    },
    actions: taskLifecycleActions(task.statusKey || task.status),
    submission: {
      summaries: [],
      generatedTask: task?.metadata?.generatedTask || {},
      verificationPolicy: task?.verificationPolicy || task?.verification?.policy || {},
    },
    currentVerificationRequest: null,
    rewardOutcome: null,
    forensics: {
      source: task?.source || "task_list_projection",
      eventCount: Number(task?.metadata?.eventCount || 0),
      requestBundleCid: task?.requestBundleCid || "",
      contextCid: task?.contextCid || "",
      lastEventTxHash: task?.txHash || "",
      lastEventCid: "",
      cids: [],
      transactions: task?.txHash ? [{ txHash: task.txHash, label: "Latest task event" }] : [],
      timeline: [],
      pointerEvents: [],
      reducerEvents: [],
      reviewState: null,
      integrity: {
        expectedEventCount: Number(task?.metadata?.eventCount || 0),
        pointerEventCount: 0,
        reducerEventCount: 0,
        renderedEventCount: 0,
        missingTimelineRows: false,
        pendingReducerCount: 0,
        processingReducerCount: 0,
        failedReducerCount: 0,
        failedReducerExamples: [],
        latestReducerUpdatedAt: null,
        latestReducerProcessedAt: null,
        latestCachedPointer: null,
        projectionBehindCachedPointer: false,
        projectionLastEvent: {
          txHash: task?.txHash || "",
          cid: "",
          status: task?.statusKey || task?.status || "",
          eventCount: Number(task?.metadata?.eventCount || 0),
        },
      },
    },
    sync: {
      updatedAt: task?.updatedAt || null,
      lastEventAt: task?.lastEventAt || null,
      requiresRefresh: false,
      nextPollMs: null,
      refreshReason: "",
    },
  };
}

function readCachedTaskDetail(cacheKey = "", fallback = null) {
  if (!cacheKey || typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(cacheKey) || "null");
    if (parsed?.task) return parsed;
  } catch {
    // Ignore cache parse failures; the task list projection is the fallback.
  }
  return fallback;
}

function writeCachedTaskDetail(cacheKey = "", detail = null) {
  if (!cacheKey || !detail?.task || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(cacheKey, JSON.stringify(detail));
  } catch {
    // Detail cache is a UX optimization; actions still use server config.
  }
}

function TaskSection({ children, last, title }) {
  return (
    <section className={last ? "task-section last" : "task-section"}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function TaskDot() {
  return <span className="task-meta-dot" aria-hidden="true">.</span>;
}

function SectionLabel({ title, meta, action }) {
  return (
    <div className="task-section-label">
      <div>
        <span>{title}</span>
        {meta && (
          <>
            <TaskDot />
            <small>{meta}</small>
          </>
        )}
      </div>
      {action}
    </div>
  );
}

function ToggleTextButton({ expanded, onClick }) {
  const Icon = expanded ? ChevronUp : ChevronDown;
  return (
    <button className="task-text-toggle" onClick={onClick} type="button">
      {expanded ? "Hide" : "Show"}
      <Icon size={12} strokeWidth={1.5} />
    </button>
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

function taskVersionKey(task = {}) {
  return [
    task.taskId || task.fullId || task.id || "",
    task.statusKey || task.status || "",
    task.updatedAt || "",
    task.lastEventAt || "",
    task.txHash || "",
    task.metadata?.eventCount || "",
  ].join("|");
}

function taskIdentityKey(task = {}) {
  return String(task?.taskId || task?.fullId || task?.id || "").trim();
}

function TaskRewardOutcome({ outcome }) {
  if (!outcome) return null;
  const rewardPft = Number(outcome.rewardPft || 0);
  const offeredPft = Number(outcome.offeredPft || 0);
  const rows = [
    ["Decision", outcome.decision],
    ["Reward outcome", `${formatPftValue(rewardPft)} PFT`],
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
        <strong>{outcome.title || "Reward outcome"}</strong>
        <p>{outcome.summary || "The reward outcome has been indexed on-chain."}</p>
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

function TaskDetailLoadingPanel() {
  return (
    <section className="task-detail-loading" aria-live="polite">
      <span />
      <p>Loading task detail</p>
    </section>
  );
}

function TaskCurrentVerificationPanel({ request }) {
  if (!request?.body && !request?.reason) return null;
  const rows = [
    request.type ? ["Evidence type", request.type] : null,
    request.assessment ? ["Assessment", request.assessment] : null,
    request.eventId ? ["Request event", request.eventId] : null,
  ].filter(Boolean);
  return (
    <section className="task-current-requirement">
      <div className="task-current-requirement-head">
        <span>Verification requested</span>
        <strong>Submit verification evidence</strong>
      </div>
      {request.body && <p>{request.body}</p>}
      {request.reason && (
        <div className="task-current-requirement-reason">
          <span>Why this was requested</span>
          <p>{request.reason}</p>
        </div>
      )}
      {rows.length > 0 && (
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function TaskOriginalContext({ displayTask, expanded, onToggle, steps, verification }) {
  return (
    <section className="task-original-context">
      <SectionLabel
        title="Original task"
        meta={displayTask.lastEventAtDisplay || displayTask.updatedAtDisplay || ""}
        action={<ToggleTextButton expanded={expanded} onClick={onToggle} />}
      />
      <p className="task-original-summary">
        {displayTask.description || "Original task details are indexed in the task offer."}
      </p>
      {expanded && (
        <div className="task-original-context-body">
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
        <TaskSection last title="Initial evidence requirement">
          <strong>{verification.title || "Submit evidence"}</strong>
          <p>{verification.body || "Submit evidence that satisfies the task requirement."}</p>
        </TaskSection>
      </div>
      )}
    </section>
  );
}

function TaskOverviewPanel({
  accountId,
  detail,
  displayTask,
  linkedWalletAddress,
  loading,
  onLifecycleAction,
  onSelectTab,
  onWalletUnlock,
  steps,
  verification,
  walletSecret,
  walletUnlockPending,
  walletVault,
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const actions = detail?.actions || {};
  const currentVerificationRequest = detail?.currentVerificationRequest || null;
  const verificationRequestActive = Boolean(actions.canSubmitVerificationEvidence && currentVerificationRequest);
  return (
    <>
      <div className="task-modal-divider" />
      <TaskRewardOutcome outcome={detail?.rewardOutcome} />
      {verificationRequestActive ? (
        <>
          <TaskOriginalContext
            displayTask={displayTask}
            expanded={showOriginal}
            onToggle={() => setShowOriginal((value) => !value)}
            steps={steps}
            verification={verification}
          />
          <div className="task-soft-divider" />
          <TaskCurrentVerificationPanel request={currentVerificationRequest} />
          <div className="task-overview-actions">
            <button className="dark-pill" onClick={() => onSelectTab?.("submit")} type="button">
              Respond in Submit
              <ArrowRight size={14} strokeWidth={2} />
            </button>
            {actions.canStop && (
              <button
                className="task-muted-action"
                onClick={() => setShowControls((value) => !value)}
                type="button"
              >
                {showControls ? "Hide task controls" : "Cancel task"}
              </button>
            )}
          </div>
          {showControls && (
            <TaskLifecycleActionPanel
              accountId={accountId}
              actions={actions}
              linkedWalletAddress={linkedWalletAddress}
              loading={loading}
              onLifecycleAction={onLifecycleAction}
              onWalletUnlock={onWalletUnlock}
              taskId={taskIdentityKey(displayTask)}
              walletSecret={walletSecret}
              walletUnlockPending={walletUnlockPending}
              walletVault={walletVault}
            />
          )}
        </>
      ) : (
        <>
          <TaskLifecycleActionPanel
            accountId={accountId}
            actions={actions}
            linkedWalletAddress={linkedWalletAddress}
            loading={loading}
            onLifecycleAction={onLifecycleAction}
            onWalletUnlock={onWalletUnlock}
            taskId={taskIdentityKey(displayTask)}
            walletSecret={walletSecret}
            walletUnlockPending={walletUnlockPending}
            walletVault={walletVault}
          />
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
      )}
    </>
  );
}

function submitClosedCopy(task = {}) {
  const status = normalizeTaskStatus(task.statusKey || task.status);
  if (status === "submitted") {
    return {
      title: "Evidence submitted",
      body: "Your initial evidence is indexed. The task authority is reviewing it and may request follow-up verification.",
      detail: "No evidence action is needed right now.",
    };
  }
  if (status === "verification_response_submitted") {
    return {
      title: "Awaiting review",
      body: "Your verification response is indexed. The task authority is reviewing it for a reward outcome.",
      detail: "No evidence action is needed right now.",
    };
  }
  if (status === "reward_decided") {
    return {
      title: "Reward outcome pending",
      body: "The task has an intermediate reward state. It will settle after the terminal reward outcome is reduced.",
      detail: "No evidence action is available for this state.",
    };
  }
  if (taskIsTerminal(status)) {
    return {
      title: "Submission closed",
      body: "This task is closed and is no longer accepting evidence.",
      detail: "Review the Overview or Forensics tabs for the final state.",
    };
  }
  return {
    title: "Submission unavailable",
    body: "This task state is not accepting evidence right now.",
    detail: "The task may still be indexing or waiting for the next authority action.",
  };
}

function TaskLifecycleActionPanel({
  accountId,
  actions = {},
  linkedWalletAddress,
  loading,
  onLifecycleAction,
  onWalletUnlock,
  taskId = "",
  walletSecret,
  walletUnlockPending = false,
  walletVault,
}) {
  const [reason, setReason] = useState("");
  const [state, setState] = useState({ error: "", pending: false, pendingLabel: "", result: "" });
  const lastAcceptUiEventRef = useRef("");

  const unlockPolicy = evaluateTaskSigningUnlockPolicy({
    accountId,
    linkedWalletAddress,
    walletSecret,
    walletVault,
    unlockPending: walletUnlockPending,
  });
  const signingReady = unlockPolicy.allowed;
  const actionLabel = actions.stopLabel || "Cancel task";
  const helper = actions.canAccept
    ? "Accepting signs a PFTL task update and puts this task on your plate. Refusing closes the offer."
    : signingReady
      ? "Publishes a signed TASK_UPDATE pointer. The task will move after the chain cache indexes it."
      : unlockPolicy.message;
  const stopDisabled = loading || state.pending;
  const acceptDisabled = stopDisabled;
  const stopCopy = signingButtonLabel(unlockPolicy, { ready: actionLabel, locked: "Unlock wallet", vault: "Open wallet" });
  const acceptCopy = signingButtonLabel(unlockPolicy, { ready: "Accept task", locked: "Unlock wallet", vault: "Open wallet" });
  const title = actions.canAccept ? "Accept or refuse task" : actionLabel;
  const resultAction = state.resultAction ? `${state.resultAction}: ` : "";
  const pendingAction = state.pendingAction || "";
  const stopPending = state.pending && pendingAction !== "accept";
  const acceptPending = state.pending && pendingAction === "accept";
  const showStopButton = Boolean(actions.canStop && (signingReady || !actions.canAccept));
  const reasonLabel = actions.canAccept ? "Refusal note" : "Reason";
  const reasonPlaceholder = actions.canAccept
    ? "Optional note if you refuse this task."
    : "Optional note for the task audit trail.";
  const acceptUiEvent = useMemo(() => {
    if (!actions.canAccept) return null;
    if (!signingReady) {
      return {
        eventType: "user.ui.blocker_shown",
        resultStatus: "blocked",
        reasonCode: unlockPolicy.state || "wallet_unlock_required",
        metadata: {
          action: "accept",
          unlockAction: unlockPolicy.action || "",
          buttonLabel: acceptCopy,
          helper,
        },
      };
    }
    if (acceptDisabled) {
      return {
        eventType: "user.ui.action_disabled",
        resultStatus: "disabled",
        reasonCode: loading ? "task_detail_loading" : state.pending ? "task_action_pending" : "accept_disabled",
        metadata: {
          action: "accept",
          pendingAction,
          loading,
          buttonLabel: acceptPending ? "Publishing" : acceptCopy,
        },
      };
    }
    return {
      eventType: "user.ui.action_recovered",
      resultStatus: "recovered",
      reasonCode: "accept_available",
      metadata: {
        action: "accept",
        buttonLabel: acceptCopy,
      },
    };
  }, [
    acceptCopy,
    acceptDisabled,
    acceptPending,
    actions.canAccept,
    helper,
    loading,
    pendingAction,
    signingReady,
    state.pending,
    unlockPolicy.action,
    unlockPolicy.state,
  ]);

  useEffect(() => {
    if (!actions.canAccept || !taskId || !acceptUiEvent) return;
    const eventKey = [
      acceptUiEvent.eventType,
      acceptUiEvent.reasonCode,
      taskId,
      linkedWalletAddress,
    ].join(":");
    if (acceptUiEvent.eventType === "user.ui.action_recovered" && !lastAcceptUiEventRef.current) return;
    if (lastAcceptUiEventRef.current === eventKey) return;
    recordClientObservabilityEvent({
      ...acceptUiEvent,
      taskId,
      walletAddress: linkedWalletAddress,
      walletScope: linkedWalletAddress ? "active" : "unknown",
      sourceSurface: "tasks",
      sourceRoute: "src/features/tasks/TaskDetailModal.jsx::TaskLifecycleActionPanel",
      metadata: {
        ...acceptUiEvent.metadata,
        canAccept: actions.canAccept,
        canStop: actions.canStop,
        signingReady,
      },
    });
    lastAcceptUiEventRef.current = eventKey;
  }, [acceptUiEvent, actions.canAccept, actions.canStop, linkedWalletAddress, signingReady, taskId]);

  if (!actions?.canAccept && !actions?.canStop) return null;

  async function submitLifecycleAction(taskAction) {
    if (!signingReady) {
      handleSigningUnlockAction(unlockPolicy, onWalletUnlock);
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
        {showStopButton && (
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
  walletUnlockPending = false,
  walletVault,
}) {
  const defaultEvidenceMethod = evidenceMethodFromContract(task, verification);
  const taskId = task?.taskId || task?.fullId || task?.id || detail?.task?.taskId || detail?.task?.fullId || "";
  const actions = detail?.actions || {};
  const verificationRequest = detail?.currentVerificationRequest || null;
  const submissionOpen = Boolean(actions.canSubmitInitialEvidence || actions.canSubmitVerificationEvidence);
  const closedCopy = submitClosedCopy(task);
  const submissionModeKey = actions.canSubmitVerificationEvidence
    ? `verification:${verificationRequest?.eventId || verificationRequest?.body || taskId}`
    : actions.canSubmitInitialEvidence
      ? `initial:${taskId}`
      : `closed:${task?.statusKey || task?.status || taskId}`;
  const draftStorageKey = taskEvidenceDraftStorageKey({ accountId, taskId, submissionModeKey });
  const readPersistedDraftState = () => {
    const storage = typeof window === "undefined" ? null : window.sessionStorage;
    const value = draftStorageKey && storage ? storage.getItem(draftStorageKey) : null;
    return restoreEvidenceDraftState(value, defaultEvidenceMethod);
  };
  const [evidenceDrafts, setEvidenceDrafts] = useState(() => readPersistedDraftState().evidenceDrafts);
  const [confirmed, setConfirmed] = useState(false);
  const [showVerificationRequest, setShowVerificationRequest] = useState(true);
  const [state, setState] = useState({ error: "", pending: false, pendingLabel: "", result: "" });
  const [notes, setNotes] = useState(() => readPersistedDraftState().notes);
  const summaries = Array.isArray(detail?.submission?.summaries) ? detail.submission.summaries : [];
  const signingEnabled = Boolean(actions.browserSubmissionEnabled);
  const unlockPolicy = evaluateTaskSigningUnlockPolicy({
    accountId,
    linkedWalletAddress,
    walletSecret,
    walletVault,
    unlockPending: walletUnlockPending,
  });
  const signingReady = unlockPolicy.allowed;
  const evidenceItems = evidenceDrafts.map((draft) => ({
    file: evidenceFileForDraft(draft),
    method: draft.method,
    notes,
    value: evidenceValueForDraft(draft),
  }));
  const readyEvidenceItems = evidenceItems.filter((item) => item.value.trim());
  const canPrepareEvidence = Boolean(
    readyEvidenceItems.length > 0 &&
      !loading &&
      !state.pending &&
      signingEnabled &&
      submissionOpen &&
      confirmed
  );
  const helperText = signingEnabled
    ? signingReady
      ? "Evidence is encrypted in this browser, pinned to IPFS, and published as a signed PFTL task pointer."
      : unlockPolicy.message
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
    const restored = readPersistedDraftState();
    setEvidenceDrafts(restored.evidenceDrafts);
    setNotes(restored.notes);
    setConfirmed(false);
    setState({ error: "", pending: false, pendingLabel: "", result: "" });
  }, [defaultEvidenceMethod, draftStorageKey]);

  useEffect(() => {
    if (!submissionOpen || !draftStorageKey || typeof window === "undefined") return;
    try {
      if (evidenceDraftStateHasUserInput({ evidenceDrafts, notes })) {
        window.sessionStorage.setItem(
          draftStorageKey,
          JSON.stringify(serializeEvidenceDraftState({ evidenceDrafts, notes }))
        );
      } else {
        window.sessionStorage.removeItem(draftStorageKey);
      }
    } catch {
      // Draft persistence is a UI safety net; submission still works if storage is unavailable.
    }
  }, [draftStorageKey, evidenceDrafts, notes, submissionOpen]);

  function clearPersistedDraftState() {
    if (!draftStorageKey || typeof window === "undefined") return;
    try {
      window.sessionStorage.removeItem(draftStorageKey);
    } catch {
      // Ignore blocked storage during cleanup.
    }
  }

  function resetSubmitDraftState({ clearStatus = true } = {}) {
    setNotes("");
    setConfirmed(false);
    if (clearStatus) setState({ error: "", pending: false, pendingLabel: "", result: "" });
    setEvidenceDrafts(resetEvidenceDrafts(defaultEvidenceMethod));
  }

  function updateEvidenceDraft(id, key, value) {
    setState({ error: "", pending: false, pendingLabel: "", result: "" });
    setConfirmed(false);
    setEvidenceDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, [key]: value } : draft))
    );
  }

  function addEvidenceDraft() {
    setEvidenceDrafts((current) => addUserRequestedEvidenceDraft(current, defaultEvidenceMethod));
    setConfirmed(false);
    setState({ error: "", pending: false, pendingLabel: "", result: "" });
  }

  function removeEvidenceDraft(id) {
    setEvidenceDrafts((current) => {
      if (current.length <= 1) return current;
      return current.filter((draft) => draft.id !== id);
    });
    setConfirmed(false);
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
      setConfirmed(false);
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
    if (!signingReady) {
      handleSigningUnlockAction(unlockPolicy, onWalletUnlock);
      return;
    }
    setState({ error: "", pending: true, pendingLabel: "Publishing evidence", result: "" });
    try {
      const result = await publishTaskEvidenceSubmission({
        accountId,
        detail,
        linkedWalletAddress,
        method: readyEvidenceItems[0]?.method || "text",
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
        value: readyEvidenceItems[0]?.value || "",
        evidenceItems: readyEvidenceItems,
        walletSecret,
        file: readyEvidenceItems[0]?.file || null,
      });
      setState({
        error: "",
        pending: false,
        pendingLabel: "",
        result: result?.txHash ? `Published ${truncateCid(result.txHash)}` : "Evidence published",
      });
      clearPersistedDraftState();
      resetSubmitDraftState({ clearStatus: false });
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
      {!actions.canSubmitVerificationEvidence && (
        <div className="task-submit-head">
          <div>
            <h3>{submissionOpen ? "Submit task evidence" : closedCopy.title}</h3>
            <p>{submissionOpen ? verification.body || "Submit evidence that satisfies this task." : closedCopy.body}</p>
            {!submissionOpen && <small>{closedCopy.detail}</small>}
          </div>
          <span className={submissionOpen ? "task-submit-state is-open" : "task-submit-state"}>
            {submissionOpen ? "Open" : task.status}
          </span>
        </div>
      )}

      {submissionOpen && actions.canSubmitVerificationEvidence && verificationRequest?.body && (
        <section className="task-submit-request">
          <SectionLabel
            title="Verification request"
            action={
              <ToggleTextButton
                expanded={showVerificationRequest}
                onClick={() => setShowVerificationRequest((value) => !value)}
              />
            }
          />
          {showVerificationRequest && <p>{verificationRequest.body}</p>}
          {showVerificationRequest && verificationRequest.reason && <small>{verificationRequest.reason}</small>}
        </section>
      )}

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

      {submissionOpen && (
        <>
      <SectionLabel
        title="Your response"
        meta={`${readyEvidenceItems.length || evidenceDrafts.length} item${(readyEvidenceItems.length || evidenceDrafts.length) === 1 ? "" : "s"}`}
      />
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
                <label className="task-file-picker">
                  <span>Choose screenshot</span>
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
                <label className="task-file-picker">
                  <span>Choose file</span>
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
        <button
          className="light-pill task-add-evidence"
          disabled={state.pending}
          onClick={addEvidenceDraft}
          title="Add one more evidence item."
          type="button"
        >
          <Plus size={14} strokeWidth={2} />
          Add second evidence
        </button>
      )}

      <div className="task-evidence-card">
        <label className="task-evidence-notes">
          <span>Notes for the verifier</span>
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
        {state.pending ? state.pendingLabel || "Working" : signingButtonLabel(unlockPolicy, { ready: "Submit evidence", locked: "Unlock wallet", vault: "Open wallet" })}
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
        </>
      )}
    </div>
  );
}

export function TaskDetailModal({
  accountId = "",
  escapeDisabled = false,
  linkedWalletAddress = "",
  onClose,
  onTaskActionReceipt,
  onTaskChanged,
  onWalletUnlock,
  task,
  walletSecret = null,
  walletUnlockPending = false,
  walletVault = null,
}) {
  const taskVersion = taskVersionKey(task);
  const detailCacheKey = taskDetailCacheKey({
    accountId,
    linkedWalletAddress,
    task,
    taskVersion,
  });
  const initialDetail = readCachedTaskDetail(
    detailCacheKey,
    cachedTaskDetailFromTask(task, { linkedWalletAddress })
  );
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [detailState, setDetailState] = useState(() => ({
    cacheKey: detailCacheKey,
    data: initialDetail,
    error: "",
    loading: true,
  }));
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [copiedValue, setCopiedValue] = useState("");
  const [optimisticEvidence, setOptimisticEvidence] = useState(null);
  const [optimisticLifecycle, setOptimisticLifecycle] = useState(null);
  const aliveRef = useRef(true);
  const onTaskActionReceiptRef = useRef(onTaskActionReceipt);
  const optimisticEvidenceRef = useRef(null);
  const optimisticLifecycleRef = useRef(null);
  const projectionDetail = useMemo(
    () => cachedTaskDetailFromTask(task, { linkedWalletAddress }),
    [linkedWalletAddress, task, taskVersion]
  );
  const displayDetail = taskDetailDisplayData(detailState, projectionDetail);
  const displayTask = displayDetail?.task || task;
  const steps = Array.isArray(displayTask.steps) ? displayTask.steps : [];
  const verification = displayTask.verification || {};
  const rewardPft = Number(displayTask.pft || 0);
  const taskId = displayTask.taskId || displayTask.fullId || task.taskId || task.fullId || task.id || "";
  const currentTaskVisibleState = useMemo(() => visibleTaskStateFromTask(task), [taskVersion]);
  const taskBriefPayload = buildTaskCopyPayloads(displayTask, displayDetail).codex;
  const forensicsCount = displayDetail?.forensics?.timeline?.length || displayTask.metadata?.eventCount || 0;
  const controlsBlocked = taskDetailControlsBlocked({ ...detailState, data: displayDetail });

  // Hold the receipt callback in a ref so commitTaskDetailResult keeps a
  // stable identity across parent re-renders; otherwise every observed
  // receipt would re-arm the detail-fetch effect and loop the request.
  useEffect(() => {
    onTaskActionReceiptRef.current = onTaskActionReceipt;
  }, [onTaskActionReceipt]);

  useEffect(() => {
    optimisticEvidenceRef.current = optimisticEvidence;
  }, [optimisticEvidence]);

  useEffect(() => {
    optimisticLifecycleRef.current = optimisticLifecycle;
  }, [optimisticLifecycle]);

  const commitTaskDetailResult = useCallback((body) => {
    const currentOptimisticEvidence = optimisticEvidenceRef.current;
    const keepOptimistic = shouldRetainOptimisticEvidenceState(body, currentOptimisticEvidence);
    if (!keepOptimistic && currentOptimisticEvidence) {
      optimisticEvidenceRef.current = null;
      setOptimisticEvidence(null);
    }
    const currentOptimisticLifecycle = optimisticLifecycleRef.current;
    const keepLifecycleOptimistic = shouldRetainVisibleTaskDetailState(body, currentOptimisticLifecycle);
    if (!keepLifecycleOptimistic && currentOptimisticLifecycle) {
      optimisticLifecycleRef.current = null;
      setOptimisticLifecycle(null);
    }
    let data = overlayTaskDetailWithVisibleState(body, currentTaskVisibleState);
    if (keepLifecycleOptimistic) {
      data = overlayTaskDetailWithVisibleState(data, currentOptimisticLifecycle);
    }
    if (keepOptimistic) {
      data = overlayTaskDetailWithOptimisticEvidence(data, currentOptimisticEvidence);
    }
    writeCachedTaskDetail(detailCacheKey, data);
    setDetailState({ cacheKey: detailCacheKey, data, error: "", loading: false });
    const observedReceipt = taskActionReceiptFromObservedTask({
      accountId,
      walletAddress: linkedWalletAddress,
      task: data?.task,
    });
    if (observedReceipt) onTaskActionReceiptRef.current?.(observedReceipt);
    return data;
  }, [accountId, currentTaskVisibleState, detailCacheKey, linkedWalletAddress]);

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

  async function refreshTaskDetail({ showLoading = true, taskProjectionRefresh = false } = {}) {
    if (showLoading) setDetailState((current) => ({ ...current, loading: true }));
    try {
      const query = new URLSearchParams({ taskId });
      if (taskProjectionRefresh) query.set("refreshProjection", "1");
      const result = await requestJson(`/api/tasks/detail?${query.toString()}`);
      if (!aliveRef.current) return null;
      if (result.ok && result.body?.ok) {
        return commitTaskDetailResult(result.body);
      }
      setDetailState((current) => taskDetailRefreshErrorState(current, result.body?.error || "task_detail_unavailable"));
      return null;
    } catch {
      if (!aliveRef.current) return null;
      setDetailState((current) => taskDetailRefreshErrorState(current, "Task detail could not be loaded."));
      return null;
    }
  }

  useEffect(() => {
    let active = true;
    setDetailState((current) => {
      const currentTaskId = taskIdentityKey(current.data?.task);
      if (current.cacheKey === detailCacheKey && current.data?.task && currentTaskId === taskId) {
        return { ...current, error: "", loading: true };
      }
      return {
        cacheKey: detailCacheKey,
        data: readCachedTaskDetail(
          detailCacheKey,
          cachedTaskDetailFromTask(task, { linkedWalletAddress })
        ),
        error: "",
        loading: true,
      };
    });
    requestJson(`/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`)
      .then((result) => {
        if (!active) return;
        if (result.ok && result.body?.ok) {
          commitTaskDetailResult(result.body);
        } else {
          setDetailState((current) => taskDetailRefreshErrorState(current, result.body?.error || "task_detail_unavailable"));
        }
      })
      .catch(() => {
        if (!active) return;
        setDetailState((current) => taskDetailRefreshErrorState(current, "Task detail could not be loaded."));
      });
    return () => {
      active = false;
    };
    // Keyed on stable primitives (plus the version-stable commit callback) so
    // the fetch fires once per open, task-version change, or explicit refresh,
    // not on every parent re-render that recreates the task object identity.
  }, [commitTaskDetailResult, detailCacheKey, detailRefreshKey, linkedWalletAddress, taskId, taskVersion]);

  function applyOptimisticEvidenceState(result = {}) {
    const optimistic = optimisticEvidenceStateFromSubmission(result);
    optimisticEvidenceRef.current = optimistic;
    setOptimisticEvidence(optimistic);
    setDetailState((current) => {
      const data = current.data;
      if (!data?.task) return current;
      return {
        ...current,
        data: overlayTaskDetailWithOptimisticEvidence(data, optimistic),
      };
    });
  }

  function applyOptimisticLifecycleState(receipt = {}) {
    const optimistic = visibleTaskStateFromActionReceipt(receipt);
    if (!optimistic) return;
    optimisticLifecycleRef.current = optimistic;
    setOptimisticLifecycle(optimistic);
    setDetailState((current) => {
      const data = current.data;
      if (!data?.task) return current;
      return {
        ...current,
        data: overlayTaskDetailWithVisibleState(data, optimistic),
      };
    });
  }

  async function pollTaskDetailForSubmittedTx(result = {}) {
    const txHash = String(result?.txHash || "").trim();
    const verificationResponse = result?.submissionPayload?.schema === "pf.task.verification_response.v1";
    const maxAttempts = verificationResponse ? 90 : 45;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      if (!aliveRef.current) return;
      const detail = await refreshTaskDetail({ showLoading: false, taskProjectionRefresh: true });
      await onTaskChanged?.({ taskProjectionRefresh: true });
      if (!detail?.task) continue;
      const lastTx = detail?.forensics?.lastEventTxHash || "";
      const hasSubmittedTx = txHash && (
        lastTx === txHash ||
        (Array.isArray(detail?.forensics?.timeline) && detail.forensics.timeline.some((event) => event?.txHash === txHash))
      );
      const statusKey = normalizeTaskStatus(detail.task.statusKey || detail.task.status);
      const terminal = taskIsTerminal(statusKey);
      if (terminal) return;
      if (verificationResponse && statusKey === "verification_response_submitted") {
        applyOptimisticEvidenceState(result);
        continue;
      }
      if (
        !verificationResponse &&
        (statusKey === "verification_requested" ||
          (hasSubmittedTx && !taskRequiresRefresh(statusKey)))
      ) {
        return;
      }
      applyOptimisticEvidenceState(result);
    }
  }

  async function handleEvidenceSubmitted(result = {}) {
    applyOptimisticEvidenceState(result);
    const receipt = taskActionReceiptFromEvidenceResult({
      accountId,
      walletAddress: linkedWalletAddress,
      result,
      task: displayTask,
    });
    if (receipt) onTaskActionReceipt?.(receipt);
    await onTaskChanged?.({ taskProjectionRefresh: true });
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
    const receipt = taskActionReceiptFromLifecycleResult({
      accountId,
      walletAddress: linkedWalletAddress,
      result,
      task: displayTask,
      taskAction,
    });
    if (receipt) {
      applyOptimisticLifecycleState(receipt);
      onTaskActionReceipt?.(receipt);
    }
    setDetailRefreshKey((key) => key + 1);
    await onTaskChanged?.({ taskProjectionRefresh: true });
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
          <div className="task-title-actions">
            <button
              className="task-id-link"
              onClick={() => copyTaskValue("task-id", taskId)}
              type="button"
            >
              {taskId}
              {copiedValue === "task-id" ? <Check size={11} strokeWidth={1.75} /> : <Copy size={11} strokeWidth={1.75} />}
            </button>
            <button
              className={copiedValue === "task-brief" ? "task-brief-copy-link is-copied" : "task-brief-copy-link"}
              onClick={() => copyTaskValue("task-brief", taskBriefPayload)}
              type="button"
            >
              {copiedValue === "task-brief" ? <Check size={12} strokeWidth={1.85} /> : <Copy size={12} strokeWidth={1.75} />}
              {copiedValue === "task-brief" ? "Copied brief" : "Copy task brief"}
            </button>
          </div>
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
              <small>{displayTask.dueLabel || "Deadline"}</small>
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

          {controlsBlocked ? (
            <TaskDetailLoadingPanel />
          ) : activeTab === "overview" && (
            <TaskOverviewPanel
              accountId={accountId}
              detail={displayDetail}
              displayTask={displayTask}
              linkedWalletAddress={linkedWalletAddress}
              loading={controlsBlocked}
              onLifecycleAction={handleLifecycleAction}
              onSelectTab={setActiveTab}
              onWalletUnlock={onWalletUnlock}
              steps={steps}
              verification={verification}
              walletSecret={walletSecret}
              walletUnlockPending={walletUnlockPending}
              walletVault={walletVault}
            />
          )}
          {!controlsBlocked && activeTab === "submit" && (
            <TaskSubmitPanel
              accountId={accountId}
              detail={displayDetail}
              linkedWalletAddress={linkedWalletAddress}
              loading={controlsBlocked}
              onEvidenceSubmitted={async (result) => {
                await handleEvidenceSubmitted(result);
              }}
              onWalletUnlock={onWalletUnlock}
              task={displayTask}
              verification={verification}
              walletSecret={walletSecret}
              walletUnlockPending={walletUnlockPending}
              walletVault={walletVault}
            />
          )}
          {!controlsBlocked && activeTab === "forensics" && (
            <TaskForensicsPanel
              copiedValue={copiedValue}
              detail={displayDetail}
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
