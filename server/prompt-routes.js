import { getTerminalSessionByToken } from "./repositories/terminal-auth.js";
import {
  registerPromptDevice,
  listPromptDevices,
  approvePromptDevice,
  revokePromptDevice,
  authorizePromptDevice,
} from "./repositories/prompt-devices.js";
import {
  promptFailure,
  appendPromptEvent,
  getPromptKey,
  initializePromptKey,
  listPromptEvents,
} from "./repositories/prompt-history.js";
import { createAgentPromptDocument, listPromptDocuments } from "./repositories/prompt-documents.js";

const promptPrefix = "/api/docs/prompts/";
const deviceEndpoints = new Set(["device-key", "history", "documents", "config"]);
const envelopeBodyLimit = 2_100_000;

async function handleBrowserDeviceRequest({ endpoint, req, accountId, readJson }) {
  if (endpoint === "devices") {
    if (req.method === "GET") return listPromptDevices(accountId);
    if (req.method === "POST") return promptFailure("terminal_required", 403);
  }
  if (endpoint === "devices/approve" && req.method === "POST") {
    const body = await readJson(req, 10_000);
    return approvePromptDevice(accountId, body.deviceId, body.envelope);
  }
  if (endpoint === "devices/revoke" && req.method === "POST") {
    const body = await readJson(req, 10_000);
    return revokePromptDevice(accountId, body.deviceId);
  }
  return null;
}

async function handleLibraryRequest({ endpoint, req, url, accountId, bearer, readJson }) {
  if (endpoint === "config" && req.method === "GET") {
    return { ok: true, pfdocsOrigin: process.env.PFDOCS_PUBLIC_ORIGIN || process.env.VITE_PFDOCS_ORIGIN || "" };
  }
  if (endpoint === "documents") {
    if (req.method === "GET") return listPromptDocuments(accountId);
    if (req.method === "POST" && bearer) {
      return createAgentPromptDocument(accountId, await readJson(req, envelopeBodyLimit));
    }
  }
  if (endpoint === "key") {
    if (req.method === "GET") return getPromptKey(accountId);
    if (req.method === "POST") {
      const body = await readJson(req, envelopeBodyLimit);
      return initializePromptKey(accountId, body.envelope);
    }
  }
  if (endpoint === "history") {
    if (req.method === "GET") return listPromptEvents(accountId, url.searchParams.get("after") || "");
    if (req.method === "POST") return appendPromptEvent(accountId, await readJson(req, envelopeBodyLimit));
  }
  return null;
}

export async function handlePromptRoute({ req, res, url, session, json, readJson }) {
  if (!url.pathname.startsWith(promptPrefix)) return false;
  if (process.env.TASKNODE_DOCS_ENABLED === "false") {
    json(res, 503, { ok: false, error: "docs_disabled" });
    return true;
  }
  const bearer = String(req.headers.authorization || "").match(/^Bearer (.+)$/i)?.[1];
  const terminal = bearer ? await getTerminalSessionByToken(bearer) : null;
  if (bearer) session = terminal;
  if (!session?.accountId) {
    json(res, 401, { ok: false, error: "docs_prompt_login_required" });
    return true;
  }
  const accountId = session.accountId;
  const endpoint = url.pathname.slice(promptPrefix.length);
  try {
    let result;
    if (bearer) {
      if (endpoint === "devices" && req.method === "POST") {
        result = await registerPromptDevice(accountId, terminal.id, await readJson(req, 10_000));
      } else {
        const deviceId = String(req.headers["x-prompt-device"] || "");
        const envelope = await authorizePromptDevice(accountId, terminal.id, deviceId);
        if (!envelope) {
          json(res, 403, promptFailure("device_approval_required", 403));
          return true;
        }
        if (!deviceEndpoints.has(endpoint)) {
          json(res, 403, promptFailure("browser_required", 403));
          return true;
        }
        if (endpoint === "device-key" && req.method === "GET") result = { ok: true, envelope };
      }
    } else {
      result = await handleBrowserDeviceRequest({ endpoint, req, accountId, readJson });
    }
    result ||= await handleLibraryRequest({ endpoint, req, url, accountId, bearer, readJson });
    result ||= promptFailure("method_not_allowed", 405);
    json(res, result.ok === false ? result.status || 400 : 200, result);
  } catch {
    json(res, 500, { ok: false, error: "docs_prompt_request_failed" });
  }
  return true;
}
