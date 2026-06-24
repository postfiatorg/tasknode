import { getTaskDetail, listTaskState } from "./repositories/tasks.js";
import { invalidateCachedAppState } from "./app-state.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import { scheduleLinkedWalletTaskProjectionRefresh } from "./task-projection-refresh.js";
import { listTaskRequests } from "./repositories/task-requests.js";
import { conversationIdForSession } from "./runtime-store.js";
import { taskLifecycleAction } from "./task-actions.js";
import { taskRequestAction } from "./task-request.js";
import { taskSubmissionAction } from "./task-submission.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function normalizeTaskAction(value = "") {
  const action = safeText(value, 40).toLowerCase();
  if (["accept", "accepted"].includes(action)) return "accept";
  if (["refuse", "refused", "reject", "rejected"].includes(action)) return "refuse";
  if (["cancel", "cancelled"].includes(action)) return "cancel";
  return action;
}

function taskClickEventType(taskAction = "") {
  const action = normalizeTaskAction(taskAction);
  if (action === "accept") return "user.task.accept_clicked";
  if (action === "refuse") return "user.task.refuse_clicked";
  return "user.task.action_published";
}

function taskVisibilityEventType(status = "") {
  const normalized = safeText(status, 80).toLowerCase();
  if (normalized === "proposed") return "user.task.offer_visible";
  if (normalized === "verification_requested") return "user.task.verification_requested";
  if (["reward_decided", "rewarded", "completed"].includes(normalized)) return "user.task.reward_projected";
  return "";
}

function taskMutationSubmitted(payload = {}, result = {}) {
  if (result?.body?.ok !== true) return false;
  const phase = safeText(payload?.phase || result?.body?.phase || "", 80);
  return phase === "submit" || Boolean(payload?.signedTxBlob || payload?.signed_tx_blob);
}

function linkedWalletAddressForEvent(getLinkedWallet, session) {
  const linkedWallet = getLinkedWallet({ accountId: session?.accountId || "" });
  return linkedWallet.status === "linked" ? linkedWallet.address || "" : "";
}

async function recordTaskRouteEvent({
  eventType = "",
  getLinkedWallet,
  payload = {},
  result = {},
  session = null,
  sourceRoute = "",
} = {}) {
  const body = result?.body || {};
  const taskAction = normalizeTaskAction(payload?.taskAction || payload?.task_action);
  const phase = safeText(payload?.phase || body.phase || "", 80);
  const walletAddress = linkedWalletAddressForEvent(getLinkedWallet, session);
  await recordUserObservabilityEvent({
    eventType,
    accountId: session?.accountId || body.accountId || "",
    walletAddress,
    walletScope: walletAddress ? "subject_wallet" : "",
    requestId: body.requestId || payload?.requestId || payload?.request_id || "",
    taskId: body.taskId || payload?.taskId || payload?.task_id || "",
    txHash: body.txHash || body.tx_hash || "",
    cid: body.cid || body.eventCid || payload?.cid || payload?.eventCid || "",
    sourceSurface: "tasks",
    sourceRoute,
    resultStatus: body.ok ? "ok" : body.error || "failed",
    reasonCode: body.ok ? "" : body.error || "",
    decision: {
      phase,
      task_action: taskAction,
      ok: body.ok === true,
      status: body.status || "",
      error: body.error || "",
      reason_present: Boolean(payload?.reason),
    },
    metrics: {
      responseStatus: Number(result?.status || 0),
    },
    metadata: {
      action: body.action || "",
      message: body.message || "",
      submissionMode: body.submissionMode || "",
      schema: body.schema || "",
    },
  }).catch(() => {});
}

export async function handleTaskReadRoute({ getLinkedWallet, json, readJson, req, res, session, url }) {
  if (url.pathname === "/api/tasks") {
    const linkedWallet = getLinkedWallet({ accountId: session?.accountId || "" });
    const walletAddress = linkedWallet.status === "linked" ? linkedWallet.address || "" : "";
    if (url.searchParams.get("refreshProjection") === "1" && walletAddress) {
      scheduleLinkedWalletTaskProjectionRefresh({
        accountId: session?.accountId || "",
        walletAddress,
        syncKind: "task_list_refresh",
      });
    }
    json(res, 200, await listTaskState({
      accountId: session?.accountId || "",
      walletAddress,
    }));
    return true;
  }

  if (url.pathname === "/api/tasks/requests") {
    const linkedWallet = getLinkedWallet({ accountId: session?.accountId || "" });
    json(res, 200, await listTaskRequests({
      accountId: session?.accountId || "",
      walletAddress: linkedWallet.status === "linked" ? linkedWallet.address || "" : "",
    }));
    return true;
  }

  if (url.pathname === "/api/tasks/detail") {
    const linkedWallet = getLinkedWallet({ accountId: session?.accountId || "" });
    const walletAddress = linkedWallet.status === "linked" ? linkedWallet.address || "" : "";
    const taskId = url.searchParams.get("taskId") || "";
    if (!taskId.trim()) {
      json(res, 400, {
        ok: false,
        error: "task_id_required",
        message: "A taskId query parameter is required.",
      });
      return true;
    }
    if (url.searchParams.get("refreshProjection") === "1" && walletAddress) {
      scheduleLinkedWalletTaskProjectionRefresh({
        accountId: session?.accountId || "",
        walletAddress,
        syncKind: "task_detail_refresh",
      });
    }

    const detail = await getTaskDetail({
      accountId: session?.accountId || "",
      walletAddress,
      taskId,
    });
    if (!detail) {
      json(res, 404, {
        ok: false,
        error: "task_not_found",
        message: "No indexed task projection was found for the linked wallet.",
      });
      return true;
    }

    await recordUserObservabilityEvent({
      eventType: "user.task.detail_opened",
      accountId: session?.accountId || "",
      walletAddress,
      walletScope: walletAddress ? "subject_wallet" : "",
      taskId,
      sourceSurface: "tasks",
      sourceRoute: "GET /api/tasks/detail",
      resultStatus: "ok",
      metadata: {
        status: detail?.task?.statusKey || detail?.task?.status || "",
        title: detail?.task?.title || "",
      },
    }).catch(() => {});
    const statusKey = detail?.task?.statusKey || detail?.task?.status || "";
    const visibilityEventType = taskVisibilityEventType(statusKey);
    if (visibilityEventType) {
      await recordUserObservabilityEvent({
        eventType: visibilityEventType,
        accountId: session?.accountId || "",
        walletAddress,
        walletScope: walletAddress ? "subject_wallet" : "",
        taskId,
        sourceSurface: "tasks",
        sourceRoute: "GET /api/tasks/detail",
        resultStatus: "visible",
        reasonCode: statusKey,
        metadata: {
          status: statusKey,
          taskKind: detail?.task?.taskKind || detail?.task?.kind || "",
          rewardPft: Number(detail?.task?.pft || 0),
        },
      }).catch(() => {});
    }

    json(res, 200, detail);
    return true;
  }

  if (url.pathname === "/api/tasks/action") {
    const payload = req.method === "POST" ? await readJson(req, 1_200_000) : {};
    const result = await taskLifecycleAction(payload, req.method, session);
    const phase = safeText(payload?.phase || result?.body?.phase || "", 80);
    const action = normalizeTaskAction(payload?.taskAction || payload?.task_action);
    const eventType = result.body?.ok
      ? phase === "prepare"
        ? taskClickEventType(action)
        : phase === "submit" || payload?.signedTxBlob || payload?.signed_tx_blob
          ? "user.task.action_published"
          : ""
      : "user.task.action_failed";
    if (eventType) {
      await recordTaskRouteEvent({
        eventType,
        getLinkedWallet,
        payload,
        result,
        session,
        sourceRoute: "POST /api/tasks/action",
      });
    }
    if (taskMutationSubmitted(payload, result)) invalidateCachedAppState(session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/tasks/submission") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const result = await taskSubmissionAction(payload, req.method, session);
    const phase = safeText(payload?.phase || result?.body?.phase || "", 80);
    const submitted = phase === "submit" || payload?.signedTxBlob || payload?.signed_tx_blob;
    const eventType = result.body?.ok
      ? submitted
        ? "user.task.submission_published"
        : ""
      : "user.task.action_failed";
    if (eventType) {
      await recordTaskRouteEvent({
        eventType,
        getLinkedWallet,
        payload,
        result,
        session,
        sourceRoute: "POST /api/tasks/submission",
      });
    }
    if (taskMutationSubmitted(payload, result)) invalidateCachedAppState(session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/tasks/request") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const conversationId = conversationIdForSession(session, payload?.conversationId || "");
    const result = await taskRequestAction({ ...payload, conversationId }, req.method, session);
    const phase = safeText(payload?.phase || result?.body?.phase || "", 80);
    const eventType = result.body?.ok
      ? phase === "submit"
        ? "user.task.request_published"
        : ""
      : "user.task.action_failed";
    if (eventType) {
      await recordTaskRouteEvent({
        eventType,
        getLinkedWallet,
        payload: { ...payload, conversationId },
        result,
        session,
        sourceRoute: "POST /api/tasks/request",
      });
    }
    json(res, result.status, result.body);
    return true;
  }

  return false;
}
