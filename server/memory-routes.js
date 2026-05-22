import { listChatMemory } from "./repositories/chat-memory.js";
import { getNetworkTaskProfileState } from "./repositories/network-task-profile.js";

export async function handleMemoryRoute({ json, req, res, session, url }) {
  if (!["/api/memory", "/api/memory/network-task-profile"].includes(url.pathname)) {
    return false;
  }

  if (!session?.accountId) {
    json(res, 401, {
      ok: false,
      error: "memory_login_required",
      message: "Sign in before reading memory.",
    });
    return true;
  }

  if (url.pathname === "/api/memory") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "memory_method_not_allowed",
        message: "Memory listing requires GET.",
      });
      return true;
    }
    json(res, 200, await listChatMemory({
      accountId: session.accountId,
      q: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit") || 100,
    }));
    return true;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    json(res, 405, {
      ok: false,
      error: "network_task_profile_method_not_allowed",
      message: "Network task profile supports GET and POST refresh.",
    });
    return true;
  }

  const result = await getNetworkTaskProfileState({
    accountId: session.accountId,
    force: req.method === "POST",
    reason: req.method === "POST" ? "manual_refresh" : "memory_page",
  });
  json(res, result.ok ? 200 : result.status || 400, result);
  return true;
}
