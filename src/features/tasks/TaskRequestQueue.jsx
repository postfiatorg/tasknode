import React from "react";

function statusSlug(status = "") {
  return String(status || "published")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function requestTitle(request = {}) {
  return request.userDetailText || request.requestText || "Task request";
}

function requestAgeMs(request = {}) {
  const timestamp = Date.parse(request.updatedAt || request.createdAt || "");
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

export function activeTaskRequests(requests = []) {
  return (Array.isArray(requests) ? requests : []).filter((request) => {
    if (request?.isActive === true) return true;
    if (request?.isActive === false) return false;
    const status = String(request?.status || "").trim().toLowerCase();
    if (!status || status === "proposed" || status === "cancelled") return false;
    if (status === "failed") return requestAgeMs(request) < 24 * 60 * 60 * 1000;
    if (["signing", "queued", "generating"].includes(status)) return true;
    if (status === "published") return requestAgeMs(request) < 20 * 60 * 1000 && !request.generatedTaskId;
    return false;
  });
}

function TaskRequestRow({ request }) {
  const statusClass = statusSlug(request.status);
  return (
    <article className={`task-request-row is-${statusClass}`}>
      <span className="task-request-status-dot" aria-hidden="true" />
      <div className="task-request-row-main">
        <div className="task-request-row-top">
          <strong>{request.statusLabel || "Published to PFT"}</strong>
          <span>{request.ago || "just now"}</span>
        </div>
        <p>{requestTitle(request)}</p>
        {request.lastError && <p className="task-request-row-error">{request.lastError}</p>}
      </div>
    </article>
  );
}

export function TaskRequestQueue({ requests = [] }) {
  const activeRequests = activeTaskRequests(requests);
  if (!activeRequests.length) return null;
  const primary = activeRequests[0];
  const extraCount = activeRequests.length - 1;
  if (activeRequests.length === 1) {
    return (
      <section className="task-request-queue" aria-label="Active task request">
        <TaskRequestRow request={primary} />
      </section>
    );
  }

  return (
    <section className="task-request-queue" aria-label="Active task request">
      <div className="task-request-queue-head">
        <div>
          <strong>Task requests</strong>
          <span>{activeRequests.length} processing</span>
        </div>
        {extraCount > 0 && <em>+{extraCount}</em>}
      </div>
      <div className="task-request-queue-list">
        {activeRequests.slice(0, 2).map((request) => (
          <TaskRequestRow key={request.requestId} request={request} />
        ))}
      </div>
    </section>
  );
}
