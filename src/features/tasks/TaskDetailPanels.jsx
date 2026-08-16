import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, ExternalLink, Eye, FileText, Github, Paperclip, Plus, Trash2 } from "lucide-react";
import { requestJson } from "../../api";
import { normalizeTaskStatus, taskIsTerminal } from "../../../shared/task-lifecycle";
import { truncateCid } from "../context/context-view-utils.jsx";
import {
  processTaskEvidenceFile,
  publishTaskEvidenceSubmission,
  readEvidenceFile,
} from "./task-submission-actions.js";
import {
  addUserRequestedEvidenceDraft,
  evidenceDraftStateHasUserInput,
  evidenceDraftIsReady,
  evidenceFileForDraft,
  evidenceMethodFromContract,
  evidenceValueForDraft,
  MAX_TASK_EVIDENCE_ITEMS,
  restoreEvidenceDraftState,
  resetEvidenceDrafts,
  serializeEvidenceDraftState,
  taskEvidenceDraftStorageKey,
} from "./task-evidence-drafts.js";
import { taskForensicsIndexedEventCount } from "./task-forensics-state.js";
import {
  evaluateTaskSigningUnlockPolicy,
  TASK_REQUEST_UNLOCK_STATES,
} from "./task-request-unlock-policy.js";
import {
  taskAcceptanceConfirmation,
  taskLifecycleStopDescriptor,
  taskSubmissionProgressSteps,
} from "./task-workflow-visibility.js";
import {
  SectionLabel,
  TaskCurrentVerificationPanel,
  TaskOriginalContext,
  TaskRewardOutcome,
  TaskSection,
  TaskWorkflowNotice,
  TaskWorkflowSteps,
  ToggleTextButton,
  formatIndexedEventCopy,
  shortProofValue,
  taskIdentityKey,
} from "./TaskDetailPrimitives.jsx";

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

export function TaskOverviewPanel({
  accountId,
  copiedValue = "",
  detail,
  directOffchain = false,
  displayTask,
  linkedWalletAddress,
  loading,
  onCopy,
  onLifecycleAction,
  onSelectTab,
  onWalletUnlock,
  pftlExplorerUrl = "",
  steps,
  verification,
  walletSecret,
  walletUnlockPending,
  walletVault,
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const actions = detail?.actions || {};
  const stopDescriptor = taskLifecycleStopDescriptor(actions);
  const currentVerificationRequest = detail?.currentVerificationRequest || null;
  const verificationRequestActive = Boolean(actions.canSubmitVerificationEvidence && currentVerificationRequest);
  const acceptanceNotice = taskAcceptanceConfirmation({ actions, task: displayTask });
  const lifecycleControls = (
    <TaskLifecycleActionPanel
      accountId={accountId}
      actions={actions}
      directOffchain={directOffchain}
      linkedWalletAddress={linkedWalletAddress}
      loading={loading}
      onLifecycleAction={onLifecycleAction}
      onWalletUnlock={onWalletUnlock}
      taskId={taskIdentityKey(displayTask)}
      walletSecret={walletSecret}
      walletUnlockPending={walletUnlockPending}
      walletVault={walletVault}
    />
  );
  return (
    <>
      <div className="task-modal-divider" />
      <TaskRewardOutcome
        copiedValue={copiedValue}
        onCopy={onCopy}
        onSelectForensics={() => onSelectTab?.("forensics")}
        outcome={detail?.rewardOutcome}
        pftlExplorerUrl={pftlExplorerUrl}
      />
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
          </div>
          {stopDescriptor && (
            <div className="task-secondary-action">
              {lifecycleControls}
            </div>
          )}
        </>
      ) : (
        <>
          {actions.canAccept && lifecycleControls}
          <TaskWorkflowNotice notice={acceptanceNotice} onAction={() => onSelectTab?.("submit")} />
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
          <TaskSection title="Verification">
            <strong>{verification.title || "Submit evidence"}</strong>
            <p>{verification.body || "Submit evidence that satisfies the task requirement."}</p>
          </TaskSection>
          <TaskProofSummary detail={detail} displayTask={displayTask} onSelectTab={onSelectTab} />
          {!actions.canAccept && stopDescriptor && (
            <div className="task-secondary-action">
              {lifecycleControls}
            </div>
          )}
        </>
      )}
    </>
  );
}

export function TaskProofSummary({ detail, displayTask, onSelectTab }) {
  const status = normalizeTaskStatus(displayTask?.statusKey || displayTask?.status);
  if (status === "proposed") return null;

  const forensics = detail?.forensics || {};
  const indexedCount = taskForensicsIndexedEventCount({ detail, task: displayTask });
  const txHash = String(forensics.lastEventTxHash || displayTask?.txHash || "").trim();
  const cid = String(forensics.lastEventCid || "").trim();
  if (!indexedCount && !txHash && !cid) return null;

  return (
    <TaskSection title="Task proof">
      <p>The latest lifecycle proof for this task is indexed and available in Forensics.</p>
      <div className="task-proof-summary">
        <span>{formatIndexedEventCopy(indexedCount)}</span>
        {txHash && <code title={txHash}>Tx {shortProofValue(txHash)}</code>}
        {cid && <code title={cid}>CID {truncateCid(cid)}</code>}
      </div>
      <button className="task-text-toggle" onClick={() => onSelectTab?.("forensics")} type="button">
        Open forensics
        <ArrowRight size={12} strokeWidth={1.5} />
      </button>
    </TaskSection>
  );
}

export function submitClosedCopy(task = {}) {
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

export function TaskLifecycleActionPanel({
  accountId,
  actions = {},
  directOffchain = false,
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
    directOffchain,
    linkedWalletAddress,
    walletSecret,
    walletVault,
    unlockPending: walletUnlockPending,
  });
  const signingReady = unlockPolicy.allowed;
  const stopDescriptor = taskLifecycleStopDescriptor(actions);
  const actionLabel = stopDescriptor?.label || "";
  const helper = actions.canAccept
    ? directOffchain
      ? "Accepting records the task update directly in Task Node and puts this task on your plate. Refusing closes the offer."
      : "Accepting signs a PFTL task update and puts this task on your plate. Refusing closes the offer."
    : signingReady
      ? directOffchain
        ? "Records the task update directly in Task Node."
        : "Publishes a signed TASK_UPDATE pointer. The task will move after the chain cache indexes it."
      : unlockPolicy.message;
  const stopDisabled = loading || state.pending;
  const acceptDisabled = stopDisabled;
  const stopCopy = actionLabel || signingButtonLabel(unlockPolicy, { ready: actionLabel, locked: "Unlock wallet", vault: "Open wallet" });
  const acceptCopy = signingButtonLabel(unlockPolicy, { ready: "Accept task", locked: "Unlock wallet", vault: "Open wallet" });
  const title = actions.canAccept
    ? actionLabel
      ? `Accept or ${actionLabel.charAt(0).toLowerCase()}${actionLabel.slice(1)}`
      : "Accept task"
    : actionLabel;
  const resultAction = state.resultAction ? `${state.resultAction}: ` : "";
  const pendingAction = state.pendingAction || "";
  const stopPending = state.pending && pendingAction !== "accept";
  const acceptPending = state.pending && pendingAction === "accept";
  const showStopButton = Boolean(stopDescriptor);
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
          buttonLabel: acceptPending ? (directOffchain ? "Accepting" : "Publishing") : acceptCopy,
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
    directOffchain,
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

  if (!actions?.canAccept && !stopDescriptor) return null;

  async function submitLifecycleAction(taskAction) {
    const isTerminalAction = taskAction !== "accept";
    if (isTerminalAction && !stopDescriptor) return;
    if (!signingReady) {
      handleSigningUnlockAction(unlockPolicy, onWalletUnlock);
      return;
    }
    if (isTerminalAction) {
      const confirmationMessage = `Confirm ${stopDescriptor.label} (${stopDescriptor.action})? This terminal action cannot be undone.`;
      if (typeof window === "undefined" || !window.confirm(confirmationMessage)) return;
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
        result: result?.txHash
          ? `${directOffchain ? "Recorded" : "Published"} ${truncateCid(result.txHash)}`
          : (directOffchain ? "Recorded" : "Published"),
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
            {acceptPending ? (directOffchain ? "Accepting" : "Publishing") : acceptCopy}
            <ArrowRight size={14} strokeWidth={2} />
          </button>
        )}
        {showStopButton && (
          <button
            className="light-pill"
            disabled={stopDisabled}
            onClick={() => submitLifecycleAction(stopDescriptor.action)}
            type="button"
          >
            {stopPending ? (directOffchain ? "Recording" : "Publishing") : stopCopy}
            <ArrowRight size={14} strokeWidth={2} />
          </button>
        )}
      </div>
      {state.error && <p className="task-action-message is-error">{state.error}</p>}
      {state.result && <p className="task-action-message">{resultAction}{state.result}</p>}
    </div>
  );
}

export function TaskSubmitPanel({
  accountId,
  detail,
  directOffchain = false,
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
  const readPersistedDraftState = useCallback(() => {
    const storage = typeof window === "undefined" ? null : window.sessionStorage;
    const value = draftStorageKey && storage ? storage.getItem(draftStorageKey) : null;
    return restoreEvidenceDraftState(value, defaultEvidenceMethod);
  }, [defaultEvidenceMethod, draftStorageKey]);
  const [evidenceDrafts, setEvidenceDrafts] = useState(() => readPersistedDraftState().evidenceDrafts);
  const [confirmed, setConfirmed] = useState(false);
  const [showVerificationRequest, setShowVerificationRequest] = useState(true);
  const [state, setState] = useState({ error: "", pending: false, pendingLabel: "", result: "", submitted: false });
  const [notes, setNotes] = useState(() => readPersistedDraftState().notes);
  const summaries = Array.isArray(detail?.submission?.summaries) ? detail.submission.summaries : [];
  const signingEnabled = Boolean(actions.browserSubmissionEnabled);
  const unlockPolicy = evaluateTaskSigningUnlockPolicy({
    accountId,
    directOffchain,
    linkedWalletAddress,
    walletSecret,
    walletVault,
    unlockPending: walletUnlockPending,
  });
  const signingReady = unlockPolicy.allowed;
  const evidenceItems = evidenceDrafts.map((draft) => ({
    draftReady: evidenceDraftIsReady(draft),
    file: evidenceFileForDraft(draft),
    method: draft.method,
    notes,
    value: evidenceValueForDraft(draft),
  }));
  const readyEvidenceItems = evidenceItems.filter((item) => item.draftReady);
  const readyEvidenceCount = readyEvidenceItems.length;
  const evidenceDraftCount = evidenceDrafts.length;
  const responseMeta = readyEvidenceCount
    ? `${readyEvidenceCount} ready${evidenceDraftCount > readyEvidenceCount ? ` / ${evidenceDraftCount} draft${evidenceDraftCount === 1 ? "" : "s"}` : ""}`
    : `${evidenceDraftCount} draft${evidenceDraftCount === 1 ? "" : "s"}`;
  const submissionProgressSteps = taskSubmissionProgressSteps({
    confirmed,
    pending: state.pending,
    pendingLabel: state.pendingLabel,
    readyEvidenceCount,
    submitted: state.submitted,
  });
  const canPrepareEvidence = Boolean(
    readyEvidenceCount > 0 &&
      !loading &&
      !state.pending &&
      signingEnabled &&
      submissionOpen &&
      confirmed
  );
  const helperText = signingEnabled
    ? signingReady
      ? directOffchain
        ? "Evidence is recorded directly in Task Node. The linked wallet is kept for attribution and rewards."
        : "Evidence is encrypted in this browser, pinned to IPFS, and published as a signed PFTL task pointer."
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
    setState({ error: "", pending: false, pendingLabel: "", result: "", submitted: false });
  }, [defaultEvidenceMethod, draftStorageKey, readPersistedDraftState]);

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
    if (clearStatus) setState({ error: "", pending: false, pendingLabel: "", result: "", submitted: false });
    setEvidenceDrafts(resetEvidenceDrafts(defaultEvidenceMethod));
  }

  function updateEvidenceDraft(id, key, value) {
    setState({ error: "", pending: false, pendingLabel: "", result: "", submitted: false });
    setConfirmed(false);
    setEvidenceDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, [key]: value } : draft))
    );
  }

  function addEvidenceDraft() {
    setEvidenceDrafts((current) => addUserRequestedEvidenceDraft(current, defaultEvidenceMethod));
    setConfirmed(false);
    setState({ error: "", pending: false, pendingLabel: "", result: "", submitted: false });
  }

  function removeEvidenceDraft(id) {
    setEvidenceDrafts((current) => {
      if (current.length <= 1) return current;
      return current.filter((draft) => draft.id !== id);
    });
    setConfirmed(false);
    setState({ error: "", pending: false, pendingLabel: "", result: "", submitted: false });
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
      submitted: false,
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
        result: key === "screenshot" ? "Screenshot read and compacted" : "File text extracted for verification",
        submitted: false,
      });
    } catch (error) {
      setState({
        error: error?.message || "Evidence file could not be read.",
        pending: false,
        pendingLabel: "",
        result: "",
        submitted: false,
      });
    }
  }

  async function submitEvidence() {
    if (!signingReady) {
      handleSigningUnlockAction(unlockPolicy, onWalletUnlock);
      return;
    }
    setState({
      error: "",
      pending: true,
      pendingLabel: directOffchain ? "Submitting evidence" : "Publishing evidence",
      result: "",
      submitted: false,
    });
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
            submitted: false,
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
        result: result?.txHash
          ? `${directOffchain ? "Recorded" : "Published"} ${truncateCid(result.txHash)}`
          : (directOffchain ? "Evidence recorded" : "Evidence published"),
        submitted: true,
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
        submitted: false,
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

      {submissionOpen && (
        <TaskWorkflowSteps
          ariaLabel="Evidence submission progress"
          className="task-submit-progress"
          steps={submissionProgressSteps}
        />
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
            meta={responseMeta}
          />
          <div className="task-evidence-list">
            {evidenceDrafts.map((draft, index) => {
              const activeMethodLabel = methods.find((method) => method.key === draft.method)?.label || "Text";
              return (
                <div className="task-evidence-card" key={draft.id}>
                  <div className="task-evidence-card-head">
                    <strong>Evidence {index + 1}: {activeMethodLabel} item</strong>
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
              );
            })}
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
              Add another evidence item
            </button>
          )}

      <div className="task-evidence-card">
        <label className="task-evidence-notes">
          <span>Notes for the verifier</span>
          <textarea
            onChange={(event) => {
              setNotes(event.target.value);
              setState({ error: "", pending: false, pendingLabel: "", result: "", submitted: false });
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
            checked={readyEvidenceCount > 0 && confirmed}
            disabled={readyEvidenceCount === 0 || state.pending}
            onChange={(event) => {
              if (readyEvidenceCount === 0) {
                setConfirmed(false);
                return;
              }
              setConfirmed(event.target.checked);
            }}
            type="checkbox"
          />
          {readyEvidenceCount > 0 ? "This evidence is ready to submit." : "Add evidence before marking it ready."}
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
