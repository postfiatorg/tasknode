import { getTaskDetail, listTaskState } from "./repositories/tasks.js";

export async function handleTaskReadRoute({ getLinkedWallet, json, res, session, url }) {
  if (url.pathname === "/api/tasks") {
    const linkedWallet = getLinkedWallet({ accountId: session?.accountId || "" });
    json(res, 200, await listTaskState({
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

  return false;
}
