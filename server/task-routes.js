import { getTaskDetail, listTaskState } from "./repositories/tasks.js";
import { listTaskRequests } from "./repositories/task-requests.js";
import { conversationIdForSession } from "./runtime-store.js";
import { taskLifecycleAction } from "./task-actions.js";
import { taskRequestAction } from "./task-request.js";
import { taskSubmissionAction } from "./task-submission.js";

export async function handleTaskReadRoute({ getLinkedWallet, json, readJson, req, res, session, url }) {
  if (url.pathname === "/api/tasks") {
    const linkedWallet = getLinkedWallet({ accountId: session?.accountId || "" });
    json(res, 200, await listTaskState({
      accountId: session?.accountId || "",
      walletAddress: linkedWallet.status === "linked" ? linkedWallet.address || "" : "",
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
    const taskId = url.searchParams.get("taskId") || "";
    if (!taskId.trim()) {
      json(res, 400, {
        ok: false,
        error: "task_id_required",
        message: "A taskId query parameter is required.",
      });
      return true;
    }

    const detail = await getTaskDetail({
      accountId: session?.accountId || "",
      walletAddress: linkedWallet.status === "linked" ? linkedWallet.address || "" : "",
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

    json(res, 200, detail);
    return true;
  }

  if (url.pathname === "/api/tasks/action") {
    const payload = req.method === "POST" ? await readJson(req, 1_200_000) : {};
    const result = await taskLifecycleAction(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/tasks/submission") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const result = await taskSubmissionAction(payload, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/tasks/request") {
    const payload = req.method === "POST" ? await readJson(req, 8 * 1024 * 1024) : {};
    const conversationId = conversationIdForSession(session, payload?.conversationId || "");
    const result = await taskRequestAction({ ...payload, conversationId }, req.method, session);
    json(res, result.status, result.body);
    return true;
  }

  return false;
}
