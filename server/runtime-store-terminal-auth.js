import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

function terminalSessionTtlSeconds() {
  const parsed = Number(process.env.TASKNODE_TERMINAL_SESSION_TTL_SECONDS || 60 * 60 * 24);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 60 * 60 * 24 * 30) : 60 * 60 * 24;
}

function terminalAuthRequestTtlSeconds() {
  const parsed = Number(process.env.TASKNODE_TERMINAL_AUTH_TTL_SECONDS || 600);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 60 * 60) : 600;
}

function randomToken(prefix, bytes = 32) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

function tokenHash(token = "") {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function userCode() {
  return randomBytes(5)
    .toString("base64url")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 8)
    .replace(/^(.{4})(.+)$/, "$1-$2");
}

export function createRuntimeTerminalAuthStore({
  state,
  saveState,
  accountHasLinkedProvider,
  getLinkedProviderForAccount,
  accountPayload,
} = {}) {
  function pruneExpiredTerminalAuthRequests({ save = true } = {}) {
    const now = Date.now();
    let changed = false;
    for (const [requestId, request] of Object.entries(state.terminalAuthRequests || {})) {
      const expiresAt = Date.parse(request?.expiresAt || "");
      if (!Number.isFinite(expiresAt) || expiresAt <= now || request?.consumedAt) {
        delete state.terminalAuthRequests[requestId];
        changed = true;
      }
    }
    if (changed && save) saveState();
    return changed;
  }

  function pruneExpiredTerminalSessions({ save = true } = {}) {
    const now = Date.now();
    let changed = false;
    for (const [sessionId, session] of Object.entries(state.terminalSessions || {})) {
      const expiresAt = Date.parse(session?.expiresAt || "");
      if (!Number.isFinite(expiresAt) || expiresAt <= now || session?.revokedAt) {
        delete state.terminalSessions[sessionId];
        changed = true;
      }
    }
    if (changed && save) saveState();
    return changed;
  }

  function createTerminalAuthRequest({ provider = "github", origin = "", userAgent = "", ip = "" } = {}) {
    pruneExpiredTerminalAuthRequests({ save: false });
    const normalizedProvider = String(provider || "").trim().toLowerCase() || "github";
    const now = new Date();
    const expiresAt = new Date(now.getTime() + terminalAuthRequestTtlSeconds() * 1000).toISOString();
    const requestId = randomToken("tnterm", 18);
    const pollToken = randomToken("tnpoll", 24);
    const request = {
      id: requestId,
      provider: normalizedProvider,
      status: "pending",
      userCode: userCode(),
      origin: String(origin || "").slice(0, 500),
      userAgent: String(userAgent || "").slice(0, 500),
      ip: String(ip || "").slice(0, 120),
      pollTokenHash: tokenHash(pollToken),
      createdAt: now.toISOString(),
      expiresAt,
    };
    state.terminalAuthRequests[requestId] = request;
    saveState();
    return { requestId, pollToken, userCode: request.userCode, expiresAt, provider: normalizedProvider };
  }

  function getTerminalAuthRequest({ requestId = "" } = {}) {
    pruneExpiredTerminalAuthRequests();
    const request = state.terminalAuthRequests[String(requestId || "").trim()] || null;
    if (!request) return null;
    return { ...request, pollTokenHash: undefined };
  }

  function completeTerminalAuthRequest({ requestId = "", accountId = "", provider = "github" } = {}) {
    pruneExpiredTerminalAuthRequests({ save: false });
    const normalizedRequestId = String(requestId || "").trim();
    const request = state.terminalAuthRequests[normalizedRequestId] || null;
    if (!request) return { ok: false, error: "terminal_auth_request_not_found" };
    if (request.status !== "pending") return { ok: false, error: "terminal_auth_request_not_pending" };
    const normalizedProvider = String(provider || request.provider || "").trim().toLowerCase();
    const normalizedAccountId = String(accountId || "").trim();
    if (!normalizedAccountId || !accountHasLinkedProvider({ accountId: normalizedAccountId, provider: normalizedProvider })) {
      request.status = "failed";
      request.error = "github_not_linked";
      request.completedAt = new Date().toISOString();
      saveState();
      return { ok: false, error: "github_not_linked" };
    }
    request.status = "linked";
    request.accountId = normalizedAccountId;
    request.provider = normalizedProvider;
    request.completedAt = new Date().toISOString();
    saveState();
    return { ok: true, request: getTerminalAuthRequest({ requestId: normalizedRequestId }) };
  }

  function terminalSessionPayload(session = null) {
    if (!session) return null;
    const account = accountPayload(state.accounts[session.accountId] || null);
    const linkedProvider = getLinkedProviderForAccount({ accountId: session.accountId, provider: session.provider });
    return {
      id: session.id,
      accountId: session.accountId,
      provider: session.provider,
      githubUsername: linkedProvider?.username || session.providerUsername || "",
      scopes: Array.isArray(session.scopes) ? session.scopes : [],
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      account,
    };
  }

  function createTerminalSession({ accountId = "", provider = "github" } = {}) {
    const normalizedAccountId = String(accountId || "").trim();
    const normalizedProvider = String(provider || "").trim().toLowerCase();
    const linkedProvider = getLinkedProviderForAccount({ accountId: normalizedAccountId, provider: normalizedProvider });
    if (!normalizedAccountId || !linkedProvider) return { ok: false, error: "github_not_linked" };
    pruneExpiredTerminalSessions({ save: false });
    const now = new Date();
    const sessionId = randomToken("tnsess", 18);
    const token = randomToken("tns", 32);
    const expiresAt = new Date(now.getTime() + terminalSessionTtlSeconds() * 1000).toISOString();
    state.terminalSessions[sessionId] = {
      id: sessionId,
      tokenHash: tokenHash(token),
      accountId: normalizedAccountId,
      provider: normalizedProvider,
      providerUsername: linkedProvider.username || "",
      scopes: ["tasknode:read", "tasknode:tasks:write", "tasknode:balance:read"],
      createdAt: now.toISOString(),
      expiresAt,
    };
    saveState();
    return { ok: true, token, session: terminalSessionPayload(state.terminalSessions[sessionId]) };
  }

  function consumeTerminalAuthRequestSession({ requestId = "", pollToken = "" } = {}) {
    pruneExpiredTerminalAuthRequests({ save: false });
    const normalizedRequestId = String(requestId || "").trim();
    const request = state.terminalAuthRequests[normalizedRequestId] || null;
    if (!request) {
      saveState();
      return { ok: false, status: 404, error: "terminal_auth_request_not_found" };
    }
    if (request.pollTokenHash !== tokenHash(pollToken)) {
      saveState();
      return { ok: false, status: 401, error: "terminal_auth_poll_denied" };
    }
    if (request.status === "pending") {
      saveState();
      return { ok: false, status: 202, error: "terminal_auth_pending", requestId: normalizedRequestId, provider: request.provider, expiresAt: request.expiresAt };
    }
    if (request.status === "failed") {
      const error = request.error || "terminal_auth_failed";
      delete state.terminalAuthRequests[normalizedRequestId];
      saveState();
      return { ok: false, status: 409, error };
    }
    if (request.status !== "linked" || !request.accountId) {
      delete state.terminalAuthRequests[normalizedRequestId];
      saveState();
      return { ok: false, status: 409, error: "terminal_auth_invalid_state" };
    }
    const issued = createTerminalSession({ accountId: request.accountId, provider: request.provider });
    delete state.terminalAuthRequests[normalizedRequestId];
    saveState();
    if (!issued.ok) return { ok: false, status: 409, error: issued.error };
    return { ok: true, status: 200, terminalToken: issued.token, session: issued.session };
  }

  function getTerminalSessionByToken(token = "") {
    const hash = tokenHash(token);
    if (!hash) return null;
    pruneExpiredTerminalSessions();
    const session = Object.values(state.terminalSessions || {})
      .find((item) => item?.tokenHash && timingSafeEqual(Buffer.from(item.tokenHash), Buffer.from(hash)));
    if (!session || !accountHasLinkedProvider({ accountId: session.accountId, provider: session.provider })) return null;
    return terminalSessionPayload(session);
  }

  function revokeTerminalSessionByToken(token = "") {
    const hash = tokenHash(token);
    if (!hash) return false;
    let revoked = false;
    for (const [sessionId, session] of Object.entries(state.terminalSessions || {})) {
      if (!session?.tokenHash || !timingSafeEqual(Buffer.from(session.tokenHash), Buffer.from(hash))) continue;
      delete state.terminalSessions[sessionId];
      revoked = true;
    }
    if (revoked) saveState();
    return revoked;
  }

  return {
    completeTerminalAuthRequest,
    consumeTerminalAuthRequestSession,
    createTerminalAuthRequest,
    getTerminalAuthRequest,
    getTerminalSessionByToken,
    pruneExpiredTerminalAuthRequests,
    pruneExpiredTerminalSessions,
    revokeTerminalSessionByToken,
  };
}
