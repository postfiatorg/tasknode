import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Flag,
  X,
} from "lucide-react";
import { requestJson } from "../../api";
import {
  normalizeTaskStatus,
  taskIsTerminal,
  taskRequiresRefresh,
  taskStatusColor,
} from "../../../shared/task-lifecycle";
import { formatTaskTimestamp } from "../../../shared/task-time-format";
import { publishTaskLifecycleAction } from "./task-actions.js";
import { captureTaskActionRoute, restoreTaskActionRoute } from "./task-action-route.js";
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
import { TaskForensicsPanel } from "./TaskForensicsPanel.jsx";
import { taskForensicsIndexedEventCount } from "./task-forensics-state.js";
import {
  TaskDetailLoadingPanel,
  TaskStatusGlyph,
  cachedTaskDetailFromTask,
  formatIndexedEventCopy,
  readCachedTaskDetail,
  taskDetailCacheKey,
  taskIdentityKey,
  taskVersionKey,
  writeCachedTaskDetail,
} from "./TaskDetailPrimitives.jsx";
import { TaskOverviewPanel, TaskSubmitPanel } from "./TaskDetailPanels.jsx";
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

export function TaskDetailModal({
  accountId = "",
  directOffchainTaskLifecycle = false,
  escapeDisabled = false,
  linkedWalletAddress = "",
  onClose,
  onTaskActionReceipt,
  onTaskChanged,
  onWalletUnlock,
  pftlExplorerUrl = "",
  task,
  walletSecret = null,
  walletUnlockPending = false,
  walletVault = null,
}) {
  const taskVersion = taskVersionKey(task); const versionedTaskRef = useRef(task);
  if (taskVersionKey(versionedTaskRef.current) !== taskVersion) versionedTaskRef.current = task; const versionedTask = versionedTaskRef.current;
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
    () => cachedTaskDetailFromTask(versionedTask, { linkedWalletAddress }),
    [linkedWalletAddress, versionedTask]
  );
  const displayDetail = taskDetailDisplayData(detailState, projectionDetail);
  const displayTask = displayDetail?.task || task;
  const steps = Array.isArray(displayTask.steps) ? displayTask.steps : [];
  const verification = displayTask.verification || {};
  const rewardPft = Number(displayTask.pft || 0);
  const taskId = displayTask.taskId || displayTask.fullId || task.taskId || task.fullId || task.id || "";
  const currentTaskVisibleState = useMemo(() => visibleTaskStateFromTask(versionedTask), [versionedTask]);
  const taskBriefPayload = buildTaskCopyPayloads(displayTask, displayDetail).codex;
  const forensicsCount = taskForensicsIndexedEventCount({ detail: displayDetail, task: displayTask });
  const controlsBlocked = taskDetailControlsBlocked({ ...detailState, data: displayDetail });
  const normalizedStatusKey = normalizeTaskStatus(displayTask.statusKey || displayTask.status);
  const rewardPaidAt = displayDetail?.rewardOutcome?.paymentObservedAt || displayTask.lastEventAt || displayTask.updatedAt || "";
  const rewardPaidDisplay = formatTaskTimestamp(rewardPaidAt, { locale: "en-US" }) || displayTask.lastEventAtDisplay || displayTask.updatedAtDisplay || "Rewarded";
  const dueStatLabel = ["rewarded", "paid"].includes(normalizedStatusKey) ? "Paid" : displayTask.dueLabel || "Deadline";
  const dueStatValue = ["rewarded", "paid"].includes(normalizedStatusKey) ? rewardPaidDisplay : displayTask.fullDue;

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
          projectionDetail
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
  }, [commitTaskDetailResult, detailCacheKey, detailRefreshKey, projectionDetail, taskId, taskVersion]);

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
    const routeSnapshot = captureTaskActionRoute();
    let result;
    try {
      result = await publishTaskLifecycleAction({
        accountId,
        linkedWalletAddress,
        walletSecret,
        task: displayTask,
        detail: detailState.data,
        taskAction,
        reason,
      });
    } finally {
      restoreTaskActionRoute(routeSnapshot);
    }
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
    try {
      await onTaskChanged?.({ taskProjectionRefresh: true });
    } finally {
      restoreTaskActionRoute(routeSnapshot);
    }
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
              <small>{dueStatLabel}</small>
              <span>{dueStatValue}</span>
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
              <span>{formatIndexedEventCopy(forensicsCount)}</span>
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
              directOffchain={directOffchainTaskLifecycle}
              displayTask={displayTask}
              linkedWalletAddress={linkedWalletAddress}
              loading={controlsBlocked}
              copiedValue={copiedValue}
              onCopy={copyTaskValue}
              onLifecycleAction={handleLifecycleAction}
              onSelectTab={setActiveTab}
              onWalletUnlock={onWalletUnlock}
              pftlExplorerUrl={pftlExplorerUrl}
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
              directOffchain={directOffchainTaskLifecycle}
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
              pftlExplorerUrl={pftlExplorerUrl}
            />
          )}
        </div>
      </section>
    </div>
  );
}
