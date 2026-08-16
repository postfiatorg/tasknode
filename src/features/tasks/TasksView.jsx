import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flag, MoreHorizontal, Plus, Trophy } from "lucide-react";
import { NetworkTaskEligibilityPanel } from "./NetworkTaskEligibilityPanel.jsx";
import { firstActiveCapacityBlockerTaskId } from "./network-task-eligibility-state.js";
import { TaskRequestModal } from "./TaskRequestModal.jsx";
import { TaskRequestQueue } from "./TaskRequestQueue.jsx";
import { TaskRow } from "./TaskRow.jsx";
import { settledTaskRequestHasVisibleOutstanding, shouldRevealSettledOutstandingTask, shouldStartTaskRequestSettle, taskRequestSettleDeadline } from "./task-refresh-policy.js";
import { findTaskById, outstandingTaskKindCounts, reconcileTaskVisibleState } from "./task-visible-state.js";
import { EmptyState } from "../chat/AppChatDialogs.jsx";
import { EMPTY_TASKS, recordClientObservabilityEvent } from "../../app/app-shell-shared.jsx";

export function TasksView({
  accountId = "",
  directOffchainTaskLifecycle = false,
  linkedWalletAddress = "",
  onRequestSettled,
  onSelectTask,
  onWalletUnlock,
  tasks = EMPTY_TASKS,
  walletSecret = null,
  walletUnlockPending = false,
  walletVault = {},
}) {
  const [tasksTab, setTasksTab] = useState("outstanding");
  const [taskRequestOpen, setTaskRequestOpen] = useState(false);
  const [taskRequestSettleUntilMs, setTaskRequestSettleUntilMs] = useState(0);
  const [taskReadFailureCount, setTaskReadFailureCount] = useState(0);
  const didAutoSelectTaskTabRef = useRef(false);
  const lastTaskFocusRefreshRef = useRef(0);
  const lastTaskHandoffKeyRef = useRef("");
  const lastTaskProjectionCountRef = useRef(null);
  const lastTaskSyncWarningEventRef = useRef("");
  const previousActiveRequestCountRef = useRef(0);
  // Stateful exponential-backoff counter for temporary task-read failures.
  // The pure policy modules stay stateless; each consecutive failing snapshot
  // increments the counter and the first healthy snapshot resets it.
  useEffect(() => {
    const syncStatus = String(tasks?.sync?.status || "");
    const readFailing = syncStatus === "database_error" || syncStatus === "integrity_unavailable";
    setTaskReadFailureCount((current) => (readFailing ? Math.min(current + 1, 6) : 0));
  }, [tasks]);

  const visibleState = useMemo(() => reconcileTaskVisibleState({
    accountId,
    directOffchain: directOffchainTaskLifecycle,
    linkedWalletAddress,
    taskReadFailureCount,
    taskRequestSettleUntilMs,
    tasks,
    tasksTab,
  }), [accountId, directOffchainTaskLifecycle, linkedWalletAddress, taskReadFailureCount, taskRequestSettleUntilMs, tasks, tasksTab]);
  const {
    activeRequests,
    activeRequestCount,
    attentionRequests,
    counts,
    currentTabTasks,
    outstanding,
    polling,
    processingRequests,
    rewarded,
    sync: taskSync,
    tabs,
    taskSyncNotice,
    totalPftInFlight,
    verification,
  } = visibleState;
  const {
    shouldForceTaskProjection,
    shouldRefreshTaskState,
    taskRefreshMs,
    taskRequestSettling,
  } = polling;
  const outstandingCount = counts.outstanding;
  const taskRequestHandoff = taskSync?.handoff || {};
  const activeCapacityTaskId = firstActiveCapacityBlockerTaskId(tasks?.networkTasks);
  const activeCapacityTask = activeCapacityTaskId ? findTaskById(visibleState.tasks, activeCapacityTaskId) : null;
  const outstandingKindCounts = outstandingTaskKindCounts(outstanding);
  const requestTaskButtonClass = activeCapacityTask
    ? "light-pill task-request-button"
    : "dark-pill task-request-button";
  const requestTaskButtonLabel = activeCapacityTask ? "Request personal task" : "Request task";

  useEffect(() => {
    const syncStatus = String(taskSync?.status || "");
    const warningVisible = Boolean(taskSyncNotice) || attentionRequests.length > 0;
    if (!warningVisible) {
      lastTaskSyncWarningEventRef.current = "";
      return;
    }
    const reasonCode = taskSyncNotice
      ? syncStatus || "task_sync_warning"
      : "task_requests_need_attention";
    const eventKey = [
      linkedWalletAddress,
      reasonCode,
      attentionRequests.length,
      Number(taskSync?.failedReducerCount || 0),
      Number(taskSync?.indexingLagCount || 0),
    ].join("|");
    if (eventKey === lastTaskSyncWarningEventRef.current) return;
    recordClientObservabilityEvent({
      eventType: "user.ui.sync_warning_shown",
      walletAddress: linkedWalletAddress,
      walletScope: linkedWalletAddress ? "active" : "unknown",
      sourceSurface: "tasks",
      sourceRoute: "src/main.jsx::TasksView",
      resultStatus: "shown",
      reasonCode,
      metadata: {
        label: taskSyncNotice?.label || "Task requests need attention",
        syncStatus,
        attentionRequestIds: attentionRequests.slice(0, 5).map((request) => request.requestId || "").filter(Boolean),
      },
      metrics: {
        attentionRequestCount: attentionRequests.length,
        failedReducerCount: Number(taskSync?.failedReducerCount || 0),
        indexingLagCount: Number(taskSync?.indexingLagCount || 0),
        projectionCount: Number(taskSync?.projectionCount || 0),
      },
    });
    lastTaskSyncWarningEventRef.current = eventKey;
  }, [
    attentionRequests,
    linkedWalletAddress,
    taskSync?.failedReducerCount,
    taskSync?.indexingLagCount,
    taskSync?.projectionCount,
    taskSync?.status,
    taskSyncNotice,
  ]);

  useEffect(() => {
    if (didAutoSelectTaskTabRef.current) return;
    if (tasksTab !== "outstanding") return;
    if (outstanding.length > 0 || verification.length > 0 || rewarded.length === 0) return;
    didAutoSelectTaskTabRef.current = true;
    setTasksTab("rewarded");
  }, [outstanding.length, rewarded.length, tasksTab, verification.length]);

  useEffect(() => {
    if (!settledTaskRequestHasVisibleOutstanding({
      outstandingCount: outstanding.length,
      taskRequestSettling,
    })) return;
    if (shouldRevealSettledOutstandingTask({
      currentTab: tasksTab,
      outstandingCount: outstanding.length,
      taskRequestSettling,
    })) {
      setTasksTab("outstanding");
    }
    setTaskRequestSettleUntilMs(0);
  }, [outstanding.length, taskRequestSettling, tasksTab]);

  useEffect(() => {
    const previous = previousActiveRequestCountRef.current;
    if (shouldStartTaskRequestSettle({
      previousActiveRequestCount: previous,
      currentActiveRequestCount: activeRequestCount,
    })) {
      setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
    }
    previousActiveRequestCountRef.current = activeRequestCount;
  }, [activeRequestCount]);

  useEffect(() => {
    const projectionCount = Number(taskSync?.projectionCount || 0);
    if (lastTaskProjectionCountRef.current === null) {
      lastTaskProjectionCountRef.current = projectionCount;
      return;
    }
    if (projectionCount > lastTaskProjectionCountRef.current) {
      setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
    }
    lastTaskProjectionCountRef.current = projectionCount;
  }, [taskSync?.projectionCount]);

  useEffect(() => {
    const handoffKey = [
      taskRequestHandoff.latestRequestId || "",
      taskRequestHandoff.latestRequestStatus || "",
      taskRequestHandoff.generatedTaskId || "",
      taskRequestHandoff.generatedTaskVisible ? "visible" : "pending",
      taskRequestHandoff.latestRequestUpdatedAt || "",
      taskRequestHandoff.requestHandoffState || "",
    ].join("|");
    if (!handoffKey.replace(/\|/g, "")) return;
    const shouldSettleHandoff = ["generated_visible", "generated_projection_pending"].includes(taskRequestHandoff.requestHandoffState);
    if (!lastTaskHandoffKeyRef.current) {
      lastTaskHandoffKeyRef.current = handoffKey;
      if (shouldSettleHandoff) setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
      return;
    }
    if (handoffKey === lastTaskHandoffKeyRef.current) return;
    lastTaskHandoffKeyRef.current = handoffKey;
    if (shouldSettleHandoff) {
      setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
    }
  }, [
    taskRequestHandoff.generatedTaskId,
    taskRequestHandoff.generatedTaskVisible,
    taskRequestHandoff.latestRequestId,
    taskRequestHandoff.latestRequestStatus,
    taskRequestHandoff.latestRequestUpdatedAt,
    taskRequestHandoff.requestHandoffState,
  ]);

  const refreshCanonicalTaskState = useCallback(
    ({ taskProjectionRefresh = true } = {}) => {
      if (typeof onRequestSettled !== "function") return null;
      return onRequestSettled({ taskProjectionRefresh });
    },
    [onRequestSettled]
  );

  const handleTaskRequestRecorded = useCallback(
    async () => {
      setTaskRequestSettleUntilMs(taskRequestSettleDeadline());
      return refreshCanonicalTaskState({ taskProjectionRefresh: true });
    },
    [refreshCanonicalTaskState]
  );

  useEffect(() => {
    if (!shouldRefreshTaskState || typeof onRequestSettled !== "function") return undefined;
    const refresh = window.setInterval(() => {
      if (taskRequestSettling && Date.now() >= taskRequestSettleUntilMs) {
        setTaskRequestSettleUntilMs(0);
        return;
      }
      Promise.resolve(refreshCanonicalTaskState({ taskProjectionRefresh: shouldForceTaskProjection })).catch(() => null);
    }, taskRefreshMs);
    return () => window.clearInterval(refresh);
  }, [
    onRequestSettled,
    refreshCanonicalTaskState,
    shouldForceTaskProjection,
    shouldRefreshTaskState,
    taskRefreshMs,
    taskRequestSettleUntilMs,
    taskRequestSettling,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return undefined;
    if (typeof onRequestSettled !== "function") return undefined;

    const refreshVisibleTaskState = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastTaskFocusRefreshRef.current < 1000) return;
      lastTaskFocusRefreshRef.current = now;
      Promise.resolve(refreshCanonicalTaskState({ taskProjectionRefresh: true })).catch(() => null);
    };

    window.addEventListener("focus", refreshVisibleTaskState);
    document.addEventListener("visibilitychange", refreshVisibleTaskState);
    return () => {
      window.removeEventListener("focus", refreshVisibleTaskState);
      document.removeEventListener("visibilitychange", refreshVisibleTaskState);
    };
  }, [onRequestSettled, refreshCanonicalTaskState]);

  const emptyCopy = {
    outstanding: {
      icon: Flag,
      title: tasks?.sync?.status === "wallet_required" ? "Link a wallet to view tasks" : "No outstanding tasks",
      desc: "Tasks appear here after signed offers or updates finish syncing for your linked wallet.",
    },
    verification: {
      icon: Trophy,
      title: "Nothing awaiting verification",
      desc: "Tasks move here when someone asks for more evidence or review.",
    },
    refused: {
      icon: MoreHorizontal,
      title: "No refused tasks",
      desc: "Refused, rejected, expired, and cancelled tasks appear here.",
    },
    rewarded: {
      icon: Trophy,
      title: "No rewarded tasks",
      desc: "Paid tasks appear here after the reward is synced.",
    },
  }[tasksTab];

  return (
    <div className="route-scroll">
      <div className="tasks-view tasks-copy-surface">
        <div className="tasks-copy-header">
          <div>
            <h1>Tasks</h1>
            <p>
              <strong>{outstandingCount} outstanding</strong>
              {outstandingCount > 0 && (
                <>
                  <span aria-hidden="true">.</span>
                  <span className="task-outstanding-breakdown">
                    {outstandingKindCounts.network} Network / {outstandingKindCounts.personal} Personal
                  </span>
                </>
              )}
              <span aria-hidden="true">.</span>
              <span className="task-in-flight">{totalPftInFlight.toLocaleString()} PFT in flight</span>
              {tasks?.sync?.projectionCount > 0 && (
                <>
                  <span aria-hidden="true">.</span>
                  <span>{tasks.sync.projectionCount} task records synced</span>
                </>
              )}
              {processingRequests.length > 0 && (
                <>
                  <span aria-hidden="true">.</span>
                  <span>{processingRequests.length} requests processing</span>
                </>
              )}
              {attentionRequests.length > 0 && (
                <>
                  <span aria-hidden="true">.</span>
                  <span>{attentionRequests.length} requests need attention</span>
                </>
              )}
            </p>
            <NetworkTaskEligibilityPanel
              networkTasks={tasks?.networkTasks}
            />
          </div>
          <div className="tasks-header-actions">
            <button className={requestTaskButtonClass} onClick={() => setTaskRequestOpen(true)} type="button">
              <Plus size={16} strokeWidth={2} />
              {requestTaskButtonLabel}
            </button>
          </div>
        </div>

        <TaskRequestQueue requests={activeRequests} />

        {taskSyncNotice && (
          <div className="tasks-sync-notice" role="status">
            <strong>{taskSyncNotice.label}</strong>
            <p>{taskSyncNotice.body}</p>
          </div>
        )}

        <div className="tab-row tasks-copy-tabs">
          {tabs.map((tab) => {
            const active = tasksTab === tab.key;
            return (
              <button
                className={active ? "active" : ""}
                key={tab.key}
                onClick={() => setTasksTab(tab.key)}
                type="button"
              >
                {tab.label}
                <span>{tab.count}</span>
              </button>
            );
          })}
        </div>

        {currentTabTasks.length > 0 ? (
          <div className="task-list task-entry-list">
            {currentTabTasks.map((task, index) => (
              <TaskRow
                isFirst={index === 0}
                key={task.taskId || task.fullId || task.id}
                onClick={() => onSelectTask(task)}
                task={task}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={emptyCopy.icon}
            title={emptyCopy.title}
            desc={emptyCopy.desc}
          />
        )}
        {taskRequestOpen && (
          <TaskRequestModal
            accountId={accountId}
            directOffchain={directOffchainTaskLifecycle}
            linkedWalletAddress={linkedWalletAddress}
            onClose={() => setTaskRequestOpen(false)}
            onRecorded={handleTaskRequestRecorded}
            onWalletUnlock={onWalletUnlock}
            walletSecret={walletSecret}
            walletUnlockPending={walletUnlockPending}
            walletVault={walletVault}
          />
        )}
      </div>
    </div>
  );
}
