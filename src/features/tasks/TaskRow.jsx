import React from "react";
import { Copy } from "lucide-react";
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

export function TaskRow({ isFirst, onClick, onCopy, task }) {
  return (
    <article className={`task-row task-entry${isFirst ? " is-first" : ""}`}>
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
            <TaskDot />
            <span>{task.fullDue}</span>
            <TaskDot />
            <span>{task.ago}</span>
          </span>
        </span>
      </button>
      <button
        aria-label={`Copy ${task.title || "task"}`}
        className="task-copy-trigger toolbar-button"
        onClick={onCopy}
        title="Copy task"
        type="button"
      >
        <Copy size={14} strokeWidth={1.75} />
      </button>
      <span className="task-reward">
        <strong>{Number(task.pft || 0).toLocaleString()}</strong>
        <span>PFT</span>
      </span>
    </article>
  );
}
