import { getDirectoryLeaderboardDocument } from "./repositories/directory-leaderboard.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";

async function recordDirectoryObservabilityEvent({
  accountId = "",
  resultStatus = "",
  sourceRoute = "",
  metrics = {},
} = {}) {
  if (!accountId) return;
  await recordUserObservabilityEvent({
    eventType: "user.directory.leaderboard_viewed",
    accountId,
    sourceSurface: "directory",
    sourceRoute: sourceRoute || "server/directory-routes.js",
    resultStatus,
    metrics,
  }).catch(() => {});
}

export async function handleDirectoryRoute({ json, req, res, session, url }) {
  if (url.pathname !== "/api/directory/leaderboard") return false;

  if (req.method !== "GET") {
    json(res, 405, {
      ok: false,
      error: "directory_leaderboard_method_not_allowed",
      message: "Directory leaderboard supports GET.",
    });
    return true;
  }

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
