import { randomUUID, timingSafeEqual } from "node:crypto";

function hashEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createRuntimeAuthChallengeStore({ state, saveState } = {}) {
  function pruneExpiredEmailChallenges() {
    const now = Date.now();
    let changed = false;
    for (const [challengeId, challenge] of Object.entries(state.emailChallenges)) {
      const expiredLongAgo = challenge?.expiresAt && Date.parse(challenge.expiresAt) <= now - (60 * 60 * 1000);
      if (!challenge || challenge.consumedAt || challenge.replacedAt || expiredLongAgo) {
        delete state.emailChallenges[challengeId];
        changed = true;
      }
    }
    if (changed) saveState();
  }

  function pruneExpiredOAuthStates() {
    const now = Date.now();
    let changed = false;
    for (const [stateId, stateRow] of Object.entries(state.oauthStates)) {
      if (!stateRow?.expiresAt || Date.parse(stateRow.expiresAt) <= now) {
        delete state.oauthStates[stateId];
        changed = true;
      }
    }
    if (changed) saveState();
  }

  function createOAuthState(options = {}) {
    pruneExpiredOAuthStates();
    const id = randomUUID();
    const now = new Date();
    const legacyContext = options.context && typeof options.context === "object" && !Array.isArray(options.context)
      ? options.context
      : {};
    const explicitMetadata = options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata)
      ? options.metadata
      : {};
    const metadata = {
      ...legacyContext,
      ...explicitMetadata,
      ...(options.codeVerifier && !explicitMetadata.codeVerifier ? { codeVerifier: options.codeVerifier } : {}),
    };
    delete metadata.linkAccountId;
    const redirectPath = String(options.redirectPath || options.returnTo || "/app");
    const ttlSeconds = Number(options.expiresInSeconds ?? options.ttlSeconds) || 600;
    const row = {
      id,
      provider: String(options.provider || "").trim().toLowerCase(),
      redirectPath: redirectPath.startsWith("/") ? redirectPath : "/app",
      redirectUri: String(options.redirectUri || ""),
      linkAccountId: String(options.linkAccountId || legacyContext.linkAccountId || "").trim(),
      metadata,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + Math.max(60, Math.min(Number(ttlSeconds) || 600, 1800)) * 1000).toISOString(),
    };
    state.oauthStates[id] = row;
    saveState();
    return { ...row };
  }

  function consumeOAuthState({ provider, stateId, peek = false }) {
    pruneExpiredOAuthStates();
    const row = state.oauthStates[stateId];
    if (!row || row.provider !== provider) return null;
    if (!peek) {
      delete state.oauthStates[stateId];
      saveState();
    }
    return row;
  }

  function createEmailChallenge({
    id,
    email, canonicalEmail, maskedEmail, codeHash, tokenHash: challengeTokenHash,
    purpose = "login", expectedAccountId = "", ttlSeconds = 600, expiresAt = "", requestIp = "", requestedIp = "", userAgent = "",
  }) {
    pruneExpiredEmailChallenges();
    const now = new Date();
    for (const challenge of Object.values(state.emailChallenges)) {
      if (
        !challenge
        || challenge.canonicalEmail !== canonicalEmail
        || (challenge.purpose || "login") !== purpose
        || challenge.consumedAt
        || challenge.replacedAt
      ) continue;
      challenge.replacedAt = now.toISOString();
    }
    const challengeId = String(id || "").trim() || randomUUID();
    const requestedExpiresAt = Date.parse(expiresAt);
    const challenge = {
      id: challengeId, email, canonicalEmail, maskedEmail, codeHash,
      tokenHash: challengeTokenHash, purpose, expectedAccountId: String(expectedAccountId || "").trim(), status: "pending", attemptCount: 0,
      requestedIp: String(requestIp || requestedIp || "").slice(0, 120),
      userAgent: String(userAgent || "").slice(0, 500),
      createdAt: now.toISOString(),
      expiresAt: Number.isFinite(requestedExpiresAt) && requestedExpiresAt > now.getTime()
        ? new Date(requestedExpiresAt).toISOString()
        : new Date(now.getTime() + Math.max(60, Math.min(Number(ttlSeconds) || 600, 3600)) * 1000).toISOString(),
    };
    state.emailChallenges[challenge.id] = challenge;
    saveState();
    return challenge;
  }

  function getEmailChallenge(challengeId) {
    pruneExpiredEmailChallenges();
    const challenge = state.emailChallenges[challengeId];
    if (!challenge) return null;
    return {
      id: challenge.id, email: challenge.email, canonicalEmail: challenge.canonicalEmail,
      maskedEmail: challenge.maskedEmail, purpose: challenge.purpose, expectedAccountId: challenge.expectedAccountId || "", status: challenge.status,
      attemptCount: challenge.attemptCount || 0, createdAt: challenge.createdAt,
      expiresAt: challenge.expiresAt, consumedAt: challenge.consumedAt || null,
      replacedAt: challenge.replacedAt || null,
    };
  }

  function consumeEmailChallenge({ challengeId, codeHash, purpose = "", expectedAccountId = "" }) {
    pruneExpiredEmailChallenges();
    const challenge = state.emailChallenges[challengeId];
    if (!challenge || challenge.replacedAt || challenge.consumedAt) return { ok: false, error: "challenge_expired" };
    if (Date.parse(challenge.expiresAt) <= Date.now()) return { ok: false, error: "challenge_expired" };
    if (purpose && challenge.purpose !== purpose) return { ok: false, error: "challenge_invalid" };
    if (expectedAccountId && challenge.expectedAccountId !== expectedAccountId) {
      return { ok: false, error: "challenge_invalid" };
    }
    challenge.attemptCount = Number(challenge.attemptCount || 0) + 1;
    if (challenge.attemptCount > 8) {
      challenge.status = "locked";
      saveState();
      return { ok: false, error: "challenge_locked" };
    }
    if (!hashEquals(challenge.codeHash, codeHash)) {
      challenge.status = "failed";
      saveState();
      return { ok: false, error: "challenge_invalid" };
    }
    challenge.status = "consumed";
    challenge.consumedAt = new Date().toISOString();
    saveState();
    return { ok: true, challenge: { ...challenge, codeHash: undefined, tokenHash: undefined } };
  }

  function recordAuthEvent({ eventType, accountId = "", provider = "", email = "", decision = "", metadata = {} }) {
    state.authEvents.push({
      id: randomUUID(), eventType, accountId, provider, email, decision,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      createdAt: new Date().toISOString(),
    });
    if (state.authEvents.length > 1000) state.authEvents = state.authEvents.slice(-1000);
    saveState();
  }

  function destroySession(sessionId) {
    if (!sessionId || !state.sessions[sessionId]) return false;
    delete state.sessions[sessionId];
    saveState();
    return true;
  }

  function attachSessionToDeviceAccountSet({ sessionId = "", setId = "" } = {}) {
    const session = state.sessions[sessionId];
    if (!session || !setId) return { attached: false };
    session.deviceAccountSetId = setId;
    saveState();
    return { attached: true };
  }

  function revokeSessionsForDeviceAccountSet({ setId = "", accountId = "" } = {}) {
    if (!setId) return { revoked: 0 };
    let revoked = 0;
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      if (session?.deviceAccountSetId !== setId) continue;
      if (accountId && session.accountId !== accountId) continue;
      delete state.sessions[sessionId];
      revoked += 1;
    }
    if (revoked) saveState();
    return { revoked };
  }

  function revokeSessionsForAccount({ accountId = "", exceptSessionId = "" } = {}) {
    if (!accountId) return { revoked: 0 };
    let revoked = 0;
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      if (session?.accountId !== accountId || sessionId === exceptSessionId) continue;
      delete state.sessions[sessionId];
      revoked += 1;
    }
    if (revoked) saveState();
    return { revoked };
  }

  return {
    consumeEmailChallenge,
    consumeOAuthState,
    createEmailChallenge,
    createOAuthState,
    destroySession,
    getEmailChallenge,
    pruneExpiredEmailChallenges,
    pruneExpiredOAuthStates,
    recordAuthEvent,
    attachSessionToDeviceAccountSet,
    revokeSessionsForAccount,
    revokeSessionsForDeviceAccountSet,
  };
}
