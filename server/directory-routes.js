import { getDirectoryLeaderboardDocument } from "./repositories/directory-leaderboard.js";
import {
  getDirectoryRewardedTasksDocument,
  normalizeDirectoryRewardedTaskKind,
} from "./repositories/directory-rewarded-tasks.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";

async function recordDirectoryObservabilityEvent({
  accountId = "",
  eventType = "user.directory.leaderboard_viewed",
  resultStatus = "",
  sourceRoute = "",
  metrics = {},
} = {}) {
  if (!accountId) return;
  await recordUserObservabilityEvent({
    eventType,
    accountId,
    sourceSurface: "directory",
    sourceRoute: sourceRoute || "server/directory-routes.js",
    resultStatus,
    metrics,
  }).catch(() => {});
}

export async function handleDirectoryRoute({
  json,
  req,
  res,
  session,
  url,
  rewardedTasksReader = getDirectoryRewardedTasksDocument,
} = {}) {
  if (!["/api/directory/leaderboard", "/api/directory/rewarded-tasks"].includes(url.pathname)) return false;

  if (url.pathname === "/api/directory/leaderboard" && req.method !== "GET") {
    json(res, 405, {
      ok: false,
      error: "directory_leaderboard_method_not_allowed",
      message: "Directory leaderboard supports GET.",
    });
    return true;
  }

  if (url.pathname === "/api/directory/leaderboard") {
    const document = await getDirectoryLeaderboardDocument({
      viewerAccountId: session?.accountId || "",
    });
    await recordDirectoryObservabilityEvent({
      accountId: session?.accountId || "",
      resultStatus: "viewed",
      sourceRoute: "server/directory-routes.js::/api/directory/leaderboard",
      metrics: {
        operatorCount: Array.isArray(document?.operators) ? document.operators.length : 0,
        tasksRewarded: Number(document?.totals?.tasksRewarded || 0),
        pftDistributed: Number(document?.totals?.pftDistributed || 0),
      },
    });

    json(res, 200, {
      ok: true,
      document,
    });
    return true;
  }

  if (req.method !== "GET") {
    json(res, 405, {
      ok: false,
      error: "directory_rewarded_tasks_method_not_allowed",
      message: "Directory rewarded tasks supports GET.",
    });
    return true;
  }

  const taskKind = normalizeDirectoryRewardedTaskKind(url.searchParams.get("taskKind") || "network");
  if (!taskKind) {
    json(res, 400, {
      ok: false,
      error: "directory_rewarded_tasks_invalid_task_kind",
      message: "taskKind must be network or personal.",
    });
    return true;
  }
  const document = await rewardedTasksReader({
    taskKind,
    limit: url.searchParams.get("limit") || undefined,
  });
  if (document?.ok === false) {
    json(res, document.status || 400, document);
    return true;
  }
  await recordDirectoryObservabilityEvent({
    accountId: session?.accountId || "",
    eventType: "user.directory.rewarded_tasks_viewed",
    resultStatus: "viewed",
    sourceRoute: "server/directory-routes.js::/api/directory/rewarded-tasks",
    metrics: {
      taskKind,
      taskCount: Array.isArray(document?.tasks) ? document.tasks.length : 0,
      rewardActualPft: Number(document?.totals?.rewardActualPft || 0),
    },
  });

  json(res, 200, {
    ok: true,
    document,
  });
  return true;
}
