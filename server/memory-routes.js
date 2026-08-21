import {
  clearChatMemoryEntriesByKind,
  deleteChatMemoryEntry,
  listChatMemory,
} from "./repositories/chat-memory.js";
import {
  getNetworkTaskProfileState,
  resetNetworkTaskProfileMemory,
} from "./repositories/network-task-profile.js";

export async function handleMemoryRoute({ json, readJson, req, res, session, url }) {
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
    if (req.method !== "GET" && req.method !== "DELETE") {
      json(res, 405, {
        ok: false,
        error: "memory_method_not_allowed",
        message: "Memory supports GET and DELETE.",
      });
      return true;
    }

    if (req.method === "GET") {
      json(res, 200, await listChatMemory({
        accountId: session.accountId,
        q: url.searchParams.get("q") || "",
        limit: url.searchParams.get("limit") || 100,
      }));
      return true;
    }

    const payload = await readJson(req, 8192);
    const action = String(payload?.action || "").trim();
    let result;
    if (action === "delete_entry") {
      result = await deleteChatMemoryEntry({
        accountId: session.accountId,
        entryId: payload?.id || payload?.entryId || "",
      });
    } else if (action === "clear_deep_memory") {
      result = await clearChatMemoryEntriesByKind({
        accountId: session.accountId,
        kind: "deep_memory",
      });
    } else if (action === "clear_turn_memory") {
      result = await clearChatMemoryEntriesByKind({
        accountId: session.accountId,
        kind: "turn_memory",
      });
    } else if (action === "reset_network_profile") {
      result = await resetNetworkTaskProfileMemory({ accountId: session.accountId });
    } else {
      result = {
        ok: false,
        status: 400,
        error: "memory_delete_unknown_action",
        message: "Choose a supported memory delete action.",
      };
    }

    json(res, result.ok ? 200 : result.status || 400, result);
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
