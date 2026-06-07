import React from "react";
import { statusSlug, taskStatusColor } from "../../../shared/task-lifecycle";

function TaskStatusGlyph({ task }) {
  const statusKey = task?.statusKey || task?.status;
  if (statusKey === "refused" || statusKey === "rejected" || statusKey === "cancelled") {
    return (
      <svg className="task-status-x" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
        <path d="M2 2 L9 9 M9 2 L2 9" strokeLinecap="round" />
      </svg>
    );
  }
  return <span className={`task-status-glyph is-${statusSlug(statusKey)}`} aria-hidden="true" />;
}

function TaskDot() {
  return <span className="task-dot" aria-hidden="true" />;
}

export function TaskRow({ isFirst, onClick, task }) {
  const dueText = task.dueLabel && task.dueLabel !== "Deadline" ? `${task.dueLabel} ${task.fullDue}` : task.fullDue;
  const syncLabel = task.clientSyncLabel || (task.integrity?.projectionBehindCachedPointer ? "updating" : "");
  return (
    <article className={`task-row task-entry${isFirst ? " is-first" : ""}${task.isNetworkTask ? " is-network-task" : ""}${syncLabel ? " is-syncing" : ""}`}>
      <button className="task-entry-open" onClick={onClick} type="button">
        <span className="task-entry-signal">
          <TaskStatusGlyph task={task} />
        </span>
        <span className="task-entry-main">
          <span className="task-title">{task.title}</span>
          <span className="task-meta">
            <strong>{task.kind}</strong>
            <TaskDot />
            <span className="task-status-text" style={{ color: task.statusColor || taskStatusColor(task.statusKey) }}>
              {task.status}
            </span>
            {syncLabel && (
              <>
                <TaskDot />
                <span className="task-sync-inline" title={task.clientSyncDetail || "Task state is updating."}>
                  {syncLabel}
                </span>
              </>
            )}
            <TaskDot />
            <span>{dueText}</span>
            <TaskDot />
            <span>{task.ago}</span>
          </span>
        </span>
      </button>
      <span className="task-reward">
        <strong>{Number(task.pft || 0).toLocaleString()}</strong>
        <span>PFT</span>
      </span>
    </article>
  );
}
